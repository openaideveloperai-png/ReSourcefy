// Type naming for the CIL decompiler: TypeDef/TypeRef/TypeSpec and signature
// nodes rendered as C# with generics, nesting and keyword aliases.
import { T, parseSig } from '../../formats/dotnet.js';

export const KEYWORDS = {
  'System.Void': 'void', 'System.Boolean': 'bool', 'System.Char': 'char', 'System.SByte': 'sbyte', 'System.Byte': 'byte',
  'System.Int16': 'short', 'System.UInt16': 'ushort', 'System.Int32': 'int', 'System.UInt32': 'uint', 'System.Int64': 'long',
  'System.UInt64': 'ulong', 'System.Single': 'float', 'System.Double': 'double', 'System.String': 'string', 'System.Object': 'object',
  'System.Decimal': 'decimal', 'System.IntPtr': 'IntPtr', 'System.UIntPtr': 'UIntPtr',
};

const CS_RESERVED = new Set('abstract as base bool break byte case catch char checked class const continue decimal default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in int interface internal is lock long namespace new null object operator out override params private protected public readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof uint ulong unchecked unsafe ushort using virtual void volatile while'.split(' '));
export function ident(name) {
  if (!name) return '_';
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return CS_RESERVED.has(name) ? '@' + name : name;
  return name; // compiler-generated names like <Start>d__5 stay as-is so they can be matched up
}

export class TypeNamer {
  constructor(mod) {
    this.mod = mod;
    this.cache = new Map();
    this.ix = mod.index();
  }

  // Full (namespace-qualified) name of a TypeDef, with outer types joined by '.'
  typeDefName(i, { ns = false, generic = true } = {}) {
    const m = this.mod, td = m.row(T.TypeDef, i);
    let name = m.str(td.Name);
    const enc = this.ix.enclosing.get(i);
    const gps = this.ix.genericParams.get(T.TypeDef * 16777216 + i);
    let own = gps;
    if (enc) {
      const encGps = this.ix.genericParams.get(T.TypeDef * 16777216 + enc);
      if (gps && encGps) own = gps.slice(encGps.length);
    }
    name = name.replace(/`\d+$/, '');
    if (generic && own && own.length) name += '<' + own.join(', ') + '>';
    if (enc) return this.typeDefName(enc, { ns, generic }) + '.' + name;
    const nsName = m.str(td.Namespace);
    return ns && nsName ? nsName + '.' + name : name;
  }

  typeRefName(i, { ns = false } = {}) {
    const m = this.mod, tr = m.row(T.TypeRef, i);
    let name = m.str(tr.Name).replace(/`\d+$/, '');
    const scope = tr.ResolutionScope;
    if (scope.table === T.TypeRef && scope.index) return this.typeRefName(scope.index, { ns }) + '.' + name;
    const nsName = m.str(tr.Namespace);
    const full = nsName ? nsName + '.' + m.str(tr.Name) : m.str(tr.Name);
    if (KEYWORDS[full]) return KEYWORDS[full];
    return ns && nsName ? nsName + '.' + name : name;
  }

  fullRefName(table, i) {
    const m = this.mod;
    if (table === T.TypeRef) { const tr = m.row(T.TypeRef, i); const nsn = m.str(tr.Namespace); return (nsn ? nsn + '.' : '') + m.str(tr.Name); }
    if (table === T.TypeDef) { const td = m.row(T.TypeDef, i); const nsn = m.str(td.Namespace); return (nsn ? nsn + '.' : '') + m.str(td.Name); }
    return '';
  }

  // token-style reference {table, index}
  refName(table, i, gctx) {
    if (table === T.TypeDef) {
      const full = this.fullRefName(T.TypeDef, i);
      return KEYWORDS[full] || this.typeDefName(i);
    }
    if (table === T.TypeRef) return this.typeRefName(i);
    if (table === T.TypeSpec) return this.sigName(parseSig(this.mod, this.mod.row(T.TypeSpec, i).Signature, 'typespec'), gctx);
    return '?';
  }

  tokenName(tok, gctx) {
    return this.refName(tok >>> 24, tok & 0xffffff, gctx);
  }

  sigName(s, gctx = {}) {
    if (!s) return 'object';
    switch (s.k) {
      case 'prim': return s.name;
      case 'class': case 'valuetype': return this.refName(s.tok, s.idx, gctx);
      case 'szarray': return this.sigName(s.t, gctx) + '[]';
      case 'array': return this.sigName(s.t, gctx) + '[' + ','.repeat(Math.max(0, s.rank - 1)) + ']';
      case 'ptr': return this.sigName(s.t, gctx) + '*';
      case 'byref': return 'ref ' + this.sigName(s.t, gctx);
      case 'pinned': return this.sigName(s.t, gctx);
      case 'var': return (gctx.type && gctx.type[s.n]) || ('T' + (s.n || ''));
      case 'mvar': return (gctx.method && gctx.method[s.n]) || ('M' + s.n);
      case 'fnptr': return 'IntPtr';
      case 'generic': {
        const base = this.sigName(s.base, gctx).replace(/<.*>$/, '');
        const args = s.args.map((a) => this.sigName(a, gctx));
        if ((base === 'Nullable' || base === 'System.Nullable') && args.length === 1) return args[0] + '?';
        return base + '<' + args.join(', ') + '>';
      }
      default: return 'object';
    }
  }

  typeGenericParams(i) { return this.ix.genericParams.get(T.TypeDef * 16777216 + i) || []; }
  methodGenericParams(i) { return this.ix.genericParams.get(T.MethodDef * 16777216 + i) || []; }
}

// Signature node helpers
export function isBoolSig(s) { return s && s.k === 'prim' && s.name === 'bool'; }
export function isCharSig(s) { return s && s.k === 'prim' && s.name === 'char'; }
export function sigPrimName(s) { return s && s.k === 'prim' ? s.name : null; }
