// Statement-level cleanups for the CIL decompiler. They run on the structured IR:
//   statements  assign incr expr ret throw break continue goto label comment if loop while dowhile
//               for foreach using lock switch try yield yieldbreak
//   expressions const local arg this tmp stackvar cap catchvar raw field call new delegate fnptr newarr
//               arrinit elem len bin un not logic cmp cast as typeof addr deref default intrinsic ternary
// Every pass is meant to be safe to run more than once.

const NEG = { '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };

export function negate(e) {
  if (!e) return e;
  if (e.k === 'not') return e.a;
  if (e.k === 'cmp' && NEG[e.op] && !e.float) return { ...e, op: NEG[e.op] };
  if (e.k === 'logic') return { k: 'logic', op: e.op === '&&' ? '||' : '&&', a: negate(e.a), b: negate(e.b), t: 'bool' };
  if (e.k === 'const' && typeof e.v === 'boolean') return { k: 'const', v: !e.v, t: 'bool' };
  return { k: 'not', a: e, t: 'bool' };
}

// ---------------- expression helpers ----------------
const CHILD_KEYS = {
  field: ['obj'], call: ['obj', 'args'], new: ['args'], delegate: ['target'], newarr: ['size'], arrinit: ['items'],
  elem: ['a', 'i'], len: ['a'], bin: ['a', 'b'], un: ['a'], not: ['a'], logic: ['a', 'b'], cmp: ['a', 'b'],
  cast: ['a'], as: ['a'], addr: ['a'], deref: ['a'], intrinsic: ['args'], ternary: ['c', 'a', 'b'], coalesce: ['a', 'b'],
  init: ['obj', 'items'], initset: ['value'], initadd: ['args'],
};

export function children(e) {
  const keys = e && CHILD_KEYS[e.k];
  if (!keys) return [];
  const out = [];
  for (const k of keys) {
    const v = e[k];
    if (Array.isArray(v)) { for (const x of v) if (x && x.k) out.push(x); }
    else if (v && v.k) out.push(v);
  }
  return out;
}

// children in evaluation order, flagged when only conditionally evaluated
function orderedChildren(e) {
  if (e.k === 'logic') return [{ e: e.a, cond: false }, { e: e.b, cond: true }];
  if (e.k === 'ternary') return [{ e: e.c, cond: false }, { e: e.a, cond: true }, { e: e.b, cond: true }];
  if (e.k === 'coalesce') return [{ e: e.a, cond: false }, { e: e.b, cond: true }];
  return children(e).map((c) => ({ e: c, cond: false }));
}

// Bottom-up rewrite. fn returns a replacement node or undefined to keep it.
export function mapExpr(e, fn) {
  if (!e || typeof e !== 'object' || !e.k) return e;
  const keys = CHILD_KEYS[e.k];
  let ne = e;
  if (keys) {
    for (const k of keys) {
      const v = e[k];
      if (Array.isArray(v)) {
        const nv = v.map((x) => mapExpr(x, fn));
        if (nv.some((x, i) => x !== v[i])) { if (ne === e) ne = { ...e }; ne[k] = nv; }
      } else if (v && v.k) {
        const nv = mapExpr(v, fn);
        if (nv !== v) { if (ne === e) ne = { ...e }; ne[k] = nv; }
      }
    }
  }
  const r = fn(ne);
  return r === undefined ? ne : r;
}

export function someExpr(e, pred) {
  if (!e || !e.k) return false;
  if (pred(e)) return true;
  for (const c of children(e)) if (someExpr(c, pred)) return true;
  return false;
}

export function varKey(e) {
  switch (e && e.k) {
    case 'tmp': return 't:' + e.name;
    case 'stackvar': return 's:' + e.n;
    case 'local': return 'l:' + e.i;
    case 'arg': return 'a:' + e.i;
    case 'cap': return 'c:' + e.name;
    default: return null;
  }
}
const isVar = (e) => varKey(e) != null;

export function sameExpr(a, b) {
  if (a === b) return true;
  if (!a || !b || a.k !== b.k) return false;
  switch (a.k) {
    case 'const': return a.v === b.v && a.t === b.t;
    case 'this': return true;
    case 'local': case 'arg': return a.i === b.i;
    case 'tmp': case 'cap': return a.name === b.name;
    case 'stackvar': return a.n === b.n;
    case 'field': return a.f.name === b.f.name && a.f.owner === b.f.owner && ((!a.obj && !b.obj) || (a.obj && b.obj && sameExpr(a.obj, b.obj)));
    case 'typeof': case 'default': return a.type === b.type;
    default: return false;
  }
}

const hasCalls = (e) => someExpr(e, (x) => x.k === 'call' || x.k === 'new' || x.k === 'intrinsic' || x.k === 'raw');
const readsMemory = (e) => someExpr(e, (x) => x.k === 'field' || x.k === 'elem' || x.k === 'deref' || x.k === 'len' || x.k === 'cap' || x.k === 'call' || x.k === 'new' || x.k === 'raw' || x.k === 'intrinsic');
const constLike = (e) => !readsMemory(e);
const isPath = (e) => e && (e.k === 'this' || e.k === 'local' || e.k === 'arg' || e.k === 'cap' || (e.k === 'field' && (!e.obj || isPath(e.obj))));

// ---------------- statement helpers ----------------
const FLOW = new Set(['ret', 'throw', 'break', 'continue', 'goto', 'yieldbreak']);
export const endsFlow = (list) => { const l = list[list.length - 1]; return !!l && FLOW.has(l.k); };

function withLists(s, f) {
  switch (s.k) {
    case 'if': return { ...s, then: f(s.then), else: f(s.else) };
    case 'loop': case 'while': case 'dowhile': case 'foreach': case 'using': case 'lock': case 'for': return { ...s, body: f(s.body) };
    case 'switch': return { ...s, cases: s.cases.map((c) => ({ ...c, body: f(c.body) })), def: f(s.def) };
    case 'try': return { ...s, body: f(s.body), catches: s.catches.map((c) => ({ ...c, body: f(c.body) })), fin: s.fin && { ...s.fin, body: f(s.fin.body) } };
    default: return s;
  }
}
function listsOf(s) {
  switch (s.k) {
    case 'if': return [s.then, s.else];
    case 'loop': case 'while': case 'dowhile': case 'foreach': case 'using': case 'lock': return [s.body];
    case 'for': return [s.init, s.body, s.step];
    case 'switch': return [...s.cases.map((c) => c.body), s.def];
    case 'try': return [s.body, ...s.catches.map((c) => c.body), ...(s.fin ? [s.fin.body] : [])];
    default: return [];
  }
}

// Apply fn to every statement list, innermost first.
export function rewriteLists(list, fn) {
  return fn(list.map((s) => withLists(s, (l) => rewriteLists(l, fn))));
}

export function forEachStmt(list, fn) {
  for (const s of list) { fn(s); for (const l of listsOf(s)) forEachStmt(l, fn); }
}

// expression slots of one statement (not nested lists), in evaluation order
function slots(s) {
  switch (s.k) {
    case 'assign': case 'using': return isVar(s.target) || !s.target ? [s.value] : [...children(s.target), s.value];
    case 'incr': return isVar(s.target) ? [] : children(s.target);
    case 'expr': case 'ret': case 'throw': case 'yield': case 'switch': return [s.e];
    case 'if': case 'while': case 'dowhile': return [s.cond];
    case 'for': return [s.cond];
    case 'foreach': return [s.coll];
    case 'lock': return [s.obj];
    default: return [];
  }
}

function mapTarget(t, fn) {
  if (!t || isVar(t)) return t;
  if (t.k === 'field') return t.obj ? { ...t, obj: mapExpr(t.obj, fn) } : t;
  if (t.k === 'elem') return { ...t, a: mapExpr(t.a, fn), i: mapExpr(t.i, fn) };
  if (t.k === 'deref') return { ...t, a: mapExpr(t.a, fn) };
  return mapExpr(t, fn);
}

// Map the expressions directly held by a statement (targets stay locations).
export function mapStmtExprs(s, fn) {
  switch (s.k) {
    case 'assign': return { ...s, target: mapTarget(s.target, fn), value: mapExpr(s.value, fn) };
    case 'using': return { ...s, target: s.target && mapTarget(s.target, fn), value: mapExpr(s.value, fn) };
    case 'incr': return { ...s, target: mapTarget(s.target, fn) };
    case 'expr': case 'ret': case 'throw': case 'yield': case 'switch': return s.e ? { ...s, e: mapExpr(s.e, fn) } : s;
    case 'if': case 'while': case 'dowhile': return { ...s, cond: mapExpr(s.cond, fn) };
    case 'for': return { ...s, cond: mapExpr(s.cond, fn), init: s.init.map((x) => mapStmtExprs(x, fn)), step: s.step.map((x) => mapStmtExprs(x, fn)) };
    case 'foreach': return { ...s, coll: mapExpr(s.coll, fn) };
    case 'lock': return { ...s, obj: mapExpr(s.obj, fn) };
    default: return s;
  }
}

// Map every expression in a statement tree.
export function mapAll(list, fn) {
  return list.map((s) => withLists(mapStmtExprs(s, fn), (l) => mapAll(l, fn)));
}

// Read/write counts of every variable.
export function usage(list) {
  const u = new Map();
  const get = (k) => { let x = u.get(k); if (!x) u.set(k, x = { reads: 0, writes: 0, addr: 0 }); return x; };
  const readE = (e) => {
    if (!e || !e.k) return;
    const k = varKey(e);
    if (k) get(k).reads++;
    if (e.k === 'addr') { const kk = varKey(e.a); if (kk) get(kk).addr++; }
    for (const c of children(e)) readE(c);
  };
  const write = (t, alsoRead) => { const k = varKey(t); if (k) { get(k).writes++; if (alsoRead) get(k).reads++; } else if (t) for (const c of children(t)) readE(c); };
  const visit = (s) => {
    if (s.k === 'assign' || s.k === 'using') { if (s.target) write(s.target, !!s.op); readE(s.value); }
    else if (s.k === 'incr') write(s.target, true);
    else if (s.k === 'foreach') { if (s.v) write(s.v); readE(s.coll); }
    else if (s.k === 'try') { for (const c of s.catches) if (c.local != null) get('l:' + c.local).writes++; }
    else for (const e of slots(s)) readE(e);
  };
  // init/step statements of a for are visited as nested lists
  forEachStmt(list, visit);
  return u;
}

// ---------------- passes ----------------

// Drop statements after an unconditional jump (up to the next label).
function removeUnreachable(list) {
  const out = [];
  let dead = false;
  for (const s of list) {
    if (s.k === 'label') dead = false;
    if (dead) continue;
    out.push(s);
    if (FLOW.has(s.k)) dead = true;
  }
  return out;
}

const isBreakOnly = (l) => l.length === 1 && l[0].k === 'break';
const isContinueOnly = (l) => l.length === 1 && l[0].k === 'continue';
const TRUE = { k: 'const', v: true, t: 'bool' };
const isTrue = (c) => c && c.k === 'const' && c.v === true;
const and = (a, b) => (isTrue(a) ? b : isTrue(b) ? a : { k: 'logic', op: '&&', a, b, t: 'bool' });
const trimContinue = (body) => (body.length && body[body.length - 1].k === 'continue' ? body.slice(0, -1) : body);
const hasContinue = (list) => { let found = false; const scan = (l) => { for (const s of l) { if (s.k === 'continue') found = true; if (s.k === 'loop' || s.k === 'while' || s.k === 'dowhile' || s.k === 'for' || s.k === 'foreach') continue; for (const x of listsOf(s)) scan(x); } }; scan(list); return found; };

function simplifyLoop(s) {
  let cond = s.k === 'while' ? s.cond : TRUE;
  let body = removeUnreachable(s.body);
  for (let guard = 0; guard < 50; guard++) {
    body = trimContinue(removeUnreachable(body));
    const n = body.length;
    // ...; if (x) { A; continue; } break;   ->   ...; if (!x) break; A
    if (n >= 2 && body[n - 1].k === 'break') {
      const p = body[n - 2];
      if (p.k === 'if' && !p.else.length && p.then.length && p.then[p.then.length - 1].k === 'continue') {
        body = [...body.slice(0, n - 2), { k: 'if', cond: negate(p.cond), then: [{ k: 'break' }], else: [] }, ...p.then.slice(0, -1)];
        continue;
      }
      if (p.k === 'if' && p.else.length && endsFlow(p.then) && p.then[p.then.length - 1].k === 'continue' && !endsFlow(p.else)) {
        body = [...body.slice(0, n - 2), { k: 'if', cond: negate(p.cond), then: [...p.else, { k: 'break' }], else: [] }, ...p.then.slice(0, -1)];
        continue;
      }
    }
    const f = body[0];
    // if (!c) break; rest   ->   while (c) { rest }
    if (f && f.k === 'if' && !f.else.length && isBreakOnly(f.then)) { cond = and(cond, negate(f.cond)); body = body.slice(1); continue; }
    // if (c) { A } else { break; } rest
    if (f && f.k === 'if' && isBreakOnly(f.else) && f.then.length) { cond = and(cond, f.cond); body = endsFlow(f.then) ? f.then : [...f.then, ...body.slice(1)]; continue; }
    if (f && f.k === 'if' && isBreakOnly(f.then) && f.else.length) { cond = and(cond, negate(f.cond)); body = endsFlow(f.else) ? f.else : [...f.else, ...body.slice(1)]; continue; }
    break;
  }
  if (s.step) return { k: 'for', init: [], cond, step: s.step, body, declInit: false };
  if (isTrue(cond)) {
    const last = body[body.length - 1];
    if (last && last.k === 'if' && !last.else.length && isContinueOnly(last.then)) return { k: 'dowhile', cond: last.cond, body: body.slice(0, -1) };
    if (last && last.k === 'if' && !last.else.length && isBreakOnly(last.then)) return { k: 'dowhile', cond: negate(last.cond), body: body.slice(0, -1) };
  }
  return { k: 'while', cond, body };
}

const size = (l) => { let n = 0; forEachStmt(l, () => n++); return n; };
const hasLabel = (l) => { let f = false; forEachStmt(l, (s) => { if (s.k === 'label') f = true; }); return f; };

// if (c) { long... return; } throw x;   ->   if (!c) { throw x; } long...
function earlyExit(list) {
  for (let k = 0; k < list.length - 1; k++) {
    const s = list[k];
    if (s.k !== 'if' || s.else.length || !endsFlow(s.then)) continue;
    const rest = list.slice(k + 1);
    const last = rest[rest.length - 1];
    if (rest.length > 2 || !endsFlow(rest) || !/^(throw|ret|yieldbreak)$/.test(last.k) || hasLabel(rest) || hasLabel(s.then)) continue;
    if (size(s.then) <= size(rest)) continue;
    return [...list.slice(0, k), { k: 'if', cond: negate(s.cond), then: rest, else: [] }, ...s.then];
  }
  return list;
}

function structural(list) {
  return rewriteLists(list, (l) => {
    l = earlyExit(l);
    const out = [];
    for (let s of removeUnreachable(l)) {
      if (s.k === 'loop' || (s.k === 'while' && !s.step)) s = simplifyLoop(s);
      if (s.k === 'if') {
        if (!s.then.length && s.else.length) s = { ...s, cond: negate(s.cond), then: s.else, else: [] };
        if (!s.then.length && !s.else.length) { out.push({ k: 'expr', e: s.cond, cond: true }); continue; }
        // if (a) { if (b) X }  ->  if (a && b) X
        if (!s.else.length && s.then.length === 1 && s.then[0].k === 'if' && !s.then[0].else.length) s = { k: 'if', cond: and(s.cond, s.then[0].cond), then: s.then[0].then, else: [] };
        // if (c) { ...; return; } else { rest }  ->  if (c) { ...; return; } rest
        if (s.else.length && endsFlow(s.then)) { out.push({ ...s, else: [] }); out.push(...s.else); continue; }
        // if (c) { rest... } else { ...; return; } with a short else -> invert so the early exit comes first
        if (s.else.length && endsFlow(s.else) && !endsFlow(s.then) && s.else.length <= 2 && s.then.length > s.else.length) { out.push({ k: 'if', cond: negate(s.cond), then: s.else, else: [] }); out.push(...s.then); continue; }
      }
      out.push(s);
    }
    return out;
  });
}

const isNullCmp = (c, v) => c && c.k === 'cmp' && c.op === '==' && c.b && c.b.k === 'const' && c.b.v === null && sameExpr(c.a, v);
// if (c) { v = A; } else { v = B; }  ->  v = c ? A : B
// v = x; if (x == null) { v = y; }    ->  v = x ?? y
function ternaries(list) {
  list = rewriteLists(list, (l) => {
    const out = [];
    for (let i = 0; i < l.length; i++) {
      const s = l[i], nx = l[i + 1];
      if (s.k === 'assign' && !s.op && (s.target.k === 'stackvar' || s.target.k === 'tmp') && nx && nx.k === 'if' && !nx.else.length && nx.then.length === 1
        && nx.then[0].k === 'assign' && !nx.then[0].op && varKey(nx.then[0].target) === varKey(s.target) && (isNullCmp(nx.cond, s.value) || isNullCmp(nx.cond, s.target))) {
        out.push({ ...s, value: { k: 'coalesce', a: s.value, b: nx.then[0].value, t: s.value.t } });
        i++;
        continue;
      }
      out.push(s);
    }
    return out;
  });
  return rewriteLists(list, (l) => l.map((s) => {
    if (s.k !== 'if' || s.then.length !== 1 || s.else.length !== 1) return s;
    const a = s.then[0], b = s.else[0];
    if (a.k !== 'assign' || b.k !== 'assign' || a.op || b.op) return s;
    if (!(a.target.k === 'stackvar' || a.target.k === 'tmp') || varKey(a.target) !== varKey(b.target)) return s;
    return { k: 'assign', target: a.target, value: makeTernary(s.cond, a.value, b.value), decl: a.decl || b.decl };
  }));
}

function boolConst(e, other) {
  if (!e || e.k !== 'const') return null;
  if (typeof e.v === 'boolean') return e.v;
  const ot = other && other.t;
  if ((ot === 'bool' || (other && (other.k === 'cmp' || other.k === 'logic' || other.k === 'not'))) && (e.v === 0 || e.v === 1)) return e.v === 1;
  return null;
}
function makeTernary(c, a, b) {
  const av = boolConst(a, b), bv = boolConst(b, a);
  if (av === true && bv === false) return c;
  if (av === false && bv === true) return negate(c);
  if (bv === false) return { k: 'logic', op: '&&', a: c, b: a, t: 'bool' };
  if (av === true) return { k: 'logic', op: '||', a: c, b, t: 'bool' };
  if (av === false) return { k: 'logic', op: '&&', a: negate(c), b, t: 'bool' };
  if (bv === true) return { k: 'logic', op: '||', a: negate(c), b: a, t: 'bool' };
  return { k: 'ternary', c, a, b, t: a.t === 'null' ? b.t : a.t };
}

// statement positions in program order, and where each variable is written / read
function positions(list) {
  const writes = new Map(), reads = new Map();
  let pos = 0;
  const add = (m, k) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(pos); };
  const readE = (e) => { if (!e || !e.k) return; add(reads, varKey(e)); for (const c of children(e)) readE(c); };
  forEachStmt(list, (s) => {
    pos++;
    if ((s.k === 'assign' || s.k === 'using' || s.k === 'incr') && s.target) { add(writes, varKey(s.target)); if (!isVar(s.target)) for (const c of children(s.target)) readE(c); }
    if (s.k === 'foreach' && s.v) add(writes, varKey(s.v));
    for (const e of slots(s)) readE(e);
    if (s.k === 'expr' || s.k === 'assign') forEachAddr(s, (k) => add(writes, k));
  });
  return { writes, reads };
}
function forEachAddr(s, fn) { for (const e of slots(s)) someExpr(e, (x) => { if (x.k === 'addr' && isVar(x.a)) fn(varKey(x.a)); return false; }); }

// stackN that always receives the same stable trivial value is just that value
function propagateStack(list) {
  const u = usage(list);
  const pos = positions(list);
  const defs = new Map();
  forEachStmt(list, (s) => {
    if (s.k !== 'assign' || s.target.k !== 'stackvar') return;
    const k = varKey(s.target);
    if (s.op) { defs.set(k, false); return; }
    const prev = defs.get(k);
    if (prev === false) return;
    if (prev === undefined) defs.set(k, s.value);
    else if (!sameExpr(prev, s.value)) defs.set(k, false);
  });
  const subst = new Map();
  for (const [k, v] of defs) {
    if (!v) continue;
    let stable = v.k === 'const' || v.k === 'this' || v.k === 'typeof' || v.k === 'default' || v.k === 'tmp';
    if (v.k === 'local' || v.k === 'arg' || v.k === 'cap') {
      const vu = u.get(varKey(v));
      if (!vu || (vu.writes === 0 && vu.addr === 0)) stable = true;
      else if (!vu.addr) {
        // no write of the source between where the slot is filled and where it is used
        const w = pos.writes.get(k) || [], r = pos.reads.get(k) || [];
        const lo = Math.min(...w), hi = Math.max(...r, ...w);
        stable = (pos.writes.get(varKey(v)) || []).every((p) => p <= lo || p > hi);
      }
    }
    if (stable) subst.set(k, v);
  }
  if (!subst.size) return list;
  const pruned = rewriteLists(list, (l) => l.filter((s) => !(s.k === 'assign' && s.target.k === 'stackvar' && subst.has(varKey(s.target)))));
  return mapAll(pruned, (e) => (e.k === 'stackvar' && subst.has(varKey(e)) ? subst.get(varKey(e)) : undefined));
}

// locate the single read of `key` within a statement's slots
function locate(s, key) {
  const before = [];
  let found = null, count = 0;
  const rec = (e, cond) => {
    if (!e || !e.k) return;
    if (varKey(e) === key) { count++; if (!found) found = { cond, before: before.slice() }; return; }
    for (const c of orderedChildren(e)) {
      rec(c.e, cond || c.cond);
      if (!found) before.push(c.e);
    }
  };
  for (const e of slots(s)) { rec(e, false); if (!found) before.push(e); }
  if (s.k === 'assign' && s.op && varKey(s.target) === key) count++;
  if (s.k === 'incr' && varKey(s.target) === key) count++;
  return count === 1 ? found : null;
}

function canMove(value, loc) {
  if (!loc) return false;
  const calls = hasCalls(value);
  if (loc.cond && calls) return false;
  if (constLike(value)) {
    // a ref argument evaluated earlier could change a variable the value reads
    return !loc.before.some((b) => someExpr(b, (x) => x.k === 'addr' && isVar(x.a) && someExpr(value, (y) => varKey(y) === varKey(x.a))));
  }
  if (calls) return loc.before.every(constLike);
  return !loc.before.some(hasCalls);
}

// Forward-substitute compiler temporaries that are written once and read once, right after.
function inlineTemps(list) {
  for (let round = 0; round < 8; round++) {
    const u = usage(list);
    let changed = false;
    list = rewriteLists(list, (l) => {
      const out = l.slice();
      for (let j = out.length - 1; j >= 0; j--) {
        const s = out[j];
        if (s.k !== 'assign' || s.op || !(s.target.k === 'tmp' || s.target.k === 'stackvar')) continue;
        const key = varKey(s.target);
        const vu = u.get(key);
        if (!vu || vu.writes !== 1 || vu.addr) continue;
        if (vu.reads === 0) {
          if (hasCalls(s.value)) out[j] = { k: 'expr', e: s.value };
          else out.splice(j, 1);
          changed = true;
          continue;
        }
        if (vu.reads > 1 && s.target.k === 'tmp' && (s.value.k === 'tmp' || s.value.k === 'const' || s.value.k === 'this')) {
          const v = s.value;
          out.splice(j, 1);
          for (let q = j; q < out.length; q++) out[q] = mapAll([out[q]], (e) => (varKey(e) === key ? v : undefined))[0];
          changed = true;
          continue;
        }
        // obj.P = obj.P + x evaluates a simple path twice: fine to repeat it
        if (vu.reads === 2 && s.target.k === 'tmp' && j + 1 < out.length && isPath(s.value) && readsOf([out[j + 1]], key) === 2) {
          const v = s.value;
          out[j + 1] = mapAll([out[j + 1]], (e) => (varKey(e) === key ? v : undefined))[0];
          out.splice(j, 1);
          changed = true;
          continue;
        }
        if (vu.reads !== 1 || j + 1 >= out.length) continue;
        const next = out[j + 1];
        if (next.k === 'while' || next.k === 'dowhile' || next.k === 'for' || next.k === 'label') continue;
        const loc = locate(next, key);
        if (!canMove(s.value, loc)) continue;
        out[j + 1] = mapStmtExprs(next, (e) => (varKey(e) === key ? s.value : undefined));
        out.splice(j, 1);
        changed = true;
      }
      return out;
    });
    if (!changed) break;
  }
  return list;
}

// Delegate caches: Roslyn's <>9__N / mcs's <>f__am$cache are just the lambda itself.
const CACHE_FIELD = /^(<>9__\d|<>f__am\$cache|<>f__mg\$cache|CS\$<>9__CachedAnonymousMethodDelegate)/;
function lambdaCaches(list) {
  const cached = new Map();
  const tmpDefs = new Map();
  forEachStmt(list, (s) => { if (s.k === 'assign' && s.target.k === 'tmp') tmpDefs.set(s.target.name, s.value); });
  const resolve = (v) => (v && v.k === 'tmp' && tmpDefs.has(v.name) ? resolve(tmpDefs.get(v.name)) : v);
  forEachStmt(list, (s) => {
    if (s.k === 'assign' && s.target.k === 'field' && !s.target.obj && CACHE_FIELD.test(s.target.f.name)) {
      const v = resolve(s.value);
      if (v && v.k === 'delegate') cached.set(s.target.f.owner + '::' + s.target.f.name, v);
    }
  });
  if (!cached.size) return list;
  const keyOf = (e) => e && e.k === 'field' && !e.obj && CACHE_FIELD.test(e.f.name) ? e.f.owner + '::' + e.f.name : null;
  let out = rewriteLists(list, (l) => l.filter((s) => !(s.k === 'assign' && cached.has(keyOf(s.target)))));
  out = mapAll(out, (e) => { const k = keyOf(e); return k && cached.has(k) ? cached.get(k) : undefined; });
  const isDelegateVal = (e) => { const r = resolve(e); return r && r.k === 'delegate'; };
  for (const [name, v] of tmpDefs) if (v && v.k === 'field' && cached.has(keyOf(v))) tmpDefs.set(name, cached.get(keyOf(v)));
  // if (cache == null) { ... }  is never taken now
  return rewriteLists(out, (l) => l.filter((s) => {
    if (s.k !== 'if' || s.else.length) return true;
    const c = s.cond;
    if (c.k === 'cmp' && c.op === '==' && c.b.k === 'const' && c.b.v === null && isDelegateVal(c.a)) return false;
    if (c.k === 'not' && c.a.k === 'cmp' && c.a.op === '!=' && c.a.b.k === 'const' && c.a.b.v === null && isDelegateVal(c.a.a)) return false;
    return true;
  }));
}

// ---- foreach / using / lock / for ----
const isCall = (e, name) => e && e.k === 'call' && e.m && e.m.name === name;
const callOn = (e, name, v) => isCall(e, name) && e.obj && sameExpr(e.obj, v);
const stripCast = (e) => (e && e.k === 'cast' && !e.conv ? e.a : e);

function disposes(fin, v) {
  // if (v != null) v.Dispose();  |  v.Dispose();  |  d = v as IDisposable; if (d != null) d.Dispose();
  const disposeCall = (s, x) => s && s.k === 'expr' && isCall(s.e, 'Dispose') && s.e.obj && (sameExpr(stripCast(s.e.obj), x) || (s.e.obj.k === 'as' && sameExpr(s.e.obj.a, x)));
  const nullCheck = (s, x) => s && s.k === 'if' && !s.else.length && s.then.length === 1 && disposeCall(s.then[0], x) && s.cond.k === 'cmp' && s.cond.op === '!=' && s.cond.b.k === 'const' && s.cond.b.v === null && (sameExpr(stripCast(s.cond.a), x) || (s.cond.a.k === 'as' && sameExpr(s.cond.a.a, x)));
  if (fin.length === 1) return disposeCall(fin[0], v) || nullCheck(fin[0], v);
  if (fin.length === 2 && fin[0].k === 'assign' && isVar(fin[0].target) && stripCast(fin[0].value) && (sameExpr(stripCast(fin[0].value), v) || (fin[0].value.k === 'as' && sameExpr(fin[0].value.a, v)))) return nullCheck(fin[1], fin[0].target) || disposeCall(fin[1], fin[0].target);
  return false;
}

function readsOf(list, key) { let n = 0; const u = usage(list).get(key); if (u) n = u.reads + u.writes; return n; }

function patterns(list) {
  const total = usage(list);
  const countIn = (stmts, key) => readsOf(stmts, key);
  return rewriteLists(list, (l) => {
    const out = [];
    for (let i = 0; i < l.length; i++) {
      const s = l[i], nx = l[i + 1];
      // foreach over an enumerator
      if (s.k === 'assign' && !s.op && (s.target.k === 'local' || s.target.k === 'cap') && isCall(s.value, 'GetEnumerator') && !s.value.args.length && s.value.obj
        && nx && nx.k === 'try' && !nx.catches.length && nx.fin && !nx.fin.fault && nx.body.length === 1 && nx.body[0].k === 'while'
        && callOn(nx.body[0].cond, 'MoveNext', s.target) && disposes(nx.fin.body, s.target)) {
        const E = s.target, key = varKey(E);
        const loop = nx.body[0];
        let body = loop.body, v = null, vt = 'var';
        const first = body[0];
        if (first && first.k === 'assign' && !first.op && (first.target.k === 'local' || first.target.k === 'cap') && callOn(stripCast(first.value), 'get_Current', E)) {
          v = first.target; vt = null; body = body.slice(1);
        } else if (first && first.k === 'expr' && callOn(first.e, 'get_Current', E)) {
          body = body.slice(1); vt = first.e.t || 'var';
        }
        const inside = countIn([s, nx], key);
        const tu = total.get(key);
        const extra = l[i + 2] && l[i + 2].k === 'assign' && sameExpr(l[i + 2].target, E) && l[i + 2].value.k === 'const' && l[i + 2].value.v === null;
        if (tu && tu.reads + tu.writes === inside + (extra ? 1 : 0) && !someExpr({ k: 'bin', a: null, b: null }, () => false) && countIn(body, key) === 0) {
          out.push({ k: 'foreach', v, vt, coll: s.value.obj, body });
          i += extra ? 2 : 1;
          continue;
        }
      }
      // using (x = ...) { }
      if (s.k === 'assign' && !s.op && (s.target.k === 'local' || s.target.k === 'cap') && nx && nx.k === 'try' && !nx.catches.length && nx.fin && !nx.fin.fault && disposes(nx.fin.body, s.target)) {
        out.push({ k: 'using', target: s.target, value: s.value, body: nx.body });
        i++;
        continue;
      }
      // lock (x) { }  — flag = false; try { Monitor.Enter(obj, ref flag); ... } finally { if (flag) Monitor.Exit(obj); }
      if (s.k === 'assign' && s.target.k === 'local' && s.value.k === 'const' && (s.value.v === 0 || s.value.v === false) && nx && nx.k === 'try' && nx.fin && !nx.catches.length && nx.body.length) {
        const enter = nx.body[0];
        const fin = nx.fin.body;
        if (enter.k === 'expr' && isCall(enter.e, 'Enter') && /Monitor$/.test(enter.e.m.owner) && enter.e.args.length === 2 && enter.e.args[1].k === 'addr' && sameExpr(enter.e.args[1].a, s.target)
          && fin.length === 1 && fin[0].k === 'if' && fin[0].then.length === 1 && isCall(fin[0].then[0].e, 'Exit')) {
          let obj = enter.e.args[0];
          // obj is usually a local copy made just before
          const prev = out[out.length - 1];
          if (prev && prev.k === 'assign' && !prev.op && prev.target.k === 'local' && sameExpr(prev.target, obj) && (total.get(varKey(obj)) || {}).writes === 1) { out.pop(); obj = prev.value; }
          out.push({ k: 'lock', obj, body: nx.body.slice(1) });
          i++;
          continue;
        }
      }
      // i = a; for (; cond; step)  ->  for (i = a; cond; step)
      if (s.k === 'assign' && !s.op && s.target.k === 'local' && nx && nx.k === 'for' && !nx.init.length && someExpr(nx.cond, (x) => sameExpr(x, s.target))) {
        const key = varKey(s.target);
        const tu = total.get(key);
        out.push({ ...nx, init: [s], declInit: !!tu && tu.reads + tu.writes === countIn([s, nx], key) });
        i++;
        continue;
      }
      // for (i = a; cond; i++) { }
      if (s.k === 'assign' && !s.op && s.target.k === 'local' && nx && nx.k === 'while' && nx.body.length && !hasContinue(nx.body)) {
        const last = nx.body[nx.body.length - 1];
        const V = s.target;
        const stepsV = (last.k === 'incr' && sameExpr(last.target, V)) || (last.k === 'assign' && sameExpr(last.target, V) && (last.op || someExpr(last.value, (x) => sameExpr(x, V))));
        if (stepsV && someExpr(nx.cond, (x) => sameExpr(x, V))) {
          const key = varKey(V);
          const inside = countIn([s, nx], key);
          const tu = total.get(key);
          const own = tu && tu.reads + tu.writes === inside;
          // foreach over an array: arr = X; for (i = 0; i < arr.Length; i++) { v = arr[i]; ... }
          const c = nx.cond;
          const first = nx.body[0];
          const prev = out[out.length - 1];
          if (own && last.k === 'incr' && last.op === '++' && s.value.k === 'const' && s.value.v === 0 && c.k === 'cmp' && c.op === '<' && sameExpr(c.a, V) && c.b.k === 'len' && isVar(c.b.a)
            && first && first.k === 'assign' && !first.op && (first.target.k === 'local' || first.target.k === 'cap') && first.value.k === 'elem' && sameExpr(first.value.a, c.b.a) && sameExpr(first.value.i, V)
            && prev && prev.k === 'assign' && !prev.op && sameExpr(prev.target, c.b.a)) {
            const A = c.b.a, akey = varKey(A);
            const au = total.get(akey);
            const body = nx.body.slice(1, -1);
            if (au && au.reads + au.writes === countIn([prev, s, nx], akey) && countIn(body, key) === 0 && countIn(body, akey) === 0) {
              out.pop();
              out.push({ k: 'foreach', v: first.target, vt: null, coll: prev.value, body });
              i++;
              continue;
            }
          }
          out.push({ k: 'for', init: [s], cond: nx.cond, step: [last], body: nx.body.slice(0, -1), declInit: own });
          i++;
          continue;
        }
      }
      out.push(s);
    }
    return out;
  });
}

// goto L directly followed by L:  (also at the tail of if/else branches)
function tidyGotos(list) {
  const stripTail = (l, block) => {
    if (!l.length) return l;
    const last = l[l.length - 1];
    if (last.k === 'goto' && last.block === block) return l.slice(0, -1);
    if (last.k === 'if') return [...l.slice(0, -1), { ...last, then: stripTail(last.then, block), else: stripTail(last.else, block) }];
    return l;
  };
  let out = rewriteLists(list, (l) => {
    const r = l.slice();
    for (let i = 0; i + 1 < r.length; i++) if (r[i + 1].k === 'label') r[i] = stripTail([r[i]], r[i + 1].block)[0] || { k: 'comment', text: '', empty: true };
    return r.filter((s) => !s.empty);
  });
  const used = new Set();
  forEachStmt(out, (s) => { if (s.k === 'goto') used.add(s.block); });
  out = rewriteLists(out, (l) => l.filter((s) => s.k !== 'label' || used.has(s.block)));
  return out;
}

function compound(list) {
  return rewriteLists(list, (l) => l.map(function one(s) {
    if (s.k === 'for') return { ...s, step: s.step.map(one), init: s.init };
    if (s.k !== 'assign' || s.op || s.decl || !s.value || s.value.k !== 'bin') return s;
    const v = s.value;
    if (sameExpr(v.a, s.target) && /^([-+*/%&|^]|<<|>>)$/.test(v.op)) {
      if ((v.op === '+' || v.op === '-') && v.b.k === 'const' && v.b.v === 1) return { k: 'incr', target: s.target, op: v.op + v.op };
      return { ...s, op: v.op, value: v.b };
    }
    return s;
  }));
}

// var t = new X(); t.A = 1; t.Add(2); use(t);   ->   use(new X { A = 1 })
function initializers(list) {
  const u = usage(list);
  return rewriteLists(list, (l) => {
    const out = l.slice();
    for (let j = out.length - 1; j >= 0; j--) {
      const s = out[j];
      if (s.k !== 'assign' || s.op || s.target.k !== 'tmp' || !(s.value.k === 'new' || s.value.k === 'newarr' || s.value.k === 'init')) continue;
      const T = s.target, key = varKey(T);
      const items = [];
      let k = j + 1;
      for (; k < out.length; k++) {
        const x = out[k];
        const val = x.k === 'assign' && !x.op && x.target.k === 'field' && x.target.obj && sameExpr(x.target.obj, T) ? x.value
          : x.k === 'expr' && x.e.k === 'call' && x.e.obj && sameExpr(x.e.obj, T) && /^(set_.+|Add)$/.test(x.e.m.name) ? x.e : null;
        if (!val) break;
        if (x.k === 'assign') { if (someExpr(x.value, (y) => varKey(y) === key)) break; items.push({ k: 'initset', name: x.target.f.name, f: x.target.f, value: x.value }); }
        else if (x.e.m.name === 'Add') { if (x.e.args.some((a) => someExpr(a, (y) => varKey(y) === key))) break; items.push({ k: 'initadd', args: x.e.args }); }
        else { if (x.e.args.length !== 1 || someExpr(x.e.args[0], (y) => varKey(y) === key)) break; items.push({ k: 'initset', name: x.e.m.name.slice(4), value: x.e.args[0], m: x.e.m }); }
      }
      if (!items.length || k >= out.length) continue;
      const vu = u.get(key);
      const used = items.length + 1;
      if (!vu || vu.writes !== 1 || vu.reads !== used || s.value.k === 'newarr') continue;
      const loc = locate(out[k], key);
      if (!loc || loc.cond) continue;
      const init = { k: 'init', obj: s.value, items, t: s.value.t };
      out[k] = mapStmtExprs(out[k], (e) => (varKey(e) === key ? init : undefined));
      out.splice(j, k - j);
    }
    return out;
  });
}

// The general pipeline (run after structuring, and again after capture rewriting).
export function simplify(stmts) {
  let s = stmts;
  for (let round = 0; round < 3; round++) {
    s = structural(s);
    s = lambdaCaches(s);
    s = ternaries(s);
    s = propagateStack(s);
    s = inlineTemps(s);
    s = initializers(s);
    s = structural(s);
  }
  s = compound(s);
  s = patterns(s);
  s = tidyGotos(s);
  s = structural(s);
  s = compound(s);
  return s;
}

// ---------------- captured variables (display classes, iterator fields) ----------------
// opts: { transparent(e) -> bool, paramNames:Set, thisType }
export function captures(stmts, opts) {
  const thisNames = /^(<>4__this|\$this|<>f__this|<>3__this)$/;
  const nestedRef = /^(CS\$<>8__locals\d*|<>8__\d+|\$locals\d*|<>f__ref\$\d+)$/;
  const isT = (e) => {
    if (!e) return false;
    if (opts.transparent(e)) return true;
    return e.k === 'field' && e.obj && nestedRef.test(e.f.name) && isT(e.obj);
  };
  const conv = (e) => {
    if (e.k === 'field' && e.obj && isT(e.obj) && !nestedRef.test(e.f.name)) {
      if (thisNames.test(e.f.name)) return { k: 'this', t: opts.thisType };
      const name = capName(e.f.name);
      return { k: 'cap', name, t: e.t, sig: e.sig, param: opts.paramNames.has(name), field: e.f };
    }
    return undefined;
  };
  let out = mapAll(stmts, conv);
  // assignments to targets: map the target too
  out = rewriteLists(out, (l) => l.map((s) => {
    if ((s.k === 'assign' || s.k === 'incr') && s.target && s.target.k === 'field') { const t = conv(s.target); if (t) return { ...s, target: t }; }
    return s;
  }).filter((s) => {
    if (s.k !== 'assign') return true;
    if (s.target.k === 'this' && s.value.k === 'this') return false; // <>4__this = this
    if (s.target.k === 'cap' && s.target.param && s.value.k === 'arg' && s.value.name === s.target.name) return false; // param copy
    if (isT(s.target) && (s.value.k === 'new' || s.value.k === 'tmp' || isT(s.value))) return false; // display class instance
    if (s.target.k === 'field' && nestedRef.test(s.target.f.name) && isT(s.target.obj)) return false; // link to the parent display class
    if (s.target.k === 'tmp' && s.value.k === 'new' && opts.isDisplayType && opts.isDisplayType(s.value.type)) return false;
    return true;
  }));
  return out;
}

export function capName(n) {
  let m = /^<([^>]+)>\d*__\d+$/.exec(n) || /^<([^>]+)>[0-9a-z]*__\d*$/.exec(n);
  if (m) return identOk(m[1]);
  m = /^<>3__(.+)$/.exec(n);
  if (m) return identOk(m[1]);
  m = /^<>7__wrap(\d+)$/.exec(n);
  if (m) return 'enumerator' + (m[1] === '1' ? '' : m[1]);
  if (/^\$/.test(n)) return identOk(n.slice(1));
  return identOk(n);
}
const identOk = (n) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(n) ? n : n.replace(/[^A-Za-z0-9_]/g, '_'));

// ---------------- iterators ----------------
// Turns the MoveNext body (after yield sites were rewritten in the CFG) back into one method body.
// iter: { state, finallyBodies: Map(name -> stmts) }
export function iteratorStatements(stmts, iter) {
  const isState = (e) => e && e.k === 'field' && e.obj && e.obj.k === 'this' && e.f.name === iter.state;
  const isStateWrite = (s) => s.k === 'assign' && isState(s.target);
  const finallyCall = (s) => s.k === 'expr' && s.e.k === 'call' && s.e.obj && s.e.obj.k === 'this' && /^<>m__Finally\d+$/.test(s.e.m.name) ? s.e.m.name : null;
  let ok = true;
  let out = rewriteLists(stmts, (l) => {
    let list = l.slice();
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      if (!isStateWrite(s) || s.value.k !== 'const' || !(s.value.v <= -3)) continue;
      const want = '<>m__Finally' + (-s.value.v - 2);
      const j = list.findIndex((x, k) => k > i && finallyCall(x) === want);
      if (j < 0) continue;
      const fin = iter.finallyBodies.get(want);
      if (!fin) { ok = false; continue; }
      let fb = fin.filter((x) => !isStateWrite(x));
      while (fb.length && fb[fb.length - 1].k === 'ret' && !fb[fb.length - 1].e) fb = fb.slice(0, -1);
      list = [...list.slice(0, i), { k: 'try', body: list.slice(i + 1, j), catches: [], fin: { body: fb } }, ...list.slice(j + 1)];
    }
    return list.filter((s) => !isStateWrite(s));
  });
  forEachStmt(out, (s) => { if (finallyCall(s) || (s.k === 'assign' && isState(s.target))) ok = false; });
  // a final "yield break" is implied
  while (out.length && out[out.length - 1].k === 'yieldbreak') out = out.slice(0, -1);
  return { stmts: out, ok };
}
