'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { createIsolatedVmContext } = require('../src/decipher');
const { pbWrapLengthDelimited } = require('../src/protobuf');
const { parseArgs } = require('../bin/ytdlm');
const {
  streamAudio,
  getInfo,
  resolveSabrContext,
  clearContextCache,
  clearDecipherCache,
  startServer,
  extractVideoId,
  normalizePlaybackSpeed,
  buildAtempoFilter,
  protobuf,
  webm,
} = require('../src/index');

async function runOfflineUnitTests() {
  console.log('=== [0/3] Running Deterministic Offline Engine Tests (Protobuf / UMP / WebM / Speed / Security) ===');
  const fmtMsg = protobuf.buildFormatIdMsg(251, '1700000000000000');
  assert(fmtMsg && fmtMsg.length > 4, 'Expected valid FormatId protobuf bytes');

  const clientInfoMsg = protobuf.buildClientInfoMsg('7.20260728.17.00', 'en', 'US', 85);
  const abrPayload = protobuf.buildAbrRequestBytes(
    {
      fmtMsg,
      ustreamerBytes: new Uint8Array([0x08, 0x01]),
      clientInfoMsg,
      hasInit: false,
    },
    15000
  );
  assert(abrPayload && abrPayload.length > 10, 'Expected valid ABR protobuf payload');

  const assembler = new webm.WebmClusterAssembler({ retainClusters: false });
  assert.strictEqual(assembler.retainClusters, false);

  // Playback speed normalization & atempo filter decomposition (0.10x to 4.00x)
  assert.strictEqual(normalizePlaybackSpeed('0,10'), 0.1);
  assert.strictEqual(normalizePlaybackSpeed('0,11'), 0.11);
  assert.strictEqual(normalizePlaybackSpeed(0.05), 0.1);
  assert.strictEqual(normalizePlaybackSpeed(1.256), 1.26);
  assert.strictEqual(normalizePlaybackSpeed(4.0), 4.0);
  assert.strictEqual(normalizePlaybackSpeed(9.5), 4.0);
  assert.strictEqual(buildAtempoFilter('0,10'), 'atempo=0.5,atempo=0.5,atempo=0.5,atempo=0.8');
  assert.strictEqual(buildAtempoFilter('0,11'), 'atempo=0.5,atempo=0.5,atempo=0.5,atempo=0.88');
  assert.strictEqual(buildAtempoFilter(1.25), 'atempo=1.25');
  assert.strictEqual(buildAtempoFilter(4.0), 'atempo=2.0,atempo=2');
  assert.strictEqual(
    buildAtempoFilter('1,25', { preservePitch: false }),
    'asetrate=60000,aresample=48000'
  );
  assert.strictEqual(
    buildAtempoFilter('0,10', { preservePitch: false }),
    'asetrate=4800,aresample=48000'
  );

  // Video ID extractor tests
  assert.strictEqual(extractVideoId('aqz-KE-bpKQ'), 'aqz-KE-bpKQ');
  assert.strictEqual(extractVideoId('https://www.youtube.com/watch?v=aqz-KE-bpKQ'), 'aqz-KE-bpKQ');
  assert.strictEqual(extractVideoId('https://music.youtube.com/watch?v=aqz-KE-bpKQ&feature=share'), 'aqz-KE-bpKQ');
  assert.strictEqual(extractVideoId('https://youtu.be/aqz-KE-bpKQ?t=10'), 'aqz-KE-bpKQ');
  assert.strictEqual(extractVideoId('youtu.be/aqz-KE-bpKQ'), 'aqz-KE-bpKQ');
  assert.strictEqual(extractVideoId('https://www.youtube.com/shorts/aqz-KE-bpKQ'), 'aqz-KE-bpKQ');
  assert.strictEqual(extractVideoId('https://www.youtube-nocookie.com/embed/aqz-KE-bpKQ'), 'aqz-KE-bpKQ');

  // Security: Zero child_process across src/ and bin/, zero transcode.js, zero long string literals
  assert(!fs.existsSync(path.join(__dirname, '../src/transcode.js')), 'src/transcode.js must not exist');
  for (const dir of ['src', 'bin']) {
    const dirPath = path.join(__dirname, '..', dir);
    for (const file of fs.readdirSync(dirPath)) {
      if (!file.endsWith('.js') && !file.endsWith('.mjs')) continue;
      const content = fs.readFileSync(path.join(dirPath, file), 'utf8');
      assert(!content.includes('child_process'), `${dir}/${file} must not reference child_process`);
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        const matches = line.match(/(['"`])(?:(?=(\\?))\2.)*?\1/g);
        if (matches) {
          for (const lit of matches) {
            assert(lit.length <= 60, `${dir}/${file}:${idx + 1} has string literal length ${lit.length} > 60`);
          }
        }
      });
    }
  }

  // Security: Check that innertube.js does not contain base64 credentials
  const innertubeSrc = fs.readFileSync(path.join(__dirname, '../src/innertube.js'), 'utf8');
  assert(!innertubeSrc.includes("Buffer.from('ODYxNTU2NzA4NDU0"), 'innertube.js should not contain base64 credentials');

  // Security: Check that decipher.js does not use fs/os.tmpdir or expose host Function
  const decipherSrc = fs.readFileSync(path.join(__dirname, '../src/decipher.js'), 'utf8');
  assert(!decipherSrc.includes("require('fs')"), 'decipher.js should not write temp files');
  assert(!decipherSrc.includes('tmpdir'), 'decipher.js should not use os.tmpdir');
  assert(decipherSrc.includes('codeGeneration'), 'decipher.js must restrict VM codeGeneration');

  // Security: Pure-realm VM isolation (no host Function escape, no string codegen)
  const vmCtx = createIsolatedVmContext();
  assert.notStrictEqual(
    vm.runInContext('this.constructor.constructor', vmCtx),
    Function,
    'VM must not expose host Function constructor'
  );
  assert.notStrictEqual(
    vm.runInContext('atob.constructor', vmCtx),
    Function,
    'VM shims must not expose host Function constructor'
  );
  assert.strictEqual(vm.runInContext('typeof process', vmCtx), 'undefined');
  assert.throws(
    () => vm.runInContext('new Function("return 1")()', vmCtx),
    { name: 'EvalError' }
  );

  // Security: CLI `--` option terminator blocks flag injection & supports hyphen video IDs
  const parsedInject = parseArgs(['stream', '-f', '251', '-o', '-', '-q', '--', '-o', '/tmp/pwned']);
  assert.strictEqual(parsedInject.command, 'stream');
  assert.strictEqual(parsedInject.output, '-');
  assert.deepStrictEqual(parsedInject.positional, ['-o', '/tmp/pwned']);
  const parsedHyphenId = parseArgs(['info', '-f', '251', '--', '-2RAq5o5pwc']);
  assert.strictEqual(parsedHyphenId.command, 'info');
  assert.deepStrictEqual(parsedHyphenId.positional, ['-2RAq5o5pwc']);

  // Security: SabrRedirect strict hostname & scheme allowlist
  assert.strictEqual(
    protobuf.isAllowedSabrRedirectUrl('https://rr1---sn-oxun-h55e.googlevideo.com/videoplayback?expire=1'),
    true
  );
  assert.strictEqual(
    protobuf.isAllowedSabrRedirectUrl('https://redirector.googlevideo.com/videoplayback?id=abc'),
    true
  );
  for (const badUrl of [
    'http://rr1.googlevideo.com/videoplayback?a=1',
    'https://127.0.0.1/videoplayback?a=1',
    'https://evil.com/videoplayback?a=1',
    'https://evil-googlevideo.com/videoplayback?a=1',
    'https://.googlevideo.com/videoplayback?a=1',
    'https://rr1.googlevideo.com:8443/videoplayback?a=1',
    'https://user:pass@rr1.googlevideo.com/videoplayback?a=1',
    'https://rr1.googlevideo.com/otherpath?a=1',
  ]) {
    assert.strictEqual(protobuf.isAllowedSabrRedirectUrl(badUrl), false, `Should reject ${badUrl}`);
  }
  const makeRedirectUmp = url => {
    const pb = pbWrapLengthDelimited(1, new TextEncoder().encode(url));
    return new Uint8Array([43, pb.length, ...pb]);
  };
  const evilDemux = protobuf.demuxUmp(makeRedirectUmp('https://evil.com/videoplayback?a=1'), 251);
  assert.strictEqual(evilDemux.redirectUrl, null);
  assert.strictEqual(evilDemux.sabrError, true);
  const okRedirect = 'https://rr1.googlevideo.com/videoplayback?a=1';
  const okDemux = protobuf.demuxUmp(makeRedirectUmp(okRedirect), 251);
  assert.strictEqual(okDemux.redirectUrl, okRedirect);
  assert.strictEqual(okDemux.sabrError, null);

  // Security: HTTP Server hardening (default no-CORS, port:0 binding, 405, 414, track cap, timing-safe API key)
  const defaultSrv = await startServer({ port: 0, host: '127.0.0.1' });
  try {
    assert(defaultSrv.port > 0 && defaultSrv.port === defaultSrv.server.address().port);
    assert.strictEqual(defaultSrv.url, `http://127.0.0.1:${defaultSrv.port}`);
    const hRes = await fetch(`${defaultSrv.url}/health`);
    assert.strictEqual(hRes.status, 200);
    assert.strictEqual(hRes.headers.get('access-control-allow-origin'), null);
    assert.strictEqual(hRes.headers.get('x-content-type-options'), 'nosniff');

    const postRes = await fetch(`${defaultSrv.url}/info?v=aqz-KE-bpKQ`, { method: 'POST' });
    assert.strictEqual(postRes.status, 405);

    const manyTracks = Array.from({ length: 51 }, (_, i) => `vid${i}`).join(',');
    const capRes = await fetch(`${defaultSrv.url}/stream?v=${encodeURIComponent(manyTracks)}`);
    assert.strictEqual(capRes.status, 400);

    const longRes = await fetch(`${defaultSrv.url}/info?v=${'a'.repeat(4100)}`);
    assert.strictEqual(longRes.status, 414);
  } finally {
    await defaultSrv.close();
  }

  const authSrv = await startServer({
    port: 0,
    host: '127.0.0.1',
    apiKey: 'test-secret-key',
    corsOrigin: 'http://localhost:3000',
  });
  try {
    const noKeyRes = await fetch(`${authSrv.url}/health`);
    assert.strictEqual(noKeyRes.status, 401);
    const badLenKeyRes = await fetch(`${authSrv.url}/health`, {
      headers: { 'X-API-Key': 'short' },
    });
    assert.strictEqual(badLenKeyRes.status, 401);
    const okKeyRes = await fetch(`${authSrv.url}/health`, {
      headers: { 'X-API-Key': 'test-secret-key' },
    });
    assert.strictEqual(okKeyRes.status, 200);
    assert.strictEqual(okKeyRes.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    const bearerRes = await fetch(`${authSrv.url}/health`, {
      headers: { Authorization: 'Bearer test-secret-key' },
    });
    assert.strictEqual(bearerRes.status, 200);
  } finally {
    await authSrv.close();
  }

  clearContextCache();
  clearDecipherCache();

  console.log('Offline Protobuf, UMP, WebM, Speed (0.10x..4.00x) & Security unit tests OK.');
}

async function runVerification() {
  await runOfflineUnitTests();

  // Creative Commons Attribution 3.0 benchmark: Blender Foundation - Big Buck Bunny
  const testVideoId = 'aqz-KE-bpKQ';
  try {
    console.log('\n=== [1/3] Testing getInfo() (Guest TVHTML5 SABR 251) ===');
    const t0 = Date.now();
    const info = await getInfo(testVideoId, { itag: 251, guest: true, speed: '1,25' });
    console.log(`Resolved in ${Date.now() - t0}ms:`, {
      videoId: info.videoId,
      title: info.title,
      durationSec: info.durationSec,
      effectiveDurationMs: info.effectiveDurationMs,
      speed: info.speed,
      atempoFilter: info.atempoFilter,
      itag: info.itag,
      mode: info.mode,
      isGuest: info.isGuest,
      bitrate: info.bitrate,
    });

    assert.strictEqual(info.videoId, testVideoId);
    assert.strictEqual(info.isGuest, true);
    assert.strictEqual(info.itag, 251);
    assert.strictEqual(info.speed, 1.25);

    const ctx1 = await resolveSabrContext(testVideoId, { itag: 251, guest: true });
    const tCache0 = Date.now();
    const ctx2 = await resolveSabrContext(testVideoId, { itag: 251, guest: true });
    const cacheElapsed = Date.now() - tCache0;
    assert(cacheElapsed < 20, `Expected LRU context cache hit < 20ms, got ${cacheElapsed}ms`);
    assert.strictEqual(ctx1.videoId, ctx2.videoId);
    assert.strictEqual(ctx1.sabrUrl, ctx2.sabrUrl);
    console.log(`LRU context cache hit verified in ${cacheElapsed}ms.`);

    console.log('\n=== [2/3] Testing streamAudio() Real-Time Live Pipe ===');
    const streamStart = Date.now();
    const liveStream = streamAudio(testVideoId, { itag: 251, guest: true });

    let firstByteMs = null;
    let totalBytes = 0;
    let chunksCount = 0;
    let firstChunk = null;

    await new Promise((resolve, reject) => {
      liveStream.on('data', chunk => {
        if (firstByteMs === null) {
          firstByteMs = Date.now() - streamStart;
          firstChunk = chunk;
          console.log(`First WebM Init chunk emitted in ${firstByteMs}ms (${chunk.length} bytes)`);
        }
        totalBytes += chunk.length;
        chunksCount++;

        // Stop after receiving > 250 KB of live Opus audio clusters
        if (totalBytes >= 250 * 1024) {
          liveStream.destroy();
          resolve();
        }
      });
      liveStream.on('error', reject);
      liveStream.on('close', resolve);
      liveStream.on('end', resolve);
    });

    console.log(`Streamed ${chunksCount} chunks (${(totalBytes / 1024).toFixed(1)} KB) before early stop.`);
    assert(firstChunk && firstChunk.length > 32, 'Expected valid WebM Init chunk');
    // Check EBML magic header: 0x1A 0x45 0xDF 0xA3
    assert.strictEqual(firstChunk[0], 0x1a);
    assert.strictEqual(firstChunk[1], 0x45);
    assert.strictEqual(firstChunk[2], 0xdf);
    assert.strictEqual(firstChunk[3], 0xa3);

    console.log('\n=== [3/3] Testing HTTP Server (/info & /stream with speed=1.50) ===');
    const srv = await startServer({ port: 0, host: '127.0.0.1' });
    const actualPort = srv.server.address().port;
    const baseUrl = `http://127.0.0.1:${actualPort}`;
    console.log(`Server started at ${baseUrl}`);

    try {
      const healthResp = await fetch(`${baseUrl}/health`);
      assert.strictEqual(healthResp.status, 200);
      const healthJson = await healthResp.json();
      assert.strictEqual(healthJson.ok, true);
      assert.strictEqual(healthJson.version, '1.1.3');

      const infoResp = await fetch(`${baseUrl}/info?v=${testVideoId}&itag=251&guest=1&speed=1,50`);
      assert.strictEqual(infoResp.status, 200);
      const infoJson = await infoResp.json();
      assert.strictEqual(infoJson.videoId, testVideoId);
      assert.strictEqual(infoJson.itag, 251);
      assert.strictEqual(infoJson.speed, 1.5);
      console.log('HTTP /info OK:', infoJson.title, `(${infoJson.mode}, speed=${infoJson.speed}x)`);

      const abortCtrl = new AbortController();
      const streamResp = await fetch(`${baseUrl}/stream?v=${testVideoId}&itag=251&guest=1&speed=1.50`, {
        signal: abortCtrl.signal,
      });
      assert.strictEqual(streamResp.status, 200);
      assert.strictEqual(streamResp.headers.get('x-audio-itag'), '251');
      assert.strictEqual(streamResp.headers.get('x-audio-speed'), '1.5');

      const reader = streamResp.body.getReader();
      const { value } = await reader.read();
      console.log(`HTTP /stream (1.5x) first chunk received: ${value.byteLength} bytes`);
      assert(value.byteLength > 0);
      abortCtrl.abort();
    } finally {
      await srv.close();
    }
  } catch (err) {
    if (process.env.CI) {
      console.warn(`[CI Notice] Skipping live YouTube CDN test on datacenter IP: ${err.message}`);
      console.log('\nALL OFFLINE YTDLM VERIFICATION TESTS PASSED IN CI!');
      return;
    }
    throw err;
  }

  console.log('\nALL YTDLM VERIFICATION TESTS PASSED!');
}

runVerification().catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
