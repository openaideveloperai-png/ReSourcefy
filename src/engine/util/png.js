// RGBA8 -> PNG encoder (zlib via fflate). Used by every texture converter.
import { zlibSync } from 'fflate';
import { crc32 } from './binary.js';

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

// rgba: Uint8Array of w*h*4. flipY flips vertically (Unity textures are bottom-up).
export function encodePNG(rgba, w, h, { flipY = false, level = 4 } = {}) {
  const stride = w * 4;
  const raw = new Uint8Array((stride + 1) * h);
  for (let y = 0; y < h; y++) {
    const sy = flipY ? h - 1 - y : y;
    const row = raw.subarray(y * (stride + 1), (y + 1) * (stride + 1));
    row[0] = 1; // Sub filter: cheap and compresses sprites well
    const src = rgba.subarray(sy * stride, sy * stride + stride);
    row[1] = src[0]; row[2] = src[1]; row[3] = src[2]; row[4] = src[3];
    for (let i = 4; i < stride; i++) row[1 + i] = (src[i] - src[i - 4]) & 0xff;
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const idat = zlibSync(raw, { level });
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const parts = [sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export function pngBlob(rgba, w, h, opts) {
  return new Blob([encodePNG(rgba, w, h, opts)], { type: 'image/png' });
}

// Decode PNG/JPEG/WebP/GIF bytes to RGBA using the browser (works in workers).
export async function decodeImage(bytes, type = 'image/png') {
  const bmp = await createImageBitmap(new Blob([bytes], { type }));
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0);
  const d = g.getImageData(0, 0, bmp.width, bmp.height);
  bmp.close?.();
  return { width: d.width, height: d.height, rgba: new Uint8Array(d.data.buffer) };
}

// Crop a region out of an RGBA image.
export function cropRGBA(src, sw, x, y, w, h) {
  const out = new Uint8Array(w * h * 4);
  for (let row = 0; row < h; row++) {
    const so = ((y + row) * sw + x) * 4;
    out.set(src.subarray(so, so + w * 4), row * w * 4);
  }
  return out;
}
