'use strict';

function readEbmlId(bytes, offset) {
  if (!bytes || offset >= bytes.length) return null;
  const first = bytes[offset];
  if (first === 0) return null;
  let len = 1;
  let mask = 0x80;
  while (len <= 4 && (first & mask) === 0) {
    len++;
    mask >>= 1;
  }
  if (len > 4 || offset + len > bytes.length) return null;
  let id = 0;
  for (let i = 0; i < len; i++) {
    id = (id * 256) + bytes[offset + i];
  }
  return { id, length: len };
}

function readEbmlVint(bytes, offset) {
  if (!bytes || offset >= bytes.length) return null;
  const first = bytes[offset];
  if (first === 0) return null;
  let len = 1;
  let mask = 0x80;
  while (len <= 8 && (first & mask) === 0) {
    len++;
    mask >>= 1;
  }
  if (len > 8 || offset + len > bytes.length) return null;
  let value = first & (mask - 1);
  let allOnes = (value === (mask - 1));
  for (let i = 1; i < len; i++) {
    const b = bytes[offset + i];
    if (b !== 0xff) allOnes = false;
    value = (value * 256) + b;
  }
  return { value, length: len, isUnknown: allOnes };
}

function encodeEbmlVint(value, fixedLength = 0) {
  let v = BigInt(Math.max(0, Math.floor(Number(value) || 0)));
  let len = fixedLength;
  if (!len) {
    if (v < 0x7fn) len = 1;
    else if (v < 0x3fffn) len = 2;
    else if (v < 0x1fffffn) len = 3;
    else if (v < 0x0fffffffn) len = 4;
    else if (v < 0x07ffffffffn) len = 5;
    else if (v < 0x03ffffffffffn) len = 6;
    else if (v < 0x01ffffffffffffn) len = 7;
    else len = 8;
  }
  const out = new Uint8Array(len);
  for (let i = len - 1; i >= 0; i--) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  out[0] |= (1 << (8 - len));
  return out;
}

function encodeEbmlUInt(id, value) {
  let idBytes = [];
  let tempId = id;
  while (tempId > 0) {
    idBytes.unshift(tempId & 0xff);
    tempId = Math.floor(tempId / 256);
  }
  let v = BigInt(Math.max(0, Math.floor(Number(value) || 0)));
  let valBytes = [];
  if (v === 0n) {
    valBytes.push(0);
  } else {
    while (v > 0n) {
      valBytes.unshift(Number(v & 0xffn));
      v >>= 8n;
    }
  }
  const vint = encodeEbmlVint(valBytes.length);
  const out = new Uint8Array(idBytes.length + vint.length + valBytes.length);
  out.set(idBytes, 0);
  out.set(vint, idBytes.length);
  out.set(valBytes, idBytes.length + vint.length);
  return out;
}

function isAudioInitSegment(bytes) {
  if (!bytes || bytes.length < 32) return false;
  // Reject DRM / encrypted ContentEncodings (0x6D80)
  for (let i = 0; i < bytes.length - 1; i++) {
    if (bytes[i] === 0x6d && bytes[i + 1] === 0x80) {
      const sz = readEbmlVint(bytes, i + 2);
      if (sz && !sz.isUnknown && sz.value > 0 && sz.value < 512) {
        return false;
      }
    }
  }
  // Check Opus ("A_OPUS") or Vorbis ("A_VORBIS") or Audio TrackType (0x83 0x81 0x02)
  const str = Buffer.from(bytes.subarray(0, Math.min(bytes.length, 4096))).toString('latin1');
  if (str.includes('A_OPUS') || str.includes('A_VORBIS') || str.includes('A_AAC')) return true;
  for (let i = 0; i < bytes.length - 2; i++) {
    if (bytes[i] === 0x83 && bytes[i + 1] === 0x81 && bytes[i + 2] === 0x02) return true;
  }
  return false;
}

const MIN_PLAYBACK_SPEED = 0.10;
const MAX_PLAYBACK_SPEED = 4.00;

/**
 * Normalizes and clamps playback speed to a 2-decimal float in [0.10, 4.00].
 * Supports both dot ("0.10", 1.25) and comma ("0,10", "0,11") decimal formats.
 *
 * @param {number|string} [speed=1.0]
 * @returns {number} Normalized speed in [0.10, 4.00] (e.g. 0.1, 0.11, 1.25, 4)
 */
function normalizePlaybackSpeed(speed) {
  if (speed === undefined || speed === null || speed === '') return 1.0;
  const parsed =
    typeof speed === 'string'
      ? Number(speed.trim().replace(',', '.'))
      : Number(speed);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1.0;
  const clamped = Math.min(MAX_PLAYBACK_SPEED, Math.max(MIN_PLAYBACK_SPEED, parsed));
  return Math.round(clamped * 100) / 100;
}

/**
 * Builds an FFmpeg audio filter chain for any playback speed in [0.10, 4.00].
 *
 * - When `preservePitch = true` (default): Uses cascaded `atempo` stages within [0.5, 2.0]
 *   to keep original vocal pitch.
 * - When `preservePitch = false` ("tape" / lossless waveform mode): Uses continuous sample-rate
 *   interpolation (`asetrate=48000*speed,aresample=48000`) which NEVER drops or duplicates
 *   time slices (zero WSOLA chopping/stuttering artifacts, even at extreme 0.10x or 4.00x speeds).
 *
 * @param {number|string} [speed=1.0]
 * @param {object} [options]
 * @param {boolean} [options.preservePitch=true]
 * @param {number} [options.sampleRate=48000]
 * @returns {string}
 */
function buildAtempoFilter(speed, options = {}) {
  const spd = normalizePlaybackSpeed(speed);
  const preservePitch = options.preservePitch !== false;
  const sampleRate = Number(options.sampleRate) || 48000;

  if (Math.abs(spd - 1.0) < 1e-4) return 'atempo=1.0';

  if (!preservePitch) {
    const targetRate = Math.max(4800, Math.round(sampleRate * spd));
    return `asetrate=${targetRate},aresample=${sampleRate}`;
  }

  const stages = [];
  let rem = spd;
  while (rem < 0.5 - 1e-6) {
    stages.push('atempo=0.5');
    rem /= 0.5;
  }
  while (rem > 2.0 + 1e-6) {
    stages.push('atempo=2.0');
    rem /= 2.0;
  }
  const finalStage = Math.round(rem * 10000) / 10000;
  if (Math.abs(finalStage - 1.0) > 1e-4 || stages.length === 0) {
    stages.push(`atempo=${finalStage}`);
  }
  return stages.join(',');
}

function parseAndPatchWebmInit(initBytes, durationMs, speed = 1.0) {
  if (!initBytes || initBytes.length < 32) return null;
  const spd = normalizePlaybackSpeed(speed);
  const firstId = readEbmlId(initBytes, 0);
  if (!firstId || firstId.id !== 0x1a45dfa3) return null;
  const ebmlSz = readEbmlVint(initBytes, firstId.length);
  if (!ebmlSz) return null;
  const ebmlEnd = firstId.length + ebmlSz.length + ebmlSz.value;
  if (ebmlEnd + 8 > initBytes.length) return null;

  const ebmlHeader = initBytes.slice(0, ebmlEnd);
  const segId = readEbmlId(initBytes, ebmlEnd);
  if (!segId || segId.id !== 0x18538067) return null;
  const segSz = readEbmlVint(initBytes, ebmlEnd + segId.length);
  if (!segSz) return null;

  let pos = ebmlEnd + segId.length + segSz.length;
  let infoElem = null;
  let tracksElem = null;
  const otherElems = [];
  let timecodeScaleNs = 1000000;
  let effectiveTimecodeScaleNs = 1000000;
  let trackNumber = 1;

  while (pos < initBytes.length) {
    const elId = readEbmlId(initBytes, pos);
    if (!elId || elId.id === 0x1f43b675) break;
    const elSz = readEbmlVint(initBytes, pos + elId.length);
    if (!elSz) break;
    const dataStart = pos + elId.length + elSz.length;
    const dataEnd = elSz.isUnknown ? initBytes.length : Math.min(initBytes.length, dataStart + elSz.value);

    if (elId.id === 0x1549a966) {
      // Info (Segment Information)
      let iPos = dataStart;
      const children = [];
      while (iPos < dataEnd) {
        const cId = readEbmlId(initBytes, iPos);
        if (!cId) break;
        const cSz = readEbmlVint(initBytes, iPos + cId.length);
        if (!cSz) break;
        const cDataStart = iPos + cId.length + cSz.length;
        const cDataEnd = cSz.isUnknown ? dataEnd : Math.min(dataEnd, cDataStart + cSz.value);
        if (cId.id === 0x2ad7b1 && cDataEnd > cDataStart) {
          let scale = 0;
          for (let k = cDataStart; k < cDataEnd; k++) {
            scale = (scale * 256) + initBytes[k];
          }
          if (scale > 0) timecodeScaleNs = scale;
        }
        if (cId.id !== 0x4489 && (spd === 1.0 || cId.id !== 0x2ad7b1)) {
          children.push(initBytes.slice(iPos, cDataEnd));
        }
        if (cDataEnd <= iPos) break;
        iPos = cDataEnd;
      }

      effectiveTimecodeScaleNs =
        spd !== 1.0
          ? Math.max(1000, Math.round((timecodeScaleNs || 1000000) / spd))
          : (timecodeScaleNs || 1000000);

      if (spd !== 1.0) {
        children.unshift(encodeEbmlUInt(0x2ad7b1, effectiveTimecodeScaleNs));
      }

      if (durationMs && durationMs > 0 && isFinite(durationMs)) {
        const scaledDuration = (durationMs * 1000000) / (timecodeScaleNs || 1000000);
        const durElem = new Uint8Array(11);
        durElem[0] = 0x44;
        durElem[1] = 0x89;
        durElem[2] = 0x88; // 8-byte float64
        const dv = new DataView(durElem.buffer);
        dv.setFloat64(3, scaledDuration, false);
        children.push(durElem);
      }

      let childrenLen = 0;
      for (const c of children) childrenLen += c.length;
      const infoSzVint = encodeEbmlVint(childrenLen);
      infoElem = new Uint8Array(4 + infoSzVint.length + childrenLen);
      infoElem[0] = 0x15;
      infoElem[1] = 0x49;
      infoElem[2] = 0xa9;
      infoElem[3] = 0x66;
      infoElem.set(infoSzVint, 4);
      let off = 4 + infoSzVint.length;
      for (const c of children) {
        infoElem.set(c, off);
        off += c.length;
      }
    } else if (elId.id === 0x1654ae6b) {
      // Tracks
      tracksElem = initBytes.slice(pos, dataEnd);
      let tPos = dataStart;
      while (tPos < dataEnd) {
        const teId = readEbmlId(initBytes, tPos);
        if (!teId) break;
        const teSz = readEbmlVint(initBytes, tPos + teId.length);
        if (!teSz) break;
        const teStart = tPos + teId.length + teSz.length;
        const teEnd = teSz.isUnknown ? dataEnd : Math.min(dataEnd, teStart + teSz.value);
        if (teId.id === 0xae) {
          let ePos = teStart;
          while (ePos < teEnd) {
            const fId = readEbmlId(initBytes, ePos);
            if (!fId) break;
            const fSz = readEbmlVint(initBytes, ePos + fId.length);
            if (!fSz) break;
            const fStart = ePos + fId.length + fSz.length;
            const fEnd = fSz.isUnknown ? teEnd : Math.min(teEnd, fStart + fSz.value);
            if (fId.id === 0xd7 && fEnd > fStart) {
              let tn = 0;
              for (let k = fStart; k < fEnd; k++) tn = (tn * 256) + initBytes[k];
              if (tn > 0) trackNumber = tn;
              break;
            }
            if (fEnd <= ePos) break;
            ePos = fEnd;
          }
          break;
        }
        if (teEnd <= tPos) break;
        tPos = teEnd;
      }
    } else if (elId.id !== 0x114d9b74 && elId.id !== 0x1c53bb6b && elId.id !== 0xec) {
      otherElems.push(initBytes.slice(pos, dataEnd));
    }

    if (dataEnd <= pos) break;
    pos = dataEnd;
  }

  if (!infoElem || !tracksElem) return null;
  return { ebmlHeader, infoElem, tracksElem, otherElems, timecodeScaleNs, trackNumber };
}

function buildWebmSeekHead(infoOffset, tracksOffset, cuesOffset) {
  const entries = [
    { id: [0x15, 0x49, 0xa9, 0x66], pos: infoOffset },
    { id: [0x16, 0x54, 0xae, 0x6b], pos: tracksOffset },
    { id: [0x1c, 0x53, 0xbb, 0x6b], pos: cuesOffset },
  ];
  const out = new Uint8Array(56);
  out[0] = 0x11;
  out[1] = 0x4d;
  out[2] = 0x9b;
  out[3] = 0x74;
  out[4] = 0x80 | 51; // 0xB3 (51 bytes payload)
  let off = 5;
  for (const e of entries) {
    out[off++] = 0x4d;
    out[off++] = 0xbb;
    out[off++] = 0x8e;
    out[off++] = 0x53;
    out[off++] = 0xab;
    out[off++] = 0x84;
    out[off++] = e.id[0];
    out[off++] = e.id[1];
    out[off++] = e.id[2];
    out[off++] = e.id[3];
    out[off++] = 0x53;
    out[off++] = 0xac;
    out[off++] = 0x84;
    const p = Math.max(0, Math.floor(Number(e.pos) || 0));
    out[off++] = (p >>> 24) & 0xff;
    out[off++] = (p >>> 16) & 0xff;
    out[off++] = (p >>> 8) & 0xff;
    out[off++] = p & 0xff;
  }
  return out;
}

function buildWebmCues(cueEntries, trackNumber = 1) {
  if (!cueEntries || cueEntries.length === 0) return null;
  const points = [];
  let totalPointsLen = 0;
  const trackNumBytes = encodeEbmlUInt(0xf7, trackNumber || 1);

  for (const entry of cueEntries) {
    const cueTimeBytes = encodeEbmlUInt(0xb3, entry.timeMs);
    const clusterPosBytes = encodeEbmlUInt(0xf1, entry.clusterOffset);

    const trackPosPayloadLen = trackNumBytes.length + clusterPosBytes.length;
    const trackPosSzVint = encodeEbmlVint(trackPosPayloadLen);
    const trackPosElem = new Uint8Array(1 + trackPosSzVint.length + trackPosPayloadLen);
    trackPosElem[0] = 0xb7;
    trackPosElem.set(trackPosSzVint, 1);
    trackPosElem.set(trackNumBytes, 1 + trackPosSzVint.length);
    trackPosElem.set(clusterPosBytes, 1 + trackPosSzVint.length + trackNumBytes.length);

    const cuePointPayloadLen = cueTimeBytes.length + trackPosElem.length;
    const cuePointSzVint = encodeEbmlVint(cuePointPayloadLen);
    const cuePointElem = new Uint8Array(1 + cuePointSzVint.length + cuePointPayloadLen);
    cuePointElem[0] = 0xbb;
    cuePointElem.set(cuePointSzVint, 1);
    cuePointElem.set(cueTimeBytes, 1 + cuePointSzVint.length);
    cuePointElem.set(trackPosElem, 1 + cuePointSzVint.length + cueTimeBytes.length);

    points.push(cuePointElem);
    totalPointsLen += cuePointElem.length;
  }

  const cuesSzVint = encodeEbmlVint(totalPointsLen);
  const cuesElem = new Uint8Array(4 + cuesSzVint.length + totalPointsLen);
  cuesElem[0] = 0x1c;
  cuesElem[1] = 0x53;
  cuesElem[2] = 0xbb;
  cuesElem[3] = 0x6b;
  cuesElem.set(cuesSzVint, 4);
  let off = 4 + cuesSzVint.length;
  for (const p of points) {
    cuesElem.set(p, off);
    off += p.length;
  }
  return cuesElem;
}

function isValidClusterHeader(bytes, pos) {
  if (!bytes || pos + 4 >= bytes.length) return false;
  if (bytes[pos] !== 0x1f || bytes[pos + 1] !== 0x43 || bytes[pos + 2] !== 0xb6 || bytes[pos + 3] !== 0x75) {
    return false;
  }
  const sz = readEbmlVint(bytes, pos + 4);
  if (!sz) return false;
  const payloadStart = pos + 4 + sz.length;
  const limit = Math.min(payloadStart + 40, bytes.length);
  for (let i = payloadStart; i < limit; i++) {
    if (bytes[i] === 0xe7) {
      const tcSz = readEbmlVint(bytes, i + 1);
      if (tcSz && tcSz.value >= 0 && tcSz.value <= 8) return true;
    }
  }
  return false;
}

function findClusterStart(bytes, startPos = 0) {
  if (!bytes || bytes.length < 8) return -1;
  const len = bytes.length - 7;
  for (let i = startPos; i < len; i++) {
    if (bytes[i] === 0x1f && bytes[i + 1] === 0x43 && bytes[i + 2] === 0xb6 && bytes[i + 3] === 0x75) {
      if (isValidClusterHeader(bytes, i)) return i;
    }
  }
  return -1;
}

function extractClusterTimecode(bytes, clusterStart = 0) {
  if (!bytes || clusterStart + 4 >= bytes.length) return null;
  const sz = readEbmlVint(bytes, clusterStart + 4);
  if (!sz) return null;
  let pos = clusterStart + 4 + sz.length;
  const end = sz.isUnknown ? bytes.length : Math.min(bytes.length, pos + sz.value);
  while (pos < end) {
    const elId = readEbmlId(bytes, pos);
    if (!elId) break;
    const elSz = readEbmlVint(bytes, pos + elId.length);
    if (!elSz) break;
    const dataStart = pos + elId.length + elSz.length;
    const dataEnd = elSz.isUnknown ? end : Math.min(end, dataStart + elSz.value);
    if (elId.id === 0xe7) {
      let timecode = 0;
      for (let i = dataStart; i < dataEnd; i++) {
        timecode = (timecode * 256) + bytes[i];
      }
      return timecode;
    }
    if (elId.id === 0xa3 || elId.id === 0xa0) break;
    if (dataEnd <= pos) break;
    pos = dataEnd;
  }
  return null;
}

function getClusterDurationMs(bytes, clusterStart = 0) {
  if (!bytes || clusterStart + 4 >= bytes.length) return 0;
  const sz = readEbmlVint(bytes, clusterStart + 4);
  if (!sz) return 0;
  let pos = clusterStart + 4 + sz.length;
  const end = sz.isUnknown ? bytes.length : Math.min(bytes.length, pos + sz.value);
  let maxRelTc = 0;
  let blockCount = 0;

  while (pos < end) {
    const elId = readEbmlId(bytes, pos);
    if (!elId) break;
    const elSz = readEbmlVint(bytes, pos + elId.length);
    if (!elSz) break;
    const dataStart = pos + elId.length + elSz.length;
    const dataEnd = elSz.isUnknown ? end : Math.min(end, dataStart + elSz.value);

    if (elId.id === 0xa3) {
      const trackVint = readEbmlVint(bytes, dataStart);
      if (trackVint && dataStart + trackVint.length + 2 <= dataEnd) {
        const tcOff = dataStart + trackVint.length;
        let relTc = (bytes[tcOff] << 8) | bytes[tcOff + 1];
        if (relTc >= 0x8000) relTc -= 0x10000;
        if (relTc > maxRelTc) maxRelTc = relTc;
        blockCount++;
      }
    } else if (elId.id === 0xa0) {
      let bgPos = dataStart;
      while (bgPos < dataEnd) {
        const bgId = readEbmlId(bytes, bgPos);
        if (!bgId) break;
        const bgSz = readEbmlVint(bytes, bgPos + bgId.length);
        if (!bgSz) break;
        const bgDataStart = bgPos + bgId.length + bgSz.length;
        const bgDataEnd = bgSz.isUnknown ? dataEnd : Math.min(dataEnd, bgDataStart + bgSz.value);
        if (bgId.id === 0xa1) {
          const trackVint = readEbmlVint(bytes, bgDataStart);
          if (trackVint && bgDataStart + trackVint.length + 2 <= bgDataEnd) {
            const tcOff = bgDataStart + trackVint.length;
            let relTc = (bytes[tcOff] << 8) | bytes[tcOff + 1];
            if (relTc >= 0x8000) relTc -= 0x10000;
            if (relTc > maxRelTc) maxRelTc = relTc;
            blockCount++;
          }
        }
        if (bgDataEnd <= bgPos) break;
        bgPos = bgDataEnd;
      }
    }
    if (dataEnd <= pos) break;
    pos = dataEnd;
  }

  return blockCount > 0 ? (maxRelTc + 20) : 0;
}

/**
 * Builds a patched WebM Init Segment for LIVE / PIPE streaming.
 * Uses the standard 8-byte EBML unknown/indeterminate Segment size (0x01FFFFFFFFFFFFFF)
 * so FFmpeg, @discordjs/voice, Lavaplayer, and GStreamer can stream Clusters immediately!
 */
function buildStreamingWebmInit(initBytes, durationMs = 0, speed = 1.0) {
  const parsed = parseAndPatchWebmInit(initBytes, durationMs, speed);
  if (!parsed) return Buffer.from(initBytes);
  const { ebmlHeader, infoElem, tracksElem, otherElems } = parsed;
  const segHeader = new Uint8Array([
    0x18, 0x53, 0x80, 0x67,
    0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff,
  ]);
  return Buffer.concat([
    Buffer.from(ebmlHeader),
    Buffer.from(segHeader),
    Buffer.from(infoElem),
    Buffer.from(tracksElem),
    ...otherElems.map(o => Buffer.from(o)),
  ]);
}

/**
 * Builds a 100% seekable WebM / Opus file Buffer with exact Segment size,
 * 56-byte SeekHead, patched Duration float, and convergent multi-pass Cues index.
 */
function buildSeekableWebmFile(initBytes, clustersMap, clusterDurationsMap, fallbackDurMs = 0, speed = 1.0) {
  const spd = normalizePlaybackSpeed(speed);
  const sortedTimecodes = Array.from(clustersMap.keys()).sort((a, b) => a - b);
  if (sortedTimecodes.length === 0 || !initBytes) return null;

  const lastTc = sortedTimecodes[sortedTimecodes.length - 1];
  const lastCluster = clustersMap.get(lastTc);
  const lastClusterDur = clusterDurationsMap.get(lastTc) || getClusterDurationMs(lastCluster, 0) || 0;
  const clustersEndMs = lastTc + lastClusterDur;
  const durMs = clustersEndMs > 0 ? clustersEndMs : fallbackDurMs;

  const parsed = parseAndPatchWebmInit(initBytes, durMs, spd);
  if (!parsed) return null;
  const { ebmlHeader, infoElem, tracksElem, otherElems, timecodeScaleNs, trackNumber } = parsed;

  let otherLen = 0;
  for (const o of otherElems) otherLen += o.length;

  const infoOffset = 56;
  const tracksOffset = 56 + infoElem.length;
  const cuesOffset = tracksOffset + tracksElem.length + otherLen;
  const seekHeadElem = buildWebmSeekHead(infoOffset, tracksOffset, cuesOffset);

  let cuesElem = null;
  let cuesLen = 0;
  for (let pass = 0; pass < 5; pass++) {
    const cueEntries = [];
    let currentOffset = cuesOffset + cuesLen;
    for (const tc of sortedTimecodes) {
      const cluster = clustersMap.get(tc);
      const scaledTc = Math.round((tc * 1000000) / (timecodeScaleNs || 1000000));
      cueEntries.push({ timeMs: scaledTc, clusterOffset: currentOffset });
      currentOffset += cluster.length;
    }
    const nextCues = buildWebmCues(cueEntries, trackNumber);
    const nextLen = nextCues ? nextCues.length : 0;
    cuesElem = nextCues;
    if (nextLen === cuesLen) break;
    cuesLen = nextLen;
  }

  const totalClustersLen = sortedTimecodes.reduce((acc, tc) => acc + clustersMap.get(tc).length, 0);
  const totalSegPayloadLen = cuesOffset + cuesLen + totalClustersLen;
  const segHeader = new Uint8Array(12);
  segHeader[0] = 0x18;
  segHeader[1] = 0x53;
  segHeader[2] = 0x80;
  segHeader[3] = 0x67;
  segHeader[4] = 0x01;
  let v = BigInt(totalSegPayloadLen);
  for (let b = 11; b >= 5; b--) {
    segHeader[b] = Number(v & 0xffn);
    v >>= 8n;
  }

  const parts = [
    Buffer.from(ebmlHeader),
    Buffer.from(segHeader),
    Buffer.from(seekHeadElem),
    Buffer.from(infoElem),
    Buffer.from(tracksElem),
    ...otherElems.map(o => Buffer.from(o)),
  ];
  if (cuesElem) parts.push(Buffer.from(cuesElem));
  for (const tc of sortedTimecodes) {
    parts.push(Buffer.from(clustersMap.get(tc)));
  }

  return {
    buffer: Buffer.concat(parts),
    durationMs: Math.round(durMs / spd),
    sourceDurationMs: durMs,
    speed: spd,
    clustersCount: sortedTimecodes.length,
  };
}

class WebmClusterAssembler {
  constructor({ onInit, onCluster, retainClusters = true, startOffsetMs = 0 } = {}) {
    this.initSegment = null;
    this.retainClusters = retainClusters !== false;
    this.startOffsetMs = Math.max(0, Number(startOffsetMs) || 0);
    this.clusters = new Map();
    this.clusterSizes = new Map();
    this.clusterDurations = new Map();
    this.activeTimecode = null;
    this.activeHintDurMs = 0;
    this.activeClusterParts = [];
    this.activeClusterExpectedLen = 0;
    this.activeClusterCurrentLen = 0;
    this.totalBytes = 0;
    this.totalClusterDurationMs = 0;
    this.maxTimecode = 0;
    this.maxEndTimeMs = 0;
    this.onInit = onInit || null;
    this.onCluster = onCluster || null;
  }

  get clustersCount() {
    return this.clusterDurations.size;
  }

  feed(chunk, segMeta = null) {
    if (!chunk || chunk.byteLength === 0) return;
    const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);

    if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      if (!isAudioInitSegment(bytes)) return;
      const firstCluster = findClusterStart(bytes, 4);
      if (firstCluster !== -1) {
        this._setInit(bytes.slice(0, firstCluster));
        this._processClusterBytes(bytes.slice(firstCluster), segMeta);
      } else {
        this._setInit(bytes.slice(0));
      }
      return;
    }

    this._processClusterBytes(bytes, segMeta);
  }

  _setInit(initU8) {
    const isFirst = !this.initSegment;
    this.initSegment = initU8;
    if (isFirst && typeof this.onInit === 'function') {
      this.onInit(initU8);
    }
  }

  flush() {
    if (this.activeTimecode !== null && this.activeClusterParts.length > 0) {
      let totalLen = 0;
      for (const p of this.activeClusterParts) totalLen += p.length;
      const merged = new Uint8Array(totalLen);
      let off = 0;
      for (const p of this.activeClusterParts) {
        merged.set(p, off);
        off += p.length;
      }

      if (merged.length >= 8 && merged[0] === 0x1f && merged[1] === 0x43 && merged[2] === 0xb6 && merged[3] === 0x75) {
        const sz = readEbmlVint(merged, 4);
        if (sz) {
          const actualPayloadLen = merged.length - (4 + sz.length);
          if ((sz.isUnknown || sz.value !== actualPayloadLen) && actualPayloadLen > 0) {
            const fixedVint = encodeEbmlVint(actualPayloadLen, sz.length);
            if (fixedVint.length === sz.length) {
              merged.set(fixedVint, 4);
            }
          }
        }
      }

      const tc = this.activeTimecode;
      const ebmlDur = getClusterDurationMs(merged, 0);
      const cDur = Math.max(ebmlDur, this.activeHintDurMs || 0, 100);

      const prevSize = this.clusterSizes.get(tc) || 0;
      const isNewOrLarger = prevSize === 0 || prevSize < merged.length;
      if (isNewOrLarger) {
        this.totalBytes += merged.length - prevSize;
        this.clusterSizes.set(tc, merged.length);
        if (this.retainClusters) {
          this.clusters.set(tc, merged);
        }
        const prevDur = this.clusterDurations.get(tc) || 0;
        const bestDur = Math.max(prevDur, cDur);
        this.clusterDurations.set(tc, bestDur);
        this.totalClusterDurationMs += bestDur - prevDur;
        if (tc > this.maxTimecode) this.maxTimecode = tc;
        if (tc + bestDur > this.maxEndTimeMs) this.maxEndTimeMs = tc + bestDur;
      }

      this.activeClusterParts = [];
      this.activeClusterExpectedLen = 0;
      this.activeClusterCurrentLen = 0;
      this.activeHintDurMs = 0;
      this.activeTimecode = null;

      if (prevSize === 0 && typeof this.onCluster === 'function') {
        this.onCluster(tc, merged, cDur);
      }
    }
  }

  _processClusterBytes(bytes, segMeta = null) {
    if (!bytes || bytes.length === 0) return;
    let pos = 0;

    if (
      this.activeClusterExpectedLen > 0 &&
      bytes.length >= 8 &&
      bytes[0] === 0x1f &&
      bytes[1] === 0x43 &&
      bytes[2] === 0xb6 &&
      bytes[3] === 0x75 &&
      isValidClusterHeader(bytes, 0)
    ) {
      this.flush();
    }

    while (pos < bytes.length) {
      if (this.activeClusterExpectedLen > 0) {
        const needed = this.activeClusterExpectedLen - this.activeClusterCurrentLen;
        const available = bytes.length - pos;
        const take = Math.min(needed, available);
        this.activeClusterParts.push(bytes.subarray(pos, pos + take));
        this.activeClusterCurrentLen += take;
        pos += take;

        if (this.activeClusterCurrentLen >= this.activeClusterExpectedLen) {
          this.flush();
        }
        continue;
      }

      let clusterStart = -1;
      if (
        pos + 4 <= bytes.length &&
        bytes[pos] === 0x1f &&
        bytes[pos + 1] === 0x43 &&
        bytes[pos + 2] === 0xb6 &&
        bytes[pos + 3] === 0x75 &&
        isValidClusterHeader(bytes, pos)
      ) {
        clusterStart = pos;
      }
      if (clusterStart === -1) {
        clusterStart = findClusterStart(bytes, pos);
      }
      if (clusterStart === -1) {
        if (pos < bytes.length && this.activeTimecode !== null) {
          this.activeClusterParts.push(bytes.subarray(pos));
        }
        break;
      }

      const sz = readEbmlVint(bytes, clusterStart + 4);
      if (!sz) break;

      const headerLen = 4 + sz.length;
      const payloadLen = sz.isUnknown ? 0 : sz.value;
      const totalClusterLen = headerLen + payloadLen;

      const tc = extractClusterTimecode(bytes, clusterStart);
      this.flush();
      const resolvedTc = tc !== null && !isNaN(tc)
        ? tc
        : (segMeta?.startMs !== undefined ? Number(segMeta.startMs) : (this.maxEndTimeMs || (this.maxTimecode + 1000)));

      this.activeTimecode = resolvedTc;
      this.activeHintDurMs = Number(segMeta?.durMs || 0);
      this.activeClusterExpectedLen = sz.isUnknown ? 0 : totalClusterLen;
      this.activeClusterCurrentLen = 0;
      this.activeClusterParts = [];

      if (sz.isUnknown) {
        const nextClust = findClusterStart(bytes, clusterStart + headerLen);
        const take = nextClust !== -1 ? (nextClust - clusterStart) : (bytes.length - clusterStart);
        this.activeClusterParts.push(bytes.subarray(clusterStart, clusterStart + take));
        this.activeClusterCurrentLen += take;
        pos = clusterStart + take;
        if (nextClust !== -1) this.flush();
      } else {
        const available = bytes.length - clusterStart;
        const take = Math.min(totalClusterLen, available);
        this.activeClusterParts.push(bytes.subarray(clusterStart, clusterStart + take));
        this.activeClusterCurrentLen += take;
        pos = clusterStart + take;
        if (this.activeClusterCurrentLen >= this.activeClusterExpectedLen) {
          this.flush();
        }
      }
    }
  }

  getNextMissingTimeMs(durMs = 0) {
    this.flush();
    const minTc = this.startOffsetMs || 0;
    const sorted = Array.from(this.clusterDurations.keys())
      .filter(tc => tc + (this.clusterDurations.get(tc) || 5000) > minTc)
      .sort((a, b) => a - b);

    if (sorted.length === 0) return minTc;
    if (sorted[0] > minTc + 1500) return minTc;

    let coveredEnd = minTc;
    for (const tc of sorted) {
      if (tc > coveredEnd + 1500) {
        return coveredEnd + 15;
      }
      const cDur = this.clusterDurations.get(tc) || 5000;
      coveredEnd = Math.max(coveredEnd, tc + cDur);
    }

    if (durMs > 0 && coveredEnd < durMs - 1200) {
      return coveredEnd + 15;
    }
    return null;
  }
}

module.exports = {
  MIN_PLAYBACK_SPEED,
  MAX_PLAYBACK_SPEED,
  normalizePlaybackSpeed,
  buildAtempoFilter,
  readEbmlId,
  readEbmlVint,
  encodeEbmlVint,
  encodeEbmlUInt,
  isAudioInitSegment,
  parseAndPatchWebmInit,
  buildWebmSeekHead,
  buildWebmCues,
  getClusterDurationMs,
  buildStreamingWebmInit,
  buildSeekableWebmFile,
  WebmClusterAssembler,
};
