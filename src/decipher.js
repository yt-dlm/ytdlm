'use strict';

const vm = require('vm');

const WEB_USER_AGENT = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  'AppleWebKit/537.36',
].join(' ');

const MAX_N_CACHE = 512;
const nTokenCache = new Map();

let cachedPlayerState = null;
let loadingPromise = null;

function getCachedNToken(cacheKey) {
  if (!nTokenCache.has(cacheKey)) return null;
  const val = nTokenCache.get(cacheKey);
  nTokenCache.delete(cacheKey);
  nTokenCache.set(cacheKey, val);
  return val;
}

function setCachedNToken(cacheKey, val) {
  if (nTokenCache.has(cacheKey)) {
    nTokenCache.delete(cacheKey);
  } else if (nTokenCache.size >= MAX_N_CACHE) {
    const oldest = nTokenCache.keys().next().value;
    if (oldest !== undefined) nTokenCache.delete(oldest);
  }
  nTokenCache.set(cacheKey, val);
}

function clearDecipherCache() {
  nTokenCache.clear();
  cachedPlayerState = null;
}

function createDummyDomElement() {
  const fn = function () {};
  return new Proxy(fn, {
    get(target, prop) {
      if (prop === 'style') return {};
      if (prop === 'classList') return { add() {}, remove() {}, contains() { return false; } };
      if (prop === 'childNodes' || prop === 'children') return [];
      if (prop === 'dataset') return {};
      if (typeof target[prop] !== 'undefined') return target[prop];
      return () => createDummyDomElement();
    },
    set(target, prop, val) {
      target[prop] = val;
      return true;
    },
    apply() {
      return createDummyDomElement();
    },
    construct() {
      return createDummyDomElement();
    },
  });
}

async function getPlayerContext(forceRefresh = false) {
  if (!forceRefresh && cachedPlayerState && Date.now() - cachedPlayerState.ts < 6 * 3600 * 1000) {
    return cachedPlayerState;
  }
  if (!forceRefresh && loadingPromise) {
    return loadingPromise;
  }

  loadingPromise = (async () => {
    let playerHash = '5203c085';
    try {
      const iframeRes = await fetch('https://www.youtube.com/iframe_api', {
        headers: { 'User-Agent': WEB_USER_AGENT },
        signal: AbortSignal.timeout(8000),
      });
      if (iframeRes.ok) {
        const text = await iframeRes.text();
        const m = text.match(/player\\\/([a-zA-Z0-9_-]{8})\\\//) || text.match(/player\/([a-zA-Z0-9_-]{8})\//);
        if (m && m[1]) playerHash = m[1];
      }
    } catch (e) {}

    const baseJsUrl = [
      'https://www.youtube.com/s/player/',
      playerHash,
      '/player_ias.vflset/en_US/base.js',
    ].join('');
    const res = await fetch(baseJsUrl, {
      headers: { 'User-Agent': WEB_USER_AGENT },
      signal: AbortSignal.timeout(12000),
    });
    if (!res.ok) {
      throw new Error(`Player script HTTP ${res.status}`);
    }
    const baseJs = await res.text();

    const stsMatch = baseJs.match(/signatureTimestamp\s*:\s*(\d+)/);
    const sts = stsMatch ? Number(stsMatch[1]) : 20732;

    const watchUrl = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
    const sandbox = {
      window: null,
      self: null,
      globalThis: null,
      _yt_player: {},
      yt: {},
      ytcfg: { get: () => undefined, set: () => {} },
      location: new URL(watchUrl),
      navigator: {
        userAgent: WEB_USER_AGENT,
        mediaCapabilities: {},
      },
      document: {
        createElement: () => createDummyDomElement(),
        createElementNS: () => createDummyDomElement(),
        getElementsByTagName: () => [],
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
        removeEventListener: () => {},
        documentElement: createDummyDomElement(),
        body: createDummyDomElement(),
        head: createDummyDomElement(),
        cookie: '',
        location: new URL(watchUrl),
      },
      Element: function () {},
      HTMLElement: function () {},
      HTMLMediaElement: function () {},
      HTMLVideoElement: function () {},
      Event: function () {},
      CustomEvent: function () {},
      Node: function () {},
      XMLHttpRequest: function () {},
      fetch: () => Promise.resolve(),
      setTimeout: () => 0,
      clearTimeout: () => {},
      setInterval: () => 0,
      clearInterval: () => {},
      requestAnimationFrame: () => 0,
      cancelAnimationFrame: () => {},
      performance: { now: () => Date.now(), mark: () => {}, measure: () => {} },
      screen: { width: 1920, height: 1080 },
      matchMedia: () => ({ matches: false, addListener: () => {}, addEventListener: () => {} }),
      CSS: { supports: () => true },
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
      Uint8Array,
      ArrayBuffer,
      DataView,
      Int32Array,
      Float64Array,
      Map,
      Set,
      WeakMap,
      WeakSet,
      Promise,
      Symbol,
      Proxy,
      Reflect,
      JSON,
      Math,
      Date,
      RegExp,
      Error,
      TypeError,
      RangeError,
      SyntaxError,
      URIError,
      Object,
      Array,
      String,
      Number,
      Boolean,
      // Note: Host Function is intentionally omitted to prevent sandbox escape
      BigInt,
      parseInt,
      parseFloat,
      isNaN,
      isFinite,
      encodeURIComponent,
      decodeURIComponent,
      encodeURI,
      decodeURI,
      escape,
      unescape,
      atob: s => Buffer.from(s, 'base64').toString('binary'),
      btoa: s => Buffer.from(s, 'binary').toString('base64'),
      console: { log() {}, warn() {}, error() {}, info() {} },
    };
    sandbox.window = sandbox;
    sandbox.self = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.Element.prototype = {};
    sandbox.HTMLElement.prototype = {};
    sandbox.HTMLMediaElement.prototype = {};
    sandbox.HTMLVideoElement.prototype = {};

    vm.createContext(sandbox);
    try {
      vm.runInContext(baseJs, sandbox, { timeout: 6000 });
    } catch (e) {}

    cachedPlayerState = {
      ytp: sandbox._yt_player,
      sts,
      playerHash,
      cachedCtor: null,
      cachedMethod: null,
      ts: Date.now(),
    };
    return cachedPlayerState;
  })();

  try {
    return await loadingPromise;
  } finally {
    loadingPromise = null;
  }
}

async function decipherSabrUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  const state = await getPlayerContext(false);
  const ytp = state?.ytp;
  if (!ytp) return rawUrl;

  try {
    const parsedUrl = new URL(rawUrl);
    const origN = parsedUrl.searchParams.get('n');
    if (!origN) return rawUrl;

    const cacheKey = `${state.playerHash}:${origN}`;
    const cachedN = getCachedNToken(cacheKey);
    if (cachedN) {
      parsedUrl.searchParams.set('n', cachedN);
      return parsedUrl.toString();
    }

    const extractValidResult = v => {
      if (typeof v !== 'string' || !v.startsWith('https://')) return null;
      const newN = new URL(v).searchParams.get('n');
      if (newN && newN !== origN) {
        setCachedNToken(cacheKey, newN);
        return v;
      }
      return null;
    };

    if (state.cachedCtor && state.cachedMethod) {
      try {
        const inst = new state.cachedCtor(rawUrl, true);
        const hit = extractValidResult(inst[state.cachedMethod]());
        if (hit) return hit;
      } catch (e) {}
    }

    for (const [, fn] of Object.entries(ytp)) {
      if (
        typeof fn === 'function' &&
        fn.prototype &&
        typeof fn.prototype.set === 'function' &&
        typeof fn.prototype.get === 'function'
      ) {
        try {
          const inst = new fn(rawUrl, true);
          for (const mk of Object.getOwnPropertyNames(fn.prototype)) {
            if (mk !== 'constructor' && typeof inst[mk] === 'function' && inst[mk].length === 0) {
              const hit = extractValidResult(inst[mk]());
              if (hit) {
                state.cachedCtor = fn;
                state.cachedMethod = mk;
                return hit;
              }
            }
          }
        } catch (e) {}
      }
    }
  } catch (e) {}

  return rawUrl;
}

module.exports = {
  getPlayerContext,
  decipherSabrUrl,
  clearDecipherCache,
};
