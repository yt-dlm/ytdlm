'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CACHE_DIR = path.join(os.tmpdir(), 'ytdlm-player-cache');

let cachedPlayerState = null;
let loadingPromise = null;

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
    try {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    } catch (e) {}

    let playerHash = '5203c085';
    try {
      const iframeRes = await fetch('https://www.youtube.com/iframe_api', {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      if (iframeRes.ok) {
        const text = await iframeRes.text();
        const m = text.match(/player\\\/([a-zA-Z0-9_-]{8})\\\//) || text.match(/player\/([a-zA-Z0-9_-]{8})\//);
        if (m && m[1]) playerHash = m[1];
      }
    } catch (e) {}

    const cacheFile = path.join(CACHE_DIR, `base_${playerHash}.js`);
    let baseJs = null;

    if (!forceRefresh && fs.existsSync(cacheFile)) {
      try {
        baseJs = fs.readFileSync(cacheFile, 'utf8');
      } catch (e) {}
    }

    if (!baseJs || baseJs.length < 100000) {
      const baseJsUrl = `https://www.youtube.com/s/player/${playerHash}/player_ias.vflset/en_US/base.js`;
      const res = await fetch(baseJsUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        },
      });
      if (!res.ok) {
        throw new Error(`Failed to fetch YouTube player base.js (${res.status})`);
      }
      baseJs = await res.text();
      try {
        fs.writeFileSync(cacheFile, baseJs, 'utf8');
      } catch (e) {}
    }

    const stsMatch = baseJs.match(/signatureTimestamp\s*:\s*(\d+)/);
    const sts = stsMatch ? Number(stsMatch[1]) : 20732;

    const sandbox = {
      window: null,
      self: null,
      globalThis: null,
      _yt_player: {},
      yt: {},
      ytcfg: { get: () => undefined, set: () => {} },
      location: new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
      navigator: {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
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
        location: new URL('https://www.youtube.com/watch?v=dQw4w9WgXcQ'),
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
      Function,
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
    const origN = new URL(rawUrl).searchParams.get('n');
    if (state.cachedCtor && state.cachedMethod) {
      try {
        const inst = new state.cachedCtor(rawUrl, true);
        const v = inst[state.cachedMethod]();
        if (typeof v === 'string' && v.startsWith('https://')) {
          const newN = new URL(v).searchParams.get('n');
          if (!origN || (newN && newN !== origN)) {
            return v;
          }
        }
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
              const v = inst[mk]();
              if (typeof v === 'string' && v.startsWith('https://')) {
                const newN = new URL(v).searchParams.get('n');
                if (!origN || (newN && newN !== origN)) {
                  state.cachedCtor = fn;
                  state.cachedMethod = mk;
                  return v;
                }
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
};
