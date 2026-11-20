#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const pkg = require('../package.json');
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
  const lines = [
    `ytdlm v${pkg.version} — Real-Time YouTube SABR UMP Audio`,
    '================================================',
    '',
    'USAGE:',
    '  ytdlm stream <url_or_query> [options]',
    '  ytdlm <url_or_query> -o - [options]',
    '  ytdlm download <url_or_query> [-o file.opus]',
    '  ytdlm info <url_or_query> [-j]',
    '  ytdlm search <query> [-n 5] [-j]',
    '  ytdlm serve [--port 8787] [--host 127.0.0.1]',
    '  ytdlm auth <login|status|logout>',
    '',
    'OPTIONS:',
    '  -o, --output <path>   File, dir, or - for stdout',
    '  -f, --format <itag>   251 (Guest) or 774 (TV)',
    '  --guest               Force Guest TVHTML5 mode',
    '  --start <ms>          Start offset in ms',
    '  --speed <0.10..4.00>  Speed float (e.g. 1.25)',
    '  --no-preserve-pitch   Analog tape resampling mode',
    '  -j, --dump-json       Output yt-dlp JSON info',
    '  -n, --limit <num>     Max search results (def: 5)',
    '  -p, --port <port>     Server port (def: 8787)',
    '  --host <host>         Server bind host (127.0.0.1)',
    '  -q, --quiet           Suppress stderr logs',
    '  -v, --version         Show version number',
    '  -h, --help            Show this help message',
    '',
    'EXAMPLES (Creative Commons Benchmark aqz-KE-bpKQ):',
    '  ytdlm stream "aqz-KE-bpKQ" --speed 1.25 | mpv -',
    '  ytdlm "ytsearch:Big Buck Bunny" -f 251 -o -',
    '  ytdlm download "aqz-KE-bpKQ" -o ./music/',
    '  ytdlm serve --port 8787',
    '',
  ];
  process.stderr.write(lines.join('\n'));
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
    version: false,
  };

  const knownCommands = new Set(['stream', 'download', 'info', 'search', 'serve', 'auth']);
  let endOfOptions = false;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (endOfOptions) {
      args.positional.push(a);
      continue;
    }
    if (a === '--') {
      endOfOptions = true;
      continue;
    }
    if (a === '-h' || a === '--help') {
      args.help = true;
    } else if (a === '-v' || a === '--version') {
      args.version = true;
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
  if (args.version) {
    console.log(`v${pkg.version}`);
    process.exit(0);
  }
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
        console.log('\n=== YouTube TV OAuth Login (ITAG 774) ===');
        console.log(`1. Open URL : ${dc.verification_url}`);
        console.log(`2. Enter Code: ${dc.user_code}`);
        console.log('Waiting for authorization...');
        await auth.pollTvDeviceToken(dc.device_code, dc.interval || 5, dc.expires_in || 300);
        console.log('Login ok! Saved to ~/.ytdlm/auth.json');
        return;
      }
      throw new Error(`Unknown auth subcommand: ${sub}`);
    }

    if (args.command === 'serve') {
      const srv = await startServer({ port: args.port, host: args.host });
      log(`[ytdlm] Server listening on ${srv.url}`);
      log(`  • Stream   : ${srv.url}/stream?v=aqz-KE-bpKQ`);
      log(`  • Info     : ${srv.url}/info?v=aqz-KE-bpKQ`);
      log(`  • Search   : ${srv.url}/search?q=Big+Buck+Bunny`);
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
          const meta = `(${r.durationText || 'N/A'}) - ${r.author}`;
          console.log(`${idx + 1}. [${r.videoId}] ${r.title} ${meta}`);
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
            const kb = (p.bytes / 1024).toFixed(0);
            const spd = liveStream.speed || 1;
            const stat = `${p.percent}% (${kb} KB)`;
            process.stderr.write(`\r[ytdlm] ${p.itag} (${spd}x): ${stat}`);
          }
        },
      });

      liveStream.once('info', ctx => {
        const kbps = Math.round(ctx.bitrate / 1000);
        const meta = `${ctx.durationSec}s, itag=${ctx.itag}`;
        const spd = `speed=${ctx.speed || 1}x, ~${kbps}kbps`;
        log(`[ytdlm] [${ctx.mode}] "${ctx.title}" (${meta}, ${spd})`);
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
            const mb = (p.bytes / 1024 / 1024).toFixed(2);
            const mode = resInfoMode(p.itag);
            process.stderr.write(`\r[ytdlm] [${mode}] ${p.percent}% (${mb} MB)`);
          }
        },
      });
      if (!args.quiet && outTarget !== '-') process.stderr.write('\n');
      const mb = (res.sizeBytes / 1024 / 1024).toFixed(2);
      const spd = res.speed || 1;
      const stats = `${res.clustersCount} clusters, ${spd}x, ${mb} MB`;
      log(`[ytdlm] Saved (${stats}) -> ${res.outputPath}`);
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

if (require.main === module) {
  main();
}

module.exports = { parseArgs };
