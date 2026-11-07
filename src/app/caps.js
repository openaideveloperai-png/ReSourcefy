// Artifact runtime capabilities: file downloads and "Ask Claude".
// Both are optional: when a view can't use them, the UI hides or explains.

const ALLOWED = new Set('gif png jpg jpeg webp mp4 webm mov txt json md docx pptx epub csv ttf html svg pdf xlsx zip fig'.split(' '));

const use = (name) => (window.claude && typeof window.claude.use === 'function' ? window.claude.use(name).catch(() => null) : Promise.resolve(null));

let downloadsP, sampleP;
export const getDownloads = () => (downloadsP ||= use('downloads'));
export const getSample = () => (sampleP ||= use('sample'));

export function extAllowed(name) {
  const ext = name.slice(name.lastIndexOf('.') + 1).toLowerCase();
  return ALLOWED.has(ext);
}

const DOWNLOAD_ERRORS = {
  declined: 'Download cancelled.',
  rate_limited: 'Another download is waiting for your confirmation. Try again in a moment.',
  too_large: 'This file is too large to save here.',
  rejected_extension: 'This file type cannot be downloaded here; export it as a .zip instead.',
};

// Returns {ok, message}
export async function saveFile(filename, data) {
  const dl = await getDownloads();
  if (!dl) return { ok: false, message: 'Downloads are not available in this view. Open the artifact on claude.ai to save files.' };
  try {
    await dl.save({ filename, data });
    return { ok: true, message: `Saved ${filename}` };
  } catch (e) {
    return { ok: false, message: DOWNLOAD_ERRORS[e && e.code] || `Could not save: ${(e && e.message) || 'unavailable'}` };
  }
}

const SAMPLE_ERRORS = {
  not_granted: 'Claude access was not allowed for this page.',
  rate_limited: 'Too many requests right now. Wait a moment and try again.',
  cancelled: 'Stopped.',
};

export async function askClaude(prompt, { onText, signal, tier = 'default' } = {}) {
  const sample = await getSample();
  if (!sample) throw Object.assign(new Error('Ask Claude is not available in this view.'), { code: 'unavailable' });
  try {
    return await sample(prompt, { onText, signal, modelTier: tier });
  } catch (e) {
    const err = new Error(SAMPLE_ERRORS[e && e.code] || (e && e.message) || 'Request failed');
    err.code = e && e.code;
    err.partial = e && e.text;
    throw err;
  }
}
