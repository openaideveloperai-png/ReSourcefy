// Zip archive as a Blob, built from Blobs without holding every file in memory. Files are
// stored as they are (most game data is already compressed); small text files are deflated.
import { deflateSync } from 'fflate';

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(u8, crc = 0xffffffff) {
  for (let i = 0; i < u8.length; i++) crc = TABLE[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);
  return crc;
}

const TEXT = /\.(js|mjs|json|html?|css|txt|xml|svg|md|csv|lua|gd|tscn|tres|cfg|ini|yaml|yml|rpy|shader|glsl)$/i;
const tick = () => new Promise((r) => setTimeout(r, 0));

// files: [{ path, data: Blob | Uint8Array }]; onProgress(fraction)
export async function zipBlob(files, { onProgress } = {}) {
  const enc = new TextEncoder();
  const now = new Date();
  const dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [], central = [];
  let offset = 0, done = 0;
  const total = files.reduce((a, f) => a + (f.data instanceof Blob ? f.data.size : f.data.length), 0) || 1;
  if (files.length > 0xfffe) throw new Error('too many files for a zip');
  for (const f of files) {
    const name = enc.encode(f.path.replace(/^\/+/, ''));
    const blob = f.data instanceof Blob ? f.data : new Blob([f.data]);
    const size = blob.size;
    let crc = 0xffffffff;
    let data = blob, method = 0, csize = size;
    if (TEXT.test(f.path) && size < (16 << 20)) {
      const raw = new Uint8Array(await blob.arrayBuffer());
      crc = crc32(raw, crc);
      const packed = deflateSync(raw, { level: 6 });
      if (packed.length < raw.length) { data = new Blob([packed]); method = 8; csize = packed.length; }
    } else {
      for (let p = 0; p < size; p += 8 << 20) {
        crc = crc32(new Uint8Array(await blob.slice(p, p + (8 << 20)).arrayBuffer()), crc);
        if (onProgress) onProgress(Math.min(0.99, (done + p) / total));
        await tick();
      }
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    if (offset + 30 + name.length + csize > 0xffffffff) throw new Error('the game is too large for a zip (over 4 GB)');
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, method, true);
    local.setUint16(10, dosTime, true); local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true); local.setUint32(18, csize, true); local.setUint32(22, size, true);
    local.setUint16(26, name.length, true); local.setUint16(28, 0, true);
    parts.push(local.buffer, name, data);
    const cd = new DataView(new ArrayBuffer(46));
    cd.setUint32(0, 0x02014b50, true);
    cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint16(8, 0x0800, true); cd.setUint16(10, method, true);
    cd.setUint16(12, dosTime, true); cd.setUint16(14, dosDate, true);
    cd.setUint32(16, crc, true); cd.setUint32(20, csize, true); cd.setUint32(24, size, true);
    cd.setUint16(28, name.length, true);
    cd.setUint32(42, offset, true);
    central.push(cd.buffer, name);
    offset += 30 + name.length + csize;
    done += size;
    if (onProgress) onProgress(Math.min(0.99, done / total));
  }
  let cdSize = 0;
  for (const c of central) cdSize += c.byteLength;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true); end.setUint32(16, offset, true);
  return new Blob([...parts, ...central, end.buffer], { type: 'application/zip' });
}
