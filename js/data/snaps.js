// 도면 스냅샷 저장소 — 「도면에 핀하기」의 바탕 그림(media/docsnap.js 가 만든 JPEG).
// 메타: 별도 IndexedDB `sajindaeji-lite-snaps` v1, store 'snaps'(keyPath id) — 사진·자료 DB 와 분리(스키마 충돌 없게).
// 그림 바이트: data/photofs.js 의 'doc' 종류에 id 'snap_<id>' 로(사진·자료처럼 IndexedDB 밖 파일. APK DATA/docs/, 웹 OPFS docs/, 폴백 IDB).
// 스냅샷은 자료(doc)·쪽 단위로 다시 쓴다 — 같은 도면·같은 쪽이면 snapFor() 가 가장 최근 것을 돌려줘 그 날 핀이 한 그림에 모인다.
// 다시 찍으면 새 스냅샷이 생기고(옛 핀이 가리키는 옛 그림은 그대로 남는다) 그다음 핀부터 새 그림을 쓴다.
// 자료를 지워도 스냅샷은 남는다(위치도는 계속 만들 수 있어야 하니까). 안 쓰는 것 정리는 pruneSnaps(쓰는지 묻는 함수).
// 읽기(snap·snapFor·listSnaps)는 동기(메모리 캐시) — initSnaps()/ready() 뒤에. 쓰기는 직렬 큐 + Promise.
//
// Snap = { id: 's_xxxxxxxx', docId, page, w, h, view: {x,y,w,h}|null, createdAt, label, store, bytes }
import * as photofs from './photofs.js';

const DB_NAME = 'sajindaeji-lite-snaps';
const DB_VER = 1;
const STORE = 'snaps';
const key = id => 'snap_' + id;

let cache = new Map();                 // id → Snap(얼림)
let dbP = null, dbName = DB_NAME;
let queue = Promise.resolve();
const subs = new Set();
let notifyQueued = false;
const urls = new Map();                // id → 화면 주소(웹 objectURL 은 지울 때 놓는다)

const uid = () => 's_' + Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(36).padStart(2, '0')).join('').slice(0, 8);

function openDb() {
  if (dbP) return dbP;
  dbP = new Promise((resolve, reject) => {
    const rq = indexedDB.open(dbName, DB_VER);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('docId', 'docId');
    };
    rq.onsuccess = () => {
      const db = rq.result;
      const drop = () => { dbP = null; try { db.close(); } catch { /* 이미 닫힘 */ } };
      db.onclose = drop;               // 웹뷰가 강제로 닫음(메모리 압박) → 다음 쓰기에서 다시 연다(§4.5-1)
      db.onversionchange = drop;
      resolve(db);
    };
    rq.onerror = () => { dbP = null; reject(rq.error); };
    rq.onblocked = () => console.warn('스냅샷 DB 열기가 막혔어요(다른 탭)');
  });
  return dbP;
}

async function run(mode, fn) {
  for (let i = 0; ; i++) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const t = db.transaction(STORE, mode);
        let out;
        Promise.resolve(fn(t.objectStore(STORE))).then(v => { out = v; }, reject);
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('abort'));
      });
    } catch (err) {
      if (err?.name === 'QuotaExceededError') throw Object.assign(err, { code: 'QUOTA' });
      const closed = err?.name === 'InvalidStateError' || /clos/i.test(err?.message || '');
      if (!closed || i >= 1) throw err;
      dbP = null;                      // 연결이 닫혀 있었다 — 다시 열고 한 번 더
    }
  }
}
const reqP = rq => new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });

function serial(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}

function changed(ids) {
  for (const id of ids) pending.add(id);
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    const set = new Set(pending); pending.clear();
    for (const fn of subs) { try { fn(set); } catch (e) { console.error(e); } }
  });
}
const pending = new Set();

// ---- 시작 ----
let initP = null;
// dbName: 시험용. 부팅에서 부르지 않아도 된다 — 쓰기·주소는 ready() 를 스스로 기다린다
export function initSnaps({ dbName: name } = {}) {
  initP = (async () => {
    if (name && name !== dbName) { dbName = name; dbP = null; }
    const all = await run('readonly', os => reqP(os.getAll()));
    cache = new Map(all.map(s => [s.id, Object.freeze(s)]));
    changed(cache.keys());
  })();
  initP.catch(() => { initP = null; });
  return initP;
}
export function ready() { return initP || initSnaps(); }

// fn(ids: Set<snapId>) — 같은 틱 변경은 한 번에
export function onSnaps(fn) { subs.add(fn); return () => subs.delete(fn); }

// ---- 읽기(동기) ----
export function snap(id) { return id ? cache.get(id) || null : null; }

// 그 자료·그 쪽의 가장 최근 스냅샷(없으면 null). page 를 안 주면 쪽 상관없이 가장 최근
export function snapFor(docId, page) {
  let best = null;
  for (const s of cache.values()) {
    if (s.docId !== docId || (page != null && s.page !== page)) continue;
    if (!best || s.createdAt > best.createdAt) best = s;
  }
  return best;
}

// docId 를 주면 그 자료 것만. 최근 순
export function listSnaps(docId) {
  const out = [];
  for (const s of cache.values()) if (docId == null || s.docId === docId) out.push(s);
  return out.sort((a, b) => b.createdAt - a.createdAt);
}

// ---- 쓰기 ----
// saveSnap({ docId, page, blob, w, h, view, label, now }) → Promise<Snap>
// 순서: 그림 파일 먼저(실패하면 메타를 안 남김) → 메타. 메타가 실패하면 그림을 지운다
export async function saveSnap({ docId, page = 1, blob, w, h, view = null, label = '', now = Date.now() } = {}) {
  if (!docId) throw new Error('docId 가 없어요');
  if (!blob || !blob.size) throw new Error('그림이 비어 있어요');
  await ready();
  return serial(async () => {
    const id = uid();
    const { store } = await photofs.put('doc', key(id), blob);
    const s = Object.freeze({
      id, docId, page: Number(page) || 1, w: Math.round(w) || 0, h: Math.round(h) || 0,
      view: view ? Object.freeze({ x: +view.x || 0, y: +view.y || 0, w: +view.w || 1, h: +view.h || 1 }) : null,
      createdAt: now, label: String(label || ''), store, bytes: blob.size,
    });
    try { await run('readwrite', os => { os.put(s); }); }
    catch (e) { await photofs.remove('doc', key(id), store).catch(() => {}); throw e; }
    cache.set(id, s);
    changed([id]);
    return s;
  });
}

// 그림 Blob(image/jpeg) — 내보내기 위치도 합성용
export async function snapBlob(id) {
  await ready();
  const s = cache.get(id);
  if (!s) return null;
  const b = await photofs.get('doc', key(id), s.store);
  if (!b) return null;
  return b.type === 'image/jpeg' ? b : new Blob([b], { type: 'image/jpeg' });
}

// 화면 주소(<img src>). APK: convertFileSrc, 웹: objectURL(캐시 — removeSnap 이 놓는다)
export async function snapUrl(id) {
  if (urls.has(id)) return urls.get(id);
  await ready();
  const s = cache.get(id);
  if (!s) return null;
  let u = null;
  if (s.store === 'file') u = await photofs.url('doc', key(id), s.store);
  else {
    const b = await snapBlob(id);
    u = b ? URL.createObjectURL(b) : null;
  }
  if (u) {
    if (urls.has(id)) { if (u.startsWith('blob:')) URL.revokeObjectURL(u); return urls.get(id); }   // 그새 다른 호출이 만들었다
    urls.set(id, u);
  }
  return u;
}

function dropUrl(id) {
  const u = urls.get(id);
  if (u?.startsWith('blob:')) URL.revokeObjectURL(u);
  urls.delete(id);
}

export async function removeSnap(id) {
  await ready();
  return serial(async () => {
    const s = cache.get(id);
    if (!s) return;
    await run('readwrite', os => { os.delete(id); });
    cache.delete(id);
    dropUrl(id);
    await photofs.remove('doc', key(id), s.store).catch(e => console.warn('스냅샷 그림을 지우지 못했어요', e));
    changed([id]);
  });
}

// 안 쓰는 스냅샷 정리 — inUse(snap) 가 false 이고 그 자료·쪽의 가장 최근 것이 아니면 지운다(다음 핀이 쓸 수 있게 최근 것은 둔다).
// olderThan(ms): 만든 지 이만큼 지난 것만(기본 1일 — 찍자마자 지우지 않게). → 지운 개수
export async function pruneSnaps(inUse, { olderThan = 864e5, now = Date.now(), keepLatest = true } = {}) {
  await ready();
  const latest = new Set();
  if (keepLatest) for (const s of cache.values()) latest.add(snapFor(s.docId, s.page)?.id);
  let n = 0;
  for (const s of [...cache.values()]) {
    if (latest.has(s.id) || now - s.createdAt < olderThan) continue;
    let used = true;
    try { used = !!inUse(s); } catch { used = true; }
    if (used) continue;
    await removeSnap(s.id);
    n++;
  }
  return n;
}
