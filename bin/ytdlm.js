#!/usr/bin/env node
'use strict';

const path = require('path');
const {
  streamAudio,
  downloadAudio,
  getInfo,
  searchVideos,
  sanitizeFilename,
  startServer,
  auth,
} = require('../src/index');

function printHelp() {
  const help = `
ytdlm v1.1.0 — Real-Time YouTube SABR UMP Audio Streamer & Downloader
=====================================================================

USAGE:
  ytdlm stream <url_or_query> [options]        Stream live WebM/Opus audio to stdout (or file)
  ytdlm <url_or_query> -o - [options]          yt-dlp compatible stdout live pipe
  ytdlm download <url_or_query> [-o file.opus] Download seekable .opus with SeekHead + Cues
  ytdlm info <url_or_query> [-j]               Print track & SABR stream metadata
  ytdlm search <query> [-n 5] [-j]             Search YouTube videos (Guest mode)
  ytdlm serve [--port 8787] [--host 127.0.0.1] Start HTTP Streaming & Metadata Server
  ytdlm auth <login|status|logout>             Manage optional TV OAuth token (for ITAG 774)

OPTIONS:
  -o, --output <path>     Output file path, directory, or '-' for stdout live stream
  -f, --format <itag>     Audio format: 251 (Guest ~160kbps Opus), 774 (TV Premium ~256kbps Opus), or bestaudio
  --guest                 Force anonymous Guest TVHTML5 mode (default for itag 251)
  --start <ms>            Start streaming at offset in milliseconds (default: 0)
  --speed <0.10..4.00>    Playback speed float from 0.10 to 4.00 (supports "0,10".."4.00", default: 1.0)
  --no-preserve-pitch     Use pure analog tape waveform resampling (0% audio slicing/chopping)
  -j, --dump-json         Output metadata in JSON format (yt-dlp compatible fields included)
  -n, --limit <num>       Max search results (default: 5)
  -p, --port <port>       HTTP server port for 'serve' (default: 8787)
  --host <host>           HTTP server bind address (default: 127.0.0.1)
  -q, --quiet             Suppress progress/status logs on stderr
  -h, --help              Show this help message

EXAMPLES (Discord Bot / FFmpeg / MPV - Creative Commons Benchmark):
  # Stream live audio directly to FFmpeg or Discord bot via stdout pipe (with 1.25x speed):
  ytdlm stream "https://www.youtube.com/watch?v=aqz-KE-bpKQ" --speed 1.25 | ffplay -i pipe:0 -nodisp

  # Drop-in yt-dlp style stdout pipe:
  ytdlm "ytsearch:Big Buck Bunny Blender Foundation" -f 251 -o -

  # Download 100% seekable .opus file (with patched Duration, SeekHead & Cues):
  ytdlm download "https://www.youtube.com/watch?v=aqz-KE-bpKQ" -o ./music/

  # Start HTTP streaming micro-server for Java (Lavaplayer), Python, or Rust bots:
  ytdlm serve --port 8787
`;
  process.stderr.write(help.trimStart());
}

function parseArgs(argv) {
  const args = {
    command: null,
    positional: [],
    output: null,
    itag: null,
    guest: false,
    loop: false,
    startMs: 0,
    speed: 1.0,
    preservePitch: true,
    json: false,
    quiet: false,
    limit: 5,
    port: 8787,
    host: '127.0.0.1',
    help: false,
  };

  const knownCommands = new Set(['stream', 'download', 'info', 'search', 'serve', 'auth']);

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') {
      args.help = true;
    } else if (a === '-j' || a === '--dump-json' || a === '--json') {
      args.json = true;
    } else if (a === '-q' || a === '--quiet' || a === '--no-warnings') {
      args.quiet = true;
    } else if (a === '--guest') {
      args.guest = true;
    } else if (a === '--loop' || a === '--infinite') {
      args.loop = true;
    } else if (a === '--no-preserve-pitch' || a === '--tape') {
      args.preservePitch = false;
    } else if (a === '-o' || a === '--output') {
      args.output = argv[++i] || null;
    } else if (a === '-f' || a === '--format' || a === '--itag') {
      const val = argv[++i] || '';
      if (val === '251' || val === '250' || val === '249' || val === '774') {
        args.itag = Number(val);
      } else {
        args.itag = null; // auto / bestaudio
      }
    } else if (a === '--start' || a === '--start-ms') {
      args.startMs = Number(argv[++i] || 0);
    } else if (a === '--speed' || a === '--rate') {
      args.speed = argv[++i] || 1.0;
    } else if (a === '-n' || a === '--limit' || a === '--max-downloads') {
      args.limit = Number(argv[++i] || 5);
    } else if (a === '-p' || a === '--port') {
      args.port = Number(argv[++i] || 8787);
    } else if (a === '--host') {
      args.host = argv[++i] || '127.0.0.1';
    } else if (a.startsWith('-')) {
      // Ignore extra yt-dlp compatibility flags like --no-playlist, --extract-audio, -x
      continue;
    } else if (!args.command && args.positional.length === 0 && knownCommands.has(a.toLowerCase())) {
      args.command = a.toLowerCase();
    } else {
      args.positional.push(a);
    }
  }

  if (!args.command) {
    if (args.json) {
      args.command = 'info';
    } else if (args.output === '-') {
      args.command = 'stream';
    } else if (args.positional.length > 0) {
      args.command = 'download';
    }
  }

  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.command) {
    printHelp();
    process.exit(args.help ? 0 : 1);
  }

  const log = msg => {
    if (!args.quiet) process.stderr.write(`${msg}\n`);
  };

  try {
    if (args.command === 'auth') {
      const sub = (args.positional[0] || 'status').toLowerCase();
      if (sub === 'logout' || sub === 'clear') {
        auth.clearStoredAuth();
        console.log('Cleared stored TV OAuth token.');
        return;
      }
      if (sub === 'status') {
        const stored = auth.loadStoredAuth();
        if (!stored || !stored.access_token) {
          console.log(JSON.stringify({ authenticated: false, mode: 'TV_GUEST_SABR_251' }, null, 2));
        } else {
          console.log(
            JSON.stringify(
              {
                authenticated: true,
                mode: 'TV_PREMIUM_SABR_774',
                expiresAt: new Date(stored.expires_at || 0).toISOString(),
              },
              null,
              2
            )
          );
        }
        return;
      }
      if (sub === 'login') {
        const dc = await auth.requestTvDeviceCode();
        console.log(`\n=== YouTube TV OAuth Login (For ITAG 774 High-Quality Audio) ===`);
        console.log(`1. Open URL : ${dc.verification_url}`);
        console.log(`2. Enter Code: ${dc.user_code}`);
        console.log(`Waiting for authorization...`);
        await auth.pollTvDeviceToken(dc.device_code, dc.interval || 5, dc.expires_in || 300);
        console.log(`Login successful! Saved token to ~/.ytdlm/auth.json`);
        return;
      }
      throw new Error(`Unknown auth subcommand: ${sub}`);
    }

    if (args.command === 'serve') {
      const srv = await startServer({ port: args.port, host: args.host });
      log(`[ytdlm] HTTP Streaming & Metadata Server listening on ${srv.url}`);
      log(`  • Live Opus Stream : ${srv.url}/stream?v=aqz-KE-bpKQ`);
      log(`  • Track Metadata   : ${srv.url}/info?v=aqz-KE-bpKQ`);
      log(`  • YouTube Search   : ${srv.url}/search?q=Big+Buck+Bunny+Blender`);
      return;
    }

    const target = args.positional.join(' ').trim();
    if (!target) {
      printHelp();
      process.exit(1);
    }

    if (args.command === 'search') {
      const results = await searchVideos(target, args.limit);
      if (args.json) {
        console.log(JSON.stringify(results, null, 2));
      } else {
        for (const [idx, r] of results.entries()) {
          console.log(`${idx + 1}. [${r.videoId}] ${r.title} (${r.durationText || 'N/A'}) - ${r.author}`);
        }
      }
      return;
    }

    if (args.command === 'info') {
      const info = await getInfo(target, {
        itag: args.itag,
        guest: args.guest,
        speed: args.speed,
        preservePitch: args.preservePitch,
      });
      const ytDlpCompat = {
        id: info.videoId,
        videoId: info.videoId,
        title: info.title,
        uploader: info.author,
        author: info.author,
        duration: info.durationSec,
        durationMs: info.durationMs,
        effectiveDurationMs: info.effectiveDurationMs,
        webpage_url: info.url,
        thumbnail: info.thumbnail,
        format_id: String(info.itag),
        itag: info.itag,
        ext: 'opus',
        acodec: 'opus',
        abr: Math.round((info.bitrate || 135000) / 1000),
        asr: info.sampleRate,
        audio_channels: info.channels,
        isGuest: info.isGuest,
        mode: info.mode,
        speed: info.speed,
        preservePitch: info.preservePitch,
        atempoFilter: info.atempoFilter,
        filename: info.filename,
      };
      console.log(JSON.stringify(ytDlpCompat, null, 2));
      return;
    }

    if (args.command === 'stream') {
      const outPath = args.output || '-';
      const liveStream = streamAudio(target, {
        itag: args.itag,
        guest: args.guest,
        startTimeMs: args.startMs,
        loop: args.loop,
        speed: args.speed,
        preservePitch: args.preservePitch,
        onProgress(p) {
          if (!args.quiet && outPath !== '-') {
            process.stderr.write(
              `\r[ytdlm] Streaming itag=${p.itag} (${liveStream.speed || 1}x): ${p.percent}% (${(p.bytes / 1024).toFixed(0)} KB)`
            );
          }
        },
      });

      liveStream.once('info', ctx => {
        log(
          `[ytdlm] Live Stream [${ctx.mode}] "${ctx.title}" (${ctx.durationSec}s, itag=${ctx.itag}, speed=${ctx.speed || 1}x, ~${Math.round(
            ctx.bitrate / 1000
          )}kbps)`
        );
      });

      await new Promise((resolve, reject) => {
        liveStream.on('error', reject);
        if (outPath === '-') {
          process.stdout.on('error', err => {
            if (err.code === 'EPIPE') {
              liveStream.destroy();
              resolve();
            } else {
              reject(err);
            }
          });
          liveStream.on('end', resolve);
          liveStream.pipe(process.stdout);
        } else {
          const fs = require('fs');
          const fileStream = fs.createWriteStream(path.resolve(outPath));
          fileStream.on('error', reject);
          fileStream.on('finish', () => {
            if (!args.quiet) process.stderr.write('\n');
            resolve();
          });
          liveStream.pipe(fileStream);
        }
      });
      return;
    }

    if (args.command === 'download') {
      let outTarget = args.output;
      if (!outTarget) {
        const info = await getInfo(target, {
          itag: args.itag,
          guest: args.guest,
          speed: args.speed,
          preservePitch: args.preservePitch,
        });
        outTarget = path.resolve(process.cwd(), sanitizeFilename(info.title, info.author, info.itag));
      }

      log(`[ytdlm] Resolving SABR UMP audio for: ${target}`);
      const res = await downloadAudio(target, outTarget, {
        itag: args.itag,
        guest: args.guest,
        speed: args.speed,
        preservePitch: args.preservePitch,
        onProgress(p) {
          if (!args.quiet && outTarget !== '-') {
            process.stderr.write(
              `\r[ytdlm] Downloading [${resInfoMode(p.itag)}] ${p.percent}% (${(p.bytes / 1024 / 1024).toFixed(2)} MB)`
            );
          }
        },
      });
      if (!args.quiet && outTarget !== '-') process.stderr.write('\n');
      log(
        `[ytdlm] Saved seekable WebM/Opus (${res.clustersCount} clusters, speed=${res.speed || 1}x, ${(res.sizeBytes / 1024 / 1024).toFixed(
          2
        )} MB) -> ${res.outputPath}`
      );
      return;
    }
  } catch (err) {
    process.stderr.write(`\n[ytdlm error] ${err.message || err}\n`);
    process.exit(1);
  }
}

function resInfoMode(itag) {
  return itag === 774 ? 'TV_PREMIUM_774' : `TV_GUEST_${itag}`;
}

main();
