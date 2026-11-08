// IL2CPP global-metadata.dat reader (v24 - v31+) and C# class dump generator.
// Struct layouts follow Il2CppDumper (MIT). Type names need the compiled
// binary: WebAssembly (WebGL) memory or a PE (GameAssembly.dll).
import { Reader, latin1 } from '../../util/binary.js';

// Section order of Il2CppGlobalMetadataHeader: [name, minVersion, maxVersion]. From v38 every
// section is {offset, size, count}; before that {offset, size}.
const SECTIONS = [
  ['stringLiteral'], ['stringLiteralData'], ['string'], ['events'], ['properties'], ['methods'], ['parameterDefaultValues'], ['fieldDefaultValues'],
  ['fieldAndParameterDefaultValueData'], ['fieldMarshaledSizes'], ['parameters'], ['fields'], ['genericParameters'], ['genericParameterConstraints'],
  ['genericContainers'], ['nestedTypes'], ['interfaces'], ['vtableMethods'], ['interfaceOffsets'], ['typeDefinitions'],
  ['typeInlineArrays', 104], ['rgctxEntries', 0, 24.1], ['images'], ['assemblies'],
  ['metadataUsageLists', 19, 24.5], ['metadataUsagePairs', 19, 24.5], ['fieldRefs', 19], ['referencedAssemblies', 20],
  ['attributesInfo', 21, 27.2], ['attributeTypes', 21, 27.2], ['attributeData', 29], ['attributeDataRange', 29],
  ['unresolvedVirtualCallParameterTypes', 22], ['unresolvedVirtualCallParameterRanges', 22], ['windowsRuntimeTypeNames', 23],
  ['windowsRuntimeStrings', 27], ['exportedTypeDefinitions', 24],
  ['methodSpecsOnGenericType', 108], ['genericMethodSpecsOnType', 108], ['methodSpecs', 108], ['genericMethodFunctionsDefinitions', 108],
  ['genericMethodFunctionsDefinitionsWithAdjustor', 108], ['invokerIndices', 108], ['rgctxRanges', 108], ['rgctxValues', 108], ['staticConstructorTypeIndices', 108],
];

// Record layouts: [name, type, minVersion, maxVersion]. Types are fixed-size ints, or (from v38)
// an index whose width depends on the size of the table it points into:
//   td type definition, gc generic container, type Il2CppType, param parameter, io interface offset,
//   ev event, pr property, nt nested type, m method, gp generic parameter, f field, dv default value data
const IMAGE = [['nameIndex', 'u32'], ['assemblyIndex', 'i32'], ['typeStart', 'td'], ['typeCount', 'u32'], ['exportedTypeStart', 'td', 24], ['exportedTypeCount', 'u32', 24],
  ['entryPointIndex', 'm'], ['token', 'u32', 19], ['customAttributeStart', 'i32', 24.1], ['customAttributeCount', 'u32', 24.1],
  ['invokerIndicesStart', 'i32', 108], ['rgctxRangesStart', 'i32', 108], ['rgctxRangesCount', 'u32', 108], ['staticConstructorStart', 'td', 108], ['staticConstructorCount', 'u32', 108]];
const TYPEDEF = [
  ['nameIndex', 'u32'], ['namespaceIndex', 'u32'], ['customAttributeIndex', 'i32', 0, 24], ['byvalTypeIndex', 'type'], ['byrefTypeIndex', 'i32', 0, 24.5],
  ['declaringTypeIndex', 'type'], ['parentIndex', 'type'], ['elementTypeIndex', 'i32', 0, 34.9], ['rgctxStartIndex', 'i32', 0, 24.1], ['rgctxCount', 'i32', 0, 24.1],
  ['genericContainerIndex', 'gc'], ['delegateWrapperFromManagedToNativeIndex', 'i32', 0, 22], ['marshalingFunctionsIndex', 'i32', 0, 22],
  ['ccwFunctionIndex', 'i32', 21, 22], ['guidIndex', 'i32', 21, 22], ['flags', 'u32'], ['fieldStart', 'f'], ['methodStart', 'm'], ['eventStart', 'ev'], ['propertyStart', 'pr'],
  ['nestedTypesStart', 'nt'], ['interfacesStart', 'io'], ['vtableStart', 'i32'], ['interfaceOffsetsStart', 'io'], ['method_count', 'u16'], ['property_count', 'u16'],
  ['field_count', 'u16'], ['event_count', 'u16'], ['nested_type_count', 'u16'], ['vtable_count', 'u16'], ['interfaces_count', 'u16'], ['interface_offsets_count', 'u16'],
  ['bitfield', 'u32'], ['token', 'u32', 19],
];
const METHOD = [['nameIndex', 'u32'], ['declaringType', 'td'], ['returnType', 'type'], ['returnParameterToken', 'u32', 31], ['parameterStart', 'param'],
  ['customAttributeIndex', 'i32', 0, 24], ['genericContainerIndex', 'gc'], ['methodIndex', 'i32', 0, 24.1], ['invokerIndex', 'i32', 0, 24.1], ['delegateWrapperIndex', 'i32', 0, 24.1],
  ['rgctxStartIndex', 'i32', 0, 24.1], ['rgctxCount', 'i32', 0, 24.1], ['token', 'u32'], ['flags', 'u16'], ['iflags', 'u16'], ['slot', 'u16'], ['parameterCount', 'u16']];
const PARAM = [['nameIndex', 'u32'], ['token', 'u32'], ['customAttributeIndex', 'i32', 0, 24], ['typeIndex', 'type']];
const FIELD = [['nameIndex', 'u32'], ['typeIndex', 'type'], ['customAttributeIndex', 'i32', 0, 24], ['token', 'u32', 19]];
const PROPERTY = [['nameIndex', 'u32'], ['get', 'm'], ['set', 'm'], ['attrs', 'u32'], ['customAttributeIndex', 'i32', 0, 24], ['token', 'u32', 19]];
const EVENT = [['nameIndex', 'u32'], ['typeIndex', 'type'], ['add', 'm'], ['remove', 'm'], ['raise', 'm'], ['customAttributeIndex', 'i32', 0, 24], ['token', 'u32', 19]];
const FIELD_DEFVAL = [['index', 'f'], ['typeIndex', 'type'], ['dataIndex', 'dv']];
const PARAM_DEFVAL = [['index', 'param'], ['typeIndex', 'type'], ['dataIndex', 'dv']];
const STRLIT = [['length', 'u32', 0, 34.9], ['dataIndex', 'i32']];
const GCONTAINER = [['ownerIndex', 'i32'], ['type_argc', 'i32', 0, 105.9], ['is_method', 'i32', 0, 105.9], ['type_argc', 'u16', 106], ['is_method', 'u8', 106], ['genericParameterStart', 'gp']];
const GPARAM = [['ownerIndex', 'gc'], ['nameIndex', 'u32'], ['constraintsStart', 'i16'], ['constraintsCount', 'i16'], ['num', 'u16'], ['flags', 'u16']];

const FIXED = { u32: 4, i32: 4, u16: 2, i16: 2, u8: 1 };
const widthFor = (n) => (n <= 0xff ? 1 : n <= 0xffff ? 2 : 4);

function compile(spec, v, W) {
  const out = [];
  let size = 0;
  for (const [name, type, min = 0, max = 9999] of spec) {
    if (v < min || v > max) continue;
    const w = FIXED[type] || W[type] || 4;
    out.push([name, type, w]);
    size += w;
  }
  return { fields: out, size };
}

// Read `count` records (or as many as `byteSize` holds) of a layout, checking bounds first.
function readRecords(dv, offset, byteSize, count, spec, v, W, what) {
  const L = compile(spec, v, W);
  const n = count != null ? count : Math.floor(byteSize / L.size);
  if (n < 0 || offset < 0 || offset + n * L.size > dv.byteLength) throw new Error(`the ${what} table lies outside the file`);
  const arr = new Array(n);
  let o = offset;
  for (let i = 0; i < n; i++) {
    const rec = {};
    for (const [name, type, w] of L.fields) {
      let val;
      switch (type) {
        case 'u32': val = dv.getUint32(o, true); break;
        case 'i32': val = dv.getInt32(o, true); break;
        case 'u16': val = dv.getUint16(o, true); break;
        case 'i16': val = dv.getInt16(o, true); break;
        case 'u8': val = dv.getUint8(o); break;
        default:
          if (w === 1) { val = dv.getUint8(o); if (val === 0xff) val = -1; }
          else if (w === 2) { val = dv.getUint16(o, true); if (val === 0xffff) val = -1; }
          else val = dv.getInt32(o, true);
      }
      rec[name] = val;
      o += w;
    }
    arr[i] = rec;
  }
  return arr;
}

function readHeader(dv, v) {
  const h = { sanity: dv.getUint32(0, true), version: dv.getInt32(4, true), positions: {} };
  const triple = v >= 38;
  let p = 8;
  for (const [name, min = 0, max = 9999] of SECTIONS) {
    if (v < min || v > max) continue;
    h.positions[name] = p;
    h[name + 'Offset'] = dv.getUint32(p, true);
    h[name + 'Size'] = dv.getInt32(p + 4, true);
    if (triple) { h[name + 'Count'] = dv.getInt32(p + 8, true); p += 12; } else p += 8;
  }
  h.size = p;
  return h;
}

// Layouts this reader knows. A file's version number picks the first one to try; if that layout
// doesn't fit the file (tables of the wrong size, indices pointing nowhere), the others are tried.
const KNOWN_LAYOUTS = [24, 24.1, 24.2, 27, 29, 31, 35, 38, 39, 104, 105, 106, 108];

function firstLayouts(raw, dv) {
  if (raw === 24) {
    // 24.2+ dropped the rgctx section, which makes the header 8 bytes shorter
    return dv.getUint32(8, true) === 264 ? [24.2] : [24.1, 24];
  }
  if (raw === 107) return [106]; // v107 reads like v106
  if (raw > 108) return [108];
  return KNOWN_LAYOUTS.includes(raw) ? [raw] : [];
}

export function parseMetadata(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < 64 || dv.getUint32(0, true) !== 0xfab11baf) throw new Error('not an IL2CPP metadata file (it may be encrypted)');
  const rawVersion = dv.getInt32(4, true);
  if (rawVersion < 16 || rawVersion > 400) throw new Error(`unexpected metadata version ${rawVersion}`);
  const first = firstLayouts(rawVersion, dv);
  const near = rawVersion > 108 ? 108 : rawVersion;
  const rest = KNOWN_LAYOUTS.filter((v) => !first.includes(v)).sort((a, b) => Math.abs(a - near) - Math.abs(b - near));
  let best = null, firstError = null;
  for (const v of [...first, ...rest]) {
    for (const typeWidth of v >= 38 ? [0, 4, 2, 1] : [0]) {
      let md;
      try { md = readMetadataAs(u8, dv, rawVersion, v, typeWidth); } catch (err) { if (!firstError) firstError = err; continue; }
      if (!best || md.fit > best.fit) best = md;
      if (md.fit >= 0.995) break;
    }
    if (best && best.fit >= 0.995) break;
  }
  if (!best || best.fit < 0.9) {
    throw firstError && !best ? firstError : new Error(`metadata v${rawVersion} could not be read: no known layout fits it (it may be protected or a newer format)`);
  }
  best.guessed = !first.includes(best.version);
  return best;
}

// How well a parsed layout fits the file: the share of sampled records whose indices make sense.
function layoutFit(md) {
  const { u8, header } = md;
  const strStart = header.stringOffset, strSize = header.stringSize;
  const nameOk = (i) => i >= 0 && i < strSize && (i === 0 || u8[strStart + i - 1] === 0);
  const nt = md.typeDefs.length, nm = md.methodDefs.length, nf = md.fieldDefs.length, np = md.paramDefs.length;
  if (!nt || !md.images.length) return 0;
  let ok = 0, all = 0;
  const check = (c) => { all++; if (c) ok++; };
  // the header ends where the first section starts
  check(header.stringLiteralOffset === header.size);
  for (const im of md.images) check(nameOk(im.nameIndex) && im.typeStart >= 0 && im.typeStart + im.typeCount <= nt);
  // from v38 every section says how many records it holds
  if (md.version >= 38) {
    for (const [name, arr] of [['typeDefinitions', md.typeDefs], ['methods', md.methodDefs], ['fields', md.fieldDefs], ['parameters', md.paramDefs], ['images', md.images]]) {
      check(arr.length * (md.recordSizes[name] || 0) === header[name + 'Size']);
    }
  } else {
    for (const name of ['typeDefinitions', 'methods', 'fields', 'parameters', 'images']) check(md.recordSizes[name] && header[name + 'Size'] % md.recordSizes[name] === 0);
  }
  const sample = (n, f) => { const step = Math.max(1, Math.floor(n / 3000)); for (let i = 0; i < n; i += step) f(i); };
  sample(nt, (i) => {
    const t = md.typeDefs[i];
    check(nameOk(t.nameIndex) && nameOk(t.namespaceIndex));
    if (t.method_count) check(t.methodStart >= 0 && t.methodStart + t.method_count <= nm);
    if (t.field_count) check(t.fieldStart >= 0 && t.fieldStart + t.field_count <= nf);
  });
  sample(nm, (i) => {
    const m = md.methodDefs[i];
    check(nameOk(m.nameIndex) && m.declaringType >= 0 && m.declaringType < nt && (!m.parameterCount || (m.parameterStart >= 0 && m.parameterStart + m.parameterCount <= np)));
  });
  sample(nf, (i) => check(nameOk(md.fieldDefs[i].nameIndex)));
  sample(np, (i) => check(nameOk(md.paramDefs[i].nameIndex)));
  return all ? ok / all : 0;
}

function readMetadataAs(u8, dv, rawVersion, v, typeWidth) {
  const header = readHeader(dv, v);
  if (header.stringLiteralOffset && header.stringLiteralOffset < header.size) throw new Error(`metadata v${rawVersion} has a header layout ReSourcefy doesn't know`);
  for (const [name, min = 0, max = 9999] of SECTIONS) {
    if (v < min || v > max) continue;
    const off = header[name + 'Offset'], size = header[name + 'Size'];
    if (!size) continue;
    if (size < 0 || off + size > u8.length) throw new Error(`metadata v${rawVersion}: section ${name} lies outside the file (unsupported layout or protected metadata)`);
  }
  // index widths (v38+: sized by the table they point into)
  const W = {};
  if (v >= 38) {
    const c = (n) => header[n + 'Count'] || 0;
    W.td = widthFor(c('typeDefinitions'));
    W.gc = widthFor(c('genericContainers'));
    // an interface offset is {type index, int32 offset}, which gives away the width of type indices
    W.type = typeWidth || (c('interfaceOffsets') > 0 ? header.interfaceOffsetsSize / c('interfaceOffsets') - 4 : 4);
    if (![1, 2, 4].includes(W.type)) W.type = 4;
    W.param = v >= 39 ? widthFor(c('parameters')) : 4;
    W.io = v >= 104 ? widthFor(c('interfaceOffsets')) : 4;
    W.ev = v >= 104 ? widthFor(c('events')) : 4;
    W.pr = v >= 104 ? widthFor(c('properties')) : 4;
    W.nt = v >= 104 ? widthFor(c('nestedTypes')) : 4;
    W.m = v >= 105 ? widthFor(c('methods')) : 4;
    W.gp = v >= 106 ? widthFor(c('genericParameters')) : 4;
    W.f = v >= 106 ? widthFor(c('fields')) : 4;
    W.dv = v >= 106 ? widthFor(c('fieldAndParameterDefaultValueData')) : 4;
  }
  const cnt = (name) => (v >= 38 ? header[name + 'Count'] : null);
  const recordSizes = {};
  const table = (name, spec, what) => {
    recordSizes[name] = compile(spec, v, W).size;
    return readRecords(dv, header[name + 'Offset'], header[name + 'Size'], cnt(name), spec, v, W, what);
  };
  const md = { u8, dv, rawVersion, version: v, header, widths: W, recordSizes };
  md.images = table('images', IMAGE, 'image');
  md.typeDefs = table('typeDefinitions', TYPEDEF, 'type');
  md.methodDefs = table('methods', METHOD, 'method');
  md.paramDefs = table('parameters', PARAM, 'parameter');
  md.fieldDefs = table('fields', FIELD, 'field');
  // a wrong layout shows up in these tables already; skip the rest when they don't fit
  md.fit = layoutFit(md);
  if (md.fit < 0.9) return md;
  md.propertyDefs = table('properties', PROPERTY, 'property');
  md.eventDefs = table('events', EVENT, 'event');
  md.fieldDefaults = new Map(table('fieldDefaultValues', FIELD_DEFVAL, 'field default value').map((x) => [x.index, x]));
  md.paramDefaults = new Map(table('parameterDefaultValues', PARAM_DEFVAL, 'parameter default value').map((x) => [x.index, x]));
  md.stringLiterals = table('stringLiteral', STRLIT, 'string literal');
  if (v >= 35) {
    // lengths are implied by where the next literal starts
    const lits = md.stringLiterals;
    for (let i = 0; i < lits.length; i++) lits[i].length = (i + 1 < lits.length ? lits[i + 1].dataIndex : header.stringLiteralDataSize) - lits[i].dataIndex;
  }
  md.genericContainers = table('genericContainers', GCONTAINER, 'generic container');
  md.genericParameters = table('genericParameters', GPARAM, 'generic parameter');
  md.nestedTypes = int32s(dv, header.nestedTypesOffset, header.nestedTypesSize);
  md.interfaces = (W.type || 4) === 4 ? int32s(dv, header.interfacesOffset, header.interfacesSize) : indices(dv, header.interfacesOffset, header.interfacesSize, W.type);
  const nt = md.typeDefs.length;
  const strStart = header.stringOffset, strEnd = header.stringOffset + header.stringSize;
  md.strCache = new Map();
  md.str = (idx) => {
    let s = md.strCache.get(idx);
    if (s !== undefined) return s;
    const start = strStart + idx;
    if (!(idx >= 0) || start >= strEnd) return '';
    let e = start;
    while (e < strEnd && u8[e]) e++;
    s = new TextDecoder().decode(u8.subarray(start, e));
    md.strCache.set(idx, s);
    return s;
  };
  const litStart = header.stringLiteralDataOffset, litEnd = litStart + header.stringLiteralDataSize;
  md.literal = (i) => {
    const l = md.stringLiterals[i];
    if (!l) return '';
    const o = Math.max(litStart, Math.min(litEnd, litStart + l.dataIndex));
    return new TextDecoder().decode(u8.subarray(o, Math.min(litEnd, o + Math.max(0, l.length))));
  };
  md.typeName = (ti) => (md.typeDefs[ti] ? md.str(md.typeDefs[ti].nameIndex) : '');
  // image index of each type; a type outside every image keeps -1
  md.typeImage = new Int32Array(nt).fill(-1);
  md.images.forEach((img, ii) => {
    const end = Math.min(nt, img.typeStart + img.typeCount);
    for (let t = Math.max(0, img.typeStart); t < end; t++) md.typeImage[t] = ii;
  });
  // only types in an image's range are listed under it
  md.imageTypes = (ii) => {
    const img = md.images[ii];
    if (!img) return [0, 0];
    const s = Math.max(0, Math.min(nt, img.typeStart));
    return [s, Math.max(s, Math.min(nt, img.typeStart + img.typeCount))];
  };
  return md;
}

function indices(dv, off, size, w) {
  const n = Math.floor(size / w), a = new Int32Array(n);
  for (let i = 0; i < n; i++) a[i] = w === 1 ? dv.getUint8(off + i) : dv.getUint16(off + i * 2, true);
  return a;
}

function int32s(dv, off, size) {
  const n = size >> 2, a = new Int32Array(n);
  for (let i = 0; i < n; i++) a[i] = dv.getInt32(off + i * 4, true);
  return a;
}

// ---------------- binary access ----------------
export class Il2CppBinary {
  // mem: Uint8Array; map(va) -> offset into mem or -1; ptrSize 4|8; dataRanges: [[start,end]] (offsets) to search
  constructor({ kind, mem, ptrSize, map, dataRanges, imageBase = 0 }) {
    Object.assign(this, { kind, mem, ptrSize, map, dataRanges, imageBase });
    this.dv = new DataView(mem.buffer, mem.byteOffset, mem.byteLength);
  }
  u32At(off) { return off >= 0 && off + 4 <= this.mem.length ? this.dv.getUint32(off, true) : 0; }
  ptrAt(off) {
    if (off < 0 || off + this.ptrSize > this.mem.length) return 0;
    if (this.ptrSize === 4) return this.dv.getUint32(off, true);
    return this.dv.getUint32(off, true) + this.dv.getUint32(off + 4, true) * 4294967296;
  }
  ptr(va) { return this.ptrAt(this.map(va)); }
  u32(va) { return this.u32At(this.map(va)); }
  valid(va) { const o = this.map(va); return o >= 0 && o < this.mem.length; }

  // Find Il2CppMetadataRegistration by its {N, ptr, N, ptr} signature (fieldOffsets / typeDefinitionsSizes).
  // The {typesCount, types} pair sits 4 pointer slots before it, or 2 from metadata v108 (which
  // moved the generic method table and method specs out of the binary).
  findMetadataRegistration(typeDefCount, version = 0) {
    const P = this.ptrSize;
    const layouts = version >= 108 ? [[2, 6], [4, 10]] : [[4, 10], [2, 6]]; // [types slot, struct start] before the signature
    for (const [start, end] of this.dataRanges) {
      for (let o = start - (start % P); o + 4 * P <= end; o += P) {
        if (this.ptrAt(o) !== typeDefCount) continue;
        if (this.ptrAt(o + 2 * P) !== typeDefCount) continue;
        const p1 = this.ptrAt(o + P), p2 = this.ptrAt(o + 3 * P);
        if (!this.valid(p1) || !this.valid(p2)) continue;
        for (const [typesBack, structBack] of layouts) {
          const typesCount = this.ptrAt(o - typesBack * P), types = this.ptrAt(o - typesBack * P + P);
          if (typesCount < typeDefCount || typesCount > typeDefCount * 64 || !this.valid(types)) continue;
          // the first type pointers must lead to plausible Il2CppType records
          let good = 0;
          const n = Math.min(16, typesCount);
          for (let i = 0; i < n; i++) {
            const tp = this.ptr(types + i * P);
            if (!this.valid(tp)) continue;
            const kind = (this.u32(tp + P) >>> 16) & 0xff;
            if (kind >= 1 && kind <= 0x55) good++;
          }
          if (good < n - 1) continue;
          const mr = o - structBack * P;
          return { offset: mr, typesCount, types, genericClassesCount: this.ptrAt(mr), genericInstsCount: this.ptrAt(mr + 2 * P), fieldOffsets: p1 };
        }
      }
    }
    return null;
  }

  readType(va, newBits) {
    const o = this.map(va);
    if (o < 0) return null;
    const data = this.ptrAt(o);
    const bits = this.u32At(o + this.ptrSize);
    const t = { data, attrs: bits & 0xffff, type: (bits >>> 16) & 0xff };
    if (newBits) { t.byref = (bits >>> 29) & 1; t.valuetype = bits >>> 31; } else { t.byref = (bits >>> 30) & 1; }
    return t;
  }

  // C string at a virtual address
  cstr(va, max = 512) {
    const o = this.map(va);
    if (o < 0) return null;
    let e = o;
    while (e < this.mem.length && e - o < max && this.mem[e]) e++;
    return latin1(this.mem.subarray(o, e));
  }

  // Locate every Il2CppCodeGenModule by finding pointers to its module name
  // string ("Assembly-CSharp.dll"). One pass to index names, one pointer scan.
  findCodeGenModules(imageNames) {
    const P = this.ptrSize, mem = this.mem;
    const names = new Set(imageNames);
    const want = new Map();
    for (let i = 4; i < mem.length - 4; i++) {
      if (mem[i] !== 0x2e || mem[i + 1] !== 0x64 || mem[i + 2] !== 0x6c || mem[i + 3] !== 0x6c || mem[i + 4] !== 0) continue;
      let st = i;
      while (st > 0 && mem[st - 1] >= 0x20 && mem[st - 1] < 0x7f && i - st < 256) st--;
      const str = latin1(mem.subarray(st, i + 4));
      if (names.has(str)) { const va = this.offsetToVA(st); if (va >= 0) want.set(va, str); }
    }
    const out = new Map();
    if (!want.size) return out;
    for (const [start, end] of this.dataRanges) {
      for (let o = start - (start % P); o + 3 * P <= end; o += P) {
        const v = this.ptrAt(o);
        const name = want.get(v);
        if (!name || out.has(name)) continue;
        const count = this.ptrAt(o + P), arr = this.ptrAt(o + 2 * P);
        if (count > 0 && count < 2e6 && this.valid(arr)) out.set(name, { count, methodPointers: arr });
      }
    }
    return out;
  }
  offsetToVA(off) { return this.toVA ? this.toVA(off) : off; }
}

export function wasmBinary(memory) {
  return new Il2CppBinary({ kind: 'wasm', mem: memory, ptrSize: 4, map: (va) => (va >= 0 && va < memory.length ? va : -1), dataRanges: [[1024, memory.length]] });
}

export function peBinary(pe) {
  const secs = pe.sections;
  const map = (va) => {
    const rva = va - pe.imageBase;
    for (const s of secs) if (rva >= s.va && rva < s.va + Math.max(s.vsize, s.rawSize)) { const off = rva - s.va; return off < s.rawSize ? s.rawPtr + off : -1; }
    return -1;
  };
  const dataRanges = secs.filter((s) => /data|rdata|bss/i.test(s.name) || (s.chars & 0x40000000 && !(s.chars & 0x20000000))).map((s) => [s.rawPtr, s.rawPtr + s.rawSize]);
  const b = new Il2CppBinary({ kind: 'pe', mem: pe.u8, ptrSize: pe.is64 ? 8 : 4, map, dataRanges, imageBase: pe.imageBase });
  b.toVA = (off) => { for (const s of secs) if (off >= s.rawPtr && off < s.rawPtr + s.rawSize) return pe.imageBase + s.va + (off - s.rawPtr); return -1; };
  return b;
}

// ---------------- type names ----------------
const PRIMS = { 1: 'void', 2: 'bool', 3: 'char', 4: 'sbyte', 5: 'byte', 6: 'short', 7: 'ushort', 8: 'int', 9: 'uint', 10: 'long', 11: 'ulong', 12: 'float', 13: 'double', 14: 'string', 22: 'TypedReference', 24: 'IntPtr', 25: 'UIntPtr', 28: 'object' };

export class Il2CppModel {
  constructor(md, bin, opts = {}) {
    this.md = md;
    this.bin = bin;
    this.newBits = md.version >= 29 || (opts.unityMajor >= 2021 && md.version >= 27);
    this.reg = bin ? bin.findMetadataRegistration(md.typeDefs.length, md.version) : null;
    this.typePtrs = null;
    if (this.reg) {
      const P = bin.ptrSize;
      this.typePtrs = new Array(this.reg.typesCount);
      for (let i = 0; i < this.reg.typesCount; i++) this.typePtrs[i] = bin.ptr(this.reg.types + i * P);
      this.fieldOffsetsBase = this.reg.fieldOffsets;
    }
    this.nameCache = new Map();
  }

  get hasTypes() { return !!this.typePtrs; }

  fieldOffset(ti, i) {
    if (!this.reg || this.md.version <= 21) return null;
    const P = this.bin.ptrSize;
    const arr = this.bin.ptr(this.fieldOffsetsBase + ti * P);
    if (!arr || !this.bin.valid(arr)) return null;
    const v = this.bin.u32(arr + i * 4) | 0;
    return v >= 0 && v < 1 << 24 ? v : null;
  }

  typeDefFullName(ti, withNs = false, depth = 0) {
    const md = this.md, td = md.typeDefs[ti];
    if (!td) return '?';
    let name = md.str(td.nameIndex);
    if (td.genericContainerIndex >= 0 && !name.includes('<')) {
      const gc = md.genericContainers[td.genericContainerIndex];
      if (gc) {
        const ps = [];
        for (let i = 0; i < gc.type_argc; i++) { const gp = md.genericParameters[gc.genericParameterStart + i]; ps.push(gp ? md.str(gp.nameIndex) : 'T' + i); }
        name = name.replace(/`\d+$/, '') + '<' + ps.join(', ') + '>';
      }
    } else name = name.replace(/`\d+$/, '');
    if (td.declaringTypeIndex >= 0 && this.typePtrs) {
      const dt = this.resolveTypeDefIndex(td.declaringTypeIndex);
      if (dt >= 0 && dt !== ti && depth < 16) name = this.typeDefFullName(dt, withNs, depth + 1) + '.' + name;
    } else if (withNs) {
      const ns = md.str(td.namespaceIndex);
      if (ns) name = ns + '.' + name;
    }
    return name;
  }

  resolveTypeDefIndex(typeIndex) {
    const t = this.typeAt(typeIndex);
    return t && (t.type === 0x11 || t.type === 0x12) && t.data < this.md.typeDefs.length ? t.data : -1;
  }

  typeAt(typeIndex) {
    if (!this.typePtrs || !(typeIndex >= 0) || typeIndex >= this.typePtrs.length) return null;
    return this.bin.readType(this.typePtrs[typeIndex], this.newBits);
  }

  typeName(typeIndex) {
    if (!this.typePtrs) return null;
    if (this.nameCache.has(typeIndex)) return this.nameCache.get(typeIndex);
    const t = this.typeAt(typeIndex);
    const n = t ? this.nameOfType(t, 0) : '?';
    this.nameCache.set(typeIndex, n);
    return n;
  }

  nameOfType(t, depth) {
    if (!t || depth > 12) return '?';
    const md = this.md, P = this.bin.ptrSize;
    switch (t.type) {
      case 0x11: case 0x12: return t.data >= 0 && t.data < md.typeDefs.length ? this.typeDefFullName(t.data) : '?';
      case 0x1d: return this.nameOfType(this.bin.readType(t.data, this.newBits), depth + 1) + '[]';
      case 0x0f: return this.nameOfType(this.bin.readType(t.data, this.newBits), depth + 1) + '*';
      case 0x14: {
        const et = this.bin.readType(this.bin.ptr(t.data), this.newBits);
        const rank = this.bin.mem[this.bin.map(t.data) + P] || 1;
        return this.nameOfType(et, depth + 1) + '[' + ','.repeat(Math.max(0, rank - 1)) + ']';
      }
      case 0x13: case 0x1e: {
        const gp = md.genericParameters[t.data];
        return gp ? md.str(gp.nameIndex) : (t.type === 0x13 ? 'T' : 'TMethod');
      }
      case 0x15: {
        // Il2CppGenericClass: v27+ {Il2CppType* type, context{class_inst, method_inst}, cached}; older {typeDefinitionIndex, context...}
        let defIndex;
        if (md.version >= 27) {
          const dt = this.bin.readType(this.bin.ptr(t.data), this.newBits);
          defIndex = dt ? dt.data : -1;
        } else defIndex = this.bin.ptr(t.data);
        const classInst = this.bin.ptr(t.data + P);
        let base = defIndex >= 0 && defIndex < md.typeDefs.length ? this.typeDefFullName(defIndex).replace(/<.*>$/, '') : '?';
        const argc = classInst ? this.bin.ptr(classInst) : 0;
        const argv = classInst ? this.bin.ptr(classInst + P) : 0;
        const args = [];
        for (let i = 0; i < Math.min(argc, 16); i++) args.push(this.nameOfType(this.bin.readType(this.bin.ptr(argv + i * P), this.newBits), depth + 1));
        if (base === 'Nullable' && args.length === 1) return args[0] + '?';
        return base + (args.length ? '<' + args.join(', ') + '>' : '');
      }
      default: return PRIMS[t.type] || `type_${t.type}`;
    }
  }
}

// ---------------- dump ----------------
const ACCESS = ['private', 'private', 'private protected', 'internal', 'protected', 'protected internal', 'public'];
const fieldAccess = (a) => ACCESS[a & 7] || '';
const methodAccess = (f) => ACCESS[f & 7] || '';

function typeKeyword(md, td, model, ti) {
  const flags = td.flags;
  const isInterface = flags & 0x20;
  const isValue = td.bitfield & 1, isEnum = (td.bitfield >> 1) & 1;
  let parent = null;
  if (model.hasTypes && td.parentIndex >= 0) parent = model.typeName(td.parentIndex);
  if (isEnum) return ['enum', null];
  if (isInterface) return ['interface', null];
  if (isValue) return ['struct', null];
  void ti;
  return ['class', parent && parent !== 'object' ? parent : null];
}

function defaultValueText(md, def, typeName) {
  if (!def || def.dataIndex < 0) return null;
  const o = md.header.fieldAndParameterDefaultValueDataOffset + def.dataIndex;
  const dv = md.dv;
  try {
    switch (typeName) {
      case 'bool': return dv.getUint8(o) ? 'true' : 'false';
      case 'byte': return String(dv.getUint8(o));
      case 'sbyte': return String(dv.getInt8(o));
      case 'char': return JSON.stringify(String.fromCharCode(dv.getUint16(o, true))).replace(/^"|"$/g, "'");
      case 'short': return String(dv.getInt16(o, true));
      case 'ushort': return String(dv.getUint16(o, true));
      case 'int': return String(dv.getInt32(o, true));
      case 'uint': return String(dv.getUint32(o, true));
      case 'long': return String(dv.getBigInt64(o, true));
      case 'ulong': return String(dv.getBigUint64(o, true));
      case 'float': return String(dv.getFloat32(o, true)) + 'f';
      case 'double': return String(dv.getFloat64(o, true));
      case 'string': {
        // compressed length (v29+) or int32
        let len, p = o;
        if (md.version >= 29) {
          const b = md.u8[p];
          if ((b & 0x80) === 0) { len = b; p += 1; } else if ((b & 0xc0) === 0x80) { len = ((b & 0x3f) << 8) | md.u8[p + 1]; p += 2; } else { len = ((b & 0x1f) << 24) | (md.u8[p + 1] << 16) | (md.u8[p + 2] << 8) | md.u8[p + 3]; p += 4; }
          if (len === 0xffffffff || len > 1e6) return 'null';
        } else { len = dv.getInt32(o, true); p += 4; }
        return JSON.stringify(new TextDecoder().decode(md.u8.subarray(p, p + len)));
      }
      default: return null;
    }
  } catch { return null; }
}

// Build C#-like source for one type definition. methodInfo(mi) -> comment string (address/wasm)
export function dumpType(model, ti, { methodInfo, indent = '', depth = 0 } = {}) {
  const md = model.md, td = md.typeDefs[ti];
  if (!td) return `${indent}// TypeDefIndex ${ti} is not in the metadata`;
  const L = [];
  const name = model.typeDefFullName(ti).split('.').pop();
  const [kw, parent] = typeKeyword(md, td, model, ti);
  const access = ['internal', 'public', 'public', 'private', 'protected', 'internal', 'private protected', 'protected internal'][td.flags & 7] || 'internal';
  const mods = [];
  if (kw === 'class') {
    if ((td.flags & 0x80) && (td.flags & 0x100)) mods.push('static');
    else if (td.flags & 0x80) mods.push('abstract');
    else if (td.flags & 0x100) mods.push('sealed');
  }
  const bases = [];
  if (parent) bases.push(parent);
  if (model.hasTypes) for (let i = 0; i < td.interfaces_count; i++) { const it = md.interfaces[td.interfacesStart + i]; if (it != null) bases.push(model.typeName(it)); }
  if (kw === 'enum' && model.hasTypes && td.elementTypeIndex >= 0) { const et = model.typeName(td.elementTypeIndex); if (et && et !== 'int') bases.push(et); }
  L.push(`${indent}// TypeDefIndex: ${ti}${td.token ? ` · Token: 0x${td.token.toString(16).toUpperCase()}` : ''}`);
  L.push(`${indent}${access} ${mods.join(' ')}${mods.length ? ' ' : ''}${kw} ${name}${bases.length ? ' : ' + bases.join(', ') : ''}`);
  L.push(`${indent}{`);
  const inner = indent + '\t';
  // fields
  if (td.field_count) {
    L.push(`${inner}// Fields`);
    for (let i = 0; i < td.field_count; i++) {
      const fi = td.fieldStart + i;
      const f = md.fieldDefs[fi];
      if (!f) continue;
      const fname = md.str(f.nameIndex);
      if (kw === 'enum') {
        const t = model.typeAt(f.typeIndex);
        if (fname === 'value__' || (t && !(t.attrs & 0x10))) continue; // the backing field is the only non-static one
        const def = md.fieldDefaults.get(fi);
        const v = def ? defaultValueText(md, def, model.hasTypes && td.elementTypeIndex >= 0 ? model.typeName(td.elementTypeIndex) : 'int') : null;
        L.push(`${inner}${fname}${v != null ? ' = ' + v : ''},`);
        continue;
      }
      const t = model.typeAt(f.typeIndex);
      const attrs = t ? t.attrs : 0;
      const typeName = model.hasTypes ? model.typeName(f.typeIndex) : 'object /*?*/';
      const m = [fieldAccess(attrs)];
      if (attrs & 0x40) { if (attrs & 0x10) m.push('const'); }
      else { if (attrs & 0x10) m.push('static'); if (attrs & 0x20) m.push('readonly'); }
      const def = md.fieldDefaults.get(fi);
      const dv = def ? defaultValueText(md, def, typeName) : null;
      const off = !(attrs & 0x40) ? model.fieldOffset(ti, i) : null;
      L.push(`${inner}${m.filter(Boolean).join(' ')} ${typeName} ${fname}${dv != null ? ' = ' + dv : ''};${off != null ? ' // 0x' + off.toString(16).toUpperCase() : ''}`);
    }
    L.push('');
  }
  if (kw === 'enum') { L.push(`${indent}}`); return L.join('\n'); }
  // properties
  if (td.property_count) {
    L.push(`${inner}// Properties`);
    for (let i = 0; i < td.property_count; i++) {
      const p = md.propertyDefs[td.propertyStart + i];
      if (!p) continue;
      const getM = p.get >= 0 ? md.methodDefs[td.methodStart + p.get] : null;
      const setM = p.set >= 0 ? md.methodDefs[td.methodStart + p.set] : null;
      const any = getM || setM;
      let ptype = 'object';
      if (model.hasTypes) {
        if (getM) ptype = model.typeName(getM.returnType);
        else if (setM && setM.parameterCount) { const pd = md.paramDefs[setM.parameterStart + setM.parameterCount - 1]; if (pd) ptype = model.typeName(pd.typeIndex); }
      }
      const acc = any ? methodAccess(any.flags) : 'public';
      const st = any && (any.flags & 0x10) ? ' static' : '';
      L.push(`${inner}${acc}${st} ${ptype} ${md.str(p.nameIndex)} { ${getM ? 'get; ' : ''}${setM ? 'set; ' : ''}}`);
    }
    L.push('');
  }
  // methods
  if (td.method_count) {
    L.push(`${inner}// Methods`);
    for (let i = 0; i < td.method_count; i++) {
      const mi = td.methodStart + i;
      const m = md.methodDefs[mi];
      if (!m) continue;
      const mname = md.str(m.nameIndex);
      const comment = methodInfo ? methodInfo(mi, m, ti) : '';
      if (comment) L.push(`${inner}// ${comment}`);
      const mods2 = [methodAccess(m.flags)];
      if (m.flags & 0x10) mods2.push('static');
      const newSlot = (m.flags & 0x100) !== 0;
      if (m.flags & 0x400) { mods2.push('abstract'); if (!newSlot) mods2.push('override'); }
      else if (m.flags & 0x20) { if ((m.flags & 0x40) && !newSlot) mods2.push('sealed override'); }
      else if (m.flags & 0x40) mods2.push(newSlot ? 'virtual' : 'override');
      const ret = model.hasTypes ? model.typeName(m.returnType) : 'void /*?*/';
      const params = [];
      for (let p = 0; p < m.parameterCount; p++) {
        const pd = md.paramDefs[m.parameterStart + p];
        if (!pd) continue;
        let pt = model.hasTypes ? model.typeName(pd.typeIndex) : 'object';
        const t = model.typeAt(pd.typeIndex);
        if (t && t.byref) pt = ((t.attrs & 2) && !(t.attrs & 1) ? 'out ' : (t.attrs & 1) && !(t.attrs & 2) ? 'in ' : 'ref ') + pt;
        const dflt = md.paramDefaults.get(m.parameterStart + p);
        const dv = dflt ? defaultValueText(md, dflt, pt) : null;
        params.push(`${pt} ${md.str(pd.nameIndex)}${dv != null ? ' = ' + dv : ''}`);
      }
      let generic = '';
      if (m.genericContainerIndex >= 0) {
        const gc = md.genericContainers[m.genericContainerIndex];
        if (gc) { const ps = []; for (let k = 0; k < gc.type_argc; k++) { const gp = md.genericParameters[gc.genericParameterStart + k]; ps.push(gp ? md.str(gp.nameIndex) : 'T'); } generic = '<' + ps.join(', ') + '>'; }
      }
      const isCtor = mname === '.ctor' || mname === '.cctor';
      const shown = isCtor ? name.replace(/<.*>$/, '') : mname;
      L.push(`${inner}${mods2.filter(Boolean).join(' ')} ${isCtor ? '' : ret + ' '}${shown}${generic}(${params.join(', ')}) { }`);
    }
  }
  // nested types
  for (let i = 0; i < td.nested_type_count && depth < 16; i++) {
    const nti = md.nestedTypes[td.nestedTypesStart + i];
    if (nti >= 0 && nti < md.typeDefs.length && nti !== ti) { L.push(''); L.push(dumpType(model, nti, { methodInfo, indent: inner, depth: depth + 1 })); }
  }
  L.push(`${indent}}`);
  return L.join('\n');
}

export function isTopLevel(md, ti) { const td = md.typeDefs[ti]; return !!td && td.declaringTypeIndex < 0; }

// Rebuild the string literal table with edited values (appends new data at the end).
export function rewriteStringLiterals(md, values) {
  const enc = new TextEncoder();
  const parts = values.map((s) => enc.encode(s));
  let total = 0;
  for (const p of parts) total += p.length;
  const oldLen = md.u8.length;
  const pad = (8 - (oldLen % 8)) % 8;
  const out = new Uint8Array(oldLen + pad + total);
  out.set(md.u8);
  const dv = new DataView(out.buffer);
  const dataOff = oldLen + pad;
  let o = 0;
  const L = compile(STRLIT, md.version, md.widths || {});
  const withLength = L.fields.some(([n]) => n === 'length');
  for (let i = 0; i < parts.length && i < md.stringLiterals.length; i++) {
    out.set(parts[i], dataOff + o);
    const rec = md.header.stringLiteralOffset + i * L.size;
    if (withLength) { dv.setUint32(rec, parts[i].length, true); dv.setInt32(rec + 4, o, true); }
    else dv.setInt32(rec, o, true); // v35+: lengths follow from the next literal's start
    o += parts[i].length;
  }
  // the stringLiteralData section now points at the appended data
  const pos = md.header.positions.stringLiteralData;
  dv.setUint32(pos, dataOff, true);
  dv.setInt32(pos + 4, total, true);
  if (md.version >= 38) dv.setInt32(pos + 8, total, true);
  return out;
}

export { Reader };
