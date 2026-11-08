// Godot Variant values: the binary-resource encoding (RSRC), the "marshalls" encoding
// (script constants, project.binary), and the text syntax of .tscn/.tres/.godot files.
//
// Values are plain JS:  null | boolean | string (String) |
//   {t:'int', v} | {t:'float', v, f32} | {t:'StringName', v} | {t:'NodePath', v} |
//   {t:'Vector2', v:[x,y]} (and every other math type) | {t:'Color', v:[r,g,b,a]} |
//   {t:'Object', ext:i} | {t:'Object', sub:id} | {t:'Object', path, type} | {t:'Object', cls, props} |
//   {t:'Array', v:[...], of?} | {t:'Dictionary', v:[[k, val], ...]} | {t:'Packed...Array', v: typed array | []}
import { utf8 } from '../../util/binary.js';

const MATH = {
  Vector2: 2, Rect2: 4, Vector3: 3, Plane: 4, Quaternion: 4, AABB: 6, Basis: 9, Transform3D: 12, Transform2D: 6,
  Vector4: 4, Projection: 16, Color: 4,
};
const MATHI = { Vector2i: 2, Rect2i: 4, Vector3i: 3, Vector4i: 4 };

// ---------------- binary resource (RSRC) ----------------
const RES = {
  1: 'nil', 2: 'bool', 3: 'int', 4: 'float', 5: 'String', 10: 'Vector2', 11: 'Rect2', 12: 'Vector3', 13: 'Plane', 14: 'Quaternion', 15: 'AABB',
  16: 'Basis', 17: 'Transform3D', 18: 'Transform2D', 20: 'Color', 21: 'Image', 22: 'NodePath', 23: 'RID', 24: 'Object', 25: 'InputEvent',
  26: 'Dictionary', 30: 'Array', 31: 'PackedByteArray', 32: 'PackedInt32Array', 33: 'PackedFloat32Array', 34: 'PackedStringArray',
  35: 'PackedVector3Array', 36: 'PackedColorArray', 37: 'PackedVector2Array', 40: 'int64', 41: 'double', 42: 'Callable', 43: 'Signal',
  44: 'StringName', 45: 'Vector2i', 46: 'Rect2i', 47: 'Vector3i', 48: 'PackedInt64Array', 49: 'PackedFloat64Array', 50: 'Vector4',
  51: 'Vector4i', 52: 'Projection', 53: 'PackedVector4Array',
};

// rd: { r: Reader, real64, fmt (ver_format), strings, intIds (index -> id), resPath }
export function readResVariant(rd) {
  const r = rd.r;
  const real = () => (rd.real64 ? r.f64() : r.f32());
  const nreal = (n) => { const a = new Array(n); for (let i = 0; i < n; i++) a[i] = real(); return a; };
  const t = r.u32();
  const name = RES[t];
  switch (name) {
    case 'nil': return null;
    case 'bool': return r.u32() !== 0;
    case 'int': return { t: 'int', v: r.i32() };
    case 'int64': { const v = r.i64big(); return { t: 'int', v: v >= -9007199254740991n && v <= 9007199254740991n ? Number(v) : v }; }
    case 'float': return { t: 'float', v: real(), f32: !rd.real64 };
    case 'double': return { t: 'float', v: r.f64() };
    case 'String': return ustr(r);
    case 'StringName': return { t: 'StringName', v: ustr(r) };
    case 'Color': return { t: 'Color', v: [r.f32(), r.f32(), r.f32(), r.f32()], f32: true };
    case 'NodePath': {
      const nameCount = r.u16();
      let subCount = r.u16();
      const absolute = !!(subCount & 0x8000);
      subCount &= 0x7fff;
      if (rd.fmt < 3) subCount += 1;
      const names = [], subs = [];
      for (let i = 0; i < nameCount; i++) names.push(getString(rd));
      for (let i = 0; i < subCount; i++) subs.push(getString(rd));
      return { t: 'NodePath', v: nodePathText(names, subs.filter((s) => s !== ''), absolute) };
    }
    case 'RID': return { t: 'RID', v: r.u32() };
    case 'Object': {
      const ot = r.u32();
      if (ot === 0) return null;
      if (ot === 2) { const i = r.u32(); return { t: 'Object', sub: rd.intIds ? rd.intIds[i] ?? i : i }; }
      if (ot === 1) { const type = ustr(r); const path = ustr(r); return { t: 'Object', path, type }; }
      if (ot === 3) return { t: 'Object', ext: r.u32() };
      throw new Error('bad object reference');
    }
    case 'InputEvent': return null;
    case 'Callable': return { t: 'Callable' };
    case 'Signal': return { t: 'Signal' };
    case 'Dictionary': {
      const n = r.u32() & 0x7fffffff;
      const out = [];
      for (let i = 0; i < n; i++) { const k = readResVariant(rd); out.push([k, readResVariant(rd)]); }
      return { t: 'Dictionary', v: out };
    }
    case 'Array': {
      const n = r.u32() & 0x7fffffff;
      const out = new Array(n);
      for (let i = 0; i < n; i++) out[i] = readResVariant(rd);
      return { t: 'Array', v: out };
    }
    case 'PackedByteArray': { const n = r.u32(); const v = r.copy(n); r.align(4); return { t: name, v }; }
    case 'PackedInt32Array': { const n = r.u32(); const v = new Int32Array(n); for (let i = 0; i < n; i++) v[i] = r.i32(); return { t: name, v }; }
    case 'PackedInt64Array': { const n = r.u32(); const v = []; for (let i = 0; i < n; i++) v.push(r.i64big()); return { t: name, v }; }
    case 'PackedFloat32Array': { const n = r.u32(); const v = new Float32Array(n); for (let i = 0; i < n; i++) v[i] = r.f32(); return { t: name, v }; }
    case 'PackedFloat64Array': { const n = r.u32(); const v = new Float64Array(n); for (let i = 0; i < n; i++) v[i] = r.f64(); return { t: name, v }; }
    case 'PackedStringArray': { const n = r.u32(); const v = []; for (let i = 0; i < n; i++) v.push(ustr(r)); return { t: name, v }; }
    case 'PackedVector2Array': { const n = r.u32(); return { t: name, v: Float64Array.from(nreal(n * 2)), f32: !rd.real64 }; }
    case 'PackedVector3Array': { const n = r.u32(); return { t: name, v: Float64Array.from(nreal(n * 3)), f32: !rd.real64 }; }
    case 'PackedVector4Array': { const n = r.u32(); return { t: name, v: Float64Array.from(nreal(n * 4)), f32: !rd.real64 }; }
    case 'PackedColorArray': { const n = r.u32(); const v = new Float32Array(n * 4); for (let i = 0; i < n * 4; i++) v[i] = r.f32(); return { t: name, v, f32: true }; }
    case 'Image': return readOldImage(r);
    default:
      if (MATH[name]) return { t: name, v: nreal(MATH[name]), f32: !rd.real64 };
      if (MATHI[name]) { const n = MATHI[name]; const v = []; for (let i = 0; i < n; i++) v.push(r.i32()); return { t: name, v }; }
      throw new Error(`unknown variant type ${t}`);
  }
}

// Godot 2/early-3 resources could embed raw images; keep only the size so the rest still parses.
function readOldImage(r) {
  const enc = r.u32();
  if (enc === 0) return null;
  if (enc === 1) { const w = r.u32(), h = r.u32(); r.u32(); r.u32(); const n = r.u32(); r.skip(n); r.align(4); return { t: 'Image', v: `${w}x${h}` }; }
  const n = r.u32(); r.skip(n); r.align(4);
  return { t: 'Image', v: 'compressed' };
}

function ustr(r) {
  const n = r.u32();
  if (!n) return '';
  const b = r.bytes(n);
  let end = b.length;
  while (end > 0 && b[end - 1] === 0) end--;
  return utf8(b.subarray(0, end));
}
export { ustr as readUString };

function getString(rd) {
  const id = rd.r.u32();
  if (id & 0x80000000) { const n = id & 0x7fffffff; return n ? utf8(rd.r.bytes(n)) : ''; }
  return rd.strings[id] ?? '';
}

function nodePathText(names, subs, absolute) {
  return (absolute ? '/' : '') + names.join('/') + (subs.length ? ':' + subs.join(':') : '');
}

// ---------------- marshalls ----------------
const M4 = ['nil', 'bool', 'int', 'float', 'String', 'Vector2', 'Vector2i', 'Rect2', 'Rect2i', 'Vector3', 'Vector3i', 'Transform2D', 'Vector4', 'Vector4i',
  'Plane', 'Quaternion', 'AABB', 'Basis', 'Transform3D', 'Projection', 'Color', 'StringName', 'NodePath', 'RID', 'Object', 'Callable', 'Signal',
  'Dictionary', 'Array', 'PackedByteArray', 'PackedInt32Array', 'PackedInt64Array', 'PackedFloat32Array', 'PackedFloat64Array', 'PackedStringArray',
  'PackedVector2Array', 'PackedVector3Array', 'PackedColorArray', 'PackedVector4Array'];
const M3 = ['nil', 'bool', 'int', 'float', 'String', 'Vector2', 'Rect2', 'Vector3', 'Transform2D', 'Plane', 'Quaternion', 'AABB', 'Basis', 'Transform3D',
  'Color', 'NodePath', 'RID', 'Object', 'Dictionary', 'Array', 'PackedByteArray', 'PackedInt32Array', 'PackedFloat32Array', 'PackedStringArray',
  'PackedVector2Array', 'PackedVector3Array', 'PackedColorArray'];
export const VARIANT_NAMES = { 3: M3, 4: M4 };

function mstr(r) {
  const n = r.u32();
  const s = utf8(r.bytes(n));
  r.align(4);
  return s;
}

// r must be little-endian. major: 3 or 4.
export function readMarshal(r, major) {
  const header = r.u32();
  const type = (major >= 4 ? M4 : M3)[header & 0xff];
  const f64 = !!(header & (1 << 16));
  const real = () => (f64 ? r.f64() : r.f32());
  const nreal = (n) => { const a = []; for (let i = 0; i < n; i++) a.push(real()); return a; };
  switch (type) {
    case 'nil': return null;
    case 'bool': return r.u32() !== 0;
    case 'int': return { t: 'int', v: f64 ? r.i64() : r.i32() };
    case 'float': return { t: 'float', v: real(), f32: !f64 };
    case 'String': return mstr(r);
    case 'StringName': return { t: 'StringName', v: mstr(r) };
    case 'Color': return { t: 'Color', v: [r.f32(), r.f32(), r.f32(), r.f32()], f32: true };
    case 'NodePath': {
      const n = r.u32();
      if (n & 0x80000000) {
        const names = n & 0x7fffffff;
        let subs = r.u32();
        const flags = r.u32();
        if (flags & 2) subs++;
        const all = [];
        for (let i = 0; i < names + subs; i++) all.push(mstr(r));
        return { t: 'NodePath', v: nodePathText(all.slice(0, names), all.slice(names).filter(Boolean), !!(flags & 1)) };
      }
      const s = utf8(r.bytes(n)); r.align(4);
      return { t: 'NodePath', v: s };
    }
    case 'RID': return { t: 'RID', v: major >= 4 ? r.u64() : 0 };
    case 'Object': {
      if (header & (1 << 16)) return { t: 'Object', id: r.u64() };
      const cls = mstr(r);
      if (!cls) return null;
      const n = r.u32();
      const props = [];
      for (let i = 0; i < n; i++) { const k = mstr(r); props.push([k, readMarshal(r, major)]); }
      return { t: 'Object', cls, props };
    }
    case 'Callable': return { t: 'Callable' };
    case 'Signal': { mstr(r); r.u64(); return { t: 'Signal' }; }
    case 'Dictionary': {
      if (major >= 4) { typeInfo(r, (header >> 16) & 3); typeInfo(r, (header >> 18) & 3); }
      const n = r.u32() & 0x7fffffff;
      const out = [];
      for (let i = 0; i < n; i++) { const k = readMarshal(r, major); out.push([k, readMarshal(r, major)]); }
      return { t: 'Dictionary', v: out };
    }
    case 'Array': {
      const of = major >= 4 ? typeInfo(r, (header >> 16) & 3) : null;
      const n = r.u32() & 0x7fffffff;
      const out = [];
      for (let i = 0; i < n; i++) out.push(readMarshal(r, major));
      return { t: 'Array', v: out, of };
    }
    case 'PackedByteArray': { const n = r.u32(); const v = r.copy(n); r.align(4); return { t: type, v }; }
    case 'PackedInt32Array': { const n = r.u32(); const v = new Int32Array(n); for (let i = 0; i < n; i++) v[i] = r.i32(); return { t: type, v }; }
    case 'PackedInt64Array': { const n = r.u32(); const v = []; for (let i = 0; i < n; i++) v.push(r.i64big()); return { t: type, v }; }
    case 'PackedFloat32Array': { const n = r.u32(); const v = new Float32Array(n); for (let i = 0; i < n; i++) v[i] = r.f32(); return { t: type, v }; }
    case 'PackedFloat64Array': { const n = r.u32(); const v = new Float64Array(n); for (let i = 0; i < n; i++) v[i] = r.f64(); return { t: type, v }; }
    case 'PackedStringArray': { const n = r.u32(); const v = []; for (let i = 0; i < n; i++) v.push(mstr(r)); return { t: type, v }; }
    case 'PackedVector2Array': { const n = r.u32(); return { t: type, v: Float64Array.from(nreal(n * 2)), f32: !f64 }; }
    case 'PackedVector3Array': { const n = r.u32(); return { t: type, v: Float64Array.from(nreal(n * 3)), f32: !f64 }; }
    case 'PackedVector4Array': { const n = r.u32(); return { t: type, v: Float64Array.from(nreal(n * 4)), f32: !f64 }; }
    case 'PackedColorArray': { const n = r.u32(); const v = new Float32Array(n * 4); for (let i = 0; i < n * 4; i++) v[i] = r.f32(); return { t: type, v, f32: true }; }
    default:
      if (MATH[type]) return { t: type, v: nreal(MATH[type]), f32: !f64 };
      if (MATHI[type]) { const v = []; for (let i = 0; i < MATHI[type]; i++) v.push(r.i32()); return { t: type, v }; }
      throw new Error(`unknown variant type ${header & 0xff}`);
  }
}

function typeInfo(r, kind) {
  if (kind === 1) return { builtin: M4[r.u32()] };
  if (kind === 2) return { cls: mstr(r) };
  if (kind === 3) return { script: mstr(r) };
  return null;
}

// ---------------- text ----------------
const NAMES3 = {
  Quaternion: 'Quat', Transform3D: 'Transform', PackedByteArray: 'PoolByteArray', PackedInt32Array: 'PoolIntArray', PackedFloat32Array: 'PoolRealArray',
  PackedStringArray: 'PoolStringArray', PackedVector2Array: 'PoolVector2Array', PackedVector3Array: 'PoolVector3Array', PackedColorArray: 'PoolColorArray',
  PackedInt64Array: 'PoolIntArray', PackedFloat64Array: 'PoolRealArray',
};
export const typeName = (t, major) => (major < 4 && NAMES3[t]) || t;

export function quote(s) {
  return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
}

// float as Godot writes it; `f32` trims single-precision noise (0.1 instead of 0.10000000149)
export function num(x, f32, scalar) {
  if (typeof x === 'bigint') return x.toString();
  if (Number.isNaN(x)) return 'nan';
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  let s = f32 ? String(parseFloat(x.toPrecision(7))) : String(x);
  if (/e/.test(s)) s = s.replace('e+', 'e+').replace(/e(-?)0*(\d)/, 'e$1$2');
  if (scalar && !/[.e]/.test(s)) s += '.0';
  return s;
}

// opts: { major, ext(i) -> id text, sub(id) -> id text, indent }
export function vtext(v, opts) {
  const major = opts.major;
  const sp = major < 4 ? ' ' : '';
  const call = (name, args) => (args.length ? `${typeName(name, major)}(${sp}${args.join(', ')}${sp})` : `${typeName(name, major)}()`);
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return quote(v);
  switch (v.t) {
    case 'int': return String(v.v);
    case 'float': return num(v.v, v.f32, true);
    case 'StringName': return major >= 4 ? '&' + quote(v.v) : quote(v.v);
    case 'NodePath': return `NodePath(${quote(v.v)})`;
    case 'RID': return major >= 4 ? 'RID()' : 'RID( )';
    case 'Callable': return 'Callable()';
    case 'Signal': return 'Signal()';
    case 'Image': return 'null';
    case 'Object': {
      if (v.ext != null) return major >= 4 ? `ExtResource(${quote(opts.ext(v.ext))})` : `ExtResource( ${opts.ext(v.ext)} )`;
      if (v.sub != null) return major >= 4 ? `SubResource(${quote(opts.sub(v.sub))})` : `SubResource( ${opts.sub(v.sub)} )`;
      if (v.path != null) return major >= 4 ? `Resource(${quote(v.path)})` : `Resource( ${quote(v.path)} )`;
      if (v.cls) return `Object(${v.cls},${v.props.map(([k, x]) => `${quote(k)}:${vtext(x, opts)}`).join(',')})`;
      return 'null';
    }
    case 'Array': {
      const items = v.v.map((x) => vtext(x, opts));
      const body = items.length ? `[${sp}${items.join(', ')}${sp}]` : '[]';
      const of = v.of && (v.of.builtin || v.of.cls);
      return major >= 4 && of ? `Array[${of}](${body})` : body;
    }
    case 'Dictionary': {
      if (!v.v.length) return '{}';
      return `{\n${v.v.map(([k, x]) => `${vtext(k, opts)}: ${vtext(x, opts)}`).join(',\n')}\n}`;
    }
    case 'Color': return call('Color', v.v.map((x) => num(x, true)));
    case 'PackedByteArray': case 'PackedInt32Array': case 'PackedInt64Array': return call(v.t, Array.from(v.v, String));
    case 'PackedFloat32Array': return call(v.t, Array.from(v.v, (x) => num(x, true)));
    case 'PackedFloat64Array': return call(v.t, Array.from(v.v, (x) => num(x, false)));
    case 'PackedStringArray': return call(v.t, v.v.map(quote));
    case 'PackedVector2Array': case 'PackedVector3Array': case 'PackedVector4Array': case 'PackedColorArray': return call(v.t, Array.from(v.v, (x) => num(x, v.f32)));
    default:
      if (MATH[v.t] || MATHI[v.t]) return call(v.t, v.v.map((x) => num(x, v.f32)));
      return 'null';
  }
}

// GDScript literal for a script constant (strings use GDScript escapes)
export function gdLiteral(v, major) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'boolean') return String(v);
  if (typeof v === 'string') return gdString(v);
  switch (v.t) {
    case 'int': return String(v.v);
    case 'float': return num(v.v, false, true);
    case 'StringName': return '&' + gdString(v.v);
    case 'NodePath': return '^' + gdString(v.v);
    default: return vtext(v, { major, ext: String, sub: String });
  }
}

function gdString(s) {
  return '"' + s.replace(/[\\"\n\r\t\0\b\f\v]/g, (c) => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\0': '\\0', '\b': '\\b', '\f': '\\f', '\v': '\\v' }[c])) + '"';
}
