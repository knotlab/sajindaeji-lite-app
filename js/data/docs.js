// 자료함 데이터(SPEC §10.4·§10.5) — 도면·문서 파일의 메타데이터는 별도 IndexedDB `sajindaeji-lite-docs` v1(store `docs`),
// 파일 본체는 사진과 같은 파일 저장소(photofs.put('doc', …): APK DATA/docs, 웹 OPFS docs/, 폴백 IDB)에 둔다.
// 읽기는 동기(메모리 캐시), 쓰기는 직렬 큐 + Promise(store.js 와 같은 방식). DB 연결이 닫히면 다시 열고 한 번 더 쓴다.
import * as photofs from './photofs.js';

const DB_NAME = 'sajindaeji-lite-docs';
const DB_VER = 1;
const STORE = 'docs';
const MAX_BYTES = 200 * 1024 * 1024;                 // 한 파일 상한(원본 files.js 값)
const TRASH_MS = 30 * 24 * 60 * 60 * 1000;           // 휴지통 30일(config.TRASH_DAYS 와 같음)

// 확장자 → 종류(§10.4). 자료함 칩과 같은 묶음
const KINDS = {
  drawing: ['dwg', 'dxf', 'dwt', 'dwf', 'dwfx'],
  pdf: ['pdf'],
  doc: ['docx', 'doc', 'hwp', 'hwpx', 'rtf', 'txt', 'md', 'odt'],
  sheet: ['xlsx', 'xls', 'xlsm', 'xlsb', 'csv', 'tsv', 'ods'],
  slide: ['pptx', 'ppt', 'odp'],
  image: ['png', 'jpg', 'jpeg', 'jfif', 'gif', 'webp', 'bmp', 'svg', 'avif', 'tif', 'tiff', 'heic', 'heif'],
};
const KIND_OF = new Map(Object.entries(KINDS).flatMap(([k, xs]) => xs.map(x => [x, k])));
const MIME = { pdf: 'application/pdf', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', csv: 'text/csv', txt: 'text/plain', dxf: 'image/vnd.dxf', dwg: 'image/vnd.dwg' };

export const extOf = name => (/\.([A-Za-z0-9]{1,10})$/.exec(String(name ?? '')) ?? [])[1]?.toLowerCase() ?? '';
export function kindOf(name) { return KIND_OF.get(extOf(name)) ?? 'other'; }

// 보이지 않는 글자(제어·폭 없는 글자·방향 바꿈·BOM)와 경로 글자를 걷는다(원본 files.cleanName)
const HIDDEN = new RegExp(`[${[[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]].map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`, 'g');
export function cleanName(name) {
  const s = String(name ?? '').replace(HIDDEN, '').replace(/[\\/:*?"<>|]/g, '_').replace(/^\.+/, '').trim();
  return s || '파일';
}

let cache = new Map();          // id → Doc
let dbP = null, dbName = DB_NAME;
let queue = Promise.resolve();
const subs = new Set();
let notifyQueued = false;

const uid = () => 'd_' + Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(36).padStart(2, '0')).join('').slice(0, 8);
const fail = (code, message) => Object.assign(new Error(message), { code });

function openDb() {
  if (dbP) return dbP;
  dbP = new Promise((resolve, reject) => {
    const rq = indexedDB.open(dbName, DB_VER);
    rq.onupgradeneeded = () => { const db = rq.result; if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }); };
    rq.onsuccess = () => {
      const db = rq.result;
      const drop = () => { dbP = null; try { db.close(); } catch { /* 이미 닫힘 */ } };
      db.onclose = drop;                    // 웹뷰가 강제로 닫음(메모리 압박) → 다음 쓰기에서 다시 연다
      db.onversionchange = drop;
      resolve(db);
    };
    rq.onerror = () => { dbP = null; reject(rq.error); };
    rq.onblocked = () => console.warn('자료 DB 열기가 막혔어요(다른 탭)');
  });
  return dbP;
}

async function run(mode, fn) {
  for (let i = 0; ; i++) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        const os = t.objectStore(STORE);
        let out;
        Promise.resolve(fn(os)).then(v => { out = v; }, reject);
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('abort'));
      });
    } catch (err) {
      if (err?.name === 'QuotaExceededError') throw Object.assign(err, { code: 'QUOTA' });
      const closed = err?.name === 'InvalidStateError' || /clos/i.test(err?.message || '');
      if (!closed || i >= 1) throw err;
      dbP = null;                            // 연결이 닫혀 있었다 — 다시 열고 한 번 더
    }
  }
}
const reqP = rq => new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });

function serial(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}

function changed() {
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    for (const fn of subs) { try { fn(); } catch (e) { console.error(e); } }
  });
}

async function save(d) {
  const frozen = Object.freeze({ ...d });
  await run('readwrite', os => { os.put(frozen); });
  cache.set(frozen.id, frozen);
  changed();
  return frozen;
}

// ---- 시작 ----
// 부트(app.js)에서 부르지 않아도 되게 화면·docFrame 은 ready() 로 한 번만 연다
let initP = null;
export function initDocs(opts = {}) {
  initP = initImpl(opts);
  initP.catch(() => { initP = null; });
  return initP;
}
export function ready() { return initP || initDocs(); }
async function initImpl({ now = Date.now(), dbName: name } = {}) {
  if (name && name !== dbName) { dbName = name; dbP = null; }
  const all = await run('readonly', os => reqP(os.getAll()));
  cache = new Map(all.map(d => [d.id, Object.freeze(d)]));
  for (const d of [...cache.values()]) {           // 휴지통 30일 지난 것 영구 삭제
    if (d.deletedAt && now - d.deletedAt > TRASH_MS) await purgeDoc(d.id).catch(e => console.warn('지난 자료를 비우지 못했어요', e));
  }
  changed();
}

export function onDocs(fn) { subs.add(fn); return () => subs.delete(fn); }

const recent = d => d.lastOpenedAt || d.addedAt || 0;
const order = (a, b) => (b.pinned - a.pinned) || (recent(b) - recent(a));

export function docs({ deleted = false } = {}) {
  return [...cache.values()].filter(d => !!d.deletedAt === !!deleted)
    .sort(deleted ? (a, b) => b.deletedAt - a.deletedAt : order);
}
export function doc(id) { return id ? cache.get(id) : undefined; }

export function searchDocs(q, { kind = null, pinned = null } = {}) {
  const words = String(q ?? '').toLowerCase().split(/\s+/).filter(Boolean);
  return docs().filter(d => {
    if (kind && d.kind !== kind) return false;
    if (pinned !== null && !!d.pinned !== !!pinned) return false;
    if (!words.length) return true;
    const hay = `${d.name} ${d.tags || ''} ${d.ext}`.toLowerCase();
    return words.every(w => hay.includes(w));
  });
}

// 하버사인 거리(m)
function distM(a, b) {
  const R = 6371008.8, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLng = (b.lng - a.lng) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}
export function nearby(pos, { radius = 200 } = {}) {
  if (!pos || !Number.isFinite(pos.lat) || !Number.isFinite(pos.lng)) return [];
  return docs().filter(d => d.anchor && Number.isFinite(d.anchor.lat))
    .map(d => ({ doc: d, dist: distM(pos, d.anchor) }))
    .filter(x => x.dist <= radius)
    .sort((a, b) => a.dist - b.dist);
}

// ---- 쓰기 ----
// files: FileList | File[] | {name, size, type, slice…}[]. 하나씩 차례로(메모리) — 실패는 그 파일만 failed 로
export function addDocs(files, { now, onProgress, site = '' } = {}) {
  const list = Array.from(files || []);
  return serial(async () => {
    const added = [], failed = [];
    let i = 0;
    for (const f of list) {
      const name = cleanName(f?.name);
      try { onProgress?.(i, list.length, name); } catch (e) { console.error(e); }
      try {
        const size = Number(f?.size);
        if (!Number.isFinite(size) || size <= 0) throw fail('EMPTY', '빈 파일이에요');
        if (size > MAX_BYTES) throw fail('TOO_BIG', '200MB 넘는 파일은 못 올려요');
        const id = uid();
        const { store } = await photofs.put('doc', id, f);
        const t = now ?? Date.now();
        const ext = extOf(name);
        const d = { id, name, ext, kind: kindOf(name), mime: f.type || MIME[ext] || 'application/octet-stream', size,
          addedAt: t, updatedAt: t, lastOpenedAt: null, tags: '', pinned: false, anchor: null, site: String(site || ''), deletedAt: null, store };
        try { added.push(await save(d)); }
        catch (err) { await photofs.remove('doc', id, store).catch(() => {}); throw err; }
      } catch (err) {
        console.warn('자료를 올리지 못했어요', name, err);
        failed.push({ name, reason: err?.code === 'QUOTA' ? '저장 공간이 부족해요' : (err?.code && err.message) || '저장하지 못했어요' });
      }
      i++;
    }
    try { onProgress?.(list.length, list.length, ''); } catch (e) { console.error(e); }
    return { added, failed };
  });
}

function patchDoc(id, fn) {
  return serial(async () => {
    const cur = cache.get(id);
    if (!cur) throw fail('NO_DOC', '자료가 없어요');
    return save(fn({ ...cur }));
  });
}

export function updateDoc(id, patch = {}, now = Date.now()) {
  return patchDoc(id, d => {
    if ('name' in patch) {                          // 확장자는 지킨다(뷰어가 확장자로 형식을 고른다)
      let n = cleanName(patch.name);
      if (d.ext && extOf(n) !== d.ext) n = `${n}.${d.ext}`;
      d.name = n;
    }
    if ('tags' in patch) d.tags = String(patch.tags ?? '').trim();
    if ('pinned' in patch) d.pinned = !!patch.pinned;
    if ('anchor' in patch) {
      const a = patch.anchor;
      d.anchor = a && Number.isFinite(a.lat) && Number.isFinite(a.lng) ? { lat: a.lat, lng: a.lng, acc: a.acc ?? null, at: a.at ?? now } : null;
    }
    d.updatedAt = now;
    return d;
  });
}
export function markOpened(id, now = Date.now()) { return patchDoc(id, d => { d.lastOpenedAt = now; return d; }); }
export function deleteDoc(id, now = Date.now()) { return patchDoc(id, d => { d.deletedAt = now; d.updatedAt = now; return d; }); }
export function restoreDoc(id, now = Date.now()) { return patchDoc(id, d => { d.deletedAt = null; d.updatedAt = now; return d; }); }
export function purgeDoc(id) {
  return serial(async () => {
    const cur = cache.get(id);
    if (!cur) return;
    await photofs.remove('doc', id, cur.store).catch(e => console.warn('자료 파일을 지우지 못했어요', e));
    await run('readwrite', os => { os.delete(id); });
    cache.delete(id);
    changed();
  });
}

export async function docBlob(id) {
  const d = cache.get(id);
  if (!d) return null;
  const b = await photofs.get('doc', id, d.store);
  if (!b) return null;
  return b.type || !d.mime ? b : new Blob([b], { type: d.mime });
}

export async function usage() {
  let count = 0, bytes = 0;
  for (const d of cache.values()) { count++; bytes += d.size || 0; }
  return { count, bytes };
}

// 화면용 크기 글자(1000 단위, 원본 fmtSize)
export function fmtSize(n) {
  n = Number(n);
  if (!Number.isFinite(n) || n < 0) return '?';
  if (n < 1e3) return `${Math.round(n)}B`;
  if (n < 1e6) return `${Math.round(n / 1e3)}KB`;
  if (n < 1e9) return `${(n / 1e6).toFixed(1)}MB`;
  return `${(n / 1e9).toFixed(1)}GB`;
}
