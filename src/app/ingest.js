// Collects files from drag & drop (folders included) and file pickers.
// Returns [{path, blob}] with folder-relative paths.

function readEntries(reader) {
  return new Promise((res, rej) => reader.readEntries(res, rej));
}

async function walkEntry(entry, prefix, out) {
  if (entry.isFile) {
    const file = await new Promise((res, rej) => entry.file(res, rej));
    out.push({ path: prefix + entry.name, blob: file });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    for (;;) {
      const batch = await readEntries(reader);
      if (!batch.length) break;
      for (const e of batch) await walkEntry(e, prefix + entry.name + '/', out);
    }
  }
}

export async function filesFromDataTransfer(dt) {
  const out = [];
  const items = dt.items ? [...dt.items] : [];
  const entries = items.map((it) => (it.kind === 'file' && it.webkitGetAsEntry ? it.webkitGetAsEntry() : null));
  if (entries.some(Boolean)) {
    for (const e of entries) if (e) await walkEntry(e, '', out);
    return out;
  }
  for (const f of dt.files || []) out.push({ path: f.name, blob: f });
  return out;
}

export function filesFromInput(input) {
  return [...input.files].map((f) => ({ path: f.webkitRelativePath || f.name, blob: f }));
}

export function pickFiles({ directory = false, multiple = true, accept } = {}) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    if (multiple) input.multiple = true;
    if (directory) { input.webkitdirectory = true; input.setAttribute('webkitdirectory', ''); }
    if (accept) input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => { resolve(filesFromInput(input)); input.remove(); });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); });
    document.body.appendChild(input);
    input.click();
  });
}
