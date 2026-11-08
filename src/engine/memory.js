// Memory budget for the engine worker, sized to the device so ReSourcefy stays usable on
// 4 GB machines. navigator.deviceMemory is coarse (and missing outside Chromium), so an
// unknown device is treated as a 4 GB one.
const reported = typeof navigator !== 'undefined' && navigator.deviceMemory ? navigator.deviceMemory : 0;
export const deviceGB = reported || 4;

const factor = deviceGB <= 2 ? 0.15 : deviceGB <= 4 ? 0.25 : deviceGB < 8 ? 0.45 : 0.6;

export const memory = {
  deviceGB,
  // scale a cache size meant for a roomy machine
  budget(base) { return Math.max(16 << 20, Math.round(base * factor)); },
  // files above this are read in windows instead of all at once
  largeFile: deviceGB <= 4 ? 48 << 20 : 160 << 20,
  // produced buffers above this live in Blobs (which the browser can keep on disk)
  blobAbove: 1 << 20,
};
