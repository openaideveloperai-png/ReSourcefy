// Image, audio, video and font viewers.
import { h, icons, formatBytes } from '../dom.js';

// Buttons shared by replaceable media: Replace (pick a file), Revert, Download.
function mediaActions(file, { onReplace, onRevert, onDownload }, what) {
  return [
    onReplace ? h('button', { class: 'btn sm', onclick: onReplace, title: `Replace this ${what} with one from your computer (or drop a file here)` }, h('span', { html: icons.upload }), 'Replace') : null,
    onRevert ? h('button', { class: 'btn sm ghost', onclick: onRevert, title: 'Go back to the original' }, h('span', { html: icons.revert }), 'Revert') : null,
    onDownload ? h('button', { class: 'btn sm ghost', onclick: onDownload, title: `Download this ${what}` }, h('span', { html: icons.download })) : null,
  ];
}

// Dropping a matching file on the viewer replaces the asset.
function dropToReplace(el, accept, onReplaceWith) {
  if (!onReplaceWith) return;
  const ok = (e) => e.dataTransfer && [...(e.dataTransfer.types || [])].includes('Files');
  el.addEventListener('dragover', (e) => { if (!ok(e)) return; e.preventDefault(); e.stopPropagation(); el.classList.add('drop-target'); });
  el.addEventListener('dragleave', () => el.classList.remove('drop-target'));
  el.addEventListener('drop', (e) => {
    if (!ok(e)) return;
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drop-target');
    const f = [...e.dataTransfer.files].find((x) => accept.test(x.type || '') || accept.test(x.name));
    if (f) onReplaceWith(f);
  });
}

export function imageViewer(file, opts = {}) {
  const url = URL.createObjectURL(file.blob);
  const img = h('img', { src: url, alt: file.name, draggable: 'false' });
  const stage = h('div', { class: 'media-stage checker' }, img);
  const info = h('span', { class: 'muted num' }, '');
  let zoom = 1, natural = { w: 0, h: 0 }, fit = true;
  const apply = () => {
    if (!natural.w) return;
    let z = zoom;
    if (fit) {
      const bw = stage.clientWidth - 48, bh = stage.clientHeight - 48;
      z = Math.min(1, bw / natural.w, bh / natural.h);
      if (natural.w <= 64 && natural.h <= 64) z = Math.min(8, Math.floor(Math.min(bw / natural.w, bh / natural.h)) || 1);
    }
    img.style.width = Math.max(1, Math.round(natural.w * z)) + 'px';
    img.style.height = Math.max(1, Math.round(natural.h * z)) + 'px';
    img.classList.toggle('pixel', z >= 2);
    zl.textContent = Math.round(z * 100) + '%';
  };
  img.onload = () => {
    natural = { w: img.naturalWidth, h: img.naturalHeight };
    info.textContent = `${natural.w} × ${natural.h}  ·  ${formatBytes(file.size)}`;
    apply();
  };
  const zl = h('span', { class: 'muted num', style: { minWidth: '44px', textAlign: 'right' } }, '');
  const bar = h('div', { class: 'view-bar' },
    h('span', { class: 'path', title: file.path }, file.path),
    info,
    h('div', { class: 'seg' },
      h('button', { title: 'Zoom out', onclick: () => { fit = false; zoom = Math.max(0.05, zoom / 1.5); apply(); } }, '−'),
      h('button', { title: 'Fit to view', onclick: () => { fit = true; apply(); } }, 'Fit'),
      h('button', { title: 'Actual size', onclick: () => { fit = false; zoom = 1; apply(); } }, '1:1'),
      h('button', { title: 'Zoom in', onclick: () => { fit = false; zoom = Math.min(64, zoom * 1.5); apply(); } }, '+'),
    ),
    zl,
    ...mediaActions(file, opts, 'image'),
  );
  const body = h('div', { class: 'view-body' }, stage);
  dropToReplace(body, /^image\/|\.(png|jpe?g|gif|webp|bmp|avif)$/i, opts.onReplaceWith);
  stage.addEventListener('wheel', (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    fit = false;
    zoom = Math.max(0.05, Math.min(64, zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15)));
    apply();
  }, { passive: false });
  const ro = new ResizeObserver(() => fit && apply());
  ro.observe(body);
  const note = file.note ? h('div', { class: 'view-note' }, file.note) : null;
  return { el: [bar, note, body].filter(Boolean), destroy() { ro.disconnect(); URL.revokeObjectURL(url); } };
}

export function audioViewer(file, opts = {}) {
  const url = URL.createObjectURL(file.blob);
  const audio = h('audio', { controls: true, src: url, preload: 'metadata' });
  const canvas = h('canvas', { width: 1100, height: 192, 'aria-label': 'Waveform' });
  const meta = h('div', { class: 'muted num' }, formatBytes(file.size));
  const card = h('div', { class: 'audio-card' }, h('div', { style: { fontWeight: 600 } }, file.name), canvas, audio, meta);
  const bar = h('div', { class: 'view-bar' }, h('span', { class: 'path', title: file.path }, file.path), ...mediaActions(file, opts, 'sound'));
  dropToReplace(card, /^audio\/|\.(ogg|mp3|wav|m4a|aac|flac|opus)$/i, opts.onReplaceWith);
  (async () => {
    try {
      const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!Ctx) return;
      const ac = new Ctx(1, 1, 44100);
      const buf = await ac.decodeAudioData(await file.blob.arrayBuffer());
      meta.textContent = `${buf.duration.toFixed(2)} s · ${buf.sampleRate} Hz · ${buf.numberOfChannels} ch · ${formatBytes(file.size)}`;
      const data = buf.getChannelData(0);
      const g = canvas.getContext('2d');
      const W = canvas.width, H = canvas.height;
      const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#3fd3c1';
      g.clearRect(0, 0, W, H);
      g.fillStyle = accent;
      const step = Math.max(1, Math.floor(data.length / W));
      for (let x = 0; x < W; x++) {
        let min = 1, max = -1;
        for (let i = x * step, e = Math.min(data.length, i + step); i < e; i++) { const v = data[i]; if (v < min) min = v; if (v > max) max = v; }
        const y1 = ((1 - max) / 2) * H, y2 = ((1 - min) / 2) * H;
        g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
      }
    } catch {
      meta.textContent += ' · waveform unavailable for this format';
    }
  })();
  const note = file.note ? h('div', { class: 'view-note' }, file.note) : null;
  return { el: [bar, note, h('div', { class: 'view-body' }, h('div', { class: 'media-stage' }, card))].filter(Boolean), destroy() { audio.pause(); URL.revokeObjectURL(url); } };
}

export function videoViewer(file) {
  const url = URL.createObjectURL(file.blob);
  const v = h('video', { controls: true, src: url, style: { maxWidth: '100%', maxHeight: '100%' } });
  return { el: [h('div', { class: 'view-bar' }, h('span', { class: 'path' }, file.path)), h('div', { class: 'view-body' }, h('div', { class: 'media-stage' }, v))], destroy() { v.pause(); URL.revokeObjectURL(url); } };
}

let fontSeq = 0;
export function fontViewer(file) {
  const fam = 'rsf-font-' + (++fontSeq);
  const body = h('div', { class: 'font-sample' });
  const bar = h('div', { class: 'view-bar' }, h('span', { class: 'path' }, file.path));
  (async () => {
    try {
      const ff = new FontFace(fam, await file.blob.arrayBuffer());
      await ff.load();
      document.fonts.add(ff);
      for (const [size, text] of [[48, file.name.replace(/\.[^.]+$/, '')], [32, 'The quick brown fox jumps over the lazy dog'], [20, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ abcdefghijklmnopqrstuvwxyz 0123456789 !?&@#'], [14, 'Sphinx of black quartz, judge my vow. 1234567890']]) {
        body.appendChild(h('div', { class: 'l', style: { fontFamily: `"${fam}"`, fontSize: size + 'px' } }, text));
      }
    } catch (e) {
      body.appendChild(h('div', { class: 'muted' }, 'This font could not be loaded for preview: ' + e.message));
    }
  })();
  return { el: [bar, h('div', { class: 'view-body' }, body)], destroy() {} };
}
