// ReSourcefy game runtime shim. Runs first inside the sandboxed game iframe.
// The parent sends the game's files as Blobs; this script serves them to the
// game by patching every loading API (fetch, XHR, src/href setters, workers,
// audio, fonts, ES modules), then writes the game's HTML into the document.
import { init as lexerInit, parse as parseModule } from 'es-module-lexer/js';
import * as FakeIDB from 'fake-indexeddb';

(function () {
  if (window.__rsfShim) return;
  window.__rsfShim = true;
  const parentWin = window.parent;
  const post = (msg) => { try { parentWin.postMessage({ __rsf: true, ...msg }, '*'); } catch { /* ignore */ } };
  const VBASE = 'https://game.local/';

  // ---------------- console + errors ----------------
  const fmt = (a) => {
    if (a instanceof Error) return a.stack || String(a);
    if (typeof a === 'string') return a;
    try { return JSON.stringify(a, (k, v) => (typeof v === 'bigint' ? v.toString() : v)); } catch { return String(a); }
  };
  // Console output is sent in batches, at most a few hundred lines a second, so a game
  // that logs every frame can't slow the editor down.
  let queue = [], dropped = 0, timer = 0, windowCount = 0;
  const flush = () => {
    timer = 0;
    windowCount = 0;
    if (!queue.length && !dropped) return;
    post({ type: 'logs', items: queue, dropped });
    queue = [];
    dropped = 0;
  };
  const queueLog = (level, msg) => {
    if (windowCount++ > 150 && level !== 'error') dropped++;
    else queue.push({ level, msg });
    if (!timer) timer = setTimeout(flush, 250);
  };
  for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      queueLog(level === 'debug' ? 'log' : level, args.map(fmt).join(' ').slice(0, 4000));
    };
  }
  // document.open() erases window listeners, so the written page re-installs these first.
  window.__rsfReinstall = () => {
    window.addEventListener('error', (e) => queueLog('error', `${e.message || 'Error'}${e.filename ? ` (${e.filename.replace(/^blob:[^ ]*/, 'script')}:${e.lineno})` : ''}`));
    window.addEventListener('unhandledrejection', (e) => queueLog('error', 'Unhandled promise rejection: ' + fmt(e.reason)));
  };
  window.__rsfReinstall();

  // The artifact viewer blocks native dialogs; keep games from stalling on them.
  window.alert = (m) => { console.info('[alert] ' + m); };
  window.confirm = (m) => { console.info('[confirm] ' + m + ' -> OK'); return true; };
  window.prompt = (m, d) => { console.info('[prompt] ' + m); return d ?? ''; };
  const origOpen = window.open;
  window.open = (u) => { console.info('[window.open blocked] ' + u); try { return origOpen.call(window, 'about:blank'); } catch { return null; } };

  // ---------------- storage (opaque origin has none) ----------------
  function makeStorage(initial, persist) {
    const data = new Map(Object.entries(initial || {}));
    let timer = 0;
    const save = () => { if (!persist) return; clearTimeout(timer); timer = setTimeout(() => post({ type: 'storage', data: Object.fromEntries(data) }), 400); };
    const api = {
      getItem: (k) => (data.has(String(k)) ? data.get(String(k)) : null),
      setItem: (k, v) => { data.set(String(k), String(v)); save(); },
      removeItem: (k) => { data.delete(String(k)); save(); },
      clear: () => { data.clear(); save(); },
      key: (i) => [...data.keys()][i] ?? null,
      get length() { return data.size; },
    };
    return new Proxy(api, {
      get(t, p) { if (p in t) return typeof t[p] === 'function' ? t[p] : t[p]; return typeof p === 'string' && data.has(p) ? data.get(p) : undefined; },
      set(t, p, v) { if (p in t) return false; api.setItem(p, v); return true; },
      deleteProperty(t, p) { api.removeItem(p); return true; },
      has(t, p) { return p in t || data.has(p); },
      ownKeys() { return [...data.keys()]; },
      getOwnPropertyDescriptor(t, p) { return data.has(p) ? { value: data.get(p), enumerable: true, configurable: true, writable: true } : undefined; },
    });
  }
  function storageWorks(name) { try { const s = window[name]; s.setItem('__rsf', '1'); s.removeItem('__rsf'); return true; } catch { return false; } }
  function installStorage(saved) {
    for (const name of ['localStorage', 'sessionStorage']) {
      if (storageWorks(name)) continue;
      const st = makeStorage(name === 'localStorage' ? saved : {}, name === 'localStorage');
      try { Object.defineProperty(window, name, { configurable: true, enumerable: true, get: () => st }); } catch (e) { console.warn('storage polyfill failed', e); }
    }
    // In an opaque-origin sandbox, reading indexedDB works but open() throws; probe for real.
    let idbOk = false;
    try {
      const req = window.indexedDB.open('__rsf_probe');
      req.onsuccess = () => { try { req.result.close(); window.indexedDB.deleteDatabase('__rsf_probe'); } catch { /* ignore */ } };
      req.onerror = () => {};
      idbOk = true;
    } catch { idbOk = false; }
    let cachesOk = false;
    try { cachesOk = !!window.caches && typeof window.caches.open === 'function'; } catch { cachesOk = false; }
    if (!cachesOk) {
      const keyOf = (r) => (typeof r === 'string' ? r : r && r.url) || String(r);
      class MemCache {
        constructor() { this.m = new Map(); }
        async match(r) { const v = this.m.get(keyOf(r)); return v ? v.clone() : undefined; }
        async matchAll(r) { if (!r) return [...this.m.values()].map((v) => v.clone()); const v = await this.match(r); return v ? [v] : []; }
        async put(r, res) { this.m.set(keyOf(r), res.clone()); }
        async add(r) { const res = await fetch(r); await this.put(r, res); }
        async addAll(rs) { for (const r of rs) await this.add(r); }
        async delete(r) { return this.m.delete(keyOf(r)); }
        async keys() { return [...this.m.keys()].map((u) => new Request(u)); }
      }
      const stores = new Map();
      const cacheStorage = {
        async open(n) { if (!stores.has(n)) stores.set(n, new MemCache()); return stores.get(n); },
        async has(n) { return stores.has(n); },
        async delete(n) { return stores.delete(n); },
        async keys() { return [...stores.keys()]; },
        async match(r) { for (const c of stores.values()) { const v = await c.match(r); if (v) return v; } return undefined; },
      };
      try { Object.defineProperty(window, 'caches', { configurable: true, enumerable: true, get: () => cacheStorage }); } catch { /* ignore */ }
    }
    if (!idbOk) {
      const defs = { indexedDB: FakeIDB.indexedDB };
      for (const k of ['IDBKeyRange', 'IDBDatabase', 'IDBObjectStore', 'IDBIndex', 'IDBCursor', 'IDBCursorWithValue', 'IDBTransaction', 'IDBRequest', 'IDBOpenDBRequest', 'IDBVersionChangeEvent', 'IDBFactory']) defs[k] = FakeIDB[k];
      for (const [k, v] of Object.entries(defs)) { try { Object.defineProperty(window, k, { configurable: true, writable: true, value: v }); } catch { /* ignore */ } }
    }
    try { void document.cookie; } catch {
      let jar = '';
      try { Object.defineProperty(document, 'cookie', { configurable: true, get: () => jar, set: (v) => { const kv = String(v).split(';')[0]; const k = kv.split('=')[0]; jar = jar.split('; ').filter((x) => x && x.split('=')[0] !== k).concat(kv).join('; '); } }); } catch { /* ignore */ }
    }
  }

  // ---------------- virtual file system ----------------
  const MIME = {
    html: 'text/html', htm: 'text/html', js: 'text/javascript', mjs: 'text/javascript', cjs: 'text/javascript', json: 'application/json', css: 'text/css',
    wasm: 'application/wasm', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml', bmp: 'image/bmp', ico: 'image/x-icon',
    ogg: 'audio/ogg', mp3: 'audio/mpeg', wav: 'audio/wav', m4a: 'audio/mp4', aac: 'audio/aac', opus: 'audio/ogg', flac: 'audio/flac', mp4: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg',
    ttf: 'font/ttf', otf: 'font/otf', woff: 'font/woff', woff2: 'font/woff2', txt: 'text/plain', xml: 'application/xml', swf: 'application/x-shockwave-flash',
  };
  const mimeOf = (p) => MIME[p.slice(p.lastIndexOf('.') + 1).toLowerCase()] || 'application/octet-stream';
  const files = new Map();      // path -> Blob
  const lowerIndex = new Map(); // lowercase path -> path
  const baseIndex = new Map();  // lowercase basename -> [paths]
  const urls = new Map();       // path -> blob URL
  const ourUrls = new Set();
  let entryDir = '';

  function norm(p) {
    const out = [];
    for (const part of p.split('/')) {
      if (!part || part === '.') continue;
      if (part === '..') out.pop(); else out.push(part);
    }
    return out.join('/');
  }

  function lookup(path) {
    path = norm(path);
    if (files.has(path)) return path;
    const lp = path.toLowerCase();
    if (lowerIndex.has(lp)) return lowerIndex.get(lp);
    try { const dp = decodeURIComponent(path); if (files.has(dp)) return dp; const ld = dp.toLowerCase(); if (lowerIndex.has(ld)) return lowerIndex.get(ld); } catch { /* ignore */ }
    return null;
  }

  function lookupLoose(name) {
    const b = name.slice(name.lastIndexOf('/') + 1).toLowerCase();
    const c = baseIndex.get(b);
    if (!c || !c.length) return null;
    const pref = c.find((p) => p.startsWith(entryDir));
    return pref || c[0];
  }

  // Resolve any URL a game might use to a path in the virtual file system.
  function resolve(url, base) {
    if (url == null) return null;
    if (typeof url === 'object') url = url.url || url.href || String(url);
    url = String(url).trim();
    if (!url || url.startsWith('data:') || url.startsWith('javascript:') || url.startsWith('about:')) return null;
    if (url.startsWith('blob:')) {
      if (ourUrls.has(url)) return null;
      const rest = url.replace(/^blob:[^/]*\/\/[^/]*\//, '').replace(/^blob:null\//, '').replace(/^blob:/, '');
      if (/^[0-9a-f-]{36}$/i.test(rest)) return null;
      return lookup(entryDir + rest) || lookup(rest) || lookupLoose(rest);
    }
    let abs;
    try { abs = new URL(url, base || VBASE + entryDir); } catch { return null; }
    let path = null;
    if (abs.origin === 'https://game.local') path = abs.pathname.slice(1);
    else if (realBase && abs.href.startsWith(realBase)) path = entryDir + abs.href.slice(realBase.length).replace(/[?#].*$/, '');
    else if (abs.protocol === 'http:' || abs.protocol === 'https:') {
      // Absolute URL to some host: try the path part (games built with absolute CDN paths).
      const p = abs.pathname.slice(1);
      return lookup(p) || null;
    } else return null;
    path = decodeSafe(path.replace(/[?#].*$/, ''));
    return lookup(path) || lookup(entryDir + path) || null;
  }
  const decodeSafe = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  let realBase = '';
  try { realBase = document.baseURI.replace(/[^/]*$/, ''); } catch { /* ignore */ }

  const textCache = new Map();
  async function readText(path) {
    if (textCache.has(path)) return textCache.get(path);
    const t = await files.get(path).text();
    textCache.set(path, t);
    return t;
  }

  // Sync blob URL for a path (CSS/modules get rewritten versions first).
  function urlFor(path) {
    if (urls.has(path)) return urls.get(path);
    const blob = files.get(path);
    const typed = blob.type ? blob : new Blob([blob], { type: mimeOf(path) });
    const u = URL.createObjectURL(typed);
    urls.set(path, u);
    ourUrls.add(u);
    return u;
  }
  function mapUrl(url, base) {
    const p = resolve(url, base);
    return p ? urlFor(p) : url;
  }

  // ---------------- CSS ----------------
  async function rewriteCss(text, cssPath, depth = 0) {
    const dir = cssPath.includes('/') ? cssPath.slice(0, cssPath.lastIndexOf('/') + 1) : '';
    const base = VBASE + dir;
    // inline @import (blob stylesheets are blocked by the page policy)
    const imports = [];
    text = text.replace(/@import\s+(?:url\()?\s*['"]?([^'")\s;]+)['"]?\s*\)?[^;]*;/g, (m, u) => { imports.push(u); return `/*@import:${imports.length - 1}*/`; });
    for (let i = 0; i < imports.length; i++) {
      const p = resolve(imports[i], base);
      const inner = p && depth < 5 ? await rewriteCss(await readText(p), p, depth + 1) : '';
      text = text.replace(`/*@import:${i}*/`, inner);
    }
    return text.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => {
      if (/^(data:|blob:|#)/.test(u)) return m;
      const p = resolve(u, base);
      return p ? `url("${urlFor(p)}")` : m;
    });
  }

  // ---------------- ES modules ----------------
  const moduleUrls = new Map();
  const moduleBusy = new Set();
  async function moduleUrl(path) {
    if (moduleUrls.has(path)) return moduleUrls.get(path);
    if (moduleBusy.has(path)) return urlFor(path); // cycle: fall back to raw
    moduleBusy.add(path);
    await lexerInit;
    let src = await readText(path);
    const base = VBASE + path;
    let imports = [];
    try { [imports] = parseModule(src); } catch (e) { console.warn('Module parse failed for ' + path, e); }
    let out = '', last = 0;
    for (const im of imports) {
      if (im.n == null) continue;
      if (im.d === -2) continue; // import.meta
      const spec = im.n;
      if (!/^(\.{0,2}\/|https?:)/.test(spec)) continue; // bare specifiers: leave for import maps
      const p = resolve(spec, base);
      if (!p) continue;
      const u = await moduleUrl(p);
      out += src.slice(last, im.s) + (im.d > -1 && src[im.s] !== '"' && src[im.s] !== "'" ? JSON.stringify(u) : u);
      last = im.e;
    }
    out += src.slice(last);
    out = out.replace(/\bimport\.meta\.url\b/g, JSON.stringify(VBASE + path));
    const u = URL.createObjectURL(new Blob([out], { type: 'text/javascript' }));
    ourUrls.add(u);
    moduleUrls.set(path, u);
    moduleBusy.delete(path);
    return u;
  }

  // ---------------- API patches ----------------
  function patchAll() {
    // In about:srcdoc, location.href can't be a base for relative URLs; use the game's virtual folder.
    const OrigURL = window.URL;
    const fixBase = (b) => {
      if (b === undefined || b === null) return b;
      const bs = String(b);
      return /^(about:|blob:null|null$|data:)/.test(bs) ? VBASE + entryDir : b;
    };
    class GameURL extends OrigURL {
      constructor(url, base) {
        if (arguments.length > 1) super(url, fixBase(base));
        else super(url);
      }
    }
    try { window.URL = GameURL; } catch { /* ignore */ }
    const origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      const url = typeof input === 'string' || input instanceof URL ? String(input) : input && input.url;
      if (url && url.startsWith('data:')) return origFetch(dataToBlobUrl(url), init);
      const p = resolve(url);
      if (p) {
        const blob = files.get(p);
        return Promise.resolve(new Response(blob, { status: 200, headers: { 'Content-Type': blob.type || mimeOf(p), 'Content-Length': String(blob.size) } }));
      }
      return origFetch(input, init);
    };

    const xo = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url, ...rest) {
      const s = String(url);
      if (s.startsWith('data:')) return xo.call(this, method, dataToBlobUrl(s), ...rest);
      return xo.call(this, method, mapUrl(s), ...rest);
    };

    const patchProp = (proto, prop, mapper = (v) => mapUrl(v)) => {
      const d = proto && Object.getOwnPropertyDescriptor(proto, prop);
      if (!d || !d.set) return;
      Object.defineProperty(proto, prop, { ...d, set(v) { d.set.call(this, mapper(v, this)); } });
    };
    patchProp(HTMLImageElement.prototype, 'src');
    patchProp(HTMLScriptElement.prototype, 'src', (v, el) => {
      const p = resolve(v);
      if (!p) return v;
      if (el.type === 'module') { scheduleModule(el, p); return 'data:text/javascript,'; }
      return urlFor(p);
    });
    patchProp(HTMLMediaElement.prototype, 'src');
    patchProp(HTMLSourceElement.prototype, 'src');
    patchProp(HTMLIFrameElement.prototype, 'src');
    patchProp(HTMLEmbedElement.prototype, 'src');
    patchProp(HTMLVideoElement.prototype, 'poster');
    patchProp(HTMLInputElement.prototype, 'src');
    patchProp(HTMLLinkElement.prototype, 'href', (v, el) => {
      const p = resolve(v);
      if (!p) return v;
      if ((el.rel || '').toLowerCase().includes('stylesheet') || /\.css$/i.test(p)) {
        // stylesheets from blob URLs are blocked: inline them instead
        inlineStylesheet(el, p);
        return 'data:text/css,';
      }
      return urlFor(p);
    });
    const sa = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function (name, value) {
      const n = String(name).toLowerCase();
      if ((n === 'src' || n === 'href' || n === 'poster' || n === 'data') && typeof value === 'string' && !(this instanceof HTMLAnchorElement)) {
        const desc = n === 'href' ? 'href' : n;
        if (desc in this && (this instanceof HTMLImageElement || this instanceof HTMLScriptElement || this instanceof HTMLMediaElement || this instanceof HTMLSourceElement || this instanceof HTMLLinkElement || this instanceof HTMLIFrameElement)) {
          this[desc] = value;
          return;
        }
        if (this instanceof SVGElement || n === 'data') return sa.call(this, name, mapUrl(value));
      }
      return sa.call(this, name, value);
    };
    const OrigAudio = window.Audio;
    window.Audio = function (src) { const a = new OrigAudio(); if (src !== undefined) a.src = src; return a; };
    window.Audio.prototype = OrigAudio.prototype;
    const OrigFontFace = window.FontFace;
    if (OrigFontFace) {
      window.FontFace = function (family, source, desc) {
        if (typeof source === 'string') source = source.replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/g, (m, q, u) => (resolve(u) ? `url("${urlFor(resolve(u))}")` : m));
        return new OrigFontFace(family, source, desc);
      };
      window.FontFace.prototype = OrigFontFace.prototype;
    }
    const OrigWorker = window.Worker;
    // Audio worklets (Godot, Emscripten audio) load modules by URL too.
    if (window.AudioWorklet && AudioWorklet.prototype.addModule) {
      const addModule = AudioWorklet.prototype.addModule;
      AudioWorklet.prototype.addModule = function (url, opts) { return addModule.call(this, mapUrl(url), opts); };
    }
    window.Worker = function (url, opts) {
      const p = resolve(url);
      if (!p) return new OrigWorker(url, opts);
      return new OrigWorker(workerBootstrap(p, opts && opts.type === 'module'), opts);
    };
    window.Worker.prototype = OrigWorker.prototype;
    // Sandboxed frames throw on navigator.serviceWorker; games get an inert stand-in.
    try {
      const fakeSW = {
        register: () => Promise.reject(new Error('Service workers are not available in ReSourcefy')),
        getRegistration: () => Promise.resolve(undefined),
        getRegistrations: () => Promise.resolve([]),
        addEventListener() {}, removeEventListener() {}, controller: null, ready: new Promise(() => {}),
      };
      Object.defineProperty(Navigator.prototype, 'serviceWorker', { configurable: true, get: () => fakeSW });
    } catch { /* ignore */ }
    for (const m of ['pushState', 'replaceState']) {
      const o = history[m];
      history[m] = function (state, title) { try { return o.call(history, state, title); } catch { /* ignore */ } };
    }
    // Ignore navigation of the whole game frame (e.g. "restart" via location.href = ...).
    document.addEventListener('click', (e) => {
      const a = e.target && e.target.closest && e.target.closest('a[href]');
      if (!a) return;
      const href = a.getAttribute('href') || '';
      if (/^(#|javascript:)/.test(href)) return;
      e.preventDefault();
      console.info('[link] ' + href);
    }, true);
  }

  function dataToBlobUrl(u) {
    const m = /^data:([^,]*?)(;base64)?,(.*)$/s.exec(u);
    if (!m) return u;
    let bytes;
    if (m[2]) { const bin = atob(m[3]); bytes = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i); }
    else bytes = new TextEncoder().encode(decodeURIComponent(m[3]));
    const url = URL.createObjectURL(new Blob([bytes], { type: m[1] || 'application/octet-stream' }));
    ourUrls.add(url);
    return url;
  }

  function inlineStylesheet(linkEl, path) {
    readText(path).then((t) => rewriteCss(t, path)).then((css) => {
      const st = document.createElement('style');
      st.textContent = css;
      st.dataset.from = path;
      if (linkEl.parentNode) linkEl.parentNode.insertBefore(st, linkEl);
      else document.head.appendChild(st);
      setTimeout(() => linkEl.dispatchEvent(new Event('load')), 0);
    });
  }

  function scheduleModule(el, path) {
    moduleUrl(path).then((u) => {
      const s = document.createElement('script');
      s.type = 'module';
      s.src = u; // our own blob URL: passes through the patched setter unchanged
      s.onload = () => el.dispatchEvent(new Event('load'));
      s.onerror = () => el.dispatchEvent(new Event('error'));
      document.head.appendChild(s);
    });
  }

  // Worker files get the same file system shim.
  function workerBootstrap(path, isModule) {
    const map = {};
    for (const [p] of files) map[p] = urlFor(p);
    const target = isModule ? null : urlFor(path);
    const code = `(function(){
      var MAP=${JSON.stringify(map)};var BASE=${JSON.stringify(VBASE)};var DIR=${JSON.stringify(path.slice(0, path.lastIndexOf('/') + 1))};
      function res(u){try{u=String(u);if(u.indexOf('blob:')===0||u.indexOf('data:')===0)return u;var a=new URL(u,BASE+DIR);if(a.origin!=='https://game.local')return u;var p=decodeURIComponent(a.pathname.slice(1));return MAP[p]||u;}catch(e){return u;}}
      var f=self.fetch;self.fetch=function(i,o){var u=typeof i==='string'||i instanceof URL?String(i):i&&i.url;var r=res(u);return f.call(self,r!==u?r:i,o);};
      var xo=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(m,u){arguments[1]=res(u);return xo.apply(this,arguments);};
      var is=self.importScripts;self.importScripts=function(){var a=[];for(var i=0;i<arguments.length;i++)a.push(res(arguments[i]));return is.apply(self,a);};
      ${target ? `importScripts(${JSON.stringify(target)});` : ''}
    })();`;
    if (isModule) {
      return URL.createObjectURL(new Blob([code + `\nimport(${JSON.stringify(urlFor(path))});`], { type: 'text/javascript' }));
    }
    const u = URL.createObjectURL(new Blob([code], { type: 'text/javascript' }));
    ourUrls.add(u);
    return u;
  }

  // ---------------- HTML ----------------
  async function prepareHtml(path) {
    const text = await readText(path);
    const doc = new DOMParser().parseFromString(text, 'text/html');
    const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
    const base = VBASE + dir;
    for (const b of doc.querySelectorAll('base')) b.remove();
    for (const m of doc.querySelectorAll('meta[http-equiv]')) if (/refresh/i.test(m.getAttribute('http-equiv'))) m.remove();
    for (const link of [...doc.querySelectorAll('link[href]')]) {
      const rel = (link.getAttribute('rel') || '').toLowerCase();
      const p = resolve(link.getAttribute('href'), base);
      if (!p) continue;
      if (rel.includes('stylesheet')) {
        const st = doc.createElement('style');
        st.textContent = await rewriteCss(await readText(p), p);
        link.replaceWith(st);
      } else if (rel.includes('manifest') || rel.includes('preload') || rel.includes('prefetch')) link.remove();
      else link.setAttribute('href', urlFor(p));
    }
    for (const st of doc.querySelectorAll('style')) st.textContent = await rewriteCss(st.textContent, path);
    for (const el of doc.querySelectorAll('[style*="url("]')) el.setAttribute('style', await rewriteCss(el.getAttribute('style'), path));
    for (const s of doc.querySelectorAll('script')) {
      const src = s.getAttribute('src');
      const isModule = (s.getAttribute('type') || '').toLowerCase() === 'module';
      if (src) {
        const p = resolve(src, base);
        if (!p) continue;
        s.setAttribute('src', isModule ? await moduleUrl(p) : urlFor(p));
        s.removeAttribute('integrity');
        s.removeAttribute('crossorigin');
      } else if (isModule && /\bimport\b/.test(s.textContent)) {
        const tmp = dir + '__inline_module_' + Math.random().toString(36).slice(2) + '.js';
        files.set(tmp, new Blob([s.textContent], { type: 'text/javascript' }));
        s.textContent = `import(${JSON.stringify(await moduleUrl(tmp))});`;
      }
    }
    for (const el of doc.querySelectorAll('img[src],audio[src],video[src],source[src],iframe[src],embed[src],input[src],video[poster]')) {
      for (const attr of ['src', 'poster']) {
        const v = el.getAttribute(attr);
        if (!v) continue;
        const p = resolve(v, base);
        if (p) el.setAttribute(attr, urlFor(p));
      }
    }
    for (const el of doc.querySelectorAll('img[srcset],source[srcset]')) el.removeAttribute('srcset');
    const boot = doc.createElement('script');
    boot.textContent = 'window.__rsfReinstall&&window.__rsfReinstall()';
    doc.head.insertBefore(boot, doc.head.firstChild);
    const dt = doc.doctype ? '<!DOCTYPE html>' : '';
    return dt + doc.documentElement.outerHTML;
  }

  // ---------------- boot ----------------
  window.addEventListener('message', async (ev) => {
    const m = ev.data;
    if (!m || !m.__rsf || m.type !== 'boot' || window.__rsfBooted) return;
    window.__rsfBooted = true;
    try {
      for (const [p, blob] of Object.entries(m.files)) {
        files.set(p, blob);
        lowerIndex.set(p.toLowerCase(), p);
        const b = p.slice(p.lastIndexOf('/') + 1).toLowerCase();
        if (!baseIndex.has(b)) baseIndex.set(b, []);
        baseIndex.get(b).push(p);
      }
      entryDir = m.entry.includes('/') ? m.entry.slice(0, m.entry.lastIndexOf('/') + 1) : '';
      installStorage(m.storage || {});
      patchAll();
      const html = await prepareHtml(m.entry);
      post({ type: 'started' });
      document.open();
      document.write(html);
      document.close();
    } catch (e) {
      post({ type: 'log', level: 'error', msg: 'ReSourcefy runner failed to start the game: ' + (e && e.stack || e) });
      post({ type: 'failed', msg: String(e && e.message || e) });
    }
  });
  post({ type: 'hello' });
})();
