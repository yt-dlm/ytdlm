'use strict';

const http = require('http');
const crypto = require('crypto');
const { createSabrAudioStream, createContinuousAudioStream } = require('./sabr-stream');
const { resolveSabrContext, searchVideos } = require('./innertube');
const { normalizePlaybackSpeed, buildAtempoFilter } = require('./webm');
const { version } = require('../package.json');

const MAX_URL_LEN = 4096;
const MAX_PARAM_LEN = 2048;
const MAX_TRACK_LIST = 50;

function timingSafeMatch(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/**
 * Starts a local HTTP streaming & metadata gateway server for multi-language media applications
 * (Node.js, Python, Java, Rust, Go, C#).
 *
 * Endpoints:
 *   GET /stream?v=<url_or_id_or_query>&itag=251&guest=1&start=0&speed=1.0
 *       -> Streams live WebM/Opus audio chunks (Content-Type: audio/webm; codecs="opus")
 *   GET /info?v=<url_or_id_or_query>&itag=251&guest=1&speed=1.0
 *       -> Returns JSON metadata (videoId, title, author, durationMs, itag, bitrate, mode, speed, etc.)
 *   GET /search?q=<query>&limit=5
 *       -> Returns JSON array of YouTube search results
 *   GET /health
 *       -> Returns { ok: true, service: "ytdlm" }
 */
function startServer(options = {}) {
  const port = options.port !== undefined ? Number(options.port) : Number(process.env.YTDLM_PORT || 8787);
  const host = options.host || process.env.YTDLM_HOST || '127.0.0.1';
  const apiKey = options.apiKey || process.env.YTDLM_API_KEY || null;
  const corsOrigin = options.corsOrigin || process.env.YTDLM_CORS_ORIGIN || null;
  let boundPort = port;

  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (corsOrigin) {
      res.setHeader('Access-Control-Allow-Origin', String(corsOrigin));
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Method Not Allowed' }));
      return;
    }

    if (apiKey) {
      const rawKey = req.headers['x-api-key'] || req.headers['authorization'] || '';
      const provided = String(rawKey).replace(/^Bearer\s+/i, '');
      if (!timingSafeMatch(provided, String(apiKey))) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    const rawReqUrl = req.url || '/';
    if (rawReqUrl.length > MAX_URL_LEN) {
      res.writeHead(414, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'URI Too Long' }));
      return;
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(rawReqUrl, `http://${req.headers.host || `${host}:${boundPort}`}`);
    } catch (e) {
      res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Invalid URL' }));
      return;
    }

    const pathname = parsedUrl.pathname;

    if (pathname === '/health' || pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(
        JSON.stringify({
          ok: true,
          service: 'ytdlm',
          version,
          endpoints: ['/stream?v=<id_or_url>&speed=1.0', '/info?v=<id_or_url>', '/search?q=<query>'],
        })
      );
      return;
    }

    if (pathname === '/search') {
      const q = parsedUrl.searchParams.get('q') || parsedUrl.searchParams.get('query') || '';
      const rawLim = Number(parsedUrl.searchParams.get('limit') || 5);
      const limit = Math.min(20, Math.max(1, Number.isFinite(rawLim) ? Math.floor(rawLim) : 5));
      if (!q.trim() || q.length > MAX_PARAM_LEN) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Invalid query parameter ?q=' }));
        return;
      }
      try {
        const results = await searchVideos(q, limit);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ query: q, results }));
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message || String(err) }));
      }
      return;
    }

    if (pathname === '/info') {
      const v = parsedUrl.searchParams.get('v') || parsedUrl.searchParams.get('url') || '';
      const itag = parsedUrl.searchParams.get('itag') || undefined;
      const guestParam = parsedUrl.searchParams.get('guest');
      const guest = guestParam === null ? undefined : guestParam !== '0' && guestParam !== 'false';
      const speed = normalizePlaybackSpeed(parsedUrl.searchParams.get('speed') || parsedUrl.searchParams.get('rate') || 1.0);
      const pitchParam = parsedUrl.searchParams.get('preservePitch');
      const tapeParam = parsedUrl.searchParams.get('tape');
      const preservePitch = tapeParam === '1' || tapeParam === 'true' ? false : pitchParam !== '0' && pitchParam !== 'false';
      const atempoFilter = buildAtempoFilter(speed, { preservePitch });

      if (!v.trim() || v.length > MAX_PARAM_LEN) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Invalid parameter ?v=' }));
        return;
      }

      try {
        const ctx = await resolveSabrContext(v, { itag, guest });
        const qs = new URLSearchParams({ v: ctx.videoId, itag: String(ctx.itag) });
        if (speed !== 1.0) qs.set('speed', String(speed));
        if (!preservePitch) qs.set('preservePitch', '0');
        const streamUrl = `http://${host}:${boundPort}/stream?${qs.toString()}`;
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(
          JSON.stringify({
            videoId: ctx.videoId,
            url: `https://www.youtube.com/watch?v=${ctx.videoId}`,
            title: ctx.title,
            author: ctx.author,
            durationSec: ctx.durationSec,
            durationMs: ctx.durationMs,
            effectiveDurationMs: Math.round((ctx.durationMs || 0) / speed),
            thumbnail: ctx.thumbnail,
            itag: ctx.itag,
            mimeType: ctx.mimeType,
            bitrate: ctx.bitrate,
            sampleRate: ctx.sampleRate,
            channels: ctx.channels,
            isGuest: ctx.isGuest,
            mode: ctx.mode,
            speed,
            preservePitch,
            atempoFilter,
            streamUrl,
          })
        );
      } catch (err) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: err.message || String(err) }));
      }
      return;
    }

    if (pathname === '/stream') {
      const v = parsedUrl.searchParams.get('v') || parsedUrl.searchParams.get('url') || '';
      const itag = parsedUrl.searchParams.get('itag') || undefined;
      const guestParam = parsedUrl.searchParams.get('guest');
      const guest = guestParam === null ? undefined : guestParam !== '0' && guestParam !== 'false';
      const rawStart = Number(parsedUrl.searchParams.get('start') || parsedUrl.searchParams.get('startTimeMs') || 0);
      const startTimeMs = Number.isFinite(rawStart) ? Math.max(0, Math.floor(rawStart)) : 0;
      const loopParam = parsedUrl.searchParams.get('loop');
      const loop = loopParam === '1' || loopParam === 'true';
      const speed = normalizePlaybackSpeed(parsedUrl.searchParams.get('speed') || parsedUrl.searchParams.get('rate') || 1.0);
      const pitchParam = parsedUrl.searchParams.get('preservePitch');
      const tapeParam = parsedUrl.searchParams.get('tape');
      const preservePitch = tapeParam === '1' || tapeParam === 'true' ? false : pitchParam !== '0' && pitchParam !== 'false';
      const atempoFilter = buildAtempoFilter(speed, { preservePitch });

      if (!v.trim() || v.length > MAX_PARAM_LEN) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Invalid parameter ?v=' }));
        return;
      }

      const trackList = v.includes(',') && !/^https?:\/\//i.test(v)
        ? v.split(',').map(s => s.trim()).filter(Boolean)
        : null;

      if (trackList && trackList.length > MAX_TRACK_LIST) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: `Too many tracks (max ${MAX_TRACK_LIST})` }));
        return;
      }

      const streamOpts = {
        itag,
        guest,
        startTimeMs,
        loop,
        speed,
        preservePitch,
      };
      const audioStream = trackList && trackList.length > 1
        ? createContinuousAudioStream(trackList, streamOpts)
        : createSabrAudioStream(v, streamOpts);

      let headersSent = false;

      const onInfo = ctx => {
        if (headersSent || res.writableEnded) return;
        headersSent = true;
        res.writeHead(200, {
          'Content-Type': 'audio/webm; codecs="opus"',
          'Transfer-Encoding': 'chunked',
          'Cache-Control': 'no-store',
          'X-Video-Id': ctx.videoId,
          'X-Audio-Itag': String(ctx.itag),
          'X-Audio-Mode': ctx.mode,
          'X-Duration-Ms': String(ctx.durationMs || 0),
          'X-Effective-Duration-Ms': String(Math.round((ctx.durationMs || 0) / speed)),
          'X-Audio-Bitrate': String(ctx.bitrate || 0),
          'X-Audio-Speed': String(speed),
          'X-Audio-Preserve-Pitch': String(preservePitch),
          'X-Audio-Atempo-Filter': atempoFilter,
        });
        if (req.method === 'HEAD') {
          audioStream.destroy();
          res.end();
        }
      };

      audioStream.once('info', onInfo);
      audioStream.once('trackStart', onInfo);

      audioStream.on('error', err => {
        if (!headersSent && !res.writableEnded) {
          headersSent = true;
          res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ error: err.message || String(err) }));
        } else if (!res.writableEnded) {
          res.destroy(err);
        }
      });

      req.on('close', () => {
        audioStream.destroy();
      });

      if (req.method !== 'HEAD') {
        audioStream.pipe(res);
      }
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: 'Not Found' }));
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => {
      const addr = server.address();
      boundPort = typeof addr === 'object' && addr ? addr.port : port;
      resolve({
        server,
        host,
        port: boundPort,
        url: `http://${host}:${boundPort}`,
        close: () => new Promise(res => server.close(res)),
      });
    });
  });
}

module.exports = {
  startServer,
};
