// Unity SerializedFile reader (globalgamemanagers, levelN, sharedassetsN.assets,
// resources.assets, CAB-* inside bundles). Supports format versions 5-23+.
import { Reader } from '../../util/binary.js';
import { parseTypeTreeBlob, parseTypeTreeOld, readTyped, classTree, commonStrings, versionKey, className, id64 } from './typetree.js';
import { CLASS_NAMES } from './classes.js';

export function isSerializedFile(u8) {
  if (u8.length < 48) return false;
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = dv.getUint32(8, false);
  if (version < 5 || version > 50) return false;
  if (version >= 22) return dv.getUint32(20, false) > 0 && u8[16] <= 1;
  const metaSize = dv.getUint32(0, false), fileSize = dv.getUint32(4, false), dataOffset = dv.getUint32(12, false);
  return metaSize > 0 && fileSize >= metaSize && dataOffset <= fileSize && fileSize <= u8.length + 16;
}

export class SerializedFile {
  // src: the whole file as a Uint8Array, or a PagedBlob for large files (only the
  // metadata is read up front; object bytes are read when needed).
  constructor(src, name, tpk) {
    let u8 = src;
    if (!(src instanceof Uint8Array)) {
      this.paged = src;
      const h = src.get(0, 48);
      const hv = new DataView(h.buffer, h.byteOffset, h.byteLength);
      const v = hv.getUint32(8, false);
      const meta = v >= 22 ? Number(hv.getUint32(20, false)) + 64 : hv.getUint32(0, false) + 64;
      u8 = src.get(0, Math.min(src.size, meta)).slice();
      this.u8 = null;
      this.size = src.size;
    } else {
      this.u8 = u8;
      this.size = u8.length;
    }
    this.name = name;
    this.tpk = tpk;
    const r = new Reader(u8, false);
    let metadataSize = r.u32();
    let fileSize = r.u32();
    const version = r.u32();
    let dataOffset = r.u32();
    this.version = version;
    let le;
    if (version >= 9) {
      le = r.u8_() === 0;
      r.skip(3);
      if (version >= 22) {
        metadataSize = r.u32();
        fileSize = r.u64();
        dataOffset = r.u64();
        r.u64();
      }
    } else {
      r.seek(fileSize - metadataSize);
      le = r.u8_() === 0;
    }
    r.le = le;
    this.le = le;
    this.dataOffset = dataOffset;
    this.unityVersion = version >= 7 ? r.cstr() : '2.5.0f5';
    if (!/^\d/.test(this.unityVersion) || this.unityVersion.startsWith('0.0.0')) this.unityVersion = '';
    this.platform = version >= 8 ? r.i32() : -1;
    this.enableTypeTree = version >= 13 ? r.u8_() !== 0 : true;
    this.vkey = versionKey(this.unityVersion);
    const common = this.enableTypeTree ? commonStrings(tpk, this.vkey || null) : null;
    const nTypes = r.i32();
    this.types = [];
    for (let i = 0; i < nTypes; i++) this.types.push(this.readType(r, false, common));
    let bigId = 0;
    if (version >= 7 && version < 14) bigId = r.i32();
    const nObjects = r.i32();
    this.objects = [];
    this.byPathId = new Map();
    for (let i = 0; i < nObjects; i++) {
      let pathId;
      if (bigId) pathId = id64(r);
      else if (version < 14) pathId = r.i32();
      else { r.align(4); pathId = id64(r); }
      const tablePos = r.pos; // where this object's offset and size are stored (for rewriting)
      const byteStart = (version >= 22 ? r.u64() : r.u32()) + dataOffset;
      const byteSize = r.u32();
      const typeId = r.i32();
      let classId, type;
      if (version < 16) {
        classId = r.u16();
        type = this.types.find((t) => t.classId === typeId) || null;
      } else {
        type = this.types[typeId] || null;
        classId = type ? type.classId : -1;
      }
      if (version < 11) r.u16();
      if (version >= 11 && version < 17) {
        const sti = r.i16();
        if (type && type.scriptTypeIndex == null) type.scriptTypeIndex = sti;
      }
      if (version === 15 || version === 16) r.u8_();
      const obj = { pathId, byteStart, byteSize, classId, type, file: this, tablePos };
      this.objects.push(obj);
      this.byPathId.set(String(pathId), obj);
    }
    this.scripts = [];
    if (version >= 11) {
      const n = r.i32();
      for (let i = 0; i < n; i++) {
        const fileIndex = r.i32();
        let id;
        if (version < 14) id = r.i32(); else { r.align(4); id = id64(r); }
        this.scripts.push({ fileIndex, id });
      }
    }
    const nExt = r.i32();
    this.externals = [];
    for (let i = 0; i < nExt; i++) {
      if (version >= 6) r.cstr();
      if (version >= 5) { r.skip(16); r.i32(); }
      this.externals.push(r.cstr());
    }
    if (version >= 20) {
      const n = r.i32();
      this.refTypes = [];
      for (let i = 0; i < n; i++) this.refTypes.push(this.readType(r, true, common));
    }
    this.metadataEnd = r.pos;
  }

  readType(r, isRef, common) {
    const v = this.version;
    const t = { classId: r.i32(), stripped: false, scriptTypeIndex: null, tree: null };
    if (v >= 16) t.stripped = r.u8_() !== 0;
    if (v >= 17) t.scriptTypeIndex = r.i16();
    if (v >= 13) {
      if ((isRef && t.scriptTypeIndex >= 0) || (v < 16 && t.classId < 0) || (v >= 16 && t.classId === 114)) t.scriptId = r.bytes(16);
      t.oldTypeHash = r.bytes(16);
    }
    if (this.enableTypeTree) {
      let size = -1;
      if (v >= 23) { r.skip(16); size = r.i32(); }
      if (v >= 12 || v === 10) {
        if (v < 23 || size) t.tree = parseTypeTreeBlob(r, v, common);
      } else t.tree = parseTypeTreeOld(r, v);
      if (v >= 21) {
        if (isRef) { t.className = r.cstr(); t.namespace = r.cstr(); t.assembly = r.cstr(); }
        else { const n = r.i32(); r.skip(4 * n); }
      }
    }
    return t;
  }

  className(classId) {
    return CLASS_NAMES[classId] || className(this.tpk, classId, this.vkey) || `Class${classId}`;
  }

  treeFor(obj) {
    if (obj.type && obj.type.tree) return obj.type.tree;
    if (!this.vkey) return null;
    return classTree(this.tpk, obj.classId, this.vkey);
  }

  range(start, len) { return this.paged ? this.paged.get(start, len) : this.u8.subarray(start, start + len); }

  reader(obj) {
    return new Reader(this.range(obj.byteStart, obj.byteSize), this.le);
  }

  // bytes this parsed file keeps alive
  get memSize() { return this.paged ? this.paged.bytes + 1024 * this.objects.length / 8 : this.size; }

  release() { if (this.paged) this.paged.release(); }

  // Fully parse an object with its type tree. Returns null if no layout is known.
  // raw: strings as bytes, for writing the object back unchanged.
  read(obj, { partial = false, raw = false } = {}) {
    const tree = this.treeFor(obj);
    if (!tree) return null;
    const r = this.reader(obj);
    if (!partial) return readTyped(r, tree, 0, raw);
    // Read only leading fields until something fails (e.g. MonoBehaviour script data).
    const out = {};
    for (const c of tree.children) {
      try { out[c.name] = readTyped(r, c); } catch { break; }
    }
    return out;
  }

  // Read just m_Name (most assets start with it) cheaply.
  peekName(obj) {
    try {
      const r = this.reader(obj);
      const tree = this.treeFor(obj);
      if (tree) {
        for (const c of tree.children) {
          if (c.name === 'm_Name') return readTyped(r, c);
          readTyped(r, c);
          if (r.pos > 4096) return null;
        }
        return null;
      }
      const n = r.i32();
      if (n > 0 && n < 512) return new TextDecoder().decode(r.bytes(n));
    } catch { /* ignore */ }
    return null;
  }
}
