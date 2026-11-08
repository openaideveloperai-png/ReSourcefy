// CIL opcode table, instruction decoder and ildasm-style disassembly.
import { Reader } from '../../util/binary.js';

// operand kinds: '' none, 'i1' i8, 'u1' u8, 'i4', 'i8', 'r4', 'r8', 'br1', 'br4', 'var1', 'var2', 'tok', 'sw'
const ONE = {};
const TWO = {};
const def = (t, code, name, op = '') => { t[code] = { name, op, code: t === TWO ? 0xfe00 | code : code }; };
[[0x00, 'nop'], [0x01, 'break'], [0x02, 'ldarg.0'], [0x03, 'ldarg.1'], [0x04, 'ldarg.2'], [0x05, 'ldarg.3'], [0x06, 'ldloc.0'], [0x07, 'ldloc.1'], [0x08, 'ldloc.2'], [0x09, 'ldloc.3'],
  [0x0a, 'stloc.0'], [0x0b, 'stloc.1'], [0x0c, 'stloc.2'], [0x0d, 'stloc.3'], [0x0e, 'ldarg.s', 'var1'], [0x0f, 'ldarga.s', 'var1'], [0x10, 'starg.s', 'var1'], [0x11, 'ldloc.s', 'var1'], [0x12, 'ldloca.s', 'var1'], [0x13, 'stloc.s', 'var1'],
  [0x14, 'ldnull'], [0x15, 'ldc.i4.m1'], [0x16, 'ldc.i4.0'], [0x17, 'ldc.i4.1'], [0x18, 'ldc.i4.2'], [0x19, 'ldc.i4.3'], [0x1a, 'ldc.i4.4'], [0x1b, 'ldc.i4.5'], [0x1c, 'ldc.i4.6'], [0x1d, 'ldc.i4.7'], [0x1e, 'ldc.i4.8'],
  [0x1f, 'ldc.i4.s', 'i1'], [0x20, 'ldc.i4', 'i4'], [0x21, 'ldc.i8', 'i8'], [0x22, 'ldc.r4', 'r4'], [0x23, 'ldc.r8', 'r8'], [0x25, 'dup'], [0x26, 'pop'], [0x27, 'jmp', 'tok'], [0x28, 'call', 'tok'], [0x29, 'calli', 'tok'], [0x2a, 'ret'],
  [0x2b, 'br.s', 'br1'], [0x2c, 'brfalse.s', 'br1'], [0x2d, 'brtrue.s', 'br1'], [0x2e, 'beq.s', 'br1'], [0x2f, 'bge.s', 'br1'], [0x30, 'bgt.s', 'br1'], [0x31, 'ble.s', 'br1'], [0x32, 'blt.s', 'br1'], [0x33, 'bne.un.s', 'br1'],
  [0x34, 'bge.un.s', 'br1'], [0x35, 'bgt.un.s', 'br1'], [0x36, 'ble.un.s', 'br1'], [0x37, 'blt.un.s', 'br1'], [0x38, 'br', 'br4'], [0x39, 'brfalse', 'br4'], [0x3a, 'brtrue', 'br4'], [0x3b, 'beq', 'br4'], [0x3c, 'bge', 'br4'],
  [0x3d, 'bgt', 'br4'], [0x3e, 'ble', 'br4'], [0x3f, 'blt', 'br4'], [0x40, 'bne.un', 'br4'], [0x41, 'bge.un', 'br4'], [0x42, 'bgt.un', 'br4'], [0x43, 'ble.un', 'br4'], [0x44, 'blt.un', 'br4'], [0x45, 'switch', 'sw'],
  [0x46, 'ldind.i1'], [0x47, 'ldind.u1'], [0x48, 'ldind.i2'], [0x49, 'ldind.u2'], [0x4a, 'ldind.i4'], [0x4b, 'ldind.u4'], [0x4c, 'ldind.i8'], [0x4d, 'ldind.i'], [0x4e, 'ldind.r4'], [0x4f, 'ldind.r8'], [0x50, 'ldind.ref'],
  [0x51, 'stind.ref'], [0x52, 'stind.i1'], [0x53, 'stind.i2'], [0x54, 'stind.i4'], [0x55, 'stind.i8'], [0x56, 'stind.r4'], [0x57, 'stind.r8'], [0x58, 'add'], [0x59, 'sub'], [0x5a, 'mul'], [0x5b, 'div'], [0x5c, 'div.un'],
  [0x5d, 'rem'], [0x5e, 'rem.un'], [0x5f, 'and'], [0x60, 'or'], [0x61, 'xor'], [0x62, 'shl'], [0x63, 'shr'], [0x64, 'shr.un'], [0x65, 'neg'], [0x66, 'not'], [0x67, 'conv.i1'], [0x68, 'conv.i2'], [0x69, 'conv.i4'],
  [0x6a, 'conv.i8'], [0x6b, 'conv.r4'], [0x6c, 'conv.r8'], [0x6d, 'conv.u4'], [0x6e, 'conv.u8'], [0x6f, 'callvirt', 'tok'], [0x70, 'cpobj', 'tok'], [0x71, 'ldobj', 'tok'], [0x72, 'ldstr', 'tok'], [0x73, 'newobj', 'tok'],
  [0x74, 'castclass', 'tok'], [0x75, 'isinst', 'tok'], [0x76, 'conv.r.un'], [0x79, 'unbox', 'tok'], [0x7a, 'throw'], [0x7b, 'ldfld', 'tok'], [0x7c, 'ldflda', 'tok'], [0x7d, 'stfld', 'tok'], [0x7e, 'ldsfld', 'tok'],
  [0x7f, 'ldsflda', 'tok'], [0x80, 'stsfld', 'tok'], [0x81, 'stobj', 'tok'], [0x82, 'conv.ovf.i1.un'], [0x83, 'conv.ovf.i2.un'], [0x84, 'conv.ovf.i4.un'], [0x85, 'conv.ovf.i8.un'], [0x86, 'conv.ovf.u1.un'],
  [0x87, 'conv.ovf.u2.un'], [0x88, 'conv.ovf.u4.un'], [0x89, 'conv.ovf.u8.un'], [0x8a, 'conv.ovf.i.un'], [0x8b, 'conv.ovf.u.un'], [0x8c, 'box', 'tok'], [0x8d, 'newarr', 'tok'], [0x8e, 'ldlen'], [0x8f, 'ldelema', 'tok'],
  [0x90, 'ldelem.i1'], [0x91, 'ldelem.u1'], [0x92, 'ldelem.i2'], [0x93, 'ldelem.u2'], [0x94, 'ldelem.i4'], [0x95, 'ldelem.u4'], [0x96, 'ldelem.i8'], [0x97, 'ldelem.i'], [0x98, 'ldelem.r4'], [0x99, 'ldelem.r8'], [0x9a, 'ldelem.ref'],
  [0x9b, 'stelem.i'], [0x9c, 'stelem.i1'], [0x9d, 'stelem.i2'], [0x9e, 'stelem.i4'], [0x9f, 'stelem.i8'], [0xa0, 'stelem.r4'], [0xa1, 'stelem.r8'], [0xa2, 'stelem.ref'], [0xa3, 'ldelem', 'tok'], [0xa4, 'stelem', 'tok'],
  [0xa5, 'unbox.any', 'tok'], [0xb3, 'conv.ovf.i1'], [0xb4, 'conv.ovf.u1'], [0xb5, 'conv.ovf.i2'], [0xb6, 'conv.ovf.u2'], [0xb7, 'conv.ovf.i4'], [0xb8, 'conv.ovf.u4'], [0xb9, 'conv.ovf.i8'], [0xba, 'conv.ovf.u8'],
  [0xc2, 'refanyval', 'tok'], [0xc3, 'ckfinite'], [0xc6, 'mkrefany', 'tok'], [0xd0, 'ldtoken', 'tok'], [0xd1, 'conv.u2'], [0xd2, 'conv.u1'], [0xd3, 'conv.i'], [0xd4, 'conv.ovf.i'], [0xd5, 'conv.ovf.u'],
  [0xd6, 'add.ovf'], [0xd7, 'add.ovf.un'], [0xd8, 'mul.ovf'], [0xd9, 'mul.ovf.un'], [0xda, 'sub.ovf'], [0xdb, 'sub.ovf.un'], [0xdc, 'endfinally'], [0xdd, 'leave', 'br4'], [0xde, 'leave.s', 'br1'], [0xdf, 'stind.i'], [0xe0, 'conv.u'],
].forEach((x) => def(ONE, ...x));
[[0x00, 'arglist'], [0x01, 'ceq'], [0x02, 'cgt'], [0x03, 'cgt.un'], [0x04, 'clt'], [0x05, 'clt.un'], [0x06, 'ldftn', 'tok'], [0x07, 'ldvirtftn', 'tok'], [0x09, 'ldarg', 'var2'], [0x0a, 'ldarga', 'var2'], [0x0b, 'starg', 'var2'],
  [0x0c, 'ldloc', 'var2'], [0x0d, 'ldloca', 'var2'], [0x0e, 'stloc', 'var2'], [0x0f, 'localloc'], [0x11, 'endfilter'], [0x12, 'unaligned.', 'u1'], [0x13, 'volatile.'], [0x14, 'tail.'], [0x15, 'initobj', 'tok'],
  [0x16, 'constrained.', 'tok'], [0x17, 'cpblk'], [0x18, 'initblk'], [0x19, 'no.', 'u1'], [0x1a, 'rethrow'], [0x1c, 'sizeof', 'tok'], [0x1d, 'refanytype'], [0x1e, 'readonly.'],
].forEach((x) => def(TWO, ...x));

// Decode a method body into instructions: {off, end, name, op, arg}
export function decodeIL(code) {
  const r = new Reader(code);
  const out = [];
  while (r.pos < code.length) {
    const off = r.pos;
    let b = r.u8_();
    let d;
    if (b === 0xfe) { const b2 = r.u8_(); d = TWO[b2]; if (!d) d = { name: `unknown.fe${b2.toString(16)}`, op: '' }; }
    else d = ONE[b] || { name: `unknown.${b.toString(16)}`, op: '' };
    let arg = null;
    switch (d.op) {
      case 'i1': arg = r.i8(); break;
      case 'u1': arg = r.u8_(); break;
      case 'i4': arg = r.i32(); break;
      case 'i8': arg = r.i64big(); break;
      case 'r4': arg = r.f32(); break;
      case 'r8': arg = r.f64(); break;
      case 'var1': arg = r.u8_(); break;
      case 'var2': arg = r.u16(); break;
      case 'tok': arg = r.u32(); break;
      case 'br1': { const rel = r.i8(); arg = r.pos + rel; break; }
      case 'br4': { const rel = r.i32(); arg = r.pos + rel; break; }
      case 'sw': { const n = r.u32(); const rels = r.i32arr(n); arg = rels.map((x) => r.pos + x); break; }
      default: break;
    }
    out.push({ off, end: r.pos, name: d.name, op: d.op, arg });
  }
  return out;
}

const label = (o) => 'IL_' + o.toString(16).padStart(4, '0');

export function disassemble(insns, { tokenText, handlers = [] } = {}) {
  const lines = [];
  const opens = new Map(), closes = new Map();
  for (const h of handlers) {
    (opens.get(h.tryStart) || opens.set(h.tryStart, []).get(h.tryStart)).push('.try {');
    (closes.get(h.tryEnd) || closes.set(h.tryEnd, []).get(h.tryEnd)).push('} // end .try');
    const kind = h.flags === 2 ? 'finally' : h.flags === 4 ? 'fault' : h.flags === 1 ? 'filter' : `catch ${tokenText ? tokenText(h.token) : h.token}`;
    (opens.get(h.hStart) || opens.set(h.hStart, []).get(h.hStart)).push(`${kind} {`);
    (closes.get(h.hEnd) || closes.set(h.hEnd, []).get(h.hEnd)).push('} // end handler');
  }
  let depth = 0;
  for (const ins of insns) {
    for (const c of closes.get(ins.off) || []) { depth--; lines.push('  '.repeat(Math.max(0, depth)) + c); }
    for (const o of opens.get(ins.off) || []) { lines.push('  '.repeat(depth) + o); depth++; }
    let a = '';
    if (ins.op === 'br1' || ins.op === 'br4') a = label(ins.arg);
    else if (ins.op === 'sw') a = '(' + ins.arg.map(label).join(', ') + ')';
    else if (ins.op === 'tok') a = tokenText ? tokenText(ins.arg, ins.name) : '0x' + ins.arg.toString(16);
    else if (ins.arg != null) a = String(ins.arg);
    lines.push(`${'  '.repeat(depth)}${label(ins.off)}: ${ins.name.padEnd(12)} ${a}`.trimEnd());
  }
  return lines.join('\n');
}

export { label as ilLabel };
