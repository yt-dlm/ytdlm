'use strict';

const UMP_AUDIO_ITAGS = new Set([774, 251, 250, 249, 141, 140, 139, 171]);

function pbReadVarint(u8, pos) {
  let result = 0n;
  let shift = 0n;
  let i = pos;
  while (i < u8.length) {
    const b = u8[i++];
    result |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) return { value: result, next: i };
    shift += 7n;
    if (shift > 70n) return null;
  }
  return null;
}

function pbEncodeVarint(val) {
  let v = typeof val === 'bigint' ? val : BigInt(Math.max(0, Math.floor(Number(val) || 0)));
  const out = [];
  while (v >= 0x80n) {
    out.push(Number((v & 0x7fn) | 0x80n));
    v >>= 7n;
  }
  out.push(Number(v));
  return new Uint8Array(out);
}

function pbConcatChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out;
}

function pbWrapLengthDelimited(fieldNum, payloadBytes) {
  const tag = pbEncodeVarint((BigInt(fieldNum) << 3n) | 2n);
  const len = pbEncodeVarint(BigInt(payloadBytes.length));
  return pbConcatChunks([tag, len, payloadBytes]);
}

function pbDecodeBase64ToU8(b64) {
  if (!b64 || typeof b64 !== 'string') return null;
  try {
    const normalized = b64.replace(/-/g, '+').replace(/_/g, '/');
    return new Uint8Array(Buffer.from(normalized, 'base64'));
  } catch (e) {
    return null;
  }
}

function pbParseMessage(u8, start = 0, end = u8.length) {
  const fields = new Map();
  let pos = start;
  while (pos < end) {
    const tag = pbReadVarint(u8, pos);
    if (!tag) return null;
    pos = tag.next;
    const fieldNum = Number(tag.value >> 3n);
    const wireType = Number(tag.value & 7n);
    if (fieldNum <= 0) return null;

    let entry;
    if (wireType === 0) {
      const v = pbReadVarint(u8, pos);
      if (!v) return null;
      entry = { wireType, value: v.value, next: v.next };
      pos = v.next;
    } else if (wireType === 1) {
      if (pos + 8 > end) return null;
      entry = { wireType, valueOff: pos, valueLen: 8, next: pos + 8 };
      pos += 8;
    } else if (wireType === 2) {
      const len = pbReadVarint(u8, pos);
      if (!len) return null;
      const l = Number(len.value);
      if (l < 0 || len.next + l > end) return null;
      entry = { wireType, valueOff: len.next, valueLen: l, next: len.next + l };
      pos = len.next + l;
    } else if (wireType === 5) {
      if (pos + 4 > end) return null;
      entry = { wireType, valueOff: pos, valueLen: 4, next: pos + 4 };
      pos += 4;
    } else {
      return null;
    }

    if (!fields.has(fieldNum)) fields.set(fieldNum, []);
    fields.get(fieldNum).push(entry);
  }
  return fields;
}

function umpReadVarint(u8, pos) {
  if (pos >= u8.length) return null;
  const b0 = u8[pos];
  if ((b0 & 0x80) === 0) return [b0, pos + 1];
  if ((b0 & 0xc0) === 0x80) {
    if (pos + 1 >= u8.length) return null;
    return [(b0 & 0x3f) | (u8[pos + 1] << 6), pos + 2];
  }
  if ((b0 & 0xe0) === 0xc0) {
    if (pos + 2 >= u8.length) return null;
    return [(b0 & 0x1f) | (u8[pos + 1] << 5) | (u8[pos + 2] << 13), pos + 3];
  }
  if ((b0 & 0xf0) === 0xe0) {
    if (pos + 3 >= u8.length) return null;
    return [((b0 & 0x0f) | (u8[pos + 1] << 4) | (u8[pos + 2] << 12) | (u8[pos + 3] << 20)) >>> 0, pos + 4];
  }
  if (pos + 4 >= u8.length) return null;
  return [(u8[pos + 1] | (u8[pos + 2] << 8) | (u8[pos + 3] << 16) | (u8[pos + 4] << 24)) >>> 0, pos + 5];
}

function buildFormatIdMsg(itag, lastModified, xtags) {
  const wrapVarint = (fn, val) => new Uint8Array([...pbEncodeVarint((fn << 3) | 0), ...pbEncodeVarint(val)]);
  const wrapStr = (fn, str) => pbWrapLengthDelimited(fn, new TextEncoder().encode(str));
  const lmt = BigInt(lastModified || 0);
  const parts = [wrapVarint(1, Number(itag) || 251), wrapVarint(2, lmt)];
  if (typeof xtags === 'string' && xtags.length > 0) {
    parts.push(wrapStr(3, xtags));
  }
  return pbConcatChunks(parts);
}

function buildClientInfoMsg(clientVersion = '7.20260728.17.00', hl = 'vi', gl = 'VN', clientNameId = 7) {
  const wrapVarint = (fn, val) => new Uint8Array([...pbEncodeVarint((fn << 3) | 0), ...pbEncodeVarint(val)]);
  const wrapStr = (fn, str) => pbWrapLengthDelimited(fn, new TextEncoder().encode(str));
  return pbConcatChunks([
    wrapStr(1, hl),
    wrapStr(2, gl),
    wrapVarint(16, clientNameId),
    wrapStr(17, clientVersion),
  ]);
}

function buildAbrRequestBytes(session, playerTimeMs) {
  const wrapVarint = (fn, val) => new Uint8Array([...pbEncodeVarint((fn << 3) | 0), ...pbEncodeVarint(val)]);
  const wrapBytes = (fn, u8) => pbWrapLengthDelimited(fn, u8);

  const clientState = pbConcatChunks([
    wrapVarint(28, Math.max(0, Math.floor(playerTimeMs))),
    wrapVarint(40, 1), // 1 = AUDIO_ONLY
  ]);

  const parts = [wrapBytes(1, clientState)];
  if (session.hasInit) {
    parts.push(wrapBytes(2, session.fmtMsg));
  }
  parts.push(
    wrapBytes(5, session.ustreamerBytes),
    wrapBytes(16, session.fmtMsg)
  );

  const scParts = [wrapBytes(1, session.clientInfoMsg)];
  if (session.playbackCookie && session.playbackCookie.length > 0) {
    scParts.push(wrapBytes(3, session.playbackCookie));
  }
  parts.push(wrapBytes(19, pbConcatChunks(scParts)));
  return pbConcatChunks(parts);
}

function demuxUmp(u8, targetItag = 251) {
  const headersById = new Map();
  let nextPlaybackCookie = null;
  let redirectUrl = null;
  let sabrError = null;
  let off = 0;

  while (off < u8.length) {
    const pt = umpReadVarint(u8, off);
    if (!pt) break;
    const ps = umpReadVarint(u8, pt[1]);
    if (!ps) break;
    const pType = pt[0], pSize = ps[0], dOff = ps[1];
    if (pSize < 0 || dOff + pSize > u8.length) break;

    if (pType === 20) {
      // MediaHeader
      const mh = pbParseMessage(u8, dOff, dOff + pSize);
      if (mh) {
        const hid = Number(mh.get(1)?.[0]?.value ?? 0);
        let itag = Number(mh.get(3)?.[0]?.value ?? 0);
        if (!itag) {
          const f13 = mh.get(13)?.[0];
          if (f13 && f13.wireType === 2) {
            const fmt = pbParseMessage(u8, f13.valueOff, f13.valueOff + f13.valueLen);
            itag = Number(fmt?.get(1)?.[0]?.value ?? 0);
          }
        }
        const isInit = Number(mh.get(8)?.[0]?.value ?? 0) === 1;
        const seq = Number(mh.get(9)?.[0]?.value ?? 0);
        let startMs = Number(mh.get(11)?.[0]?.value ?? 0);
        let durMs = Number(mh.get(12)?.[0]?.value ?? 0);
        const f14 = mh.get(14)?.[0];
        if ((!startMs || !durMs) && f14 && f14.wireType === 2) {
          const tr = pbParseMessage(u8, f14.valueOff, f14.valueOff + f14.valueLen);
          const trStart = Number(tr?.get(1)?.[0]?.value ?? 0);
          const trDur = Number(tr?.get(2)?.[0]?.value ?? 0);
          const trScale = Number(tr?.get(3)?.[0]?.value ?? 1000);
          if (trScale > 0) {
            if (!startMs && trStart > 0) startMs = Math.round((trStart * 1000) / trScale);
            if (!durMs && trDur > 0) durMs = Math.round((trDur * 1000) / trScale);
          }
        }
        headersById.set(hid, { hid, itag, isInit, seq, startMs, durMs, chunks: [] });
      }
    } else if (pType === 21) {
      // Media payload
      const hidV = umpReadVarint(u8, dOff);
      if (hidV) {
        const hdr = headersById.get(hidV[0]);
        const matchesItag = hdr && (targetItag === 774
          ? hdr.itag === 774
          : (hdr.itag === targetItag || UMP_AUDIO_ITAGS.has(hdr.itag)));
        if (matchesItag && hidV[1] < dOff + pSize) {
          hdr.chunks.push(u8.subarray(hidV[1], dOff + pSize));
        }
      }
    } else if (pType === 35) {
      // NextRequestPolicy
      const nrp = pbParseMessage(u8, dOff, dOff + pSize);
      const f7 = nrp?.get(7)?.[0];
      if (f7 && f7.wireType === 2) {
        nextPlaybackCookie = u8.slice(f7.valueOff, f7.valueOff + f7.valueLen);
      }
    } else if (pType === 43 || pType === 42 || pType === 33) {
      // SabrRedirect (Part 43 / 33) or SabrError (Part 42 / 43 without URL)
      const sr = pbParseMessage(u8, dOff, dOff + pSize);
      const f1 = sr?.get(1)?.[0];
      let foundRedirect = false;
      if (f1 && f1.wireType === 2 && f1.valueLen > 24 && f1.valueLen < 4096) {
        const candidate = new TextDecoder().decode(u8.subarray(f1.valueOff, f1.valueOff + f1.valueLen));
        if (/^https:\/\/[^/\s]+\/videoplayback\?/.test(candidate)) {
          redirectUrl = candidate;
          foundRedirect = true;
        }
      }
      if (!foundRedirect && (pType === 42 || pType === 43)) {
        sabrError = true;
      }
    }
    off = dOff + pSize;
  }

  const segments = [];
  for (const h of headersById.values()) {
    const matchesItag = targetItag === 774
      ? h.itag === 774
      : (h.itag === targetItag || UMP_AUDIO_ITAGS.has(h.itag));
    if (matchesItag && h.chunks.length > 0) {
      const data = pbConcatChunks(h.chunks);
      const isEbmlInit = data.length >= 4 && data[0] === 0x1a && data[1] === 0x45 && data[2] === 0xdf && data[3] === 0xa3;
      segments.push({
        itag: h.itag || targetItag,
        isInit: h.isInit || isEbmlInit,
        seq: h.seq,
        startMs: h.startMs,
        durMs: h.durMs,
        data,
      });
    }
  }
  return { segments, nextPlaybackCookie, redirectUrl, sabrError };
}

module.exports = {
  UMP_AUDIO_ITAGS,
  pbReadVarint,
  pbEncodeVarint,
  pbConcatChunks,
  pbWrapLengthDelimited,
  pbDecodeBase64ToU8,
  pbParseMessage,
  umpReadVarint,
  buildFormatIdMsg,
  buildClientInfoMsg,
  buildAbrRequestBytes,
  demuxUmp,
};
