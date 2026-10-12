'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { getPlayerContext } = require('./decipher');

const VIDEO_ID_RE = /^[a-zA-Z0-9_-]{11}$/;
const TV_CLIENT_VERSION = '7.20260728.17.00';
const TV_USER_AGENT =
  'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/5.0 TV Safari/538.1';

const TV_OAUTH = {
  clientId:
    process.env.YTDLM_OAUTH_CLIENT_ID ||
    Buffer.from(
      'ODYxNTU2NzA4NDU0LWQ2ZGxtM2xoMDVpZGQ4bnBlazE4azZiZThiYTNvYzY4LmFwcHMuZ29vZ2xldXNlcmNvbnRlbnQuY29t',
      'base64'
    ).toString('utf8'),
  clientSecret:
    process.env.YTDLM_OAUTH_CLIENT_SECRET ||
    Buffer.from('U2JvVmhvRzlzMHJOYWZpeENTR0dLWEFU', 'base64').toString('utf8'),
  scope: 'http://gdata.youtube.com https://www.googleapis.com/auth/youtube-paid-content',
};

const CONFIG_DIR = process.env.YTDLM_CONFIG_DIR || path.join(os.homedir(), '.ytdlm');
const AUTH_FILE = path.join(CONFIG_DIR, 'auth.json');

function extractVideoId(input) {
  if (!input || typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (VIDEO_ID_RE.test(trimmed)) return trimmed;

  try {
    const u = new URL(trimmed);
    const v = u.searchParams.get('v');
    if (v && VIDEO_ID_RE.test(v)) return v;

    if (u.hostname === 'youtu.be') {
      const id = u.pathname.split('/').filter(Boolean)[0];
      if (id && VIDEO_ID_RE.test(id)) return id;
    }

    const parts = u.pathname.split('/').filter(Boolean);
    if (['shorts', 'live', 'embed', 'v'].includes(parts[0]) && parts[1] && VIDEO_ID_RE.test(parts[1])) {
      return parts[1];
    }
  } catch (e) {}

  return null;
}

function sanitizeFilename(title, author = '', itag = 251) {
  let cleanTitle = (title || 'Audio Track').trim().replace(/\s*-\s*YouTube(\s*Music)?$/i, '');
  let cleanAuthor = (author || '').trim().replace(/\s*-\s*Topic$/i, '');

  const stripBadChars = s =>
    (s || '')
      .replace(/[\u0000-\u001F\u007F-\u009F]/g, '')
      .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF\u061C]/g, '')
      .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g, ' ');

  cleanTitle = stripBadChars(cleanTitle);
  cleanAuthor = stripBadChars(cleanAuthor);

  let name = cleanTitle;
  if (cleanAuthor && !cleanTitle.toLowerCase().includes(cleanAuthor.toLowerCase())) {
    name = `${cleanAuthor} - ${cleanTitle}`;
  }

  name = name
    .replace(/[<>:"/\\|?*]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[\s._-]+|[\s._-]+$/g, '');

  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(name)) {
    name = `_${name}`;
  }

  if (Array.from(name).length > 150) {
    name = Array.from(name).slice(0, 150).join('').replace(/^[\s._-]+|[\s._-]+$/g, '');
  }
  if (!name) name = 'Audio Track';

  const ext = Number(itag) === 141 || Number(itag) === 140 ? 'm4a' : 'opus';
  name = name.replace(new RegExp(`\\.${ext}$`, 'i'), '').replace(/[\s._-]+$/, '');
  return `${name}.${ext}`;
}

const GUEST_POOL_MAX = 16;
const GUEST_TOKEN_TTL_MS = 25 * 60 * 1000;
const guestVisitorPool = [];
let guestPoolRoundRobin = 0;

async function fetchFreshGuestVisitorData() {
  try {
    const resp = await fetch('https://www.youtube.com/sw.js_data', {
      method: 'GET',
      headers: {
        'User-Agent': TV_USER_AGENT,
        'Cache-Control': 'no-cache',
      },
    });
    if (resp.ok) {
      const text = await resp.text();
      const m = text.match(/(Cg[st][a-zA-Z0-9_-]+)/);
      if (m && m[1]) {
        const token = m[1];
        guestVisitorPool.push({ token, ts: Date.now() });
        while (guestVisitorPool.length > GUEST_POOL_MAX) {
          guestVisitorPool.shift();
        }
        return token;
      }
    }
  } catch (e) {}
  return null;
}

async function getGuestVisitorData(forceRefresh = false) {
  const now = Date.now();
  for (let i = guestVisitorPool.length - 1; i >= 0; i--) {
    if (now - guestVisitorPool[i].ts > GUEST_TOKEN_TTL_MS) {
      guestVisitorPool.splice(i, 1);
    }
  }

  if (forceRefresh || guestVisitorPool.length === 0) {
    const fresh = await fetchFreshGuestVisitorData();
    if (fresh) return fresh;
  }

  // Background replenish pool up to 4 concurrent guest identities for multi-stream load distribution
  if (guestVisitorPool.length < 4) {
    fetchFreshGuestVisitorData().catch(() => {});
  }

  if (guestVisitorPool.length > 0) {
    const idx = (guestPoolRoundRobin++) % guestVisitorPool.length;
    return guestVisitorPool[idx].token;
  }
  return null;
}

// ─── TV OAUTH DEVICE CODE MANAGER (OPTIONAL FOR ITAG 774 HQ) ────────
function loadStoredAuth() {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    }
  } catch (e) {}
  return null;
}

function saveStoredAuth(tokenObj) {
  try {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
    fs.writeFileSync(AUTH_FILE, JSON.stringify(tokenObj, null, 2), 'utf8');
  } catch (e) {}
}

function clearStoredAuth() {
  try {
    if (fs.existsSync(AUTH_FILE)) fs.unlinkSync(AUTH_FILE);
  } catch (e) {}
}

async function requestTvDeviceCode() {
  const res = await fetch('https://www.youtube.com/o/oauth2/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: TV_OAUTH.clientId,
      scope: TV_OAUTH.scope,
      device_id: crypto.randomUUID(),
      device_model: 'YtTv',
    }),
  });
  if (!res.ok) throw new Error(`OAuth device code failed: HTTP ${res.status}`);
  return await res.json();
}

async function pollTvDeviceToken(deviceCode, intervalSec = 5, maxWaitSec = 300) {
  const deadline = Date.now() + maxWaitSec * 1000;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, intervalSec * 1000));
    const res = await fetch('https://www.youtube.com/o/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: TV_OAUTH.clientId,
        client_secret: TV_OAUTH.clientSecret,
        code: deviceCode,
        grant_type: 'http://oauth.net/grant_type/device/1.0',
      }),
    });
    const data = await res.json();
    if (data.access_token) {
      const tokenObj = {
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
      };
      saveStoredAuth(tokenObj);
      return tokenObj;
    }
    if (data.error && data.error !== 'authorization_pending' && data.error !== 'slow_down') {
      throw new Error(`OAuth error: ${data.error}`);
    }
  }
  throw new Error('OAuth polling timed out');
}

async function getValidTvAccessToken(explicitToken = null) {
  if (explicitToken) return explicitToken;
  if (process.env.YTDLM_TV_TOKEN) return process.env.YTDLM_TV_TOKEN;

  const stored = loadStoredAuth();
  if (!stored) return null;
  if (stored.access_token && stored.expires_at && Date.now() < stored.expires_at - 60000) {
    return stored.access_token;
  }
  if (!stored.refresh_token) return stored.access_token || null;

  try {
    const res = await fetch('https://www.youtube.com/o/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: TV_OAUTH.clientId,
        client_secret: TV_OAUTH.clientSecret,
        refresh_token: stored.refresh_token,
        grant_type: 'refresh_token',
      }),
    });
    if (res.ok) {
      const data = await res.json();
      if (data.access_token) {
        const updated = {
          access_token: data.access_token,
          refresh_token: data.refresh_token || stored.refresh_token,
          expires_at: Date.now() + (Number(data.expires_in) || 3600) * 1000,
        };
        saveStoredAuth(updated);
        return updated.access_token;
      }
    }
  } catch (e) {}
  return null;
}

// ─── YOUTUBE SEARCH (GUEST MODE) ────────────────────────────────────
async function searchVideos(query, limit = 5) {
  const cleanQuery = String(query || '').replace(/^ytsearch\d*:/i, '').trim();
  if (!cleanQuery) return [];

  const guestVd = await getGuestVisitorData(false);
  const res = await fetch('https://www.youtube.com/youtubei/v1/search?prettyPrint=false', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-YouTube-Client-Name': '1',
      'X-YouTube-Client-Version': '2.20260728.01.00',
      ...(guestVd ? { 'X-Goog-Visitor-Id': guestVd } : {}),
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    },
    body: JSON.stringify({
      context: {
        client: {
          clientName: 'WEB',
          clientVersion: '2.20260728.01.00',
          hl: 'en',
          gl: 'US',
          ...(guestVd ? { visitorData: guestVd } : {}),
        },
      },
      query: cleanQuery,
    }),
  });

  if (!res.ok) return [];
  const data = await res.json();
  const results = [];

  function walk(obj) {
    if (!obj || typeof obj !== 'object' || results.length >= limit) return;
    if (obj.videoRenderer && obj.videoRenderer.videoId) {
      const vr = obj.videoRenderer;
      const title =
        vr.title?.runs?.map(r => r.text).join('') ||
        vr.title?.simpleText ||
        'Unknown Title';
      const author =
        vr.ownerText?.runs?.[0]?.text ||
        vr.longBylineText?.runs?.[0]?.text ||
        '';
      const lengthText = vr.lengthText?.simpleText || '';
      results.push({
        videoId: vr.videoId,
        url: `https://www.youtube.com/watch?v=${vr.videoId}`,
        title,
        author,
        durationText: lengthText,
        thumbnail: vr.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || null,
      });
      return;
    }
    for (const v of Object.values(obj)) {
      if (Array.isArray(v)) {
        for (const item of v) walk(item);
      } else if (v && typeof v === 'object') {
        walk(v);
      }
    }
  }

  walk(data.contents);
  return results.slice(0, limit);
}

// ─── TVHTML5 PLAYER CALL (GUEST OR AUTHENTICATED 774) ───────────────
async function fetchTvPlayer(videoId, { guest = true, accessToken = null, sts = 20732, hl = 'vi', gl = 'VN' } = {}) {
  const isGuest = Boolean(guest || !accessToken);
  const guestVd = isGuest ? await getGuestVisitorData(false) : null;

  const headers = {
    'Content-Type': 'application/json',
    'X-YouTube-Client-Name': '7',
    'X-YouTube-Client-Version': TV_CLIENT_VERSION,
    'Origin': 'https://www.youtube.com',
    'User-Agent': TV_USER_AGENT,
  };

  if (isGuest && guestVd) {
    headers['X-Goog-Visitor-Id'] = guestVd;
  } else if (!isGuest && accessToken) {
    headers['Authorization'] = `Bearer ${accessToken}`;
  }

  const clientObj = {
    clientName: 'TVHTML5',
    clientVersion: TV_CLIENT_VERSION,
    hl,
    gl,
    deviceMake: 'Samsung',
    deviceModel: 'SmartTV',
    deviceCategory: 'TV',
    clientFormFactor: 'LARGE_FORM_FACTOR',
    ...(isGuest && guestVd ? { visitorData: guestVd } : {}),
  };

  const context = {
    client: clientObj,
    user: {
      lockedSafetyMode: false,
      audioQuality: 'AUDIO_QUALITY_HIGH',
    },
    request: {
      useSsl: true,
      internalExperimentFlags: [
        { key: 'tv_high_quality_audio', value: 'true' },
        { key: 'html5_audio_quality', value: 'high' },
      ],
    },
  };

  const payload = {
    context,
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: {
      contentPlaybackContext: {
        signatureTimestamp: sts || 20732,
        audioQualityPreference: 'AUDIO_QUALITY_HIGH',
        html5Preference: 'HTML5_PREF_WANTS',
      },
    },
  };

  const res = await fetch('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    throw new Error(`InnerTube TVHTML5 HTTP ${res.status}`);
  }
  return await res.json();
}

async function fetchOembedMeta(videoId) {
  try {
    const res = await fetch(
      `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}`)}&format=json`
    );
    if (res.ok) {
      return await res.json();
    }
  } catch (e) {}
  return null;
}

/**
 * Resolves the SABR UMP streaming context and format metadata for a video.
 * - For itag 251 (or guest=true): Strictly uses Anonymous Guest TVHTML5 (never touches TV OAuth token).
 * - For itag 774 (or auto with TV OAuth token): Tries authenticated TVHTML5 for 774; if video has no 774,
 *   automatically falls back to Anonymous Guest TVHTML5 for 251 so 251 is NEVER downloaded with the main token.
 */
async function resolveSabrContext(videoIdOrQuery, options = {}) {
  let videoId = extractVideoId(videoIdOrQuery);
  if (!videoId) {
    const searchRes = await searchVideos(videoIdOrQuery, 1);
    if (!searchRes.length) {
      throw new Error(`Could not resolve video ID or search results for: "${videoIdOrQuery}"`);
    }
    videoId = searchRes[0].videoId;
  }

  const oembedPromise = fetchOembedMeta(videoId);
  const playerCtx = await getPlayerContext(false);
  const sts = playerCtx?.sts || 20732;

  const requestedItag = options.itag ? Number(options.itag) : null;
  const forceGuest = Boolean(options.guest) || requestedItag === 251 || requestedItag === 250 || requestedItag === 249;
  const tvToken = !forceGuest ? await getValidTvAccessToken(options.accessToken) : null;

  // 1. If TV OAuth token is present and user wants 774 or 'auto', check authenticated TVHTML5 for ITAG 774 ONLY
  if (tvToken && !forceGuest) {
    try {
      const authData = await fetchTvPlayer(videoId, { guest: false, accessToken: tvToken, sts });
      if (authData?.playabilityStatus?.status === 'OK' && authData.streamingData) {
        const allFormats = authData.streamingData.adaptiveFormats || [];
        const audioFmts = allFormats.filter(f => (f.mimeType || '').includes('audio/'));
        const fmt774 = audioFmts.find(f => f.itag === 774);
        const sabrUrl = authData.streamingData.serverAbrStreamingUrl;
        const ustreamerConfig =
          authData.streamingData.ustreamerConfig ||
          authData.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig;

        if (fmt774 && sabrUrl && ustreamerConfig) {
          const vd = authData.videoDetails || {};
          const oembed = (!vd.title || !vd.author) ? await oembedPromise : null;
          return {
            videoId,
            title: vd.title || oembed?.title || 'YouTube Audio',
            author: vd.author || oembed?.author_name || '',
            durationSec: Number(vd.lengthSeconds || 0) || Math.round(Number(fmt774.approxDurationMs || 0) / 1000),
            durationMs: Number(fmt774.approxDurationMs || 0) || Number(vd.lengthSeconds || 0) * 1000,
            thumbnail: vd.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || oembed?.thumbnail_url || null,
            itag: 774,
            mimeType: fmt774.mimeType || 'audio/webm; codecs="opus"',
            bitrate: fmt774.averageBitrate || fmt774.bitrate || 256000,
            contentLength: Number(fmt774.contentLength || 0),
            sampleRate: Number(fmt774.audioSampleRate || 48000),
            channels: Number(fmt774.audioChannels || 2),
            isGuest: false,
            mode: 'TV_PREMIUM_SABR_774',
            format: fmt774,
            sabrUrl,
            ustreamerConfig,
            clientVersion: TV_CLIENT_VERSION,
          };
        }
      }
    } catch (e) {
      if (requestedItag === 774 && options.strictHq) {
        throw e;
      }
    }

    if (requestedItag === 774 && options.strictHq) {
      throw new Error(`NO_774_STREAM: Video ${videoId} does not have an ITAG 774 stream.`);
    }
  } else if (requestedItag === 774 && options.strictHq) {
    throw new Error('NO_TV_TOKEN: ITAG 774 requires a YouTube TV Premium OAuth token (run `ytdlm auth login`).');
  }

  // 2. Resolve ITAG 251 via Anonymous Guest TVHTML5 (Zero cookies, zero account tokens!)
  let guestData = await fetchTvPlayer(videoId, { guest: true, sts });
  if (guestData?.playabilityStatus?.status !== 'OK' || !guestData.streamingData) {
    await getGuestVisitorData(true);
    guestData = await fetchTvPlayer(videoId, { guest: true, sts });
  }

  if (guestData?.playabilityStatus?.status !== 'OK' || !guestData.streamingData) {
    const reason = guestData?.playabilityStatus?.reason || guestData?.playabilityStatus?.status || 'UNPLAYABLE';
    throw new Error(`Guest TVHTML5 failed for ${videoId}: ${reason}`);
  }

  const allFormats = guestData.streamingData.adaptiveFormats || [];
  const audioFmts = allFormats.filter(f => (f.mimeType || '').includes('audio/'));
  const bestOpus =
    audioFmts.find(f => f.itag === 251 && !String(f.xtags || '').includes('drc') && f.audioTrack?.audioIsDefault !== false) ||
    audioFmts.find(f => f.itag === 251 && !String(f.xtags || '').includes('drc')) ||
    audioFmts.find(f => f.itag === 251) ||
    audioFmts.find(f => f.itag === 250 && !String(f.xtags || '').includes('drc')) ||
    audioFmts.find(f => f.itag === 250) ||
    audioFmts.find(f => f.itag === 249);

  if (!bestOpus) {
    throw new Error(`No Opus audio format (251/250/249) found on Guest TVHTML5 for ${videoId}`);
  }

  const sabrUrl = guestData.streamingData.serverAbrStreamingUrl;
  const ustreamerConfig =
    guestData.streamingData.ustreamerConfig ||
    guestData.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig;

  if (!sabrUrl || !ustreamerConfig) {
    throw new Error(`Missing SABR streaming context on Guest TVHTML5 for ${videoId}`);
  }

  const vd = guestData.videoDetails || {};
  const oembed = (!vd.title || !vd.author) ? await oembedPromise : null;
  return {
    videoId,
    title: vd.title || oembed?.title || 'YouTube Audio',
    author: vd.author || oembed?.author_name || '',
    durationSec: Number(vd.lengthSeconds || 0) || Math.round(Number(bestOpus.approxDurationMs || 0) / 1000),
    durationMs: Number(bestOpus.approxDurationMs || 0) || Number(vd.lengthSeconds || 0) * 1000,
    thumbnail: vd.thumbnail?.thumbnails?.slice(-1)?.[0]?.url || oembed?.thumbnail_url || null,
    itag: bestOpus.itag,
    mimeType: bestOpus.mimeType || 'audio/webm; codecs="opus"',
    bitrate: bestOpus.averageBitrate || bestOpus.bitrate || 135000,
    contentLength: Number(bestOpus.contentLength || 0),
    sampleRate: Number(bestOpus.audioSampleRate || 48000),
    channels: Number(bestOpus.audioChannels || 2),
    isGuest: true,
    mode: 'TV_GUEST_SABR_251',
    format: bestOpus,
    sabrUrl,
    ustreamerConfig,
    clientVersion: TV_CLIENT_VERSION,
  };
}

module.exports = {
  extractVideoId,
  sanitizeFilename,
  getGuestVisitorData,
  loadStoredAuth,
  clearStoredAuth,
  requestTvDeviceCode,
  pollTvDeviceToken,
  getValidTvAccessToken,
  searchVideos,
  resolveSabrContext,
};
