'use strict';

const http = require('http');
const { createSabrAudioStream, createContinuousAudioStream } = require('./sabr-stream');
const { resolveSabrContext, searchVideos } = require('./innertube');
const { normalizePlaybackSpeed, buildAtempoFilter } = require('./webm');

/**
 * Starts a local HTTP streaming & metadata gateway server for multi-language Discord bots
 * (Lavaplayer, Lavalink, JDA, discord.py, Songbird/Rust, Go, C#).
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

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (apiKey) {
      const provided =
        req.headers['x-api-key'] ||
        (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
      if (provided !== apiKey) {
        res.writeHead(401, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Unauthorized' }));
        return;
      }
    }

    let parsedUrl;
    try {
      parsedUrl = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
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
          version: '1.1.0',
          endpoints: ['/stream?v=<id_or_url>&speed=1.0', '/info?v=<id_or_url>', '/search?q=<query>'],
        })
      );
      return;
    }

    if (pathname === '/search') {
      const q = parsedUrl.searchParams.get('q') || parsedUrl.searchParams.get('query') || '';
      const limit = Math.min(20, Math.max(1, Number(parsedUrl.searchParams.get('limit') || 5)));
      if (!q.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Missing query parameter ?q=' }));
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

      if (!v.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Missing parameter ?v=<video_id_or_url>' }));
        return;
      }

      try {
        const ctx = await resolveSabrContext(v, { itag, guest });
        const speedParam = speed !== 1.0 ? `&speed=${speed}` : '';
        const pitchQuery = !preservePitch ? '&preservePitch=0' : '';
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
            streamUrl: `http://${host}:${port}/stream?v=${encodeURIComponent(ctx.videoId)}&itag=${ctx.itag}${speedParam}${pitchQuery}`,
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
      const startTimeMs = Number(parsedUrl.searchParams.get('start') || parsedUrl.searchParams.get('startTimeMs') || 0);
      const loopParam = parsedUrl.searchParams.get('loop');
      const loop = loopParam === '1' || loopParam === 'true';
      const speed = normalizePlaybackSpeed(parsedUrl.searchParams.get('speed') || parsedUrl.searchParams.get('rate') || 1.0);
      const speedMode = parsedUrl.searchParams.get('speedMode') || 'auto';
      const pitchParam = parsedUrl.searchParams.get('preservePitch');
      const tapeParam = parsedUrl.searchParams.get('tape');
      const preservePitch = tapeParam === '1' || tapeParam === 'true' ? false : pitchParam !== '0' && pitchParam !== 'false';
      const atempoFilter = buildAtempoFilter(speed, { preservePitch });

      if (!v.trim()) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: 'Missing parameter ?v=<video_id_or_url>' }));
        return;
      }

      const trackList = v.includes(',') && !/^https?:\/\//i.test(v)
        ? v.split(',').map(s => s.trim()).filter(Boolean)
        : null;

      const audioStream = trackList && trackList.length > 1
        ? createContinuousAudioStream(trackList, {
            itag,
            guest,
            startTimeMs,
            loop,
            speed,
            speedMode,
            preservePitch,
          })
        : createSabrAudioStream(v, {
            itag,
            guest,
            startTimeMs,
            loop,
            speed,
            speedMode,
            preservePitch,
          });

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
      resolve({
        server,
        host,
        port,
        url: `http://${host}:${port}`,
        close: () => new Promise(res => server.close(res)),
      });
    });
  });
}

module.exports = {
  startServer,
};
