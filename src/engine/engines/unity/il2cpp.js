// IL2CPP global-metadata.dat reader (v24 - v31+) and C# class dump generator.
// Struct layouts follow Il2CppDumper (MIT). Type names need the compiled
// binary: WebAssembly (WebGL) memory or a PE (GameAssembly.dll).
import { Reader, latin1 } from '../../util/binary.js';

const U = 'u32', I = 'i32', H = 'u16';
// [name, type, minVersion, maxVersion]
const HEADER = [
  ['sanity', U], ['version', I], ['stringLiteralOffset', U], ['stringLiteralSize', I], ['stringLiteralDataOffset', U], ['stringLiteralDataSize', I],
  ['stringOffset', U], ['stringSize', I], ['eventsOffset', U], ['eventsSize', I], ['propertiesOffset', U], ['propertiesSize', I], ['methodsOffset', U], ['methodsSize', I],
  ['parameterDefaultValuesOffset', U], ['parameterDefaultValuesSize', I], ['fieldDefaultValuesOffset', U], ['fieldDefaultValuesSize', I],
  ['fieldAndParameterDefaultValueDataOffset', U], ['fieldAndParameterDefaultValueDataSize', I], ['fieldMarshaledSizesOffset', I], ['fieldMarshaledSizesSize', I],
  ['parametersOffset', U], ['parametersSize', I], ['fieldsOffset', U], ['fieldsSize', I], ['genericParametersOffset', U], ['genericParametersSize', I],
  ['genericParameterConstraintsOffset', U], ['genericParameterConstraintsSize', I], ['genericContainersOffset', U], ['genericContainersSize', I],
  ['nestedTypesOffset', U], ['nestedTypesSize', I], ['interfacesOffset', U], ['interfacesSize', I], ['vtableMethodsOffset', U], ['vtableMethodsSize', I],
  ['interfaceOffsetsOffset', I], ['interfaceOffsetsSize', I], ['typeDefinitionsOffset', U], ['typeDefinitionsSize', I],
  ['rgctxEntriesOffset', U, 0, 24.1], ['rgctxEntriesCount', I, 0, 24.1],
  ['imagesOffset', U], ['imagesSize', I], ['assembliesOffset', U], ['assembliesSize', I],
  ['metadataUsageListsOffset', U, 19, 24.5], ['metadataUsageListsCount', I, 19, 24.5], ['metadataUsagePairsOffset', U, 19, 24.5], ['metadataUsagePairsCount', I, 19, 24.5],
  ['fieldRefsOffset', U, 19], ['fieldRefsSize', I, 19], ['referencedAssembliesOffset', I, 20], ['referencedAssembliesSize', I, 20],
  ['attributesInfoOffset', U, 21, 27.2], ['attributesInfoCount', I, 21, 27.2], ['attributeTypesOffset', U, 21, 27.2], ['attributeTypesCount', I, 21, 27.2],
  ['attributeDataOffset', U, 29], ['attributeDataSize', I, 29], ['attributeDataRangeOffset', U, 29], ['attributeDataRangeSize', I, 29],
  ['unresolvedVirtualCallParameterTypesOffset', I, 22], ['unresolvedVirtualCallParameterTypesSize', I, 22],
  ['unresolvedVirtualCallParameterRangesOffset', I, 22], ['unresolvedVirtualCallParameterRangesSize', I, 22],
  ['windowsRuntimeTypeNamesOffset', I, 23], ['windowsRuntimeTypeNamesSize', I, 23], ['windowsRuntimeStringsOffset', I, 27], ['windowsRuntimeStringsSize', I, 27],
  ['exportedTypeDefinitionsOffset', I, 24], ['exportedTypeDefinitionsSize', I, 24],
];
const IMAGE = [['nameIndex', U], ['assemblyIndex', I], ['typeStart', I], ['typeCount', U], ['exportedTypeStart', I, 24], ['exportedTypeCount', U, 24], ['entryPointIndex', I], ['token', U, 19], ['customAttributeStart', I, 24.1], ['customAttributeCount', U, 24.1]];
const TYPEDEF = [
  ['nameIndex', U], ['namespaceIndex', U], ['customAttributeIndex', I, 0, 24], ['byvalTypeIndex', I], ['byrefTypeIndex', I, 0, 24.5], ['declaringTypeIndex', I], ['parentIndex', I], ['elementTypeIndex', I],
  ['rgctxStartIndex', I, 0, 24.1], ['rgctxCount', I, 0, 24.1], ['genericContainerIndex', I], ['delegateWrapperFromManagedToNativeIndex', I, 0, 22], ['marshalingFunctionsIndex', I, 0, 22],
  ['ccwFunctionIndex', I, 21, 22], ['guidIndex', I, 21, 22], ['flags', U], ['fieldStart', I], ['methodStart', I], ['eventStart', I], ['propertyStart', I], ['nestedTypesStart', I], ['interfacesStart', I],
  ['vtableStart', I], ['interfaceOffsetsStart', I], ['method_count', H], ['property_count', H], ['field_count', H], ['event_count', H], ['nested_type_count', H], ['vtable_count', H],
  ['interfaces_count', H], ['interface_offsets_count', H], ['bitfield', U], ['token', U, 19],
];
const METHOD = [['nameIndex', U], ['declaringType', I], ['returnType', I], ['returnParameterToken', I, 31], ['parameterStart', I], ['customAttributeIndex', I, 0, 24], ['genericContainerIndex', I],
  ['methodIndex', I, 0, 24.1], ['invokerIndex', I, 0, 24.1], ['delegateWrapperIndex', I, 0, 24.1], ['rgctxStartIndex', I, 0, 24.1], ['rgctxCount', I, 0, 24.1], ['token', U], ['flags', H], ['iflags', H], ['slot', H], ['parameterCount', H]];
const PARAM = [['nameIndex', U], ['token', U], ['customAttributeIndex', I, 0, 24], ['typeIndex', I]];
const FIELD = [['nameIndex', U], ['typeIndex', I], ['customAttributeIndex', I, 0, 24], ['token', U, 19]];
const PROPERTY = [['nameIndex', U], ['get', I], ['set', I], ['attrs', U], ['customAttributeIndex', I, 0, 24], ['token', U, 19]];
const EVENT = [['nameIndex', U], ['typeIndex', I], ['add', I], ['remove', I], ['raise', I], ['customAttributeIndex', I, 0, 24], ['token', U, 19]];
const DEFVAL = [['index', I], ['typeIndex', I], ['dataIndex', I]];
const STRLIT = [['length', U], ['dataIndex', I]];
const GCONTAINER = [['ownerIndex', I], ['type_argc', I], ['is_method', I], ['genericParameterStart', I]];
const GPARAM = [['ownerIndex', I], ['nameIndex', U], ['constraintsStart', 'i16'], ['constraintsCount', 'i16'], ['num', H], ['flags', H]];

const SIZES = { u32: 4, i32: 4, u16: 2, i16: 2 };
function layout(fields, v) {
  const out = [];
  let size = 0;
  for (const [name, type, min = 0, max = 999] of fields) {
    if (v < min || v > max) continue;
    out.push([name, type, size]);
    size += SIZES[type];
  }
  return { fields: out, size };
}
function readArray(dv, offset, byteSize, fields, v) {
  const L = layout(fields, v);
  const n = Math.floor(byteSize / L.size);
  const arr = new Array(n);
  for (let i = 0; i < n; i++) {
    const o = offset + i * L.size, rec = {};
    for (const [name, type, fo] of L.fields) {
      rec[name] = type === 'u32' ? dv.getUint32(o + fo, true) : type === 'i32' ? dv.getInt32(o + fo, true) : type === 'u16' ? dv.getUint16(o + fo, true) : dv.getInt16(o + fo, true);
    }
    arr[i] = rec;
  }
  return arr;
}

export function parseMetadata(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (dv.getUint32(0, true) !== 0xfab11baf) throw new Error('not an IL2CPP metadata file');
  const rawVersion = dv.getInt32(4, true);
  if (rawVersion < 16 || rawVersion > 200) throw new Error(`unexpected metadata version ${rawVersion}`);
  let v = rawVersion > 31 ? 31 : rawVersion;
  let header = readArray(dv, 0, layout(HEADER, v).size, HEADER, v)[0];
  if (rawVersion === 24) {
    if (header.stringLiteralOffset === 264) { v = 24.2; header = readArray(dv, 0, layout(HEADER, v).size, HEADER, v)[0]; }
    else {
      const imgs = readArray(dv, header.imagesOffset, header.imagesSize, IMAGE, 24);
      if (imgs.some((x) => x.token !== 1)) v = 24.1;
    }
  }
  const md = { u8, dv, rawVersion, version: v, header };
  md.images = readArray(dv, header.imagesOffset, header.imagesSize, IMAGE, v);
  md.typeDefs = readArray(dv, header.typeDefinitionsOffset, header.typeDefinitionsSize, TYPEDEF, v);
  md.methodDefs = readArray(dv, header.methodsOffset, header.methodsSize, METHOD, v);
  // Unknown newer versions: sanity-check the method layout, retry without the v31 field.
  if (rawVersion > 31 && !layoutLooksRight(md)) {
    md.methodDefs = readArray(dv, header.methodsOffset, header.methodsSize, METHOD, 29);
  }
  md.paramDefs = readArray(dv, header.parametersOffset, header.parametersSize, PARAM, v);
  md.fieldDefs = readArray(dv, header.fieldsOffset, header.fieldsSize, FIELD, v);
  md.propertyDefs = readArray(dv, header.propertiesOffset, header.propertiesSize, PROPERTY, v);
  md.eventDefs = readArray(dv, header.eventsOffset, header.eventsSize, EVENT, v);
  md.fieldDefaults = new Map(readArray(dv, header.fieldDefaultValuesOffset, header.fieldDefaultValuesSize, DEFVAL, v).map((x) => [x.index, x]));
  md.paramDefaults = new Map(readArray(dv, header.parameterDefaultValuesOffset, header.parameterDefaultValuesSize, DEFVAL, v).map((x) => [x.index, x]));
  md.stringLiterals = readArray(dv, header.stringLiteralOffset, header.stringLiteralSize, STRLIT, v);
  md.genericContainers = readArray(dv, header.genericContainersOffset, header.genericContainersSize, GCONTAINER, v);
  md.genericParameters = readArray(dv, header.genericParametersOffset, header.genericParametersSize, GPARAM, v);
  md.nestedTypes = int32s(dv, header.nestedTypesOffset, header.nestedTypesSize);
  md.interfaces = int32s(dv, header.interfacesOffset, header.interfacesSize);
  md.strCache = new Map();
  md.str = (idx) => {
    let s = md.strCache.get(idx);
    if (s !== undefined) return s;
    const start = header.stringOffset + idx;
    let e = start;
    while (e < u8.length && u8[e]) e++;
    s = new TextDecoder().decode(u8.subarray(start, e));
    md.strCache.set(idx, s);
    return s;
  };
  md.literal = (i) => {
    const l = md.stringLiterals[i];
    const o = header.stringLiteralDataOffset + l.dataIndex;
    return new TextDecoder().decode(u8.subarray(o, o + l.length));
  };
  md.typeName = (ti) => md.str(md.typeDefs[ti].nameIndex);
  // image index of each type
  md.typeImage = new Int32Array(md.typeDefs.length).fill(-1);
  md.images.forEach((img, ii) => { for (let t = img.typeStart; t < img.typeStart + img.typeCount; t++) md.typeImage[t] = ii; });
  return md;
}

function layoutLooksRight(md) {
  let ok = 0;
  for (const m of md.methodDefs.slice(0, 50)) if (m.declaringType >= 0 && m.declaringType < md.typeDefs.length && m.parameterCount < 64) ok++;
  return ok > 40 || md.methodDefs.length < 50;
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
  findMetadataRegistration(typeDefCount) {
    const P = this.ptrSize;
    for (const [start, end] of this.dataRanges) {
      for (let o = start - (start % P); o + 4 * P <= end; o += P) {
        if (this.ptrAt(o) !== typeDefCount) continue;
        if (this.ptrAt(o + 2 * P) !== typeDefCount) continue;
        const p1 = this.ptrAt(o + P), p2 = this.ptrAt(o + 3 * P);
        if (!this.valid(p1) || !this.valid(p2)) continue;
        const mr = o - 10 * P;
        const typesCount = this.ptrAt(mr + 6 * P), types = this.ptrAt(mr + 7 * P);
        if (typesCount < typeDefCount || typesCount > typeDefCount * 64 || !this.valid(types)) continue;
        // first type pointers must be valid
        let good = 0;
        for (let i = 0; i < Math.min(16, typesCount); i++) if (this.valid(this.ptr(types + i * P))) good++;
        if (good < Math.min(16, typesCount) - 1) continue;
        return { offset: mr, typesCount, types, genericClassesCount: this.ptrAt(mr), genericInstsCount: this.ptrAt(mr + 2 * P), fieldOffsets: p1 };
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
    this.reg = bin ? bin.findMetadataRegistration(md.typeDefs.length) : null;
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

  typeDefFullName(ti, withNs = false) {
    const md = this.md, td = md.typeDefs[ti];
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
      if (dt >= 0) name = this.typeDefFullName(dt, withNs) + '.' + name;
    } else if (withNs) {
      const ns = md.str(td.namespaceIndex);
      if (ns) name = ns + '.' + name;
    }
    return name;
  }

  resolveTypeDefIndex(typeIndex) {
    const t = this.typeAt(typeIndex);
    return t && (t.type === 0x11 || t.type === 0x12) ? t.data : -1;
  }

  typeAt(typeIndex) {
    if (!this.typePtrs || typeIndex < 0 || typeIndex >= this.typePtrs.length) return null;
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
export function dumpType(model, ti, { methodInfo, indent = '' } = {}) {
  const md = model.md, td = md.typeDefs[ti];
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
  if (model.hasTypes) for (let i = 0; i < td.interfaces_count; i++) bases.push(model.typeName(md.interfaces[td.interfacesStart + i]));
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
        else if (setM && setM.parameterCount) ptype = model.typeName(md.paramDefs[setM.parameterStart + setM.parameterCount - 1].typeIndex);
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
  for (let i = 0; i < td.nested_type_count; i++) {
    const nti = md.nestedTypes[td.nestedTypesStart + i];
    if (nti >= 0 && nti < md.typeDefs.length) { L.push(''); L.push(dumpType(model, nti, { methodInfo, indent: inner })); }
  }
  L.push(`${indent}}`);
  return L.join('\n');
}

export function isTopLevel(md, ti) { return md.typeDefs[ti].declaringTypeIndex < 0; }

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
  const L = layout(STRLIT, md.version);
  for (let i = 0; i < parts.length && i < md.stringLiterals.length; i++) {
    out.set(parts[i], dataOff + o);
    const rec = md.header.stringLiteralOffset + i * L.size;
    dv.setUint32(rec, parts[i].length, true);
    dv.setInt32(rec + 4, o, true);
    o += parts[i].length;
  }
  // header fields: stringLiteralDataOffset (offset 16), stringLiteralDataSize (20)
  dv.setUint32(16, dataOff, true);
  dv.setInt32(20, total, true);
  return out;
}

export { Reader };
