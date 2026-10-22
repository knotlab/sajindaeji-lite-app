// 자료함·도면보관함 폴더(사용자 요구 「자료함에 폴더화도 가능하게 해. 관리가 쉽게」) — 두 곳이 같은 폴더 방식(scope 'docs' | 'drawings').
// 별도 IndexedDB `sajindaeji-lite-folders` v1: store `folders`(keyPath id) · `places`(keyPath key). docs·drawings DB 스키마는 건드리지 않는다.
//   Folder = { id:'f_…', scope, name, parentId: null|id, createdAt, updatedAt, order, deletedAt }
//   Place  = { key: scope+':'+itemId, scope, itemId, folderId: null|id, updatedAt }   // 자료·도면이 어느 폴더에 있는지(없으면 맨 위)
// 읽기는 동기(메모리 캐시 + 색인), 쓰기는 직렬 큐 + Promise(docs.js 방식). 한 번 쓰기 = 한 트랜잭션(폴더·배치 같이).
// 지운 폴더는 묘비(deletedAt)로 남긴다 — 백업 합치기에서 되살아나지 않게. 30일 지나면 비운다.
// 폴더가 지워졌거나 없으면(백업 합치기 등) 그 안의 것은 가장 가까운 살아 있는 위 폴더에 있는 것으로 본다(resolve). 합치기로 생긴 순환은 색인에서 끊는다.
// 위쪽(순수 함수)은 DOM·IndexedDB 없이 node 로 시험한다(tests/unit/folders.test.mjs).

export const DB_NAME = 'sajindaeji-lite-folders';
const DB_VER = 1;
export const SCOPES = Object.freeze(['docs', 'drawings']);
export const NAME_MAX = 40;                              // 폴더 이름 글자 수 상한(빵 부스러기·줄이 넘치지 않게)
export const MAX_DEPTH = 8;                              // 맨 위 아래로 8단계까지
export const TOMB_MS = 30 * 24 * 60 * 60 * 1000;         // 지운 폴더 묘비 30일

const fail = (code, message) => Object.assign(new Error(message), { code });
export const MESSAGES = Object.freeze({
  BAD_SCOPE: '폴더 종류가 잘못됐어요',
  EMPTY_NAME: '폴더 이름을 적어 주세요',
  NO_FOLDER: '폴더가 없어요',
  NO_PARENT: '옮길 폴더가 없어요',
  OTHER_SCOPE: '다른 보관함의 폴더예요',
  CYCLE: '폴더를 자기 안으로는 못 옮겨요',
  TOO_DEEP: `폴더는 ${MAX_DEPTH}단계까지 만들 수 있어요`,
});
const err = code => fail(code, MESSAGES[code] || '하지 못했어요');

// =====================================================================
// 순수 부분
// =====================================================================

export const placeKey = (scope, itemId) => `${scope}:${itemId}`;
const ROOT_KEY = 'root';
const kidKey = (scope, parentId) => `${scope}|${parentId || ''}`;
const alive = f => !!f && !f.deletedAt;
const idOf = x => (x && typeof x === 'object' ? x.id : x);
const isFolderId = v => typeof v === 'string' && /^f_[A-Za-z0-9_-]{1,40}$/.test(v);

// 보이지 않는 글자(제어·폭 없는 글자·방향 바꿈·BOM)를 걷고 공백은 하나로(docs.cleanName 과 같은 글자 묶음). 비면 ''
const HIDDEN = new RegExp(`[${[[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]].map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`, 'g');
export function cleanFolderName(s) {
  return String(s ?? '').normalize('NFC').replace(HIDDEN, ' ').replace(/\s+/g, ' ').trim().slice(0, NAME_MAX).trim();
}
const nameKey = s => String(s ?? '').normalize('NFC').toLowerCase();

// 같은 자리에 같은 이름(대소문자 무시)이 있으면 '이름 (2)', '이름 (3)' …  — 이미 '이름 (2)' 꼴이면 그 번호 다음부터
export function uniqueName(name, taken = []) {
  const set = new Set(Array.from(taken, nameKey));
  if (!set.has(nameKey(name))) return name;
  const m = /^(.*\S) \((\d{1,4})\)$/.exec(name);
  const base = m ? m[1] : name;
  let k = m ? Number(m[2]) + 1 : 2;
  while (set.has(nameKey(`${base} (${k})`))) k++;
  return `${base} (${k})`;
}

// 이름순(숫자는 수로: 2층 < 10층), 같으면 order → 만든 순 → id
const coll = typeof Intl !== 'undefined' ? new Intl.Collator('ko', { numeric: true, sensitivity: 'base' }) : null;
export function byName(a, b) {
  return (coll ? coll.compare(a.name, b.name) : (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
    || ((a.order || 0) - (b.order || 0)) || ((a.createdAt || 0) - (b.createdAt || 0)) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

// 색인: 살아 있는 폴더마다 「실제 부모」(eff) — 부모가 지워졌으면 그 위, 없거나 다른 scope 면 맨 위(null), 순환이면 끊는다.
export function indexFolders(list = []) {
  const byId = new Map();
  for (const f of list) if (f && typeof f.id === 'string') byId.set(f.id, f);
  // id 부터(자기 포함) 위로 가며 처음 만나는 살아 있는 같은 scope 폴더. 없거나 순환이면 null
  const up = (id, scope) => {
    const seen = new Set();
    while (id) {
      if (seen.has(id)) return null;
      seen.add(id);
      const f = byId.get(id);
      if (!f || f.scope !== scope) return null;
      if (alive(f)) return id;
      id = f.parentId || null;
    }
    return null;
  };
  const eff = new Map();
  for (const f of byId.values()) if (alive(f)) eff.set(f.id, up(f.parentId || null, f.scope));
  // 살아 있는 폴더끼리의 순환(두 기기에서 서로 안으로 옮긴 뒤 합치기) — 순환 안에서 id 가 가장 작은 것을 맨 위로
  for (const start of eff.keys()) {
    const at = new Map(), path = [];
    let cur = start;
    while (cur) {
      if (at.has(cur)) { const cut = path.slice(at.get(cur)).sort()[0]; eff.set(cut, null); break; }
      at.set(cur, path.length); path.push(cur);
      cur = eff.get(cur) ?? null;
    }
  }
  const kids = new Map();
  for (const [id, p] of eff) {
    const f = byId.get(id), k = kidKey(f.scope, p);
    (kids.get(k) || kids.set(k, []).get(k)).push(f);
  }
  for (const arr of kids.values()) arr.sort(byName);
  const resolve = (id, scope = null) => {
    if (!id) return null;
    const f = byId.get(id);
    if (!f || (scope && f.scope !== scope)) return null;
    return up(id, f.scope);
  };
  return { byId, eff, kids, resolve };
}

export const childrenOf = (idx, scope, parentId = null) => idx.kids.get(kidKey(scope, parentId || null)) || [];

// [맨 위 다음 폴더 … 이 폴더] — 맨 위·없는 폴더면 []. 지운 폴더면 가장 가까운 살아 있는 위 폴더까지
export function pathOf(idx, id) {
  const out = [];
  let cur = idx.resolve(id);
  const seen = new Set();
  while (cur && !seen.has(cur)) { seen.add(cur); out.push(idx.byId.get(cur)); cur = idx.eff.get(cur) ?? null; }
  return out.reverse();
}
const depthOf = (idx, id) => pathOf(idx, id).length;                         // 맨 위 = 0, 첫 단 폴더 = 1
function heightOf(idx, id) {                                                 // 자기 포함 아래로 몇 단(빈 폴더 = 1)
  const f = idx.byId.get(id);
  if (!alive(f)) return 0;
  let h = 0;
  for (const k of childrenOf(idx, f.scope, id)) h = Math.max(h, heightOf(idx, k.id));
  return h + 1;
}
// id 가 anc 이거나 그 아래에 있나
export function isInside(idx, id, anc) {
  let cur = idx.resolve(id);
  const seen = new Set();
  while (cur && !seen.has(cur)) { if (cur === anc) return true; seen.add(cur); cur = idx.eff.get(cur) ?? null; }
  return false;
}
// 폴더 옮기기 검사 → null(된다) | 'NO_FOLDER' | 'NO_PARENT' | 'OTHER_SCOPE' | 'CYCLE' | 'SAME' | 'TOO_DEEP'
export function checkMove(idx, id, to) {
  const f = idx.byId.get(id);
  if (!alive(f)) return 'NO_FOLDER';
  to = to && to !== ROOT_KEY ? to : null;
  if (to) {
    const t = idx.byId.get(to);
    if (!alive(t)) return 'NO_PARENT';
    if (t.scope !== f.scope) return 'OTHER_SCOPE';
    if (isInside(idx, to, id)) return 'CYCLE';
  }
  if ((idx.eff.get(id) ?? null) === to) return 'SAME';
  if ((to ? depthOf(idx, to) : 0) + heightOf(idx, id) > MAX_DEPTH) return 'TOO_DEEP';
  return null;
}

// 자료 하나가 있는 폴더(살아 있는 폴더로 맞춤) — 맨 위면 null
export function placeOf(idx, places, scope, itemId) {
  const p = places.get(placeKey(scope, itemId));
  return p && p.folderId ? idx.resolve(p.folderId, scope) : null;
}
// all(id 나 {id} 목록) 중 folderId 에 있는 것만 — 받은 모양 그대로 돌려준다. folderId null|'root' = 맨 위(배치 없는 것 포함)
export function pickIn(idx, places, scope, folderId, all = []) {
  const want = folderId && folderId !== ROOT_KEY ? folderId : null;
  return Array.from(all).filter(x => placeOf(idx, places, scope, idOf(x)) === want);
}
// { [folderId]: { folders, items }, root: { folders, items } } — 바로 안의 것. deep 이면 아래 폴더까지 합계.
// items(살아 있는 자료 id·{id} 목록)를 주면 그것만 센다(휴지통 자료 빼기, 맨 위 자료 수). 안 주면 배치 기록으로만(맨 위 items 는 모름 → 0)
export function countIn(idx, places, scope, { deep = false, items = null } = {}) {
  const out = { [ROOT_KEY]: { folders: childrenOf(idx, scope, null).length, items: 0 } };
  for (const [id] of idx.eff) { const f = idx.byId.get(id); if (f.scope === scope) out[id] = { folders: childrenOf(idx, scope, id).length, items: 0 }; }
  const bump = fid => { (out[fid || ROOT_KEY] || out[ROOT_KEY]).items++; };
  if (items) { for (const x of items) bump(placeOf(idx, places, scope, idOf(x))); }
  else for (const p of places.values()) { if (p.scope === scope && p.folderId) { const fid = idx.resolve(p.folderId, scope); if (fid) bump(fid); } }
  if (!deep) return out;
  const sum = id => {
    const self = out[id || ROOT_KEY];
    const acc = { folders: 0, items: self.items };
    for (const k of childrenOf(idx, scope, id)) { const s = sum(k.id); acc.folders += 1 + s.folders; acc.items += s.items; }
    out[id || ROOT_KEY] = acc;
    return acc;
  };
  sum(null);
  return out;
}

// 지우기 계획: 폴더는 묘비, 바로 안의 폴더·자료는 부모로 올림(이름이 겹치면 '이름 (2)'). token 으로 되돌린다
export function planDelete(idx, places, id, now = Date.now()) {
  const f = idx.byId.get(id);
  if (!alive(f)) throw err('NO_FOLDER');
  const to = idx.eff.get(id) ?? null;
  const taken = childrenOf(idx, f.scope, to).filter(x => x.id !== id).map(x => x.name);
  const folders = [{ ...f, deletedAt: now, updatedAt: now }];
  const kids = [];
  for (const k of childrenOf(idx, f.scope, id)) {
    const name = uniqueName(k.name, taken);
    taken.push(name);
    kids.push({ id: k.id, name: k.name });
    folders.push({ ...k, parentId: to, name, updatedAt: now });
  }
  const moved = [], outPlaces = [];
  for (const p of places.values()) {
    if (p.scope !== f.scope || !p.folderId || idx.resolve(p.folderId, f.scope) !== id) continue;
    moved.push({ key: p.key, folderId: p.folderId });
    outPlaces.push({ ...p, folderId: to, updatedAt: now });
  }
  return { folders, places: outPlaces, token: { v: 1, id, scope: f.scope, name: f.name, to, at: now, kids, places: moved } };
}
// 되돌리기 계획: 그사이 사용자가 다른 데로 옮긴 것은 건드리지 않는다
export function planUndo(idx, places, token, now = Date.now()) {
  const f = token && idx.byId.get(token.id);
  if (!f) throw err('NO_FOLDER');
  const folders = [], outPlaces = [];
  if (f.deletedAt) {
    const at = idx.resolve(f.parentId, f.scope);
    const name = uniqueName(token.name || f.name, childrenOf(idx, f.scope, at).map(x => x.name));
    folders.push({ ...f, name, deletedAt: null, updatedAt: now });
  }
  for (const k of token.kids || []) {
    const cur = idx.byId.get(k.id);
    if (!alive(cur) || (idx.eff.get(k.id) ?? null) !== (token.to ?? null)) continue;
    folders.push({ ...cur, parentId: token.id, name: k.name, updatedAt: now });
  }
  for (const m of token.places || []) {
    const cur = places.get(m.key);
    if (!cur || (cur.folderId ?? null) !== (token.to ?? null)) continue;
    outPlaces.push({ ...cur, folderId: m.folderId, updatedAt: now });
  }
  return { folders, places: outPlaces };
}

// ---- 백업(작은 JSON: 폴더 + 배치, 묘비 포함) ----
export const DUMP_V = 1;
export function makeFolderDump(folderList = [], placeList = []) {
  return { v: DUMP_V, folders: folderList.map(f => ({ ...f })), places: placeList.map(p => ({ ...p })) };
}
const num = v => (Number.isFinite(v) ? v : 0);
function cleanFolder(f) {
  if (!f || typeof f !== 'object' || !isFolderId(f.id) || !SCOPES.includes(f.scope)) return null;
  const name = cleanFolderName(f.name);
  if (!name) return null;
  return { id: f.id, scope: f.scope, name, parentId: isFolderId(f.parentId) ? f.parentId : null,
    createdAt: num(f.createdAt), updatedAt: num(f.updatedAt), order: num(f.order), deletedAt: Number.isFinite(f.deletedAt) ? f.deletedAt : null };
}
function cleanPlace(p) {
  if (!p || typeof p !== 'object' || !SCOPES.includes(p.scope) || typeof p.itemId !== 'string' || !p.itemId) return null;
  if (p.key !== placeKey(p.scope, p.itemId)) return null;
  return { key: p.key, scope: p.scope, itemId: p.itemId, folderId: isFolderId(p.folderId) ? p.folderId : null, updatedAt: num(p.updatedAt) };
}
// 둘 중 새것(updatedAt) — 같으면 이 기기 것. → { folders: 바뀔 것, places: 바뀔 것, added, updated, skipped }
export function mergeFolderDump(cur = { folders: [], places: [] }, inc = {}) {
  const out = { folders: [], places: [], added: 0, updated: 0, skipped: 0 };
  if (!inc || typeof inc !== 'object' || !Number.isFinite(inc.v) || inc.v > DUMP_V) return { ...out, bad: true };
  const fm = new Map((cur.folders || []).map(f => [f.id, f]));
  for (const raw of Array.isArray(inc.folders) ? inc.folders : []) {
    const f = cleanFolder(raw);
    if (!f) { out.skipped++; continue; }
    const c = fm.get(f.id);
    if (!c) { out.folders.push(f); out.added++; } else if (f.updatedAt > num(c.updatedAt)) { out.folders.push(f); out.updated++; } else out.skipped++;
  }
  const pm = new Map((cur.places || []).map(p => [p.key, p]));
  for (const raw of Array.isArray(inc.places) ? inc.places : []) {
    const p = cleanPlace(raw);
    if (!p) { out.skipped++; continue; }
    const c = pm.get(p.key);
    if (!c) { out.places.push(p); out.added++; } else if (p.updatedAt > num(c.updatedAt)) { out.places.push(p); out.updated++; } else out.skipped++;
  }
  return out;
}

// =====================================================================
// 저장소 부분(브라우저)
// =====================================================================

let dbName = DB_NAME, dbP = null;
let fcache = new Map();          // id → Folder(얼림, 묘비 포함)
let pcache = new Map();          // key → Place(얼림)
let idx = indexFolders([]);
let queue = Promise.resolve();
const subs = new Set();
const pend = { folders: false, places: false };
let notifyQueued = false;

const uid = () => 'f_' + Array.from(crypto.getRandomValues(new Uint8Array(6)), b => b.toString(36).padStart(2, '0')).join('').slice(0, 8);
const reqP = rq => new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });

function openDb() {
  if (dbP) return dbP;
  dbP = new Promise((resolve, reject) => {
    const rq = indexedDB.open(dbName, DB_VER);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('places')) db.createObjectStore('places', { keyPath: 'key' });
    };
    rq.onsuccess = () => {
      const db = rq.result;
      const drop = () => { dbP = null; try { db.close(); } catch { /* 이미 닫힘 */ } };
      db.onclose = drop;                 // 웹뷰가 강제로 닫음(메모리 압박) → 다음 쓰기에서 다시 연다
      db.onversionchange = drop;
      resolve(db);
    };
    rq.onerror = () => { dbP = null; reject(rq.error); };
    rq.onblocked = () => console.warn('폴더 DB 열기가 막혔어요(다른 탭)');
  });
  return dbP;
}

async function run(mode, fn) {
  for (let i = 0; ; i++) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const t = db.transaction(['folders', 'places'], mode);
        let out;
        Promise.resolve(fn(t.objectStore('folders'), t.objectStore('places'))).then(v => { out = v; }, reject);
        t.oncomplete = () => resolve(out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('abort'));
      });
    } catch (e) {
      if (e?.name === 'QuotaExceededError') throw Object.assign(e, { code: 'QUOTA' });
      const closed = e?.name === 'InvalidStateError' || /clos/i.test(e?.message || '');
      if (!closed || i >= 1) throw e;
      dbP = null;                         // 연결이 닫혀 있었다 — 다시 열고 한 번 더
    }
  }
}

function serial(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}
// 쓰기는 캐시를 다 읽은 뒤에(부팅 복원의 mergeFolders·자료 영구 삭제의 forget 이 화면보다 먼저 와도 맞게). ready() 는 직렬 큐 밖에서 기다린다(init 이 큐를 쓴다)
const write = fn => ready().then(() => serial(fn));

function changed(what) {
  if (what.folders) pend.folders = true;
  if (what.places) pend.places = true;
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    const ev = { folders: pend.folders, places: pend.places };
    pend.folders = pend.places = false;
    for (const fn of [...subs]) { try { fn(ev); } catch (e) { console.error(e); } }
  });
}

// 한 번에 한 트랜잭션: 폴더·배치 넣기 + 배치 빼기 → 캐시·색인 → 알림
async function commit({ folders = [], places = [], dropPlaces = [], dropFolders = [] } = {}) {
  if (!folders.length && !places.length && !dropPlaces.length && !dropFolders.length) return;
  const fz = folders.map(f => Object.freeze({ ...f }));
  const pz = places.map(p => Object.freeze({ ...p }));
  await run('readwrite', (fs, ps) => {
    for (const f of fz) fs.put(f);
    for (const p of pz) ps.put(p);
    for (const k of dropPlaces) ps.delete(k);
    for (const id of dropFolders) fs.delete(id);
  });
  for (const f of fz) fcache.set(f.id, f);
  for (const id of dropFolders) fcache.delete(id);
  for (const p of pz) pcache.set(p.key, p);
  for (const k of dropPlaces) pcache.delete(k);
  if (fz.length || dropFolders.length) idx = indexFolders([...fcache.values()]);
  changed({ folders: !!(fz.length || dropFolders.length), places: !!(pz.length || dropPlaces.length) });
}

const checkScope = scope => { if (!SCOPES.includes(scope)) throw err('BAD_SCOPE'); };
const normParent = id => (id && id !== ROOT_KEY ? id : null);

// ---- 시작 ----
// 부팅에서 부르지 않아도 된다 — 처음 쓰는 화면이 ready() 로 한 번만 연다(사진 앱 부팅을 늦추지 않게)
let initP = null;
export function initFolders(opts = {}) {
  initP = initImpl(opts);
  initP.catch(() => { initP = null; });
  return initP;
}
export function ready() { return initP || initFolders(); }
async function initImpl({ dbName: name, now = Date.now() } = {}) {
  if (name && name !== dbName) { dbName = name; dbP = null; }
  const [fl, pl] = await run('readonly', (fs, ps) => Promise.all([reqP(fs.getAll()), reqP(ps.getAll())]));
  fcache = new Map(fl.map(f => [f.id, Object.freeze(f)]));
  pcache = new Map(pl.map(p => [p.key, Object.freeze(p)]));
  idx = indexFolders([...fcache.values()]);
  // 30일 지난 묘비 비우기 — 아직 그 묘비를 부모로 둔 것(합치기로 들어온 것)이 있으면 남긴다
  const old = [...fcache.values()].filter(f => f.deletedAt && now - f.deletedAt > TOMB_MS
    && ![...fcache.values()].some(x => x.parentId === f.id) && ![...pcache.values()].some(p => p.folderId === f.id));
  if (old.length) await serial(() => commit({ dropFolders: old.map(f => f.id) })).catch(e => console.warn('지난 폴더 묘비를 비우지 못했어요', e));
  changed({ folders: true, places: true });
}

// fn({ folders: bool, places: bool }) — 한 틱에 한 번. 해제 함수를 돌려준다
export function onFolders(fn) { subs.add(fn); return () => { subs.delete(fn); }; }

// ---- 읽기(동기) ----
export function folders(scope, parentId = null) { return childrenOf(idx, scope, normParent(parentId)).slice(); }
// 그 scope 의 살아 있는 폴더 전부(이름순 아님 — 찾기·pickFolder 용)
export function allFolders(scope) { return [...idx.eff.keys()].map(id => idx.byId.get(id)).filter(f => f.scope === scope); }
// 묘비도 돌려준다(deletedAt 으로 안다). 화면이 「지금 폴더」를 고를 때는 resolveFolder
export function folder(id) { return id ? fcache.get(id) : undefined; }
export function resolveFolder(id) { return idx.resolve(normParent(id)); }
export function path(id) { return pathOf(idx, normParent(id)); }
// 폴더의 실제 부모(맨 위면 null)
export function parentOf(id) { return idx.eff.get(id) ?? null; }
export function folderOf(scope, itemId) { return placeOf(idx, pcache, scope, itemId); }
export function itemsIn(scope, folderId, allItemIds = []) { return pickIn(idx, pcache, scope, normParent(folderId), allItemIds); }
export function counts(scope, opts = {}) { return countIn(idx, pcache, scope, opts); }
export function canMove(id, to) { return checkMove(idx, id, normParent(to)); }

// ---- 쓰기 ----
export function createFolder(scope, parentId, name, now = Date.now()) {
  return write(async () => {
    checkScope(scope);
    const p = normParent(parentId);
    if (p) {
      const pf = fcache.get(p);
      if (!alive(pf)) throw err('NO_PARENT');
      if (pf.scope !== scope) throw err('OTHER_SCOPE');
      if (depthOf(idx, p) + 1 > MAX_DEPTH) throw err('TOO_DEEP');
    }
    const n = cleanFolderName(name);
    if (!n) throw err('EMPTY_NAME');
    let id = uid();
    while (fcache.has(id)) id = uid();
    const f = { id, scope, name: uniqueName(n, childrenOf(idx, scope, p).map(x => x.name)), parentId: p, createdAt: now, updatedAt: now, order: 0, deletedAt: null };
    await commit({ folders: [f] });
    return fcache.get(id);
  });
}

export function renameFolder(id, name, now = Date.now()) {
  return write(async () => {
    const f = fcache.get(id);
    if (!alive(f)) throw err('NO_FOLDER');
    const n = cleanFolderName(name);
    if (!n) throw err('EMPTY_NAME');
    if (n === f.name) return f;
    const sib = childrenOf(idx, f.scope, idx.eff.get(id) ?? null).filter(x => x.id !== id).map(x => x.name);
    await commit({ folders: [{ ...f, name: uniqueName(n, sib), updatedAt: now }] });
    return fcache.get(id);
  });
}

// 자기 아래로는 못 옮긴다(CYCLE). 같은 자리면 그대로. 옮긴 자리에 같은 이름이 있으면 '이름 (2)'
export function moveFolder(id, newParentId, now = Date.now()) {
  return write(async () => {
    const to = normParent(newParentId);
    const why = checkMove(idx, id, to);
    if (why === 'SAME') return fcache.get(id);
    if (why) throw err(why);
    const f = fcache.get(id);
    const name = uniqueName(f.name, childrenOf(idx, f.scope, to).map(x => x.name));
    await commit({ folders: [{ ...f, parentId: to, name, updatedAt: now }] });
    return fcache.get(id);
  });
}

// → token(되돌리기용 이전 배치). 안의 폴더·자료는 부모 폴더로 올라간다
export function deleteFolder(id, now = Date.now()) {
  return write(async () => {
    const plan = planDelete(idx, pcache, id, now);
    await commit({ folders: plan.folders, places: plan.places });
    return Object.freeze({ ...plan.token, moved: { folders: plan.token.kids.length, items: plan.token.places.length } });
  });
}
export function undoDelete(token, now = Date.now()) {
  return write(async () => {
    const plan = planUndo(idx, pcache, token, now);
    await commit({ folders: plan.folders, places: plan.places });
    return { folders: plan.folders.length, items: plan.places.length };
  });
}

// 여러 개 한 번에. folderId null|'root' = 맨 위. → { moved, undo() }(undo = 그새 다시 옮기지 않은 것만 이전 자리로)
export function placeItems(scope, itemIds, folderId, now = Date.now()) {
  return write(async () => {
    checkScope(scope);
    const to = normParent(folderId);
    if (to) {
      const f = fcache.get(to);
      if (!alive(f)) throw err('NO_PARENT');
      if (f.scope !== scope) throw err('OTHER_SCOPE');
    }
    const prev = [], list = [];
    const seen = new Set();
    for (const raw of Array.from(itemIds || [])) {
      const itemId = idOf(raw);
      if (typeof itemId !== 'string' || !itemId || seen.has(itemId)) continue;
      seen.add(itemId);
      const key = placeKey(scope, itemId);
      const cur = pcache.get(key);
      if ((placeOf(idx, pcache, scope, itemId) ?? null) === to && (cur?.folderId ?? null) === to) continue;
      prev.push({ itemId, folderId: cur?.folderId ?? null });
      list.push({ key, scope, itemId, folderId: to, updatedAt: now });
    }
    await commit({ places: list });
    const undo = () => serial(async () => {
      const back = prev.filter(x => (pcache.get(placeKey(scope, x.itemId))?.folderId ?? null) === to)
        .map(x => ({ key: placeKey(scope, x.itemId), scope, itemId: x.itemId, folderId: x.folderId, updatedAt: Date.now() }));
      await commit({ places: back });
      return back.length;
    });
    return { moved: list.length, undo };
  });
}

// 자료·도면이 영구 삭제될 때(휴지통 비우기·purge) — 배치 기록을 지운다. itemId 하나나 목록
export function forget(scope, itemId) {
  return write(async () => {
    const keys = (Array.isArray(itemId) ? itemId : [itemId]).map(x => placeKey(scope, idOf(x))).filter(k => pcache.has(k));
    await commit({ dropPlaces: keys });
    return keys.length;
  });
}

// ---- 백업 ----
export function dumpFolders() { return makeFolderDump([...fcache.values()], [...pcache.values()]); }
export function mergeFolders(json) {
  return write(async () => {
    let inc = json;
    if (typeof json === 'string') { try { inc = JSON.parse(json); } catch { inc = null; } }
    const r = mergeFolderDump({ folders: [...fcache.values()], places: [...pcache.values()] }, inc);
    if (r.bad) return { added: 0, updated: 0, skipped: 0, bad: true };
    await commit({ folders: r.folders, places: r.places });
    return { added: r.added, updated: r.updated, skipped: r.skipped };
  });
}

export function usage() { return { folders: idx.eff.size, places: pcache.size }; }
