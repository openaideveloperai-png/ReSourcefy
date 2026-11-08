// Game view: runs the prepared build inside a sandboxed iframe with the shim.
/* global __RUNNER_SHIM__ */
import { h, icons, clear } from './dom.js';
import { showMissingDialog } from './missing.js';

const SHIM = typeof __RUNNER_SHIM__ !== 'undefined' ? __RUNNER_SHIM__ : '';
let vendorManifest = null;

// v: a runtime name, or { name, dir, rename: { from: to } } to place its files elsewhere
export async function loadVendor(v) {
  const name = typeof v === 'string' ? v : v.name;
  const dir = typeof v === 'string' || v.dir == null ? `__vendor/${name}/` : v.dir;
  const rename = (f) => { if (typeof v !== 'string' && v.rename) for (const [a, b] of Object.entries(v.rename)) if (f.startsWith(a)) return b + f.slice(a.length); return f; };
  if (!vendorManifest) {
    const r = await fetch('vendor/manifest.json');
    if (!r.ok) throw new Error('runtime manifest missing');
    vendorManifest = await r.json();
  }
  const list = vendorManifest[name] || [];
  const out = {};
  await Promise.all(list.map(async (f) => {
    const r = await fetch(`vendor/${name}/${f}`);
    if (!r.ok) throw new Error(`could not load ${name}/${f}`);
    // *.gz.wasm: a gzip-compressed WebAssembly module (keeps the bundle small)
    if (f.endsWith('.gz.wasm')) {
      const stream = r.body.pipeThrough(new DecompressionStream('gzip'));
      const buf = await new Response(stream).arrayBuffer();
      out[dir + rename(f.replace('.gz.wasm', '.wasm'))] = new Blob([buf], { type: 'application/wasm' });
    } else out[dir + rename(f)] = await r.blob();
  }));
  return out;
}

function storageKey(name) { return 'rsf-save:' + name; }
function loadSaves(name) {
  try { return JSON.parse(localStorage.getItem(storageKey(name)) || '{}'); } catch { return {}; }
}
function storeSaves(name, data) {
  try { localStorage.setItem(storageKey(name), JSON.stringify(data)); } catch { /* storage full or blocked */ }
}

export class GameView {
  constructor(app) {
    this.app = app;
    this.iframe = null;
    this.running = false;
    this.status = h('span', { class: 'muted' }, 'Not running');
    this.stage = h('div', { class: 'game-stage' });
    this.overlay = h('div', { class: 'game-overlay' });
    this.stage.appendChild(this.overlay);
    this.btnRestart = h('button', { class: 'btn sm', onclick: () => this.start(), title: 'Rebuild with your edits and restart' }, h('span', { html: icons.rebuild }), 'Restart');
    this.btnStop = h('button', { class: 'btn sm', onclick: () => this.stop(), disabled: true }, h('span', { html: icons.stop }), 'Stop');
    this.btnFull = h('button', { class: 'btn sm', onclick: () => this.fullscreen(), disabled: true }, h('span', { html: icons.expand }), 'Fullscreen');
    this.btnDownload = h('button', { class: 'btn sm', onclick: () => this.app.exportGame(), title: 'Download the game with your edits as a zip you can host or share' }, h('span', { html: icons.download }), 'Download');
    // files the game asked for (or will ask for) that aren't in the upload
    this.missing = new Map();
    this.btnMissing = h('button', { class: 'btn sm warn', hidden: true, onclick: () => this.showMissing(), title: 'Files the game needs that are not in the upload' });
    this.bar = h('div', { class: 'view-bar' }, h('span', { class: 'path' }, 'Game'), this.status, this.btnMissing, this.btnRestart, this.btnStop, this.btnFull, this.btnDownload);
    this.el = [this.bar, this.stage];
    this.onMessage = (e) => this.message(e);
    window.addEventListener('message', this.onMessage);
    this.idle();
  }

  idle(title = 'Press Play to run the game', text = 'ReSourcefy rebuilds the game from the files in the Project and Build folders, including your edits, and runs it here in a sandbox.') {
    clear(this.overlay);
    this.overlay.append(h('h3', null, title), h('p', null, text));
    const r = this.app.project && this.app.project.runnable;
    if (r) this.overlay.append(h('button', { class: 'btn primary', onclick: () => this.start() }, h('span', { html: icons.play }), 'Play ' + (r.label || '')));
    this.overlay.hidden = false;
    this.updateMissing();
  }

  // predicted by the analysis, plus what the running game asked for
  missingItems() {
    const out = new Map();
    for (const m of (this.app.project && this.app.project.missing) || []) out.set(m.path, m);
    for (const [path, why] of this.missing) if (!out.has(path)) out.set(path, { path, why });
    return [...out.values()];
  }

  updateMissing() {
    const n = this.missingItems().length;
    this.btnMissing.hidden = !n;
    this.btnMissing.textContent = `${n} missing file${n === 1 ? '' : 's'}`;
  }

  showMissing() {
    const items = this.missingItems();
    if (!items.length) return;
    showMissingDialog(this.app, items, { root: this.run && this.run.root });
  }

  async start() {
    this.stop(true);
    this.app.setRunning(true);
    this.status.textContent = 'Preparing build…';
    clear(this.overlay);
    this.overlay.append(h('h3', null, 'Building…'), h('p', null, 'Collecting files and applying your edits.'));
    this.overlay.hidden = false;
    let run;
    try {
      await this.app.saveAllTabs();
      run = await this.app.engine.call('prepareRun', {});
    } catch (e) {
      this.fail('Could not prepare the game: ' + e.message);
      return;
    }
    this.missing.clear();
    this.updateMissing();
    if (!run || !run.files) {
      this.fail(run && run.reason ? run.reason : 'This build has no web version that can run in the browser.', true);
      return;
    }
    let files = run.files;
    try {
      for (const v of run.vendor || []) Object.assign(files, await loadVendor(v));
    } catch (e) {
      this.fail('A bundled runtime failed to load: ' + e.message);
      return;
    }
    this.run = run;
    const iframe = h('iframe', {
      title: 'Game',
      sandbox: 'allow-scripts allow-pointer-lock allow-forms allow-modals allow-popups allow-orientation-lock',
      allow: 'fullscreen; autoplay; gamepad; accelerometer; gyroscope; clipboard-write',
      allowfullscreen: true,
    });
    const shim = SHIM.replace(/<\/script/gi, '<\\/script');
    iframe.srcdoc = `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;background:#000;color:#ccc;font:13px system-ui}</style><script>${shim}</script></head><body></body></html>`;
    this.iframe = iframe;
    this.pendingFiles = files;
    this.stage.insertBefore(iframe, this.overlay);
    this.status.textContent = `Starting ${run.label || 'game'}…`;
    this.running = true;
    this.btnStop.disabled = false;
    this.btnFull.disabled = false;
    this.app.log('info', `Running ${run.label || 'game'} (${Object.keys(files).length} files)`);
    if (run.notes) for (const n of run.notes) this.app.log('warn', n);
  }

  message(e) {
    if (!this.iframe || e.source !== this.iframe.contentWindow) return;
    const m = e.data;
    if (!m || !m.__rsf) return;
    if (m.type === 'hello') {
      const name = this.app.project ? this.app.project.name : 'game';
      this.iframe.contentWindow.postMessage({ __rsf: true, type: 'boot', files: this.pendingFiles, entry: this.run.entry, storage: loadSaves(name) }, '*');
    } else if (m.type === 'started') {
      this.overlay.hidden = true;
      this.status.textContent = 'Running';
      try { this.iframe.focus(); } catch { /* ignore */ }
    } else if (m.type === 'log') {
      this.app.log(m.level, m.msg, 'game');
    } else if (m.type === 'logs') {
      this.app.logMany(m.items || [], 'game', m.dropped || 0);
    } else if (m.type === 'missing') {
      const fresh = (m.paths || []).filter((p) => !this.missing.has(p));
      for (const p of fresh) this.missing.set(p, 'requested by the game');
      if (fresh.length) {
        this.app.log('warn', `The game asked for ${fresh.length === 1 ? 'a file that isn’t' : fresh.length + ' files that aren’t'} in the upload: ${fresh.slice(0, 8).join(', ')}${fresh.length > 8 ? ', …' : ''}`, 'game');
        this.updateMissing();
      }
    } else if (m.type === 'storage') {
      storeSaves(this.app.project ? this.app.project.name : 'game', m.data);
    } else if (m.type === 'failed') {
      this.fail(m.msg);
    }
  }

  fail(msg, info = false) {
    this.stop(true);
    this.idle(info ? 'Not playable here' : 'The game could not start', msg);
    this.status.textContent = info ? 'Not playable' : 'Failed';
    if (!info) this.app.log('error', msg);
  }

  stop(silent) {
    if (this.iframe) { this.iframe.remove(); this.iframe = null; }
    this.running = false;
    this.btnStop.disabled = true;
    this.btnFull.disabled = true;
    this.app.setRunning(false);
    if (!silent) { this.status.textContent = 'Stopped'; this.idle('Stopped', 'Press Play to run the game again. Edits you saved are included.'); }
  }

  fullscreen() {
    const el = this.stage;
    const req = el.requestFullscreen || el.webkitRequestFullscreen;
    if (req) Promise.resolve(req.call(el)).catch(() => this.app.toast('Fullscreen is not available in this view.'));
  }

  destroy() {
    this.stop(true);
    window.removeEventListener('message', this.onMessage);
  }
}
