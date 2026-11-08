// Game text: every string players see (UI labels, dialogue, settings in script data), in one
// editable table. Saving writes the changes into the objects that hold them.
import { h, clear, debounce } from './dom.js';

const PAGE = 500;

// set obj at "a.b[2].c" (or "[3]" for a top-level list)
function setPath(obj, field, value) {
  const keys = [...field.matchAll(/([^.[\]]+)|\[(\d+)\]/g)].map((m) => (m[2] != null ? Number(m[2]) : m[1]));
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    cur = cur[keys[i]];
    if (cur == null || typeof cur !== 'object') throw new Error(`${field} no longer exists`);
  }
  cur[keys[keys.length - 1]] = value;
}

export function textsView(app) {
  const filter = h('input', { class: 'search-input', type: 'search', placeholder: 'Filter text', 'aria-label': 'Filter text' });
  const code = h('input', { type: 'checkbox', 'aria-label': 'Include strings from the game code' });
  const count = h('span', { class: 'muted num' }, '');
  const saveBtn = h('button', { class: 'btn sm primary', disabled: true, onclick: () => save() }, 'Save');
  const bar = h('div', { class: 'view-bar texts-bar' }, h('span', { class: 'path' }, 'Game text'), count, filter,
    h('label', { class: 'check', title: 'Strings written in the game code (IL2CPP string literals)' }, code, 'Code strings'), saveBtn);
  const list = h('div', { class: 'texts-list' });
  const more = h('button', { class: 'btn sm', hidden: true }, 'Show more');
  const status = h('div', { class: 'insp-empty', hidden: true }, '');
  const body = h('div', { class: 'view-body texts-body' }, status, list, h('div', { class: 'gallery-more' }, more));
  let rows = [], items = [], shown = 0;
  const pending = new Map(); // row key -> { row, value }
  const keyOf = (r) => r.path + '|' + r.field;

  const updateSave = () => {
    saveBtn.disabled = !pending.size;
    saveBtn.textContent = pending.size ? `Save ${pending.size} change${pending.size === 1 ? '' : 's'}` : 'Save';
  };
  const rowEl = (r) => {
    const k = keyOf(r);
    const ta = h('textarea', { class: 'tx-value', rows: String(Math.min(6, r.value.split('\n').length)), spellcheck: 'true', 'aria-label': `${r.label} ${r.field}` }, pending.has(k) ? pending.get(k).value : r.value);
    const el = h('div', { class: 'tx-row' + (pending.has(k) ? ' changed' : ''), 'data-key': k },
      h('div', { class: 'tx-meta' },
        h('button', { class: 'linkish tx-label', title: r.path, onclick: () => app.openFile(r.path) }, r.label),
        h('span', { class: 'muted small tx-field' }, r.field)),
      ta);
    ta.addEventListener('input', () => {
      if (ta.value === r.value) pending.delete(k); else pending.set(k, { row: r, value: ta.value });
      el.classList.toggle('changed', pending.has(k));
      updateSave();
    });
    ta.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) { e.preventDefault(); e.stopPropagation(); save(); } });
    return el;
  };
  const showMore = () => {
    const frag = document.createDocumentFragment();
    for (const r of items.slice(shown, shown + PAGE)) frag.appendChild(rowEl(r));
    list.appendChild(frag);
    shown = Math.min(items.length, shown + PAGE);
    more.hidden = shown >= items.length;
    more.textContent = `Show more (${(items.length - shown).toLocaleString()} left)`;
  };
  more.onclick = showMore;
  const render = () => {
    clear(list);
    const q = filter.value.trim().toLowerCase();
    items = q ? rows.filter((r) => r.value.toLowerCase().includes(q) || r.label.toLowerCase().includes(q) || r.field.toLowerCase().includes(q)) : rows;
    count.textContent = `${items.length.toLocaleString()} of ${rows.length.toLocaleString()}`;
    status.hidden = rows.length > 0;
    shown = 0;
    showMore();
  };
  const load = async () => {
    status.hidden = false;
    status.textContent = 'Collecting text…';
    clear(list);
    try { rows = await app.engine.call('texts', { literals: code.checked }); } catch (e) { rows = []; status.textContent = 'Could not collect text: ' + e.message; return; }
    if (!rows.length) {
      status.textContent = 'No editable text was found. In Unity games, text lives in script data (MonoBehaviours), which needs the game code (WebAssembly or GameAssembly) next to the IL2CPP metadata. Text files themselves open from the Project tree.';
    }
    render();
  };
  const save = async () => {
    if (!pending.size) return;
    const byPath = new Map();
    for (const { row, value } of pending.values()) {
      if (!byPath.has(row.path)) byPath.set(row.path, []);
      byPath.get(row.path).push({ row, value });
    }
    saveBtn.disabled = true;
    let saved = 0;
    const failed = [];
    for (const [path, changes] of byPath) {
      try {
        const f = await app.engine.call('open', { path });
        const j = JSON.parse(f.text);
        for (const c of changes) setPath(j, c.row.field, c.value);
        await app.writeFile(path, JSON.stringify(j, null, path.endsWith('string-literals.json') ? 1 : 2));
        for (const c of changes) { c.row.value = c.value; pending.delete(keyOf(c.row)); saved++; }
      } catch (e) { failed.push(`${path.slice(path.lastIndexOf('/') + 1)}: ${e.message}`); }
    }
    for (const el of list.querySelectorAll('.tx-row.changed')) if (!pending.has(el.dataset.key)) el.classList.remove('changed');
    updateSave();
    if (failed.length) app.toast(`Some text could not be saved: ${failed.join('; ')}`, { error: true });
    else app.toast(`Saved ${saved} text change${saved === 1 ? '' : 's'}. Press Play to see them.`);
  };
  filter.addEventListener('input', debounce(render, 150));
  code.addEventListener('change', load);
  load();
  return { el: [bar, body], reload: load, destroy() {} };
}
