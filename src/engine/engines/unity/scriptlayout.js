// Layouts (type trees) for script data, MonoBehaviour and ScriptableObject fields, built from
// IL2CPP metadata and the game binary, for builds that don't carry type trees (WebGL and most
// players). They follow Unity's serialization rules; a layout is only used for an object when
// reading it with the layout consumes exactly the object's bytes and writing it back gives the
// same bytes.
import { classTree } from './typetree.js';
import { T as MT, parseSig } from '../../formats/dotnet.js';

const ALIGN = 0x4000;
const node = (type, name, children = [], metaFlag = 0) => ({ type, name, metaFlag, children, byteSize: -1, level: 0, version: 1, typeFlags: 0 });
const leaf = (type, name, align = false) => node(type, name, [], align ? ALIGN : 0);
const arrayOf = (name, elem) => node('vector', name, [node('Array', 'Array', [leaf('int', 'size'), { ...elem, name: 'data', metaFlag: elem.metaFlag & ~ALIGN }], ALIGN)]);
const pptr = (name, cls) => node(`PPtr<${cls}>`, name, [leaf('int', 'm_FileID'), leaf('SInt64', 'm_PathID')]);

// Il2CppTypeEnum -> [type tree name, aligned when it is a field of its own]
const PRIMS = {
  0x02: ['bool', true], 0x03: ['UInt16', true], 0x04: ['SInt8', true], 0x05: ['UInt8', true], 0x06: ['SInt16', true], 0x07: ['UInt16', true],
  0x08: ['int', false], 0x09: ['UInt32', false], 0x0a: ['SInt64', false], 0x0b: ['UInt64', false], 0x0c: ['float', false], 0x0d: ['double', false],
};

const f = (n) => leaf('float', n);
const i32 = (n) => leaf('int', n);
const v3 = (n) => node('Vector3f', n, ['x', 'y', 'z'].map(f));
const v3i = (n) => node('int3_storage', n, ['x', 'y', 'z'].map(i32));
// Unity's own structs, which it serializes natively
const BUILTIN = {
  'UnityEngine.Vector2': (n) => node('Vector2f', n, ['x', 'y'].map(f)),
  'UnityEngine.Vector3': v3,
  'UnityEngine.Vector4': (n) => node('Vector4f', n, ['x', 'y', 'z', 'w'].map(f)),
  'UnityEngine.Quaternion': (n) => node('Quaternionf', n, ['x', 'y', 'z', 'w'].map(f)),
  'UnityEngine.Color': (n) => node('ColorRGBA', n, ['r', 'g', 'b', 'a'].map(f)),
  'UnityEngine.Color32': (n) => node('ColorRGBA', n, [leaf('UInt32', 'rgba')]),
  'UnityEngine.Rect': (n) => node('Rectf', n, ['x', 'y', 'width', 'height'].map(f)),
  'UnityEngine.RectInt': (n) => node('RectInt', n, ['x', 'y', 'width', 'height'].map(i32)),
  'UnityEngine.Vector2Int': (n) => node('int2_storage', n, ['x', 'y'].map(i32)),
  'UnityEngine.Vector3Int': v3i,
  'UnityEngine.Bounds': (n) => node('AABB', n, [v3('m_Center'), v3('m_Extent')]),
  'UnityEngine.BoundsInt': (n) => node('BoundsInt', n, [v3i('m_Position'), v3i('m_Size')]),
  'UnityEngine.Matrix4x4': (n) => node('Matrix4x4f', n, [0, 1, 2, 3].flatMap((r) => [0, 1, 2, 3].map((c) => f(`e${r}${c}`)))),
  'UnityEngine.LayerMask': (n) => node('BitField', n, [leaf('UInt32', 'm_Bits')]),
  'UnityEngine.RectOffset': (n) => node('RectOffset', n, ['m_Left', 'm_Right', 'm_Top', 'm_Bottom'].map(i32)),
};
// complex Unity structs whose layout comes from the class database (they appear inside these classes)
const FROM_TPK = { 'UnityEngine.AnimationCurve': 'AnimationCurve', 'UnityEngine.Gradient': 'Gradient' };
const TPK_HOSTS = [198, 74, 96, 120, 199];

class Unsupported extends Error {}

export class ScriptLayouts {
  constructor(md, model, { tpk, vkey }) {
    this.md = md;
    this.model = model;
    this.bin = model.bin;
    this.tpk = tpk;
    this.vkey = vkey;
    this.cache = new Map();
    this.objCache = new Map();
    this.attrIndex = new Map();
    this.byName = null;
    this.tpkNodes = new Map();
  }

  get usable() { return !!(this.model && this.model.hasTypes); }

  fullName(ti) {
    const td = this.md.typeDefs[ti];
    if (!td) return '';
    const ns = this.md.str(td.namespaceIndex);
    return (ns ? ns + '.' : '') + this.md.str(td.nameIndex);
  }

  // type definition index of a script class
  findType(assembly, ns, name) {
    if (!this.byName) {
      this.byName = new Map();
      this.md.images.forEach((img, ii) => {
        const asm = this.md.str(img.nameIndex).replace(/\.dll$/i, '').toLowerCase();
        const [s, e] = this.md.imageTypes(ii);
        for (let ti = s; ti < e; ti++) {
          const td = this.md.typeDefs[ti];
          this.byName.set(`${asm}|${this.md.str(td.namespaceIndex)}|${this.md.str(td.nameIndex)}`, ti);
        }
      });
    }
    return this.byName.get(`${String(assembly || '').replace(/\.dll$/i, '').toLowerCase()}|${ns || ''}|${name}`) ?? -1;
  }

  // names of the attributes on a metadata token (field or type) in an image
  attributes(ii, token) {
    const md = this.md, h = md.header, img = md.images[ii];
    if (!img || img.customAttributeCount == null) return new Set();
    let idx = this.attrIndex.get(ii);
    if (!idx) {
      idx = new Map();
      const v29 = md.version >= 29;
      const recSize = v29 ? 8 : 12, base = v29 ? h.attributeDataRangeOffset : h.attributesInfoOffset;
      for (let k = img.customAttributeStart; k < img.customAttributeStart + img.customAttributeCount; k++) idx.set(md.dv.getUint32(base + k * recSize, true), k);
      this.attrIndex.set(ii, idx);
    }
    const k = idx.get(token);
    const names = new Set();
    if (k == null) return names;
    const dv = md.dv;
    if (md.version >= 29) {
      const start = h.attributeDataOffset + dv.getUint32(h.attributeDataRangeOffset + k * 8 + 4, true);
      let p = start;
      const b = md.u8[p];
      let count;
      if ((b & 0x80) === 0) { count = b; p += 1; } else if ((b & 0xc0) === 0x80) { count = ((b & 0x3f) << 8) | md.u8[p + 1]; p += 2; } else { count = ((b & 0x1f) << 24) | (md.u8[p + 1] << 16) | (md.u8[p + 2] << 8) | md.u8[p + 3]; p += 4; }
      for (let j = 0; j < count && j < 64; j++) {
        const m = md.methodDefs[dv.getInt32(p + j * 4, true)];
        if (m) names.add(md.typeName(m.declaringType));
      }
    } else {
      const rec = h.attributesInfoOffset + k * 12;
      const start = dv.getInt32(rec + 4, true), count = dv.getInt32(rec + 8, true);
      for (let j = 0; j < count && j < 64; j++) {
        const t = this.model.typeAt(dv.getInt32(h.attributeTypesOffset + (start + j) * 4, true));
        if (t && (t.type === 0x12 || t.type === 0x11)) names.add(md.typeName(t.data));
      }
    }
    return names;
  }

  // does the class derive from UnityEngine.Object?
  isUnityObject(ti) {
    if (this.objCache.has(ti)) return this.objCache.get(ti);
    let cur = ti, result = false;
    for (let d = 0; d < 32 && cur >= 0; d++) {
      if (this.fullName(cur) === 'UnityEngine.Object') { result = true; break; }
      const td = this.md.typeDefs[cur];
      if (!td || td.parentIndex < 0) break;
      cur = this.defOf(this.model.typeAt(td.parentIndex)).ti;
    }
    this.objCache.set(ti, result);
    return result;
  }

  // {ti, args} for a class, value type or generic instance type
  defOf(t) {
    if (!t) return { ti: -1, args: [] };
    if (t.type === 0x11 || t.type === 0x12) return { ti: t.data < this.md.typeDefs.length ? t.data : -1, args: [] };
    if (t.type === 0x15) {
      const bin = this.bin, P = bin.ptrSize, nb = this.model.newBits;
      let ti;
      if (this.md.version >= 27) { const dt = bin.readType(bin.ptr(t.data), nb); ti = dt ? dt.data : -1; } else ti = bin.ptr(t.data);
      const inst = bin.ptr(t.data + P);
      const argc = inst ? bin.ptr(inst) : 0, argv = inst ? bin.ptr(inst + P) : 0;
      const args = [];
      for (let k = 0; k < Math.min(argc, 16); k++) args.push(bin.readType(bin.ptr(argv + k * P), nb));
      return { ti: ti >= 0 && ti < this.md.typeDefs.length ? ti : -1, args };
    }
    return { ti: -1, args: [] };
  }

  fromTpk(typeName) {
    if (this.tpkNodes.has(typeName)) return this.tpkNodes.get(typeName);
    let found = null;
    const walk = (n) => { if (found || !n) return; if (n.type === typeName) { found = n; return; } for (const c of n.children) walk(c); };
    for (const id of TPK_HOSTS) { walk(classTree(this.tpk, id, this.vkey)); if (found) break; }
    this.tpkNodes.set(typeName, found);
    return found;
  }

  // The serialized fields of a class (base classes first), with generic arguments `args`.
  fieldsOf(ti, args, depth) {
    if (depth > 8) throw new Unsupported('fields nest too deeply');
    const md = this.md, chain = [];
    let cur = { ti, args };
    for (let d = 0; d < 32 && cur.ti >= 0; d++) {
      const name = this.fullName(cur.ti);
      if (/^UnityEngine\.(MonoBehaviour|ScriptableObject|Behaviour|Component|Object)$/.test(name) || name === 'System.Object' || name === 'System.ValueType') break;
      chain.push(cur);
      const td = md.typeDefs[cur.ti];
      if (td.parentIndex < 0) break;
      const pt = this.model.typeAt(td.parentIndex);
      const p = this.defOf(pt);
      // a generic base gets its arguments from this class's arguments
      p.args = p.args.map((a) => this.substitute(a, cur.args));
      cur = p;
    }
    const out = [];
    for (const { ti: t, args: a } of chain.reverse()) {
      const td = md.typeDefs[t];
      const ii = md.typeImage[t];
      for (let k = 0; k < td.field_count; k++) {
        const fd = md.fieldDefs[td.fieldStart + k];
        if (!fd) continue;
        const ft = this.model.typeAt(fd.typeIndex);
        if (!ft) throw new Unsupported('a field type could not be read');
        const attrs = ft.attrs;
        if (attrs & 0x10 || attrs & 0x40 || attrs & 0x20 || attrs & 0x80) continue; // static, const, readonly, [NonSerialized]
        const names = fd.token && ii >= 0 ? this.attributes(ii, fd.token) : new Set();
        if (names.has('SerializeReference')) throw new Unsupported('[SerializeReference] fields are not supported yet');
        if ((attrs & 7) !== 6 && !names.has('SerializeField')) continue; // private without [SerializeField]
        const n = this.nodeFor(this.substitute(ft, a), md.str(fd.nameIndex), depth, false);
        if (n) out.push(n);
      }
    }
    return out;
  }

  // replace a generic parameter (T) by the argument it stands for
  substitute(t, args) {
    if (t && (t.type === 0x13) && args && args.length) {
      const gp = this.md.genericParameters[t.data];
      const a = gp ? args[gp.num] : null;
      if (a) return a;
    }
    return t;
  }

  // The layout node for a field of type t, or null when Unity doesn't serialize it.
  nodeFor(t, name, depth, inArray) {
    if (!t || t.byref) return null;
    const prim = PRIMS[t.type];
    if (prim) return leaf(prim[0], name, prim[1] && !inArray);
    if (t.type === 0x0e) return leaf('string', name);
    if (t.type === 0x1d) {
      if (inArray) return null; // arrays of arrays are not serialized
      const el = this.bin.readType(t.data, this.model.newBits);
      const en = this.nodeFor(el, 'data', depth + 1, true);
      return en ? arrayOf(name, en) : null;
    }
    if (t.type !== 0x11 && t.type !== 0x12 && t.type !== 0x15) return null;
    const { ti, args } = this.defOf(t);
    if (ti < 0) return null;
    const full = this.fullName(ti);
    const td = this.md.typeDefs[ti];
    if (BUILTIN[full]) return BUILTIN[full](name);
    if (FROM_TPK[full]) {
      const n = this.fromTpk(FROM_TPK[full]);
      if (!n) throw new Unsupported(`no layout for ${full} in this Unity version`);
      return { ...n, name };
    }
    if (full === 'System.Collections.Generic.List`1') {
      if (inArray) return null;
      const en = this.nodeFor(args[0], 'data', depth + 1, true);
      return en ? arrayOf(name, en) : null;
    }
    if ((td.bitfield >> 1) & 1) {
      // enum: stored as its underlying integer
      for (let k = 0; k < td.field_count; k++) {
        const fd = this.md.fieldDefs[td.fieldStart + k];
        const ft = fd && this.model.typeAt(fd.typeIndex);
        if (ft && !(ft.attrs & 0x10) && PRIMS[ft.type]) return leaf(PRIMS[ft.type][0], name, PRIMS[ft.type][1] && !inArray);
      }
      return leaf('int', name);
    }
    if (t.type !== 0x11 && this.isUnityObject(ti)) return pptr(name, this.md.typeName(ti).replace(/`\d+$/, ''));
    const serializable = (td.flags & 0x2000) !== 0, isInterface = (td.flags & 0x20) !== 0, isAbstract = (td.flags & 0x80) !== 0;
    if (!serializable || isInterface || (isAbstract && t.type !== 0x11)) return null;
    if (/^System\./.test(full)) return null;
    return node(this.md.typeName(ti).replace(/`\d+$/, ''), name, this.fieldsOf(ti, args, depth + 1));
  }

  // Full layout for a MonoBehaviour / ScriptableObject whose script is type `ti`, or { error }.
  tree(ti) {
    if (this.cache.has(ti)) return this.cache.get(ti);
    let res;
    try {
      const base = classTree(this.tpk, 114, this.vkey);
      if (!base) throw new Unsupported('no MonoBehaviour layout for this Unity version');
      res = { tree: { ...base, children: [...base.children, ...this.fieldsOf(ti, [], 0)] } };
    } catch (err) {
      if (!(err instanceof Unsupported)) console.warn(err);
      res = { error: err.message };
    }
    this.cache.set(ti, res);
    return res;
  }
}

// ---------------- editable JSON <-> values ----------------
// floats are shown with the fewest digits that read back to the same 32-bit value
function shortFloat(v) {
  if (!Number.isFinite(v)) return v;
  for (let p = 1; p <= 9; p++) { const n = Number(v.toPrecision(p)); if (Math.fround(n) === v) return n; }
  return v;
}

export function toEditable(n, v) {
  const t = n.type;
  if (t === 'string') return typeof v === 'string' ? v : new TextDecoder().decode(v || new Uint8Array(0));
  if (t === 'float') return shortFloat(v);
  if (t === 'SInt64' || t === 'UInt64') return typeof v === 'bigint' ? (v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v.toString()) : v;
  if (v instanceof Uint8Array) return t === 'string' ? new TextDecoder().decode(v) : Array.from(v);
  if (t === 'pair') return [toEditable(n.children[0], v[0]), toEditable(n.children[1], v[1])];
  if (n.children.length && n.children[0].type === 'Array') { const sub = n.children[0].children[1]; return Array.from(v || [], (x) => toEditable(sub, x)); }
  if (n.children.length && v && typeof v === 'object') { const o = {}; for (const c of n.children) o[c.name] = toEditable(c, v[c.name]); return o; }
  return v;
}

const INT_RANGES = { SInt8: [-128, 127], UInt8: [0, 255], char: [0, 255], SInt16: [-32768, 32767], short: [-32768, 32767], UInt16: [0, 65535], 'unsigned short': [0, 65535], SInt32: [-2147483648, 2147483647], int: [-2147483648, 2147483647], UInt32: [0, 4294967295], 'unsigned int': [0, 4294967295] };

export function fromEditable(n, v, path = n.name) {
  const t = n.type;
  if (t === 'bool') return !!v;
  if (t === 'float' || t === 'double') { const x = Number(v); if (!Number.isFinite(x)) throw new Error(`${path} must be a number`); return x; }
  if (INT_RANGES[t]) {
    const x = Number(v), [lo, hi] = INT_RANGES[t];
    if (!Number.isInteger(x) || x < lo || x > hi) throw new Error(`${path} must be a whole number from ${lo} to ${hi}`);
    return x;
  }
  if (t === 'SInt64' || t === 'UInt64' || t === 'long long' || t === 'unsigned long long' || t === 'FileSize') {
    try { return BigInt(typeof v === 'number' ? Math.trunc(v) : String(v)); } catch { throw new Error(`${path} must be a whole number`); }
  }
  if (t === 'string') return typeof v === 'string' ? v : String(v ?? '');
  if (t === 'pair') return [fromEditable(n.children[0], v[0], path + '.first'), fromEditable(n.children[1], v[1], path + '.second')];
  if (n.children.length && n.children[0].type === 'Array') {
    if (!Array.isArray(v)) throw new Error(`${path} must be a list`);
    const sub = n.children[0].children[1];
    if (sub.type === 'UInt8' || sub.type === 'SInt8' || sub.type === 'char') return Uint8Array.from(v, (x) => Number(x) & 0xff);
    return v.map((x, k) => fromEditable(sub, x, `${path}[${k}]`));
  }
  if (n.children.length) {
    if (!v || typeof v !== 'object') throw new Error(`${path} must be an object`);
    const o = {};
    for (const c of n.children) {
      if (!(c.name in v)) throw new Error(`${path}.${c.name} is missing`);
      o[c.name] = fromEditable(c, v[c.name], `${path}.${c.name}`);
    }
    return o;
  }
  return v;
}

// ---------------- Mono builds: layouts from the managed assemblies ----------------

const CIL_PRIMS = {
  bool: ['bool', true], char: ['UInt16', true], sbyte: ['SInt8', true], byte: ['UInt8', true], short: ['SInt16', true], ushort: ['UInt16', true],
  int: ['int', false], uint: ['UInt32', false], long: ['SInt64', false], ulong: ['UInt64', false], float: ['float', false], double: ['double', false],
};

export class MonoLayouts {
  // loadModule(assemblyName) -> Promise<DotNetModule | null>
  constructor(loadModule, { tpk, vkey }) {
    this.load = loadModule;
    this.tpk = tpk;
    this.vkey = vkey;
    this.mods = new Map();
    this.names = new WeakMap();
    this.cache = new Map();
    this.objCache = new Map();
    this.tpkNodes = new Map();
  }

  get usable() { return true; }

  mod(asm) {
    const key = String(asm || '').replace(/\.dll$/i, '').toLowerCase();
    if (!this.mods.has(key)) this.mods.set(key, Promise.resolve().then(() => this.load(key)).catch(() => null));
    return this.mods.get(key);
  }

  typeIndex(mod) {
    let m = this.names.get(mod);
    if (!m) {
      m = new Map();
      const enclosing = mod.index().enclosing;
      for (let i = 1; i <= mod.count(MT.TypeDef); i++) {
        if (enclosing.has(i)) continue;
        const td = mod.row(MT.TypeDef, i);
        m.set(`${mod.str(td.Namespace)}|${mod.str(td.Name)}`, i);
      }
      this.names.set(mod, m);
    }
    return m;
  }

  key(h) { return `${h.mod.assemblyName().name}|${h.ti}`; }
  fullName(h) { const td = h.mod.row(MT.TypeDef, h.ti); const ns = h.mod.str(td.Namespace); return (ns ? ns + '.' : '') + h.mod.str(td.Name); }
  shortName(h) { return h.mod.str(h.mod.row(MT.TypeDef, h.ti).Name).replace(/`\d+$/, ''); }

  async findType(asm, ns, name) {
    const mod = await this.mod(asm);
    if (!mod) return -1;
    const ti = this.typeIndex(mod).get(`${ns || ''}|${name}`);
    return ti ? { mod, ti } : -1;
  }

  // a TypeDefOrRef reference in `mod`, followed into other assemblies and type forwards
  async resolve(mod, table, index) {
    if (!index) return null;
    if (table === MT.TypeDef) return { mod, ti: index };
    if (table !== MT.TypeRef) return null;
    const tr = mod.row(MT.TypeRef, index);
    const name = mod.str(tr.Name), ns = mod.str(tr.Namespace), scope = tr.ResolutionScope;
    if (scope.table === MT.TypeRef) {
      const outer = await this.resolve(mod, MT.TypeRef, scope.index);
      if (!outer) return null;
      const kids = outer.mod.index().nested.get(outer.ti) || [];
      const ti = kids.find((k) => outer.mod.str(outer.mod.row(MT.TypeDef, k).Name) === name);
      return ti ? { mod: outer.mod, ti } : null;
    }
    const target = scope.table === MT.AssemblyRef ? await this.mod(mod.str(mod.row(MT.AssemblyRef, scope.index).Name)) : mod;
    return target ? this.findIn(target, ns, name, 0) : null;
  }

  async findIn(mod, ns, name, depth) {
    const ti = this.typeIndex(mod).get(`${ns}|${name}`);
    if (ti) return { mod, ti };
    if (depth > 4) return null;
    for (let i = 1; i <= mod.count(MT.ExportedType); i++) {
      const et = mod.row(MT.ExportedType, i);
      if (mod.str(et.Name) !== name || mod.str(et.Namespace) !== ns || et.Implementation.table !== MT.AssemblyRef) continue;
      const m2 = await this.mod(mod.str(mod.row(MT.AssemblyRef, et.Implementation.index).Name));
      if (m2) return this.findIn(m2, ns, name, depth + 1);
    }
    return null;
  }

  // the base class of h with its generic arguments: { h, args } | null
  async baseOf(h, args) {
    const ext = h.mod.row(MT.TypeDef, h.ti).Extends;
    if (!ext || !ext.index) return null;
    if (ext.table === MT.TypeSpec) {
      const sig = parseSig(h.mod, h.mod.row(MT.TypeSpec, ext.index).Signature, 'typespec');
      if (sig.k !== 'generic') return null;
      const bh = await this.resolve(h.mod, sig.base.tok, sig.base.idx);
      return bh ? { h: bh, args: sig.args.map((a) => ({ sig: a, mod: h.mod, args })) } : null;
    }
    const bh = await this.resolve(h.mod, ext.table, ext.index);
    return bh ? { h: bh, args: [] } : null;
  }

  baseName(h) {
    const ext = h.mod.row(MT.TypeDef, h.ti).Extends;
    if (!ext || ext.table !== MT.TypeRef || !ext.index) return '';
    const tr = h.mod.row(MT.TypeRef, ext.index);
    return `${h.mod.str(tr.Namespace)}.${h.mod.str(tr.Name)}`;
  }

  async isUnityObject(h) {
    const k = this.key(h);
    if (this.objCache.has(k)) return this.objCache.get(k);
    let cur = h, result = false;
    for (let d = 0; d < 32 && cur; d++) {
      if (this.fullName(cur) === 'UnityEngine.Object') { result = true; break; }
      const b = await this.baseOf(cur, []);
      cur = b && b.h;
    }
    this.objCache.set(k, result);
    return result;
  }

  attrNames(mod, table, index) {
    const ix = mod.index();
    const names = new Set();
    for (const ca of ix.attrs.get(table * 16777216 + index) || []) {
      let owner = null;
      if (ca.Type.table === MT.MethodDef) owner = { table: MT.TypeDef, index: ix.methodOwner[ca.Type.index] };
      else if (ca.Type.table === MT.MemberRef) owner = mod.row(MT.MemberRef, ca.Type.index).Class;
      if (!owner || !owner.index) continue;
      if (owner.table === MT.TypeRef) names.add(mod.str(mod.row(MT.TypeRef, owner.index).Name));
      else if (owner.table === MT.TypeDef) names.add(mod.str(mod.row(MT.TypeDef, owner.index).Name));
    }
    return names;
  }

  fromTpk(typeName) { return ScriptLayouts.prototype.fromTpk.call(this, typeName); }

  async fieldsOf(h, args, depth) {
    if (depth > 8) throw new Unsupported('fields nest too deeply');
    const chain = [];
    let cur = { h, args };
    for (let d = 0; d < 32 && cur; d++) {
      const name = this.fullName(cur.h);
      if (/^UnityEngine\.(MonoBehaviour|ScriptableObject|Behaviour|Component|Object)$/.test(name) || name === 'System.Object' || name === 'System.ValueType') break;
      chain.push(cur);
      cur = await this.baseOf(cur.h, cur.args);
    }
    const out = [];
    for (const { h: t, args: a } of chain.reverse()) {
      const [fs, fe] = t.mod.listRange(MT.TypeDef, t.ti, 'FieldList', MT.Field);
      for (let fi = fs; fi < fe; fi++) {
        const f = t.mod.row(MT.Field, fi);
        if (f.Flags & 0x10 || f.Flags & 0x40 || f.Flags & 0x20 || f.Flags & 0x80) continue; // static, const, readonly, [NonSerialized]
        const names = this.attrNames(t.mod, MT.Field, fi);
        if (names.has('SerializeReference')) throw new Unsupported('[SerializeReference] fields are not supported yet');
        if ((f.Flags & 7) !== 6 && !names.has('SerializeField')) continue;
        const n = await this.nodeFor({ sig: parseSig(t.mod, f.Signature, 'field'), mod: t.mod, args: a }, t.mod.str(f.Name), depth, false);
        if (n) out.push(n);
      }
    }
    return out;
  }

  async nodeFor(t, name, depth, inArray) {
    const { sig, mod } = t;
    if (!sig) return null;
    if (sig.k === 'var') { const a = t.args && t.args[sig.n]; return a ? this.nodeFor(a, name, depth, inArray) : null; }
    if (sig.k === 'prim') {
      if (sig.name === 'string') return leaf('string', name);
      const p = CIL_PRIMS[sig.name];
      return p ? leaf(p[0], name, p[1] && !inArray) : null;
    }
    if (sig.k === 'szarray') {
      if (inArray) return null; // arrays of arrays are not serialized
      const en = await this.nodeFor({ sig: sig.t, mod, args: t.args }, 'data', depth + 1, true);
      return en ? arrayOf(name, en) : null;
    }
    let h = null, args = [];
    if (sig.k === 'generic') {
      h = await this.resolve(mod, sig.base.tok, sig.base.idx);
      args = sig.args.map((a) => ({ sig: a, mod, args: t.args }));
    } else if (sig.k === 'class' || sig.k === 'valuetype') h = await this.resolve(mod, sig.tok, sig.idx);
    if (!h) return null;
    const full = this.fullName(h);
    if (BUILTIN[full]) return BUILTIN[full](name);
    if (FROM_TPK[full]) {
      const n = this.fromTpk(FROM_TPK[full]);
      if (!n) throw new Unsupported(`no layout for ${full} in this Unity version`);
      return { ...n, name };
    }
    if (full === 'System.Collections.Generic.List`1') {
      if (inArray) return null;
      const en = await this.nodeFor(args[0], 'data', depth + 1, true);
      return en ? arrayOf(name, en) : null;
    }
    const td = h.mod.row(MT.TypeDef, h.ti);
    const base = this.baseName(h);
    if (base === 'System.Enum') {
      // enum: stored as its underlying integer
      const [fs, fe] = h.mod.listRange(MT.TypeDef, h.ti, 'FieldList', MT.Field);
      for (let fi = fs; fi < fe; fi++) {
        const f = h.mod.row(MT.Field, fi);
        if (f.Flags & 0x10) continue;
        const s = parseSig(h.mod, f.Signature, 'field');
        const p = s.k === 'prim' && CIL_PRIMS[s.name];
        if (p) return leaf(p[0], name, p[1] && !inArray);
      }
      return leaf('int', name);
    }
    const isValue = base === 'System.ValueType';
    if (!isValue && await this.isUnityObject(h)) return pptr(name, this.shortName(h));
    const serializable = (td.Flags & 0x2000) !== 0, isInterface = (td.Flags & 0x20) !== 0, isAbstract = (td.Flags & 0x80) !== 0;
    if (!serializable || isInterface || (isAbstract && !isValue)) return null;
    if (/^System\./.test(full)) return null;
    return node(this.shortName(h), name, await this.fieldsOf(h, args, depth + 1));
  }

  async tree(h) {
    const k = this.key(h);
    if (this.cache.has(k)) return this.cache.get(k);
    let res;
    try {
      const base = classTree(this.tpk, 114, this.vkey);
      if (!base) throw new Unsupported('no MonoBehaviour layout for this Unity version');
      res = { tree: { ...base, children: [...base.children, ...await this.fieldsOf(h, [], 0)] } };
    } catch (err) {
      if (!(err instanceof Unsupported)) console.warn(err);
      res = { error: err.message };
    }
    this.cache.set(k, res);
    return res;
  }
}
