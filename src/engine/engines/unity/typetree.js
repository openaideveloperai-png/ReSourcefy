// Unity type trees: the TPK class database (layouts of every built-in class for
// every Unity version, from AssetRipper/UnityPy), plus a generic reader that
// turns serialized object bytes into plain JS values using a type tree.
import { Reader } from '../../util/binary.js';
import { loadData } from '../../util/data.js';

// "2021.3.16f1" -> comparable BigInt (major<<48 | minor<<32 | build<<16 | type<<8 | n)
const TYPE_CODES = { a: 0, b: 1, c: 2, f: 3, p: 4, x: 5 };
export function versionKey(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)([a-z]?)(\d*)/.exec(s || '');
  if (!m) return 0n;
  const type = m[4] ? (TYPE_CODES[m[4]] ?? 3) : 3;
  return (BigInt(+m[1]) << 48n) | (BigInt(+m[2]) << 32n) | (BigInt(+m[3]) << 16n) | (BigInt(type) << 8n) | BigInt(+(m[5] || 0));
}
export function parseUnityVersion(s) {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(s || '');
  return m ? [+m[1], +m[2], +m[3]] : [0, 0, 0];
}

let tpkPromise = null;
export function loadTpk() {
  if (!tpkPromise) tpkPromise = (async () => {
    return parseTpk(await loadData('unity-types.tpk'));
  })();
  return tpkPromise;
}

function parseTpk(u8) {
  const r = new Reader(u8);
  if (r.u32() !== 0x2a4b5054) throw new Error('bad TPK');
  const tpkVersion = r.u8_();
  const compression = r.u8_();
  r.u8_(); r.u8_(); // data type, reserved
  r.u32(); // reserved
  const csize = r.u32();
  r.u32();
  if (compression !== 0) throw new Error('compressed TPK not supported');
  const b = r.sub(r.pos, csize);
  b.i64();
  const nVersions = b.i32();
  for (let i = 0; i < nVersions; i++) b.u64big();
  const nClasses = b.i32();
  const classes = new Map();
  for (let i = 0; i < nClasses; i++) {
    const id = b.i32();
    const count = b.i32();
    const entries = [];
    for (let j = 0; j < count; j++) {
      const v = b.u64big();
      const has = b.u8_();
      let cls = null;
      if (has) {
        const name = b.u16(), base = b.u16(), flags = b.u8_();
        const editorRoot = flags & 64 ? b.u16() : null;
        const releaseRoot = flags & 128 ? b.u16() : null;
        cls = { name, base, flags, editorRoot, releaseRoot };
      }
      entries.push([v, cls]);
    }
    classes.set(id, entries);
  }
  // common strings
  let common;
  if (tpkVersion === 1) {
    const vc = b.i32();
    const vinfo = [];
    for (let i = 0; i < vc; i++) vinfo.push([b.u64big(), b.u8_()]);
    const n = b.i32();
    const idx = [];
    for (let i = 0; i < n; i++) idx.push(b.u16());
    common = { v1: true, vinfo, idx };
  } else {
    const vc = b.i32();
    const byVersion = [];
    for (let i = 0; i < vc; i++) {
      const v = b.u64big();
      const n = b.i32();
      const entries = new Array(n);
      for (let j = 0; j < n; j++) entries[j] = [b.u16(), b.u16()];
      byVersion.push([v, entries]);
    }
    common = { v1: false, byVersion };
  }
  const nNodes = b.i32();
  const nodes = new Array(nNodes);
  for (let i = 0; i < nNodes; i++) {
    const typeName = b.u16(), name = b.u16(), byteSize = b.i32(), version = b.i16(), typeFlags = b.u8_(), metaFlag = b.u32();
    const n = b.u16();
    const sub = new Array(n);
    for (let j = 0; j < n; j++) sub[j] = b.u16();
    nodes[i] = { typeName, name, byteSize, version, typeFlags, metaFlag, sub };
  }
  const nStrings = b.i32();
  const strings = new Array(nStrings);
  for (let i = 0; i < nStrings; i++) strings[i] = b.strVar();
  return { classes, common, nodes, strings, tpkVersion };
}

function forVersion(entries, key) {
  let ret = null;
  for (const [v, item] of entries) {
    if (key >= v) ret = item;
    else break;
  }
  return ret;
}

export function commonStrings(tpk, key) {
  const c = tpk.common;
  const map = new Map();
  if (c.v1) {
    let count = c.idx.length;
    if (key) { const n = forVersion(c.vinfo, key); if (n != null) count = n; }
    let off = 0;
    for (let i = 0; i < count; i++) { const s = tpk.strings[c.idx[i]]; map.set(off, s); off += s.length + 1; }
  } else {
    const entries = key ? forVersion(c.byVersion, key) : c.byVersion[c.byVersion.length - 1][1];
    for (const [off, si] of entries || []) map.set(off, tpk.strings[si]);
  }
  return map;
}

export function className(tpk, classId, key) {
  const entries = tpk.classes.get(classId);
  if (!entries) return null;
  const cls = forVersion(entries, key) || entries.find(([, c]) => c)?.[1];
  return cls ? tpk.strings[cls.name] : null;
}

const treeCache = new Map();
// Type tree root node for a built-in class in a given Unity version.
export function classTree(tpk, classId, key) {
  const ck = classId + ':' + key;
  if (treeCache.has(ck)) return treeCache.get(ck);
  const entries = tpk.classes.get(classId);
  let tree = null;
  if (entries) {
    const cls = forVersion(entries, key);
    if (cls && cls.releaseRoot != null) tree = buildNode(tpk, cls.releaseRoot, 0);
  }
  treeCache.set(ck, tree);
  return tree;
}

function buildNode(tpk, id, level) {
  const n = tpk.nodes[id];
  return {
    type: tpk.strings[n.typeName], name: tpk.strings[n.name], byteSize: n.byteSize, version: n.version,
    typeFlags: n.typeFlags, metaFlag: n.metaFlag, level, children: n.sub.map((c) => buildNode(tpk, c, level + 1)),
  };
}

// Parse a serialized type tree blob (v10, v12+) into nested nodes.
export function parseTypeTreeBlob(r, version, common) {
  if (version >= 23) {
    const magic = r.str(4, 'latin1');
    if (magic !== 'mhtt') throw new Error('bad type tree blob');
    r.i32();
  }
  const nodeCount = r.i32();
  const strSize = r.i32();
  const raw = [];
  for (let i = 0; i < nodeCount; i++) {
    const n = { version: r.i16(), level: r.u8_(), typeFlags: r.u8_(), typeOff: r.u32(), nameOff: r.u32(), byteSize: r.i32(), index: r.i32(), metaFlag: r.u32() };
    if (version >= 19) r.u64();
    raw.push(n);
  }
  const sb = r.bytes(strSize);
  const str = (off) => {
    if ((off & 0x80000000) === 0) {
      let e = off;
      while (e < sb.length && sb[e]) e++;
      return new TextDecoder().decode(sb.subarray(off, e));
    }
    const k = off & 0x7fffffff;
    return common.get(k) ?? String(k);
  };
  const nodes = raw.map((n) => ({ type: str(n.typeOff), name: str(n.nameOff), byteSize: n.byteSize, version: n.version, typeFlags: n.typeFlags, metaFlag: n.metaFlag, level: n.level, children: [] }));
  return linkByLevel(nodes);
}

// Old (pre-v10) recursive format.
export function parseTypeTreeOld(r, version, level = 0) {
  const node = { type: r.cstr(), name: r.cstr(), byteSize: r.i32(), level, children: [] };
  if (version === 2) r.i32();
  if (version !== 3) r.i32();
  node.typeFlags = r.i32();
  node.version = r.i32();
  node.metaFlag = version !== 3 ? r.i32() : 0;
  const n = r.i32();
  for (let i = 0; i < n; i++) node.children.push(parseTypeTreeOld(r, version, level + 1));
  return node;
}

function linkByLevel(nodes) {
  if (!nodes.length) return null;
  const root = nodes[0];
  const stack = [root];
  for (let i = 1; i < nodes.length; i++) {
    const n = nodes[i];
    while (stack.length && stack[stack.length - 1].level >= n.level) stack.pop();
    const parent = stack[stack.length - 1] || root;
    parent.children.push(n);
    stack.push(n);
  }
  return root;
}

// ---------------- generic value reader ----------------
// 64-bit IDs (path IDs are often random hashes): exact as number when safe, else string.
export function id64(r) {
  const v = r.i64big();
  return v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v.toString();
}

const ALIGN = 0x4000;
const PRIM = {
  SInt8: (r) => r.i8(), UInt8: (r) => r.u8_(), char: (r) => r.u8_(),
  SInt16: (r) => r.i16(), short: (r) => r.i16(), UInt16: (r) => r.u16(), 'unsigned short': (r) => r.u16(),
  SInt32: (r) => r.i32(), int: (r) => r.i32(), UInt32: (r) => r.u32(), 'unsigned int': (r) => r.u32(), 'Type*': (r) => r.u32(),
  SInt64: (r) => id64(r), 'long long': (r) => id64(r), UInt64: (r) => r.u64(), 'unsigned long long': (r) => r.u64(), FileSize: (r) => r.u64(),
  float: (r) => r.f32(), double: (r) => r.f64(), bool: (r) => r.u8_() !== 0,
};

export function readTyped(r, node, depth = 0) {
  if (depth > 64) throw new Error('type tree too deep');
  let align = (node.metaFlag & ALIGN) !== 0;
  let value;
  const t = node.type;
  const prim = PRIM[t];
  if (prim) value = prim(r);
  else if (t === 'string') {
    const n = r.i32();
    value = new TextDecoder().decode(r.bytes(n));
    r.align(4);
    align = false;
  } else if (t === 'TypelessData') {
    const n = r.i32();
    value = r.bytes(n);
  } else if (t === 'pair') {
    value = [readTyped(r, node.children[0], depth + 1), readTyped(r, node.children[1], depth + 1)];
  } else if (node.children.length && node.children[0].type === 'Array') {
    const arr = node.children[0];
    if (arr.metaFlag & ALIGN) align = true;
    const size = r.i32();
    if (size < 0 || size > 1e8) throw new Error('bad array size ' + size);
    const sub = arr.children[1];
    const sp = PRIM[sub.type];
    if (sp && (sub.type === 'UInt8' || sub.type === 'char' || sub.type === 'SInt8')) {
      value = r.bytes(size);
    } else if (sp) {
      value = new Array(size);
      for (let i = 0; i < size; i++) value[i] = sp(r);
      if (sub.metaFlag & ALIGN) r.align(4);
    } else {
      value = new Array(size);
      for (let i = 0; i < size; i++) value[i] = readTyped(r, sub, depth + 1);
    }
  } else {
    value = {};
    for (const c of node.children) value[c.name] = readTyped(r, c, depth + 1);
  }
  if (align) r.align(4);
  return value;
}
