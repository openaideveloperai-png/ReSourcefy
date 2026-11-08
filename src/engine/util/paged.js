// Random access into a large Blob without holding all of it in memory. Reads are
// synchronous (FileReaderSync, which workers have) and cached in a few windows.
const WINDOW = 4 << 20;

export class PagedBlob {
  static supported() { return typeof FileReaderSync !== 'undefined'; }

  constructor(blob, budget = 48 << 20) {
    this.blob = blob;
    this.size = blob.size;
    this.budget = budget;
    this.windows = new Map(); // start -> Uint8Array, in LRU order
    this.bytes = 0;
    this.reader = new FileReaderSync();
  }

  get(start, len) {
    const end = Math.min(this.size, start + len);
    for (const [s, w] of this.windows) {
      if (s <= start && end <= s + w.length) {
        this.windows.delete(s);
        this.windows.set(s, w);
        return w.subarray(start - s, end - s);
      }
    }
    const ws = Math.floor(start / WINDOW) * WINDOW;
    const we = Math.min(this.size, Math.max(end, ws + WINDOW));
    const buf = new Uint8Array(this.reader.readAsArrayBuffer(this.blob.slice(ws, we)));
    const old = this.windows.get(ws);
    if (old) { this.windows.delete(ws); this.bytes -= old.length; }
    this.windows.set(ws, buf);
    this.bytes += buf.length;
    while (this.bytes > this.budget && this.windows.size > 1) {
      const [k, v] = this.windows.entries().next().value;
      this.windows.delete(k);
      this.bytes -= v.length;
    }
    return buf.subarray(start - ws, end - ws);
  }

  release() { this.windows.clear(); this.bytes = 0; }
}
