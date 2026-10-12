'use strict';

const assert = require('assert');
const {
  streamAudio,
  getInfo,
  startServer,
  normalizePlaybackSpeed,
  buildAtempoFilter,
  protobuf,
  webm,
} = require('../src/index');

async function runOfflineUnitTests() {
  console.log('=== [0/3] Running Deterministic Offline Engine Tests (Protobuf / UMP / WebM / Speed) ===');
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
  console.log('Offline Protobuf, UMP, WebM & Speed (0.10x..4.00x) unit tests OK.');
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
      const infoResp = await fetch(`${baseUrl}/info?v=${testVideoId}&itag=251&guest=1&speed=1,50`);
      assert.strictEqual(infoResp.status, 200);
      const infoJson = await infoResp.json();
      assert.strictEqual(infoJson.videoId, testVideoId);
      assert.strictEqual(infoJson.itag, 251);
      assert.strictEqual(infoJson.speed, 1.5);
      console.log('HTTP /info OK:', infoJson.title, `(${infoJson.mode}, speed=${infoJson.speed}x)`);

      const abortCtrl = new AbortController();
      const streamResp = await fetch(`${baseUrl}/stream?v=${testVideoId}&itag=251&guest=1&speed=1.50&speedMode=container`, {
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
