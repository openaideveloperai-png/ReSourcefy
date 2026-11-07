// Virtualized hex viewer; pages bytes from the engine 64 KB at a time.
import { h, clear, formatBytes } from '../dom.js';

const ROW_H = 20, PER_ROW = 16, PAGE = 65536;

export function hexViewer(file, { readRange, onOpenText, actions = [] }) {
  const size = file.size || 0;
  const rows = Math.ceil(size / PER_ROW);
  const pages = new Map();
  const inner = h('div', { class: 'hex', style: { height: rows * ROW_H + 'px', position: 'relative' } });
  const body = h('div', { class: 'view-body' }, inner);
  const gotoInput = h('input', { class: 'search-input', style: { maxWidth: '130px' }, placeholder: 'Go to offset', 'aria-label': 'Go to offset' });
  gotoInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const v = gotoInput.value.trim();
    const off = /^0x/i.test(v) ? parseInt(v, 16) : parseInt(v, 10);
    if (Number.isFinite(off)) body.scrollTop = Math.floor(off / PER_ROW) * ROW_H;
  });
  const bar = h('div', { class: 'view-bar' },
    h('span', { class: 'path', title: file.path }, file.path),
    h('span', { class: 'muted num' }, `${file.label || 'Binary'} · ${formatBytes(size)}`),
    gotoInput,
    onOpenText ? h('button', { class: 'btn sm', onclick: onOpenText }, 'Open as text') : null,
    ...actions,
  );
  const hexByte = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, '0'));
  let painting = false, pendingPaint = false;
  async function page(n) {
    if (pages.has(n)) return pages.get(n);
    const p = readRange(n * PAGE, Math.min(size, (n + 1) * PAGE)).then((b) => { pages.set(n, b); return b; });
    pages.set(n, p);
    return p;
  }
  async function paint() {
    if (painting) { pendingPaint = true; return; }
    painting = true;
    const top = body.scrollTop, height = body.clientHeight || 600;
    const first = Math.max(0, Math.floor(top / ROW_H) - 4);
    const last = Math.min(rows, Math.ceil((top + height) / ROW_H) + 4);
    const startByte = first * PER_ROW, endByte = Math.min(size, last * PER_ROW);
    const firstPage = Math.floor(startByte / PAGE), lastPage = Math.floor(Math.max(startByte, endByte - 1) / PAGE);
    const bufs = [];
    try {
      for (let p = firstPage; p <= lastPage; p++) bufs.push(await page(p));
    } catch (e) {
      clear(inner).appendChild(h('div', { class: 'insp-empty' }, 'Could not read this file: ' + e.message));
      painting = false;
      return;
    }
    const byteAt = (i) => { const p = Math.floor(i / PAGE) - firstPage; const b = bufs[p]; return b ? b[i % PAGE] : undefined; };
    const frag = document.createDocumentFragment();
    for (let r = first; r < last; r++) {
      const off = r * PER_ROW;
      let hx = '', asc = '';
      for (let i = 0; i < PER_ROW; i++) {
        const b = off + i < size ? byteAt(off + i) : undefined;
        hx += b === undefined ? '   ' : hexByte[b] + ' ';
        if (i === 7) hx += ' ';
        asc += b === undefined ? ' ' : b >= 32 && b < 127 ? String.fromCharCode(b) : '·';
      }
      frag.appendChild(h('div', { class: 'hex-row', style: { position: 'absolute', top: r * ROW_H + 'px', left: 0, right: 0 } },
        h('span', { class: 'hex-off' }, off.toString(16).padStart(8, '0')),
        h('span', { class: 'hex-bytes' }, hx),
        h('span', { class: 'hex-ascii' }, asc)));
    }
    clear(inner).appendChild(frag);
    painting = false;
    if (pendingPaint) { pendingPaint = false; paint(); }
  }
  body.addEventListener('scroll', () => paint());
  const ro = new ResizeObserver(() => paint());
  ro.observe(body);
  if (!size) inner.appendChild(h('div', { class: 'insp-empty' }, 'This file is empty.'));
  return { el: [bar, body], destroy() { ro.disconnect(); } };
}
