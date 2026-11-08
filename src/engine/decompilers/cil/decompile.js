// CIL method body -> C# statements.
// Pipeline: decode IL -> basic blocks -> stack simulation into expression trees
// (with spills that keep evaluation order) -> short-circuit condition merging ->
// structuring (if/else, loops, switch, try/catch/finally; goto as fallback) ->
// C#-flavoured cleanups -> text.
import { T, parseSig } from '../../formats/dotnet.js';
import { decodeIL } from './il.js';
import { ident } from './types.js';
import { negate, simplify, mapExpr, mapStmtExprs, someExpr } from './transforms.js';

const BRANCH_COND = {
  'brtrue': 'true', 'brtrue.s': 'true', 'brfalse': 'false', 'brfalse.s': 'false',
  'beq': '==', 'beq.s': '==', 'bne.un': '!=', 'bne.un.s': '!=', 'bge': '>=', 'bge.s': '>=', 'bge.un': '>=', 'bge.un.s': '>=',
  'bgt': '>', 'bgt.s': '>', 'bgt.un': '>', 'bgt.un.s': '>', 'ble': '<=', 'ble.s': '<=', 'ble.un': '<=', 'ble.un.s': '<=',
  'blt': '<', 'blt.s': '<', 'blt.un': '<', 'blt.un.s': '<',
};
const BINOP = { add: '+', 'add.ovf': '+', 'add.ovf.un': '+', sub: '-', 'sub.ovf': '-', 'sub.ovf.un': '-', mul: '*', 'mul.ovf': '*', 'mul.ovf.un': '*', div: '/', 'div.un': '/', rem: '%', 'rem.un': '%', and: '&', or: '|', xor: '^', shl: '<<', shr: '>>', 'shr.un': '>>' };
const CMP = { ceq: '==', cgt: '>', 'cgt.un': '>', clt: '<', 'clt.un': '<' };
const CONV = { 'conv.i1': 'sbyte', 'conv.i2': 'short', 'conv.i4': 'int', 'conv.i8': 'long', 'conv.r4': 'float', 'conv.r8': 'double', 'conv.u4': 'uint', 'conv.u8': 'ulong', 'conv.u2': 'ushort', 'conv.u1': 'byte', 'conv.i': 'IntPtr', 'conv.u': 'UIntPtr', 'conv.r.un': 'double', 'conv.ovf.i1': 'sbyte', 'conv.ovf.u1': 'byte', 'conv.ovf.i2': 'short', 'conv.ovf.u2': 'ushort', 'conv.ovf.i4': 'int', 'conv.ovf.u4': 'uint', 'conv.ovf.i8': 'long', 'conv.ovf.u8': 'ulong', 'conv.ovf.i': 'IntPtr', 'conv.ovf.u': 'UIntPtr', 'conv.ovf.i1.un': 'sbyte', 'conv.ovf.i2.un': 'short', 'conv.ovf.i4.un': 'int', 'conv.ovf.i8.un': 'long', 'conv.ovf.u1.un': 'byte', 'conv.ovf.u2.un': 'ushort', 'conv.ovf.u4.un': 'uint', 'conv.ovf.u8.un': 'ulong', 'conv.ovf.i.un': 'IntPtr', 'conv.ovf.u.un': 'UIntPtr' };
const LDIND_T = { 'ldind.i1': 'sbyte', 'ldind.u1': 'byte', 'ldind.i2': 'short', 'ldind.u2': 'ushort', 'ldind.i4': 'int', 'ldind.u4': 'uint', 'ldind.i8': 'long', 'ldind.i': 'IntPtr', 'ldind.r4': 'float', 'ldind.r8': 'double', 'ldind.ref': 'object' };
const OPERATORS = { op_Addition: '+', op_Subtraction: '-', op_Multiply: '*', op_Division: '/', op_Modulus: '%', op_BitwiseAnd: '&', op_BitwiseOr: '|', op_ExclusiveOr: '^', op_LeftShift: '<<', op_RightShift: '>>', op_Equality: '==', op_Inequality: '!=', op_LessThan: '<', op_GreaterThan: '>', op_LessThanOrEqual: '<=', op_GreaterThanOrEqual: '>=' };
const CMP_OPS = new Set(['==', '!=', '<', '>', '<=', '>=']);
const UNARY_OPS = { op_UnaryNegation: '-', op_LogicalNot: '!', op_OnesComplement: '~', op_UnaryPlus: '+' };

// ---------------- member resolution ----------------
export class Resolver {
  constructor(mod, namer) {
    this.mod = mod;
    this.namer = namer;
    this.ix = mod.index();
    this.cache = new Map();
  }

  method(tok, gctx) {
    const key = 'm' + tok;
    if (this.cache.has(key) && !gctx) return this.cache.get(key);
    const m = this.mod, table = tok >>> 24, idx = tok & 0xffffff;
    let info;
    if (table === T.MethodDef) {
      const row = m.row(T.MethodDef, idx);
      if (!row) return { name: `method_${tok.toString(16)}`, owner: '?', params: [], ret: null, isStatic: true };
      const owner = this.ix.methodOwner[idx];
      const sig = parseSig(m, row.Signature, 'method');
      info = { name: m.str(row.Name), owner: owner ? this.namer.typeDefName(owner) : '?', ownerDef: owner, sig, params: sig.params, ret: sig.ret, isStatic: !sig.hasThis, def: idx, flags: row.Flags, gtype: owner ? this.namer.typeGenericParams(owner) : [], gmeth: this.namer.methodGenericParams(idx) };
    } else if (table === T.MemberRef) {
      const row = m.row(T.MemberRef, idx);
      const sig = parseSig(m, row.Signature, 'method');
      const p = row.Class;
      let owner = '?', ownerSig = null;
      if (p.table === T.TypeSpec) { ownerSig = parseSig(m, m.row(T.TypeSpec, p.index).Signature, 'typespec'); owner = this.namer.sigName(ownerSig, gctx || {}); }
      else if (p.table === T.TypeRef || p.table === T.TypeDef) owner = this.namer.refName(p.table, p.index);
      else if (p.table === T.MethodDef) return this.method((T.MethodDef << 24) | p.index, gctx);
      info = { name: m.str(row.Name), owner, ownerSig, sig, params: sig.params, ret: sig.ret, isStatic: !sig.hasThis };
      // generic args of the owner type substitute !0 in the signature
      if (ownerSig && ownerSig.k === 'generic') info.typeArgs = ownerSig.args;
      // a reference to a method of this module (generic instantiation): keep the definition
      const defType = p.table === T.TypeDef ? p.index : ownerSig && ownerSig.k === 'generic' && ownerSig.base && ownerSig.base.tok === T.TypeDef ? ownerSig.base.idx : 0;
      if (defType) {
        const [ms, me] = m.listRange(T.TypeDef, defType, 'MethodList', T.MethodDef);
        for (let mi = ms; mi < me; mi++) {
          const mr = m.row(T.MethodDef, mi);
          if (m.str(mr.Name) !== info.name) continue;
          const ds = parseSig(m, mr.Signature, 'method');
          if (ds.params.length !== sig.params.length) continue;
          info.def = mi; info.ownerDef = defType; info.flags = mr.Flags;
          break;
        }
      }
    } else if (table === T.MethodSpec) {
      const row = m.row(T.MethodSpec, idx);
      const base = this.method((row.Method.table << 24) | row.Method.index, gctx);
      const args = parseSig(m, row.Instantiation, 'methodspec');
      info = { ...base, methodArgs: args };
    } else info = { name: `token_${tok.toString(16)}`, owner: '?', params: [], ret: null, isStatic: true };
    if (!gctx) this.cache.set(key, info);
    return info;
  }

  field(tok) {
    const key = 'f' + tok;
    if (this.cache.has(key)) return this.cache.get(key);
    const m = this.mod, table = tok >>> 24, idx = tok & 0xffffff;
    let info;
    if (table === T.Field) {
      const row = m.row(T.Field, idx);
      const owner = this.ix.fieldOwner[idx];
      info = { name: m.str(row.Name), owner: owner ? this.namer.typeDefName(owner) : '?', ownerDef: owner, sig: parseSig(m, row.Signature, 'field'), isStatic: !!(row.Flags & 0x10), def: idx };
    } else if (table === T.MemberRef) {
      const row = m.row(T.MemberRef, idx);
      const p = row.Class;
      let owner = '?', ownerSig = null;
      if (p.table === T.TypeSpec) { ownerSig = parseSig(m, m.row(T.TypeSpec, p.index).Signature, 'typespec'); owner = this.namer.sigName(ownerSig, {}); }
      else owner = this.namer.refName(p.table, p.index);
      info = { name: m.str(row.Name), owner, ownerSig, sig: parseSig(m, row.Signature, 'field'), isStatic: false };
    } else info = { name: `field_${tok.toString(16)}`, owner: '?', sig: null, isStatic: false };
    this.cache.set(key, info);
    return info;
  }

  typeTok(tok, gctx) { return this.namer.tokenName(tok, gctx); }
}

// ---------------- expressions ----------------
const E = {
  c: (v, t) => ({ k: 'const', v, t }),
  bin: (op, a, b, t) => ({ k: 'bin', op, a, b, t }),
};
const isTrivial = (e) => e && (e.k === 'const' || e.k === 'local' || e.k === 'arg' || e.k === 'this' || e.k === 'stackvar' || e.k === 'typeof' || e.k === 'default' || e.k === 'catchvar');

function reads(e, pred) {
  if (!e || typeof e !== 'object') return false;
  if (pred(e)) return true;
  for (const k in e) {
    const v = e[k];
    if (k === 't' || k === 'm' || k === 'f') continue;
    if (Array.isArray(v)) { for (const x of v) if (x && typeof x === 'object' && reads(x, pred)) return true; }
    else if (v && typeof v === 'object' && v.k && reads(v, pred)) return true;
  }
  return false;
}

const refInner = (t) => (t && t.startsWith('ref ') ? t.slice(4) : t);

// ---------------- method decompiler ----------------
export function decompileMethod(ctx, mdIdx, opts = {}) {
  const { mod, namer, resolver } = ctx;
  const row = mod.row(T.MethodDef, mdIdx);
  const body = mod.methodBody(row.RVA);
  if (!body) return null;
  const sig = parseSig(mod, row.Signature, 'method');
  const owner = mod.index().methodOwner[mdIdx];
  const gctx = { type: owner ? namer.typeGenericParams(owner) : [], method: namer.methodGenericParams(mdIdx) };
  const isStatic = !sig.hasThis;
  const [ps, pe] = mod.listRange(T.MethodDef, mdIdx, 'ParamList', T.Param);
  const paramNames = [];
  for (let p = ps; p < pe; p++) { const pr = mod.row(T.Param, p); if (pr.Sequence > 0) paramNames[pr.Sequence - 1] = ident(mod.str(pr.Name)); }
  const params = sig.params.map((t, i) => ({ name: paramNames[i] || `p${i}`, sig: t, type: namer.sigName(t, gctx) }));
  let localSigs = [];
  if (body.localSig) {
    const ss = mod.row(T.StandAloneSig, body.localSig & 0xffffff);
    if (ss) localSigs = parseSig(mod, ss.Signature, 'locals');
  }
  const locals = localSigs.map((t, i) => ({ i, sig: t, type: namer.sigName(t, gctx).replace(/^ref /, 'ref '), name: null, used: false }));
  const insns = decodeIL(body.code);
  if (!insns.length) return { stmts: [], locals, params };

  const st = new MethodState(ctx, { mdIdx, isStatic, params, locals, sig, gctx, owner, insns, handlers: body.handlers, methodName: mod.str(row.Name), iter: opts.iterator || null, raw: !!opts.raw });
  st.build();
  return st.output();
}

class MethodState {
  constructor(ctx, o) {
    Object.assign(this, ctx, o);
    this.tmpCount = 0;
    this.extraLocals = [];
    this.svPairs = [];
  }

  // A stack slot that carries values across blocks becomes one variable per connected
  // group of blocks, so unrelated uses of the same slot don't share a name.
  numberStackVars() {
    const parent = new Map();
    const find = (x) => { while (parent.has(x) && parent.get(x) !== x) { const p = parent.get(parent.get(x)) ?? parent.get(x); parent.set(x, p); x = p; } return x; };
    const union = (a, b) => { if (!parent.has(a)) parent.set(a, a); if (!parent.has(b)) parent.set(b, b); const ra = find(a), rb = find(b); if (ra !== rb) parent.set(ra, rb); };
    for (const [a, b] of this.svPairs) union(a, b);
    for (const b of this.blocks) {
      if (!b.exitDepth || !b.term || b.term.k === 'ret' || b.term.k === 'throw') continue;
      for (const sc of b.succ) for (let i = 0; i < b.exitDepth; i++) if (!sc.handlerEntry) union(`x:${b.id}:${i}`, `e:${sc.id}:${i}`);
    }
    const ids = new Map(), types = new Map();
    const idOf = (sv) => { const r = find(sv); if (!ids.has(r)) ids.set(r, ids.size); return ids.get(r); };
    const fn = (e) => (e.k === 'stackvar' && e.sv ? { ...e, n: idOf(e.sv) } : undefined);
    for (const b of this.blocks) {
      b.stmts = b.stmts.map((st) => {
        const ns = mapStmtExprs(st, fn);
        if (ns.k === 'assign' && ns.target.k === 'stackvar' && ns.target.sv) {
          const n = idOf(ns.target.sv);
          if (!types.has(n) || types.get(n) === 'var') types.set(n, ns.value.t || 'var');
          return { ...ns, target: { ...ns.target, n } };
        }
        return ns;
      });
      const t = b.term;
      if (t && t.k === 'cond') b.term = { ...t, cond: mapExpr(t.cond, fn) };
      else if (t && (t.k === 'ret' || t.k === 'throw' || t.k === 'switch') && t.e) b.term = { ...t, e: mapExpr(t.e, fn) };
      if (b.filterCond) b.filterCond = mapExpr(b.filterCond, fn);
    }
    this.extraLocals = this.extraLocals.filter((l) => !l.name.startsWith('stack'));
    for (const [n, t] of types) this.extraLocals.push({ name: `stack${n}`, type: t || 'var' });
  }

  // ---------- blocks ----------
  build() {
    const insns = this.insns;
    const byOff = new Map(insns.map((x, i) => [x.off, i]));
    this.byOff = byOff;
    const leaders = new Set([0]);
    for (const h of this.handlers) { leaders.add(h.tryStart); leaders.add(h.tryEnd); leaders.add(h.hStart); leaders.add(h.hEnd); if (h.filterStart != null) leaders.add(h.filterStart); }
    for (let i = 0; i < insns.length; i++) {
      const x = insns[i];
      if (x.op === 'br1' || x.op === 'br4') { leaders.add(x.arg); leaders.add(x.end); }
      else if (x.op === 'sw') { for (const t of x.arg) leaders.add(t); leaders.add(x.end); }
      else if (/^(ret|throw|rethrow|endfinally|endfilter|jmp)$/.test(x.name)) leaders.add(x.end);
    }
    const sorted = [...leaders].filter((o) => byOff.has(o)).sort((a, b) => a - b);
    this.blocks = [];
    this.blockAt = new Map();
    for (let i = 0; i < sorted.length; i++) {
      const start = sorted[i], end = i + 1 < sorted.length ? sorted[i + 1] : insns[insns.length - 1].end;
      const b = { id: this.blocks.length, start, end, insns: [], succ: [], pred: [], stmts: [], term: null };
      for (let j = byOff.get(start); j < insns.length && insns[j].off < end; j++) b.insns.push(insns[j]);
      this.blocks.push(b);
      this.blockAt.set(start, b);
    }
    // edges
    for (let i = 0; i < this.blocks.length; i++) {
      const b = this.blocks[i];
      const last = b.insns[b.insns.length - 1];
      const next = this.blocks[i + 1];
      const add = (off) => { const t = this.blockAt.get(off); if (t && !b.succ.includes(t)) b.succ.push(t); };
      if (!last) { if (next) add(next.start); continue; }
      if (last.op === 'br1' || last.op === 'br4') {
        if (/^(br|br\.s|leave|leave\.s)$/.test(last.name)) add(last.arg);
        else { add(last.arg); if (next) add(next.start); }
      } else if (last.op === 'sw') { for (const t of last.arg) add(t); if (next) add(next.start); }
      else if (!/^(ret|throw|rethrow|endfinally|endfilter|jmp)$/.test(last.name) && next) add(next.start);
    }
    for (const b of this.blocks) for (const s of b.succ) s.pred.push(b);
    // simulate stacks in block order with a worklist (entry stacks via spill variables)
    this.entryDepth = new Map([[this.blocks[0], 0]]);
    for (const h of this.handlers) {
      const hb = this.blockAt.get(h.hStart);
      if (hb) { this.entryDepth.set(hb, h.flags === 0 || h.flags === 1 ? 1 : 0); hb.handlerEntry = h; }
      const fb = h.filterStart != null ? this.blockAt.get(h.filterStart) : null;
      if (fb) { this.entryDepth.set(fb, 1); fb.handlerEntry = h; }
    }
    const work = [...this.entryDepth.keys()];
    const done = new Set();
    while (work.length) {
      const b = work.shift();
      if (done.has(b)) continue;
      done.add(b);
      this.simulate(b);
      for (const s of b.succ) if (!done.has(s)) { if (!this.entryDepth.has(s)) this.entryDepth.set(s, b.exitDepth || 0); work.push(s); }
    }
    for (const b of this.blocks) if (!done.has(b)) { this.entryDepth.set(b, 0); this.simulate(b); b.unreachable = true; }
    this.numberStackVars();
    this.threadJumps();
    this.mergeConditions();
    if (this.iter) this.rewriteIterator();
    this.computeDominators();
  }

  // MoveNext of a compiler-generated iterator: resume points become plain control flow and
  // "current = x; state = n; return true" becomes "yield return x".
  rewriteIterator() {
    const it = this.iter;
    const blocks = this.live;
    const isThisF = (e, name) => e && e.k === 'field' && e.obj && e.obj.k === 'this' && e.f.name === name;
    const isState = (e) => isThisF(e, it.state);
    const unc = (e) => (e && e.k === 'cast' ? e.a : e);
    const mapTerm = (t, fn) => {
      if (t.k === 'cond') return { ...t, cond: mapExpr(t.cond, fn) };
      if ((t.k === 'ret' || t.k === 'throw' || t.k === 'switch') && t.e) return { ...t, e: mapExpr(t.e, fn) };
      return t;
    };
    // locals that only alias the outer instance (Foo foo = <>4__this;)
    const writes = new Map();
    for (const b of blocks) for (const s of b.stmts) if (s.k === 'assign' && s.target.k === 'local') writes.set(s.target.i, (writes.get(s.target.i) || []).concat([s.value]));
    const alias = new Map();
    for (const [i, vals] of writes) if (vals.length === 1 && it.thisField && isThisF(vals[0], it.thisField)) alias.set(i, vals[0]);
    if (alias.size) {
      const fn = (e) => (e.k === 'local' && alias.has(e.i) ? alias.get(e.i) : undefined);
      for (const b of blocks) {
        b.stmts = b.stmts.filter((s) => !(s.k === 'assign' && s.target.k === 'local' && alias.has(s.target.i))).map((s) => mapStmtExprs(s, fn));
        b.term = mapTerm(b.term, fn);
      }
    }
    const evalE = (e, env) => {
      e = unc(e);
      if (!e) return null;
      if (e.k === 'const') return typeof e.v === 'boolean' ? +e.v : typeof e.v === 'number' ? e.v : null;
      if (e.k === 'local' && env.has(e.i)) return env.get(e.i);
      if (isState(e)) return env.get('state');
      if (e.k === 'cmp') {
        const a = evalE(e.a, env), b = evalE(e.b, env);
        if (a == null || b == null) return null;
        return +({ '==': a === b, '!=': a !== b, '<': a < b, '>': a > b, '<=': a <= b, '>=': a >= b }[e.op]);
      }
      if (e.k === 'not') { const a = evalE(e.a, env); return a == null ? null : +!a; }
      if (e.k === 'logic') {
        const a = evalE(e.a, env);
        if (a == null) return null;
        if (e.op === '&&' ? !a : a) return a ? 1 : 0;
        const b = evalE(e.b, env);
        return b == null ? null : +!!b;
      }
      if (e.k === 'bin' && (e.op === '-' || e.op === '+')) { const a = evalE(e.a, env), b = evalE(e.b, env); return a == null || b == null ? null : e.op === '-' ? a - b : a + b; }
      return null;
    };
    const resume = (sv) => {
      const env = new Map([['state', sv]]);
      let b = blocks[0];
      for (let guard = 0; guard < 64 && b; guard++) {
        let pure = true;
        for (const s of b.stmts) {
          if (s.k === 'assign' && s.target.k === 'local' && isState(unc(s.value))) { env.set(s.target.i, sv); continue; }
          if (s.k === 'assign' && isState(s.target)) continue;
          pure = false; break;
        }
        if (!pure) return b;
        const t = b.term;
        let next;
        if (t.k === 'goto' || t.k === 'fall') next = t.target;
        else if (t.k === 'cond') { const v = evalE(t.cond, env); if (v == null) return b; next = v ? t.target : t.fall; }
        else if (t.k === 'switch') { const v = evalE(t.e, env); if (v == null) return b; next = v >= 0 && v < t.targets.length ? t.targets[v] : t.fall; }
        else return b;
        b = this.blockAt.get(next);
      }
      return null;
    };
    const sites = [];
    for (const b of blocks) {
      const ci = b.stmts.findIndex((s) => s.k === 'assign' && isThisF(s.target, it.current));
      if (ci < 0) continue;
      let N = null, ok = false, cur = b, k = ci + 1;
      const retLocal = new Map();
      for (let chain = 0; cur && chain < 6; chain++) {
        let bad = false;
        for (; k < cur.stmts.length; k++) {
          const s = cur.stmts[k];
          if (s.k === 'assign' && isState(s.target) && s.value.k === 'const') { N = s.value.v; continue; }
          if (s.k === 'assign' && s.target.k === 'local' && s.value.k === 'const') { retLocal.set(s.target.i, s.value.v); continue; }
          bad = true; break;
        }
        if (bad) break;
        const t = cur.term;
        if (t.k === 'ret') { const v = t.e && (t.e.k === 'const' ? t.e.v : t.e.k === 'local' ? retLocal.get(t.e.i) : null); ok = v === 1 || v === true; break; }
        if (t.k === 'goto' || t.k === 'fall' || t.k === 'leave') { cur = this.blockAt.get(t.target); k = 0; continue; }
        if (t.k === 'cond' && someExpr(t.cond, (x) => x.k === 'field' && /disposing/.test(x.f.name))) { cur = this.blockAt.get(t.fall); k = 0; continue; }
        break;
      }
      if (ok && N != null) sites.push({ b, ci, value: b.stmts[ci].value, N });
    }
    const r0 = resume(0);
    if (!sites.length && !r0) return;
    if (!r0) return;
    for (const site of sites) { site.target = resume(site.N); if (!site.target) return; }
    for (const site of sites) {
      site.b.stmts = [...site.b.stmts.slice(0, site.ci), { k: 'yield', e: site.value }];
      site.b.term = { k: 'goto', target: site.target.start };
    }
    const outer = this.handlers.find((h) => h.flags === 4 && h.tryStart === 0);
    for (const b of blocks) {
      const t = b.term;
      if (t.k === 'ret' && t.e && t.e.k === 'const' && (t.e.v === 0 || t.e.v === false)) { b.term = { k: 'yieldbreak' }; continue; }
      if (t.k === 'leave' || t.k === 'goto' || t.k === 'fall') {
        const last = b.stmts[b.stmts.length - 1];
        const tb = this.blockAt.get(t.target);
        if (last && last.k === 'assign' && last.target.k === 'local' && last.value.k === 'const' && last.value.v === 0 && tb && !tb.stmts.length && tb.term.k === 'ret' && tb.term.e && tb.term.e.k === 'local' && tb.term.e.i === last.target.i) {
          b.stmts = b.stmts.slice(0, -1);
          b.term = { k: 'yieldbreak' };
          continue;
        }
      }
      if (t.k === 'leave' && outer && b.start >= outer.tryStart && b.start < outer.tryEnd && t.target >= outer.tryEnd) b.term = { k: 'goto', target: t.target };
    }
    this.skipTry = outer || null;
    this.entryBlock = r0;
    this.iterOK = true;
  }

  newTemp(type) {
    const name = `tmp${this.tmpCount++}`;
    this.extraLocals.push({ name, type: type || 'var' });
    return { k: 'tmp', name, t: type };
  }

  local(i) { const l = this.locals[i]; if (l) l.used = true; return { k: 'local', i, t: l ? l.type : 'object', sig: l && l.sig }; }
  arg(i) {
    if (!this.isStatic) { if (i === 0) return { k: 'this', t: this.owner ? this.namer.typeDefName(this.owner) : 'object' }; i--; }
    const p = this.params[i];
    return { k: 'arg', i, name: p ? p.name : `arg${i}`, t: p ? p.type : 'object', sig: p && p.sig };
  }

  simulate(b) {
    const depth = this.entryDepth.get(b) || 0;
    const stack = [];
    for (let i = 0; i < depth; i++) stack.push(b.handlerEntry && i === 0 ? { k: 'catchvar', h: b.handlerEntry } : { k: 'stackvar', n: i, t: 'var', sv: `e:${b.id}:${i}` });
    const out = b.stmts;
    const emit = (s) => out.push(s);
    // Spill stack values that a statement could change, to keep evaluation order.
    const spill = (pred, vars) => {
      for (let i = 0; i < stack.length; i++) {
        const e = stack[i];
        if (e.k === 'const' || e.k === 'catchvar') continue;
        if ((!isTrivial(e) || vars) && (pred === true || reads(e, pred))) {
          const tmp = this.newTemp(e.t);
          emit({ k: 'assign', target: tmp, value: e, decl: true });
          stack[i] = tmp;
        }
      }
    };
    const pop = () => (stack.length ? stack.pop() : { k: 'raw', text: '/*stack underflow*/', t: 'object' });
    const push = (e) => stack.push(e);
    let constrained = null;
    for (const x of b.insns) {
      const n = x.name;
      if (n === 'nop' || n === 'break' || n === 'volatile.' || n === 'tail.' || n === 'readonly.' || n === 'unaligned.' || n === 'no.') continue;
      if (n === 'constrained.') { constrained = x.arg; continue; }
      if (n.startsWith('ldarg')) {
        const i = n === 'ldarg.0' ? 0 : n === 'ldarg.1' ? 1 : n === 'ldarg.2' ? 2 : n === 'ldarg.3' ? 3 : x.arg;
        push(n.startsWith('ldarga') ? { k: 'addr', a: this.arg(i), t: 'ref' } : this.arg(i));
        continue;
      }
      if (n.startsWith('ldloc')) {
        const i = /^ldloc\.\d$/.test(n) ? +n[6] : x.arg;
        push(n.startsWith('ldloca') ? { k: 'addr', a: this.local(i), t: 'ref' } : this.local(i));
        continue;
      }
      if (n.startsWith('stloc')) {
        const i = /^stloc\.\d$/.test(n) ? +n[6] : x.arg;
        const v = pop();
        if (v.k === 'catchvar') { v.h.local = i; this.local(i); continue; }
        spill((e) => e.k === 'local' && e.i === i, true);
        emit({ k: 'assign', target: this.local(i), value: v });
        continue;
      }
      if (n.startsWith('starg')) {
        const v = pop();
        const a = this.arg(x.arg);
        if (a.k === 'arg') spill((e) => e.k === 'arg' && e.i === a.i, true);
        emit({ k: 'assign', target: a, value: v });
        continue;
      }
      if (n === 'ldnull') { push(E.c(null, 'null')); continue; }
      if (n.startsWith('ldc.i4')) {
        let v = x.arg;
        if (v == null) v = n === 'ldc.i4.m1' ? -1 : +n.slice(7);
        push(E.c(v, 'int'));
        continue;
      }
      if (n === 'ldc.i8') { push(E.c(x.arg, 'long')); continue; }
      if (n === 'ldc.r4') { push(E.c(x.arg, 'float')); continue; }
      if (n === 'ldc.r8') { push(E.c(x.arg, 'double')); continue; }
      if (n === 'ldstr') { push(E.c(this.mod.userString(x.arg & 0xffffff), 'string')); continue; }
      if (n === 'dup') {
        const v = pop();
        if (isTrivial(v)) { push(v); push(v); }
        else { const tmp = this.newTemp(v.t); emit({ k: 'assign', target: tmp, value: v, decl: true }); push(tmp); push(tmp); }
        continue;
      }
      if (n === 'pop') {
        const v = pop();
        if (!isTrivial(v)) emit({ k: 'expr', e: v });
        continue;
      }
      if (BINOP[n]) { const bb = pop(), a = pop(); push(E.bin(BINOP[n], a, bb, a.t === 'float' || a.t === 'double' ? a.t : bb.t === 'long' ? 'long' : a.t)); continue; }
      if (n === 'neg') { const a = pop(); push({ k: 'un', op: '-', a, t: a.t }); continue; }
      if (n === 'not') { const a = pop(); push({ k: 'un', op: '~', a, t: a.t }); continue; }
      if (CMP[n]) { const bb = pop(), a = pop(); push({ k: 'cmp', op: CMP[n], a, b: bb, t: 'bool', float: n.endsWith('.un') && (a.t === 'float' || a.t === 'double') }); continue; }
      if (CONV[n]) {
        const a = pop();
        if (a.k === 'const' && typeof a.v === 'number' && CONV[n] === 'long') push(E.c(a.v, 'long'));
        else if (a.t === CONV[n] || (a.k === 'len' && /^(int|IntPtr|long)$/.test(CONV[n]))) push(a);
        else push({ k: 'cast', type: CONV[n], a, t: CONV[n], conv: true });
        continue;
      }
      if (n === 'ckfinite') continue;
      if (n === 'ldlen') { const a = pop(); push({ k: 'len', a, t: 'int' }); continue; }
      if (n.startsWith('ldelem')) {
        const idx = pop(), arr = pop();
        if (n === 'ldelema') push({ k: 'addr', a: { k: 'elem', a: arr, i: idx }, t: 'ref' });
        else push({ k: 'elem', a: arr, i: idx, t: arr.t && arr.t.endsWith('[]') ? arr.t.slice(0, -2) : 'object' });
        continue;
      }
      if (n.startsWith('stelem')) {
        const v = pop(), idx = pop(), arr = pop();
        spill((e) => e.k === 'elem' || e.k === 'call');
        emit({ k: 'assign', target: { k: 'elem', a: arr, i: idx, t: arr.t && arr.t.endsWith('[]') ? arr.t.slice(0, -2) : 'object' }, value: v });
        continue;
      }
      if (n === 'newarr') { const size = pop(); push({ k: 'newarr', type: this.resolver.typeTok(x.arg, this.gctx), size, t: this.resolver.typeTok(x.arg, this.gctx) + '[]' }); continue; }
      if (LDIND_T[n] || n === 'ldobj') { const a = pop(); push(a.k === 'addr' ? a.a : this.isRefVar(a) ? { ...a, t: refInner(a.t) } : { k: 'deref', a, t: LDIND_T[n] || 'object' }); continue; }
      if (n.startsWith('stind') || n === 'stobj') {
        const v = pop(), a = pop();
        spill(true);
        emit({ k: 'assign', target: a.k === 'addr' ? a.a : this.isRefVar(a) ? { ...a, t: refInner(a.t) } : { k: 'deref', a }, value: v });
        continue;
      }
      if (n === 'ldfld' || n === 'ldsfld' || n === 'ldflda' || n === 'ldsflda') {
        const f = this.resolver.field(x.arg);
        const obj = n === 'ldfld' || n === 'ldflda' ? pop() : null;
        const fe = { k: 'field', obj: obj && obj.k === 'addr' ? obj.a : obj, f, t: f.sig ? this.namer.sigName(f.sig, this.gctx) : 'object', sig: f.sig };
        push(n.endsWith('a') ? { k: 'addr', a: fe, t: 'ref' } : fe);
        continue;
      }
      if (n === 'stfld' || n === 'stsfld') {
        const f = this.resolver.field(x.arg);
        const v = pop();
        const obj = n === 'stfld' ? pop() : null;
        spill((e) => e.k === 'field' && e.f.name === f.name || e.k === 'call');
        emit({ k: 'assign', target: { k: 'field', obj: obj && obj.k === 'addr' ? obj.a : obj, f, t: f.sig ? this.namer.sigName(f.sig, this.gctx) : 'object', sig: f.sig }, value: v });
        continue;
      }
      if (n === 'call' || n === 'callvirt' || n === 'newobj') {
        const m = this.resolver.method(x.arg);
        const args = [];
        for (let i = 0; i < m.params.length; i++) args.unshift(pop());
        if (n === 'newobj') {
          const typeName = m.owner;
          // delegate construction: new Action(obj, ldftn) -> method group
          if (args.length === 2 && args[1].k === 'fnptr') {
            push({ k: 'delegate', type: typeName, target: args[0], method: args[1].m, t: typeName });
          } else push({ k: 'new', type: typeName, args, m, t: typeName });
          continue;
        }
        let obj = m.isStatic ? null : pop();
        if (obj && obj.k === 'addr') obj = obj.a;
        const retT = m.ret ? this.retName(m) : 'void';
        const isBase = n === 'call' && obj && obj.k === 'this' && !m.isStatic && m.ownerDef !== this.owner && (m.name === '.ctor' || m.name === this.methodName || (m.flags != null && (m.flags & 0x40)));
        let call = { k: 'call', obj, m, args, t: retT, virt: n === 'callvirt', base: isBase, constrained };
        constrained = null;
        // user-defined operators read as operators (so compound assignment works on them too)
        if (m.isStatic && args.length === 2 && OPERATORS[m.name] && !CMP_OPS.has(OPERATORS[m.name])) call = { k: 'bin', op: OPERATORS[m.name], a: args[0], b: args[1], t: retT, opcall: true };
        if (retT === 'void') { spill((e) => e.k === 'call' || e.k === 'field' || e.k === 'elem'); emit({ k: 'expr', e: call }); }
        else push(call);
        continue;
      }
      if (n === 'calli') { const sg = this.mod.row(T.StandAloneSig, x.arg & 0xffffff); const s = sg ? parseSig(this.mod, sg.Signature, 'method') : { params: [], ret: null }; pop(); const args = []; for (let i = 0; i < s.params.length; i++) args.unshift(pop()); const e = { k: 'raw', text: `calli(${args.length} args)`, t: 'object' }; if (s.ret && s.ret.name !== 'void') push(e); else emit({ k: 'expr', e }); continue; }
      if (n === 'ldftn' || n === 'ldvirtftn') { if (n === 'ldvirtftn') pop(); push({ k: 'fnptr', m: this.resolver.method(x.arg), t: 'IntPtr' }); continue; }
      if (n === 'castclass' || n === 'unbox.any' || n === 'unbox') { const a = pop(); push({ k: 'cast', type: this.resolver.typeTok(x.arg, this.gctx), a, t: this.resolver.typeTok(x.arg, this.gctx) }); continue; }
      if (n === 'isinst') { const a = pop(); push({ k: 'as', type: this.resolver.typeTok(x.arg, this.gctx), a, t: this.resolver.typeTok(x.arg, this.gctx) }); continue; }
      if (n === 'box') { const a = pop(); const ty = this.resolver.typeTok(x.arg, this.gctx); push({ ...a, boxed: ty, t: a.t === 'int' && ty !== 'int' ? ty : a.t }); continue; }
      if (n === 'ldtoken') {
        const tb = x.arg >>> 24;
        if (tb === T.TypeDef || tb === T.TypeRef || tb === T.TypeSpec) push({ k: 'typeof', type: this.resolver.typeTok(x.arg, this.gctx), t: 'RuntimeTypeHandle', handle: true });
        else if (tb === T.Field) push({ k: 'raw', text: `fieldof(${this.resolver.field(x.arg).name})`, t: 'RuntimeFieldHandle', fieldTok: x.arg });
        else push({ k: 'raw', text: `methodof(${this.resolver.method(x.arg).name})`, t: 'RuntimeMethodHandle' });
        continue;
      }
      if (n === 'sizeof') { push({ k: 'raw', text: `sizeof(${this.resolver.typeTok(x.arg, this.gctx)})`, t: 'int' }); continue; }
      if (n === 'initobj') {
        const a = pop();
        emit({ k: 'assign', target: a.k === 'addr' ? a.a : this.isRefVar(a) ? a : { k: 'deref', a }, value: { k: 'default', type: this.resolver.typeTok(x.arg, this.gctx) } });
        continue;
      }
      if (n === 'localloc') { const a = pop(); push({ k: 'intrinsic', name: 'stackalloc', args: [a], t: 'byte*' }); continue; }
      if (n === 'cpblk' || n === 'initblk') { pop(); pop(); pop(); emit({ k: 'comment', text: n }); continue; }
      if (n === 'arglist') { push({ k: 'raw', text: '__arglist', t: 'object' }); continue; }
      if (n === 'mkrefany' || n === 'refanyval' || n === 'refanytype') { const a = pop(); push({ k: 'intrinsic', name: n, args: [a], t: 'object' }); continue; }
      // terminators
      if (n === 'ret') { b.term = { k: 'ret', e: this.sig.ret && this.sig.ret.name !== 'void' ? pop() : null }; break; }
      if (n === 'throw') { b.term = { k: 'throw', e: pop() }; break; }
      if (n === 'rethrow') { b.term = { k: 'throw', e: null }; break; }
      if (n === 'endfinally' || n === 'endfilter') { if (n === 'endfilter') b.filterCond = pop(); b.term = { k: 'endfinally' }; break; }
      if (n === 'jmp') { b.term = { k: 'ret', e: null }; break; }
      if (n === 'br' || n === 'br.s') { b.term = { k: 'goto', target: x.arg }; break; }
      if (n === 'leave' || n === 'leave.s') { stack.length = 0; b.term = { k: 'leave', target: x.arg }; break; }
      if (BRANCH_COND[n]) {
        const op = BRANCH_COND[n];
        let cond;
        if (op === 'true' || op === 'false') { const a = pop(); cond = this.truthy(a); if (op === 'false') cond = negate(cond); }
        else { const bb = pop(), a = pop(); cond = { k: 'cmp', op, a, b: bb, t: 'bool' }; }
        b.term = { k: 'cond', cond, target: x.arg, fall: x.end };
        break;
      }
      if (n === 'switch') { const v = pop(); b.term = { k: 'switch', e: v, targets: x.arg, fall: x.end }; break; }
      emit({ k: 'comment', text: `unsupported: ${n}` });
    }
    if (!b.term) b.term = { k: 'fall', target: b.end };
    // spill remaining stack for successors
    b.exitDepth = stack.length;
    if (stack.length && b.term.k !== 'ret' && b.term.k !== 'throw') {
      stack.forEach((e, i) => {
        if (e.k === 'stackvar' && e.sv === `e:${b.id}:${i}`) { this.svPairs.push([e.sv, `x:${b.id}:${i}`]); return; }
        out.push({ k: 'assign', target: { k: 'stackvar', n: i, t: e.t, sv: `x:${b.id}:${i}` }, value: e });
      });
    }
  }

  isRefVar(a) { return (a.k === 'arg' || a.k === 'local') && a.sig && a.sig.k === 'byref' || a.k === 'this'; }

  retName(m) {
    const gc = { type: m.typeArgs ? m.typeArgs.map((a) => this.namer.sigName(a, this.gctx)) : (m.gtype || []), method: m.methodArgs ? m.methodArgs.map((a) => this.namer.sigName(a, this.gctx)) : (m.gmeth || []) };
    return this.namer.sigName(m.ret, gc);
  }

  truthy(a) {
    if (a.t === 'bool' || a.k === 'cmp' || a.k === 'not' || a.k === 'logic') return a;
    // the signature says whether this is a reference (null test) or a number/enum (zero test)
    const sg = a.k === 'call' ? a.m && a.m.ret : a.k === 'field' || a.k === 'local' || a.k === 'arg' ? a.sig : null;
    if (sg && !a.boxed) {
      if (sg.k === 'valuetype' || (sg.k === 'prim' && !/^(string|object)$/.test(sg.name))) return { k: 'cmp', op: '!=', a, b: E.c(0, 'int'), t: 'bool' };
      if (sg.k === 'class' || sg.k === 'szarray' || sg.k === 'array' || sg.k === 'generic' || sg.k === 'prim') return { k: 'cmp', op: '!=', a, b: E.c(null, 'null'), t: 'bool' };
    }
    if (a.k === 'as' || a.t === 'string' || a.t === 'object' || (a.t && /^[A-Z]/.test(a.t) && !/^(IntPtr|UIntPtr)$/.test(a.t)) || a.t === 'null') return { k: 'cmp', op: '!=', a, b: E.c(null, 'null'), t: 'bool' };
    return { k: 'cmp', op: '!=', a, b: E.c(0, 'int'), t: 'bool' };
  }

  // Jumps to empty "goto X" blocks go straight to X.
  threadJumps() {
    const final = (off) => {
      let b = this.blockAt.get(off);
      for (let guard = 0; b && guard < 32; guard++) {
        if (b.stmts.length || !b.term || (b.term.k !== 'goto' && b.term.k !== 'fall') || b.handlerEntry || (this.entryDepth.get(b) || 0) !== 0) break;
        const nb = this.blockAt.get(b.term.target);
        if (!nb || nb === b || this.inDifferentTry(b, nb)) break;
        b = nb;
      }
      return b ? b.start : off;
    };
    let changed = false;
    for (const b of this.blocks) {
      const t = b.term;
      if (!t) continue;
      const fix = (off) => { const f = final(off); if (f !== off && !this.inDifferentTry(b, this.blockAt.get(f))) { changed = true; return f; } return off; };
      if (t.k === 'cond') b.term = { ...t, target: fix(t.target), fall: fix(t.fall) };
      else if (t.k === 'goto' || t.k === 'fall') b.term = { ...t, k: 'goto', target: fix(t.target) };
      else if (t.k === 'switch') b.term = { ...t, targets: t.targets.map(fix), fall: fix(t.fall) };
    }
    if (!changed) return;
    for (const b of this.blocks) { b.succ = []; b.pred = []; }
    for (const b of this.blocks) {
      for (const sc of this.succOf(b)) if (!b.succ.includes(sc)) b.succ.push(sc);
      // exception handler entries keep their implicit edges
    }
    for (const b of this.blocks) for (const sc of b.succ) sc.pred.push(b);
  }

  // Merge chains of condition-only blocks into && / || expressions.
  mergeConditions() {
    let changed = true, guard = 0;
    while (changed && guard++ < 200) {
      changed = false;
      for (const a of this.blocks) {
        if (!a.term || a.term.k !== 'cond' || a.dead) continue;
        const t = this.blockAt.get(a.term.target), f = this.blockAt.get(a.term.fall);
        for (const [x, other, aGoesToX] of [[f, t, false], [t, f, true]]) {
          if (!x || x === a || x.dead || x.stmts.length || x.pred.length !== 1 || !x.term || x.term.k !== 'cond' || (this.entryDepth.get(x) || 0) !== 0 || x.handlerEntry) continue;
          if (this.inDifferentTry(a, x)) continue;
          const xt = this.blockAt.get(x.term.target), xf = this.blockAt.get(x.term.fall);
          const ca = aGoesToX ? negate(a.term.cond) : a.term.cond; // condition under which a goes to `other`
          let cond, target, fall;
          if (xt === other) { cond = { k: 'logic', op: '||', a: ca, b: x.term.cond, t: 'bool' }; target = other; fall = xf; }
          else if (xf === other) { cond = { k: 'logic', op: '||', a: ca, b: negate(x.term.cond), t: 'bool' }; target = other; fall = xt; }
          else continue;
          // a: (cond) -> target else fall
          a.term = { k: 'cond', cond, target: target.start, fall: fall.start, merged: true };
          a.succ = [target, fall].filter((v, i, arr) => arr.indexOf(v) === i);
          x.dead = true;
          for (const s of [xt, xf]) if (s) s.pred = s.pred.filter((p) => p !== x);
          if (!target.pred.includes(a)) target.pred.push(a);
          if (!fall.pred.includes(a)) fall.pred.push(a);
          changed = true;
          break;
        }
      }
    }
    this.live = this.blocks.filter((b) => !b.dead);
  }

  inDifferentTry(a, b) {
    for (const h of this.handlers) {
      const ina = a.start >= h.tryStart && a.start < h.tryEnd, inb = b.start >= h.tryStart && b.start < h.tryEnd;
      const ha = a.start >= h.hStart && a.start < h.hEnd, hb = b.start >= h.hStart && b.start < h.hEnd;
      if (ina !== inb || ha !== hb) return true;
    }
    return false;
  }

  succOf(b) {
    const t = b.term;
    const get = (o) => this.blockAt.get(o);
    if (!t) return [];
    if (t.k === 'cond') return [get(t.target), get(t.fall)].filter(Boolean);
    if (t.k === 'goto' || t.k === 'fall') return [get(t.target)].filter(Boolean);
    if (t.k === 'switch') return [...t.targets.map(get), get(t.fall)].filter(Boolean);
    if (t.k === 'leave') return [get(t.target)].filter(Boolean);
    return [];
  }

  computeDominators() {
    const blocks = this.live;
    const idx = new Map(blocks.map((b, i) => [b, i]));
    const n = blocks.length;
    // successors in live graph
    this.S = blocks.map((b) => this.succOf(b).map((s) => idx.get(s)).filter((v) => v != null));
    const P = blocks.map(() => []);
    this.S.forEach((ss, i) => ss.forEach((j) => P[j].push(i)));
    this.P = P;
    this.idx = idx;
    // reverse postorder from entry (and handler entries as extra roots)
    const order = [];
    const seen = new Uint8Array(n);
    const e0 = this.entryBlock && idx.has(this.entryBlock) ? idx.get(this.entryBlock) : 0;
    this.entryIdx = e0;
    const roots = [e0, ...blocks.map((b, i) => (b.handlerEntry && i !== e0 ? i : -1)).filter((i) => i >= 0)];
    const dfs = (r) => {
      const stack = [[r, 0]];
      seen[r] = 1;
      while (stack.length) {
        const top = stack[stack.length - 1];
        const ss = this.S[top[0]];
        if (top[1] < ss.length) {
          const nx = ss[top[1]++];
          if (!seen[nx]) { seen[nx] = 1; stack.push([nx, 0]); }
        } else { order.push(top[0]); stack.pop(); }
      }
    };
    for (const r of roots) if (!seen[r]) dfs(r);
    for (let i = 0; i < n; i++) if (!seen[i]) dfs(i);
    const rpo = order.reverse();
    this.rpoIndex = new Int32Array(n);
    rpo.forEach((b, i) => { this.rpoIndex[b] = i; });
    this.idom = this.domTree(rpo, P, roots);
    // post-dominators: reverse graph with virtual exit n
    const exitNodes = [];
    for (let i = 0; i < n; i++) if (!this.S[i].length) exitNodes.push(i);
    const RS = blocks.map((_, i) => P[i]);           // reverse succ = preds
    const RP = blocks.map((_, i) => this.S[i].slice()); // reverse preds = succs
    RS.push([]); RP.push([]);
    for (const e of exitNodes) { RP[e].push(n); RS[n].push(e); }
    // nodes that can't reach an exit (infinite loops): connect to virtual exit too
    const canExit = new Uint8Array(n + 1);
    const q = [n]; canExit[n] = 1;
    while (q.length) { const v = q.pop(); for (const u of RS[v]) if (!canExit[u]) { canExit[u] = 1; q.push(u); } }
    for (let i = 0; i < n; i++) if (!canExit[i]) { RP[i].push(n); RS[n].push(i); }
    const order2 = [];
    const seen2 = new Uint8Array(n + 1);
    const stack2 = [[n, 0]]; seen2[n] = 1;
    while (stack2.length) {
      const top = stack2[stack2.length - 1];
      const ss = RS[top[0]];
      if (top[1] < ss.length) { const nx = ss[top[1]++]; if (!seen2[nx]) { seen2[nx] = 1; stack2.push([nx, 0]); } }
      else { order2.push(top[0]); stack2.pop(); }
    }
    const rpo2 = order2.reverse();
    this.ipdom = this.domTree(rpo2, RP, [n]);
    this.exitIndex = n;
  }

  domTree(rpo, preds, roots) {
    // Cooper-Harvey-Kennedy. Several roots (handler entries) hang off one virtual root
    // so that walks up the tree always meet.
    let N = Math.max(...rpo, ...roots) + 1;
    const vroot = roots.length > 1 ? N++ : -1;
    const pos = new Int32Array(N).fill(-1);
    const order = vroot >= 0 ? [vroot, ...rpo] : rpo;
    order.forEach((b, i) => { pos[b] = i; });
    const idom = new Int32Array(N).fill(-1);
    if (vroot >= 0) { idom[vroot] = vroot; for (const r of roots) idom[r] = vroot; }
    else idom[roots[0]] = roots[0];
    const isRoot = new Set(roots);
    const intersect = (a, b) => {
      let guard = 0;
      while (a !== b && guard++ < 1e6) {
        while (pos[a] > pos[b]) a = idom[a];
        while (pos[b] > pos[a]) b = idom[b];
      }
      return a;
    };
    let changed = true, guard = 0;
    while (changed && guard++ < 1000) {
      changed = false;
      for (const b of rpo) {
        if (isRoot.has(b)) continue;
        let nd = -1;
        for (const p of preds[b]) {
          if (pos[p] < 0 || idom[p] < 0) continue;
          nd = nd < 0 ? p : intersect(p, nd);
        }
        if (nd >= 0 && idom[b] !== nd) { idom[b] = nd; changed = true; }
      }
    }
    return idom;
  }

  dominates(a, b) {
    let x = b, guard = 0;
    while (x >= 0 && guard++ < 100000) {
      if (x === a) return true;
      const nx = this.idom[x];
      if (nx === x || nx < 0) return false;
      x = nx;
    }
    return false;
  }

  // ---------- structuring ----------
  output() {
    this.emitted = new Set();
    this.labels = new Set();
    this.loopStack = [];
    this.jumpLog = [];
    const tryRegions = this.tryRegions().filter((r) => !this.skipTry || r.tryStart !== this.skipTry.tryStart || r.tryEnd !== this.skipTry.tryEnd);
    this.tryByStart = new Map();
    for (const r of tryRegions) { if (!this.tryByStart.has(r.tryStart)) this.tryByStart.set(r.tryStart, []); this.tryByStart.get(r.tryStart).push(r); }
    for (const list of this.tryByStart.values()) list.sort((a, b) => (b.tryEnd - b.tryStart) - (a.tryEnd - a.tryStart));
    this.openTries = new Set();
    let stmts = this.region(this.entryIdx || 0, { stop: new Set(), range: null });
    // blocks reached only through goto that were never placed
    for (let guard = 0; guard < 64; guard++) {
      const missing = [...this.labels].filter((n) => !this.emitted.has(n)).sort((a, b) => this.live[a].start - this.live[b].start);
      if (!missing.length) break;
      stmts.push(...this.region(missing[0], { stop: new Set(), range: null }));
    }
    stmts = this.withLabels(stmts);
    if (!this.raw) stmts = simplify(stmts);
    return { stmts, locals: this.locals, params: this.params, extraLocals: this.extraLocals, labels: this.labels, blockStart: (i) => (this.live[i] ? this.live[i].start : i), iterOK: !!this.iterOK };
  }

  tryRegions() {
    const groups = new Map();
    for (const h of this.handlers) {
      const key = h.tryStart + ':' + h.tryEnd;
      if (!groups.has(key)) groups.set(key, { tryStart: h.tryStart, tryEnd: h.tryEnd, handlers: [] });
      groups.get(key).handlers.push(h);
    }
    return [...groups.values()];
  }

  bi(off) { const b = this.blockAt.get(off); return b ? this.idx.get(b) : undefined; }

  // Structure from block index `i` until reaching a stop block.
  region(i, ctx, depth = 0) {
    const out = [];
    out.exitTo = null;
    const blocks = this.live;
    let guard = 0;
    while (i != null && i >= 0 && i < blocks.length && guard++ < 10000) {
      if (ctx.stop.has(i)) { out.exitTo = i; break; }
      const b = blocks[i];
      if (ctx.range && (b.start < ctx.range[0] || b.start >= ctx.range[1])) { out.push(this.jump(i, ctx)); break; }
      if (this.emitted.has(i)) { out.push(this.jump(i, ctx)); break; }
      // try region starting here?
      const tries = (this.tryByStart.get(b.start) || []).filter((r) => !this.openTries.has(r));
      if (tries.length) {
        const r = tries[0];
        const res = this.structTry(r, ctx, depth);
        out.push(res.stmt);
        i = res.next;
        continue;
      }
      // loop header?
      const backPreds = this.P[i].filter((p) => this.dominates(i, p));
      if (backPreds.length && !this.loopStack.some((l) => l.header === i)) {
        const res = this.structLoop(i, backPreds, ctx, depth);
        out.push(res.stmt);
        i = res.next;
        continue;
      }
      this.emitted.add(i);
      out.push({ k: 'label', block: i });
      out.push(...b.stmts);
      const t = b.term;
      if (t.k === 'ret') { out.push({ k: 'ret', e: t.e }); break; }
      if (t.k === 'throw') { out.push({ k: 'throw', e: t.e }); break; }
      if (t.k === 'yieldbreak') { out.push({ k: 'yieldbreak' }); break; }
      if (t.k === 'endfinally') break;
      if (t.k === 'leave') { out.exitTo = this.bi(t.target) ?? null; break; }
      if (t.k === 'goto' || t.k === 'fall') {
        const n = this.bi(t.target);
        if (n == null) break;
        const j = this.loopJump(n, ctx);
        if (j) { out.push(j); break; }
        if (ctx.stop.has(n)) { out.exitTo = n; break; }
        if (this.emitted.has(n) || (this.P[n].length > 1 && !this.dominates(i, n) && !this.isMerge(n, ctx))) { out.push(this.jump(n, ctx)); break; }
        i = n;
        continue;
      }
      if (t.k === 'cond') {
        const tn = this.bi(t.target), fn = this.bi(t.fall);
        let merge = this.ipdom[i];
        if (merge === this.exitIndex || merge < 0) merge = null;
        const branch = (n) => {
          if (n == null) return [];
          const j = this.loopJump(n, ctx);
          if (j) return [j];
          if (n === merge) { const r = []; r.exitTo = n; return r; }
          if (ctx.stop.has(n)) return [this.jump(n, ctx)];
          const stop = new Set(ctx.stop);
          if (merge != null) stop.add(merge);
          return this.region(n, { ...ctx, stop }, depth + 1);
        };
        const mark = this.jumpLog.length;
        const thenS = branch(tn);
        const elseS = branch(fn);
        out.push({ k: 'if', cond: t.cond, then: thenS, else: elseS });
        // a block both branches jump to but nobody placed yet: put it right after the if
        if (merge == null || ctx.stop.has(merge) || this.emitted.has(merge)) {
          const pend = this.jumpLog.slice(mark).filter((n) => !this.emitted.has(n) && !ctx.stop.has(n) && this.inRange(n, ctx) && !this.loopStack.some((l) => l.header === n || l.exit === n));
          if (pend.length && [thenS, elseS].every((br) => endsFlowS(br) || br.exitTo != null)) {
            const P = pend.sort((a, b) => this.live[a].start - this.live[b].start)[0];
            for (const br of [thenS, elseS]) if (!endsFlowS(br) && br.exitTo !== P) br.push(this.jump(br.exitTo, ctx));
            i = P;
            continue;
          }
        }
        if (merge == null) { if (thenS.exitTo != null && thenS.exitTo === elseS.exitTo) out.exitTo = thenS.exitTo; break; }
        const j = this.loopJump(merge, ctx);
        if (j) { if (!(endsFlowS(thenS) && endsFlowS(elseS))) out.push(j); break; }
        i = merge;
        continue;
      }
      if (t.k === 'switch') {
        let merge = this.ipdom[i];
        if (merge === this.exitIndex || merge < 0) merge = null;
        const caseMap = new Map();
        t.targets.forEach((off, v) => { const n = this.bi(off); if (!caseMap.has(n)) caseMap.set(n, []); caseMap.get(n).push(v); });
        const fall = this.bi(t.fall);
        const cases = [];
        const stop = new Set(ctx.stop);
        if (merge != null) stop.add(merge);
        const sctx = { ...ctx, stop, inSwitch: merge, switchLoop: this.loopStack.length };
        for (const [n, values] of caseMap) {
          if (n === fall) continue;
          const bodyS = n === merge ? [] : this.region(n, sctx, depth + 1);
          cases.push({ values, body: bodyS });
        }
        const defS = fall != null && fall !== merge ? this.region(fall, sctx, depth + 1) : [];
        out.push({ k: 'switch', e: t.e, cases, def: defS, merge });
        if (merge == null) break;
        i = merge;
        continue;
      }
      break;
    }
    return out;
  }

  isMerge(n, ctx) { return ctx.stop.has(n); }

  inRange(n, ctx) { const b = this.live[n]; return !!b && (!ctx.range || (b.start >= ctx.range[0] && b.start < ctx.range[1])); }

  loopJump(n, ctx) {
    for (let k = this.loopStack.length - 1; k >= 0; k--) {
      const l = this.loopStack[k];
      const inner = k === this.loopStack.length - 1;
      if (n === l.header) return inner ? { k: 'continue' } : this.gotoBlock(n);
      if (l.cont != null && n === l.cont) { if (inner) return { k: 'continue' }; l.contUsedOuter = true; return this.gotoBlock(n); }
      if (n === l.exit) {
        // "break" inside a switch would leave the switch, not the loop
        if (inner && !(ctx && ctx.inSwitch != null && ctx.switchLoop === this.loopStack.length)) return { k: 'break' };
        return this.gotoBlock(n);
      }
    }
    return null;
  }

  gotoBlock(n) { this.labels.add(n); this.jumpLog.push(n); return { k: 'goto', block: n }; }

  jump(n, ctx) {
    if (n == null) return { k: 'comment', text: 'unknown jump' };
    const j = this.loopJump(n, ctx);
    if (j) return j;
    if (ctx.inSwitch != null && n === ctx.inSwitch) return { k: 'break' };
    const b = this.live[n];
    if (b && b.term && b.term.k === 'ret' && !b.stmts.length) return { k: 'ret', e: b.term.e };
    if (b && b.term && b.term.k === 'yieldbreak' && !b.stmts.length) return { k: 'yieldbreak' };
    return this.gotoBlock(n);
  }

  structLoop(h, backPreds, ctx, depth) {
    // natural loop body
    const body = new Set([h]);
    const work = [...backPreds];
    while (work.length) { const x = work.pop(); if (!body.has(x)) { body.add(x); for (const p of this.P[x]) work.push(p); } }
    // exit: successor outside the loop that is reached most often / earliest
    const exits = new Map();
    for (const x of body) for (const s of this.S[x]) if (!body.has(s)) exits.set(s, (exits.get(s) || 0) + 1);
    let exit = null;
    for (const [s, c] of exits) if (exit == null || c > exits.get(exit) || (c === exits.get(exit) && this.live[s].start < this.live[exit].start)) exit = s;
    // prefer the block every path out of the loop ends up in
    let f = this.ipdom[h];
    for (let guard = 0; f >= 0 && f !== this.exitIndex && body.has(f) && guard < 10000; guard++) f = this.ipdom[f];
    if (f >= 0 && f !== this.exitIndex && !body.has(f) && this.live[f] && !ctx.stop.has(f) && (!ctx.range || this.inRange(f, ctx))) exit = f;
    if (exit != null && ctx.stop.has(exit) === false && this.loopStack.some((l) => l.exit === exit)) { /* shared exit */ }
    // a single latch block reached from several places is the step of a for loop ("continue" target)
    let cont = null;
    if (backPreds.length === 1) {
      const L = backPreds[0], lb = this.live[L];
      if (L !== h && this.P[L].length > 1 && (lb.term.k === 'goto' || lb.term.k === 'fall') && lb.stmts.length > 0 && lb.stmts.length <= 3
        && lb.stmts.every((st) => st.k === 'assign' || (st.k === 'expr' && st.e.k === 'call')) && !this.tryByStart.has(lb.start) && !lb.handlerEntry) cont = L;
    }
    const loop = { header: h, exit, body, cont, contUsedOuter: false };
    this.loopStack.push(loop);
    const stop = new Set(ctx.stop);
    if (exit != null) stop.add(exit);
    if (cont != null) stop.add(cont);
    let bodyS = this.region(h, { ...ctx, stop, inSwitch: null }, depth + 1);
    this.loopStack.pop();
    if (cont == null) return { stmt: { k: 'loop', body: bodyS }, next: exit };
    this.emitted.add(cont);
    const step = this.live[cont].stmts;
    if (!loop.contUsedOuter) return { stmt: { k: 'loop', body: bodyS, step }, next: exit };
    // an inner loop jumps to the step: keep it as a labelled block at the end of the body
    const toGoto = (list) => list.map((st) => {
      if (st.k === 'continue') { this.labels.add(cont); return { k: 'goto', block: cont }; }
      if (st.k === 'loop' || st.k === 'while' || st.k === 'dowhile') return st;
      if (st.k === 'if') return { ...st, then: toGoto(st.then), else: toGoto(st.else) };
      if (st.k === 'switch') return { ...st, cases: st.cases.map((c) => ({ ...c, body: toGoto(c.body) })), def: toGoto(st.def) };
      if (st.k === 'try') return { ...st, body: toGoto(st.body), catches: st.catches.map((c) => ({ ...c, body: toGoto(c.body) })), fin: st.fin && { ...st.fin, body: toGoto(st.fin.body) } };
      return st;
    });
    this.labels.add(cont);
    bodyS = [...toGoto(bodyS), { k: 'label', block: cont }, ...step];
    return { stmt: { k: 'loop', body: bodyS }, next: exit };
  }

  structTry(r, ctx, depth) {
    this.openTries.add(r);
    const startI = this.bi(r.tryStart);
    // leave target = continuation
    const leaveTargets = new Map();
    for (const b of this.live) {
      if (b.term && b.term.k === 'leave' && b.start >= r.tryStart && b.start < r.handlers.reduce((m, h) => Math.max(m, h.hEnd), r.tryEnd)) leaveTargets.set(b.term.target, (leaveTargets.get(b.term.target) || 0) + 1);
    }
    let cont = null, best = -1;
    for (const [off, c] of leaveTargets) if (c > best) { best = c; cont = this.bi(off); }
    if (cont == null) {
      const after = Math.max(r.tryEnd, ...r.handlers.map((h) => h.hEnd));
      cont = this.bi(after) ?? null;
      // a try whose every path returns/throws continues nowhere
      if (cont != null && !this.P[cont].length) cont = null;
    }
    const stop = new Set(ctx.stop);
    if (cont != null) stop.add(cont);
    const body = this.region(startI, { ...ctx, stop, range: [r.tryStart, r.tryEnd] }, depth + 1);
    const catches = [];
    let fin = null;
    for (const h of r.handlers) {
      const hi = this.bi(h.hStart);
      if (hi == null) continue;
      const hs = this.region(hi, { ...ctx, stop, range: [h.hStart, h.hEnd] }, depth + 1);
      if (h.flags === 2 || h.flags === 4) fin = { body: hs, fault: h.flags === 4 };
      else {
        const type = h.flags === 1 ? 'Exception' : this.resolver.typeTok(h.token, this.gctx);
        catches.push({ type, local: h.local, body: hs, filter: h.flags === 1 });
      }
    }
    this.openTries.delete(r);
    return { stmt: { k: 'try', body, catches, fin }, next: cont };
  }

  withLabels(stmts) {
    // keep only label markers that are jumped to
    const walk = (list) => list.filter((s) => s.k !== 'label' || this.labels.has(s.block)).map((s) => {
      if (s.k === 'if') return { ...s, then: walk(s.then), else: walk(s.else) };
      if (s.k === 'loop') return { ...s, body: walk(s.body) };
      if (s.k === 'switch') return { ...s, cases: s.cases.map((c) => ({ ...c, body: walk(c.body) })), def: walk(s.def) };
      if (s.k === 'try') return { ...s, body: walk(s.body), catches: s.catches.map((c) => ({ ...c, body: walk(c.body) })), fin: s.fin && { ...s.fin, body: walk(s.fin.body) } };
      return s;
    });
    return walk(stmts);
  }
}

function endsFlowS(list) { const l = list[list.length - 1]; return !!l && (l.k === 'ret' || l.k === 'throw' || l.k === 'break' || l.k === 'continue' || l.k === 'goto' || l.k === 'yieldbreak'); }
