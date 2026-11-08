// Downloads the official Godot web runtimes ReSourcefy uses to play Godot games, into
// vendor/godot/<id>/. Only the needed entries are read from the (large) export template
// archives, using HTTP range requests.
//   node tools/fetch-godot-runtimes.mjs            download from GitHub releases
//   node tools/fetch-godot-runtimes.mjs --from DIR use already downloaded template zips:
//                                                  DIR/godot-<version>-<template file name>
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { unzipSync, gzipSync } from 'fflate';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'vendor/godot');
const RUNTIMES = [
  { id: 'godot-3.6', version: '3.6.2', template: 'templates/webassembly_release.zip' },
  { id: 'godot-4.4', version: '4.4.1', template: 'templates/web_nothreads_release.zip' },
  { id: 'godot-4.7', version: '4.7.2', template: 'templates/web_nothreads_release.zip' },
];
const KEEP = ['godot.js', 'godot.wasm', 'godot.audio.worklet.js', 'godot.audio.position.worklet.js'];

const args = process.argv.slice(2);
const from = args.includes('--from') ? args[args.indexOf('--from') + 1] : null;

async function range(url, start, end) {
  const r = await fetch(url, { headers: { Range: `bytes=${start}-${end}` }, redirect: 'follow' });
  if (!r.ok) throw new Error(`${r.status} for ${url}`);
  return new Uint8Array(await r.arrayBuffer());
}
async function size(url) {
  const r = await fetch(url, { method: 'HEAD', redirect: 'follow' });
  return +r.headers.get('content-length');
}

// one entry of a remote zip (zip64-aware), stored or deflated
async function remoteEntry(url, name) {
  const n = await size(url);
  const tail = await range(url, n - 70000, n - 1);
  const dv = new DataView(tail.buffer);
  let i = tail.length - 22;
  while (i >= 0 && dv.getUint32(i, true) !== 0x06054b50) i--;
  let cdSize = dv.getUint32(i + 12, true), cdOff = dv.getUint32(i + 16, true);
  if (cdOff === 0xffffffff) {
    let j = i;
    while (j >= 0 && dv.getUint32(j, true) !== 0x06064b50) j--;
    cdSize = Number(dv.getBigUint64(j + 40, true));
    cdOff = Number(dv.getBigUint64(j + 48, true));
  }
  const cd = await range(url, cdOff, cdOff + cdSize - 1);
  const cv = new DataView(cd.buffer);
  for (let p = 0; p + 46 <= cd.length && cv.getUint32(p, true) === 0x02014b50;) {
    const method = cv.getUint16(p + 10, true);
    let csize = cv.getUint32(p + 20, true), usize = cv.getUint32(p + 24, true);
    const nl = cv.getUint16(p + 28, true), el = cv.getUint16(p + 30, true), cl = cv.getUint16(p + 32, true);
    let off = cv.getUint32(p + 42, true);
    const ename = new TextDecoder().decode(cd.subarray(p + 46, p + 46 + nl));
    // zip64 extra field
    for (let q = p + 46 + nl; q < p + 46 + nl + el;) {
      const id = cv.getUint16(q, true), len = cv.getUint16(q + 2, true);
      if (id === 1) {
        let r = q + 4;
        if (usize === 0xffffffff) { usize = Number(cv.getBigUint64(r, true)); r += 8; }
        if (csize === 0xffffffff) { csize = Number(cv.getBigUint64(r, true)); r += 8; }
        if (off === 0xffffffff) { off = Number(cv.getBigUint64(r, true)); }
      }
      q += 4 + len;
    }
    if (ename === name) {
      const lh = await range(url, off, off + 29);
      const lv = new DataView(lh.buffer);
      const data = await range(url, off + 30 + lv.getUint16(26, true) + lv.getUint16(28, true), off + 30 + lv.getUint16(26, true) + lv.getUint16(28, true) + csize - 1);
      if (method === 0) return data;
      const { inflateSync } = await import('fflate');
      return inflateSync(data, { out: new Uint8Array(usize) });
    }
    p += 46 + nl + el + cl;
  }
  throw new Error(`${name} not found in ${url}`);
}

for (const rt of RUNTIMES) {
  const local = from && join(from, `godot-${rt.version}-${rt.template.split('/').pop()}`);
  let zip;
  if (local && existsSync(local)) zip = new Uint8Array(readFileSync(local));
  else {
    const url = `https://github.com/godotengine/godot/releases/download/${rt.version}-stable/Godot_v${rt.version}-stable_export_templates.tpz`;
    console.log(`Fetching ${rt.template} from Godot ${rt.version}…`);
    zip = await remoteEntry(url, rt.template);
  }
  const files = unzipSync(zip, { filter: (f) => KEEP.includes(f.name) });
  const dir = join(out, rt.id);
  mkdirSync(dir, { recursive: true });
  for (const [name, data] of Object.entries(files)) {
    // the wasm is stored gzip-compressed (served as .wasm, inflated by the player)
    if (name === 'godot.wasm') writeFileSync(join(dir, 'godot.gz.wasm'), gzipSync(data, { level: 9 }));
    else writeFileSync(join(dir, name), data);
  }
  writeFileSync(join(dir, 'VERSION.txt'), `Godot ${rt.version}-stable, ${rt.template}\n`);
  console.log(`${rt.id}: ${Object.keys(files).join(', ')}`);
}
// licenses
for (const f of ['LICENSE.txt', 'COPYRIGHT.txt']) {
  const r = await fetch(`https://raw.githubusercontent.com/godotengine/godot/4.7.2-stable/${f}`);
  if (r.ok) writeFileSync(join(out, f), new Uint8Array(await r.arrayBuffer()));
}
console.log('Godot runtimes are in vendor/godot');
