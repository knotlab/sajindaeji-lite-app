// IndexedDB 관문 — 사진 DB `sajindaeji-lite` v1(설계서 §4.1·§5.3). 다른 모듈은 store.js 만 쓴다(photofs 의 IDB 폴백만 여기를 직접 쓴다).
// 원본 현장사진대지 store.js 의 idb()·run()·tx() 를 옮겼다(공시체 2026-08 실사고): 웹뷰가 메모리·저장소 압박으로 연결을 강제로 닫으면
// 죽은 연결을 물고 있는 동안 모든 조회·쓰기가 실패하고 화면엔 기록이 다 사라진 것처럼 보인다 → 닫히면 버리고, 다음 호출에서 다시 연다.
export const DB_NAME = 'sajindaeji-lite';
export const DB_VERSION = 1;
export const STORES = ['records', 'photos', 'blobs', 'meta'];

let name = DB_NAME;
let dbp = null;                 // 열린(또는 여는 중인) 연결 약속

// 시험용 — 다른 이름의 DB 를 쓴다(열린 연결은 닫는다)
export function setDbName(n) {
  if (n === name) return;
  closeDb();
  name = n || DB_NAME;
}
export const dbName = () => name;

export function openDb() {
  if (dbp) return dbp;
  const p = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(Object.assign(new Error('이 환경에서는 저장소를 쓸 수 없어요'), { code: 'NO_IDB' })); return; }
    const req = indexedDB.open(name, DB_VERSION);
    req.onupgradeneeded = () => {                                            // 없는 스토어만 만든다 — 있는 데이터는 건드리지 않는다
      const db = req.result;
      if (!db.objectStoreNames.contains('records')) db.createObjectStore('records', { keyPath: 'id' }).createIndex('day', 'day');
      if (!db.objectStoreNames.contains('photos')) db.createObjectStore('photos', { keyPath: 'id' }).createIndex('recordId', 'recordId');
      if (!db.objectStoreNames.contains('blobs')) db.createObjectStore('blobs', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
    };
    req.onsuccess = () => {
      const db = req.result;
      // 다른 탭이 버전을 올리거나 DB 를 지우려 하면 비켜 준다(안 비키면 그쪽이 blocked 로 멈춘다)
      db.onversionchange = () => { try { db.close(); } catch { /* 이미 닫힘 */ } if (dbp === p) dbp = null; };
      db.onclose = () => { db.__closed = true; if (dbp === p) dbp = null; };   // 강제로 닫힘 — 다음 호출이 다시 연다
      resolve(db);
    };
    req.onerror = () => {
      const err = req.error || new Error('저장소를 열지 못했어요');
      if (err.name === 'VersionError') { err.code = 'VERSION'; err.userMsg = '앱이 데이터보다 오래됐어요 — 최신으로 설치해 주세요'; }   // 빈 목록으로 보이면 증발로 오인한다
      reject(err);
    };
    req.onblocked = () => reject(Object.assign(new Error('저장소를 다른 곳에서 쓰고 있어요'), { code: 'BLOCKED' }));
  });
  dbp = p;
  p.catch(() => { if (dbp === p) dbp = null; });                             // 실패한 약속을 물고 있으면 세션 내내 저장이 죽는다
  return p;
}

// 시험·DB 지우기 전 — 연결을 닫고 버린다
export function closeDb() {
  const p = dbp;
  dbp = null;
  p?.then(db => { try { db.close(); } catch { /* 이미 닫힘 */ } }, () => {});
}

// 모든 접근의 관문. 연결이 이미 죽어 transaction() 이 동기로 던지면(InvalidStateError) 한 번 다시 열어 재시도한다
function run(fn) {
  return openDb().then(db => {
    try { return fn(db); }
    catch (e) {
      if (e?.name === 'InvalidStateError') { dbp = null; return openDb().then(fn); }
      throw e;
    }
  });
}

// 저장 공간 부족은 err.code = 'QUOTA'(§5.3)
function wrapErr(e, fallback) {
  const err = e || new Error(fallback);
  if (err.name === 'QuotaExceededError' || /quota/i.test(err.message || '')) {
    const q = new Error('저장 공간이 모자라요');
    q.code = 'QUOTA'; q.cause = err;
    return q;
  }
  return err;
}

// IDBRequest(또는 그 배열·객체)를 결과 값으로
function results(v) {
  if (typeof IDBRequest !== 'undefined' && v instanceof IDBRequest) return v.result;
  if (Array.isArray(v)) return v.map(results);
  if (v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype) {
    const o = {};
    for (const [k, x] of Object.entries(v)) o[k] = results(x);
    return o;
  }
  return v;
}

// fn(t) 은 동기여야 한다(await 를 쓰면 트랜잭션이 먼저 끝난다). 커밋이 끝나야(oncomplete) resolve —
// fn 이 돌려준 IDBRequest(배열·객체 안의 것 포함)는 그 결과 값으로 바꿔 돌려준다
// 진행 중이던 트랜잭션이 연결 강제 종료로 abort 되면(AbortError·UnknownError·InvalidStateError + onclose) 다시 열어 한 번 더 —
// fn 은 put/delete 뿐이라 두 번 해도 같다(§4.5-1)
const RETRY_ERR = new Set(['AbortError', 'UnknownError', 'InvalidStateError']);
export function tx(stores, mode, fn, retried = false) {
  const names = Array.isArray(stores) ? stores : [stores];
  return run(db => {
    const t = db.transaction(names, mode);
    return new Promise((resolve, reject) => {
      let out, done = false;
      const fail = (raw, fallback) => {
        if (done) return;
        done = true;
        const name = raw?.name || 'AbortError';
        if (!retried && RETRY_ERR.has(name) && (db.__closed || dbp === null)) {
          dbp = null;
          console.warn('저장소 연결이 닫혀 다시 시도해요', name);
          tx(stores, mode, fn, true).then(resolve, reject);
          return;
        }
        reject(wrapErr(raw, fallback));
      };
      t.oncomplete = () => { done = true; resolve(results(out)); };
      t.onerror = e => fail(t.error || e?.target?.error, '저장소 오류');
      t.onabort = () => fail(t.error, '저장이 중단됐어요');
      try { out = fn(t); } catch (e) { try { t.abort(); } catch { /* 이미 끝남 */ } done = true; reject(wrapErr(e, '저장소 오류')); }
    });
  });
}

export const getAll = store => tx([store], 'readonly', t => t.objectStore(store).getAll());
export const getAllKeys = store => tx([store], 'readonly', t => t.objectStore(store).getAllKeys());
export const get = (store, key) => tx([store], 'readonly', t => t.objectStore(store).get(key));
export const put = (store, value) => tx([store], 'readwrite', t => { t.objectStore(store).put(value); });
export const del = (store, key) => tx([store], 'readwrite', t => { t.objectStore(store).delete(key); });
