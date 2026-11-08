// C# writer for the CIL decompiler: expressions, statements, and whole types.
import { T, parseSig, readCompressed, readTypeSig } from '../../formats/dotnet.js';
import { Reader } from '../../util/binary.js';
import { TypeNamer, ident, KEYWORDS } from './types.js';
import { Resolver, decompileMethod } from './decompile.js';
import { decodeIL, disassemble } from './il.js';
import { captures, simplify, usage, iteratorStatements } from './transforms.js';

const isDisplayName = (t) => /(<>c__DisplayClass|c__AnonStorey)/.test(t || '');
const HIDDEN_FIELD = /^(<>f__am\$cache|<>f__mg\$cache|CS\$<>9__CachedAnonymousMethodDelegate)/;

const PREC = { assign: 1, ternary: 2, '??': 2.5, '||': 3, '&&': 4, '|': 5, '^': 6, '&': 7, '==': 8, '!=': 8, '<': 9, '>': 9, '<=': 9, '>=': 9, is: 9, as: 9, '<<': 10, '>>': 10, '+': 11, '-': 11, '*': 12, '/': 12, '%': 12, unary: 13, primary: 14 };

function strLit(s) {
  return '"' + String(s).replace(/[\\"\n\r\t\0\x01-\x1f\u2028\u2029]/g, (c) => ({ '\\': '\\\\', '"': '\\"', '\n': '\\n', '\r': '\\r', '\t': '\\t', '\0': '\\0' }[c] || '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'))) + '"';
}
function charLit(n) {
  const c = String.fromCharCode(n);
  if (c === "'") return "'\\''";
  if (c === '\\') return "'\\\\'";
  if (n < 32 || n > 126) return n === 10 ? "'\\n'" : n === 13 ? "'\\r'" : n === 9 ? "'\\t'" : n === 0 ? "'\\0'" : `'\\u${n.toString(16).padStart(4, '0')}'`;
  return `'${c}'`;
}
function numLit(v, t) {
  if (typeof v === 'bigint') return v.toString() + 'L';
  if (t === 'float' || t === 'double') {
    const suf = t === 'float' ? 'f' : '';
    if (Number.isNaN(v)) return `${t}.NaN`;
    if (v === Infinity) return `${t}.PositiveInfinity`;
    if (v === -Infinity) return `${t}.NegativeInfinity`;
    let s = t === 'float' ? String(Math.fround(v) === v ? +v.toPrecision(9) : v) : String(v);
    if (t === 'float') s = String(parseFloat(Math.fround(v).toPrecision(9)));
    if (!/[.eE]/.test(s) && t === 'double') s += '.0';
    return s + suf;
  }
  return String(v);
}

export class CSharpWriter {
  constructor(mod) {
    this.mod = mod;
    this.namer = new TypeNamer(mod);
    this.resolver = new Resolver(mod, this.namer);
    this.ix = mod.index();
    this.enumCache = new Map();
    this.extCache = new Map();
    this.inlinedMethods = new Set();
    this.consumedTypes = new Set();
    this.lambdaDepth = 0;
  }

  // ---------- enum value names for constants passed to enum-typed slots ----------
  enumMembers(typeName) {
    if (this.enumCache.has(typeName)) return this.enumCache.get(typeName);
    let map = null;
    for (let i = 1; i <= this.mod.count(T.TypeDef); i++) {
      if (this.namer.typeDefName(i) !== typeName) continue;
      const td = this.mod.row(T.TypeDef, i);
      if (!this.isEnum(td)) break;
      map = new Map();
      const [fs, fe] = this.mod.listRange(T.TypeDef, i, 'FieldList', T.Field);
      for (let f = fs; f < fe; f++) {
        const c = this.ix.constants.get(T.Field * 16777216 + f);
        if (c) map.set(Number(this.constValue(c)), this.mod.str(this.mod.row(T.Field, f).Name));
      }
      break;
    }
    this.enumCache.set(typeName, map);
    return map;
  }

  isEnum(td) { const ext = td.Extends; return ext.index && this.namer.fullRefName(ext.table, ext.index) === 'System.Enum'; }

  constValue(c) {
    const b = this.mod.blob(c.Value);
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    switch (c.Type) {
      case 0x02: return b[0] !== 0;
      case 0x03: return String.fromCharCode(dv.getUint16(0, true));
      case 0x04: return dv.getInt8(0); case 0x05: return dv.getUint8(0);
      case 0x06: return dv.getInt16(0, true); case 0x07: return dv.getUint16(0, true);
      case 0x08: return dv.getInt32(0, true); case 0x09: return dv.getUint32(0, true);
      case 0x0a: return dv.getBigInt64(0, true); case 0x0b: return dv.getBigUint64(0, true);
      case 0x0c: return dv.getFloat32(0, true); case 0x0d: return dv.getFloat64(0, true);
      case 0x0e: return new TextDecoder('utf-16le').decode(b);
      case 0x12: return null;
      default: return null;
    }
  }

  constText(c) {
    const v = this.constValue(c);
    if (v === null) return 'null';
    if (typeof v === 'string') return c.Type === 0x03 ? charLit(v.charCodeAt(0)) : strLit(v);
    if (typeof v === 'boolean') return String(v);
    if (typeof v === 'bigint') return v.toString();
    if (c.Type === 0x0c) return numLit(v, 'float');
    if (c.Type === 0x0d) return numLit(v, 'double');
    return String(v);
  }

  // ---------- expressions ----------
  typed(e, typeName, m) {
    // render a constant according to the slot type it flows into
    if (e && e.k === 'const' && typeof e.v === 'number' && Number.isInteger(e.v) && typeName) {
      if (typeName === 'bool') return e.v === 0 ? 'false' : 'true';
      if (typeName === 'char') return charLit(e.v);
      if (typeName === 'float' || typeName === 'double') return numLit(e.v, typeName);
      const en = this.enumMembers(typeName);
      const tn = m && m.selfName && typeName.startsWith(m.selfName + '.') ? typeName.slice(m.selfName.length + 1) : typeName;
      if (en && en.has(e.v)) return `${tn}.${en.get(e.v)}`;
      if (en) return `(${tn})${e.v}`;
    }
    return this.expr(e, m, 0);
  }

  // right-hand operand rendered in the type of the left one (bool/char/enum/float constants)
  rhs(b, leftType, m, p) {
    if (b && b.k === 'const' && typeof b.v === 'number' && Number.isInteger(b.v) && leftType && leftType !== 'int') return this.typed(b, leftType, m);
    return this.expr(b, m, p);
  }

  argList(args, m, method) {
    const gc = { type: method && method.typeArgs ? method.typeArgs.map((a) => this.namer.sigName(a, m.gctx)) : (method && method.gtype) || [], method: method && method.methodArgs ? method.methodArgs.map((a) => this.namer.sigName(a, m.gctx)) : (method && method.gmeth) || [] };
    return args.map((a, i) => {
      const ps = method && method.params[i];
      const pt = ps ? this.namer.sigName(ps, gc) : null;
      if (a && a.k === 'addr') return (ps && ps.k === 'byref' ? (method.outParams && method.outParams.has(i) ? 'out ' : 'ref ') : '&') + this.expr(a.a, m, PREC.unary);
      return this.typed(a, pt && pt.replace(/^ref /, ''), m);
    }).join(', ');
  }

  memberOwner(ownerName, m) {
    if (!ownerName || ownerName === '?') return '';
    return ownerName === m.selfName ? '' : ownerName + '.';
  }

  fieldName(f) {
    const mm = /^<(.+)>k__BackingField$/.exec(f.name);
    return mm ? mm[1] : ident(f.name);
  }

  expr(e, m, prec = 0) {
    if (!e) return '/*?*/';
    const wrap = (s, p) => (p < prec ? `(${s})` : s);
    switch (e.k) {
      case 'const': {
        if (e.v === null) return 'null';
        if (e.t === 'string') return strLit(e.v);
        if (typeof e.v === 'boolean') return String(e.v);
        if (e.boxed && e.boxed !== 'int' && e.boxed !== e.t) return this.typed({ ...e, boxed: null }, e.boxed, m);
        const s = numLit(e.v, e.t);
        return s.startsWith('-') ? wrap(s, PREC.unary) : s;
      }
      case 'local': return m.localName(e.i);
      case 'arg': return e.name;
      case 'this': return 'this';
      case 'cap': return ident(e.name);
      case 'tmp': return m.tmpName(e.name, e.t);
      case 'stackvar': return `stack${e.n}`;
      case 'catchvar': return 'ex';
      case 'raw': return e.text;
      case 'field': {
        const name = this.fieldName(e.f);
        if (!e.obj) return this.memberOwner(e.f.owner, m) + name;
        if (e.obj.k === 'this' && !m.shadowed.has(name)) return name;
        return this.expr(e.obj, m, PREC.primary) + '.' + name;
      }
      case 'call': return this.callExpr(e, m, prec);
      case 'new': {
        if (/^(System\.)?Nullable</.test(e.type) || e.type.endsWith('?')) return e.args.length ? (e.type.endsWith('?') ? this.typed(e.args[0], e.type.slice(0, -1), m) : this.expr(e.args[0], m, prec)) : 'null';
        return `new ${e.type}(${this.argList(e.args, m, e.m)})`;
      }
      case 'delegate': {
        const lam = this.lambda(e, m);
        if (lam) return prec > PREC.assign ? `(${lam})` : lam;
        const mn = ident(e.method.name);
        if (e.target && e.target.k === 'const' && e.target.v === null) return this.memberOwner(e.method.owner, m) + mn;
        if (e.target && e.target.k === 'this') return mn;
        return this.expr(e.target, m, PREC.primary) + '.' + mn;
      }
      case 'fnptr': return ident(e.m.name);
      case 'newarr': {
        const [base, rest] = splitArray(e.type);
        return `new ${base}[${this.expr(e.size, m, 0)}]${rest}`;
      }
      case 'arrinit': return `new ${e.type}[] { ${e.items.map((x) => this.typed(x, e.type, m)).join(', ')} }`;
      case 'elem': return this.expr(e.a, m, PREC.primary) + '[' + this.expr(e.i, m, 0) + ']';
      case 'len': return this.expr(e.a, m, PREC.primary) + '.Length';
      case 'bin': {
        const p = PREC[e.op];
        return wrap(`${this.expr(e.a, m, p)} ${e.op} ${this.rhs(e.b, e.a && e.a.t, m, p + 1)}`, p);
      }
      case 'un': return wrap(e.op + this.expr(e.a, m, PREC.unary), PREC.unary);
      case 'not': {
        if (e.a.k === 'cmp' && !e.a.float) return this.expr({ ...e.a, op: { '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>' }[e.a.op] }, m, prec);
        return wrap('!' + this.expr(e.a, m, PREC.unary), PREC.unary);
      }
      case 'logic': return wrap(`${this.expr(e.a, m, PREC[e.op])} ${e.op} ${this.expr(e.b, m, PREC[e.op] + 1)}`, PREC[e.op]);
      case 'cmp': {
        const a = e.a, b = e.b;
        // isinst / null checks
        if (a.k === 'as' && b.k === 'const' && b.v === null) {
          const s = `${this.expr(a.a, m, PREC.is)} is ${a.type}`;
          return e.op === '!=' ? wrap(s, PREC.is) : wrap(`!(${s})`, PREC.unary);
        }
        // bool compared with 0/1
        if ((a.t === 'bool') && b.k === 'const' && (b.v === 0 || b.v === false)) return e.op === '==' ? wrap('!' + this.expr(a, m, PREC.unary), PREC.unary) : this.expr(a, m, prec);
        if ((a.t === 'bool') && b.k === 'const' && (b.v === 1 || b.v === true)) return e.op === '==' ? this.expr(a, m, prec) : wrap('!' + this.expr(a, m, PREC.unary), PREC.unary);
        const p = PREC[e.op];
        return wrap(`${this.expr(a, m, p)} ${e.op} ${this.rhs(b, a.t, m, p + 1)}`, p);
      }
      case 'cast': {
        if (e.a.k === 'const' && typeof e.a.v === 'number' && e.conv) {
          if (e.type === 'float' || e.type === 'double') return numLit(e.a.v, e.type);
          if (e.type === 'long' || e.type === 'ulong' || e.type === 'int' || e.type === 'uint' || e.type === 'char') return e.type === 'char' ? charLit(e.a.v) : numLit(e.a.v, 'int');
        }
        if (e.a.t === e.type && !e.conv) return this.expr(e.a, m, prec);
        return wrap(`(${e.type})${this.expr(e.a, m, PREC.unary)}`, PREC.unary);
      }
      case 'as': return wrap(`${this.expr(e.a, m, PREC.as)} as ${e.type}`, PREC.as);
      case 'typeof': return `typeof(${e.type})`;
      case 'addr': return wrap('&' + this.expr(e.a, m, PREC.unary), PREC.unary);
      case 'deref':
        if ((e.a.k === 'arg' || e.a.k === 'local') && e.a.sig && e.a.sig.k === 'byref') return this.expr(e.a, m, prec);
        return wrap('*' + this.expr(e.a, m, PREC.unary), PREC.unary);
      case 'coalesce': return wrap(`${this.expr(e.a, m, PREC['??'] + 0.1)} ?? ${this.expr(e.b, m, PREC['??'])}`, PREC['??']);
      case 'init': {
        const base = this.expr(e.obj, m, PREC.primary).replace(/\(\)$/, '');
        const parts = e.items.map((it) => (it.k === 'initadd' ? (it.args.length === 1 ? this.expr(it.args[0], m, 0) : `{ ${it.args.map((a) => this.expr(a, m, 0)).join(', ')} }`) : `${it.f ? this.fieldName(it.f) : it.name} = ${this.typed(it.value, it.value && it.value.t, m)}`));
        const one = `${base} { ${parts.join(', ')} }`;
        if (one.length < 100 && !one.includes('\n')) return one;
        const ind = '\t'.repeat((m.curInd || 0) + 1);
        return `${base}\n${'\t'.repeat(m.curInd || 0)}{\n${parts.map((x) => ind + x).join(',\n')}\n${'\t'.repeat(m.curInd || 0)}}`;
      }
      case 'default': return `default(${e.type})`;
      case 'intrinsic': return e.name === 'stackalloc' ? `stackalloc byte[${this.expr(e.args[0], m, 0)}]` : `${e.name}(${e.args.map((a) => this.expr(a, m, 0)).join(', ')})`;
      case 'ternary': return wrap(`${this.expr(e.c, m, PREC.ternary + 1)} ? ${this.expr(e.a, m, PREC.ternary)} : ${this.expr(e.b, m, PREC.ternary)}`, PREC.ternary);
      default: return `/*${e.k}*/`;
    }
  }

  callExpr(e, m, prec) {
    const meth = e.m;
    const name = meth.name;
    const args = e.args;
    const target = () => {
      if (!e.obj) return this.memberOwner(meth.owner, m);
      if (e.base) return 'base.';
      if (e.obj.k === 'this') return '';
      return this.expr(e.obj, m, PREC.primary) + '.';
    };
    // Type.GetTypeFromHandle(typeof(X)) -> typeof(X)
    if (name === 'GetTypeFromHandle' && args.length === 1 && args[0].k === 'typeof') return `typeof(${args[0].type})`;
    // string concatenation
    if (name === 'Concat' && /^(string|String)$/.test(meth.owner) && args.length >= 2 && args.length <= 4 && !(args[0].k === 'newarr')) {
      return (prec > PREC['+'] ? '(' : '') + args.map((a) => this.expr(a, m, PREC['+'] + 1)).join(' + ') + (prec > PREC['+'] ? ')' : '');
    }
    // operators
    if (OPS[name] && !e.obj && args.length === 2) {
      const p = PREC[OPS[name]];
      const s = `${this.expr(args[0], m, p)} ${OPS[name]} ${this.expr(args[1], m, p + 1)}`;
      return p < prec ? `(${s})` : s;
    }
    if (UOPS[name] && !e.obj && args.length === 1) return UOPS[name] + this.expr(args[0], m, PREC.unary);
    if ((name === 'op_Implicit') && !e.obj && args.length === 1) return this.expr(args[0], m, prec);
    if ((name === 'op_Explicit') && !e.obj && args.length === 1) { const s = `(${this.namer.sigName(meth.ret, m.gctx)})${this.expr(args[0], m, PREC.unary)}`; return PREC.unary < prec ? `(${s})` : s; }
    // properties & indexers
    if (name.startsWith('get_') && name.length > 4) {
      if (name === 'get_Item' && args.length >= 1) { const t = target(); return (t ? t.replace(/\.$/, '') : 'this') + '[' + this.argList(args, m, meth) + ']'; }
      if (!args.length) return target() + name.slice(4);
    }
    const generic = meth.methodArgs && meth.methodArgs.length && !this.inferable(meth) ? '<' + meth.methodArgs.map((a) => this.namer.sigName(a, m.gctx)).join(', ') + '>' : '';
    // extension methods read as instance calls
    if (!e.obj && args.length >= 1 && !(args[0].k === 'const' && args[0].v === null) && this.isExtension(meth)) {
      const rest = { ...meth, params: meth.params.slice(1) };
      return `${this.expr(args[0], m, PREC.primary)}.${ident(name)}${generic}(${this.argList(args.slice(1), m, rest)})`;
    }
    return `${target()}${ident(name)}${generic}(${this.argList(args, m, meth)})`;
  }

  // generic method arguments can be left out when every one appears in the parameters
  inferable(meth) {
    const seen = new Set();
    const visit = (t) => { if (!t || typeof t !== 'object') return; if (t.k === 'mvar') seen.add(t.n); visit(t.t); visit(t.base); if (t.args) t.args.forEach(visit); };
    (meth.params || []).forEach(visit);
    for (let i = 0; i < meth.methodArgs.length; i++) if (!seen.has(i)) return false;
    return true;
  }

  isExtension(meth) {
    if (meth.def) {
      if (!this.extCache.has(meth.def)) {
        const attrs = this.ix.attrs.get(T.MethodDef * 16777216 + meth.def) || [];
        this.extCache.set(meth.def, attrs.some((ca) => { try { return /^(System\.Runtime\.CompilerServices\.)?ExtensionAttribute$/.test(this.resolver.method((ca.Type.table << 24) | ca.Type.index).owner); } catch { return false; } }));
      }
      return this.extCache.get(meth.def);
    }
    return /^(Enumerable|Queryable|ParallelEnumerable)$/.test(meth.owner);
  }

  // Compiler-generated method behind a delegate, written inline as a lambda.
  lambda(e, m) {
    const md = e.method && e.method.def;
    if (!md || this.lambdaDepth > 6) return null;
    const mod = this.mod;
    const row = mod.row(T.MethodDef, md);
    if (!row || !/^</.test(mod.str(row.Name)) || !row.RVA) return null;
    const ownerTi = this.ix.methodOwner[md];
    if (!ownerTi) return null;
    this.lambdaDepth++;
    try {
      const d = decompileMethod({ mod, namer: this.namer, resolver: this.resolver }, md);
      if (!d) return null;
      const lm = this.methodContext(md, ownerTi, d);
      lm.selfName = m.selfName;
      lm.curInd = m.curInd || 0;
      const ownerName = mod.str(mod.row(T.TypeDef, ownerTi).Name);
      let stmts = this.applyCaptures(d.stmts, d, lm, { thisTransparent: isDisplayName(ownerName) });
      if (stmts.length && stmts[stmts.length - 1].k === 'ret' && !stmts[stmts.length - 1].e) stmts = stmts.slice(0, -1);
      const ps = d.params.map((p) => p.name);
      const head = ps.length === 1 ? ps[0] : `(${ps.join(', ')})`;
      let text;
      if (stmts.length === 1 && stmts[0].k === 'ret' && stmts[0].e) text = `${head} => ${this.typed(stmts[0].e, lm.retType, lm)}`;
      else if (stmts.length === 1 && stmts[0].k === 'expr' && !stmts[0].cond) text = `${head} => ${stmts[0].e.k === 'call' ? this.callStmt(stmts[0].e, lm).replace(/;$/, '') : this.expr(stmts[0].e, lm, 0)}`;
      else if (!stmts.length) text = `${head} => { }`;
      else {
        const ind = lm.curInd;
        const body = this.bodyLines(d, lm, stmts, ind + 1);
        text = `${head} =>\n${'\t'.repeat(ind)}{\n${body.join('\n')}\n${'\t'.repeat(ind)}}`;
      }
      if (/Decompilation failed/.test(text)) return null;
      this.inlinedMethods.add(md);
      return text;
    } catch {
      return null;
    } finally {
      this.lambdaDepth--;
    }
  }

  // statement-level call rewriting (setters, events)
  callStmt(e, m) {
    const meth = e.m, name = meth.name, args = e.args;
    const tgt = !e.obj ? this.memberOwner(meth.owner, m) : e.base ? 'base.' : e.obj.k === 'this' ? '' : this.expr(e.obj, m, PREC.primary) + '.';
    if (name.startsWith('set_') && name.length > 4) {
      if (name === 'set_Item' && args.length >= 2) return `${tgt ? tgt.replace(/\.$/, '') : 'this'}[${this.argList(args.slice(0, -1), m, meth)}] = ${this.expr(args[args.length - 1], m, 0)};`;
      if (args.length === 1) {
        // obj.P = obj.P op x  ->  obj.P op= x
        const v = args[0];
        if (v.k === 'bin' && v.a.k === 'call' && v.a.m.name === 'get_' + name.slice(4) && !v.a.args.length && this.expr(v.a.obj || { k: 'this' }, m, 0) === this.expr(e.obj || { k: 'this' }, m, 0) && /^([-+*/%&|^]|<<|>>)$/.test(v.op)) {
          if ((v.op === '+' || v.op === '-') && v.b.k === 'const' && v.b.v === 1 && !v.opcall) return `${tgt}${name.slice(4)}${v.op}${v.op};`;
          return `${tgt}${name.slice(4)} ${v.op}= ${this.rhs(v.b, v.a.t, m, 0)};`;
        }
        const pt = meth.params[0] ? this.namer.sigName(meth.params[0], { type: meth.gtype || [] }) : null;
        return `${tgt}${name.slice(4)} = ${this.typed(args[0], pt, m)};`;
      }
    }
    if ((name.startsWith('add_') || name.startsWith('remove_')) && args.length === 1 && (args[0].k === 'delegate' || /Handler|Action|Event|Func|Delegate|Callback/.test(args[0].t || ''))) {
      const ev = name.slice(name.indexOf('_') + 1);
      return `${tgt}${ev} ${name.startsWith('add_') ? '+=' : '-='} ${this.expr(args[0], m, 0)};`;
    }
    return this.expr(e, m, 0) + ';';
  }

  // ---------- statements ----------
  varType(v, m) {
    if (!v) return 'var';
    if (v.k === 'local') return m.localType(v.i);
    return v.t && v.t !== 'null' ? v.t : 'var';
  }

  stmts(list, m, ind) {
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const s = list[i];
      const pad = '\t'.repeat(ind);
      m.curInd = ind;
      switch (s.k) {
        case 'assign': {
          const declare = (s.target.k === 'local' || s.target.k === 'cap') && m.inlineDecl.get(s) ? this.varType(s.target, m) + ' ' : s.target.k === 'tmp' && s.decl ? 'var ' : '';
          const tt = s.target.t;
          const val = this.typed(s.value, tt, m);
          const tgt = s.target.k === 'field' && s.target.obj === null ? this.expr(s.target, m, 0) : this.expr(s.target, m, 0);
          out.push(`${pad}${declare}${tgt} ${s.op ? s.op + '=' : '='} ${val};`);
          break;
        }
        case 'incr': out.push(`${pad}${this.expr(s.target, m, PREC.primary)}${s.op};`); break;
        case 'expr':
          if (s.e.k === 'call') out.push(pad + this.callStmt(s.e, m));
          else if (s.cond) out.push(`${pad}if (${this.expr(s.e, m, 0)}) { }`);
          else out.push(`${pad}${this.expr(s.e, m, 0)};`);
          break;
        case 'ret': out.push(`${pad}return${s.e ? ' ' + this.typed(s.e, m.retType, m) : ''};`); break;
        case 'throw': out.push(`${pad}throw${s.e ? ' ' + this.expr(s.e, m, 0) : ''};`); break;
        case 'break': out.push(`${pad}break;`); break;
        case 'continue': out.push(`${pad}continue;`); break;
        case 'goto': out.push(`${pad}goto ${m.labelName(s.block)};`); break;
        case 'label': out.push(`${m.labelName(s.block)}:`); break;
        case 'comment': out.push(`${pad}// ${s.text}`); break;
        case 'if': {
          let cur = s;
          out.push(`${pad}if (${this.expr(cur.cond, m, 0)})`);
          out.push(...this.block(cur.then, m, ind));
          while (cur.else.length === 1 && cur.else[0].k === 'if') {
            cur = cur.else[0];
            out.push(`${pad}else if (${this.expr(cur.cond, m, 0)})`);
            out.push(...this.block(cur.then, m, ind));
          }
          if (cur.else.length) { out.push(`${pad}else`); out.push(...this.block(cur.else, m, ind)); }
          break;
        }
        case 'while': out.push(`${pad}while (${this.expr(s.cond, m, 0)})`); out.push(...this.block(s.body, m, ind)); break;
        case 'yield': out.push(`${pad}yield return ${this.typed(s.e, m.yieldType, m)};`); break;
        case 'yieldbreak': out.push(`${pad}yield break;`); break;
        case 'foreach': {
          const vt = s.v ? s.vt || this.varType(s.v, m) : s.vt || 'var';
          out.push(`${pad}foreach (${vt} ${s.v ? this.expr(s.v, m, 0) : '_'} in ${this.expr(s.coll, m, 0)})`);
          out.push(...this.block(s.body, m, ind));
          break;
        }
        case 'using': {
          const head = s.target ? `${m.headerDecl.has(s) ? this.varType(s.target, m) + ' ' : ''}${this.expr(s.target, m, 0)} = ${this.typed(s.value, s.target.t, m)}` : this.expr(s.value, m, 0);
          out.push(`${pad}using (${head})`);
          out.push(...this.block(s.body, m, ind));
          break;
        }
        case 'lock': out.push(`${pad}lock (${this.expr(s.obj, m, 0)})`); out.push(...this.block(s.body, m, ind)); break;
        case 'for': {
          const one = (x) => this.stmts([x], m, 0).join(' ').replace(/;$/, '');
          const init = s.init.map((x) => (s.declInit && x.k === 'assign' ? `${this.varType(x.target, m)} ${this.expr(x.target, m, 0)} = ${this.typed(x.value, x.target.t, m)}` : one(x))).join(', ');
          out.push(`${pad}for (${init}; ${this.expr(s.cond, m, 0)}; ${s.step.map(one).join(', ')})`);
          m.curInd = ind;
          out.push(...this.block(s.body, m, ind));
          break;
        }
        case 'dowhile': out.push(`${pad}do`); out.push(...this.block(s.body, m, ind)); out.push(`${pad}while (${this.expr(s.cond, m, 0)});`); break;
        case 'switch': {
          out.push(`${pad}switch (${this.expr(s.e, m, 0)})`);
          out.push(`${pad}{`);
          const et = s.e && s.e.t;
          for (const c of s.cases) {
            for (const v of c.values) out.push(`${pad}case ${this.typed({ k: 'const', v, t: 'int' }, et, m)}:`);
            const body = this.stmts(c.body, m, ind + 1);
            out.push(...body);
            if (!flowEnds(c.body)) out.push(`${pad}\tbreak;`);
          }
          if (s.def.length) {
            out.push(`${pad}default:`);
            out.push(...this.stmts(s.def, m, ind + 1));
            if (!flowEnds(s.def)) out.push(`${pad}\tbreak;`);
          }
          out.push(`${pad}}`);
          break;
        }
        case 'try': {
          out.push(`${pad}try`);
          out.push(...this.block(s.body, m, ind));
          for (const c of s.catches) {
            const v = c.local != null ? ' ' + m.localName(c.local) : '';
            if (c.local != null) m.catchLocals.add(c.local);
            out.push(`${pad}catch${c.type === 'object' ? '' : ` (${c.type}${v})`}${c.filter ? ' when (true)' : ''}`);
            out.push(...this.block(c.body, m, ind));
          }
          if (s.fin) { out.push(`${pad}${s.fin.fault ? 'fault' : 'finally'}`); out.push(...this.block(s.fin.body, m, ind)); }
          break;
        }
        default: out.push(`${pad}/* ${s.k} */`);
      }
    }
    return out;
  }

  block(list, m, ind) {
    const pad = '\t'.repeat(ind);
    return [`${pad}{`, ...this.stmts(list, m, ind + 1), `${pad}}`];
  }

  // ---------- methods ----------
  methodContext(mdIdx, typeIdx, decomp) {
    const mod = this.mod;
    const row = mod.row(T.MethodDef, mdIdx);
    const sig = parseSig(mod, row.Signature, 'method');
    const gctx = { type: this.namer.typeGenericParams(typeIdx), method: this.namer.methodGenericParams(mdIdx) };
    const used = new Set((decomp ? decomp.params : []).map((p) => p.name));
    const names = new Map();
    const counts = new Map();
    const self = this;
    const m = {
      gctx,
      selfName: this.namer.typeDefName(typeIdx),
      retType: this.namer.sigName(sig.ret, gctx),
      shadowed: new Set(),
      inlineDecl: new Map(),
      headerDecl: new Set(),
      catchLocals: new Set(),
      curInd: 0,
      tmpName(name, type) {
        const key = 'tmp:' + name;
        if (names.has(key)) return names.get(key);
        let base = suggestName(type && type !== 'var' ? type : 'object');
        let n = base, k = 0;
        while (used.has(n)) { k++; n = base + k; }
        used.add(n);
        names.set(key, n);
        return n;
      },
      localName(i) {
        if (names.has(i)) return names.get(i);
        const l = decomp && decomp.locals[i];
        let base = suggestName(l ? l.type : 'object');
        let n = base, k = counts.get(base) || 0;
        while (used.has(n) || (k && n === base)) { k++; n = base + k; }
        if (!k && used.has(base)) n = base + 2;
        counts.set(base, k);
        used.add(n);
        names.set(i, n);
        return n;
      },
      localType(i) { const l = decomp && decomp.locals[i]; return l ? (l.type.startsWith('ref ') ? l.type : l.type) : 'var'; },
      labelName(block) { const off = decomp && decomp.blockStart ? decomp.blockStart(block) : block; return 'IL_' + off.toString(16).padStart(4, '0'); },
    };
    void self;
    for (const p of (decomp ? decomp.params : [])) m.shadowed.add(p.name);
    return m;
  }

  methodBodyText(mdIdx, typeIdx, ind, transform) {
    const it = this.iteratorInfo(mdIdx, typeIdx);
    if (it) {
      try { const r = this.iteratorBodyText(mdIdx, typeIdx, ind, it); if (r) return r; } catch { /* fall back to the state machine */ }
    }
    let d;
    try { d = decompileMethod({ mod: this.mod, namer: this.namer, resolver: this.resolver }, mdIdx); }
    catch (err) { return { text: [`${'\t'.repeat(ind)}// Decompilation failed: ${err.message}`, ...this.ilComment(mdIdx, ind)], d: null }; }
    if (!d) return { text: null, d: null };
    const m = this.methodContext(mdIdx, typeIdx, d);
    d.stmts = this.applyCaptures(d.stmts, d, m, {});
    if (transform) transform(d, m);
    return { text: this.bodyLines(d, m, d.stmts, ind), d };
  }

  // display-class locals (closures) read as the captured variables themselves
  applyCaptures(stmts, d, m, o) {
    const displayLocals = new Set();
    d.locals.forEach((l, i) => { if (isDisplayName(l.type)) displayLocals.add(i); });
    if (!displayLocals.size && !o.thisTransparent && !o.iterator && !JSON.stringify(stmts, (k, v) => (k === 'm' || k === 'f' || k === 'sig' ? undefined : typeof v === 'bigint' ? 0 : v)).includes('DisplayClass')) return stmts;
    const out = captures(stmts, {
      transparent: (e) => (e.k === 'local' && displayLocals.has(e.i)) || (e.k === 'this' && !e.outer && (o.thisTransparent || o.iterator)) || (e.k === 'tmp' && isDisplayName(e.t)),
      paramNames: new Set(o.paramNames || []),
      thisType: m.selfName,
      isDisplayType: isDisplayName,
    });
    for (const k of usage(out).keys()) if (k.startsWith('c:')) m.shadowed.add(k.slice(2));
    return simplify(out);
  }

  // declarations + statements of a body
  bodyLines(d, m, stmts, ind) {
    const pad = '\t'.repeat(ind);
    const u = usage(stmts);
    const seen = new Set();
    const keyOf = (v) => (v.k === 'local' ? 'l:' + v.i : v.k === 'cap' ? 'c:' + v.name : null);
    for (const s of stmts) {
      if (s.k === 'assign' && !s.op && (s.target.k === 'local' || (s.target.k === 'cap' && !s.target.param))) {
        const k = keyOf(s.target);
        const self = usage([{ k: 'expr', e: s.value }]).get(k);
        if (!seen.has(k) && !self) { m.inlineDecl.set(s, true); seen.add(k); }
      }
      if (s.k === 'for' && s.declInit && s.init[0] && s.init[0].k === 'assign') seen.add(keyOf(s.init[0].target));
      for (const k of usage([s]).keys()) seen.add(k);
    }
    // variables declared by statement headers
    const header = new Set();
    const visit = (list) => {
      for (const s of list) {
        if (s.k === 'foreach' && s.v) header.add(keyOf(s.v));
        if (s.k === 'for' && s.declInit && s.init[0] && s.init[0].target) header.add(keyOf(s.init[0].target));
        if (s.k === 'using' && s.target && keyOf(s.target)) { header.add(keyOf(s.target)); m.headerDecl.add(s); }
        if (s.k === 'try') for (const c of s.catches) if (c.local != null) header.add('l:' + c.local);
        for (const l of [s.then, s.else, s.body, s.def, ...(s.cases || []).map((c) => c.body), ...(s.catches || []).map((c) => c.body), s.fin && s.fin.body]) if (Array.isArray(l)) visit(l);
      }
    };
    visit(stmts);
    const inline = new Set([...m.inlineDecl.keys()].map((s) => keyOf(s.target)));
    const lines = this.stmts(stmts, m, ind);
    const decls = [];
    for (const [k] of u) {
      if (header.has(k) || inline.has(k)) continue;
      if (k.startsWith('l:')) {
        const i = +k.slice(2);
        if (m.catchLocals.has(i) || !d.locals[i]) continue;
        decls.push(`${pad}${d.locals[i].type} ${m.localName(i)};`);
      } else if (k.startsWith('c:')) {
        let t = null, isParam = false;
        const find = (e) => { if (!e || typeof e !== 'object') return; if (e.k === 'cap' && e.name === k.slice(2)) { t = t || e.t; isParam = isParam || e.param; } };
        JSON.stringify(stmts, (key, v) => { if (v && typeof v === 'object' && v.k === 'cap') find(v); return key === 'm' || key === 'f' || key === 'sig' ? undefined : typeof v === 'bigint' ? 0 : v; });
        if (!isParam) decls.push(`${pad}${t && t !== 'null' ? t : 'object'} ${ident(k.slice(2))};`);
      } else if (k.startsWith('s:')) {
        const x = d.extraLocals.find((l) => l.name === 'stack' + k.slice(2));
        decls.push(`${pad}${x && x.type !== 'var' ? x.type : 'object'} stack${k.slice(2)};`);
      }
    }
    // drop a trailing bare "return;" in void methods
    if (lines.length && (lines[lines.length - 1].trim() === 'return;' && m.retType === 'void' || (m.iterator && lines[lines.length - 1].trim() === 'yield break;' && lines[lines.length - 1].startsWith(pad + 'y')))) lines.pop();
    return [...decls, ...lines];
  }

  // A method whose body only creates a compiler-generated iterator (Unity coroutines, yield).
  iteratorInfo(mi, ti) {
    const mod = this.mod;
    const row = mod.row(T.MethodDef, mi);
    if (!row.RVA) return null;
    const body = mod.methodBody(row.RVA);
    if (!body || body.code.length > 256) return null;
    let insns;
    try { insns = decodeIL(body.code); } catch { return null; }
    for (const x of insns) {
      if (x.name !== 'newobj') continue;
      const ctor = this.resolver.method(x.arg);
      const smTi = ctor.ownerDef;
      if (!smTi || this.ix.enclosing.get(smTi) !== ti) continue;
      const smName = mod.str(mod.row(T.TypeDef, smTi).Name);
      if (!/^<.*>(d__\d+|c__Iterator\d+)/.test(smName)) continue;
      const fields = new Map();
      const [fs, fe] = mod.listRange(T.TypeDef, smTi, 'FieldList', T.Field);
      for (let f = fs; f < fe; f++) fields.set(mod.str(mod.row(T.Field, f).Name), f);
      if (fields.has('<>t__builder')) return null; // async
      const state = fields.has('<>1__state') ? '<>1__state' : fields.has('$PC') ? '$PC' : null;
      const current = fields.has('<>2__current') ? '<>2__current' : fields.has('$current') ? '$current' : null;
      if (!state || !current) return null;
      const thisField = ['<>4__this', '$this', '<>f__this'].find((n) => fields.has(n)) || null;
      let moveNext = 0;
      const finals = new Map();
      const [ms, me] = mod.listRange(T.TypeDef, smTi, 'MethodList', T.MethodDef);
      for (let k = ms; k < me; k++) {
        const n = mod.str(mod.row(T.MethodDef, k).Name);
        if (n === 'MoveNext' || n.endsWith('.MoveNext')) moveNext = k;
        if (/^<>m__Finally\d+$/.test(n)) finals.set(n, k);
      }
      if (!moveNext) return null;
      const curSig = parseSig(mod, mod.row(T.Field, fields.get(current)).Signature, 'field');
      return { smTi, moveNext, state, current, thisField, finals, yieldType: this.namer.sigName(curSig, { type: this.namer.typeGenericParams(smTi) }) };
    }
    return null;
  }

  iteratorBodyText(mi, ti, ind, info) {
    const ctx = { mod: this.mod, namer: this.namer, resolver: this.resolver };
    const finallyBodies = new Map();
    for (const [name, fmi] of info.finals) { const fd = decompileMethod(ctx, fmi); if (fd) finallyBodies.set(name, fd.stmts); }
    const d = decompileMethod(ctx, info.moveNext, { iterator: { state: info.state, current: info.current, thisField: info.thisField } });
    if (!d || !d.iterOK) return null;
    const r = iteratorStatements(d.stmts, { state: info.state, finallyBodies });
    if (!r.ok) return null;
    const m = this.methodContext(info.moveNext, info.smTi, d);
    const outer = this.methodContext(mi, ti, null);
    m.selfName = outer.selfName;
    m.retType = outer.retType;
    m.iterator = true;
    m.yieldType = info.yieldType;
    const [ps, pe] = this.mod.listRange(T.MethodDef, mi, 'ParamList', T.Param);
    const paramNames = [];
    for (let p = ps; p < pe; p++) { const pr = this.mod.row(T.Param, p); if (pr.Sequence > 0) paramNames.push(ident(this.mod.str(pr.Name))); }
    paramNames.forEach((n) => m.shadowed.add(n));
    const stmts = this.applyCaptures(r.stmts, d, m, { iterator: true, paramNames });
    // anything still touching the state machine means the rewrite was incomplete
    const leftover = JSON.stringify(stmts, (k, v) => (k === 'm' || k === 'sig' ? undefined : typeof v === 'bigint' ? 0 : v));
    if (/<>1__state|<>2__current|"\$PC"|"\$current"/.test(leftover)) return null;
    const text = this.bodyLines(d, m, stmts, ind);
    this.consumedTypes.add(info.smTi);
    return { text, d };
  }

  // compiler-generated nested types whose code was written inline elsewhere
  consumed(nt) {
    if (this.consumedTypes.has(nt)) return true;
    const mod = this.mod;
    if (!/^</.test(mod.str(mod.row(T.TypeDef, nt).Name))) return false;
    if ((this.ix.nested.get(nt) || []).some((x) => !this.consumed(x))) return false;
    const [ms, me] = mod.listRange(T.TypeDef, nt, 'MethodList', T.MethodDef);
    let lambdas = 0;
    for (let k = ms; k < me; k++) {
      const n = mod.str(mod.row(T.MethodDef, k).Name);
      if (n === '.ctor' || n === '.cctor') continue;
      if (!this.inlinedMethods.has(k)) return false;
      lambdas++;
    }
    return lambdas > 0;
  }

  ilComment(mdIdx, ind) {
    const row = this.mod.row(T.MethodDef, mdIdx);
    const body = this.mod.methodBody(row.RVA);
    if (!body) return [];
    const text = disassemble(decodeIL(body.code), { tokenText: (t) => this.tokenText(t), handlers: body.handlers });
    return text.split('\n').map((l) => `${'\t'.repeat(ind)}// ${l}`);
  }

  tokenText(tok) {
    const table = tok >>> 24;
    try {
      if (table === 0x70) return strLit(this.mod.userString(tok & 0xffffff));
      if (table === T.MethodDef || table === T.MemberRef || table === T.MethodSpec) {
        const mi = this.resolver.method(tok);
        if (mi.sig && mi.sig.params && !(table === T.MemberRef && this.mod.blob(this.mod.row(T.MemberRef, tok & 0xffffff).Signature)[0] === 6)) return `${mi.owner}::${mi.name}(${mi.params.map((p) => this.namer.sigName(p)).join(', ')})`;
      }
      if (table === T.Field || table === T.MemberRef) { const f = this.resolver.field(tok); return `${f.owner}::${f.name}`; }
      if (table === T.TypeDef || table === T.TypeRef || table === T.TypeSpec) return this.namer.tokenName(tok);
    } catch { /* ignore */ }
    return '0x' + tok.toString(16);
  }

  methodIL(mdIdx) {
    const row = this.mod.row(T.MethodDef, mdIdx);
    const body = this.mod.methodBody(row.RVA);
    if (!body) return '// (no body)';
    return disassemble(decodeIL(body.code), { tokenText: (t) => this.tokenText(t), handlers: body.handlers });
  }

  // ---------- attributes ----------
  attributes(table, index, gctx) {
    const list = this.ix.attrs.get(table * 16777216 + index) || [];
    const out = [];
    for (const ca of list) {
      try {
        const ctor = this.resolver.method((ca.Type.table << 24) | ca.Type.index, gctx);
        let name = ctor.owner.replace(/Attribute$/, '');
        if (/^(CompilerGenerated|DebuggerHidden|DebuggerStepThrough|DebuggerBrowsable|DebuggerDisplay|IteratorStateMachine|AsyncStateMachine|NullableContext|Nullable|Extension|TargetFramework|AssemblyMetadata|RefSafetyRules|IsReadOnly|Embedded|ParamArray|MethodImpl|TupleElementNames|DefaultMember|IsByRefLike|ScriptedImporter)$/.test(name)) continue;
        const args = this.attrArgs(ca, ctor);
        out.push(`[${name}${args.length ? '(' + args.join(', ') + ')' : ''}]`);
      } catch { /* ignore */ }
    }
    return out;
  }

  attrArgs(ca, ctor) {
    const b = this.mod.blob(ca.Value);
    if (b.length < 2) return [];
    const r = new Reader(b);
    if (r.u16() !== 1) return [];
    const out = [];
    const readVal = (sig) => {
      const n = sig.k === 'prim' ? sig.name : this.namer.sigName(sig);
      switch (n) {
        case 'bool': return r.u8_() ? 'true' : 'false';
        case 'char': return charLit(r.u16());
        case 'sbyte': return String(r.i8()); case 'byte': return String(r.u8_());
        case 'short': return String(r.i16()); case 'ushort': return String(r.u16());
        case 'int': return String(r.i32()); case 'uint': return String(r.u32());
        case 'long': return String(r.i64big()); case 'ulong': return String(r.u64big());
        case 'float': return numLit(r.f32(), 'float'); case 'double': return numLit(r.f64(), 'double');
        case 'string': case 'Type': {
          if (r.u8[r.pos] === 0xff) { r.pos++; return 'null'; }
          const len = readCompressed(r);
          const s = new TextDecoder().decode(r.bytes(len));
          return n === 'Type' ? `typeof(${s.split(',')[0].split('.').pop()})` : strLit(s);
        }
        default: {
          const en = this.enumMembers(n);
          if (en) { const v = r.i32(); return en.has(v) ? `${n}.${en.get(v)}` : `(${n})${v}`; }
          throw new Error('complex attribute argument');
        }
      }
    };
    for (const p of ctor.params) out.push(readVal(p));
    if (r.remaining >= 2) {
      const named = r.u16();
      for (let i = 0; i < named && r.remaining > 0; i++) {
        r.u8_();
        const et = r.u8[r.pos];
        let sig;
        if (et === 0x55) { r.u8_(); const len = readCompressed(r); const tn = new TextDecoder().decode(r.bytes(len)).split(',')[0]; sig = { k: 'prim', name: tn.split('.').pop() }; if (!this.enumMembers(sig.name)) sig = { k: 'prim', name: 'int' }; }
        else if (et === 0x50) { r.u8_(); sig = { k: 'prim', name: 'Type' }; }
        else sig = readTypeSig(r);
        const len = readCompressed(r);
        const nm = new TextDecoder().decode(r.bytes(len));
        out.push(`${nm} = ${readVal(sig)}`);
      }
    }
    return out;
  }

  // ---------- types ----------
  typeKind(td) {
    if (td.Flags & 0x20) return 'interface';
    const ext = td.Extends;
    const base = ext.index ? this.namer.fullRefName(ext.table, ext.index) : '';
    if (base === 'System.Enum') return 'enum';
    if (base === 'System.ValueType') return 'struct';
    if (base === 'System.MulticastDelegate') return 'delegate';
    return 'class';
  }

  writeType(ti, ind = 0) {
    const mod = this.mod, td = mod.row(T.TypeDef, ti);
    const pad = '\t'.repeat(ind);
    const gctx = { type: this.namer.typeGenericParams(ti), method: [] };
    const kind = this.typeKind(td);
    const vis = ['internal', 'public', 'public', 'private', 'protected', 'internal', 'private protected', 'protected internal'][td.Flags & 7];
    let mods = vis;
    if (kind === 'class') {
      if ((td.Flags & 0x80) && (td.Flags & 0x100)) mods += ' static';
      else if (td.Flags & 0x80) mods += ' abstract';
      else if (td.Flags & 0x100) mods += ' sealed';
    }
    const name = this.namer.typeDefName(ti).split('.').pop();
    const L = [];
    for (const a of this.attributes(T.TypeDef, ti, gctx)) L.push(pad + a);
    const [ms, me] = mod.listRange(T.TypeDef, ti, 'MethodList', T.MethodDef);
    const [fs, fe] = mod.listRange(T.TypeDef, ti, 'FieldList', T.Field);
    if (kind === 'delegate') {
      for (let mi = ms; mi < me; mi++) {
        if (mod.str(mod.row(T.MethodDef, mi).Name) !== 'Invoke') continue;
        const s = parseSig(mod, mod.row(T.MethodDef, mi).Signature, 'method');
        L.push(`${pad}${vis} delegate ${this.namer.sigName(s.ret, gctx)} ${name}(${this.paramList(mi, s, gctx)});`);
      }
      return L.join('\n');
    }
    const bases = [];
    const ext = td.Extends;
    if (kind === 'class' && ext.index) { const bn = this.namer.refName(ext.table, ext.index, gctx); if (bn !== 'object') bases.push(bn); }
    for (const it of this.ix.interfaces.get(ti) || []) bases.push(this.namer.refName(it.table, it.index, gctx));
    if (kind === 'enum') {
      for (let f = fs; f < fe; f++) { const fr = mod.row(T.Field, f); if (!(fr.Flags & 0x10)) { const ut = this.namer.sigName(parseSig(mod, fr.Signature, 'field')); if (ut !== 'int') bases.push(ut); } }
    }
    L.push(`${pad}${mods} ${kind} ${name}${bases.length ? ' : ' + bases.join(', ') : ''}`);
    L.push(`${pad}{`);
    const inner = ind + 1, ip = '\t'.repeat(inner);
    if (kind === 'enum') {
      for (let f = fs; f < fe; f++) {
        const fr = mod.row(T.Field, f);
        if (!(fr.Flags & 0x10)) continue;
        const c = this.ix.constants.get(T.Field * 16777216 + f);
        L.push(`${ip}${ident(mod.str(fr.Name))}${c ? ' = ' + this.constText(c) : ''},`);
      }
      L.push(`${pad}}`);
      return L.join('\n');
    }
    // methods that belong to properties/events
    const accessor = new Map();
    const props = this.ix.propsOf.get(ti);
    const events = this.ix.eventsOf.get(ti);
    for (let mi = ms; mi < me; mi++) { const s = this.ix.semantics.get(mi); if (s) accessor.set(mi, s); }
    // decompile constructors first to lift field initializers
    const fieldInit = new Map();
    const ctorBodies = new Map();
    const ctors = [];
    for (let mi = ms; mi < me; mi++) { const mn = mod.str(mod.row(T.MethodDef, mi).Name); if (mn === '.ctor' || mn === '.cctor') ctors.push([mi, mn]); }
    const instanceCtors = ctors.filter(([, mn]) => mn === '.ctor').length;
    for (const [mi, mn] of ctors) {
      const lift = (mn === '.cctor') || (instanceCtors === 1 && kind === 'class');
      ctorBodies.set(mi, this.methodBodyText(mi, ti, inner + 1, lift ? (d, m) => {
        const keep = [];
        let lifting = true;
        for (const s of d.stmts) {
          const isBaseCall = s.k === 'expr' && s.e.k === 'call' && s.e.m.name === '.ctor';
          if (isBaseCall) lifting = false;
          if (lifting && s.k === 'assign' && s.target.k === 'field' && s.target.f.ownerDef === ti && (mn === '.cctor' ? !s.target.obj : s.target.obj && s.target.obj.k === 'this') && !mentions(s.value, (x) => x.k === 'arg' || x.k === 'local' || x.k === 'this' || x.k === 'tmp' || x.k === 'stackvar')) {
            fieldInit.set(s.target.f.name, this.typed(s.value, s.target.t, m));
            continue;
          }
          if (mn === '.cctor' && s.k !== 'ret') lifting = lifting && s.k === 'assign';
          keep.push(s);
        }
        d.stmts = keep;
      } : null));
    }
    // fields
    const backing = new Set();
    for (let f = fs; f < fe; f++) {
      const fr = mod.row(T.Field, f);
      const fname = mod.str(fr.Name);
      if (/^<.+>k__BackingField$/.test(fname)) { backing.add(fname.slice(1, fname.indexOf('>'))); continue; }
      if (HIDDEN_FIELD.test(fname)) continue;
      if (events && this.eventNamed(events, fname)) continue;
      const fsig = parseSig(mod, fr.Signature, 'field');
      const ftype = this.namer.sigName(fsig, gctx);
      let fm = ['privatescope', 'private', 'private protected', 'internal', 'protected', 'protected internal', 'public'][fr.Flags & 7];
      if (fr.Flags & 0x40) fm += ' const';
      else { if (fr.Flags & 0x10) fm += ' static'; if (fr.Flags & 0x20) fm += ' readonly'; }
      const c = this.ix.constants.get(T.Field * 16777216 + f);
      for (const a of this.attributes(T.Field, f, gctx)) L.push(ip + a);
      const init = c ? ' = ' + this.constText(c) : fieldInit.has(fname) ? ' = ' + fieldInit.get(fname) : '';
      L.push(`${ip}${fm} ${ftype} ${ident(fname)}${init};`);
    }
    if (fe > fs) L.push('');
    // properties
    if (props) {
      for (let p = props[0]; p < props[1]; p++) {
        const pr = mod.row(T.Property, p);
        const pname = mod.str(pr.Name);
        const psig = parseSig(mod, pr.Type, 'property');
        const ptype = this.namer.sigName(psig.type, gctx);
        let getter = null, setter = null;
        for (const [mi, s] of accessor) if (s.assoc.table === T.Property && s.assoc.index === p) { if (s.sem & 2) getter = mi; else if (s.sem & 1) setter = mi; }
        const any = getter || setter;
        if (!any) continue;
        const arow = mod.row(T.MethodDef, any);
        const mm = this.methodModifiers(arow.Flags, kind === 'interface');
        for (const a of this.attributes(T.Property, p, gctx)) L.push(ip + a);
        const auto = backing.has(pname);
        const isIndexer = psig.params.length > 0;
        let indexParams = '';
        if (isIndexer) {
          const acc = getter || setter;
          const asig = parseSig(mod, mod.row(T.MethodDef, acc).Signature, 'method');
          const full = this.paramList(acc, getter ? asig : { ...asig, params: asig.params.slice(0, -1) }, gctx);
          indexParams = full;
        }
        const head = `${ip}${mm}${mm ? ' ' : ''}${ptype} ${isIndexer ? `this[${indexParams}]` : ident(pname)}`;
        if (auto || kind === 'interface' || (getter && !mod.row(T.MethodDef, getter).RVA && (!setter || !mod.row(T.MethodDef, setter).RVA))) {
          L.push(`${head} { ${getter ? 'get; ' : ''}${setter ? (setter && mod.row(T.MethodDef, setter).Flags & 7) !== (arow.Flags & 7) ? 'private set; ' : 'set; ' : ''}}`);
        } else {
          L.push(head);
          L.push(`${ip}{`);
          for (const [acc, kw] of [[getter, 'get'], [setter, 'set']]) {
            if (!acc) continue;
            const body = this.methodBodyText(acc, ti, inner + 2);
            L.push(`${ip}\t${kw}`);
            L.push(`${ip}\t{`);
            L.push(...(body.text || []));
            L.push(`${ip}\t}`);
          }
          L.push(`${ip}}`);
        }
        L.push('');
      }
    }
    if (events) {
      for (let ev = events[0]; ev < events[1]; ev++) {
        const er = mod.row(T.Event, ev);
        L.push(`${ip}public event ${this.namer.refName(er.EventType.table, er.EventType.index, gctx)} ${ident(mod.str(er.Name))};`);
      }
      if (events[1] > events[0]) L.push('');
    }
    // methods
    for (let mi = ms; mi < me; mi++) {
      if (accessor.has(mi)) continue;
      const row = mod.row(T.MethodDef, mi);
      const mname = mod.str(row.Name);
      const sig = parseSig(mod, row.Signature, 'method');
      const mgctx = { type: gctx.type, method: this.namer.methodGenericParams(mi) };
      for (const a of this.attributes(T.MethodDef, mi, mgctx)) L.push(ip + a);
      const mm = this.methodModifiers(row.Flags, kind === 'interface');
      const gp = mgctx.method.length ? '<' + mgctx.method.join(', ') + '>' : '';
      let decl;
      if (mname === '.cctor') decl = `${ip}static ${name.replace(/<.*>$/, '')}()`;
      else if (mname === '.ctor') decl = `${ip}${mm.replace(/\b(virtual|override|sealed|abstract|new)\b\s*/g, '').trim()} ${name.replace(/<.*>$/, '')}(${this.paramList(mi, sig, mgctx)})`;
      else {
        const op = OP_NAMES[mname];
        const dispName = op ? `operator ${op}` : mname.includes('.') && !mname.startsWith('<') ? mname : ident(mname);
        decl = `${ip}${mm}${mm ? ' ' : ''}${mname === 'op_Implicit' || mname === 'op_Explicit' ? `${mname === 'op_Implicit' ? 'implicit' : 'explicit'} operator ${this.namer.sigName(sig.ret, mgctx)}` : this.namer.sigName(sig.ret, mgctx) + ' ' + dispName}${gp}(${this.paramList(mi, sig, mgctx)})`;
      }
      if (row.Flags & 0x2000) {
        const im = this.implMap(mi);
        if (im) L.push(`${ip}[DllImport(${strLit(im.lib)}${im.entry && im.entry !== mname ? `, EntryPoint = ${strLit(im.entry)}` : ''})]`);
        L.push(decl.replace(/^(\s*)/, '$1') + ';');
        continue;
      }
      if (!row.RVA || kind === 'interface') { L.push(decl + ';'); continue; }
      const body = ctorBodies.get(mi) || this.methodBodyText(mi, ti, inner + 1);
      let text = body.text || [];
      if (mname === '.cctor' && !text.filter((l) => l.trim()).length) continue;
      if (mname === '.ctor') {
        // ": base(...)" call at the start
        const idx = text.findIndex((l) => /^\s*(base|this)\.\.ctor\(|^\s*\.ctor\(/.test(l));
        if (idx >= 0) {
          const call = text[idx].trim().replace(/^base\.\.ctor/, 'base').replace(/^this\.\.ctor/, 'this').replace(/^\.ctor/, 'this').replace(/;$/, '');
          text = text.filter((_, i) => i !== idx);
          if (!/^base\(\)$/.test(call)) decl += ` : ${call}`;
        }
        if (!text.length && !sig.params.length && (row.Flags & 7) === 6) continue; // default ctor
      }
      L.push(decl);
      L.push(`${ip}{`);
      L.push(...text);
      L.push(`${ip}}`);
      L.push('');
    }
    // nested types
    for (const nt of this.ix.nested.get(ti) || []) {
      if (this.consumed(nt)) continue;
      L.push(this.writeType(nt, inner));
      L.push('');
    }
    while (L.length && L[L.length - 1] === '') L.pop();
    L.push(`${pad}}`);
    return L.join('\n');
  }

  eventNamed(events, name) {
    for (let ev = events[0]; ev < events[1]; ev++) if (this.mod.str(this.mod.row(T.Event, ev).Name) === name) return true;
    return false;
  }

  implMap(mi) {
    for (let i = 1; i <= this.mod.count(T.ImplMap); i++) {
      const im = this.mod.row(T.ImplMap, i);
      if (im.MemberForwarded.table === T.MethodDef && im.MemberForwarded.index === mi) {
        const mr = this.mod.row(T.ModuleRef, im.ImportScope);
        return { lib: mr ? this.mod.str(mr.Name) : '?', entry: this.mod.str(im.ImportName) };
      }
    }
    return null;
  }

  methodModifiers(flags, inInterface) {
    if (inInterface) return '';
    const acc = ['', 'private', 'private protected', 'internal', 'protected', 'protected internal', 'public'][flags & 7];
    const m = [acc];
    if (flags & 0x10) m.push('static');
    if (flags & 0x2000) m.push('extern');
    if (flags & 0x400) m.push('abstract');
    else if (flags & 0x40) {
      const newSlot = flags & 0x100;
      if (flags & 0x20) { if (!newSlot) m.push('sealed override'); }
      else m.push(newSlot ? 'virtual' : 'override');
    }
    return m.filter(Boolean).join(' ');
  }

  paramList(mi, sig, gctx) {
    const mod = this.mod;
    const [ps, pe] = mod.listRange(T.MethodDef, mi, 'ParamList', T.Param);
    const prow = [];
    for (let p = ps; p < pe; p++) { const pr = mod.row(T.Param, p); if (pr.Sequence > 0) prow[pr.Sequence - 1] = { pr, idx: p }; }
    return sig.params.map((t, i) => {
      const info = prow[i];
      let tn = this.namer.sigName(t, gctx);
      if (t.k === 'byref') tn = (info && (info.pr.Flags & 3) === 2 ? 'out ' : info && (info.pr.Flags & 1) && !(info.pr.Flags & 2) ? 'in ' : 'ref ') + this.namer.sigName(t.t, gctx);
      const name = info ? ident(mod.str(info.pr.Name)) : 'p' + i;
      let def = '';
      if (info && (info.pr.Flags & 0x1000)) { const c = this.ix.constants.get(T.Param * 16777216 + info.idx); if (c) def = ' = ' + this.constText(c); }
      const attrs = info ? (this.ix.attrs.get(T.Param * 16777216 + info.idx) || []) : [];
      const isParams = attrs.some((ca) => { try { return /ParamArray/.test(this.resolver.method((ca.Type.table << 24) | ca.Type.index).owner); } catch { return false; } });
      return `${isParams ? 'params ' : ''}${tn} ${name}${def}`;
    }).join(', ');
  }

  // A whole top-level type with namespace + usings, as a file.
  typeFile(ti, header = '') {
    const td = this.mod.row(T.TypeDef, ti);
    const ns = this.mod.str(td.Namespace);
    const body = this.writeType(ti, ns ? 1 : 0);
    const usings = this.usingsFor(body, ns);
    return `${header}${usings.map((u) => `using ${u};`).join('\n')}${usings.length ? '\n\n' : ''}${ns ? `namespace ${ns}\n{\n${body}\n}\n` : body + '\n'}`;
  }

  usingsFor(text, ownNs) {
    if (!this._nsByName) {
      this._nsByName = new Map();
      for (let i = 1; i <= this.mod.count(T.TypeRef); i++) {
        const tr = this.mod.row(T.TypeRef, i);
        const ns = this.mod.str(tr.Namespace);
        if (!ns || tr.ResolutionScope.table === T.TypeRef) continue;
        const n = this.mod.str(tr.Name).replace(/`\d+$/, '');
        if (KEYWORDS[ns + '.' + this.mod.str(tr.Name)]) continue;
        if (!this._nsByName.has(n)) this._nsByName.set(n, new Set());
        this._nsByName.get(n).add(ns);
      }
      for (let i = 1; i <= this.mod.count(T.TypeDef); i++) {
        const td = this.mod.row(T.TypeDef, i);
        const ns = this.mod.str(td.Namespace);
        if (!ns || this.ix.enclosing.has(i)) continue;
        const n = this.mod.str(td.Name).replace(/`\d+$/, '');
        if (!this._nsByName.has(n)) this._nsByName.set(n, new Set());
        this._nsByName.get(n).add(ns);
      }
    }
    const out = new Set();
    const words = new Set(text.match(/\b[A-Z][A-Za-z0-9_]*\b/g) || []);
    for (const w of words) {
      const nss = this._nsByName.get(w);
      if (nss) for (const ns of nss) if (ns !== ownNs) out.add(ns);
    }
    return [...out].sort((a, b) => (a.startsWith('System') === b.startsWith('System') ? a.localeCompare(b) : a.startsWith('System') ? -1 : 1));
  }

  // IL for a whole type (for the IL tab)
  typeIL(ti) {
    const mod = this.mod;
    const L = [`// IL for ${this.namer.typeDefName(ti, { ns: true })}`, ''];
    const visit = (t) => {
      const [ms, me] = mod.listRange(T.TypeDef, t, 'MethodList', T.MethodDef);
      for (let mi = ms; mi < me; mi++) {
        const row = mod.row(T.MethodDef, mi);
        const sig = parseSig(mod, row.Signature, 'method');
        L.push(`.method ${this.namer.sigName(sig.ret)} ${this.namer.typeDefName(t)}::${mod.str(row.Name)}(${sig.params.map((p) => this.namer.sigName(p)).join(', ')})`);
        L.push('{');
        L.push(...this.methodIL(mi).split('\n').map((x) => '  ' + x));
        L.push('}', '');
      }
      for (const nt of this.ix.nested.get(t) || []) visit(nt);
    };
    visit(ti);
    return L.join('\n');
  }
}

const OPS = { op_Addition: '+', op_Subtraction: '-', op_Multiply: '*', op_Division: '/', op_Modulus: '%', op_BitwiseAnd: '&', op_BitwiseOr: '|', op_ExclusiveOr: '^', op_LeftShift: '<<', op_RightShift: '>>', op_Equality: '==', op_Inequality: '!=', op_LessThan: '<', op_GreaterThan: '>', op_LessThanOrEqual: '<=', op_GreaterThanOrEqual: '>=' };
const UOPS = { op_UnaryNegation: '-', op_LogicalNot: '!', op_OnesComplement: '~', op_UnaryPlus: '+' };
const OP_NAMES = { ...OPS, ...UOPS, op_Increment: '++', op_Decrement: '--', op_True: 'true', op_False: 'false' };

function splitArray(t) {
  const m = /^(.*?)((\[,*\])*)$/.exec(t);
  return [m[1], m[2] || ''];
}

function flowEnds(list) { const l = list[list.length - 1]; return l && (l.k === 'ret' || l.k === 'throw' || l.k === 'break' || l.k === 'continue' || l.k === 'goto'); }

function mentions(e, pred) {
  if (!e || typeof e !== 'object') return false;
  if (e.k && pred(e)) return true;
  for (const k in e) { const v = e[k]; if (v && typeof v === 'object' && k !== 'm' && k !== 'f' && k !== 'sig') { if (Array.isArray(v) ? v.some((x) => mentions(x, pred)) : v.k && mentions(v, pred)) return true; } }
  return false;
}

function refsLocal(e, i) {
  if (!e || typeof e !== 'object') return false;
  if (e.k === 'local' && e.i === i) return true;
  for (const k in e) { const v = e[k]; if (v && typeof v === 'object' && k !== 'm' && k !== 'f' && k !== 'sig' && (Array.isArray(v) ? v.some((x) => refsLocal(x, i)) : v.k && refsLocal(v, i))) return true; }
  return false;
}
function collectLocals(s, add, except) {
  const visit = (e) => {
    if (!e || typeof e !== 'object') return;
    if (e.k === 'local' && e.i !== except) add(e.i);
    for (const k in e) { const v = e[k]; if (v && typeof v === 'object' && k !== 'm' && k !== 'f' && k !== 'sig') { if (Array.isArray(v)) v.forEach(visit); else visit(v); } }
  };
  visit(s);
}

const NAME_HINTS = { int: 'num', uint: 'num', long: 'num', ulong: 'num', short: 'num', ushort: 'num', byte: 'b', sbyte: 'b', float: 'num', double: 'num', decimal: 'num', bool: 'flag', string: 'text', char: 'c', object: 'obj', IntPtr: 'ptr' };
function suggestName(type) {
  if (!type) return 'v';
  type = type.replace(/^ref /, '');
  if (NAME_HINTS[type]) return NAME_HINTS[type];
  if (type.endsWith('[]')) return 'array';
  if (type.endsWith('?')) return suggestName(type.slice(0, -1));
  let base = type.replace(/<.*$/, '').split('.').pop();
  if (/^I[A-Z]/.test(base) && base.length > 2) base = base.slice(1);
  if (/Exception$/.test(base)) return 'ex';
  if (!/^[A-Za-z_]/.test(base)) return 'v';
  const s = base[0].toLowerCase() + base.slice(1);
  return ident(s) === s ? s : s + '_';
}
