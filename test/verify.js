'use strict';

const assert = require('assert');
const {
  streamAudio,
  getInfo,
  startServer,
  protobuf,
  webm,
} = require('../src/index');

async function runOfflineUnitTests() {
  console.log('=== [0/3] Running Deterministic Offline Engine Tests (Protobuf / UMP / WebM) ===');
  const v = protobuf.encodeVarint(300);
  const decoded = protobuf.decodeVarint(v, 0);
  assert.strictEqual(decoded.value, 300);

  const abrPayload = protobuf.buildPlaybackAbrRequest({
    clientAbrState: {
      playerTimeMs: 15000,
      enabledTrackTypesBitfield: 1,
      drcEnabled: false,
    },
    selectedAudioFormatIds: [{ itag: 251, lastModified: 1700000000000000 }],
    videoPlaybackUstreamerConfig: Buffer.from([0x08, 0x01]),
    streamerContext: {
      clientInfo: { clientName: 7, clientVersion: '7.20260318.18.00' },
    },
  });
  assert(Buffer.isBuffer(abrPayload) && abrPayload.length > 10, 'Expected valid ABR protobuf payload');

  const demuxer = new protobuf.UmpStreamDemuxer();
  const sampleData = Buffer.from('opus-test-frame');
  const umpChunk = Buffer.concat([
    protobuf.encodeUmpVarint(21),
    protobuf.encodeUmpVarint(sampleData.length),
    sampleData,
  ]);
  const parts = [];
  demuxer.push(umpChunk, (type, body) => parts.push({ type, body }));
  assert.strictEqual(parts.length, 1);
  assert.strictEqual(parts[0].type, 21);
  assert.strictEqual(parts[0].body.toString(), 'opus-test-frame');
  console.log('Offline Protobuf & UMP Demuxer unit tests OK.');
}

async function runVerification() {
  await runOfflineUnitTests();

  // Creative Commons Attribution 3.0 benchmark: Blender Foundation - Big Buck Bunny
  const testVideoId = 'aqz-KE-bpKQ';
  console.log('\n=== [1/3] Testing getInfo() (Guest TVHTML5 SABR 251) ===');
  const t0 = Date.now();
  let info;
  try {
    info = await getInfo(testVideoId, { itag: 251, guest: true });
  } catch (err) {
    if (process.env.CI) {
      console.warn(`[CI Notice] Skipping live YouTube CDN test on datacenter IP: ${err.message}`);
      console.log('\nALL OFFLINE YTDLM VERIFICATION TESTS PASSED IN CI!');
      return;
    }
    throw err;
  }

  console.log(`Resolved in ${Date.now() - t0}ms:`, {
    videoId: info.videoId,
    title: info.title,
    durationSec: info.durationSec,
    itag: info.itag,
    mode: info.mode,
    isGuest: info.isGuest,
    bitrate: info.bitrate,
  });

  assert.strictEqual(info.videoId, testVideoId);
  assert.strictEqual(info.isGuest, true);
  assert.strictEqual(info.itag, 251);

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

  console.log('\n=== [3/3] Testing HTTP Server (/info & /stream) ===');
  const srv = await startServer({ port: 0, host: '127.0.0.1' });
  const actualPort = srv.server.address().port;
  const baseUrl = `http://127.0.0.1:${actualPort}`;
  console.log(`Server started at ${baseUrl}`);

  try {
    const infoResp = await fetch(`${baseUrl}/info?v=${testVideoId}&itag=251&guest=1`);
    assert.strictEqual(infoResp.status, 200);
    const infoJson = await infoResp.json();
    assert.strictEqual(infoJson.videoId, testVideoId);
    assert.strictEqual(infoJson.itag, 251);
    console.log('HTTP /info OK:', infoJson.title, `(${infoJson.mode})`);

    const abortCtrl = new AbortController();
    const streamResp = await fetch(`${baseUrl}/stream?v=${testVideoId}&itag=251&guest=1`, {
      signal: abortCtrl.signal,
    });
    assert.strictEqual(streamResp.status, 200);
    assert.strictEqual(streamResp.headers.get('x-audio-itag'), '251');

    const reader = streamResp.body.getReader();
    const { value } = await reader.read();
    console.log(`HTTP /stream first chunk received: ${value.byteLength} bytes`);
    assert(value.byteLength > 0);
    abortCtrl.abort();
  } finally {
    await srv.close();
  }

  console.log('\nALL YTDLM VERIFICATION TESTS PASSED!');
}

runVerification().catch(err => {
  console.error('Verification failed:', err);
  process.exit(1);
});
