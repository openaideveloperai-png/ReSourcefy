// ZIP-family archives (zip, apk, ipa, jar, love, xapk, pk3, nupkg, package.nw ...).
// Reads the central directory and creates lazy entries: nothing is inflated
// until a file is opened or its first bytes are needed for type detection.
import { Inflate, inflateSync } from 'fflate';
import { Reader, utf8 } from '../util/binary.js';

const cp437 = (() => {
  try { return new TextDecoder('ibm437'); } catch { return null; }
})();

export async function readZipDirectory(blob) {
  const size = blob.size;
  const tailLen = Math.min(size, 65557 + 20);
  const tail = new Uint8Array(await blob.slice(size - tailLen).arrayBuffer());
  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip (no end of central directory)');
  const r = new Reader(tail, true, eocd);
  r.skip(4);
  r.u16(); r.u16();
  let count = r.u16();
  r.u16();
  let cdSize = r.u32();
  let cdOffset = r.u32();
  // ZIP64
  if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
    const locPos = eocd - 20;
    if (locPos >= 0 && tail[locPos] === 0x50 && tail[locPos + 1] === 0x4b && tail[locPos + 2] === 0x06 && tail[locPos + 3] === 0x07) {
      const lr = new Reader(tail, true, locPos + 8);
      const z64Off = lr.u64();
      const z64 = new Reader(new Uint8Array(await blob.slice(z64Off, z64Off + 56).arrayBuffer()));
      z64.skip(4 + 8 + 2 + 2 + 4 + 4);
      z64.u64();
      count = z64.u64();
      cdSize = z64.u64();
      cdOffset = z64.u64();
    }
  }
  // Self-extracting / prefixed archives (e.g. a fused LÖVE exe): central directory
  // offsets are relative to the start of the zip, which may sit after other data.
  let base = 0;
  const cdAbs = size - tailLen + eocd - cdSize;
  if (cdAbs !== cdOffset && cdAbs > cdOffset) base = cdAbs - cdOffset;
  const cd = new Reader(new Uint8Array(await blob.slice(base + cdOffset, base + cdOffset + cdSize).arrayBuffer()));
  const entries = [];
  for (let i = 0; i < count && cd.remaining >= 46; i++) {
    if (cd.u32() !== 0x02014b50) break;
    cd.u16(); cd.u16();
    const flags = cd.u16();
    const method = cd.u16();
    cd.u16(); cd.u16();
    const crc = cd.u32();
    let csize = cd.u32();
    let usize = cd.u32();
    const nlen = cd.u16(), xlen = cd.u16(), clen = cd.u16();
    cd.u16(); cd.u16(); cd.u32();
    let lho = cd.u32();
    const nameBytes = cd.bytes(nlen);
    const name = (flags & 0x800) || !cp437 ? utf8(nameBytes) : decodeName(nameBytes);
    const extra = cd.bytes(xlen);
    cd.skip(clen);
    if (usize === 0xffffffff || csize === 0xffffffff || lho === 0xffffffff) {
      const xr = new Reader(extra);
      while (xr.remaining >= 4) {
        const id = xr.u16(), len = xr.u16();
        const end = xr.pos + len;
        if (id === 1) {
          if (usize === 0xffffffff) usize = xr.u64();
          if (csize === 0xffffffff) csize = xr.u64();
          if (lho === 0xffffffff) lho = xr.u64();
        }
        xr.seek(end);
      }
    }
    entries.push({ name, method, flags, crc, csize, usize, lho: lho + base, dir: name.endsWith('/') });
  }
  return entries;
}

function decodeName(bytes) {
  // Most tools write UTF-8 without setting the flag; prefer it when valid.
  const s = utf8(bytes);
  if (!s.includes('�')) return s;
  return cp437 ? cp437.decode(bytes) : s;
}

async function dataStart(blob, ent) {
  const h = new Uint8Array(await blob.slice(ent.lho, ent.lho + 30).arrayBuffer());
  const r = new Reader(h);
  if (r.u32() !== 0x04034b50) throw new Error('bad local header');
  r.skip(22);
  const nlen = r.u16(), xlen = r.u16();
  return ent.lho + 30 + nlen + xlen;
}

export async function readZipEntry(blob, ent) {
  if (ent.flags & 1) throw new Error('this file is encrypted inside the archive');
  const start = await dataStart(blob, ent);
  const comp = blob.slice(start, start + ent.csize);
  if (ent.method === 0) return comp;
  if (ent.method === 8) {
    if (ent.csize > 32 * 1024 * 1024 && typeof DecompressionStream !== 'undefined') {
      const ds = new DecompressionStream('deflate-raw');
      return new Blob([await new Response(comp.stream().pipeThrough(ds)).arrayBuffer()]);
    }
    const u8 = new Uint8Array(await comp.arrayBuffer());
    return inflateSync(u8, { out: new Uint8Array(ent.usize) });
  }
  throw new Error(`unsupported zip compression method ${ent.method}`);
}

async function readZipHead(blob, ent, n) {
  if (ent.flags & 1) return new Uint8Array(0);
  const start = await dataStart(blob, ent);
  if (ent.method === 0) return new Uint8Array(await blob.slice(start, start + Math.min(n, ent.csize)).arrayBuffer());
  if (ent.method !== 8) return new Uint8Array(0);
  const chunk = new Uint8Array(await blob.slice(start, start + Math.min(ent.csize, Math.max(65536, n * 4))).arrayBuffer());
  const out = [];
  let got = 0;
  const inf = new Inflate((d) => { out.push(d); got += d.length; });
  try { inf.push(chunk, chunk.length >= ent.csize); } catch { /* partial stream */ }
  const res = new Uint8Array(Math.min(got, n));
  let o = 0;
  for (const d of out) { if (o >= res.length) break; const take = Math.min(d.length, res.length - o); res.set(d.subarray(0, take), o); o += take; }
  return res;
}

export default {
  id: 'zip',
  kinds: ['zip'],
  async expand(ctx, e) {
    const blob = await ctx.vfs.blob(e);
    const list = await readZipDirectory(blob);
    let files = 0;
    for (const ent of list) {
      if (ent.dir) continue;
      const child = ctx.extract(`${e.path}/${ent.name}`, null, {
        size: ent.usize,
        source: e.path,
        producer: () => readZipEntry(blob, ent),
      });
      if (child) {
        child.headFn = (n) => readZipHead(blob, ent, n);
        if (ent.flags & 1) child.meta = { encrypted: true };
      }
      files++;
    }
    e.meta = { ...(e.meta || {}), archive: 'ZIP', entries: files };
  },
};
