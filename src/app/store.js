// Games kept in this browser (IndexedDB), so a reload doesn't lose the game or the edits.
// Every call fails soft: storage can be blocked, full or cleared at any time.
const DB = 'resourcefy-games';
let dbPromise = null;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB, 1); } catch (e) { reject(e); return; }
      req.onupgradeneeded = () => {
        const d = req.result;
        d.createObjectStore('games', { keyPath: 'id' });
        d.createObjectStore('files', { keyPath: ['game', 'path'] }).createIndex('game', 'game');
        d.createObjectStore('edits', { keyPath: ['game', 'path'] }).createIndex('game', 'game');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('storage is busy in another tab'));
    });
    dbPromise.catch(() => { dbPromise = null; });
  }
  return dbPromise;
}

function run(stores, mode, fn) {
  return open().then((d) => new Promise((resolve, reject) => {
    const t = d.transaction(stores, mode);
    let out;
    try { out = fn(t); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('storage write was cancelled'));
  }));
}

const all = (req) => new Promise((resolve, reject) => { req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error); });

export const newGameId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function listGames() {
  const games = await run(['games'], 'readonly', (t) => all(t.objectStore('games').getAll()));
  return games.sort((a, b) => (b.openedAt || 0) - (a.openedAt || 0));
}

// files: [{ path, blob }]; written a batch at a time so big games don't make one huge transaction
export async function saveGame(meta, files, onProgress) {
  await run(['games'], 'readwrite', (t) => { t.objectStore('games').put({ ...meta, complete: false }); });
  const BATCH = 40;
  for (let i = 0; i < files.length; i += BATCH) {
    await run(['files'], 'readwrite', (t) => {
      const s = t.objectStore('files');
      for (const f of files.slice(i, i + BATCH)) s.put({ game: meta.id, path: f.path, blob: f.blob });
    });
    if (onProgress) onProgress(Math.min(1, (i + BATCH) / files.length));
  }
  await run(['games'], 'readwrite', (t) => { t.objectStore('games').put({ ...meta, complete: true }); });
}

export async function addFiles(id, files) {
  await run(['files'], 'readwrite', (t) => { const s = t.objectStore('files'); for (const f of files) s.put({ game: id, path: f.path, blob: f.blob }); });
}

export async function updateGame(id, patch) {
  await run(['games'], 'readwrite', (t) => {
    const s = t.objectStore('games');
    const req = s.get(id);
    req.onsuccess = () => { if (req.result) s.put({ ...req.result, ...patch }); };
  });
}

export async function loadGame(id) {
  const [meta, files, edits] = await run(['games', 'files', 'edits'], 'readonly', (t) => Promise.all([
    all(t.objectStore('games').get(id)),
    all(t.objectStore('files').index('game').getAll(id)),
    all(t.objectStore('edits').index('game').getAll(id)),
  ]));
  return { meta, files: files.map((f) => ({ path: f.path, blob: f.blob })), edits: edits.sort((a, b) => a.at - b.at) };
}

export async function saveEdit(id, path, blob) {
  await run(['edits'], 'readwrite', (t) => { t.objectStore('edits').put({ game: id, path, blob, at: Date.now() }); });
}

export async function deleteEdit(id, path) {
  await run(['edits'], 'readwrite', (t) => { t.objectStore('edits').delete([id, path]); });
}

export async function deleteGame(id) {
  await run(['games', 'files', 'edits'], 'readwrite', (t) => {
    t.objectStore('games').delete(id);
    for (const name of ['files', 'edits']) {
      const req = t.objectStore(name).index('game').openKeyCursor(IDBKeyRange.only(id));
      req.onsuccess = () => { const c = req.result; if (c) { t.objectStore(name).delete(c.primaryKey); c.continue(); } };
    }
  });
}

export async function usage() {
  try { const e = await navigator.storage.estimate(); return { used: e.usage || 0, quota: e.quota || 0 }; } catch { return null; }
}
