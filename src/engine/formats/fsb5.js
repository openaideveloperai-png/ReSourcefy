// FMOD FSB5 sound banks (Unity AudioClip data on most platforms).
// Vorbis samples are rebuilt into Ogg files using setup headers generated
// offline with libvorbis (see tools/gen_vorbis_headers.py); PCM becomes WAV;
// MPEG is already MP3.
import { Reader } from '../util/binary.js';
import { loadData } from '../util/data.js';

const FREQ = { 1: 8000, 2: 11000, 3: 11025, 4: 16000, 5: 22050, 6: 24000, 7: 32000, 8: 44100, 9: 48000 };
export const FSB_CODECS = { 1: 'PCM8', 2: 'PCM16', 3: 'PCM24', 4: 'PCM32', 5: 'PCMFLOAT', 6: 'GCADPCM', 7: 'IMAADPCM', 8: 'VAG', 9: 'HEVAG', 10: 'XMA', 11: 'MPEG', 12: 'CELT', 13: 'AT9', 14: 'XWMA', 15: 'VORBIS', 16: 'FADPCM', 17: 'OPUS' };

export function parseFSB5(u8) {
  const r = new Reader(u8);
  if (r.str(4, 'latin1') !== 'FSB5') throw new Error('not an FSB5 bank');
  const version = r.u32();
  const numSamples = r.u32(), sampleHeadersSize = r.u32(), nameTableSize = r.u32(), dataSize = r.u32(), mode = r.u32();
  r.skip(8 + 16 + 8);
  if (version === 0) r.u32();
  const headerSize = r.pos;
  const samples = [];
  for (let i = 0; i < numSamples; i++) {
    const lo = r.u32(), hi = r.u32();
    let next = lo & 1;
    let freq = (lo >>> 1) & 15;
    const channels = ((lo >>> 5) & 1) + 1;
    const dataOffset = (((lo >>> 6) | ((hi & 0x3) << 26)) >>> 0) * 16;
    const count = hi >>> 2;
    const chunks = {};
    while (next) {
      const raw = r.u32();
      next = raw & 1;
      const size = (raw >>> 1) & 0xffffff;
      const type = raw >>> 25;
      const start = r.pos;
      if (type === 11) chunks.vorbisCrc = r.u32();
      else if (type === 2) chunks.frequency = r.u32();
      else if (type === 1) chunks.channels = r.u8_();
      else if (type === 3) chunks.loop = [r.u32(), r.u32()];
      r.seek(start + size);
    }
    samples.push({ name: String(i).padStart(4, '0'), frequency: chunks.frequency || FREQ[freq] || 44100, channels: chunks.channels || channels, dataOffset, samples: count, chunks });
  }
  if (nameTableSize) {
    const nt = headerSize + sampleHeadersSize;
    for (let i = 0; i < numSamples; i++) {
      const off = new Reader(u8, true, nt + i * 4, 4).u32();
      const rr = new Reader(u8, true, nt + off);
      samples[i].name = rr.cstr(256);
    }
  }
  const dataStart = headerSize + sampleHeadersSize + nameTableSize;
  for (let i = 0; i < numSamples; i++) {
    const s = samples[i];
    const end = i < numSamples - 1 ? samples[i + 1].dataOffset : dataSize;
    s.data = u8.subarray(dataStart + s.dataOffset, dataStart + end);
  }
  return { version, mode, codec: FSB_CODECS[mode] || String(mode), samples };
}

// ---- Vorbis header table ----
let headerTableP = null;
function headerTable() {
  if (!headerTableP) headerTableP = (async () => {
    const r = new Reader(await loadData('fsb-vorbis-headers.bin'));
    if (r.str(4, 'latin1') !== 'RSVH') throw new Error('bad header table');
    const n = r.u32();
    const map = new Map();
    for (let i = 0; i < n; i++) {
      const crc = r.u32(), channels = r.u8_(), rate = r.u32(), bs0 = r.u16(), bs1 = r.u16(), nModes = r.u8_();
      const flags = r.bytes(nModes);
      const setup = r.bytes(r.u32());
      map.set(crc, { channels, rate, bs0, bs1, flags, setup });
    }
    return map;
  })();
  return headerTableP;
}

// ---- Ogg writer ----
let oggCrcTable;
function oggCrc(u8) {
  if (!oggCrcTable) {
    oggCrcTable = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let r = i << 24;
      for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
      oggCrcTable[i] = r >>> 0;
    }
  }
  let crc = 0;
  for (let i = 0; i < u8.length; i++) crc = ((crc << 8) ^ oggCrcTable[((crc >>> 24) & 0xff) ^ u8[i]]) >>> 0;
  return crc >>> 0;
}

export class OggStream {
  constructor(serial = 1) { this.serial = serial; this.seq = 0; this.pages = []; this.cur = []; this.segs = 0; this.bytes = 0; this.granule = -1; this.first = true; }
  packet(data, granule, flush = false) {
    const nseg = Math.floor(data.length / 255) + 1;
    if (this.cur.length && (this.segs + nseg > 255 || this.bytes + data.length > 4096)) this.flush();
    this.cur.push(data);
    this.segs += nseg;
    this.bytes += data.length;
    this.granule = granule;
    if (flush) this.flush();
  }
  flush(eos = false) {
    if (!this.cur.length && !eos) return;
    const seg = [];
    for (const p of this.cur) { let n = p.length; while (n >= 255) { seg.push(255); n -= 255; } seg.push(n); }
    const body = this.bytes;
    const page = new Uint8Array(27 + seg.length + body);
    const dv = new DataView(page.buffer);
    page.set([0x4f, 0x67, 0x67, 0x53, 0]);
    page[5] = (this.first ? 2 : 0) | (eos ? 4 : 0);
    dv.setBigInt64(6, BigInt(this.granule), true);
    dv.setUint32(14, this.serial, true);
    dv.setUint32(18, this.seq++, true);
    page[26] = seg.length;
    page.set(seg, 27);
    let o = 27 + seg.length;
    for (const p of this.cur) { page.set(p, o); o += p.length; }
    dv.setUint32(22, oggCrc(page), true);
    this.pages.push(page);
    this.cur = []; this.segs = 0; this.bytes = 0; this.first = false;
  }
  result() {
    let n = 0;
    for (const p of this.pages) n += p.length;
    const out = new Uint8Array(n);
    let o = 0;
    for (const p of this.pages) { out.set(p, o); o += p.length; }
    return out;
  }
}

const ilog = (v) => { let r = 0; while (v) { r++; v >>>= 1; } return r; };

async function rebuildVorbis(sample) {
  const table = await headerTable();
  const h = table.get(sample.chunks.vorbisCrc);
  if (!h) throw new Error(`unknown Vorbis setup (crc ${sample.chunks.vorbisCrc}); this audio can't be rebuilt`);
  const exp = (n) => Math.log2(n);
  const id = new Uint8Array(30);
  const dv = new DataView(id.buffer);
  id.set([1, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]);
  dv.setUint32(7, 0, true);
  id[11] = sample.channels;
  dv.setUint32(12, sample.frequency, true);
  id[28] = exp(h.bs0) | (exp(h.bs1) << 4);
  id[29] = 1;
  const vendor = new TextEncoder().encode('ReSourcefy (libVorbis setup)');
  const com = new Uint8Array(7 + 4 + vendor.length + 4 + 1);
  com.set([3, 0x76, 0x6f, 0x72, 0x62, 0x69, 0x73]);
  new DataView(com.buffer).setUint32(7, vendor.length, true);
  com.set(vendor, 11);
  com[com.length - 1] = 1;
  const ogg = new OggStream(1);
  ogg.packet(id, 0, true);
  ogg.packet(com, 0);
  ogg.packet(h.setup, 0, true);
  const modeBits = ilog(h.flags.length - 1);
  const r = new Reader(sample.data);
  let granule = 0, prev = 0;
  const packets = [];
  while (r.remaining >= 2) {
    const size = r.u16();
    if (!size || size > r.remaining) break;
    packets.push(r.bytes(size));
  }
  for (let i = 0; i < packets.length; i++) {
    const p = packets[i];
    const mode = (p[0] >> 1) & ((1 << modeBits) - 1);
    const bs = h.flags[mode] ? h.bs1 : h.bs0;
    granule = prev ? granule + (bs + prev) / 4 : 0;
    prev = bs;
    ogg.packet(p, granule);
  }
  ogg.flush(true);
  return ogg.result();
}

export function wavFromPCM(pcm, channels, rate, bits, float = false) {
  const out = new Uint8Array(44 + pcm.length);
  const dv = new DataView(out.buffer);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) out[o + i] = s.charCodeAt(i); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + pcm.length, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, float ? 3 : 1, true); dv.setUint16(22, channels, true);
  dv.setUint32(24, rate, true); dv.setUint32(28, rate * channels * bits / 8, true); dv.setUint16(32, channels * bits / 8, true);
  dv.setUint16(34, bits, true); w(36, 'data'); dv.setUint32(40, pcm.length, true);
  out.set(pcm, 44);
  return out;
}

// Returns [{name, ext, mime, data}]
export async function extractFSB5(u8) {
  const fsb = parseFSB5(u8);
  const out = [];
  for (const s of fsb.samples) {
    if (fsb.mode === 15) out.push({ name: s.name, ext: 'ogg', mime: 'audio/ogg', data: await rebuildVorbis(s) });
    else if (fsb.mode === 11) out.push({ name: s.name, ext: 'mp3', mime: 'audio/mpeg', data: s.data.slice() });
    else if (fsb.mode >= 1 && fsb.mode <= 5) {
      const bits = { 1: 8, 2: 16, 3: 24, 4: 32, 5: 32 }[fsb.mode];
      let pcm = s.data;
      if (fsb.mode === 1) pcm = pcm.map((b) => (b + 128) & 255); // FMOD PCM8 is signed; WAV 8-bit is unsigned
      out.push({ name: s.name, ext: 'wav', mime: 'audio/wav', data: wavFromPCM(pcm, s.channels, s.frequency, bits, fsb.mode === 5) });
    } else throw new Error(`FSB codec ${fsb.codec} is not supported`);
  }
  return out;
}
