// More game archive formats: Ren'Py .rpa (zlib pickle index) and Electron .asar.
import { unzlib } from '../util/compress.js';
import { utf8, latin1 } from '../util/binary.js';

// ---------------- a small Python unpickler (protocols 0-5, the opcodes indexes use) ----------------
export function unpickle(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = 0;
  const stack = [], marks = [], memo = new Map();
  const MARK = Symbol('mark');
  const pop = () => stack.pop();
  const popMark = () => { const m = marks.pop(); return stack.splice(m); };
  const line = () => { let e = p; while (u8[e] !== 10) e++; const s = latin1(u8.subarray(p, e)); p = e + 1; return s; };
  const toInt = (bytes) => { let v = 0n; for (let i = bytes.length - 1; i >= 0; i--) v = (v << 8n) | BigInt(bytes[i]); if (bytes.length && bytes[bytes.length - 1] & 0x80) v -= 1n << BigInt(bytes.length * 8); return Number(v); };
  for (let guard = 0; guard < 1e8; guard++) {
    const op = u8[p++];
    switch (op) {
      case 0x80: p++; break; // PROTO
      case 0x95: p += 8; break; // FRAME
      case 0x2e: return pop(); // STOP
      case 0x28: marks.push(stack.length); break; // MARK
      case 0x7d: stack.push(new Map()); break; // EMPTY_DICT
      case 0x5d: stack.push([]); break; // EMPTY_LIST
      case 0x29: stack.push([]); break; // EMPTY_TUPLE
      case 0x4e: stack.push(null); break; // NONE
      case 0x88: stack.push(true); break;
      case 0x89: stack.push(false); break;
      case 0x4a: stack.push(dv.getInt32(p, true)); p += 4; break; // BININT
      case 0x4b: stack.push(u8[p++]); break; // BININT1
      case 0x4d: stack.push(dv.getUint16(p, true)); p += 2; break; // BININT2
      case 0x8a: { const n = u8[p++]; stack.push(toInt(u8.subarray(p, p + n))); p += n; break; } // LONG1
      case 0x8b: { const n = dv.getInt32(p, true); p += 4; stack.push(toInt(u8.subarray(p, p + n))); p += n; break; } // LONG4
      case 0x47: stack.push(dv.getFloat64(p, false)); p += 8; break; // BINFLOAT
      case 0x49: { const s = line(); stack.push(s === '01' ? true : s === '00' ? false : parseInt(s, 10)); break; } // INT
      case 0x4c: stack.push(parseInt(line(), 10)); break; // LONG
      case 0x58: { const n = dv.getUint32(p, true); p += 4; stack.push(utf8(u8.subarray(p, p + n))); p += n; break; } // BINUNICODE
      case 0x8c: { const n = u8[p++]; stack.push(utf8(u8.subarray(p, p + n))); p += n; break; } // SHORT_BINUNICODE
      case 0x8d: { const n = Number(dv.getBigUint64(p, true)); p += 8; stack.push(utf8(u8.subarray(p, p + n))); p += n; break; } // BINUNICODE8
      case 0x54: { const n = dv.getInt32(p, true); p += 4; stack.push(u8.subarray(p, p + n)); p += n; break; } // BINSTRING
      case 0x55: { const n = u8[p++]; stack.push(u8.subarray(p, p + n)); p += n; break; } // SHORT_BINSTRING
      case 0x42: { const n = dv.getUint32(p, true); p += 4; stack.push(u8.subarray(p, p + n)); p += n; break; } // BINBYTES
      case 0x43: { const n = u8[p++]; stack.push(u8.subarray(p, p + n)); p += n; break; } // SHORT_BINBYTES
      case 0x56: stack.push(line()); break; // UNICODE (raw)
      case 0x53: { const s = line(); stack.push(s.slice(1, -1)); break; } // STRING
      case 0x61: { const v = pop(); stack[stack.length - 1].push(v); break; } // APPEND
      case 0x65: { const items = popMark(); stack[stack.length - 1].push(...items); break; } // APPENDS
      case 0x73: { const v = pop(), k = pop(); stack[stack.length - 1].set(k, v); break; } // SETITEM
      case 0x75: { const items = popMark(); const d = stack[stack.length - 1]; for (let i = 0; i < items.length; i += 2) d.set(items[i], items[i + 1]); break; } // SETITEMS
      case 0x74: stack.push(popMark()); break; // TUPLE
      case 0x85: stack.push([pop()]); break; // TUPLE1
      case 0x86: { const b = pop(), a = pop(); stack.push([a, b]); break; } // TUPLE2
      case 0x87: { const c = pop(), b = pop(), a = pop(); stack.push([a, b, c]); break; } // TUPLE3
      case 0x6c: stack.push(popMark()); break; // LIST
      case 0x64: { const items = popMark(); const d = new Map(); for (let i = 0; i < items.length; i += 2) d.set(items[i], items[i + 1]); stack.push(d); break; } // DICT
      case 0x94: memo.set(memo.size, stack[stack.length - 1]); break; // MEMOIZE
      case 0x71: memo.set(u8[p++], stack[stack.length - 1]); break; // BINPUT
      case 0x72: memo.set(dv.getUint32(p, true), stack[stack.length - 1]); p += 4; break; // LONG_BINPUT
      case 0x70: memo.set(parseInt(line(), 10), stack[stack.length - 1]); break; // PUT
      case 0x68: stack.push(memo.get(u8[p++])); break; // BINGET
      case 0x6a: stack.push(memo.get(dv.getUint32(p, true))); p += 4; break; // LONG_BINGET
      case 0x67: stack.push(memo.get(parseInt(line(), 10))); break; // GET
      case 0x63: { const mod = line(), name = line(); stack.push({ global: mod + '.' + name }); break; } // GLOBAL
      case 0x93: { const name = pop(), mod = pop(); stack.push({ global: mod + '.' + name }); break; } // STACK_GLOBAL
      case 0x52: { const args = pop(), fn = pop(); stack.push({ reduce: fn, args }); break; } // REDUCE
      case 0x81: { const args = pop(), cls = pop(); stack.push({ obj: cls, args }); break; } // NEWOBJ
      case 0x62: { const state = pop(); const o = stack[stack.length - 1]; if (o && typeof o === 'object') o.state = state; break; } // BUILD
      case 0x30: pop(); break; // POP
      case 0x31: popMark(); break; // POP_MARK
      case 0x32: stack.push(stack[stack.length - 1]); break; // DUP
      default: throw new Error(`unsupported pickle opcode 0x${op.toString(16)} at ${p - 1}`);
    }
    void MARK;
  }
  throw new Error('pickle did not end');
}

// ---------------- Ren'Py RPA ----------------
async function readRpa(blob) {
  const head = latin1(new Uint8Array(await blob.slice(0, 64).arrayBuffer()));
  const m = /^RPA-(\d\.\d) ([0-9a-fA-F]+)(?: ([0-9a-fA-F]+))?/.exec(head);
  if (!m) throw new Error("not a Ren'Py archive");
  const version = m[1];
  const offset = parseInt(m[2], 16);
  let key = 0;
  if (version !== '2.0' && m[3]) key = parseInt(m[3], 16) >>> 0;
  const index = unpickle(unzlib(new Uint8Array(await blob.slice(offset).arrayBuffer())));
  const files = [];
  const x = (v) => (key ? Number(BigInt.asUintN(64, BigInt(v) ^ BigInt(key))) : v);
  for (const [name, parts] of index) {
    const part = parts[0];
    let pre = part[2];
    // Python 2 pickles store bytes as _codecs.encode(text, 'latin1')
    if (pre && pre.reduce) pre = Uint8Array.from(pre.args && typeof pre.args[0] === 'string' ? pre.args[0] : '', (c) => c.charCodeAt(0) & 0xff);
    const prefix = pre && pre.length ? (typeof pre === 'string' ? Uint8Array.from(pre, (c) => c.charCodeAt(0) & 0xff) : pre) : null;
    files.push({ name: typeof name === 'string' ? name : utf8(name), offset: x(part[0]), size: x(part[1]), prefix });
  }
  return { version, files };
}

// ---------------- Electron asar ----------------
async function readAsar(blob) {
  const h = new DataView(await blob.slice(0, 16).arrayBuffer());
  const headerSize = h.getUint32(4, true);
  const jsonLen = h.getUint32(12, true);
  const json = JSON.parse(utf8(new Uint8Array(await blob.slice(16, 16 + jsonLen).arrayBuffer())));
  const base = 8 + headerSize;
  const files = [];
  const walk = (node, dir) => {
    for (const [name, v] of Object.entries(node.files || {})) {
      if (v.files) walk(v, dir + name + '/');
      else if (!v.unpacked && v.offset != null) files.push({ name: dir + name, offset: base + Number(v.offset), size: v.size });
    }
  };
  walk(json, '');
  return files;
}

export const rpa = {
  id: 'rpa',
  kinds: ['rpa'],
  async expand(ctx, e) {
    const blob = await ctx.vfs.blob(e);
    const { version, files } = await readRpa(blob);
    for (const f of files) {
      const slice = blob.slice(f.offset, f.offset + f.size);
      ctx.extract(`${e.path}/${f.name}`, f.prefix ? new Blob([f.prefix, slice]) : slice, { source: e.path });
    }
    e.meta = { ...(e.meta || {}), archive: `Ren'Py RPA-${version}`, entries: files.length };
  },
};

export const asar = {
  id: 'asar',
  kinds: ['asar'],
  async expand(ctx, e) {
    const blob = await ctx.vfs.blob(e);
    const files = await readAsar(blob);
    for (const f of files) ctx.extract(`${e.path}/${f.name}`, blob.slice(f.offset, f.offset + f.size), { source: e.path });
    e.meta = { ...(e.meta || {}), archive: 'Electron asar', entries: files.length };
  },
};

// ---------------- tar (ustar, GNU long names, pax paths) ----------------
function octal(u8, off, len) {
  let s = '';
  for (let i = off; i < off + len && u8[i]; i++) s += String.fromCharCode(u8[i]);
  s = s.trim();
  return s ? parseInt(s, 8) : 0;
}
const cstrAt = (u8, off, len) => { let e = off; while (e < off + len && u8[e]) e++; return utf8(u8.subarray(off, e)); };

async function readTar(blob) {
  const files = [];
  let pos = 0, longName = null, paxPath = null;
  while (pos + 512 <= blob.size) {
    const h = new Uint8Array(await blob.slice(pos, pos + 512).arrayBuffer());
    if (h.every((b) => b === 0)) break;
    const size = octal(h, 124, 12), type = String.fromCharCode(h[156] || 48);
    const data = pos + 512;
    let name = cstrAt(h, 0, 100);
    if (latin1(h.subarray(257, 262)) === 'ustar') { const prefix = cstrAt(h, 345, 155); if (prefix) name = prefix + '/' + name; }
    if (type === 'L') longName = cstrAt(new Uint8Array(await blob.slice(data, data + size).arrayBuffer()), 0, size);
    else if (type === 'x') {
      const text = utf8(new Uint8Array(await blob.slice(data, data + size).arrayBuffer()));
      const m = /\d+ path=([^\n]*)\n/.exec(text);
      if (m) paxPath = m[1];
    } else {
      if (type === '0' || type === '\0' || type === '7') files.push({ name: paxPath || longName || name, offset: data, size });
      longName = null; paxPath = null;
    }
    pos = data + Math.ceil(size / 512) * 512;
  }
  return files;
}

export const tar = {
  id: 'tar',
  kinds: ['tar'],
  async expand(ctx, e) {
    const blob = await ctx.vfs.blob(e);
    const files = await readTar(blob);
    for (const f of files) {
      const name = f.name.replace(/^\.\//, '').replace(/^\/+/, '');
      if (name) ctx.extract(`${e.path}/${name}`, blob.slice(f.offset, f.offset + f.size), { source: e.path });
    }
    e.meta = { ...(e.meta || {}), archive: 'tar', entries: files.length };
  },
};
