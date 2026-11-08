// .NET (ECMA-335) metadata reader: tables, heaps, signatures, method bodies.
import { Reader, utf8 } from '../util/binary.js';

export const T = {
  Module: 0, TypeRef: 1, TypeDef: 2, FieldPtr: 3, Field: 4, MethodPtr: 5, MethodDef: 6, ParamPtr: 7, Param: 8, InterfaceImpl: 9,
  MemberRef: 10, Constant: 11, CustomAttribute: 12, FieldMarshal: 13, DeclSecurity: 14, ClassLayout: 15, FieldLayout: 16,
  StandAloneSig: 17, EventMap: 18, EventPtr: 19, Event: 20, PropertyMap: 21, PropertyPtr: 22, Property: 23, MethodSemantics: 24,
  MethodImpl: 25, ModuleRef: 26, TypeSpec: 27, ImplMap: 28, FieldRVA: 29, EncLog: 30, EncMap: 31, Assembly: 32, AssemblyProcessor: 33,
  AssemblyOS: 34, AssemblyRef: 35, AssemblyRefProcessor: 36, AssemblyRefOS: 37, File: 38, ExportedType: 39, ManifestResource: 40,
  NestedClass: 41, GenericParam: 42, MethodSpec: 43, GenericParamConstraint: 44,
};

const CODED = {
  TypeDefOrRef: [2, [T.TypeDef, T.TypeRef, T.TypeSpec]],
  HasConstant: [2, [T.Field, T.Param, T.Property]],
  HasCustomAttribute: [5, [T.MethodDef, T.Field, T.TypeRef, T.TypeDef, T.Param, T.InterfaceImpl, T.MemberRef, T.Module, T.DeclSecurity, T.Property, T.Event, T.StandAloneSig, T.ModuleRef, T.TypeSpec, T.Assembly, T.AssemblyRef, T.File, T.ExportedType, T.ManifestResource, T.GenericParam, T.GenericParamConstraint, T.MethodSpec]],
  HasFieldMarshal: [1, [T.Field, T.Param]],
  HasDeclSecurity: [2, [T.TypeDef, T.MethodDef, T.Assembly]],
  MemberRefParent: [3, [T.TypeDef, T.TypeRef, T.ModuleRef, T.MethodDef, T.TypeSpec]],
  HasSemantics: [1, [T.Event, T.Property]],
  MethodDefOrRef: [1, [T.MethodDef, T.MemberRef]],
  MemberForwarded: [1, [T.Field, T.MethodDef]],
  Implementation: [2, [T.File, T.AssemblyRef, T.ExportedType]],
  CustomAttributeType: [3, [-1, -1, T.MethodDef, T.MemberRef, -1]],
  ResolutionScope: [2, [T.Module, T.ModuleRef, T.AssemblyRef, T.TypeRef]],
  TypeOrMethodDef: [1, [T.TypeDef, T.MethodDef]],
};

// column kinds: u8 u16 u32 str guid blob t:<Table> c:<Coded>
const SCHEMA = {
  [T.Module]: ['Generation:u16', 'Name:str', 'Mvid:guid', 'EncId:guid', 'EncBaseId:guid'],
  [T.TypeRef]: ['ResolutionScope:c:ResolutionScope', 'Name:str', 'Namespace:str'],
  [T.TypeDef]: ['Flags:u32', 'Name:str', 'Namespace:str', 'Extends:c:TypeDefOrRef', 'FieldList:t:Field', 'MethodList:t:MethodDef'],
  [T.FieldPtr]: ['Field:t:Field'],
  [T.Field]: ['Flags:u16', 'Name:str', 'Signature:blob'],
  [T.MethodPtr]: ['Method:t:MethodDef'],
  [T.MethodDef]: ['RVA:u32', 'ImplFlags:u16', 'Flags:u16', 'Name:str', 'Signature:blob', 'ParamList:t:Param'],
  [T.ParamPtr]: ['Param:t:Param'],
  [T.Param]: ['Flags:u16', 'Sequence:u16', 'Name:str'],
  [T.InterfaceImpl]: ['Class:t:TypeDef', 'Interface:c:TypeDefOrRef'],
  [T.MemberRef]: ['Class:c:MemberRefParent', 'Name:str', 'Signature:blob'],
  [T.Constant]: ['Type:u8', 'Pad:u8', 'Parent:c:HasConstant', 'Value:blob'],
  [T.CustomAttribute]: ['Parent:c:HasCustomAttribute', 'Type:c:CustomAttributeType', 'Value:blob'],
  [T.FieldMarshal]: ['Parent:c:HasFieldMarshal', 'NativeType:blob'],
  [T.DeclSecurity]: ['Action:u16', 'Parent:c:HasDeclSecurity', 'PermissionSet:blob'],
  [T.ClassLayout]: ['PackingSize:u16', 'ClassSize:u32', 'Parent:t:TypeDef'],
  [T.FieldLayout]: ['Offset:u32', 'Field:t:Field'],
  [T.StandAloneSig]: ['Signature:blob'],
  [T.EventMap]: ['Parent:t:TypeDef', 'EventList:t:Event'],
  [T.EventPtr]: ['Event:t:Event'],
  [T.Event]: ['Flags:u16', 'Name:str', 'EventType:c:TypeDefOrRef'],
  [T.PropertyMap]: ['Parent:t:TypeDef', 'PropertyList:t:Property'],
  [T.PropertyPtr]: ['Property:t:Property'],
  [T.Property]: ['Flags:u16', 'Name:str', 'Type:blob'],
  [T.MethodSemantics]: ['Semantics:u16', 'Method:t:MethodDef', 'Association:c:HasSemantics'],
  [T.MethodImpl]: ['Class:t:TypeDef', 'MethodBody:c:MethodDefOrRef', 'MethodDeclaration:c:MethodDefOrRef'],
  [T.ModuleRef]: ['Name:str'],
  [T.TypeSpec]: ['Signature:blob'],
  [T.ImplMap]: ['MappingFlags:u16', 'MemberForwarded:c:MemberForwarded', 'ImportName:str', 'ImportScope:t:ModuleRef'],
  [T.FieldRVA]: ['RVA:u32', 'Field:t:Field'],
  [T.EncLog]: ['Token:u32', 'FuncCode:u32'],
  [T.EncMap]: ['Token:u32'],
  [T.Assembly]: ['HashAlgId:u32', 'Major:u16', 'Minor:u16', 'Build:u16', 'Revision:u16', 'Flags:u32', 'PublicKey:blob', 'Name:str', 'Culture:str'],
  [T.AssemblyProcessor]: ['Processor:u32'],
  [T.AssemblyOS]: ['Platform:u32', 'Major:u32', 'Minor:u32'],
  [T.AssemblyRef]: ['Major:u16', 'Minor:u16', 'Build:u16', 'Revision:u16', 'Flags:u32', 'PublicKeyOrToken:blob', 'Name:str', 'Culture:str', 'HashValue:blob'],
  [T.AssemblyRefProcessor]: ['Processor:u32', 'AssemblyRef:t:AssemblyRef'],
  [T.AssemblyRefOS]: ['Platform:u32', 'Major:u32', 'Minor:u32', 'AssemblyRef:t:AssemblyRef'],
  [T.File]: ['Flags:u32', 'Name:str', 'HashValue:blob'],
  [T.ExportedType]: ['Flags:u32', 'TypeDefId:u32', 'Name:str', 'Namespace:str', 'Implementation:c:Implementation'],
  [T.ManifestResource]: ['Offset:u32', 'Flags:u32', 'Name:str', 'Implementation:c:Implementation'],
  [T.NestedClass]: ['NestedClass:t:TypeDef', 'EnclosingClass:t:TypeDef'],
  [T.GenericParam]: ['Number:u16', 'Flags:u16', 'Owner:c:TypeOrMethodDef', 'Name:str'],
  [T.MethodSpec]: ['Method:c:MethodDefOrRef', 'Instantiation:blob'],
  [T.GenericParamConstraint]: ['Owner:t:GenericParam', 'Constraint:c:TypeDefOrRef'],
};

export function readCompressed(r) {
  const b = r.u8_();
  if ((b & 0x80) === 0) return b;
  if ((b & 0xc0) === 0x80) return ((b & 0x3f) << 8) | r.u8_();
  return (((b & 0x1f) << 24) | (r.u8_() << 16) | (r.u8_() << 8) | r.u8_()) >>> 0;
}

export class DotNetModule {
  constructor(pe) {
    if (!pe.clr) throw new Error('not a .NET assembly');
    this.pe = pe;
    const u8 = pe.u8;
    const mdOff = pe.rvaToOffset(pe.clr.mdRva);
    const r = new Reader(u8, true, mdOff);
    if (r.u32() !== 0x424a5342) throw new Error('bad .NET metadata signature');
    r.u16(); r.u16(); r.u32();
    const vlen = r.u32();
    this.runtimeVersion = utf8(r.bytes(vlen)).replace(/\0+$/, '');
    r.u16();
    const nStreams = r.u16();
    this.streams = {};
    for (let i = 0; i < nStreams; i++) {
      const off = r.u32(), size = r.u32();
      const name = r.cstr(32);
      r.align(4);
      this.streams[name] = { off: mdOff + off, size };
    }
    const S = this.streams;
    this.strings = S['#Strings'] ? u8.subarray(S['#Strings'].off, S['#Strings'].off + S['#Strings'].size) : new Uint8Array(0);
    this.blobs = S['#Blob'] ? u8.subarray(S['#Blob'].off, S['#Blob'].off + S['#Blob'].size) : new Uint8Array(0);
    this.us = S['#US'] ? u8.subarray(S['#US'].off, S['#US'].off + S['#US'].size) : new Uint8Array(0);
    this.guids = S['#GUID'] ? u8.subarray(S['#GUID'].off, S['#GUID'].off + S['#GUID'].size) : new Uint8Array(0);
    const ts = S['#~'] || S['#-'];
    if (!ts) throw new Error('no metadata tables');
    this.readTables(u8, ts.off, !!S['#-']);
    this.strCache = new Map();
  }

  readTables(u8, off, uncompressed) {
    const r = new Reader(u8, true, off);
    r.u32(); r.u8_(); r.u8_();
    const heapSizes = r.u8_();
    r.u8_();
    const valid = r.u64big();
    r.u64big();
    const rows = new Array(64).fill(0);
    for (let i = 0; i < 64; i++) if ((valid >> BigInt(i)) & 1n) rows[i] = r.u32();
    if (heapSizes & 0x40) r.u32(); // extra data (#- streams)
    this.rows = rows;
    const strSize = heapSizes & 1 ? 4 : 2, guidSize = heapSizes & 2 ? 4 : 2, blobSize = heapSizes & 4 ? 4 : 2;
    const tIdx = (t) => (rows[t] < 65536 ? 2 : 4);
    const cIdx = (name) => {
      const [bits, tables] = CODED[name];
      const max = Math.max(...tables.map((t) => (t >= 0 ? rows[t] : 0)));
      return max < (1 << (16 - bits)) ? 2 : 4;
    };
    this.tables = [];
    let pos = off + r.pos; // absolute file offset of the first table
    for (let t = 0; t < 64; t++) {
      const schema = SCHEMA[t];
      if (!rows[t]) { this.tables[t] = null; continue; }
      if (!schema) { this.tables[t] = null; continue; } // portable PDB etc.: sizes unknown; they come last
      const cols = schema.map((c) => {
        const [name, kind, arg] = c.split(':');
        let size;
        if (kind === 'u8') size = 1; else if (kind === 'u16') size = 2; else if (kind === 'u32') size = 4;
        else if (kind === 'str') size = strSize; else if (kind === 'guid') size = guidSize; else if (kind === 'blob') size = blobSize;
        else if (kind === 't') size = tIdx(T[arg]); else size = cIdx(arg);
        return { name, kind, arg, size };
      });
      const rowSize = cols.reduce((a, c) => a + c.size, 0);
      this.tables[t] = { cols, rowSize, start: pos, count: rows[t] };
      pos += rowSize * rows[t];
    }
    this.u8 = u8;
    this.dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    this.rowCache = new Map();
    void uncompressed;
  }

  count(t) { return this.rows[t] || 0; }

  // 1-based row access -> object
  row(t, i) {
    const tab = this.tables[t];
    if (!tab || i < 1 || i > tab.count) return null;
    const key = t * 16777216 + i;
    let o = this.rowCache.get(key);
    if (o) return o;
    o = { _t: t, _i: i };
    let p = tab.start + (i - 1) * tab.rowSize;
    for (const c of tab.cols) {
      const v = c.size === 1 ? this.u8[p] : c.size === 2 ? this.dv.getUint16(p, true) : this.dv.getUint32(p, true);
      p += c.size;
      if (c.kind === 'c') {
        const [bits, tables] = CODED[c.arg];
        o[c.name] = { table: tables[v & ((1 << bits) - 1)], index: v >>> bits };
      } else o[c.name] = v;
    }
    this.rowCache.set(key, o);
    return o;
  }

  str(i) {
    if (!i) return '';
    let s = this.strCache.get(i);
    if (s !== undefined) return s;
    let e = i;
    while (e < this.strings.length && this.strings[e]) e++;
    s = utf8(this.strings.subarray(i, e));
    this.strCache.set(i, s);
    return s;
  }

  blob(i) {
    const r = new Reader(this.blobs, true, i);
    const n = readCompressed(r);
    return this.blobs.subarray(i + r.pos, i + r.pos + n);
  }

  userString(i) {
    const r = new Reader(this.us, true, i);
    const n = readCompressed(r);
    const bytes = this.us.subarray(i + r.pos, i + r.pos + Math.max(0, n - 1));
    return new TextDecoder('utf-16le').decode(bytes);
  }

  // Range [start, end) of child rows for list columns (FieldList, MethodList, ParamList ...)
  listRange(t, i, col, childTable) {
    const start = this.row(t, i)[col];
    const next = i < this.count(t) ? this.row(t, i + 1)[col] : this.count(childTable) + 1;
    return [start, Math.min(next, this.count(childTable) + 1)];
  }

  // ---- method bodies ----
  methodBody(rva) {
    if (!rva) return null;
    const off = this.pe.rvaToOffset(rva);
    if (off < 0) return null;
    const r = new Reader(this.u8, true, off);
    const first = r.u8_();
    let codeSize, maxStack = 8, localSig = 0, moreSects = false, initLocals = false;
    let headerSize;
    if ((first & 3) === 2) { codeSize = first >> 2; headerSize = 1; }
    else {
      r.seek(0);
      const flags = r.u16();
      headerSize = (flags >> 12) * 4;
      maxStack = r.u16();
      codeSize = r.u32();
      localSig = r.u32();
      moreSects = !!(flags & 8);
      initLocals = !!(flags & 0x10);
    }
    const codeStart = off + headerSize;
    const code = this.u8.subarray(codeStart, codeStart + codeSize);
    const handlers = [];
    if (moreSects) {
      let p = codeStart + codeSize;
      p = (p + 3) & ~3;
      for (let guard = 0; guard < 16; guard++) {
        const sr = new Reader(this.u8, true, p);
        const kind = sr.u8_();
        const fat = !!(kind & 0x40);
        let dataSize;
        if (fat) { dataSize = sr.u8_() | (sr.u8_() << 8) | (sr.u8_() << 16); }
        else { dataSize = sr.u8_(); sr.u16(); }
        if (kind & 1) {
          const n = fat ? Math.floor((dataSize - 4) / 24) : Math.floor((dataSize - 4) / 12);
          for (let i = 0; i < n; i++) {
            if (fat) handlers.push({ flags: sr.u32(), tryStart: sr.u32(), tryLen: sr.u32(), hStart: sr.u32(), hLen: sr.u32(), token: sr.u32() });
            else handlers.push({ flags: sr.u16(), tryStart: sr.u16(), tryLen: sr.u8_(), hStart: sr.u16(), hLen: sr.u8_(), token: sr.u32() });
          }
        }
        if (!(kind & 0x80)) break;
        p += dataSize;
        p = (p + 3) & ~3;
      }
    }
    for (const h of handlers) { h.tryEnd = h.tryStart + h.tryLen; h.hEnd = h.hStart + h.hLen; h.filterStart = h.flags === 1 ? h.token : null; }
    return { code, maxStack, localSig, initLocals, handlers };
  }

  // ---- lookups built once ----
  index() {
    if (this._index) return this._index;
    const ix = { nested: new Map(), enclosing: new Map(), propsOf: new Map(), eventsOf: new Map(), semantics: new Map(), constants: new Map(), genericParams: new Map(), interfaces: new Map(), methodOwner: new Int32Array(this.count(T.MethodDef) + 2), fieldOwner: new Int32Array(this.count(T.Field) + 2), attrs: new Map() };
    for (let i = 1; i <= this.count(T.NestedClass); i++) {
      const n = this.row(T.NestedClass, i);
      ix.enclosing.set(n.NestedClass, n.EnclosingClass);
      if (!ix.nested.has(n.EnclosingClass)) ix.nested.set(n.EnclosingClass, []);
      ix.nested.get(n.EnclosingClass).push(n.NestedClass);
    }
    for (let i = 1; i <= this.count(T.TypeDef); i++) {
      const [ms, me] = this.listRange(T.TypeDef, i, 'MethodList', T.MethodDef);
      for (let m = ms; m < me; m++) ix.methodOwner[m] = i;
      const [fs, fe] = this.listRange(T.TypeDef, i, 'FieldList', T.Field);
      for (let f = fs; f < fe; f++) ix.fieldOwner[f] = i;
    }
    for (let i = 1; i <= this.count(T.PropertyMap); i++) {
      const pm = this.row(T.PropertyMap, i);
      const [s, e] = this.listRange(T.PropertyMap, i, 'PropertyList', T.Property);
      ix.propsOf.set(pm.Parent, [s, e]);
    }
    for (let i = 1; i <= this.count(T.EventMap); i++) {
      const em = this.row(T.EventMap, i);
      const [s, e] = this.listRange(T.EventMap, i, 'EventList', T.Event);
      ix.eventsOf.set(em.Parent, [s, e]);
    }
    for (let i = 1; i <= this.count(T.MethodSemantics); i++) {
      const s = this.row(T.MethodSemantics, i);
      ix.semantics.set(s.Method, { sem: s.Semantics, assoc: s.Association });
    }
    for (let i = 1; i <= this.count(T.Constant); i++) {
      const c = this.row(T.Constant, i);
      ix.constants.set(c.Parent.table * 16777216 + c.Parent.index, c);
    }
    for (let i = 1; i <= this.count(T.GenericParam); i++) {
      const g = this.row(T.GenericParam, i);
      const key = g.Owner.table * 16777216 + g.Owner.index;
      if (!ix.genericParams.has(key)) ix.genericParams.set(key, []);
      ix.genericParams.get(key)[g.Number] = this.str(g.Name);
    }
    for (let i = 1; i <= this.count(T.InterfaceImpl); i++) {
      const ii = this.row(T.InterfaceImpl, i);
      if (!ix.interfaces.has(ii.Class)) ix.interfaces.set(ii.Class, []);
      ix.interfaces.get(ii.Class).push(ii.Interface);
    }
    for (let i = 1; i <= this.count(T.CustomAttribute); i++) {
      const ca = this.row(T.CustomAttribute, i);
      const key = ca.Parent.table * 16777216 + ca.Parent.index;
      if (!ix.attrs.has(key)) ix.attrs.set(key, []);
      ix.attrs.get(key).push(ca);
    }
    this._index = ix;
    return ix;
  }

  assemblyName() {
    if (this.count(T.Assembly)) { const a = this.row(T.Assembly, 1); return { name: this.str(a.Name), version: `${a.Major}.${a.Minor}.${a.Build}.${a.Revision}` }; }
    return { name: this.str(this.row(T.Module, 1).Name), version: '' };
  }
}

// ---------------- signatures ----------------
// Type node: {k: 'prim'|'class'|'valuetype'|'array'|'szarray'|'ptr'|'byref'|'var'|'mvar'|'generic'|'fnptr'|'pinned', ...}
const PRIM = { 1: 'void', 2: 'bool', 3: 'char', 4: 'sbyte', 5: 'byte', 6: 'short', 7: 'ushort', 8: 'int', 9: 'uint', 10: 'long', 11: 'ulong', 12: 'float', 13: 'double', 14: 'string', 0x16: 'TypedReference', 0x18: 'IntPtr', 0x19: 'UIntPtr', 0x1c: 'object' };

export function readTypeSig(r) {
  const et = r.u8_();
  switch (et) {
    case 0x0f: return { k: 'ptr', t: readTypeSig(r) };
    case 0x10: return { k: 'byref', t: readTypeSig(r) };
    case 0x11: case 0x12: { const v = readCompressed(r); return { k: et === 0x11 ? 'valuetype' : 'class', tok: [T.TypeDef, T.TypeRef, T.TypeSpec][v & 3], idx: v >> 2 }; }
    case 0x13: return { k: 'var', n: readCompressed(r) };
    case 0x1e: return { k: 'mvar', n: readCompressed(r) };
    case 0x14: {
      const t = readTypeSig(r);
      const rank = readCompressed(r);
      const ns = readCompressed(r); for (let i = 0; i < ns; i++) readCompressed(r);
      const nl = readCompressed(r); for (let i = 0; i < nl; i++) readCompressed(r);
      return { k: 'array', t, rank };
    }
    case 0x15: {
      const base = readTypeSig(r);
      const n = readCompressed(r);
      const args = [];
      for (let i = 0; i < n; i++) args.push(readTypeSig(r));
      return { k: 'generic', base, args };
    }
    case 0x1b: return { k: 'fnptr', sig: readMethodSig(r) };
    case 0x1d: return { k: 'szarray', t: readTypeSig(r) };
    case 0x1f: case 0x20: { readCompressed(r); return readTypeSig(r); }
    case 0x45: return { k: 'pinned', t: readTypeSig(r) };
    case 0x41: return readTypeSig(r);
    default:
      if (PRIM[et]) return { k: 'prim', name: PRIM[et], et };
      return { k: 'prim', name: `/*et ${et}*/object`, et };
  }
}

export function readMethodSig(r) {
  const flags = r.u8_();
  let genCount = 0;
  if (flags & 0x10) genCount = readCompressed(r);
  const n = readCompressed(r);
  const ret = readTypeSig(r);
  const params = [];
  for (let i = 0; i < n; i++) {
    if (r.u8[r.pos] === 0x41) r.u8_();
    params.push(readTypeSig(r));
  }
  return { hasThis: !!(flags & 0x20), explicitThis: !!(flags & 0x40), genCount, ret, params, conv: flags & 0xf };
}

export function parseSig(mod, blobIndex, kind) {
  const r = new Reader(mod.blob(blobIndex));
  if (kind === 'field') { r.u8_(); return readTypeSig(r); }
  if (kind === 'locals') {
    if (r.u8_() !== 7) return [];
    const n = readCompressed(r);
    const out = [];
    for (let i = 0; i < n; i++) out.push(readTypeSig(r));
    return out;
  }
  if (kind === 'methodspec') {
    r.u8_();
    const n = readCompressed(r);
    const out = [];
    for (let i = 0; i < n; i++) out.push(readTypeSig(r));
    return out;
  }
  if (kind === 'property') {
    const flags = r.u8_();
    const n = readCompressed(r);
    const t = readTypeSig(r);
    const params = [];
    for (let i = 0; i < n; i++) params.push(readTypeSig(r));
    return { hasThis: !!(flags & 0x20), type: t, params };
  }
  if (kind === 'typespec') return readTypeSig(r);
  return readMethodSig(r);
}
