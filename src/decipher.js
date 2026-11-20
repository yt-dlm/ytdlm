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

// Pure-realm browser shims executed inside the VM context so
// zero host objects or constructors cross the VM boundary.
const VM_BOOTSTRAP_CODE = [
  'const __ua = String(globalThis.__ua || "");',
  'const __w = String(globalThis.__watch || "");',
  'delete globalThis.__ua;',
  'delete globalThis.__watch;',
  'function makeDummy() {',
  '  const fn = function () {};',
  '  return new Proxy(fn, {',
  '    get(t, p) {',
  '      if (p === "style") return {};',
  '      if (p === "classList") {',
  '        return {',
  '          add() {},',
  '          remove() {},',
  '          contains() { return false; },',
  '        };',
  '      }',
  '      if (p === "childNodes" || p === "children") {',
  '        return [];',
  '      }',
  '      if (p === "dataset") return {};',
  '      if (typeof t[p] !== "undefined") return t[p];',
  '      return () => makeDummy();',
  '    },',
  '    set(t, p, v) { t[p] = v; return true; },',
  '    apply() { return makeDummy(); },',
  '    construct() { return makeDummy(); },',
  '  });',
  '}',
  'function SimpleParams(init) {',
  '  this._m = new Map();',
  '  const s = String(init || "").replace(/^\\?/, "");',
  '  if (!s) return;',
  '  for (const part of s.split("&")) {',
  '    if (!part) continue;',
  '    const i = part.indexOf("=");',
  '    const k = i >= 0 ? part.slice(0, i) : part;',
  '    const v = i >= 0 ? part.slice(i + 1) : "";',
  '    try {',
  '      this._m.set(',
  '        decodeURIComponent(k),',
  '        decodeURIComponent(v)',
  '      );',
  '    } catch (e) { this._m.set(k, v); }',
  '  }',
  '}',
  'SimpleParams.prototype.get = function (k) {',
  '  return this._m.has(k) ? this._m.get(k) : null;',
  '};',
  'SimpleParams.prototype.set = function (k, v) {',
  '  this._m.set(String(k), String(v));',
  '};',
  'SimpleParams.prototype.has = function (k) {',
  '  return this._m.has(k);',
  '};',
  'SimpleParams.prototype.delete = function (k) {',
  '  this._m.delete(k);',
  '};',
  'SimpleParams.prototype.toString = function () {',
  '  const out = [];',
  '  for (const [k, v] of this._m.entries()) {',
  '    const ek = encodeURIComponent(k);',
  '    const ev = encodeURIComponent(v);',
  '    out.push(ek + "=" + ev);',
  '  }',
  '  return out.join("&");',
  '};',
  'const __urlRe = new RegExp(',
  '  "^([a-z]+:)//([^/?#]+)([^?#]*)" +',
  '  "(\\\\?[^#]*)?(#.*)?$", "i"',
  ');',
  'function SimpleURL(input) {',
  '  const raw = String(input || "");',
  '  const m = raw.match(__urlRe);',
  '  this.href = raw;',
  '  this.protocol = m ? m[1] : "https:";',
  '  this.host = m ? m[2] : "www.youtube.com";',
  '  this.hostname = this.host.split(":")[0];',
  '  this.pathname = m ? (m[3] || "/") : "/";',
  '  this.search = m && m[4] ? m[4] : "";',
  '  this.hash = m && m[5] ? m[5] : "";',
  '  this.origin = this.protocol + "//" + this.host;',
  '  this.searchParams = new SimpleParams(this.search);',
  '}',
  'SimpleURL.prototype.toString = function () {',
  '  const q = this.searchParams.toString();',
  '  const base = this.origin + this.pathname;',
  '  return base + (q ? "?" + q : "") + this.hash;',
  '};',
  'const __b64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ" +',
  '  "abcdefghijklmnopqrstuvwxyz0123456789+/";',
  'function atobPoly(str) {',
  '  const s = String(str).replace(/[=\\s]+$/g, "");',
  '  let out = "";',
  '  for (let i = 0; i < s.length; i += 4) {',
  '    const c1 = __b64.indexOf(s[i]);',
  '    const c2 = __b64.indexOf(s[i + 1]);',
  '    const c3 = __b64.indexOf(s[i + 2]);',
  '    const c4 = __b64.indexOf(s[i + 3]);',
  '    const b1 = (c1 << 18) | (c2 << 12);',
  '    const b2 = ((c3 & 63) << 6) | (c4 & 63);',
  '    const n = b1 | b2;',
  '    out += String.fromCharCode((n >> 16) & 255);',
  '    if (c3 !== -1) {',
  '      out += String.fromCharCode((n >> 8) & 255);',
  '    }',
  '    if (c4 !== -1) {',
  '      out += String.fromCharCode(n & 255);',
  '    }',
  '  }',
  '  return out;',
  '}',
  'function btoaPoly(str) {',
  '  const s = String(str);',
  '  const l = s.length;',
  '  let out = "";',
  '  for (let i = 0; i < l; i += 3) {',
  '    const a = s.charCodeAt(i);',
  '    const b = i + 1 < l ? s.charCodeAt(i + 1) : NaN;',
  '    const c = i + 2 < l ? s.charCodeAt(i + 2) : NaN;',
  '    const i2 = ((a & 3) << 4) | (isNaN(b) ? 0 : b >> 4);',
  '    const i3 = ((b & 15) << 2) | (isNaN(c) ? 0 : c >> 6);',
  '    out += __b64[a >> 2] + __b64[i2];',
  '    out += isNaN(b) ? "=" : __b64[i3];',
  '    out += isNaN(c) ? "=" : __b64[c & 63];',
  '  }',
  '  return out;',
  '}',
  'globalThis.window = globalThis;',
  'globalThis.self = globalThis;',
  'globalThis._yt_player = {};',
  'globalThis.yt = {};',
  'globalThis.ytcfg = {',
  '  get() { return undefined; },',
  '  set() {},',
  '};',
  'globalThis.location = new SimpleURL(__w);',
  'globalThis.URL = SimpleURL;',
  'globalThis.URLSearchParams = SimpleParams;',
  'globalThis.atob = atobPoly;',
  'globalThis.btoa = btoaPoly;',
  'globalThis.navigator = {',
  '  userAgent: __ua,',
  '  mediaCapabilities: {},',
  '};',
  'globalThis.document = {',
  '  createElement: () => makeDummy(),',
  '  createElementNS: () => makeDummy(),',
  '  getElementsByTagName: () => [],',
  '  querySelector: () => null,',
  '  querySelectorAll: () => [],',
  '  addEventListener() {},',
  '  removeEventListener() {},',
  '  documentElement: makeDummy(),',
  '  body: makeDummy(),',
  '  head: makeDummy(),',
  '  cookie: "",',
  '  location: new SimpleURL(__w),',
  '};',
  'globalThis.Element = function () {};',
  'globalThis.HTMLElement = function () {};',
  'globalThis.HTMLMediaElement = function () {};',
  'globalThis.HTMLVideoElement = function () {};',
  'globalThis.Event = function () {};',
  'globalThis.CustomEvent = function () {};',
  'globalThis.Node = function () {};',
  'globalThis.XMLHttpRequest = function () {};',
  'globalThis.fetch = () => Promise.resolve();',
  'globalThis.setTimeout = () => 0;',
  'globalThis.clearTimeout = () => {};',
  'globalThis.setInterval = () => 0;',
  'globalThis.clearInterval = () => {};',
  'globalThis.requestAnimationFrame = () => 0;',
  'globalThis.cancelAnimationFrame = () => {};',
  'globalThis.performance = {',
  '  now: () => Date.now(),',
  '  mark() {},',
  '  measure() {},',
  '};',
  'globalThis.screen = { width: 1920, height: 1080 };',
  'globalThis.matchMedia = () => ({',
  '  matches: false,',
  '  addListener() {},',
  '  addEventListener() {},',
  '});',
  'globalThis.CSS = { supports: () => true };',
  'globalThis.console = {',
  '  log() {}, warn() {}, error() {}, info() {},',
  '};',
  'globalThis.TextEncoder = function () {};',
  'globalThis.TextEncoder.prototype.encode = function (s) {',
  '  const u = unescape(encodeURIComponent(String(s)));',
  '  const a = new Uint8Array(u.length);',
  '  for (let i = 0; i < u.length; i++) {',
  '    a[i] = u.charCodeAt(i);',
  '  }',
  '  return a;',
  '};',
  'globalThis.TextDecoder = function () {};',
  'globalThis.TextDecoder.prototype.decode = function (a) {',
  '  let s = "";',
  '  for (let i = 0; i < a.length; i++) {',
  '    s += String.fromCharCode(a[i]);',
  '  }',
  '  try { return decodeURIComponent(escape(s)); }',
  '  catch (e) { return s; }',
  '};',
  'let __ctor = null;',
  'let __meth = null;',
  'globalThis.__decipherN = function (rawUrl, origN) {',
  '  const ytp = globalThis._yt_player;',
  '  if (!ytp) return "";',
  '  const pick = (v) => {',
  '    if (typeof v !== "string") return "";',
  '    if (!v.startsWith("https://")) return "";',
  '    const nn = new SimpleURL(v).searchParams.get("n");',
  '    return (nn && nn !== origN) ? nn : "";',
  '  };',
  '  if (__ctor && __meth) {',
  '    try {',
  '      const inst = new __ctor(rawUrl, true);',
  '      const r = pick(inst[__meth]());',
  '      if (r) return r;',
  '    } catch (e) {}',
  '  }',
  '  for (const k of Object.keys(ytp)) {',
  '    const fn = ytp[k];',
  '    if (typeof fn !== "function" || !fn.prototype) {',
  '      continue;',
  '    }',
  '    const p = fn.prototype;',
  '    if (typeof p.set !== "function") continue;',
  '    if (typeof p.get !== "function") continue;',
  '    try {',
  '      const inst = new fn(rawUrl, true);',
  '      for (const mk of Object.getOwnPropertyNames(p)) {',
  '        if (mk === "constructor") continue;',
  '        if (typeof inst[mk] !== "function") continue;',
  '        if (inst[mk].length !== 0) continue;',
  '        const r = pick(inst[mk]());',
  '        if (r) {',
  '          __ctor = fn;',
  '          __meth = mk;',
  '          return r;',
  '        }',
  '      }',
  '    } catch (e) {}',
  '  }',
  '  return "";',
  '};',
].join('\n');

const BOOTSTRAP_SCRIPT = new vm.Script(VM_BOOTSTRAP_CODE);
const DECIPHER_SCRIPT = new vm.Script('__decipherN(__inUrl, __inN)');

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

function createIsolatedVmContext() {
  const ctx = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false },
  });
  ctx.__ua = WEB_USER_AGENT;
  ctx.__watch = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
  BOOTSTRAP_SCRIPT.runInContext(ctx, { timeout: 2000 });
  return ctx;
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

    const ctx = createIsolatedVmContext();
    try {
      vm.runInContext(baseJs, ctx, { timeout: 6000 });
    } catch (e) {}

    cachedPlayerState = {
      ctx,
      sts,
      playerHash,
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
  const ctx = state?.ctx;
  if (!ctx) return rawUrl;

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

    ctx.__inUrl = String(rawUrl);
    ctx.__inN = String(origN);
    let newN = '';
    try {
      const out = DECIPHER_SCRIPT.runInContext(ctx, { timeout: 2000 });
      if (typeof out === 'string' && out.length > 0 && out.length < 256) {
        newN = out;
      }
    } finally {
      ctx.__inUrl = '';
      ctx.__inN = '';
    }

    if (newN && newN !== origN) {
      setCachedNToken(cacheKey, newN);
      parsedUrl.searchParams.set('n', newN);
      return parsedUrl.toString();
    }
  } catch (e) {}

  return rawUrl;
}

module.exports = {
  createIsolatedVmContext,
  getPlayerContext,
  decipherSabrUrl,
  clearDecipherCache,
};
