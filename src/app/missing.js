// Files a game needs that weren't uploaded (usually its StreamingAssets folder): where to get
// them from the game's website, and where to put them when they're added.
import { h, clear, copyText, modal } from './dom.js';
import { pickFiles } from './ingest.js';

const ITCH_HTML = 'https://html-classic.itch.zone/html/';

// The folder a web game is served from, from whatever address the user pastes:
// an itch.io upload number, the game frame's address, or the URL of any file of the game.
export function gameBase(input) {
  let s = String(input || '').trim();
  if (!s) return null;
  if (/^\d{4,}$/.test(s)) return { base: `${ITCH_HTML}${s}/`, referer: `${ITCH_HTML}${s}/index.html` };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;
  let u;
  try { u = new URL(s); } catch { return { error: 'That doesn’t look like a web address.' }; }
  if (!/^https?:$/.test(u.protocol)) return { error: 'Use the game’s http(s) address.' };
  if (/(^|\.)itch\.io$/i.test(u.hostname)) {
    return { error: 'That’s the game’s itch.io page. Start the game there, right-click it, choose “Open frame in new tab” (in Firefox: “This Frame → Open Frame in New Tab”), and paste the address of that tab. It starts with https://html-classic.itch.zone/html/.' };
  }
  let path = u.pathname;
  const build = path.search(/\/Build\//i);
  if (build >= 0) path = path.slice(0, build + 1);
  else if (/\/[^/]+\.[a-z0-9]+$/i.test(path)) path = path.slice(0, path.lastIndexOf('/') + 1);
  else if (!path.endsWith('/')) path += '/';
  const base = u.origin + path;
  return { base, referer: build >= 0 || !/\.html?$/i.test(u.pathname) ? base + 'index.html' : u.origin + u.pathname };
}

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');

export function downloadCommands(base, referer, paths, windows) {
  const q = (x) => '"' + x.replace(/"/g, '') + '"';
  const curl = windows ? 'curl.exe' : 'curl';
  return paths.map((p) => `${curl} -fL --create-dirs -e ${q(referer)} -o ${q(p)} ${q(base + encodePath(p))}`).join(windows ? '\r\n' : '\n');
}

// Where added files go. Paths containing a StreamingAssets folder keep their place below it;
// other files are matched against the missing list by the end of their path.
export function placeFiles(files, root, missing, defaultDir = '') {
  const lowerMissing = missing.map((m) => [m.toLowerCase(), m]);
  const anySA = files.some((f) => /(^|\/)StreamingAssets\//i.test(f.path));
  const out = [];
  for (const f of files) {
    const rel = String(f.path).replace(/\\/g, '/').replace(/^\/+/, '');
    const m = /(^|\/)(StreamingAssets\/.*)$/i.exec(rel);
    if (m) { out.push({ path: root + 'StreamingAssets/' + m[2].slice('StreamingAssets/'.length), blob: f.blob }); continue; }
    const parts = rel.split('/');
    let target = null;
    for (let k = 0; k < parts.length && !target; k++) {
      const tail = parts.slice(k).join('/').toLowerCase();
      const hit = lowerMissing.find(([lm]) => lm === tail || lm.endsWith('/' + tail));
      if (hit) target = hit[1];
    }
    if (target) out.push({ path: root + target, blob: f.blob });
    else if (!anySA) out.push({ path: root + defaultDir + rel, blob: f.blob });
  }
  return out;
}

// The dialog: what's missing, how to download it, and buttons to add it.
export function showMissingDialog(app, items, { root, onAdded } = {}) {
  const paths = items.map((m) => m.path);
  const list = h('div', { class: 'missing-list' }, items.map((m) => h('div', null, h('code', null, m.path), m.why ? h('span', { class: 'muted' }, ' · ' + m.why) : null)));
  const out = h('div', { class: 'missing-out' });
  const input = h('input', { type: 'text', class: 'text-input', placeholder: 'https://html-classic.itch.zone/html/1234567/index.html', spellcheck: 'false', 'aria-label': 'Game address' });
  const render = () => {
    clear(out);
    const r = gameBase(input.value);
    if (!r) return;
    if (r.error) { out.append(h('p', { class: 'warn-text' }, r.error)); return; }
    const block = (label, text) => {
      const ta = h('textarea', { class: 'cmd', readonly: true, rows: String(Math.min(6, paths.length + 1)), spellcheck: 'false' }, text);
      return h('div', { class: 'cmd-block' }, h('div', { class: 'cmd-head' }, h('span', null, label), h('button', { class: 'btn sm', onclick: () => copyText(text) }, 'Copy')), ta);
    };
    out.append(
      h('p', null, 'Run one of these in a terminal, in an empty folder. It creates a ', h('code', null, 'StreamingAssets'), ' folder there; add that folder below.'),
      block('Windows (Command Prompt or PowerShell)', downloadCommands(r.base, r.referer, paths, true)),
      block('macOS / Linux (Terminal)', downloadCommands(r.base, r.referer, paths, false)),
      h('details', null, h('summary', null, 'Or open each file in the browser'),
        h('div', { class: 'missing-links' }, paths.map((p) => h('a', { href: r.base + encodePath(p), target: '_blank', rel: 'noopener noreferrer' }, p)))),
    );
  };
  input.addEventListener('input', render);
  const add = async (directory) => {
    const files = await pickFiles({ directory });
    if (!files.length) return;
    dlg.close(true);
    const placed = placeFiles(files, root ?? app.webRoot(), paths, 'StreamingAssets/');
    if (!placed.length) { app.toast('None of those files belong to the missing list.', { error: true }); return; }
    await app.addFiles(placed, { play: !!(app.project && app.project.runnable) });
    if (onAdded) onAdded();
  };
  const body = h('div', { class: 'missing-dialog' },
    h('p', null, `The game loads ${items.length === 1 ? 'a file that wasn’t' : items.length + ' files that weren’t'} in your upload. Unity games keep these in a StreamingAssets folder next to the Build folder.`),
    list,
    h('h4', null, 'Get them from the game’s website'),
    h('p', null, 'ReSourcefy can’t download them itself: this page isn’t allowed to connect to other websites. Paste the address the game runs from (or an itch.io upload number) to get download commands.'),
    input,
    h('p', { class: 'muted small' }, 'On itch.io: start the game, right-click it, choose “Open frame in new tab”, and copy that tab’s address.'),
    out,
    h('h4', null, 'Add them'),
    h('div', { class: 'row start' },
      h('button', { class: 'btn', onclick: () => add(true) }, 'Add folder…'),
      h('button', { class: 'btn', onclick: () => add(false) }, 'Add files…')),
    h('p', { class: 'muted small' }, 'You can also drop the StreamingAssets folder anywhere on this page. Some files only show up once the game has loaded the ones before them; add what you have, press Play, and repeat if more appear.'),
  );
  const dlg = modal({ title: 'Missing files', body, actions: [{ label: 'Close', value: null }] });
  dlg.el.classList.add('wide');
  return dlg;
}
