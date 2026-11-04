'use strict';

const { Readable } = require('stream');
const { buildAtempoFilter } = require('./webm');

let _childProcess = null;
function getChildProcess() {
  if (!_childProcess) {
    _childProcess = require('child_process');
  }
  return _childProcess;
}

const ffmpegCheckCache = new Map();
const UNSAFE_PATH_CHARS = /[;&|`$><\r\n\0]/;

/**
 * Validates and resolves the FFmpeg executable path.
 * Checks for binary availability using an isolated spawn with shell: false.
 *
 * @param {string} [customPath] - Explicit path to ffmpeg binary
 * @returns {string|null} - Validated binary path or null if not available
 */
function resolveFfmpegBinary(customPath) {
  const candidate = (customPath || process.env.FFMPEG_PATH || 'ffmpeg').trim();
  if (!candidate || UNSAFE_PATH_CHARS.test(candidate)) {
    return null;
  }

  if (ffmpegCheckCache.has(candidate)) {
    return ffmpegCheckCache.get(candidate);
  }

  try {
    const cp = getChildProcess();
    const res = cp.spawnSync(candidate, ['-version'], {
      stdio: 'ignore',
      shell: false,
      windowsHide: true,
      timeout: 3000,
    });
    const ok = Boolean(res && res.status === 0);
    ffmpegCheckCache.set(candidate, ok ? candidate : null);
    return ok ? candidate : null;
  } catch (e) {
    ffmpegCheckCache.set(candidate, null);
    return null;
  }
}

/**
 * Pipes a raw WebM/Opus stream through an isolated FFmpeg child process
 * to apply pitch-preserving or analog tape waveform resampling in real time.
 *
 * @param {Readable} rawStream - Source Node.js Readable stream
 * @param {number} speed - Playback speed multiplier (0.10 to 4.00)
 * @param {object} options - Stream options
 * @param {string} ffmpegBin - Validated ffmpeg executable path
 * @returns {Readable} - Transcoded Readable stream
 */
function createFfmpegSpeedStream(rawStream, speed, options, ffmpegBin) {
  const preservePitch = options.preservePitch !== false;
  const atempoFilter = buildAtempoFilter(speed, { preservePitch });
  let ff = null;
  let destroyed = false;

  const outStream = new Readable({
    highWaterMark: options.highWaterMark || 512 * 1024,
    read() {
      if (ff && ff.stdout && !destroyed) {
        ff.stdout.resume();
      }
    },
    destroy(err, cb) {
      destroyed = true;
      try {
        rawStream.destroy();
      } catch (e) {}
      if (ff) {
        try {
          ff.kill('SIGKILL');
        } catch (e) {}
      }
      cb(err);
    },
  });

  outStream.speed = speed;
  outStream.preservePitch = preservePitch;
  outStream.atempoFilter = atempoFilter;
  outStream.getInfo = () =>
    rawStream.getInfo().then(ctx => ({
      ...ctx,
      speed,
      preservePitch,
      atempoFilter,
      effectiveDurationMs: Math.round((ctx.durationMs || 0) / speed),
    }));

  rawStream.once('info', ctx => {
    if (destroyed) return;
    const enrichedCtx = {
      ...ctx,
      speed,
      preservePitch,
      atempoFilter,
      effectiveDurationMs: Math.round((ctx.durationMs || 0) / speed),
    };
    outStream.emit('info', enrichedCtx);

    const bitrate = ctx.itag === 774 ? '256k' : '160k';
    const cp = getChildProcess();

    try {
      ff = cp.spawn(
        ffmpegBin,
        [
          '-hide_banner',
          '-loglevel',
          'error',
          '-i',
          'pipe:0',
          '-vn',
          '-af',
          atempoFilter,
          '-c:a',
          'libopus',
          '-b:a',
          bitrate,
          '-vbr',
          'on',
          '-application',
          'audio',
          '-f',
          'webm',
          'pipe:1',
        ],
        {
          stdio: ['pipe', 'pipe', 'pipe'],
          shell: false,
          windowsHide: true,
        }
      );
    } catch (spawnErr) {
      if (!destroyed) outStream.destroy(spawnErr);
      return;
    }

    ff.stdin.on('error', () => {});
    rawStream.pipe(ff.stdin);

    ff.stdout.on('data', chunk => {
      if (destroyed) return;
      if (!outStream.push(chunk)) {
        ff.stdout.pause();
      }
    });

    ff.stdout.once('end', () => {
      if (!destroyed) outStream.push(null);
    });

    ff.once('error', err => {
      if (!destroyed) outStream.destroy(err);
    });
  });

  rawStream.on('loop', ctx => {
    if (!destroyed) outStream.emit('loop', ctx);
  });

  rawStream.once('error', err => {
    if (!destroyed) outStream.destroy(err);
  });

  return outStream;
}

/**
 * Transcodes an assembled WebM Opus audio buffer to target playback speed.
 *
 * @param {Buffer} inputBuffer - Assembled seekable WebM file buffer
 * @param {number} speed - Playback speed multiplier (0.10 to 4.00)
 * @param {string} atempoFilter - FFmpeg audio filter string
 * @param {number} itag - Audio itag (251 or 774)
 * @param {string} ffmpegBin - Validated ffmpeg executable path
 * @returns {Buffer|null} - Transcoded WebM buffer or null on error
 */
function transcodeWebmBuffer(inputBuffer, speed, atempoFilter, itag, ffmpegBin) {
  if (!inputBuffer || inputBuffer.length === 0 || !ffmpegBin) {
    return null;
  }

  const cp = getChildProcess();
  const bitrate = itag === 774 ? '256k' : '160k';

  try {
    const transcoded = cp.spawnSync(
      ffmpegBin,
      [
        '-hide_banner',
        '-loglevel',
        'error',
        '-i',
        'pipe:0',
        '-vn',
        '-af',
        atempoFilter,
        '-c:a',
        'libopus',
        '-b:a',
        bitrate,
        '-vbr',
        'on',
        '-application',
        'audio',
        '-f',
        'webm',
        'pipe:1',
      ],
      {
        input: inputBuffer,
        shell: false,
        windowsHide: true,
        timeout: 120000,
        maxBuffer: Math.max(64 * 1024 * 1024, inputBuffer.length * 12),
      }
    );

    if (transcoded && transcoded.status === 0 && transcoded.stdout && transcoded.stdout.length > 64) {
      return Buffer.from(transcoded.stdout);
    }
    return null;
  } catch (e) {
    return null;
  }
}

module.exports = {
  resolveFfmpegBinary,
  createFfmpegSpeedStream,
  transcodeWebmBuffer,
};
