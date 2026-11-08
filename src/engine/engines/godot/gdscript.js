// Compiled GDScript (.gdc) back to source.
//   Godot 3.x  bytecode 10-13: identifier and constant tables plus a token stream whose
//              NEWLINE tokens carry the indentation.
//   Godot 4.3+ binary tokens 100/101 (optionally zstd-compressed); indentation comes from
//              the column recorded for the first token of each line.
// Comments are not stored in compiled scripts; line numbers are kept by inserting blank lines.
import { Reader, utf8 } from '../../util/binary.js';
import { zstd } from '../../util/compress.js';
import { readMarshal, gdLiteral } from './variant.js';
import { TOKENS_30, TOKENS_31, FUNCS_30, FUNCS_31, FUNCS_32, TOKENS_4, TOKENS_45 } from './gdtables.js';

const TYPES_3 = ['null', 'bool', 'int', 'float', 'String', 'Vector2', 'Rect2', 'Vector3', 'Transform2D', 'Plane', 'Quat', 'AABB', 'Basis', 'Transform',
  'Color', 'NodePath', 'RID', 'Object', 'Dictionary', 'Array', 'PoolByteArray', 'PoolIntArray', 'PoolRealArray', 'PoolStringArray', 'PoolVector2Array',
  'PoolVector3Array', 'PoolColorArray'];

const SYMBOL = {
  // Godot 3 names
  OP_IN: 'in', OP_EQUAL: '==', OP_NOT_EQUAL: '!=', OP_LESS: '<', OP_LESS_EQUAL: '<=', OP_GREATER: '>', OP_GREATER_EQUAL: '>=', OP_AND: 'and', OP_OR: 'or',
  OP_NOT: 'not', OP_ADD: '+', OP_SUB: '-', OP_MUL: '*', OP_DIV: '/', OP_MOD: '%', OP_SHIFT_LEFT: '<<', OP_SHIFT_RIGHT: '>>', OP_ASSIGN: '=',
  OP_ASSIGN_ADD: '+=', OP_ASSIGN_SUB: '-=', OP_ASSIGN_MUL: '*=', OP_ASSIGN_DIV: '/=', OP_ASSIGN_MOD: '%=', OP_ASSIGN_SHIFT_LEFT: '<<=',
  OP_ASSIGN_SHIFT_RIGHT: '>>=', OP_ASSIGN_BIT_AND: '&=', OP_ASSIGN_BIT_OR: '|=', OP_ASSIGN_BIT_XOR: '^=', OP_BIT_AND: '&', OP_BIT_OR: '|',
  OP_BIT_XOR: '^', OP_BIT_INVERT: '~', CF_IF: 'if', CF_ELIF: 'elif', CF_ELSE: 'else', CF_FOR: 'for', CF_DO: 'do', CF_WHILE: 'while', CF_SWITCH: 'switch',
  CF_CASE: 'case', CF_BREAK: 'break', CF_CONTINUE: 'continue', CF_PASS: 'pass', CF_RETURN: 'return', CF_MATCH: 'match', PR_FUNCTION: 'func',
  PR_CLASS: 'class', PR_CLASS_NAME: 'class_name', PR_EXTENDS: 'extends', PR_IS: 'is', PR_ONREADY: 'onready', PR_TOOL: 'tool', PR_STATIC: 'static',
  PR_EXPORT: 'export', PR_SETGET: 'setget', PR_CONST: 'const', PR_VAR: 'var', PR_AS: 'as', PR_VOID: 'void', PR_ENUM: 'enum', PR_PRELOAD: 'preload',
  PR_ASSERT: 'assert', PR_YIELD: 'yield', PR_SIGNAL: 'signal', PR_BREAKPOINT: 'breakpoint', PR_REMOTE: 'remote', PR_SYNC: 'sync', PR_MASTER: 'master',
  PR_SLAVE: 'slave', PR_PUPPET: 'puppet', PR_REMOTESYNC: 'remotesync', PR_MASTERSYNC: 'mastersync', PR_PUPPETSYNC: 'puppetsync',
  BRACKET_OPEN: '[', BRACKET_CLOSE: ']', CURLY_BRACKET_OPEN: '{', CURLY_BRACKET_CLOSE: '}', PARENTHESIS_OPEN: '(', PARENTHESIS_CLOSE: ')',
  COMMA: ',', SEMICOLON: ';', PERIOD: '.', QUESTION_MARK: '?', COLON: ':', DOLLAR: '$', FORWARD_ARROW: '->', CONST_PI: 'PI', CONST_TAU: 'TAU',
  WILDCARD: '_', CONST_INF: 'INF', CONST_NAN: 'NAN', SELF: 'self',
  // Godot 4 names
  LESS: '<', LESS_EQUAL: '<=', GREATER: '>', GREATER_EQUAL: '>=', EQUAL_EQUAL: '==', BANG_EQUAL: '!=', AND: 'and', OR: 'or', NOT: 'not',
  AMPERSAND_AMPERSAND: '&&', PIPE_PIPE: '||', BANG: '!', AMPERSAND: '&', PIPE: '|', TILDE: '~', CARET: '^', LESS_LESS: '<<', GREATER_GREATER: '>>',
  PLUS: '+', MINUS: '-', STAR: '*', STAR_STAR: '**', SLASH: '/', PERCENT: '%', EQUAL: '=', PLUS_EQUAL: '+=', MINUS_EQUAL: '-=', STAR_EQUAL: '*=',
  STAR_STAR_EQUAL: '**=', SLASH_EQUAL: '/=', PERCENT_EQUAL: '%=', LESS_LESS_EQUAL: '<<=', GREATER_GREATER_EQUAL: '>>=', AMPERSAND_EQUAL: '&=',
  PIPE_EQUAL: '|=', CARET_EQUAL: '^=', IF: 'if', ELIF: 'elif', ELSE: 'else', FOR: 'for', WHILE: 'while', BREAK: 'break', CONTINUE: 'continue',
  PASS: 'pass', RETURN: 'return', MATCH: 'match', WHEN: 'when', AS: 'as', ASSERT: 'assert', AWAIT: 'await', BREAKPOINT: 'breakpoint', CLASS: 'class',
  CLASS_NAME: 'class_name', CONST: 'const', ENUM: 'enum', EXTENDS: 'extends', FUNC: 'func', IN: 'in', IS: 'is', NAMESPACE: 'namespace',
  PRELOAD: 'preload', SIGNAL: 'signal', STATIC: 'static', SUPER: 'super', TRAIT: 'trait', VAR: 'var', VOID: 'void', YIELD: 'yield',
  BRACE_OPEN: '{', BRACE_CLOSE: '}', PERIOD_PERIOD: '..', PERIOD_PERIOD_PERIOD: '...', UNDERSCORE: '_', BACKTICK: '`',
};

const BINARY = new Set(['==', '!=', '<', '<=', '>', '>=', 'and', 'or', '&&', '||', '+', '-', '*', '**', '/', '%', '<<', '>>', '&', '|', '^', '=', '+=', '-=',
  '*=', '**=', '/=', '%=', '<<=', '>>=', '&=', '|=', '^=', 'in', 'is', 'as', '->', 'when']);
const KEYWORD = new Set(['if', 'elif', 'else', 'for', 'while', 'match', 'return', 'var', 'const', 'func', 'class', 'class_name', 'extends', 'signal',
  'enum', 'static', 'await', 'not', 'onready', 'export', 'setget', 'tool', 'remote', 'sync', 'master', 'slave', 'puppet', 'remotesync', 'mastersync',
  'puppetsync', 'yield', 'do', 'switch', 'case', 'namespace', 'trait']);
const CALLABLE_WORD = new Set(['preload', 'assert', 'yield', 'super', 'self', 'func', 'export']);

// Join one line of tokens with GDScript-style spacing.
function joinLine(toks) {
  let out = '';
  let prev = null;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    let s = t.text;
    let space = prev != null;
    const p = prev && prev.text;
    if (prev) {
      if (s === ':' && toks[i + 1] && toks[i + 1].text === '=') space = true; // x := 1
      else if (s === ',' || s === ';' || s === ')' || s === ']' || s === '}' || s === ':' || s === '.') space = false;
      else if (s === '=' && p === ':') space = false;
      else if (p === '(' || p === '[' || p === '{' || p === '.' || p === '$' || p === '!' || p === '~' || prev.unary || p === '@' || p === '^' && prev.np || p === '&' && prev.sn) space = false;
      else if (s === '(' || s === '[') space = !(prev.word && !KEYWORD.has(p) || p === ')' || p === ']' || p === '}' || CALLABLE_WORD.has(p) || prev.annotation);
      else if (s === '$' && (p === '(' || p === '[')) space = false;
    }
    // unary minus / plus
    if ((s === '-' || s === '+') && (!prev || (BINARY.has(p) && !prev.word) || p === '(' || p === '[' || p === '{' || p === ',' || p === ':' || KEYWORD.has(p) || p === 'return')) t.unary = true;
    out += (space ? ' ' : '') + s;
    prev = t;
  }
  return out;
}

function tok(text, extra) { return { text, ...extra }; }

// ---------------- Godot 3.x ----------------
function decompile3(u8, { minor = null } = {}) {
  const r = new Reader(u8, true);
  r.skip(4);
  const version = r.u32();
  const nId = r.u32(), nConst = r.u32(), nLines = r.u32(), nTokens = r.u32();
  const ids = [];
  for (let i = 0; i < nId; i++) {
    const len = r.u32();
    const b = r.bytes(len).map((x) => x ^ 0xb6);
    let end = b.length;
    while (end > 0 && b[end - 1] === 0) end--;
    ids.push(utf8(b.subarray(0, end)));
  }
  const consts = [];
  for (let i = 0; i < nConst; i++) consts.push(readMarshal(r, 3));
  const lines = new Map();
  for (let i = 0; i < nLines; i++) { const t = r.u32(); lines.set(t, r.u32()); }
  const tokens = new Uint32Array(nTokens);
  for (let i = 0; i < nTokens; i++) tokens[i] = r.u8[r.pos] & 0x80 ? r.u32() & ~0x80 : r.u8_();
  const names = version <= 12 ? TOKENS_30 : TOKENS_31;
  // builtin functions: 3.0 / 3.1 / 3.2+ tables differ
  let funcs = version <= 12 ? FUNCS_30 : minor === 1 ? FUNCS_31 : FUNCS_32;
  if (version >= 13 && minor == null) {
    let maxF = 0;
    for (const t of tokens) if (names[t & 0xff] === 'BUILT_IN_FUNC') maxF = Math.max(maxF, t >> 8);
    funcs = maxF >= FUNCS_31.length ? FUNCS_32 : FUNCS_32;
  }
  // indentation: tabs, unless every indent is a multiple of a space width
  const indents = [];
  for (const t of tokens) if (names[t & 0xff] === 'NEWLINE') indents.push(t >> 8);
  const nz = indents.filter((x) => x > 0);
  const gcd = (a, b) => (b ? gcd(b, a % b) : a);
  const unit = nz.length ? nz.reduce(gcd) : 1;
  const pad = (n) => (unit > 1 ? ' '.repeat(n) : '\t'.repeat(n));
  const out = [];
  let line = [], lineNo = 1, curIndent = 0, depth = 0;
  const lineOf = (i) => { const v = lines.get(i); return v == null ? null : v & 0xffffff; };
  const flush = () => {
    if (!line.length) return;
    out.push(pad(curIndent) + joinLine(line));
    line = [];
  };
  for (let i = 0; i < nTokens; i++) {
    const t = tokens[i], name = names[t & 0xff], arg = t >> 8;
    if (name === 'NEWLINE') {
      if (depth > 0) continue; // a line break inside brackets
      flush();
      curIndent = arg;
      // keep source line numbers: the next token's line
      const ln = lineOf(i + 1);
      if (ln != null) { while (out.length + 1 < ln) out.push(''); lineNo = ln; }
      continue;
    }
    if (name === 'EOF') break;
    let item;
    switch (name) {
      case 'IDENTIFIER': item = tok(ids[arg] ?? '?', { word: true }); break;
      case 'CONSTANT': item = tok(gdLiteral(consts[arg], 3), { word: true }); break;
      case 'BUILT_IN_TYPE': item = tok(TYPES_3[arg] || 'Variant', { word: true }); break;
      case 'BUILT_IN_FUNC': item = tok(funcs[arg] || `builtin_${arg}`, { word: true }); break;
      case 'EMPTY': case 'ERROR': case 'CURSOR': continue;
      default: {
        const s = SYMBOL[name];
        if (s == null) continue;
        item = tok(s, { word: /^[A-Za-z_]/.test(s) });
      }
    }
    if (item.text === '(' || item.text === '[' || item.text === '{') depth++;
    if (item.text === ')' || item.text === ']' || item.text === '}') depth = Math.max(0, depth - 1);
    line.push(item);
  }
  flush();
  void lineNo;
  return { text: out.join('\n').replace(/\s+$/, '') + '\n', version };
}

// ---------------- Godot 4.3+ ----------------
function decompile4(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const version = dv.getUint32(4, true);
  const size = dv.getUint32(8, true);
  const body = size ? zstd(u8.subarray(12)).subarray(0, size) : u8.subarray(12);
  const r = new Reader(body, true);
  const nId = r.u32(), nConst = r.u32(), nLines = r.u32();
  if (version < 101) r.u32();
  const nTokens = r.u32();
  const ids = [];
  for (let i = 0; i < nId; i++) {
    const len = r.u32();
    const b = r.bytes(len * 4);
    let s = '';
    for (let j = 0; j < len; j++) {
      const c = ((b[j * 4] ^ 0xb6) | ((b[j * 4 + 1] ^ 0xb6) << 8) | ((b[j * 4 + 2] ^ 0xb6) << 16) | ((b[j * 4 + 3] ^ 0xb6) << 24)) >>> 0;
      s += String.fromCodePoint(c);
    }
    ids.push(s);
  }
  const consts = [];
  for (let i = 0; i < nConst; i++) consts.push(readMarshal(r, 4));
  const lineAt = new Map(), colAt = new Map();
  for (let i = 0; i < nLines; i++) { const t = r.u32(); lineAt.set(t, r.u32()); }
  for (let i = 0; i < nLines; i++) { const t = r.u32(); colAt.set(t, r.u32()); }
  const names = version >= 101 ? TOKENS_45 : TOKENS_4;
  const toks = [];
  for (let i = 0; i < nTokens; i++) {
    let type;
    if (r.u8[r.pos] & 0x80) { type = r.u32(); } else { type = r.u8_(); }
    r.u32(); // line
    toks.push(type);
  }
  const out = [];
  let line = [], lineIndent = 0, depth = 0;
  const stack = [1]; // block columns
  const flush = () => { if (line.length) out.push('\t'.repeat(lineIndent) + joinLine(line)); line = []; };
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const name = names[t & 0x7f];
    const arg = t >>> 8;
    if (lineAt.has(i)) {
      flush();
      const ln = lineAt.get(i), col = colAt.get(i) || 1;
      while (out.length + 1 < ln) out.push('');
      if (depth > 0) lineIndent = stack.length; // inside brackets: one level deeper than the statement
      else {
        while (stack.length > 1 && col < stack[stack.length - 1]) stack.pop();
        if (col > stack[stack.length - 1]) stack.push(col);
        lineIndent = stack.length - 1;
      }
    }
    if (name === 'TK_EOF') break;
    let item;
    switch (name) {
      case 'IDENTIFIER': item = tok(ids[arg] ?? '?', { word: true }); break;
      case 'ANNOTATION': item = tok(ids[arg] ?? '@?', { word: true, annotation: true }); break;
      case 'LITERAL': {
        const v = consts[arg];
        item = tok(gdLiteral(v, 4), { word: true });
        break;
      }
      case 'EMPTY': case 'ERROR': case 'NEWLINE': case 'INDENT': case 'DEDENT': case 'VCS_CONFLICT_MARKER': continue;
      case 'CONST_PI': item = tok('PI', { word: true }); break;
      case 'CONST_TAU': item = tok('TAU', { word: true }); break;
      case 'CONST_INF': item = tok('INF', { word: true }); break;
      case 'CONST_NAN': item = tok('NAN', { word: true }); break;
      case 'SELF': item = tok('self', { word: true }); break;
      default: {
        const s = SYMBOL[name];
        if (s == null) continue;
        item = tok(s, { word: /^[A-Za-z_]/.test(s) });
      }
    }
    if (item.text === '(' || item.text === '[' || item.text === '{') depth++;
    if (item.text === ')' || item.text === ']' || item.text === '}') depth = Math.max(0, depth - 1);
    line.push(item);
  }
  flush();
  return { text: out.join('\n').replace(/\s+$/, '') + '\n', version };
}

export function isCompiledGDScript(u8) {
  return u8.length > 12 && u8[0] === 0x47 && u8[1] === 0x44 && u8[2] === 0x53 && u8[3] === 0x43;
}

// opts.minor: engine minor version if known (picks the Godot 3 builtin-function table)
export function decompileGDScript(u8, opts = {}) {
  if (!isCompiledGDScript(u8)) throw new Error('not a compiled GDScript file');
  const version = new DataView(u8.buffer, u8.byteOffset, 8).getUint32(4, true);
  if (version >= 100) return decompile4(u8);
  if (version >= 10 && version <= 13) return decompile3(u8, opts);
  throw new Error(`unsupported GDScript bytecode version ${version}`);
}
