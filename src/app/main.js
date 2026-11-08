// ReSourcefy editor UI: wires the engine worker, project tree, editor tabs,
// inspector, console/search dock, game runner and capabilities together.
import { h, clear, icons, formatBytes, debounce, basename, toast, modal, copyText, iconFor } from './dom.js';
import { EngineClient } from './engine-client.js';
import { FileTree } from './tree.js';
import { Tabs } from './tabs.js';
import { overviewView, analysisJSON } from './overview.js';
import { createEditor, formatCode, LANG_LABELS } from './viewers/code.js';
import { imageViewer, audioViewer, videoViewer, fontViewer } from './viewers/media.js';
import { hexViewer } from './viewers/hex.js';
import { GameView, loadVendor } from './runner.js';
import { zipBlob } from '../engine/util/zipblob.js';
import { galleryView } from './gallery.js';
import { filesFromDataTransfer, pickFiles } from './ingest.js';
import { placeFiles } from './missing.js';
import * as store from './store.js';
import { saveFile, extAllowed, askClaude, getSample } from './caps.js';
import { sampleGameFiles } from './sample.js';

class App {
  constructor() {
    this.project = null;
    this.listing = [];
    this.engine = new EngineClient('engine.js');
    this.engine.on('log', (m) => this.log(m.level, m.msg));
    this.engine.on('progress', (m) => this.progress(m.label, m.frac));
    this.engine.on('dead', (m) => this.engineRestarted(m.reason));
    this.layout();
    this.bindGlobal();
    // offer a way out if the engine stops answering
    setInterval(() => this.checkStuck(), 2000);
  }

  checkStuck() {
    const silent = Date.now() - this.engine.lastActivity;
    const stuck = this.engine.busy && silent > 15000;
    if (this.stopBtn) this.stopBtn.hidden = !stuck;
    if (stuck) this.stopBtn.textContent = `No response for ${Math.round(silent / 1000)} s — Stop`;
  }

  engineRestarted(reason) {
    this.progress(null);
    if (this.stopBtn) this.stopBtn.hidden = true;
    this.log('warn', `${reason}. The engine was restarted; open the game again to retry. If it keeps happening, include every file of the build (for Unity WebGL: the .loader.js, .framework.js, .data and .wasm files).`);
    this.toast(`${reason}. Open the game again to retry.`, { error: true });
  }

  // ---------------- layout ----------------
  layout() {
    const app = document.getElementById('app');
    clear(app);
    app.classList.remove('booting');

    this.nameEl = h('div', { class: 'project-name' }, 'No game loaded');
    this.chipsEl = h('div', { class: 'chips' });
    this.playBtn = h('button', { class: 'btn primary play-btn keep', onclick: () => this.togglePlay(), title: 'Play (F5)' }, h('span', { html: icons.play }), h('span', { class: 'tb-label' }, 'Play'));
    this.exportBtn = h('button', { class: 'btn', onclick: () => this.exportDialog(), title: 'Export files' }, h('span', { html: icons.download }), h('span', { class: 'tb-label' }, 'Export'));
    this.openBtn = h('button', { class: 'btn keep', onclick: () => this.openDialog(), title: 'Open a game' }, h('span', { html: icons.plus }), h('span', { class: 'tb-label' }, 'Open game'));
    this.imagesBtn = h('button', { class: 'btn', onclick: () => this.openGallery(), title: 'Every picture in the game (drop a file on one to replace it)' }, h('span', { html: icons.image }), h('span', { class: 'tb-label' }, 'Images'));
    const toolbar = h('header', { class: 'toolbar' },
      h('div', { class: 'brand', html: icons.logo + '<span>Re<b>Source</b>fy</span>' }),
      h('div', { class: 'project-id' }, this.nameEl, this.chipsEl),
      h('div', { class: 'tb-actions' }, this.openBtn, this.imagesBtn, this.exportBtn, this.playBtn),
    );

    // Narrow screens: pane switcher
    this.paneButtons = {};
    const paneSwitch = h('nav', { class: 'pane-switch', 'aria-label': 'Panels' },
      ['files', 'editor', 'info'].map((p) => (this.paneButtons[p] = h('button', { 'aria-pressed': String(p === 'editor'), onclick: () => this.showPane(p) }, { files: 'Files', editor: 'Editor', info: 'Inspector' }[p]))),
      (this.paneButtons.console = h('button', { 'aria-pressed': 'false', onclick: () => this.toggleMobileDock() }, 'Console')),
    );

    // Left: project tree + hierarchy
    this.tree = new FileTree({
      rootLabels: { Project: 'Project · recovered', Build: 'Build · original files' },
      rootOrder: ['Project', 'Build'],
      onOpen: (path) => { this.openFile(path); if (this.isNarrow()) this.showPane('editor'); },
      onSelect: (path) => this.inspect(path),
    });
    const filter = h('input', { class: 'search-input', type: 'search', placeholder: 'Filter files  (Ctrl+P: go to file)', 'aria-label': 'Filter files', id: 'tree-filter' });
    filter.addEventListener('input', debounce(() => this.tree.setFilter(filter.value), 150));
    this.leftTabs = { files: null };
    const left = h('aside', { class: 'side left', 'aria-label': 'Project' },
      h('div', { class: 'panel-tabs', role: 'tablist' }, (this.filesTabBtn = h('button', { class: 'panel-tab', role: 'tab', 'aria-selected': 'true' }, 'Project', h('span', { class: 'count' }, '')))),
      h('div', { class: 'panel-body' }, h('div', { class: 'panel-tools' }, filter), this.tree.el));

    // Center: tabs
    this.tabbar = h('div', { class: 'tabbar', role: 'tablist' });
    this.viewsEl = h('div', { class: 'views' });
    const center = h('main', { class: 'center' }, this.tabbar, this.viewsEl);
    this.tabs = new Tabs({ bar: this.tabbar, host: this.viewsEl, onActivate: (t) => { if (t.path) this.tree.select(t.path); } , onClose: (t) => this.confirmClose(t) });

    // Right: inspector
    this.inspectorEl = h('div', { class: 'inspector' }, h('div', { class: 'insp-empty' }, 'Select a file to see its details.'));
    const right = h('aside', { class: 'side right', 'aria-label': 'Inspector' },
      h('div', { class: 'panel-tabs' }, h('button', { class: 'panel-tab', 'aria-selected': 'true' }, 'Inspector')),
      this.inspectorEl);

    this.workbench = h('div', { class: 'workbench', 'data-pane': 'editor' },
      left, h('div', { class: 'splitter split-l', role: 'separator', 'aria-orientation': 'vertical' }), center,
      h('div', { class: 'splitter split-r', role: 'separator', 'aria-orientation': 'vertical' }), right);

    // Dock
    this.consoleEl = h('div', { class: 'console', role: 'log', 'aria-live': 'off' });
    this.notesEl = h('div', { class: 'notes', style: { padding: '8px 12px' } });
    this.searchEl = this.buildSearch();
    this.dockTabs = {};
    const dockTab = (id, label) => (this.dockTabs[id] = h('button', { class: 'panel-tab', role: 'tab', 'aria-selected': String(id === 'console'), onclick: () => this.showDock(id) }, label, h('span', { class: 'count' }, '')));
    this.dockBody = h('div', { class: 'dock-body' }, this.consoleEl);
    this.dock = h('section', { class: 'dock', 'aria-label': 'Console and search' },
      h('div', { class: 'dock-head' },
        h('div', { class: 'panel-tabs', role: 'tablist' }, dockTab('console', 'Console'), dockTab('notes', 'Notes'), dockTab('search', 'Search')),
        h('button', { class: 'btn ghost sm', onclick: () => clear(this.consoleEl), title: 'Clear console' }, 'Clear'),
        h('button', { class: 'btn ghost sm icon', onclick: () => this.dock.classList.toggle('collapsed'), title: 'Collapse', html: icons.chevron }),
      ),
      this.dockBody);
    this.hsplit = h('div', { class: 'hsplit', role: 'separator', 'aria-orientation': 'horizontal' });

    // Status bar
    this.progressText = h('span', null, 'Ready');
    this.progressBar = h('i');
    this.stopBtn = h('button', { class: 'btn sm danger', hidden: true, onclick: () => this.engine.restart('Analysis stopped') }, 'Stop');
    this.statsEl = h('span', { class: 'num' }, '');
    const status = h('footer', { class: 'statusbar' },
      h('div', { class: 'progress' }, h('div', { class: 'bar', hidden: true }, this.progressBar), this.progressText, this.stopBtn),
      h('span', { class: 'grow' }), this.statsEl, h('span', null, 'Runs entirely in your browser'));

    this.dropOverlay = h('div', { class: 'drop-overlay', 'aria-hidden': 'true' }, h('div', null, 'Drop to analyze'));
    app.append(toolbar, paneSwitch, this.workbench, this.hsplit, this.dock, status, this.dropOverlay);

    this.overviewTab = this.tabs.add({ id: 'overview', kind: 'overview', title: 'Overview', pinned: true, icon: ['scene', icons.info] });
    this.overview = overviewView(this);
    this.tabs.setContent(this.overviewTab, this.overview);
    this.tabs.activate('overview');
    this.setupSplitters();
  }

  setupSplitters() {
    const root = document.documentElement;
    const drag = (el, onMove) => {
      el.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        el.classList.add('dragging');
        const move = (ev) => onMove(ev);
        const up = () => { el.classList.remove('dragging'); el.removeEventListener('pointermove', move); el.removeEventListener('pointerup', up); };
        el.addEventListener('pointermove', move);
        el.addEventListener('pointerup', up);
      });
    };
    drag(this.workbench.querySelector('.split-l'), (e) => root.style.setProperty('--left-w', Math.max(170, Math.min(e.clientX, window.innerWidth * 0.5)) + 'px'));
    drag(this.workbench.querySelector('.split-r'), (e) => root.style.setProperty('--right-w', Math.max(200, Math.min(window.innerWidth - e.clientX, window.innerWidth * 0.5)) + 'px'));
    drag(this.hsplit, (e) => {
      const hgt = window.innerHeight - e.clientY - 24;
      this.dock.classList.remove('collapsed');
      this.dock.style.setProperty('--dock-h', Math.max(80, Math.min(hgt, window.innerHeight * 0.7)) + 'px');
    });
  }

  isNarrow() { return window.matchMedia('(max-width: 860px)').matches; }
  showPane(p) {
    this.workbench.dataset.pane = p;
    for (const [k, b] of Object.entries(this.paneButtons)) if (k !== 'console') b.setAttribute('aria-pressed', String(k === p));
  }
  toggleMobileDock() {
    const on = this.dock.classList.toggle('mobile-open');
    this.dock.classList.remove('collapsed');
    this.paneButtons.console.setAttribute('aria-pressed', String(on));
  }

  showDock(id) {
    for (const [k, b] of Object.entries(this.dockTabs)) b.setAttribute('aria-selected', String(k === id));
    clear(this.dockBody).appendChild({ console: this.consoleEl, notes: this.notesEl, search: this.searchEl }[id]);
    this.dock.classList.remove('collapsed');
    if (id === 'search') setTimeout(() => this.searchInput.focus(), 20);
  }

  bindGlobal() {
    let depth = 0;
    const hasFiles = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
    window.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; depth++; this.dropOverlay.classList.add('on'); e.preventDefault(); });
    window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener('dragleave', () => { depth = Math.max(0, depth - 1); if (!depth) this.dropOverlay.classList.remove('on'); });
    window.addEventListener('drop', async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      this.dropOverlay.classList.remove('on');
      const files = await filesFromDataTransfer(e.dataTransfer);
      if (!files.length) return;
      if (this.project && this.project.loaded && !this.project.sample) this.askDrop(files);
      else this.ingest(files);
    });
    window.addEventListener('keydown', (e) => {
      if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && e.key === 'Enter')) { e.preventDefault(); this.togglePlay(); }
      else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && (e.key === 'p' || e.key === 'P')) { e.preventDefault(); this.quickOpen(); }
      else if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === 'F' || e.key === 'f')) { e.preventDefault(); this.showDock('search'); }
      else if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); const t = this.tabs.active; if (t && t.save) t.save(); }
    });
    window.addEventListener('beforeunload', () => { if (this.game) this.game.destroy(); });
  }

  // ---------------- logging & progress ----------------
  log(level, msg, src) { this.logMany([{ level, msg }], src); }

  // Append many console lines with one DOM update (game output arrives in batches).
  logMany(items, src, dropped = 0) {
    const time = new Date().toTimeString().slice(0, 8);
    const body = this.dockBody;
    const stick = body.scrollHeight - body.scrollTop - body.clientHeight < 80;
    const frag = document.createDocumentFragment();
    let errors = 0;
    const max = 2000;
    for (const { level, msg } of items.length > max ? items.slice(-max) : items) {
      if (level === 'error') errors++;
      frag.appendChild(h('div', { class: 'log ' + (level === 'warn' || level === 'error' ? level : '') + (src ? ' game' : '') },
        h('span', { class: 't' }, time), src ? h('span', { class: 'src' }, '[' + src + ']') : null, h('span', null, msg)));
    }
    if (dropped) frag.appendChild(h('div', { class: 'log warn game' }, h('span', { class: 't' }, time), h('span', null, `… ${dropped.toLocaleString()} more game messages skipped to keep the editor responsive`)));
    this.consoleEl.appendChild(frag);
    const extra = this.consoleEl.childNodes.length - max;
    for (let i = 0; i < extra; i++) this.consoleEl.firstChild.remove();
    if (stick) body.scrollTop = body.scrollHeight;
    if (errors) { const c = this.dockTabs.console.querySelector('.count'); c.textContent = String((+c.textContent || 0) + errors); }
  }
  toast(msg, opts) { toast(msg, opts); }

  progress(label, frac) {
    const bar = this.progressBar.parentElement;
    if (!label) { this.progressText.textContent = 'Ready'; bar.hidden = true; return; }
    this.progressText.textContent = label;
    bar.hidden = false;
    this.progressBar.style.width = Math.round((frac || 0) * 100) + '%';
  }

  // ---------------- loading ----------------
  async boot() {
    await this.engine.ready.catch(() => {});
    this.log('info', 'ReSourcefy engine started. Drop a game folder or archive to begin.');
    let last = null;
    try { last = (await store.listGames()).find((g) => g.complete); } catch { /* storage unavailable */ }
    if (last && await this.reopen(last.id, { quiet: true })) return;
    await this.loadSample(true);
  }

  // Open a game kept in this browser and put its edits back.
  async reopen(id, { quiet = false } = {}) {
    let saved;
    try { saved = await store.loadGame(id); } catch (e) {
      if (!quiet) this.toast('Could not open the saved game: ' + e.message, { error: true });
      return false;
    }
    if (!saved.meta || !saved.files.length) return false;
    this.log('info', `Reopening ${saved.meta.name} from this browser${saved.edits.length ? ` with ${saved.edits.length} edit${saved.edits.length === 1 ? '' : 's'}` : ''}…`);
    return this.ingest(saved.files, { name: saved.meta.name, gameId: id, edits: saved.edits });
  }

  async openDialog() {
    const recent = h('div', { class: 'recent' });
    const dlg = modal({
      title: 'Open a game',
      body: h('div', { style: { display: 'grid', gap: '12px' } },
        h('p', null, 'Choose the folder that contains the game (recommended), or individual files such as a .pck, .apk, .zip, data.win, .wasm, .dll or .data.gz. You can also drag files anywhere onto this page.'),
        recent),
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Choose files', run: () => { this.pick({ directory: false }); } },
        { label: 'Choose folder', primary: true, run: () => { this.pick({ directory: true }); } },
      ],
    });
    this.renderRecent(recent, () => dlg.close(null));
  }

  // Games kept in this browser, newest first, with Open and Remove.
  async renderRecent(el, close) {
    let games = [];
    try { games = (await store.listGames()).filter((g) => g.complete); } catch { return; }
    clear(el);
    if (!games.length) return;
    const u = await store.usage();
    el.append(h('h4', null, 'Kept in this browser'));
    for (const g of games) {
      const row = h('div', { class: 'recent-row' + (g.id === this.gameId ? ' current' : '') },
        h('div', { class: 'recent-main' }, h('div', { class: 'recent-name' }, g.name), h('div', { class: 'muted small' }, [g.engine, formatBytes(g.size), g.edits ? `${g.edits} edit${g.edits === 1 ? '' : 's'}` : null, new Date(g.openedAt || g.createdAt).toLocaleDateString()].filter(Boolean).join(' · '))),
        h('button', { class: 'btn sm', disabled: g.id === this.gameId, onclick: () => { close(); this.reopen(g.id); } }, g.id === this.gameId ? 'Open now' : 'Open'),
        h('button', { class: 'btn sm', title: 'Remove it and its edits from this browser', onclick: async () => {
          try { await store.deleteGame(g.id); } catch { /* ignore */ }
          if (g.id === this.gameId) this.gameId = null;
          this.renderRecent(el, close);
        } }, 'Remove'));
      el.append(row);
    }
    if (u && u.quota) el.append(h('p', { class: 'muted small' }, `Saved games use ${formatBytes(u.used)} of the ${formatBytes(u.quota)} this browser allows. Your edits are saved as you make them.`));
  }

  async pick({ directory }) {
    const files = await pickFiles({ directory });
    if (files.length) this.ingest(files);
  }

  async loadSample(auto = false) {
    const files = await sampleGameFiles();
    await this.ingest(files, { name: 'Orbit Courier (sample)', sample: true, quiet: auto });
  }

  async ingest(files, { name, sample = false, quiet = false, gameId = null, edits = [] } = {}) {
    if (this.game) this.game.stop(true);
    this.tabs.closeAll();
    const total = files.reduce((a, f) => a + f.blob.size, 0);
    if (!quiet) this.log('info', `Analyzing ${files.length.toLocaleString()} file${files.length === 1 ? '' : 's'} (${formatBytes(total)})…`);
    this.progress('Reading files', 0);
    try {
      const snap = await this.engine.call('ingest', { files, name });
      this.applySnapshot(snap, { sample });
      this.gameId = sample ? null : gameId;
      if (gameId) await this.applySavedEdits(edits);
      if (!sample) this.toast(`Analysis complete: ${this.mainEngineLabel()}`);
      this.autoOpen();
      if (!sample && !gameId) this.keepGame(files);
      else if (gameId) store.updateGame(gameId, { openedAt: Date.now() }).catch(() => {});
      return true;
    } catch (e) {
      this.log('error', 'Analysis failed: ' + e.message);
      if (e.workerStack) console.error(e.workerStack);
      this.toast('Analysis failed: ' + e.message, { error: true });
      return false;
    } finally {
      this.progress(null);
    }
  }

  async applySavedEdits(edits) {
    let applied = 0, listing = null;
    const missed = [];
    for (const ed of edits) {
      try { const r = await this.engine.call('write', { path: ed.path, data: ed.blob }); listing = r.listing || listing; applied++; } catch { missed.push(ed.path); }
    }
    if (listing) this.refreshListing(listing);
    if (applied) this.log('info', `Put back ${applied} saved edit${applied === 1 ? '' : 's'}.`);
    if (missed.length) this.log('warn', `${missed.length} saved edit${missed.length === 1 ? '' : 's'} no longer match a file: ${missed.slice(0, 5).join(', ')}`);
  }

  // Keep a copy of a newly opened game in this browser (in the background).
  async keepGame(files) {
    const id = store.newGameId();
    this.gameId = id;
    const size = files.reduce((a, f) => a + f.blob.size, 0);
    const meta = { id, name: this.project.name, engine: this.mainEngineLabel(), size, fileCount: files.length, createdAt: Date.now(), openedAt: Date.now(), edits: 0 };
    try {
      // the same files opened again replace the older copy; at most 8 games are kept
      const games = await store.listGames();
      for (const g of games) if (g.name === meta.name && g.size === size && g.fileCount === files.length) await store.deleteGame(g.id);
      for (const g of (await store.listGames()).slice(7)) await store.deleteGame(g.id);
      await store.saveGame(meta, files.map((f) => ({ path: String(f.path).replace(/^\/+/, ''), blob: f.blob })));
      if (this.gameId === id) this.log('info', `Kept a copy of ${meta.name} in this browser, so it reopens after a reload.`);
    } catch (e) {
      try { await store.deleteGame(id); } catch { /* ignore */ }
      if (this.gameId === id) this.gameId = null;
      this.log('warn', `Couldn't keep a copy of this game in the browser (${e && e.name === 'QuotaExceededError' ? 'not enough storage' : (e && e.message) || 'storage unavailable'}); edits will be lost on reload.`);
    }
  }

  mainEngineLabel() {
    const e = this.project && this.project.engines.find((x) => !x.generic);
    return e ? `${e.name}${e.version ? ' ' + e.version : ''}` : 'no specific engine found';
  }

  applySnapshot(snap, { sample } = {}) {
    this.project = { ...snap.project, loaded: true, sample: sample ?? (this.project && this.project.sample) };
    this.listing = snap.listing;
    this.tree.setItems(this.listing);
    this.filesTabBtn.querySelector('.count').textContent = this.listing.length.toLocaleString();
    this.nameEl.textContent = this.project.name;
    this.nameEl.title = this.project.name;
    clear(this.chipsEl);
    for (const e of this.project.engines.filter((x) => !x.generic)) {
      this.chipsEl.appendChild(h('span', { class: 'chip engine' }, h('span', { class: 'dot' }), e.name + (e.version ? ' ' + e.version : '')));
    }
    if (this.project.platform) this.chipsEl.appendChild(h('span', { class: 'chip' }, this.project.platform));
    const warnCount = this.project.notes.filter((n) => n.level !== 'info').length;
    this.dockTabs.notes.querySelector('.count').textContent = this.project.notes.length ? String(this.project.notes.length) : '';
    clear(this.notesEl);
    if (!this.project.notes.length) this.notesEl.appendChild(h('div', { class: 'muted' }, 'No notes for this game.'));
    for (const n of this.project.notes) {
      this.notesEl.appendChild(h('div', { class: 'note ' + n.level }, h('span', { class: 'sev' }), h('span', null, n.text,
        n.path ? h('button', { class: 'linkish', style: { marginLeft: '6px' }, onclick: () => this.openFile(n.path) }, 'open') : null)));
    }
    void warnCount;
    const s = this.project.stats || {};
    this.statsEl.textContent = `${(s.files || 0).toLocaleString()} files · ${(s.recovered || 0).toLocaleString()} recovered`;
    this.playBtn.disabled = !this.project.runnable;
    this.playBtn.title = this.project.runnable ? `Play ${this.project.runnable.label || ''} (F5)` : 'No web build to run';
    this.projectIconUrl && URL.revokeObjectURL(this.projectIconUrl);
    this.projectIconUrl = this.project.icon ? URL.createObjectURL(this.project.icon) : null;
    this.overview.render();
    // open the Project root by default
    this.tree.open.add('Project');
    if (!this.listing.some((x) => x.path.startsWith('Project/'))) this.tree.open.add('Build');
    this.tree.refresh();
    if (this.game) this.game.idle();
    if (this.gallery) this.gallery.render();
  }

  autoOpen() {
    this.tabs.activate('overview');
    const first = this.project.mainFile;
    if (first) this.openFile(first, { background: true });
  }

  // Files dropped while a game is open: add them to it (e.g. its StreamingAssets folder) or open a new game.
  askDrop(files) {
    const missing = this.missingPaths();
    const placed = placeFiles(files, this.webRoot(), missing, '');
    const looksLikeAddition = files.some((f) => /(^|\/)StreamingAssets\//i.test(f.path)) || placed.some((p) => missing.some((m) => p.path.endsWith('/' + m)));
    const n = files.length;
    modal({
      title: 'Add to this game?',
      body: h('p', null, `Add ${n === 1 ? 'this file' : `these ${n.toLocaleString()} files`} to ${this.project.name}${looksLikeAddition ? ' (they look like files it is missing)' : ''}, or open ${n === 1 ? 'it' : 'them'} as a new game?`),
      actions: [
        { label: 'Cancel', value: null },
        { label: 'Open as a new game', primary: !looksLikeAddition, run: () => { this.ingest(files); } },
        { label: 'Add to this game', primary: looksLikeAddition, run: () => { this.addFiles(placed, { play: looksLikeAddition && !!this.project.runnable }); } },
      ],
    });
  }

  // Folder the running game is served from (where its StreamingAssets folder belongs).
  webRoot() {
    return (this.game && this.game.run && this.game.run.root) ?? this.project.webRoot ?? 'Build/';
  }

  missingPaths() {
    const out = new Set(((this.project && this.project.missing) || []).map((m) => m.path));
    if (this.game) for (const p of this.game.missing.keys()) out.add(p);
    return [...out];
  }

  // Add files to the open game (keeping edits) and analyze it again.
  async addFiles(files, { play = false } = {}) {
    if (!files.length) return;
    if (this.game) this.game.stop(true);
    const total = files.reduce((a, f) => a + f.blob.size, 0);
    this.log('info', `Adding ${files.length.toLocaleString()} file${files.length === 1 ? '' : 's'} (${formatBytes(total)})…`);
    this.progress('Adding files', 0);
    try {
      await this.saveAllTabs();
      this.tabs.closeAll((t) => t.id !== 'game');
      const snap = await this.engine.call('addFiles', { files });
      this.applySnapshot(snap);
      if (this.gameId) store.addFiles(this.gameId, files.map((f) => ({ path: f.path.replace(/^Build\//, ''), blob: f.blob }))).catch(() => {});
      const left = (this.project.missing || []).length;
      this.toast(`Added ${files.length.toLocaleString()} file${files.length === 1 ? '' : 's'}${left ? ` · ${left} still missing` : ''}`);
      if (play) this.play();
    } catch (e) {
      this.log('error', 'Adding files failed: ' + e.message);
      this.toast('Adding files failed: ' + e.message, { error: true });
    } finally {
      this.progress(null);
    }
  }

  async reanalyze() {
    if (this.game) this.game.stop(true);
    this.tabs.closeAll();
    this.progress('Re-analyzing', 0);
    try {
      const snap = await this.engine.call('reanalyze');
      this.applySnapshot(snap);
      this.toast('Re-analysis complete');
    } catch (e) {
      this.log('error', 'Re-analysis failed: ' + e.message);
    } finally { this.progress(null); }
  }

  async refreshListing(listing) {
    if (listing) { this.listing = listing; this.tree.setItems(listing); }
  }

  // ---------------- files ----------------
  async openFile(path, { line, col, len, background = false, raw = false } = {}) {
    const id = (raw ? 'raw:' : 'file:') + path;
    let tab = this.tabs.find(id);
    if (tab) {
      if (!background) this.tabs.activate(id);
      if (line && tab.editor) tab.editor.gotoLine(line, col, len);
      return tab;
    }
    const item = this.listing.find((x) => x.path === path) || { path };
    tab = this.tabs.add({ id, kind: 'file', path, title: basename(path) + (raw ? ' (raw)' : ''), item });
    this.tabs.setContent(tab, { el: h('div', { class: 'insp-empty' }, 'Opening…') });
    if (!background) this.tabs.activate(id);
    try {
      const file = await this.engine.call('open', { path, raw });
      tab.file = file;
      tab.modified = file.modified;
      this.tabs.setContent(tab, this.makeViewer(tab, file));
      this.tabs.renderBar();
      if (line && tab.editor) setTimeout(() => tab.editor.gotoLine(line, col, len), 30);
    } catch (e) {
      this.tabs.setContent(tab, { el: h('div', { class: 'insp-empty' }, `Could not open ${basename(path)}: ${e.message}`) });
      this.log('error', `Open failed for ${path}: ${e.message}`);
    }
    return tab;
  }

  makeViewer(tab, file) {
    const replaceWith = async (blob) => {
      await this.writeFile(file.path, await blob.arrayBuffer());
      this.tabs.close(tab.id);
      this.openFile(file.path);
      this.toast('Replaced. Press Play (or Restart) to see it in the game.');
    };
    const replace = (accept) => async () => {
      const picked = await pickFiles({ multiple: false, accept });
      if (picked.length) await replaceWith(picked[0].blob);
    };
    const canReplace = !file.converted && file.replaceable !== false;
    const media = (accept) => ({
      onReplace: canReplace ? replace(accept) : null,
      onReplaceWith: canReplace ? replaceWith : null,
      onRevert: file.modified ? () => this.revert(tab) : null,
      onDownload: () => this.exportPaths([file.path], basename(file.path)),
    });
    switch (file.view) {
      case 'code': return this.codeViewer(tab, file);
      case 'image': return imageViewer(file, media('image/*'));
      case 'audio': return audioViewer(file, media('audio/*'));
      case 'video': return videoViewer(file);
      case 'font': return fontViewer(file);
      case 'model': return this.lazyModel(file);
      default:
        return hexViewer(file, {
          readRange: (start, end) => this.engine.call('readRange', { path: file.path, start, end }),
          onOpenText: file.textual ? async () => { await this.engine.call('action', { id: 'openAsText', params: { path: file.path } }); this.tabs.close(tab.id); this.openFile(file.path); } : null,
          actions: [h('button', { class: 'btn sm', onclick: () => this.exportPaths([file.path], basename(file.path)) }, h('span', { html: icons.download }), 'Download')],
        });
    }
  }

  lazyModel(file) {
    const holder = h('div', { class: 'view-body' }, h('div', { class: 'insp-empty' }, 'Loading 3D viewer…'));
    const v = { el: holder, inner: null, destroy() { this.inner && this.inner.destroy(); } };
    import('./viewers/model.js').then(({ modelViewer }) => {
      v.inner = modelViewer(file);
      const parent = holder.parentElement;
      if (!parent) return;
      holder.replaceWith(...v.inner.el);
    }).catch((e) => { holder.textContent = 'The 3D viewer failed to load: ' + e.message; });
    return v;
  }

  codeViewer(tab, file) {
    const host = h('div', { class: 'view-body cm-wrap' });
    const lang = file.lang || 'text';
    const readonly = !!file.readonly;
    const saveBtn = h('button', { class: 'btn sm', disabled: true, onclick: () => tab.save(), title: 'Save (Ctrl+S)' }, 'Save');
    const revertBtn = h('button', { class: 'btn sm ghost', hidden: !file.modified, onclick: () => this.revert(tab), title: 'Restore the original file' }, h('span', { html: icons.revert }), 'Revert');
    const fmtBtn = /^(javascript|json|css|html|xml|gml|actionscript)$/.test(lang) ? h('button', { class: 'btn sm', onclick: async () => {
      try { tab.editor.setText(await formatCode(tab.editor.getText(), lang)); } catch (e) { this.toast('Format failed: ' + e.message, { error: true }); }
    }, title: 'Re-indent minified code' }, h('span', { html: icons.format }), 'Format') : null;
    const aiBtn = h('button', { class: 'btn sm', onclick: () => this.askAI(tab), title: 'Ask Claude to explain or clean up this code' }, h('span', { html: icons.spark }), 'Ask Claude');
    const altList = file.alts || file.related || [];
    const alts = altList.length ? h('div', { class: 'seg' }, [h('button', { 'aria-pressed': 'true' }, file.altLabel || LANG_LABELS[lang] || lang), ...altList.map((a) => h('button', { 'aria-pressed': 'false', onclick: () => this.openFile(a.path) }, a.label))]) : null;
    const bar = h('div', { class: 'view-bar' },
      h('span', { class: 'path', title: file.path }, file.path),
      alts,
      h('span', { class: 'badge' }, LANG_LABELS[lang] || lang),
      file.origin === 'recovered' ? h('span', { class: 'badge yes' }, 'Recovered') : null,
      readonly ? h('span', { class: 'badge' }, 'Read-only view') : null,
      fmtBtn, aiBtn, revertBtn, readonly ? null : saveBtn,
    );
    const notes = [];
    if (file.truncated) notes.push(h('div', { class: 'view-note warn' }, 'This file is very large; only the first 24 MB is shown.'));
    if (file.note) notes.push(h('div', { class: 'view-note' }, file.note));
    if (file.convertError) notes.push(h('div', { class: 'view-note warn' }, 'Conversion failed: ' + file.convertError));
    tab.editor = createEditor(host, {
      text: file.text || '', lang, readOnly: readonly,
      onChange: () => { if (!tab.dirty) { this.tabs.markDirty(tab, true); saveBtn.disabled = false; } },
      onSave: () => tab.save(),
    });
    tab.save = async () => {
      if (!tab.dirty || readonly) return;
      await this.writeFile(file.path, tab.editor.getText());
      this.tabs.markDirty(tab, false);
      tab.modified = true;
      saveBtn.disabled = true;
      revertBtn.hidden = false;
      this.tabs.renderBar();
    };
    return { el: [bar, ...notes, host], destroy: () => tab.editor.destroy() };
  }

  async writeFile(path, data) {
    const r = await this.engine.call('write', { path, data });
    if (r.listing) this.refreshListing(r.listing);
    this.log('info', `Saved ${path}`);
    if (this.gameId) this.rememberEdit(path, new Blob([data]));
  }

  async rememberEdit(path, blob) {
    try {
      await store.saveEdit(this.gameId, path, blob);
      await store.updateGame(this.gameId, { edits: this.listing.filter((x) => x.modified).length });
    } catch { /* storage unavailable: the edit still applies for this session */ }
  }

  async revert(tab) {
    const r = await this.engine.call('revert', { path: tab.path });
    if (r.listing) this.refreshListing(r.listing);
    if (this.gameId) store.deleteEdit(this.gameId, tab.path).catch(() => {});
    this.tabs.close(tab.id);
    this.openFile(tab.path);
    this.toast('Reverted to the original');
  }

  async saveAllTabs() {
    for (const t of this.tabs.tabs) if (t.dirty && t.save) await t.save();
  }

  confirmClose(t) {
    if (!t.dirty) return true;
    modal({
      title: 'Save changes?',
      body: h('p', null, `${basename(t.path)} has unsaved edits.`),
      actions: [
        { label: 'Cancel', value: null },
        { label: "Don't save", run: () => { t.dirty = false; this.tabs.close(t.id); } },
        { label: 'Save', primary: true, run: async () => { await t.save(); this.tabs.close(t.id); } },
      ],
    });
    return false;
  }

  async inspect(path) {
    let info;
    try { info = await this.engine.call('inspect', { path }); } catch { info = null; }
    clear(this.inspectorEl);
    if (!info) {
      const kids = this.listing.filter((x) => x.path.startsWith(path + '/'));
      const size = kids.reduce((a, x) => a + (x.size || 0), 0);
      this.inspectorEl.appendChild(h('div', { class: 'insp-section' }, h('h4', null, 'Folder'),
        h('div', { class: 'prop-grid' }, h('span', { class: 'k' }, 'Path'), h('span', { class: 'v' }, path), h('span', { class: 'k' }, 'Files'), h('span', { class: 'v' }, kids.length.toLocaleString()), h('span', { class: 'k' }, 'Size'), h('span', { class: 'v' }, formatBytes(size))),
        h('div', { class: 'insp-actions', style: { marginTop: '10px' } }, h('button', { class: 'btn sm', onclick: () => this.exportFolder(path) }, h('span', { html: icons.download }), 'Download folder (.zip)'))));
      return;
    }
    const [icCls, icSvg] = iconFor(info);
    this.inspectorEl.appendChild(h('div', { class: 'insp-section' },
      h('h4', null, h('span', { class: 'ic ' + icCls, html: icSvg, style: { display: 'inline-grid', width: '14px', verticalAlign: '-3px', marginRight: '6px' } }), basename(info.path)),
      h('div', { class: 'prop-grid' }, info.rows.flatMap(([k, v]) => [h('span', { class: 'k' }, k), h('span', { class: 'v' }, String(v))]))));
    if (info.meta) {
      const rows = Object.entries(info.meta).filter(([, v]) => v != null && typeof v !== 'object');
      if (rows.length) {
        this.inspectorEl.appendChild(h('div', { class: 'insp-section' }, h('h4', null, 'Details'),
          h('div', { class: 'prop-grid' }, rows.flatMap(([k, v]) => [h('span', { class: 'k', title: k }, k), h('span', { class: 'v' }, String(v))]))));
      }
      const objs = Object.entries(info.meta).filter(([, v]) => v && typeof v === 'object' && !(v instanceof Blob) && !Array.isArray(v));
      for (const [k, v] of objs.slice(0, 6)) {
        const r = Object.entries(v).filter(([, x]) => x != null && typeof x !== 'object').slice(0, 60);
        if (!r.length) continue;
        this.inspectorEl.appendChild(h('div', { class: 'insp-section' }, h('h4', null, k),
          h('div', { class: 'prop-grid' }, r.flatMap(([a, b]) => [h('span', { class: 'k', title: a }, a), h('span', { class: 'v' }, String(b))]))));
      }
    }
    this.inspectorEl.appendChild(h('div', { class: 'insp-section' }, h('h4', null, 'Actions'),
      h('div', { class: 'insp-actions' },
        h('button', { class: 'btn sm', onclick: () => this.openFile(info.path) }, 'Open'),
        info.view !== 'hex' ? h('button', { class: 'btn sm', onclick: () => this.openFile(info.path, { raw: true }) }, 'Open raw') : null,
        h('button', { class: 'btn sm', onclick: () => this.exportPaths([info.path], basename(info.path)) }, h('span', { html: icons.download }), 'Download'),
        ...(info.actions || []).map((a) => h('button', { class: 'btn sm', onclick: () => this.runAction(a.id, a.params) }, a.label)),
      )));
  }

  // ---------------- export ----------------
  exportDialog() {
    if (!this.project) return;
    const modifiedCount = this.listing.filter((x) => x.modified).length;
    modal({
      title: 'Export',
      body: h('div', { style: { display: 'grid', gap: '10px' } },
        h('p', null, 'Files are packed into a .zip in your browser and saved through the artifact\'s download prompt.'),
        this.project.runnable ? h('button', { class: 'btn primary', onclick: () => this.exportGame() }, 'Playable game with your edits') : null,
        h('button', { class: 'btn', onclick: () => this.exportScope('project') }, 'Recovered project (Project folder)'),
        h('button', { class: 'btn', disabled: !modifiedCount, onclick: () => this.exportScope('modified') }, `Modified files only (${modifiedCount})`),
        h('button', { class: 'btn', onclick: () => this.exportScope('all') }, 'Everything (original + recovered)'),
        h('button', { class: 'btn', onclick: () => copyText(JSON.stringify(analysisJSON(this.project), null, 2)) }, 'Copy analysis JSON'),
      ),
      actions: [{ label: 'Close', value: null }],
    });
  }

  async exportScope(scope) {
    document.querySelector('.modal-back')?.remove();
    await this.saveAllTabs();
    this.progress('Packing files', 0.1);
    try {
      const r = await this.engine.call('exportFiles', { scope });
      const name = `${(this.project.name || 'game').replace(/[\\/:*?"<>|]+/g, '_')}-${scope}.zip`;
      const res = await saveFile(name, r.blob);
      this.toast(res.ok ? `${res.message} (${r.count} files)` : res.message, { error: !res.ok });
    } catch (e) {
      this.toast('Export failed: ' + e.message, { error: true });
    } finally { this.progress(null); }
  }

  // The game as it runs here (edits applied, runtime included), ready to put on a web host.
  async exportGame() {
    document.querySelector('.modal-back')?.remove();
    if (!this.project || !this.project.runnable) { this.toast('This game has no web version to download.'); return; }
    await this.saveAllTabs();
    this.progress('Building the game', 0.05);
    try {
      const run = await this.engine.call('prepareRun', {});
      if (!run || !run.files) throw new Error(run && run.reason ? run.reason : 'This game has no web version to download.');
      const files = { ...run.files };
      for (const v of run.vendor || []) Object.assign(files, await loadVendor(v));
      // the start page ReSourcefy wrote becomes index.html
      if (!files['index.html']) {
        if (!run.entry.includes('/')) { files['index.html'] = files[run.entry]; delete files[run.entry]; }
        else files['index.html'] = new Blob([`<!DOCTYPE html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=${encodeURI(run.entry)}"><a href="${encodeURI(run.entry)}">Start the game</a>`], { type: 'text/html' });
      }
      const name = (this.project.name || 'game').replace(/[\\/:*?"<>|]+/g, '_');
      files['README.txt'] = new Blob([`${this.project.name || 'This game'}, exported by ReSourcefy${(run.notes || []).some((n) => /edit/i.test(n)) ? ' with your edits' : ''}.\r\n\r\n` +
        'To play it, put this folder on a web server: upload the zip to itch.io as an HTML game, or run\r\n' +
        '"npx serve" or "python -m http.server" inside the folder and open the address it prints.\r\n' +
        'Opening index.html straight from disk does not work in most browsers.\r\n'], { type: 'text/plain' });
      for (const n of run.notes || []) this.log('info', n);
      const blob = await zipBlob(Object.entries(files).map(([path, data]) => ({ path, data })), { onProgress: (f) => this.progress('Packing the game', 0.1 + f * 0.85) });
      const res = await saveFile(`${name}-playable.zip`, blob);
      this.toast(res.ok ? `${res.message} (${formatBytes(blob.size)})` : res.message, { error: !res.ok });
    } catch (e) {
      this.log('error', 'Download failed: ' + e.message);
      this.toast('Download failed: ' + e.message, { error: true });
    } finally { this.progress(null); }
  }

  async exportPaths(paths, label) {
    try {
      if (paths.length === 1 && extAllowed(paths[0])) {
        const blobs = await this.engine.call('blobs', { paths });
        const res = await saveFile(basename(paths[0]), blobs[paths[0]]);
        this.toast(res.message, { error: !res.ok });
        return;
      }
      const r = await this.engine.call('exportFiles', { paths });
      const res = await saveFile(`${label}.zip`, r.blob);
      this.toast(res.message, { error: !res.ok });
    } catch (e) { this.toast('Download failed: ' + e.message, { error: true }); }
  }

  async exportFolder(path) {
    try {
      const r = await this.engine.call('exportFiles', { scope: 'folder', root: path });
      const res = await saveFile(`${basename(path) || 'files'}.zip`, r.blob);
      this.toast(res.message, { error: !res.ok });
    } catch (e) { this.toast('Download failed: ' + e.message, { error: true }); }
  }

  // ---------------- actions ----------------
  async runAction(id, params) {
    this.progress('Working', 0.1);
    try {
      const r = await this.engine.call('action', { id, params });
      this.applySnapshot(r);
      const res = r.result;
      if (res && res.open) this.openFile(res.open);
      if (res && res.message) this.toast(res.message);
    } catch (e) {
      this.toast(e.message, { error: true });
      this.log('error', e.message);
    } finally { this.progress(null); }
  }

  // Ctrl+P: jump to a file by typing part of its name.
  quickOpen() {
    if (!this.listing || document.querySelector('.qo')) return;
    const input = h('input', { type: 'text', placeholder: 'Type part of a file name…', 'aria-label': 'File name', spellcheck: 'false' });
    const list = h('div', { class: 'qo-list', role: 'listbox' });
    let results = [], sel = 0;
    const score = (path, q) => {
      const p = path.toLowerCase(), name = p.slice(p.lastIndexOf('/') + 1);
      let s;
      const i = name.indexOf(q);
      if (i >= 0) s = 1000 - i * 4 - name.length * 0.2;
      else if (p.includes(q)) s = 500 - p.length * 0.05;
      else {
        // letters in order, fewer gaps first
        let k = 0, gaps = 0, last = -1;
        for (let j = 0; j < p.length && k < q.length; j++) if (p[j] === q[k]) { if (last >= 0) gaps += j - last - 1; last = j; k++; }
        if (k < q.length) return -1;
        s = 200 - gaps * 0.5;
      }
      return s + (path.startsWith('Project/') ? 50 : 0);
    };
    const pick = (i) => { const r = results[i]; if (!r) return; dlg.close(null); this.openFile(r.path); if (this.isNarrow()) this.showPane('editor'); };
    const render = () => {
      const q = input.value.trim().toLowerCase();
      results = q ? this.listing.map((x) => ({ path: x.path, s: score(x.path, q) })).filter((x) => x.s >= 0).sort((a, b) => b.s - a.s).slice(0, 60) : this.listing.filter((x) => x.modified).map((x) => ({ path: x.path })).slice(0, 60);
      sel = Math.min(sel, Math.max(0, results.length - 1));
      clear(list);
      if (!results.length) list.append(h('div', { class: 'muted small qo-empty' }, q ? 'No file matches.' : 'Type to search every file. Edited files are listed here.'));
      results.forEach((r, i) => {
        const slash = r.path.lastIndexOf('/');
        list.append(h('div', { class: 'qo-item' + (i === sel ? ' sel' : ''), role: 'option', 'aria-selected': String(i === sel), onmousedown: (e) => { e.preventDefault(); pick(i); } },
          h('span', { class: 'qo-name' }, r.path.slice(slash + 1)), h('span', { class: 'muted small qo-dir' }, r.path.slice(0, slash))));
      });
      list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    };
    input.addEventListener('input', () => { sel = 0; render(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); sel = Math.min(results.length - 1, sel + 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); sel = Math.max(0, sel - 1); render(); }
      else if (e.key === 'Enter') { e.preventDefault(); pick(sel); }
    });
    const dlg = modal({ title: 'Go to file', body: h('div', { class: 'qo' }, input, list), actions: [] });
    dlg.el.classList.add('wide');
    render();
  }

  openGallery() {
    let t = this.tabs.find('gallery');
    if (!t) {
      t = this.tabs.add({ id: 'gallery', kind: 'gallery', title: 'Images', icon: ['image', icons.image] });
      this.gallery = galleryView(this);
      this.tabs.setContent(t, { el: this.gallery.el, destroy: () => { this.gallery.destroy(); this.gallery = null; } });
    }
    this.tabs.activate(t.id);
    if (this.isNarrow()) this.showPane('editor');
  }

  // ---------------- play ----------------
  ensureGameTab() {
    let t = this.tabs.find('game');
    if (!t) {
      t = this.tabs.add({ id: 'game', kind: 'game', title: 'Game', icon: ['scene', icons.play] });
      this.game = new GameView(this);
      this.tabs.setContent(t, { el: this.game.el, destroy: () => { this.game.destroy(); this.game = null; } });
    }
    return t;
  }

  togglePlay() {
    if (this.game && this.game.running) { this.game.stop(); return; }
    this.play();
  }

  play() {
    if (!this.project || !this.project.runnable) {
      this.toast('This game has no web build that can run in the browser.');
      return;
    }
    const t = this.ensureGameTab();
    this.tabs.activate(t.id);
    if (this.isNarrow()) this.showPane('editor');
    this.game.start();
  }

  setRunning(on) {
    this.playBtn.classList.toggle('running', on);
    this.playBtn.querySelector('span').innerHTML = on ? icons.stop : icons.play;
    this.playBtn.querySelector('.tb-label').textContent = on ? 'Stop' : 'Play';
  }

  // ---------------- search ----------------
  buildSearch() {
    this.searchInput = h('input', { class: 'search-input', type: 'search', placeholder: 'Search in all text and source files', 'aria-label': 'Search text', id: 'search-text' });
    const regex = h('input', { type: 'checkbox', id: 'search-regex' });
    const cs = h('input', { type: 'checkbox', id: 'search-case' });
    const results = h('div', { class: 'search-results' });
    const run = async () => {
      const q = this.searchInput.value;
      clear(results);
      if (!q) return;
      results.appendChild(h('div', { class: 'insp-empty' }, 'Searching…'));
      const r = await this.engine.call('search', { query: q, regex: regex.checked, caseSensitive: cs.checked });
      clear(results);
      if (r.error) { results.appendChild(h('div', { class: 'insp-empty' }, r.error)); return; }
      if (!r.results.length) { results.appendChild(h('div', { class: 'insp-empty' }, `No matches in ${r.scanned.toLocaleString()} files.`)); return; }
      results.appendChild(h('div', { class: 'insp-empty', style: { padding: '6px 12px' } }, `${r.matches.toLocaleString()} matches in ${r.results.length.toLocaleString()} files${r.truncated ? ' (stopped early)' : ''}`));
      for (const f of r.results) {
        results.appendChild(h('div', { class: 'sr-file', onclick: () => this.openFile(f.path) }, h('span', null, basename(f.path)), h('span', { class: 'muted mono', style: { fontWeight: 400, fontSize: '11px' } }, f.path)));
        for (const hit of f.hits) {
          const before = hit.text.slice(0, hit.col), mid = hit.text.slice(hit.col, hit.col + hit.len), after = hit.text.slice(hit.col + hit.len);
          results.appendChild(h('div', { class: 'sr-hit', onclick: () => this.openFile(f.path, { line: hit.line, col: hit.col, len: hit.len }) },
            h('span', { class: 'muted' }, String(hit.line).padStart(5) + '  '), before.trimStart().slice(-80), h('mark', null, mid), after.slice(0, 120)));
        }
      }
    };
    this.searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    return h('div', { class: 'search-panel' },
      h('div', { class: 'panel-tools' }, this.searchInput,
        h('label', { class: 'muted', style: { fontSize: '12px', display: 'flex', gap: '4px', alignItems: 'center' } }, regex, 'Regex'),
        h('label', { class: 'muted', style: { fontSize: '12px', display: 'flex', gap: '4px', alignItems: 'center' } }, cs, 'Match case'),
        h('button', { class: 'btn sm', onclick: run }, 'Search')),
      results);
  }

  // ---------------- Ask Claude ----------------
  async askAI(tab) {
    const sample = await getSample();
    const code = tab.editor ? tab.editor.getText() : '';
    const sel = tab.editor ? tab.editor.view.state.sliceDoc(tab.editor.view.state.selection.main.from, tab.editor.view.state.selection.main.to) : '';
    const snippet = (sel || code).slice(0, 60000);
    const engineName = this.mainEngineLabel();
    const out = h('div', { class: 'ai-out', hidden: true });
    const question = h('textarea', { rows: '2', placeholder: 'Optional: ask something specific about this code', id: 'ai-question' });
    let ctl = null;
    let lastText = '';
    const ask = async (mode) => {
      if (!sample) return;
      ctl = new AbortController();
      out.hidden = false;
      out.textContent = 'Thinking…';
      const what = sel ? 'the selected part of' : '';
      const instructions = {
        explain: `Explain what ${what} this code does in plain language: the game logic, important functions and data, and anything notable for someone modding the game. Be concise and use short paragraphs or bullets.`,
        clean: `Rewrite ${what} this decompiled or minified code as clean, readable source in the same language: meaningful names for obfuscated or generated identifiers, normal control flow instead of gotos where obvious, and brief comments. Keep behaviour identical. Reply with only the code, no explanations or markdown fences.`,
        ask: question.value.trim() || 'What does this code do?',
      }[mode];
      const prompt = `You are helping a game modder understand code recovered from a ${engineName} game by a decompiler.\nFile: ${tab.path}\n\n${instructions}\n\n--- CODE START ---\n${snippet}\n--- CODE END ---`;
      try {
        const r = await askClaude(prompt, { signal: ctl.signal, onText: ({ text }) => { out.textContent = text; lastText = text; } });
        lastText = r.text;
        out.textContent = r.text + (r.truncated ? '\n\n[Answer cut short]' : '');
        applyBtn.hidden = mode !== 'clean';
      } catch (e) {
        out.textContent = (e.partial ? e.partial + '\n\n' : '') + e.message;
      }
    };
    const applyBtn = h('button', { class: 'btn', hidden: true, onclick: () => { tab.editor.setText(lastText.replace(/^```\w*\n|```\s*$/g, '')); this.toast('Applied to the editor. Save to keep it.'); } }, 'Replace editor text');
    modal({
      title: 'Ask Claude about this code',
      body: h('div', { style: { display: 'grid', gap: '10px' } },
        sample ? h('p', null, sel ? 'Claude will look at your selection.' : `Claude will look at this file (${Math.round(snippet.length / 1000)}k characters).`)
          : h('p', null, 'Ask Claude is not available in this view. Open the artifact on claude.ai to use it.'),
        sample ? h('div', { class: 'insp-actions' },
          h('button', { class: 'btn', onclick: () => ask('explain') }, 'Explain it'),
          h('button', { class: 'btn', onclick: () => ask('clean') }, 'Rewrite as readable code'),
          h('button', { class: 'btn ghost', onclick: () => ctl && ctl.abort() }, 'Stop')) : null,
        sample ? question : null,
        sample ? h('div', null, h('button', { class: 'btn sm', onclick: () => ask('ask') }, 'Ask')) : null,
        out, applyBtn),
      actions: [{ label: 'Close', value: null }],
      onClose: () => ctl && ctl.abort(),
    });
  }
}

const app = new App();
window.__resourcefy = app;
app.boot();
