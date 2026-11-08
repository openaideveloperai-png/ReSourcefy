// Gallery: every picture in the game as a thumbnail. Click one to open it; drop an image file
// on one to replace it.
import { h, clear, icons, debounce } from './dom.js';

const NATIVE = /^(png|jpeg|gif|webp|bmp|ico|avif)$/;
const PAGE = 400;

export function galleryView(app) {
  const filter = h('input', { class: 'search-input', type: 'search', placeholder: 'Filter images', 'aria-label': 'Filter images' });
  const editedOnly = h('input', { type: 'checkbox', 'aria-label': 'Only edited images' });
  const count = h('span', { class: 'muted num' }, '');
  const grid = h('div', { class: 'gallery-grid' });
  const more = h('button', { class: 'btn sm', hidden: true }, 'Show more');
  const empty = h('div', { class: 'insp-empty', hidden: true }, 'No pictures match.');
  const downloadAll = h('button', { class: 'btn sm', title: 'Download the listed pictures as a zip' }, h('span', { html: icons.download }), 'Download');
  const bar = h('div', { class: 'view-bar gallery-bar' },
    h('span', { class: 'path' }, 'Images'), count, filter,
    h('label', { class: 'check' }, editedOnly, 'Edited'),
    downloadAll);
  const body = h('div', { class: 'view-body gallery-body' }, grid, empty, h('div', { class: 'gallery-more' }, more));
  const urls = new Set();
  let items = [], shown = 0;

  // thumbnails load as tiles scroll into view, a few at a time
  const queue = [];
  let busy = 0;
  const pump = async () => {
    if (busy >= 2 || !queue.length) return;
    const batch = queue.splice(0, 12);
    busy++;
    try {
      const res = await app.engine.call('thumbs', { paths: batch.map((t) => t.dataset.path), size: 160 });
      for (const tile of batch) {
        const r = res[tile.dataset.path];
        const img = tile.querySelector('img');
        if (r && r.blob) {
          const u = URL.createObjectURL(r.blob);
          urls.add(u);
          img.src = u;
          if (r.width <= 64 && r.height <= 64) img.classList.add('pixel');
          tile.querySelector('.dims').textContent = `${r.width}×${r.height}`;
        } else {
          tile.classList.add('broken');
          if (r && r.error) tile.title = `${tile.dataset.path}\nNo preview: ${r.error}`;
        }
      }
    } catch { /* the engine restarted; tiles stay blank */ }
    busy--;
    pump();
  };
  const io = new IntersectionObserver((entries) => {
    for (const en of entries) {
      if (!en.isIntersecting) continue;
      io.unobserve(en.target);
      queue.push(en.target);
    }
    pump();
  }, { root: body, rootMargin: '300px' });

  const replaceable = (it) => !it.readonly && NATIVE.test(it.kind || '') && it.path.startsWith('Project/');
  const tileFor = (it) => {
    const name = it.path.slice(it.path.lastIndexOf('/') + 1);
    const tile = h('button', { class: 'gallery-tile' + (it.modified ? ' modified' : ''), title: it.path, 'data-path': it.path, onclick: () => app.openFile(it.path) },
      h('div', { class: 'thumb checker' }, h('img', { alt: '', draggable: 'false' })),
      h('div', { class: 'name' }, name),
      h('div', { class: 'muted small dims' }, ''));
    if (replaceable(it)) {
      const ok = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
      tile.addEventListener('dragover', (e) => { if (!ok(e)) return; e.preventDefault(); e.stopPropagation(); tile.classList.add('drop-target'); });
      tile.addEventListener('dragleave', () => tile.classList.remove('drop-target'));
      tile.addEventListener('drop', async (e) => {
        if (!ok(e)) return;
        e.preventDefault();
        e.stopPropagation();
        tile.classList.remove('drop-target');
        const f = [...e.dataTransfer.files].find((x) => /^image\//.test(x.type) || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(x.name));
        if (!f) return;
        await app.writeFile(it.path, await f.arrayBuffer());
        it.modified = true;
        tile.classList.add('modified');
        queue.push(tile);
        pump();
        app.toast(`Replaced ${name}. Press Play to see it in the game.`);
      });
    } else tile.classList.add('locked');
    io.observe(tile);
    return tile;
  };

  const showMore = () => {
    const frag = document.createDocumentFragment();
    for (const it of items.slice(shown, shown + PAGE)) frag.appendChild(tileFor(it));
    grid.appendChild(frag);
    shown = Math.min(items.length, shown + PAGE);
    more.hidden = shown >= items.length;
    more.textContent = `Show more (${(items.length - shown).toLocaleString()} left)`;
  };
  more.onclick = showMore;

  const render = () => {
    io.disconnect();
    queue.length = 0;
    for (const u of urls) URL.revokeObjectURL(u);
    urls.clear();
    clear(grid);
    const listing = app.listing || [];
    let pics = listing.filter((x) => x.view === 'image' && x.path.startsWith('Project/'));
    if (!pics.length) pics = listing.filter((x) => x.view === 'image');
    const q = filter.value.trim().toLowerCase();
    items = pics.filter((x) => (!q || x.path.toLowerCase().includes(q)) && (!editedOnly.checked || x.modified))
      .sort((a, b) => a.path.localeCompare(b.path));
    count.textContent = `${items.length.toLocaleString()} of ${pics.length.toLocaleString()}`;
    empty.hidden = items.length > 0;
    shown = 0;
    showMore();
  };
  filter.addEventListener('input', debounce(render, 150));
  editedOnly.addEventListener('change', render);
  downloadAll.onclick = () => {
    if (!items.length) return;
    app.exportPaths(items.map((x) => x.path), `${(app.project && app.project.name) || 'game'}-images`);
  };
  render();
  return {
    el: [bar, body],
    render,
    destroy() { io.disconnect(); for (const u of urls) URL.revokeObjectURL(u); },
  };
}
