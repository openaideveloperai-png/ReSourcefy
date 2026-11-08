// Godot pack files (.pck), standalone or embedded in an executable.
//   format 1  Godot 3.x   offsets absolute within the containing file
//   format 2  Godot 4.0-4.4  offsets relative to file_base
//   format 3  Godot 4.5+  directory at dir_offset, paths without "res://"
import { Reader, Writer, utf8, encodeUtf8 } from '../../util/binary.js';

const MAGIC = 0x43504447; // "GDPC"

async function bytesAt(blob, start, len) { return new Uint8Array(await blob.slice(start, start + len).arrayBuffer()); }

// Where the pack starts inside an executable (or 0 for a .pck), or -1.
export async function findPack(blob) {
  const head = await bytesAt(blob, 0, 4);
  if (new DataView(head.buffer).getUint32(0, true) === MAGIC) return 0;
  if (blob.size < 16) return -1;
  // trailer: ... [pck] [u64 size] ["GDPC"]
  const tail = await bytesAt(blob, blob.size - 12, 12);
  const tdv = new DataView(tail.buffer);
  if (tdv.getUint32(8, true) === MAGIC) {
    const size = Number(tdv.getBigUint64(0, true));
    const start = blob.size - 12 - size;
    if (start >= 0) {
      const m = await bytesAt(blob, start, 4);
      if (new DataView(m.buffer).getUint32(0, true) === MAGIC) return start;
    }
  }
  // Windows exports can keep the pack in a "pck" PE section
  if (head[0] === 0x4d && head[1] === 0x5a) {
    const hdr = await bytesAt(blob, 0, Math.min(blob.size, 4096));
    const dv = new DataView(hdr.buffer);
    const pe = dv.getUint32(0x3c, true);
    if (pe + 24 < hdr.length && dv.getUint32(pe, true) === 0x4550) {
      const nsec = dv.getUint16(pe + 6, true), optSize = dv.getUint16(pe + 20, true);
      let s = pe + 24 + optSize;
      for (let i = 0; i < nsec && s + 40 <= hdr.length; i++, s += 40) {
        const name = utf8(hdr.subarray(s, s + 8)).replace(/\0.*$/, '');
        if (name === 'pck') {
          const off = dv.getUint32(s + 20, true);
          for (let k = 0; k < 8; k++) {
            const m = await bytesAt(blob, off + k, 4);
            if (new DataView(m.buffer).getUint32(0, true) === MAGIC) return off + k;
          }
        }
      }
    }
  }
  return -1;
}

export async function readPack(blob, start = 0) {
  const headLen = Math.min(blob.size - start, 128);
  const h = new Reader(await bytesAt(blob, start, headLen), true);
  if (h.u32() !== MAGIC) throw new Error('not a Godot pack');
  const format = h.u32();
  const ver = [h.u32(), h.u32(), h.u32()];
  let flags = 0, fileBase = 0, dirOffset;
  if (format >= 2) {
    flags = h.u32();
    fileBase = h.u64();
    if (format >= 3 || (flags & 2)) fileBase += start;
    if (format >= 3) dirOffset = h.u64() + start;
    else dirOffset = start + h.pos + 64;
  } else dirOffset = start + h.pos + 64;
  const encryptedDir = !!(flags & 1);
  const pack = { format, version: ver, flags, start, fileBase, files: [], encryptedDir };
  if (encryptedDir) return pack;
  // read the directory in growing chunks
  let dirBytes = await bytesAt(blob, dirOffset, Math.min(blob.size - dirOffset, 1 << 20));
  let r = new Reader(dirBytes, true);
  const count = r.u32();
  for (let i = 0; i < count; i++) {
    for (;;) {
      try {
        const save = r.pos;
        const sl = r.u32();
        if (r.pos + sl + 36 > r.u8.length) { r.pos = save; throw new RangeError('more'); }
        let path = utf8(r.bytes(sl)).replace(/\0+$/, '');
        const ofs = r.u64(), size = r.u64();
        r.skip(16); // md5
        const fflags = format >= 2 ? r.u32() : 0;
        if (path.startsWith('res://')) path = path.slice(6);
        const offset = format >= 2 ? fileBase + ofs : start + ofs;
        if (!(fflags & 2)) pack.files.push({ path, offset, size, encrypted: !!(fflags & 1) });
        break;
      } catch (err) {
        if (!(err instanceof RangeError)) throw err;
        const pos = r.pos;
        if (dirOffset + dirBytes.length >= blob.size) throw new Error('pack directory is truncated');
        const more = await bytesAt(blob, dirOffset + dirBytes.length, Math.min(blob.size - dirOffset - dirBytes.length, dirBytes.length * 2));
        const merged = new Uint8Array(dirBytes.length + more.length);
        merged.set(dirBytes); merged.set(more, dirBytes.length);
        dirBytes = merged;
        r = new Reader(dirBytes, true);
        r.pos = pos;
      }
    }
  }
  return pack;
}

// Build a standalone pack with the same format/version. files: [{path, data: Blob|Uint8Array}]
export function writePack({ format, version }, files) {
  const fmt = format || 2;
  const align = (n, a = 16) => (n + a - 1) & ~(a - 1);
  const entries = files.map((f) => {
    const p = fmt >= 3 ? f.path : 'res://' + f.path;
    let pb = encodeUtf8(p);
    const padded = new Uint8Array(align(pb.length + 1, 4));
    padded.set(pb);
    pb = padded;
    return { ...f, pb, size: f.data instanceof Blob ? f.data.size : f.data.length };
  });
  const head = new Writer(1024, true);
  head.u32(MAGIC); head.u32(fmt); head.u32(version[0]); head.u32(version[1]); head.u32(version[2]);
  const headerSize = fmt >= 3 ? 20 + 4 + 8 + 8 + 64 : fmt === 2 ? 20 + 4 + 8 + 64 : 20 + 64;
  const dir = new Writer(1024, true);
  dir.u32(entries.length);
  const dirSize = 4 + entries.reduce((n, e) => n + 4 + e.pb.length + 8 + 8 + 16 + (fmt >= 2 ? 4 : 0), 0);
  // layout: header, [v1/v2: directory], data..., [v3: directory]
  const dataStart = align(fmt >= 3 ? headerSize : headerSize + dirSize);
  let ofs = 0;
  for (const e of entries) { e.ofs = ofs; ofs = align(ofs + e.size); }
  const dataEnd = dataStart + ofs;
  for (const e of entries) {
    dir.u32(e.pb.length); dir.bytes(e.pb);
    dir.u64(fmt >= 2 ? e.ofs : dataStart + e.ofs); dir.u64(e.size);
    dir.bytes(new Uint8Array(16));
    if (fmt >= 2) dir.u32(0);
  }
  if (fmt >= 3) { head.u32(2); head.u64(dataStart); head.u64(align(dataEnd)); }
  else if (fmt === 2) { head.u32(2); head.u64(dataStart); }
  head.bytes(new Uint8Array(64));
  const parts = [head.result()];
  if (fmt < 3) parts.push(dir.result());
  let pos = fmt < 3 ? headerSize + dirSize : headerSize;
  const padTo = (n) => { if (n > pos) { parts.push(new Uint8Array(n - pos)); pos = n; } };
  for (const e of entries) {
    padTo(dataStart + e.ofs);
    parts.push(e.data);
    pos += e.size;
  }
  if (fmt >= 3) { padTo(align(dataEnd)); parts.push(dir.result()); }
  return new Blob(parts);
}
