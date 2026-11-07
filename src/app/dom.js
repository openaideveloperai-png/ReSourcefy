// Tiny DOM helpers, icons and formatting used across the UI.

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  append(el, children);
  return el;
}

function append(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else if (c instanceof Node) el.appendChild(c);
    else el.appendChild(document.createTextNode(String(c)));
  }
}

export function clear(el) { while (el.firstChild) el.removeChild(el.firstChild); return el; }

export function svg(markup, cls = '') {
  const t = document.createElement('template');
  t.innerHTML = markup.trim();
  const s = t.content.firstChild;
  if (cls) s.setAttribute('class', cls);
  return s;
}

const I = (d, extra = '') => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" ${extra}>${d}</svg>`;

export const icons = {
  chevron: I('<path d="M6 4l4 4-4 4"/>'),
  folder: I('<path d="M1.5 4.5v8a1 1 0 0 0 1 1h11a1 1 0 0 0 1-1v-6.5a1 1 0 0 0-1-1H8L6.5 3.5h-4a1 1 0 0 0-1 1z"/>'),
  folderOpen: I('<path d="M1.5 12.5v-8a1 1 0 0 1 1-1h4L8 5h5.5a1 1 0 0 1 1 1v1"/><path d="M1.5 12.5l2-5h11.5l-2 5z"/>'),
  file: I('<path d="M4 1.5h5l3.5 3.5v9.5H4z"/><path d="M9 1.5V5h3.5"/>'),
  code: I('<path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/>'),
  image: I('<rect x="2" y="2.5" width="12" height="11" rx="1.5"/><circle cx="6" cy="6.5" r="1.3"/><path d="M2.5 12l3.5-3.5 2.5 2.5 2-2 3 3"/>'),
  audio: I('<path d="M6 11.5V3.5l7-1.5v8"/><circle cx="4.5" cy="11.5" r="1.8"/><circle cx="11.5" cy="10" r="1.8"/>'),
  video: I('<rect x="1.5" y="3.5" width="9.5" height="9" rx="1.2"/><path d="M11 7l3.5-2v6L11 9"/>'),
  model: I('<path d="M8 1.5l5.5 3v7L8 14.5l-5.5-3v-7z"/><path d="M2.5 4.5L8 7.5l5.5-3M8 7.5v7"/>'),
  font: I('<path d="M3 13L7 3h2l4 10M4.6 9.5h6.8"/>'),
  archive: I('<rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M7 2v2h2v2H7v2h2v2H7"/>'),
  binary: I('<rect x="2" y="2" width="12" height="12" rx="1.5"/><path d="M5 5.5v5M8 5.5h2v5H8zM11.5 5.5v5" /> '),
  exe: I('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5"/><path d="M1.5 5.5h13M4.5 8.5l2 1.5-2 1.5M8 11.5h3"/>'),
  scene: I('<path d="M8 1.5l6 3.5v6L8 14.5 2 11V5z"/><circle cx="8" cy="8" r="2"/>'),
  data: I('<ellipse cx="8" cy="3.5" rx="5.5" ry="2"/><path d="M2.5 3.5v9c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2v-9M2.5 8c0 1.1 2.5 2 5.5 2s5.5-.9 5.5-2"/>'),
  play: I('<path d="M4.5 2.5v11l9-5.5z" fill="currentColor"/>'),
  stop: I('<rect x="3.5" y="3.5" width="9" height="9" rx="1" fill="currentColor"/>'),
  rebuild: I('<path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3"/>'),
  download: I('<path d="M8 2v8.5M4.5 7.5L8 11l3.5-3.5M2.5 13.5h11"/>'),
  upload: I('<path d="M8 11V2.5M4.5 6L8 2.5 11.5 6M2.5 13.5h11"/>'),
  close: I('<path d="M3 3l10 10M13 3L3 13"/>'),
  search: I('<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5L14 14"/>'),
  spark: I('<path d="M8 1.5l1.4 4.1 4.1 1.4-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4z"/><path d="M13 11.5l.6 1.4 1.4.6-1.4.6-.6 1.4-.6-1.4-1.4-.6 1.4-.6z"/>'),
  expand: I('<path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10"/>'),
  info: I('<circle cx="8" cy="8" r="6.5"/><path d="M8 7.2v4M8 4.8v.1"/>'),
  revert: I('<path d="M3 6.5h7a3.5 3.5 0 0 1 0 7H6"/><path d="M5.5 4L3 6.5 5.5 9"/>'),
  copy: I('<rect x="5" y="5" width="8.5" height="8.5" rx="1.2"/><path d="M3.5 10.5h-.5a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1h6.5a1 1 0 0 1 1 1v.5"/>'),
  format: I('<path d="M2.5 3.5h11M2.5 6.5h7M4.5 9.5h9M2.5 12.5h7"/>'),
  node: I('<circle cx="8" cy="8" r="2.5"/><path d="M8 1.5v4M8 10.5v4M1.5 8h4M10.5 8h4"/>'),
  plus: I('<path d="M8 3v10M3 8h10"/>'),
  mute: I('<path d="M2.5 6h2.5L8.5 3v10L5 10H2.5zM11 6l3 4M14 6l-3 4"/>'),
  sound: I('<path d="M2.5 6h2.5L8.5 3v10L5 10H2.5zM11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.8a6 6 0 0 1 0 8.4"/>'),
  logo: `<svg viewBox="0 0 24 24" aria-hidden="true" class="brand-mark"><rect x="2" y="2" width="20" height="20" rx="5" fill="none" stroke="var(--accent)" stroke-width="2"/><path d="M8 8.5L5 12l3 3.5M16 8.5l3 3.5-3 3.5" fill="none" stroke="var(--fg)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M13.2 7l-2.4 10" stroke="var(--accent)" stroke-width="2" stroke-linecap="round"/></svg>`,
};

export function iconFor(item) {
  if (item.dir) return ['folder', icons.folder];
  const v = item.view, k = item.kind || '';
  if (/^(zip|pck|pak|rpa|rgssad|xp3|asar|unityweb|unitybundle|7z|rar|tar|gzip|brotli|zstd|lz4|vpk|wad|bsa|defold|utoc|ucas|quakepak)$/.test(k)) return ['archive', icons.archive];
  if (/^(pe|elf|macho)$/.test(k)) return ['exe', icons.exe];
  if (/scene|tscn|unity-scene|room|map/.test(k)) return ['scene', icons.scene];
  if (/^(unityassets|godot-binary|gmdata|il2cpp-metadata|rubymarshal|uasset|uexp|data)$/.test(k)) return ['data', icons.data];
  if (v === 'code') return ['code', icons.code];
  if (v === 'image') return ['image', icons.image];
  if (v === 'audio') return ['audio', icons.audio];
  if (v === 'video') return ['video', icons.video];
  if (v === 'model') return ['model', icons.model];
  if (v === 'font') return ['font', icons.font];
  if (k === 'wasm' || k === 'jvmclass' || k === 'luac' || k === 'gdscript-bytecode' || k === 'pyc') return ['code', icons.binary];
  return ['binary', icons.file];
}

export function formatBytes(n) {
  if (n == null) return '';
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(n < 10240 ? 1 : 0) + ' KB';
  if (n < 1073741824) return (n / 1048576).toFixed(1) + ' MB';
  return (n / 1073741824).toFixed(2) + ' GB';
}

export function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

export function basename(p) { return p.slice(p.lastIndexOf('/') + 1); }
export function dirname(p) { const i = p.lastIndexOf('/'); return i < 0 ? '' : p.slice(0, i); }

const toastHost = () => document.querySelector('.toast-host') || document.body.appendChild(h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' }));
export function toast(msg, { error = false, ms = 3800 } = {}) {
  const t = h('div', { class: 'toast' + (error ? ' error' : '') }, msg);
  toastHost().appendChild(t);
  setTimeout(() => t.remove(), ms);
}

// In-page confirm/prompt (the artifact viewer blocks native dialogs).
export function modal({ title, body, actions = [], onClose }) {
  const back = h('div', { class: 'modal-back' });
  const close = (v) => { back.remove(); document.removeEventListener('keydown', onKey); onClose && onClose(v); };
  const onKey = (e) => { if (e.key === 'Escape') close(null); };
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('h3', null, title),
    body,
    h('div', { class: 'row' }, actions.map((a) => h('button', { class: 'btn ' + (a.primary ? 'primary' : ''), onclick: () => { const r = a.run ? a.run() : a.value; if (r !== false) close(r ?? a.value); } }, a.label))),
  );
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(null); });
  document.addEventListener('keydown', onKey);
  back.appendChild(box);
  document.body.appendChild(back);
  const first = box.querySelector('input,textarea,button.primary');
  first && setTimeout(() => first.focus(), 30);
  return { close, el: box };
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
    return true;
  } catch {
    const ta = h('textarea', { style: { position: 'fixed', opacity: '0' } }, text);
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch { /* ignore */ }
    ta.remove();
    toast(ok ? 'Copied to clipboard' : 'Copy failed: select the text and copy it manually', { error: !ok });
    return ok;
  }
}
