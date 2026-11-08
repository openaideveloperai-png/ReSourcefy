// WebAssembly module parser + disassembler (WAT-like text).
// Used for IL2CPP WebGL builds (methods -> wasm functions) and any .wasm file.

class R {
  constructor(u8, pos = 0) { this.u8 = u8; this.pos = pos; }
  byte() { return this.u8[this.pos++]; }
  u32() { let r = 0, s = 0, b; do { b = this.u8[this.pos++]; r += (b & 0x7f) * 2 ** s; s += 7; } while (b & 0x80); return r; }
  s32() {
    let r = 0, s = 0, b;
    do { b = this.u8[this.pos++]; r |= (b & 0x7f) << s; s += 7; } while (b & 0x80 && s < 35);
    if (s < 32 && (b & 0x40)) r |= -1 << s;
    return r | 0;
  }
  s64() {
    let r = 0n, s = 0n, b;
    do { b = this.u8[this.pos++]; r |= BigInt(b & 0x7f) << s; s += 7n; } while (b & 0x80);
    if (s < 64n && (b & 0x40)) r |= -1n << s;
    return BigInt.asIntN(64, r);
  }
  bytes(n) { const b = this.u8.subarray(this.pos, this.pos + n); this.pos += n; return b; }
  name() { return new TextDecoder().decode(this.bytes(this.u32())); }
  f32() { const v = new DataView(this.u8.buffer, this.u8.byteOffset + this.pos, 4).getFloat32(0, true); this.pos += 4; return v; }
  f64() { const v = new DataView(this.u8.buffer, this.u8.byteOffset + this.pos, 8).getFloat64(0, true); this.pos += 8; return v; }
}

const VALTYPE = { 0x7f: 'i32', 0x7e: 'i64', 0x7d: 'f32', 0x7c: 'f64', 0x7b: 'v128', 0x70: 'funcref', 0x6f: 'externref', 0x69: 'exnref', 0x64: 'ref', 0x63: 'ref null' };

function valtype(r) {
  const b = r.byte();
  if (b === 0x64 || b === 0x63) { const ht = r.s32(); return `(ref ${b === 0x63 ? 'null ' : ''}${ht < 0 ? 'func' : ht})`; }
  return VALTYPE[b] || `0x${b.toString(16)}`;
}

function initExpr(r) {
  const op = r.byte();
  let v = null;
  if (op === 0x41) v = { op: 'i32.const', value: r.s32() };
  else if (op === 0x42) v = { op: 'i64.const', value: r.s64() };
  else if (op === 0x23) v = { op: 'global.get', value: r.u32() };
  else if (op === 0x43) v = { op: 'f32.const', value: r.f32() };
  else if (op === 0x44) v = { op: 'f64.const', value: r.f64() };
  else if (op === 0xd2) v = { op: 'ref.func', value: r.u32() };
  else if (op === 0xd0) { r.byte(); v = { op: 'ref.null', value: 0 }; }
  // skip extended-const expressions until end
  while (r.u8[r.pos] !== 0x0b && r.pos < r.u8.length) {
    const o = r.byte();
    if (o === 0x41) r.s32(); else if (o === 0x42) r.s64(); else if (o === 0x23) r.u32();
  }
  r.byte();
  return v;
}

export function parseWasm(u8) {
  const r = new R(u8, 8);
  const m = { types: [], imports: [], funcs: [], tables: [], memories: [], globals: [], exports: [], elements: [], codes: [], data: [], names: new Map(), customs: [], start: null };
  if (u8[0] !== 0 || u8[1] !== 0x61 || u8[2] !== 0x73 || u8[3] !== 0x6d) throw new Error('not a WebAssembly module');
  while (r.pos < u8.length) {
    const id = r.byte();
    const len = r.u32();
    const end = r.pos + len;
    try {
      if (id === 1) {
        const n = r.u32();
        for (let i = 0; i < n; i++) {
          const form = r.byte();
          if (form === 0x4e || form === 0x50 || form === 0x4f) { m.types.push({ params: [], results: [], gc: true }); r.pos = end; break; }
          const np = r.u32(); const params = []; for (let j = 0; j < np; j++) params.push(valtype(r));
          const nr = r.u32(); const results = []; for (let j = 0; j < nr; j++) results.push(valtype(r));
          m.types.push({ params, results });
        }
      } else if (id === 2) {
        const n = r.u32();
        for (let i = 0; i < n; i++) {
          const module = r.name(), field = r.name(), kind = r.byte();
          const imp = { module, field, kind };
          if (kind === 0) imp.type = r.u32();
          else if (kind === 1) { imp.elem = valtype(r); const f = r.byte(); imp.min = r.u32(); if (f & 1) imp.max = r.u32(); }
          else if (kind === 2) { const f = r.byte(); imp.min = r.u32(); if (f & 1) imp.max = r.u32(); imp.shared = !!(f & 2); }
          else if (kind === 3) { imp.valtype = valtype(r); imp.mutable = r.byte(); }
          else if (kind === 4) { r.byte(); imp.type = r.u32(); }
          m.imports.push(imp);
        }
      } else if (id === 3) {
        const n = r.u32();
        for (let i = 0; i < n; i++) m.funcs.push(r.u32());
      } else if (id === 4) {
        const n = r.u32();
        for (let i = 0; i < n; i++) { const t = valtype(r); const f = r.byte(); const min = r.u32(); const max = f & 1 ? r.u32() : null; m.tables.push({ t, min, max }); }
      } else if (id === 5) {
        const n = r.u32();
        for (let i = 0; i < n; i++) { const f = r.byte(); const min = r.u32(); const max = f & 1 ? r.u32() : null; m.memories.push({ min, max, shared: !!(f & 2) }); }
      } else if (id === 6) {
        const n = r.u32();
        for (let i = 0; i < n; i++) { const t = valtype(r); const mut = r.byte(); const init = initExpr(r); m.globals.push({ t, mut, init }); }
      } else if (id === 7) {
        const n = r.u32();
        for (let i = 0; i < n; i++) m.exports.push({ name: r.name(), kind: r.byte(), index: r.u32() });
      } else if (id === 8) {
        m.start = r.u32();
      } else if (id === 9) {
        const n = r.u32();
        for (let i = 0; i < n; i++) {
          const flags = r.u32();
          const el = { flags, table: 0, offset: null, funcs: [] };
          if (flags === 0) { el.offset = initExpr(r); const c = r.u32(); for (let j = 0; j < c; j++) el.funcs.push(r.u32()); }
          else if (flags === 1 || flags === 3) { r.byte(); const c = r.u32(); for (let j = 0; j < c; j++) el.funcs.push(r.u32()); }
          else if (flags === 2) { el.table = r.u32(); el.offset = initExpr(r); r.byte(); const c = r.u32(); for (let j = 0; j < c; j++) el.funcs.push(r.u32()); }
          else if (flags === 4) { el.offset = initExpr(r); const c = r.u32(); for (let j = 0; j < c; j++) { const e = initExpr(r); el.funcs.push(e && e.op === 'ref.func' ? e.value : -1); } }
          else if (flags === 5 || flags === 7) { valtype(r); const c = r.u32(); for (let j = 0; j < c; j++) { const e = initExpr(r); el.funcs.push(e && e.op === 'ref.func' ? e.value : -1); } }
          else if (flags === 6) { el.table = r.u32(); el.offset = initExpr(r); valtype(r); const c = r.u32(); for (let j = 0; j < c; j++) { const e = initExpr(r); el.funcs.push(e && e.op === 'ref.func' ? e.value : -1); } }
          m.elements.push(el);
        }
      } else if (id === 10) {
        const n = r.u32();
        for (let i = 0; i < n; i++) { const size = r.u32(); m.codes.push({ offset: r.pos, size }); r.pos += size; }
      } else if (id === 11) {
        const n = r.u32();
        for (let i = 0; i < n; i++) {
          const flags = r.u32();
          let offset = null, mem = 0;
          if (flags === 0) offset = initExpr(r);
          else if (flags === 2) { mem = r.u32(); offset = initExpr(r); }
          const size = r.u32();
          m.data.push({ flags, mem, offset: offset && (offset.op === 'i32.const' || offset.op === 'i64.const') ? Number(offset.value) : null, at: r.pos, size });
          r.pos += size;
        }
      } else if (id === 0) {
        const nameStart = r.pos;
        const name = r.name();
        m.customs.push({ name, offset: r.pos, size: end - r.pos });
        if (name === 'name') parseNames(new R(u8.subarray(0, end), r.pos), end, m);
        void nameStart;
      }
    } catch (e) {
      m.parseError = `section ${id}: ${e.message}`;
    }
    r.pos = end;
  }
  m.importedFuncs = m.imports.filter((i) => i.kind === 0);
  m.funcCount = m.importedFuncs.length + m.funcs.length;
  return m;
}

function parseNames(r, end, m) {
  while (r.pos < end) {
    const sub = r.byte();
    const size = r.u32();
    const subEnd = r.pos + size;
    if (sub === 1) {
      const n = r.u32();
      for (let i = 0; i < n; i++) { const idx = r.u32(); m.names.set(idx, r.name()); }
    }
    r.pos = subEnd;
  }
}

export function funcName(m, i) {
  if (m.names.has(i)) return m.names.get(i);
  if (i < m.importedFuncs.length) { const imp = m.importedFuncs[i]; return `${imp.module}.${imp.field}`; }
  const ex = m.exports.find((e) => e.kind === 0 && e.index === i);
  if (ex) return ex.name;
  return `f${i}`;
}

export function funcType(m, i) {
  if (i < m.importedFuncs.length) return m.types[m.importedFuncs[i].type];
  return m.types[m.funcs[i - m.importedFuncs.length]];
}

// Linear memory image built from active data segments (32-bit address space).
export function buildMemory(m, u8) {
  const placed = m.data.map((d) => d.offset);
  // passive segments (threaded builds) are copied in by memory.init calls in the code
  if (m.data.some((d) => d.offset == null && d.flags === 1)) {
    for (const [seg, dest] of passiveSegmentTargets(m, u8)) if (placed[seg] == null) placed[seg] = dest;
  }
  let size = 0;
  m.data.forEach((d, i) => { if (placed[i] != null) size = Math.max(size, placed[i] + d.size); });
  if (size > 0x7fffffff) throw new Error('the data segments do not fit in 2 GB of memory');
  const mem = new Uint8Array(size);
  m.data.forEach((d, i) => { if (placed[i] != null) mem.set(u8.subarray(d.at, d.at + d.size), placed[i]); });
  return mem;
}

// Destination of each passive data segment, from `i32.const dest; i32.const src; i32.const n; memory.init seg 0`.
function passiveSegmentTargets(m, u8) {
  const out = new Map();
  const sleb = (p) => { let v = 0, shift = 0, b; do { b = u8[p++]; v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80 && shift < 35); if (shift < 32 && (b & 0x40)) v |= -1 << shift; return [v, p]; };
  const consts = (p, end) => {
    const vals = [];
    for (let k = 0; k < 3; k++) { if (u8[p] !== 0x41) return null; const [v, q] = sleb(p + 1); vals.push(v); p = q; }
    return p === end ? vals : null;
  };
  for (const c of m.codes) {
    const end = c.offset + c.size;
    for (let p = c.offset; p < end - 3; p++) {
      if (u8[p] !== 0xfc || u8[p + 1] !== 0x08) continue;
      let q = p + 2, seg = 0, shift = 0, b;
      do { b = u8[q++]; seg |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80 && shift < 35);
      if (u8[q] !== 0x00 || out.has(seg) || !m.data[seg]) continue;
      // three i32.const operands end right before the opcode; each takes 2 to 6 bytes
      for (let s = p - 6; s >= Math.max(c.offset, p - 18); s--) {
        const vals = consts(s, p);
        if (vals && vals[1] === 0 && vals[0] >= 0) { out.set(seg, vals[0]); break; }
      }
    }
  }
  return out;
}

// table index -> function index (table 0)
export function functionTable(m) {
  const table = new Map();
  for (const el of m.elements) {
    if (el.table !== 0 || !el.offset || el.offset.op !== 'i32.const') continue;
    const base = el.offset.value;
    el.funcs.forEach((f, i) => table.set(base + i, f));
  }
  return table;
}

// ---------------- disassembler ----------------
const OPS = {};
const def = (code, name, imm = '') => { OPS[code] = [name, imm]; };
[[0, 'unreachable'], [1, 'nop'], [2, 'block', 'bt'], [3, 'loop', 'bt'], [4, 'if', 'bt'], [5, 'else'], [6, 'try', 'bt'], [7, 'catch', 'u'], [8, 'throw', 'u'], [9, 'rethrow', 'u'], [10, 'throw_ref'],
  [11, 'end'], [12, 'br', 'u'], [13, 'br_if', 'u'], [14, 'br_table', 'brt'], [15, 'return'], [16, 'call', 'func'], [17, 'call_indirect', 'ci'], [18, 'return_call', 'func'], [19, 'return_call_indirect', 'ci'],
  [20, 'call_ref', 'u'], [21, 'return_call_ref', 'u'], [24, 'delegate', 'u'], [25, 'catch_all'], [26, 'drop'], [27, 'select'], [28, 'select', 'types'], [31, 'try_table', 'trytable'],
  [32, 'local.get', 'u'], [33, 'local.set', 'u'], [34, 'local.tee', 'u'], [35, 'global.get', 'u'], [36, 'global.set', 'u'], [37, 'table.get', 'u'], [38, 'table.set', 'u'],
  [63, 'memory.size', 'b'], [64, 'memory.grow', 'b'], [65, 'i32.const', 's32'], [66, 'i64.const', 's64'], [67, 'f32.const', 'f32'], [68, 'f64.const', 'f64'],
  [0xd0, 'ref.null', 'b'], [0xd1, 'ref.is_null'], [0xd2, 'ref.func', 'func'], [0xd3, 'ref.as_non_null'], [0xd4, 'br_on_null', 'u'], [0xd6, 'br_on_non_null', 'u']].forEach((x) => def(...x));
'i32.load i64.load f32.load f64.load i32.load8_s i32.load8_u i32.load16_s i32.load16_u i64.load8_s i64.load8_u i64.load16_s i64.load16_u i64.load32_s i64.load32_u i32.store i64.store f32.store f64.store i32.store8 i32.store16 i64.store8 i64.store16 i64.store32'
  .split(' ').forEach((n, i) => def(0x28 + i, n, 'mem'));
('i32.eqz i32.eq i32.ne i32.lt_s i32.lt_u i32.gt_s i32.gt_u i32.le_s i32.le_u i32.ge_s i32.ge_u i64.eqz i64.eq i64.ne i64.lt_s i64.lt_u i64.gt_s i64.gt_u i64.le_s i64.le_u i64.ge_s i64.ge_u ' +
  'f32.eq f32.ne f32.lt f32.gt f32.le f32.ge f64.eq f64.ne f64.lt f64.gt f64.le f64.ge i32.clz i32.ctz i32.popcnt i32.add i32.sub i32.mul i32.div_s i32.div_u i32.rem_s i32.rem_u i32.and i32.or i32.xor ' +
  'i32.shl i32.shr_s i32.shr_u i32.rotl i32.rotr i64.clz i64.ctz i64.popcnt i64.add i64.sub i64.mul i64.div_s i64.div_u i64.rem_s i64.rem_u i64.and i64.or i64.xor i64.shl i64.shr_s i64.shr_u i64.rotl i64.rotr ' +
  'f32.abs f32.neg f32.ceil f32.floor f32.trunc f32.nearest f32.sqrt f32.add f32.sub f32.mul f32.div f32.min f32.max f32.copysign f64.abs f64.neg f64.ceil f64.floor f64.trunc f64.nearest f64.sqrt f64.add ' +
  'f64.sub f64.mul f64.div f64.min f64.max f64.copysign i32.wrap_i64 i32.trunc_f32_s i32.trunc_f32_u i32.trunc_f64_s i32.trunc_f64_u i64.extend_i32_s i64.extend_i32_u i64.trunc_f32_s i64.trunc_f32_u ' +
  'i64.trunc_f64_s i64.trunc_f64_u f32.convert_i32_s f32.convert_i32_u f32.convert_i64_s f32.convert_i64_u f32.demote_f64 f64.convert_i32_s f64.convert_i32_u f64.convert_i64_s f64.convert_i64_u ' +
  'f64.promote_f32 i32.reinterpret_f32 i64.reinterpret_f64 f32.reinterpret_i32 f64.reinterpret_i64 i32.extend8_s i32.extend16_s i64.extend8_s i64.extend16_s i64.extend32_s')
  .split(' ').forEach((n, i) => def(0x45 + i, n));
const FC = ['i32.trunc_sat_f32_s', 'i32.trunc_sat_f32_u', 'i32.trunc_sat_f64_s', 'i32.trunc_sat_f64_u', 'i64.trunc_sat_f32_s', 'i64.trunc_sat_f32_u', 'i64.trunc_sat_f64_s', 'i64.trunc_sat_f64_u', 'memory.init', 'data.drop', 'memory.copy', 'memory.fill', 'table.init', 'elem.drop', 'table.copy', 'table.grow', 'table.size', 'table.fill'];
const FC_IMM = { 8: 'u b', 9: 'u', 10: 'b b', 11: 'b', 12: 'u u', 13: 'u', 14: 'u u', 15: 'u', 16: 'u', 17: 'u' };

function blockType(r) {
  const b = r.u8[r.pos];
  if (b === 0x40) { r.pos++; return ''; }
  if (VALTYPE[b] && b !== 0x64 && b !== 0x63) { r.pos++; return ` (result ${VALTYPE[b]})`; }
  return ` (type ${r.s32()})`;
}

export function disassembleFunction(m, u8, funcIndex, { maxInstr = 200000, nameOf } = {}) {
  const local = funcIndex - m.importedFuncs.length;
  const nm = nameOf || ((i) => funcName(m, i));
  const t = funcType(m, funcIndex);
  const head = `(func $${nm(funcIndex)} (;${funcIndex};)${t && t.params.length ? ' (param ' + t.params.join(' ') + ')' : ''}${t && t.results.length ? ' (result ' + t.results.join(' ') + ')' : ''}`;
  if (local < 0) return `${head}\n  ;; imported from ${m.importedFuncs[funcIndex].module}.${m.importedFuncs[funcIndex].field}\n)`;
  const code = m.codes[local];
  if (!code) return `${head}\n  ;; no body\n)`;
  const r = new R(u8, code.offset);
  const end = code.offset + code.size;
  const lines = [head];
  const nLocalGroups = r.u32();
  const locals = [];
  for (let i = 0; i < nLocalGroups; i++) { const c = r.u32(); const ty = valtype(r); locals.push(`${ty}${c > 1 ? '×' + c : ''}`); }
  if (locals.length) lines.push(`  (local ${locals.join(' ')})`);
  let depth = 1, count = 0;
  while (r.pos < end && count++ < maxInstr) {
    const at = r.pos - code.offset;
    const op = r.byte();
    let text;
    if (op === 0xfc) {
      const sub = r.u32();
      text = FC[sub] || `0xfc ${sub}`;
      const imm = FC_IMM[sub];
      if (imm) for (const k of imm.split(' ')) text += ' ' + (k === 'b' ? r.byte() : r.u32());
    } else if (op === 0xfd) {
      const sub = r.u32();
      text = `v128.op_${sub}`;
      if (sub <= 11 || sub === 92 || sub === 93) { const a = r.u32(), o = r.u32(); text += ` offset=${o} align=${2 ** a}`; }
      else if (sub >= 84 && sub <= 91) { r.u32(); const o = r.u32(); text += ` offset=${o} lane=${r.byte()}`; }
      else if (sub === 12 || sub === 13) { text += ' ' + Array.from(r.bytes(16)).join(' '); }
      else if (sub >= 21 && sub <= 34) text += ' lane=' + r.byte();
    } else if (op === 0xfe) {
      const sub = r.u32();
      text = `atomic.op_${sub}`;
      if (sub === 3) r.byte(); else { const a = r.u32(), o = r.u32(); text += ` offset=${o} align=${2 ** a}`; }
    } else {
      const d = OPS[op];
      if (!d) { text = `;; unknown opcode 0x${op.toString(16)}`; lines.push(`  ${text}`); break; }
      const [name, imm] = d;
      text = name;
      switch (imm) {
        case 'bt': text += blockType(r); break;
        case 'u': text += ' ' + r.u32(); break;
        case 'b': text += ' ' + r.byte(); break;
        case 's32': text += ' ' + r.s32(); break;
        case 's64': text += ' ' + r.s64(); break;
        case 'f32': text += ' ' + r.f32(); break;
        case 'f64': text += ' ' + r.f64(); break;
        case 'func': { const f = r.u32(); text += ` $${nm(f)}`; break; }
        case 'ci': { const ty = r.u32(); const tb = r.u32(); text += ` (type ${ty})${tb ? ' ' + tb : ''}`; break; }
        case 'brt': { const n = r.u32(); const ls = []; for (let i = 0; i <= n; i++) ls.push(r.u32()); text += ' ' + ls.join(' '); break; }
        case 'mem': { const a = r.u32(), o = r.u32(); if (o) text += ` offset=${o}`; text += ` align=${2 ** a}`; break; }
        case 'types': { const n = r.u32(); const ts = []; for (let i = 0; i < n; i++) ts.push(valtype(r)); text += ` (result ${ts.join(' ')})`; break; }
        case 'trytable': { text += blockType(r); const n = r.u32(); for (let i = 0; i < n; i++) { const k = r.byte(); if (k < 2) r.u32(); r.u32(); } break; }
        default: break;
      }
      if (name === 'end' || name === 'else' || name === 'catch' || name === 'catch_all' || name === 'delegate') depth--;
    }
    if (r.pos >= end && text === 'end') break;
    lines.push(`${'  '.repeat(Math.max(1, depth))}${text}`.padEnd(48) + `;; +${at}`);
    if (/^(block|loop|if|try|else|catch|catch_all|try_table)\b/.test(text)) depth++;
  }
  if (count >= maxInstr) lines.push('  ;; … truncated');
  lines.push(')');
  return lines.join('\n');
}

export function summarizeWasm(m, name = 'module.wasm') {
  const L = [`# ${name}`, ''];
  L.push(`- Functions: ${m.funcCount.toLocaleString()} (${m.importedFuncs.length} imported, ${m.funcs.length} defined)`);
  L.push(`- Types: ${m.types.length}  Tables: ${m.tables.length}  Memories: ${m.memories.length}${m.memories[0] ? ` (initial ${m.memories[0].min} pages${m.memories[0].shared ? ', shared/threads' : ''})` : ''}`);
  L.push(`- Data segments: ${m.data.length} (${m.data.reduce((a, d) => a + d.size, 0).toLocaleString()} bytes)`);
  L.push(`- Function names: ${m.names.size ? m.names.size.toLocaleString() + ' (name section present)' : 'stripped'}`);
  if (m.customs.length) L.push(`- Custom sections: ${m.customs.map((c) => c.name).join(', ')}`);
  const mods = {};
  for (const i of m.imports) (mods[i.module] ||= []).push(i.field);
  L.push('', '## Imports', '');
  for (const [mod, fields] of Object.entries(mods)) L.push(`### ${mod} (${fields.length})`, fields.slice(0, 600).join(', ') + (fields.length > 600 ? ', …' : ''), '');
  L.push('## Exports', '');
  for (const e of m.exports.slice(0, 2000)) L.push(`- ${['func', 'table', 'memory', 'global', 'tag'][e.kind] || e.kind} ${e.name}${e.kind === 0 ? ` -> ${e.index}` : ''}`);
  return L.join('\n');
}
