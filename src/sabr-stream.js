'use strict';

const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const {
  pbDecodeBase64ToU8,
  buildFormatIdMsg,
  buildClientInfoMsg,
  buildAbrRequestBytes,
  demuxUmp,
} = require('./protobuf');
const {
  buildStreamingWebmInit,
  buildSeekableWebmFile,
  WebmClusterAssembler,
} = require('./webm');
const { decipherSabrUrl } = require('./decipher');
const { resolveSabrContext, sanitizeFilename } = require('./innertube');

/**
 * Creates a real-time Node.js Readable stream of WebM/Opus audio from YouTube SABR UMP.
 * Starts emitting the patched WebM Init Segment + Clusters within ~300-500ms without
 * waiting for the whole file to download. Ideal for piping into FFmpeg, @discordjs/voice,
 * Lavaplayer, discord.py, or Songbird (Rust).
 *
 * @param {string} videoIdOrQuery - YouTube URL, 11-char videoId, or search query
 * @param {object} [options]
 * @param {number|string} [options.itag] - 251 (Guest Opus), 774 (Premium HQ Opus), or 'auto'
 * @param {boolean} [options.guest] - Force anonymous Guest session (no tokens/cookies)
 * @param {string} [options.accessToken] - Optional TV OAuth access token for ITAG 774
 * @param {number} [options.startTimeMs] - Optional start time offset in milliseconds (default 0)
 * @param {number} [options.highWaterMark] - Stream buffer highWaterMark (default 512 KB)
 * @param {Function} [options.onProgress] - Callback ({ bufferedMs, durationMs, percent, bytes })
 * @returns {Readable & { getInfo: () => Promise<object> }}
 */
function createSabrAudioStream(videoIdOrQuery, options = {}) {
  let session = null;
  let aborted = false;
  let pausedByBackpressure = false;
  let infoResolve, infoReject;
  const infoPromise = new Promise((res, rej) => {
    infoResolve = res;
    infoReject = rej;
  });

  const stream = new Readable({
    highWaterMark: options.highWaterMark || 512 * 1024,
    read() {
      if (pausedByBackpressure && session && !aborted) {
        pausedByBackpressure = false;
        pump();
      }
    },
    destroy(err, cb) {
      aborted = true;
      if (session && session.abortCtrl) {
        try {
          session.abortCtrl.abort();
        } catch (e) {}
      }
      cb(err);
    },
  });

  stream.getInfo = () => infoPromise;

  let lastEmittedTc = -1;
  let emittedInit = false;
  let emittedBytes = 0;

  const startOffsetMs = Math.max(0, Number(options.startTimeMs) || 0);

  const assembler = new WebmClusterAssembler({
    retainClusters: false, // O(1) constant memory for live streaming (never holds emitted clusters in RAM)
    startOffsetMs,
    onInit(initU8) {
      if (emittedInit || aborted) return;
      emittedInit = true;
      const patchedInit = buildStreamingWebmInit(initU8, session?.durationMs || 0);
      emittedBytes += patchedInit.length;
      const canContinue = stream.push(patchedInit);
      if (!canContinue) pausedByBackpressure = true;
    },
    onCluster(tc, clusterU8, cDur) {
      if (aborted) return;
      if (tc <= lastEmittedTc) return;
      lastEmittedTc = tc;
      const buf = Buffer.from(clusterU8);
      emittedBytes += buf.length;
      const canContinue = stream.push(buf);
      if (!canContinue) pausedByBackpressure = true;

      if (typeof options.onProgress === 'function' && session) {
        const bufferedMs = Math.min(session.durationMs || 0, tc + cDur);
        const pct = session.durationMs > 0 ? Math.min(100, Math.round((bufferedMs / session.durationMs) * 100)) : 0;
        options.onProgress({
          bufferedMs,
          durationMs: session.durationMs || 0,
          percent: pct,
          bytes: emittedBytes,
          itag: session.targetItag,
        });
      }
    },
  });

  async function refreshSabrSession() {
    if (!session || aborted) return false;
    try {
      const ctx = await resolveSabrContext(session.videoId, {
        ...options,
        itag: session.targetItag,
      });
      const ustreamerBytes = pbDecodeBase64ToU8(ctx.ustreamerConfig);
      if (!ustreamerBytes || ustreamerBytes.length < 16) return false;
      session.ustreamerBytes = ustreamerBytes;
      session.fmtMsg = buildFormatIdMsg(ctx.itag, ctx.format.lastModified, ctx.format.xtags);
      session.clientInfoMsg = buildClientInfoMsg(ctx.clientVersion);
      session.decipheredUrl = await decipherSabrUrl(ctx.sabrUrl);
      session.playbackCookie = null;
      session.errorCount = 0;
      session.refreshCount = (session.refreshCount || 0) + 1;
      return true;
    } catch (e) {
      return false;
    }
  }

  async function initSession() {
    try {
      const ctx = await resolveSabrContext(videoIdOrQuery, options);
      if (aborted) return;

      const ustreamerBytes = pbDecodeBase64ToU8(ctx.ustreamerConfig);
      if (!ustreamerBytes || ustreamerBytes.length < 16) {
        throw new Error('Invalid ustreamerConfig bytes in SABR context');
      }

      const fmtMsg = buildFormatIdMsg(ctx.itag, ctx.format.lastModified, ctx.format.xtags);
      const clientInfoMsg = buildClientInfoMsg(ctx.clientVersion);
      const decipheredUrl = await decipherSabrUrl(ctx.sabrUrl);

      session = {
        ctx,
        videoId: ctx.videoId,
        targetItag: ctx.itag,
        durationMs: ctx.durationMs,
        ustreamerBytes,
        fmtMsg,
        clientInfoMsg,
        decipheredUrl,
        playbackCookie: null,
        hasInit: false,
        inFlight: false,
        reachedEof: false,
        rn: 0,
        nextTargetMs: startOffsetMs,
        lastMissingMs: undefined,
        errorCount: 0,
        refreshCount: 0,
        abortCtrl: null,
      };

      infoResolve(ctx);
      stream.emit('info', ctx);
      pump();
    } catch (err) {
      infoReject(err);
      if (!aborted) stream.destroy(err);
    }
  }

  async function pump() {
    if (!session || aborted || pausedByBackpressure || session.inFlight || session.reachedEof) {
      return;
    }

    const durMs = session.durationMs || 0;
    let targetMs = 0;

    if (!session.hasInit) {
      targetMs = 0;
    } else {
      const missingMs = assembler.getNextMissingTimeMs(durMs);
      if (missingMs === null && durMs > 0 && assembler.clustersCount > 0) {
        finishStream();
        return;
      }
      if (missingMs !== null) {
        if (session.lastMissingMs !== undefined && Math.abs(missingMs - session.lastMissingMs) < 50) {
          targetMs = Math.max(missingMs, session.nextTargetMs || 0);
        } else {
          session.lastMissingMs = missingMs;
          targetMs = Math.max(missingMs, startOffsetMs);
        }
      } else {
        targetMs = session.nextTargetMs || 0;
      }

      if (durMs > 0 && targetMs >= durMs - 200) {
        const checkMissing = assembler.getNextMissingTimeMs(durMs);
        if (checkMissing === null || checkMissing >= durMs - 500) {
          finishStream();
          return;
        }
        targetMs = checkMissing;
      }
    }

    session.inFlight = true;
    const abortCtrl = new AbortController();
    session.abortCtrl = abortCtrl;

    try {
      const reqBytes = buildAbrRequestBytes(session, targetMs);
      const u = new URL(session.decipheredUrl);
      u.searchParams.set('alr', 'yes');
      u.searchParams.set('rn', String(++session.rn));

      const resp = await fetch(u.toString(), {
        method: 'POST',
        body: reqBytes,
        signal: abortCtrl.signal,
      });

      if (aborted) return;
      if (!resp.ok) {
        session.errorCount++;
        if (session.errorCount >= 3 && (session.refreshCount || 0) < 5) {
          const refreshed = await refreshSabrSession();
          if (refreshed) {
            session.inFlight = false;
            setImmediate(pump);
            return;
          }
        }
        if (session.errorCount >= 6) {
          throw new Error(`SABR POST HTTP ${resp.status} for ${session.videoId}`);
        }
        session.inFlight = false;
        setTimeout(pump, 250);
        return;
      }

      const buf = new Uint8Array(await resp.arrayBuffer());
      if (aborted) return;

      const demuxed = demuxUmp(buf, session.targetItag);
      if (demuxed.nextPlaybackCookie) {
        session.playbackCookie = demuxed.nextPlaybackCookie;
      }
      if (demuxed.redirectUrl) {
        session.decipheredUrl = demuxed.redirectUrl;
        session.inFlight = false;
        pump();
        return;
      }

      if (demuxed.segments.length === 0) {
        if (demuxed.sabrError) {
          session.errorCount++;
          if (session.errorCount >= 3 && (session.refreshCount || 0) < 5) {
            const refreshed = await refreshSabrSession();
            if (refreshed) {
              session.inFlight = false;
              setImmediate(pump);
              return;
            }
          }
          if (session.errorCount >= 6) {
            throw new Error(`SABR UMP SabrError (part 43) on ${session.videoId}`);
          }
        } else if (session.hasInit && targetMs > 5000) {
          finishStream();
          return;
        }
      } else {
        session.errorCount = 0;
        for (const seg of demuxed.segments) {
          if (seg.isInit) {
            session.hasInit = true;
            assembler.feed(seg.data, seg);
          } else {
            assembler.feed(seg.data, seg);
            if ((seg.startMs || 0) + (seg.durMs || 0) > 0) {
              session.nextTargetMs = Math.max(session.nextTargetMs || 0, (seg.startMs || 0) + (seg.durMs || 0) + 20);
            } else {
              session.nextTargetMs = Math.max(session.nextTargetMs || 0, targetMs + 5000);
            }
          }
        }
      }
    } catch (err) {
      if (!aborted && err?.name !== 'AbortError') {
        stream.destroy(err);
        return;
      }
    } finally {
      if (session) {
        session.abortCtrl = null;
        session.inFlight = false;
      }
    }

    if (!aborted && !pausedByBackpressure && session && !session.reachedEof) {
      setImmediate(pump);
    }
  }

  function finishStream() {
    if (!session || session.reachedEof || aborted) return;
    session.reachedEof = true;
    assembler.flush();
    if (options.loop && !aborted) {
      // Infinite 24/7 loop mode on the same stream: reset timecode tracking and continue
      lastEmittedTc = -1;
      assembler.clusterSizes.clear();
      assembler.clusterDurations.clear();
      assembler.totalClusterDurationMs = 0;
      assembler.maxTimecode = 0;
      assembler.maxEndTimeMs = 0;
      session.reachedEof = false;
      session.nextTargetMs = startOffsetMs;
      session.lastMissingMs = undefined;
      stream.emit('loop', session.ctx);
      setImmediate(pump);
      return;
    }
    stream.push(null);
  }

  initSession();
  return stream;
}

/**
 * Downloads the full YouTube SABR UMP audio stream, patches the WebM Duration,
 * builds a 56-byte SeekHead and convergent multi-pass Cues index table, and
 * writes a 100% seekable `.opus` file (or returns the Buffer).
 */
async function downloadSabrAudio(videoIdOrQuery, outputPath = null, options = {}) {
  const ctx = await resolveSabrContext(videoIdOrQuery, options);
  const ustreamerBytes = pbDecodeBase64ToU8(ctx.ustreamerConfig);
  if (!ustreamerBytes || ustreamerBytes.length < 16) {
    throw new Error('Invalid ustreamerConfig bytes in SABR context');
  }

  const fmtMsg = buildFormatIdMsg(ctx.itag, ctx.format.lastModified, ctx.format.xtags);
  const clientInfoMsg = buildClientInfoMsg(ctx.clientVersion);
  let decipheredUrl = await decipherSabrUrl(ctx.sabrUrl);

  const assembler = new WebmClusterAssembler();
  const session = {
    videoId: ctx.videoId,
    targetItag: ctx.itag,
    durationMs: ctx.durationMs,
    ustreamerBytes,
    fmtMsg,
    clientInfoMsg,
    playbackCookie: null,
    hasInit: false,
    rn: 0,
    nextTargetMs: 0,
    lastMissingMs: undefined,
    errorCount: 0,
  };

  const durMs = session.durationMs || 0;

  while (true) {
    let targetMs = 0;
    if (!session.hasInit) {
      targetMs = 0;
    } else {
      const missingMs = assembler.getNextMissingTimeMs(durMs);
      if (missingMs === null && durMs > 0 && assembler.clusters.size > 0) {
        break;
      }
      if (missingMs !== null) {
        if (session.lastMissingMs !== undefined && Math.abs(missingMs - session.lastMissingMs) < 50) {
          targetMs = Math.max(missingMs, session.nextTargetMs || 0);
        } else {
          session.lastMissingMs = missingMs;
          targetMs = missingMs;
        }
      } else {
        targetMs = session.nextTargetMs || 0;
      }
      if (durMs > 0 && targetMs >= durMs - 200) {
        const checkMissing = assembler.getNextMissingTimeMs(durMs);
        if (checkMissing === null || checkMissing >= durMs - 500) {
          break;
        }
        targetMs = checkMissing;
      }
    }

    const reqBytes = buildAbrRequestBytes(session, targetMs);
    const u = new URL(decipheredUrl);
    u.searchParams.set('alr', 'yes');
    u.searchParams.set('rn', String(++session.rn));

    const resp = await fetch(u.toString(), {
      method: 'POST',
      body: reqBytes,
    });

    if (!resp.ok) {
      session.errorCount++;
      if (session.errorCount >= 4) {
        throw new Error(`SABR POST HTTP ${resp.status} for ${ctx.videoId}`);
      }
      await new Promise(r => setTimeout(r, 200));
      continue;
    }

    const buf = new Uint8Array(await resp.arrayBuffer());
    const demuxed = demuxUmp(buf, session.targetItag);

    if (demuxed.nextPlaybackCookie) {
      session.playbackCookie = demuxed.nextPlaybackCookie;
    }
    if (demuxed.redirectUrl) {
      decipheredUrl = demuxed.redirectUrl;
      continue;
    }

    if (demuxed.segments.length === 0) {
      if (demuxed.sabrError) {
        session.errorCount++;
        if (session.errorCount >= 4) {
          throw new Error(`SABR UMP SabrError on ${ctx.videoId}`);
        }
      } else if (session.hasInit && targetMs > 5000) {
        break;
      }
      continue;
    }

    session.errorCount = 0;
    for (const seg of demuxed.segments) {
      if (seg.isInit) {
        session.hasInit = true;
        assembler.feed(seg.data, seg);
      } else {
        assembler.feed(seg.data, seg);
        if ((seg.startMs || 0) + (seg.durMs || 0) > 0) {
          session.nextTargetMs = Math.max(session.nextTargetMs || 0, (seg.startMs || 0) + (seg.durMs || 0) + 20);
        } else {
          session.nextTargetMs = Math.max(session.nextTargetMs || 0, targetMs + 5000);
        }
      }
    }

    if (typeof options.onProgress === 'function') {
      assembler.flush();
      const bMs = Math.min(durMs, assembler.totalClusterDurationMs || assembler.maxEndTimeMs);
      const pct = durMs > 0 ? Math.min(100, Math.round((bMs / durMs) * 100)) : 0;
      options.onProgress({
        bufferedMs: bMs,
        durationMs: durMs,
        percent: pct,
        bytes: assembler.totalBytes,
        itag: ctx.itag,
      });
    }
  }

  assembler.flush();
  const built = buildSeekableWebmFile(
    assembler.initSegment,
    assembler.clusters,
    assembler.clusterDurations,
    durMs
  );
  if (!built || !built.buffer) {
    throw new Error('Failed to assemble WebM audio file from SABR UMP segments');
  }

  let finalPath = outputPath;
  if (finalPath === '-') {
    process.stdout.write(built.buffer);
  } else if (finalPath) {
    const stat = fs.existsSync(finalPath) && fs.statSync(finalPath).isDirectory();
    if (stat) {
      finalPath = path.join(finalPath, sanitizeFilename(ctx.title, ctx.author, ctx.itag));
    }
    fs.mkdirSync(path.dirname(path.resolve(finalPath)), { recursive: true });
    fs.writeFileSync(finalPath, built.buffer);
  }

  return {
    info: ctx,
    buffer: built.buffer,
    outputPath: finalPath,
    durationMs: built.durationMs,
    clustersCount: built.clustersCount,
    sizeBytes: built.buffer.length,
  };
}

/**
 * Creates a continuous 24/7 multi-track audio stream from a playlist array or an async track provider function.
 * Automatically transitions from one track to the next without closing the output stream.
 *
 * @param {string[] | ((index: number) => Promise<string|null> | string | null)} tracksOrProvider
 * @param {object} [options]
 * @param {boolean} [options.loop=true] - Loop playlist array infinitely (24/7 radio mode)
 * @param {number} [options.itag=251] - Target audio itag (251 Guest or 774 HQ)
 * @param {boolean} [options.guest=true] - Force Guest session for 251
 */
function createContinuousAudioStream(tracksOrProvider, options = {}) {
  let aborted = false;
  let paused = false;
  let currentSubStream = null;
  let trackIndex = 0;
  const loopPlaylist = options.loop !== false;

  const outStream = new Readable({
    highWaterMark: options.highWaterMark || 512 * 1024,
    read() {
      if (paused && currentSubStream && !aborted) {
        paused = false;
        currentSubStream.resume();
      }
    },
    destroy(err, cb) {
      aborted = true;
      if (currentSubStream) {
        try {
          currentSubStream.destroy();
        } catch (e) {}
      }
      cb(err);
    },
  });

  async function resolveNextTarget() {
    if (typeof tracksOrProvider === 'function') {
      return await tracksOrProvider(trackIndex++);
    }
    if (Array.isArray(tracksOrProvider) && tracksOrProvider.length > 0) {
      if (trackIndex >= tracksOrProvider.length) {
        if (!loopPlaylist) return null;
        trackIndex = 0;
      }
      return tracksOrProvider[trackIndex++];
    }
    return null;
  }

  async function startNextTrack() {
    if (aborted) return;
    let target = null;
    try {
      target = await resolveNextTarget();
    } catch (err) {
      outStream.emit('trackError', err);
      setTimeout(startNextTrack, 1000);
      return;
    }

    if (!target) {
      outStream.push(null);
      return;
    }

    const sub = createSabrAudioStream(target, {
      ...options,
      loop: false,
    });
    currentSubStream = sub;

    sub.once('info', info => {
      if (!aborted) outStream.emit('trackStart', info);
    });

    sub.on('data', chunk => {
      if (aborted) return;
      if (!outStream.push(chunk)) {
        paused = true;
        sub.pause();
      }
    });

    sub.once('end', () => {
      if (aborted) return;
      currentSubStream = null;
      outStream.emit('trackEnd', target);
      setImmediate(startNextTrack);
    });

    sub.once('error', err => {
      if (aborted) return;
      currentSubStream = null;
      outStream.emit('trackError', err, target);
      // Auto-skip broken track in 24/7 radio mode instead of killing the stream
      setTimeout(startNextTrack, 500);
    });
  }

  startNextTrack();
  return outStream;
}

module.exports = {
  createSabrAudioStream,
  createContinuousAudioStream,
  downloadSabrAudio,
};

