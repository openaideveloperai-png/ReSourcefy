// Portable Executable (Windows .exe / .dll) parser: headers, sections, imports,
// exports, version resources, icons, .NET (CLI) header and overlay detection.
import { Reader, utf16le, latin1, hex } from '../util/binary.js';

const MACHINES = { 0x14c: 'x86', 0x8664: 'x64', 0x1c0: 'ARM', 0xaa64: 'ARM64', 0x200: 'IA64', 0x1c4: 'ARMv7' };
const SUBSYSTEMS = { 1: 'Native', 2: 'Windows GUI', 3: 'Windows console', 9: 'Windows CE', 10: 'EFI application' };

export function isPE(u8) {
  if (u8.length < 64 || u8[0] !== 0x4d || u8[1] !== 0x5a) return false;
  const off = u8[0x3c] | (u8[0x3d] << 8) | (u8[0x3e] << 16) | (u8[0x3f] << 24);
  return off > 0 && off + 4 < u8.length && u8[off] === 0x50 && u8[off + 1] === 0x45 && u8[off + 2] === 0 && u8[off + 3] === 0;
}

export function parsePE(u8) {
  const r = new Reader(u8);
  const peOff = r.seek(0x3c).u32();
  r.seek(peOff);
  if (r.u32() !== 0x00004550) throw new Error('not a PE file');
  const machine = r.u16();
  const nsec = r.u16();
  const timestamp = r.u32();
  r.skip(8);
  const optSize = r.u16();
  const characteristics = r.u16();
  const optStart = r.pos;
  const magic = r.u16();
  const is64 = magic === 0x20b;
  r.seek(optStart + 16);
  const entryRva = r.u32();
  let imageBase;
  if (is64) { r.seek(optStart + 24); imageBase = r.u64(); }
  else { r.seek(optStart + 28); imageBase = r.u32(); }
  r.seek(optStart + 68);
  const subsystem = r.u16();
  const dllChars = r.u16();
  const ddOff = optStart + (is64 ? 112 : 96);
  r.seek(ddOff - 4);
  const nDirs = Math.min(r.u32(), 16);
  const dirs = [];
  for (let i = 0; i < nDirs; i++) dirs.push({ rva: r.u32(), size: r.u32() });
  r.seek(optStart + optSize);
  const sections = [];
  for (let i = 0; i < nsec; i++) {
    const name = latin1(r.bytes(8)).replace(/\0.*$/, '');
    const vsize = r.u32(), va = r.u32(), rawSize = r.u32(), rawPtr = r.u32();
    r.skip(12);
    const chars = r.u32();
    sections.push({ name, vsize, va, rawSize, rawPtr, chars });
  }
  const pe = { u8, machine, machineName: MACHINES[machine] || hex(machine, 4), is64, timestamp, characteristics, entryRva, imageBase, subsystem, dllChars, dirs, sections, isDll: !!(characteristics & 0x2000) };
  pe.rvaToOffset = (rva) => {
    for (const s of sections) {
      const size = Math.max(s.vsize, s.rawSize);
      if (rva >= s.va && rva < s.va + size) {
        const off = rva - s.va;
        return off < s.rawSize ? s.rawPtr + off : -1;
      }
    }
    return rva < (sections[0]?.rawPtr || 0x400) ? rva : -1;
  };
  pe.vaToOffset = (va) => pe.rvaToOffset(va - imageBase);
  pe.sectionOf = (rva) => sections.find((s) => rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) || null;
  let end = 0;
  for (const s of sections) end = Math.max(end, s.rawPtr + s.rawSize);
  const cert = dirs[4];
  pe.overlayOffset = end;
  pe.overlaySize = Math.max(0, (cert && cert.rva && cert.rva >= end ? cert.rva : u8.length) - end);
  pe.clr = dirs[14] && dirs[14].rva ? readCLR(pe, dirs[14]) : null;
  return pe;
}

function readCLR(pe, dir) {
  const off = pe.rvaToOffset(dir.rva);
  if (off < 0) return null;
  const r = new Reader(pe.u8, true, off);
  r.u32();
  const major = r.u16(), minor = r.u16();
  const mdRva = r.u32(), mdSize = r.u32();
  const flags = r.u32();
  const entryToken = r.u32();
  const resRva = r.u32(), resSize = r.u32();
  return { major, minor, mdRva, mdSize, flags, entryToken, resRva, resSize };
}

export function readCString(pe, rva, max = 512) {
  const off = pe.rvaToOffset(rva);
  if (off < 0) return '';
  let end = off;
  while (end < pe.u8.length && end - off < max && pe.u8[end]) end++;
  return latin1(pe.u8.subarray(off, end));
}

export function readImports(pe) {
  const dir = pe.dirs[1];
  const out = [];
  if (!dir || !dir.rva) return out;
  let off = pe.rvaToOffset(dir.rva);
  if (off < 0) return out;
  const r = new Reader(pe.u8);
  for (let i = 0; i < 4096; i++, off += 20) {
    r.seek(off);
    const ilt = r.u32(); r.u32(); r.u32();
    const nameRva = r.u32(); const iat = r.u32();
    if (!nameRva && !ilt && !iat) break;
    const dll = readCString(pe, nameRva);
    const funcs = [];
    let t = pe.rvaToOffset(ilt || iat);
    if (t >= 0) {
      for (let j = 0; j < 20000; j++) {
        r.seek(t);
        let v, ordinal = false;
        if (pe.is64) {
          const lo = r.u32(), hi = r.u32();
          if (!lo && !hi) break;
          ordinal = (hi & 0x80000000) !== 0;
          v = lo;
        } else {
          v = r.u32();
          if (!v) break;
          ordinal = (v & 0x80000000) !== 0;
        }
        funcs.push(ordinal ? `#${v & 0xffff}` : readCString(pe, (v & 0x7fffffff) + 2));
        t += pe.is64 ? 8 : 4;
      }
    }
    out.push({ dll, funcs });
  }
  return out;
}

export function readExports(pe) {
  const dir = pe.dirs[0];
  if (!dir || !dir.rva) return { name: null, list: [] };
  const off = pe.rvaToOffset(dir.rva);
  if (off < 0) return { name: null, list: [] };
  const r = new Reader(pe.u8, true, off);
  r.skip(12);
  const nameRva = r.u32();
  const base = r.u32();
  const nFuncs = r.u32(), nNames = r.u32();
  const funcsRva = r.u32(), namesRva = r.u32(), ordsRva = r.u32();
  const list = [];
  const names = new Map();
  const nOff = pe.rvaToOffset(namesRva), oOff = pe.rvaToOffset(ordsRva), fOff = pe.rvaToOffset(funcsRva);
  if (nOff >= 0 && oOff >= 0) {
    const nr = new Reader(pe.u8), or = new Reader(pe.u8);
    for (let i = 0; i < Math.min(nNames, 100000); i++) {
      const nm = readCString(pe, nr.seek(nOff + i * 4).u32());
      const ord = or.seek(oOff + i * 2).u16();
      names.set(ord, nm);
    }
  }
  if (fOff >= 0) {
    const fr = new Reader(pe.u8);
    for (let i = 0; i < Math.min(nFuncs, 100000); i++) {
      const rva = fr.seek(fOff + i * 4).u32();
      if (!rva) continue;
      list.push({ ordinal: base + i, rva, name: names.get(i) || null });
    }
  }
  return { name: readCString(pe, nameRva), list };
}

// Walk the resource tree: returns [{type, name, lang, rva, size, offset}]
export function readResources(pe) {
  const dir = pe.dirs[2];
  const out = [];
  if (!dir || !dir.rva) return out;
  const base = pe.rvaToOffset(dir.rva);
  if (base < 0) return out;
  const u8 = pe.u8;
  const r = new Reader(u8);
  const nameAt = (o) => {
    r.seek(base + o);
    const len = r.u16();
    return utf16le(r.bytes(len * 2));
  };
  const walk = (o, depth, path) => {
    if (depth > 3 || out.length > 20000) return;
    r.seek(base + o + 12);
    const named = r.u16(), ids = r.u16();
    const entries = [];
    for (let i = 0; i < named + ids; i++) {
      r.seek(base + o + 16 + i * 8);
      const nameField = r.u32(), dataField = r.u32();
      entries.push([nameField, dataField]);
    }
    for (const [nameField, dataField] of entries) {
      const id = nameField & 0x80000000 ? nameAt(nameField & 0x7fffffff) : nameField;
      if (dataField & 0x80000000) walk(dataField & 0x7fffffff, depth + 1, [...path, id]);
      else {
        r.seek(base + dataField);
        const rva = r.u32(), size = r.u32();
        const p = [...path, id];
        out.push({ type: p[0], name: p[1], lang: p[2], rva, size, offset: pe.rvaToOffset(rva) });
      }
    }
  };
  try { walk(0, 0, []); } catch { /* malformed resource tree */ }
  return out;
}

// VS_VERSIONINFO string table -> {ProductName: ..., FileVersion: ...}
export function readVersionInfo(pe, resources = readResources(pe)) {
  const res = resources.find((x) => x.type === 16 && x.offset >= 0);
  if (!res) return null;
  const u8 = pe.u8.subarray(res.offset, res.offset + res.size);
  const out = {};
  const r = new Reader(u8);
  const readKey = () => {
    const start = r.pos;
    while (r.pos + 1 < u8.length && (u8[r.pos] | u8[r.pos + 1])) r.pos += 2;
    const s = utf16le(u8.subarray(start, r.pos));
    r.pos += 2;
    return s;
  };
  const node = (start, depth) => {
    if (depth > 6 || start + 6 > u8.length) return;
    r.seek(start);
    const len = r.u16(), vlen = r.u16(), type = r.u16();
    if (!len) return;
    const key = readKey();
    r.align(4);
    const end = Math.min(start + len, u8.length);
    if (depth >= 3 && type === 1 && vlen) {
      const vs = r.pos;
      let ve = vs;
      while (ve + 1 < end && (u8[ve] | u8[ve + 1])) ve += 2;
      out[key] = utf16le(u8.subarray(vs, ve));
      return;
    }
    if (key === 'VS_VERSION_INFO' && vlen >= 52) {
      const fr = new Reader(u8, true, r.pos);
      fr.skip(8);
      const ms = fr.u32(), ls = fr.u32();
      out._fileVersion = `${ms >>> 16}.${ms & 0xffff}.${ls >>> 16}.${ls & 0xffff}`;
    }
    r.pos += type === 1 ? vlen * 2 : vlen;
    r.align(4);
    let child = r.pos;
    while (child + 6 < end) {
      r.seek(child);
      const clen = r.u16();
      if (!clen) break;
      node(child, depth + 1);
      child = child + clen;
      child = (child + 3) & ~3;
    }
  };
  try { node(0, 0); } catch { /* malformed */ }
  return out;
}

// Largest icon from RT_GROUP_ICON, returned as PNG bytes or an .ico file.
export function readIcon(pe, resources = readResources(pe)) {
  const groups = resources.filter((x) => x.type === 14 && x.offset >= 0);
  if (!groups.length) return null;
  const g = groups[0];
  const r = new Reader(pe.u8, true, g.offset);
  r.skip(4);
  const count = r.u16();
  let best = null;
  for (let i = 0; i < count; i++) {
    const w = r.u8_() || 256, h = r.u8_() || 256;
    r.skip(2);
    const planes = r.u16(), bpp = r.u16();
    const bytes = r.u32();
    const id = r.u16();
    void planes;
    if (!best || w * h * (bpp || 32) > best.w * best.h * (best.bpp || 32)) best = { w, h, bpp, bytes, id };
  }
  if (!best) return null;
  const icon = resources.find((x) => x.type === 3 && x.name === best.id && x.offset >= 0);
  if (!icon) return null;
  const data = pe.u8.subarray(icon.offset, icon.offset + icon.size);
  if (data[0] === 0x89 && data[1] === 0x50) return { mime: 'image/png', data: data.slice(), width: best.w, height: best.h };
  const ico = new Uint8Array(22 + data.length);
  const dv = new DataView(ico.buffer);
  dv.setUint16(2, 1, true); dv.setUint16(4, 1, true);
  ico[6] = best.w >= 256 ? 0 : best.w; ico[7] = best.h >= 256 ? 0 : best.h;
  dv.setUint16(10, 1, true); dv.setUint16(12, best.bpp, true);
  dv.setUint32(14, data.length, true); dv.setUint32(18, 22, true);
  ico.set(data, 22);
  return { mime: 'image/x-icon', data: ico, width: best.w, height: best.h };
}

export function summarizePE(pe, name = '') {
  const lines = [];
  const vi = (() => { try { return readVersionInfo(pe); } catch { return null; } })();
  lines.push(`# ${name || 'Executable'}`, '');
  lines.push(`- Format: PE${pe.is64 ? '32+' : '32'} ${pe.isDll ? 'library (DLL)' : 'executable'} for ${pe.machineName}`);
  lines.push(`- Subsystem: ${SUBSYSTEMS[pe.subsystem] || pe.subsystem}`);
  if (pe.timestamp) lines.push(`- Linked: ${new Date(pe.timestamp * 1000).toISOString().slice(0, 10)}`);
  lines.push(`- Image base: ${hex(pe.imageBase)}  Entry point RVA: ${hex(pe.entryRva)}`);
  if (pe.clr) lines.push(`- .NET assembly (CLR ${pe.clr.major}.${pe.clr.minor}${pe.clr.flags & 1 ? ', IL only' : ''})`);
  if (pe.overlaySize > 0) lines.push(`- Appended data (overlay): ${pe.overlaySize.toLocaleString()} bytes at ${hex(pe.overlayOffset)}`);
  if (vi && Object.keys(vi).length) {
    lines.push('', '## Version information', '');
    for (const [k, v] of Object.entries(vi)) if (!k.startsWith('_') && v) lines.push(`- ${k}: ${v}`);
  }
  lines.push('', '## Sections', '', '| Name | Virtual address | Virtual size | Raw size |', '|---|---|---|---|');
  for (const s of pe.sections) lines.push(`| ${s.name} | ${hex(s.va)} | ${s.vsize.toLocaleString()} | ${s.rawSize.toLocaleString()} |`);
  try {
    const imps = readImports(pe);
    if (imps.length) {
      lines.push('', `## Imports (${imps.length} libraries)`, '');
      for (const imp of imps) {
        lines.push(`### ${imp.dll} (${imp.funcs.length})`);
        lines.push(imp.funcs.slice(0, 400).join(', ') + (imp.funcs.length > 400 ? ', …' : ''), '');
      }
    }
  } catch (e) { lines.push('', `Imports could not be read: ${e.message}`); }
  try {
    const ex = readExports(pe);
    if (ex.list.length) {
      lines.push('', `## Exports (${ex.list.length})${ex.name ? ' from ' + ex.name : ''}`, '');
      for (const x of ex.list.slice(0, 3000)) lines.push(`- ${x.name || '#' + x.ordinal}  ${hex(x.rva)}`);
      if (ex.list.length > 3000) lines.push(`- … ${ex.list.length - 3000} more`);
    }
  } catch (e) { lines.push('', `Exports could not be read: ${e.message}`); }
  return { text: lines.join('\n'), versionInfo: vi };
}
