// 저장소 — 메타데이터는 IndexedDB(db.js), 사진 본체는 파일(photofs.js). 화면은 동기 캐시를 읽는다(설계서 §4·§5.3).
// 원본 현장사진대지 store.js 방식: 쓰기는 한 줄로 세워 하나씩(읽기-수정-쓰기가 겹쳐 rev·사진 순서가 사라지지 않게),
// 캐시는 IDB 트랜잭션이 끝난 뒤에만 바꾸고, 캐시 레코드는 얼린 새 객체로 갈아 끼운다. 알림은 같은 틱 변경을 한 번에 묶는다.
// 사진은 §4.5(공시체 BUGREPORT): 셔터 결과 원본을 incoming 파일에 먼저 쓰고 메타(processing)+photoIds 를 같이 저장 → 작업본·썸네일 → ready → incoming 삭제.
//   APK 갤러리 원본이 필요한 사진은 ready 뒤에도 incoming 을 남겼다가(finishPhoto keepIncoming) 갤러리에 넣은 뒤 releaseIncoming(속도 감사 #7 — 원본 사본 단계 없앰).
// 도면 핀(v0.1.4): 핀은 도면보관함(data/drawings.js) 한 곳에만. 묶음에는 연결 표지 record.pin = { drawingId, pinId } | null 만.
// 순서(v0.1.7, 계산은 core/order.js 한 곳): 하루 묶음 순서 = record.order(분수 ms, 없으면 createdAt — 0.1.5 기록은 이주 없음). recordsOfDay·days 는 사진대지 순서,
//   새 묶음은 그 날 맨 끝(nextOrder — 지금 시각과 같으면 칸을 쓰지 않는다), 바꾸기는 reorderRecords(옮긴 묶음만 rev+1)·reorderPhotos(photoIds — 1번이 대표) 만.
//   updateRecord 로는 순서를 바꾸지 못한다. 합치기(merge)의 photoIds 는 이긴 쪽 순서 + 진 쪽에만 있는 사진(order.mergeIds).
import * as self from './store.js';
import * as db from './db.js';
import * as fs from './photofs.js';
import { uid, newRecord, newPhoto, touch, recordNo } from '../core/model.js';
import { compareOrder, nextOrder, planOrder, reorderTo, mergeIds } from '../core/order.js';
import { mergeRecord, mergePhoto, cleanRecordPin } from '../core/backup.js';
import { TRASH_DAYS } from '../config.js';
import { dayKey } from '../core/date.js';

const DAY = 864e5;
export const DEFAULT_SETTINGS = Object.freeze({
  siteName: '', author: '', wmMode: 'loc+content', wmOnScreen: true, wmDate: true,
  captureMode: 'incam', photoRatio: '4:3', saveToGallery: true, galleryPref: 'sd', vworldKey: '',
  captureHiRes: false,                                                         // 켜면 takePhoto(느림), 끄면 미리보기 프레임 즉시 잡기(§5.4)
  captureStage: 'shared',                                                      // 'shared' 같은 창(바꾸기 단추, v0.1.6 기본) | 'split' 작은 창(나란히 보기)
  stageAutoReturn: false,                                                      // 같은 창: 마지막 셔터 4초 뒤 도면으로(v0.1.6 기본 끔)
  captureStagePicked: false,                                                   // 설정 화면에서 배치를 직접 고름 — 아니면 저장된 captureStage 를 보지 않는다(아래 settings())
  stageAutoPicked: false,                                                      // 설정 화면에서 자동 돌아가기를 직접 바꿈 — 아니면 저장된 stageAutoReturn 을 보지 않는다
  wmWhen: 'datetime',                                                          // 촬영 일시: 'datetime' 날짜+시간 | 'date' 날짜만 | 'off' 안 넣기(옛 wmDate 는 읽기 호환용으로 남김)
});
const RECORD_EDIT = ['location', 'content'];                                  // updateRecord 로 바꿀 수 있는 글 칸 — 번호·rev·묶음 순서(order)·사진 순서·휴지통은 전용 함수 몫
export { cleanRecordPin };                                                   // 도면 핀 연결 모양 확인(core/backup.js)
const PHOTO_FIXED = ['id', 'recordId', 'state', 'store', 'deletedAt', 'createdAt'];
const PURGED_MAX = 2000;                                                     // 영구 삭제한 묶음 id 기억(복원 제안이 지운 것을 「잃어버린 것」으로 보지 않게)
const PURGED_PHOTOS_MAX = 5000;                                              // 영구 삭제한 사진 id 기억(meta purgedPhotoIds) — 옛 백업을 합쳐도 되살리지 않게(merge)

const cache = { records: new Map(), photos: new Map(), meta: new Map() };
const photoIdx = new Map();                                                  // recordId → Set(photoId)
const urls = new Map();                                                      // `${id}:${kind}` → 화면 주소 캐시(웹 objectURL, APK 예전 사진의 convertFileSrc 주소)
const listeners = new Set();
let ready = false, openP = null, writeTail = Promise.resolve();

// ---- 도우미 ----
const clone = v => (v === undefined ? v : structuredClone(v));
function deepFreeze(o) {
  if (o && typeof o === 'object' && !ArrayBuffer.isView(o) && !Object.isFrozen(o)) { Object.freeze(o); for (const v of Object.values(o)) deepFreeze(v); }
  return o;
}
function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every(k => same(a[k], b[k]));
}
const num = v => (Number.isFinite(v) ? v : 0);
const sizeOf = v => (v == null ? 0 : typeof v.size === 'number' ? v.size : (v.byteLength ?? 0));
function fail(code, msg) { return Object.assign(new Error(msg), { code }); }
function idxAdd(rid, id) { let s = photoIdx.get(rid); if (!s) photoIdx.set(rid, s = new Set()); s.add(id); }
function idxDel(rid, id) { const s = photoIdx.get(rid); if (s && s.delete(id) && !s.size) photoIdx.delete(rid); }
function setPhotoCache(p) { const old = cache.photos.get(p.id); if (old) idxDel(old.recordId, p.id); cache.photos.set(p.id, deepFreeze(p)); idxAdd(p.recordId, p.id); }
function dropPhotoCache(id) { const old = cache.photos.get(id); if (old) idxDel(old.recordId, id); cache.photos.delete(id); }
function freshId(prefix, map) { for (;;) { const id = uid(prefix); if (!map.has(id)) return id; } }   // 같은 id 로 put 하면 조용히 덮어쓴다 — 있으면 다시 뽑는다
function dropUrl(key) {                                                      // objectURL 만 해제(파일 주소는 해제할 것이 없다)
  const u = urls.get(key);
  if (u === undefined) return;
  urls.delete(key);
  if (typeof u === 'string' && u.startsWith('blob:')) { try { URL.revokeObjectURL(u); } catch { /* 없음 */ } }
}

// ---- 알림(마이크로태스크 묶음) ----
let pending = null;
function note({ records = [], photos = [], settings = false, meta = [] }) {
  if (!pending) {
    pending = { records: new Set(), photos: new Set(), settings: false, meta: new Set() };
    queueMicrotask(() => {
      const ev = pending;
      pending = null;
      for (const fn of listeners) { try { fn(ev); } catch (e) { console.error(e); } }
    });
  }
  records.forEach(id => id && pending.records.add(id));
  photos.forEach(id => id && pending.photos.add(id));
  if (settings) pending.settings = true;
  meta.forEach(k => pending.meta.add(k));
}
export function on(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// ---- 수명 ----
async function load() {
  ready = false;
  for (const m of Object.values(cache)) m.clear();
  photoIdx.clear();
  const [rs, ps, ms] = await db.tx(['records', 'photos', 'meta'], 'readonly', t => [
    t.objectStore('records').getAll(), t.objectStore('photos').getAll(), t.objectStore('meta').getAll(),
  ]);
  rs.forEach(r => cache.records.set(r.id, deepFreeze(r)));
  ps.forEach(setPhotoCache);
  ms.forEach(m => cache.meta.set(m.key, deepFreeze(m.value)));
  ready = true;
}

// dbName: 시험용. fsKind: 시험용 photofs 강제('idb' 등)
export async function init({ now = Date.now(), dbName, fsKind } = {}) {
  if (dbName && dbName !== db.dbName()) { db.setDbName(dbName); openP = null; }
  if (!openP) {
    openP = (async () => {
      await fs.initPhotoFs(fsKind ? { force: fsKind } : {});
      await load();
      if (!cache.meta.get('installId')) await setMeta('installId', uid('i'));
      try { navigator.storage?.persist?.().catch(() => {}); } catch { /* 없음 */ }   // 브라우저가 비울 수 있는 저장소를 지켜 달라고(웹뷰에선 무력)
      await sweepTrash(now).catch(e => console.error('휴지통 정리 실패', e));
    })().catch(e => { openP = null; ready = false; throw e; });
  }
  await openP;
  globalThis.__lite = Object.assign(globalThis.__lite || {}, { store: self });
  return { records: cache.records.size, photos: cache.photos.size, fs: fs.fsKind() };
}

// 시험·DB 지우기 전 — 캐시를 비우고 연결을 닫는다. 다음 init 이 다시 연다
export async function close() {
  await flush();
  ready = false; openP = null;
  for (const m of Object.values(cache)) m.clear();
  photoIdx.clear();
  for (const k of [...urls.keys()]) dropUrl(k);
  db.closeDb();
}

// 줄 선 쓰기가 다 끝날 때까지(그동안 새로 들어온 것도)
export async function flush() { for (;;) { const w = writeTail; await w; if (w === writeTail) return; } }
export const isReady = () => ready;

// 휴지통 30일 — 묶음, 그리고 살아 있는 묶음의 개별 삭제 사진
async function sweepTrash(now) {
  const limit = (Number.isFinite(TRASH_DAYS) ? TRASH_DAYS : 30) * DAY;
  for (const r of [...cache.records.values()]) if (r.deletedAt && now - r.deletedAt >= limit) await purgeRecord(r.id, { deferPins: true });   // 부팅에서 도면 DB 를 열지 않게
  for (const p of [...cache.photos.values()]) if (p.deletedAt && now - p.deletedAt >= limit && !cache.records.get(p.recordId)?.deletedAt) await purgePhoto(p.id);
}

// ---- 쓰기 줄 ----
function serial(fn) {
  const p = writeTail.then(() => {
    if (!ready) throw fail('NOT_READY', '저장소가 열려 있지 않아요 — store.init() 을 먼저 불러 주세요');
    return fn();
  });
  writeTail = p.then(() => {}, () => {});
  return p.then(v => v);                                                     // 호출자용 약속은 따로 — 실패가 조용히 묻히지 않게
}

// 한 쓰기의 레코드를 한 트랜잭션으로 → 끝나면 캐시 → 알림. db.js 가 연결이 닫혔으면 다시 열고 한 번 더 한다
async function commit({ records = [], photos = [], metas = [], delRecords = [], delPhotos = [] }) {
  const names = [];
  if (records.length || delRecords.length) names.push('records');
  if (photos.length || delPhotos.length) names.push('photos');
  if (metas.length) names.push('meta');
  if (!names.length) return;
  await db.tx(names, 'readwrite', t => {
    records.forEach(r => t.objectStore('records').put(r));
    delRecords.forEach(id => t.objectStore('records').delete(id));
    photos.forEach(p => t.objectStore('photos').put(p));
    delPhotos.forEach(id => t.objectStore('photos').delete(id));
    metas.forEach(([key, value]) => t.objectStore('meta').put({ key, value }));
  });
  const ev = { records: [], photos: [], settings: false, meta: [] };
  for (const r of records) { cache.records.set(r.id, deepFreeze(r)); ev.records.push(r.id); }
  for (const id of delRecords) { cache.records.delete(id); ev.records.push(id); }
  for (const p of photos) { const old = cache.photos.get(p.id); if (old && old.recordId !== p.recordId) ev.records.push(old.recordId); setPhotoCache(p); ev.photos.push(p.id); ev.records.push(p.recordId); }
  for (const id of delPhotos) { const old = cache.photos.get(id); if (old) ev.records.push(old.recordId); dropPhotoCache(id); ev.photos.push(id); }
  for (const [k, v] of metas) { cache.meta.set(k, deepFreeze(v)); if (k === 'settings') ev.settings = true; else ev.meta.push(k); }
  note(ev);
}

// ---- 설정·메타 ----
export function settings() {
  const out = { ...DEFAULT_SETTINGS };
  const saved = cache.meta.get('settings') ?? {};
  for (const [k, v] of Object.entries(saved)) if (v != null) out[k] = v;
  if (saved.wmWhen == null && saved.wmDate === false) out.wmWhen = 'off';    // 옛 설정(「촬영 일시 함께 넣기」 끔)을 기본값 'datetime' 이 덮지 않게
  // 도면·카메라 배치·자동 돌아가기는 사용자가 설정에서 직접 고른 값만 따른다(v0.1.6 — 기본이 'split'·켬 → 'shared'·끔으로 바뀜).
  // 자동 백업·미러 복원은 settings()(기본값까지 담긴 통째)를 저장하므로 옛 기본값이 「저장된 값」으로 박혀 있을 수 있다
  if (saved.captureStagePicked !== true) out.captureStage = DEFAULT_SETTINGS.captureStage;
  if (saved.stageAutoPicked !== true) out.stageAutoReturn = DEFAULT_SETTINGS.stageAutoReturn;
  return Object.freeze(out);
}
export function setSettings(patch) {
  return serial(async () => {
    await commit({ metas: [['settings', { ...cache.meta.get('settings'), ...clone(patch) }]] });
    return settings();
  });
}
export const meta = (key, fallback) => { const v = cache.meta.get(key); return v === undefined ? fallback : v; };
// 같은 값이어도 그대로 쓴다(원본 규칙 — 호출자가 캐시 값을 고친 뒤 부를 수 있다. 캐시는 얼려 있어 실제로는 못 고친다)
export function setMeta(key, value) {
  return serial(async () => { const v = clone(value); await commit({ metas: [[key, v]] }); return v; });
}
export const lastLocation = () => String(cache.meta.get('lastLocation')?.text ?? '');
export const setLastLocation = (text, now = Date.now()) => setMeta('lastLocation', { text: String(text ?? ''), at: now });

// ---- 조회(동기) ----
export const record = id => cache.records.get(id);
export const photo = id => cache.photos.get(id);
// 그 날 살아 있는 묶음 — 사진대지 순서(order → 만든 시각 → 관리번호 → id. 순서를 안 바꾼 날은 만든 시각 순 그대로)
export const recordsOfDay = day => [...cache.records.values()].filter(r => r.day === day && !r.deletedAt).sort(compareOrder);
// 사진의 recordId 가 이 묶음인 것만(복원 merge 로 같은 id 가 두 묶음 photoIds 에 들어가도 한 묶음에만 보이게)
export const photosOf = recordId => (cache.records.get(recordId)?.photoIds ?? []).map(id => cache.photos.get(id)).filter(p => p && !p.deletedAt && p.recordId === recordId);
export function days() {
  const by = new Map();
  for (const r of cache.records.values()) {
    if (r.deletedAt) continue;
    let d = by.get(r.day);
    if (!d) by.set(r.day, d = { day: r.day, list: [] });
    d.list.push(r);
  }
  const out = [];
  for (const { day, list } of by.values()) {
    list.sort(compareOrder);                                                 // 표지 4장도 사진대지 순서(묶음 순서 → 그 안 사진 순서)
    let photos = 0;
    const cover = [];
    for (const r of list) for (const p of photosOf(r.id)) { photos++; if (cover.length < 4 && p.state === 'ready') cover.push(p.id); }
    if (!list.length && !photos) continue;
    out.push({ day, records: list.length, photos, cover });
  }
  return out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
}
export function trash() {
  const records = [...cache.records.values()].filter(r => r.deletedAt).sort((a, b) => b.deletedAt - a.deletedAt);
  const photos = [...cache.photos.values()].filter(p => p.deletedAt && (() => { const r = cache.records.get(p.recordId); return r && !r.deletedAt; })()).sort((a, b) => b.deletedAt - a.deletedAt);
  return { records, photos };
}

// ---- 묶음 쓰기 ----
// 관리번호 = 그 날 가장 큰 순번 + 1. 휴지통·영구 삭제한 것도 센다(meta seqMax) — 번호는 되돌아가지 않는다
function nextSeq(day) {
  const pre = recordNo(day, 0).slice(0, -2);
  let max = num(cache.meta.get('seqMax')?.[day]);
  for (const r of cache.records.values()) if (r.no?.startsWith(pre)) max = Math.max(max, parseInt(r.no.slice(pre.length), 10) || 0);
  return max + 1;
}

export function createRecord({ day, location = '', content = '', now = Date.now() } = {}) {
  return serial(async () => {
    const d = day || dayKey(now);
    const sameDay = [];
    for (const r of cache.records.values()) if (r.day === d) sameDay.push(r);   // 휴지통 것도 — 되살려도 새 묶음이 그 뒤
    const o = nextOrder(sameDay, now);                                         // 그 날 맨 끝(시계가 뒤로 갔거나 누가 끝으로 옮겼어도)
    const rec = newRecord({ id: freshId('r', cache.records), day: d, now, location, content, site: settings().siteName, seq: nextSeq(d) });
    if (o !== now) rec.order = o;                                              // 칸은 쓸 때만(만든 시각과 같으면 없음)
    await commit({ records: [rec] });
    return cache.records.get(rec.id);
  });
}

// patch: { location?, content?, pin? } — pin 은 { drawingId, pinId } | null(도면보관함 핀 연결). 바뀐 게 없으면 rev 그대로
export function updateRecord(id, patch = {}, now = Date.now()) {
  return serial(async () => {
    const cur = cache.records.get(id);
    if (!cur) throw fail('NO_RECORD', '묶음을 찾을 수 없어요');
    let next = cur;
    for (const k of RECORD_EDIT) {
      if (patch[k] === undefined) continue;
      const v = String(patch[k] ?? '');
      if (v !== cur[k]) { if (next === cur) next = { ...cur }; next[k] = v; }
    }
    if (patch.pin !== undefined) {
      const pin = cleanRecordPin(patch.pin);
      if (pin === undefined) throw fail('BAD_PIN', '핀 연결 모양이 맞지 않아요');
      if (!same(pin, cur.pin ?? null)) { if (next === cur) next = { ...cur }; next.pin = pin; }
    }
    if (next === cur) return cur;                                            // 바뀐 게 없으면 rev 를 올리지 않는다
    const rec = touch(next, now);
    await commit({ records: [rec] });
    return cache.records.get(id);
  });
}

// 하루 묶음 순서(사진대지·대장·카톡 글·위치도·홈·내보내기 목록). ids = 그 날 살아 있는 묶음 id 를 원하는 순서로(화면 순서 그대로).
// 쓰기 줄 안에서 최신 캐시로 계산(core/order.js planOrder — 가장 긴 증가 부분열은 그대로): 옮긴 묶음만 order 새 값 + rev+1(합치기에서 이 순서가 이긴다),
// 한 트랜잭션·알림 한 번(미러도 바뀐 조각만). ids 에 없는 묶음(끄는 사이 새로 들어온 것)·모르는·겹친 id 는 그대로. 관리번호·만든 시각 그대로.
// → { changed: 쓴 묶음 수, order: 그 날 새 순서 id[] }
export function reorderRecords(day, ids, now = Date.now()) {
  return serial(async () => {
    const plan = planOrder(recordsOfDay(day), ids);
    if (!plan.changes.length) return { changed: 0, order: recordsOfDay(day).map(r => r.id) };
    const recs = plan.changes.map(c => touch({ ...cache.records.get(c.id), order: c.order }, now));
    await commit({ records: recs });
    return { changed: recs.length, order: recordsOfDay(day).map(r => r.id) };
  });
}

// 묶음 안 사진 순서(사진 번호 — 1번이 대표: 홈 줄 첫 썸네일·대장 대표 사진·표지). ids = 보이는 사진 id 를 원하는 순서로(화면 순서 그대로).
// 지운 사진 id 는 photoIds 에 남기되 바로 앞 사진 뒤에 붙어 따라간다(되살리면 그 근처 — order.reorderTo), ids 에 없는 살아 있는 사진도 앞 사진을 따라 제자리.
// 처리 중·실패 사진도 살아 있는 사진(격자에 보인다). 바뀐 게 없으면 쓰지 않는다. rev+1. 없거나 휴지통 묶음이면 NO_RECORD
export function reorderPhotos(recordId, ids, now = Date.now()) {
  return serial(async () => {
    const r = cache.records.get(recordId);
    if (!r || r.deletedAt) throw fail('NO_RECORD', '묶음을 찾을 수 없어요');
    const live = new Set(photosOf(recordId).map(p => p.id));
    const next = reorderTo(r.photoIds, (Array.isArray(ids) ? ids : []).filter(id => live.has(id)));
    if (same(next, r.photoIds)) return r;
    await commit({ records: [touch({ ...r, photoIds: next }, now)] });
    return cache.records.get(recordId);
  });
}

// 휴지통 — rev 는 그대로, updatedAt 만. 이미 그 상태면 아무것도 하지 않는다(삭제 시각을 새로 찍으면 30일 시계가 늘어난다)
const trashRecord = (id, at, now) => serial(async () => {
  const cur = cache.records.get(id);
  if (!cur) return null;
  if (!!cur.deletedAt === !!at) return cur;
  await commit({ records: [{ ...cur, deletedAt: at, updatedAt: now }] });
  return cache.records.get(id);
});
export const deleteRecord = (id, now = Date.now()) => trashRecord(id, now, now);
export const restoreRecord = (id, now = Date.now()) => trashRecord(id, null, now);

// 영구 삭제한 사진 id — 같은 기기의 옛 백업(자동 백업·수동 ZIP)을 합칠 때 그 사진을 다시 붙이지 않는다(0.1.7 결정 10 으로 「이 기기가 이김」에서도
//   백업에만 있는 사진을 붙이게 되자, 영구 삭제한 사진이 「처리 실패」 칸으로 되살아났다 — 검토 major). 같은 commit 으로 쓴다
function rememberPurgedPhotos(ids) {
  return ['purgedPhotoIds', [...(cache.meta.get('purgedPhotoIds') ?? []), ...ids].slice(-PURGED_PHOTOS_MAX)];
}
function rememberPurged(ids, rec) {
  const list = [...(cache.meta.get('purgedIds') ?? []), ...ids].slice(-PURGED_MAX);
  const metas = [['purgedIds', list]];
  if (rec) {                                                                 // 영구 삭제해도 그 날 번호는 다시 쓰지 않는다
    const n = parseInt(String(rec.no ?? '').split('-')[1], 10) || 0;
    const sm = { ...(cache.meta.get('seqMax') ?? {}) };
    if (n > num(sm[rec.day])) { sm[rec.day] = n; metas.push(['seqMax', sm]); }
  }
  return metas;
}

// 영구 삭제 — 기록을 먼저 지우고(반대 순서면 기록만 남고 파일이 없다) 그 다음 파일. 갤러리 원본은 건드리지 않는다.
// 도면 핀은 지우지 않고 묶음 연결(recordId)만 푼다(핀 이름·자리는 도면보관함에 남는다).
// deferPins: 부팅 휴지통 정리 — 도면 DB 를 부팅에서 열지 않게 핀 풀기는 한가할 때(setPinDefer) 따로
export async function purgeRecord(id, { deferPins = false } = {}) {
  const gone = await serial(async () => {
    const r = cache.records.get(id);
    if (!r) return null;
    const ps = [...(photoIdx.get(id) ?? [])].map(pid => cache.photos.get(pid)).filter(Boolean);
    const metas = rememberPurged([id], r);
    if (ps.length) metas.push(rememberPurgedPhotos(ps.map(p => p.id)));
    await commit({ delRecords: [id], delPhotos: ps.map(p => p.id), metas });
    return { ps, pin: r.pin || null };
  });
  if (gone) {
    await removeFiles(gone.ps);
    if (deferPins) { const prev = pinTail; pinTail = (async () => { await prev; await pinDefer(); await unlinkPins(id, gone.pin); })(); }
    else await unlinkPins(id, gone.pin);
  }
  return !!gone;
}

// 도면보관함 핀의 묶음 연결 풀기(drawings.updatePin(pinId, { recordId: null })). 모듈이 없거나 실패해도 묶음 삭제는 끝난 것 — 조용히
let pinTail = Promise.resolve();
let pinDefer = () => Promise.resolve();
export const pinsIdle = () => pinTail;                                       // 시험용 — 미룬 핀 풀기가 끝날 때까지
// app.js 가 「첫 화면 뒤 한가할 때」 약속을 넘긴다(없으면 바로)
export function setPinDefer(fn) { pinDefer = typeof fn === 'function' ? fn : () => Promise.resolve(); }
async function unlinkPins(recordId, pin) {
  try {
    const dw = await import('./drawings.js');
    if (typeof dw.updatePin !== 'function' || typeof dw.ready !== 'function') return 0;
    await dw.ready();
    const ids = new Set();
    if (pin?.pinId && dw.pin?.(pin.pinId)?.recordId === recordId) ids.add(pin.pinId);
    const all = [...(dw.drawings?.() ?? []), ...(dw.drawings?.({ deleted: true }) ?? [])];
    for (const d of all) for (const deleted of [false, true]) for (const p of dw.pins?.(d.id, { deleted }) ?? []) if (p.recordId === recordId) ids.add(p.id);
    for (const pid of ids) await dw.updatePin(pid, { recordId: null }).catch(e => console.warn('핀 연결을 풀지 못했어요', pid, e));
    return ids.size;
  } catch (e) { console.warn('도면 핀 연결 풀기 실패', e); return 0; }
}

async function removeFiles(photos) {
  await Promise.all(photos.flatMap(p => ['work', 'thumb', 'incoming'].map(kind => {
    dropUrl(`${p.id}:${kind}`);
    return fs.remove(kind, p.id, kind === 'incoming' ? (p.incoming || p.store) : p.store).catch(e => console.warn('사진 파일을 지우지 못했어요', e));
  })));
}

// ---- 사진 쓰기 ----
// §4.5: 원본 bytes 를 incoming 에 먼저 쓰고(메모리에만 있는 순간을 없앤다) Photo(processing) + record.photoIds 를 한 트랜잭션으로
//   xform·tempPath·original 도 같은 트랜잭션에(사이에 죽으면 회전·갤러리 정보가 빠진 채 복구되지 않게)
export async function addIncoming(recordId, { id, raw, takenAt, takenAtSource = 'camera', source = 'incam', gps = null, xform = null, tempPath = null, original = null, now = Date.now() } = {}) {
  if (!ready) throw fail('NOT_READY', '저장소가 열려 있지 않아요');
  if (!cache.records.has(recordId)) throw fail('NO_RECORD', '묶음을 찾을 수 없어요');
  const pid = id || freshId('p', cache.photos);
  if (cache.photos.has(pid)) throw fail('DUP_PHOTO', '이미 있는 사진 id 예요');
  const { store } = await fs.put('incoming', pid, raw);                      // 쓰기 줄 밖 — 큰 파일을 쓰는 동안 다른 저장이 기다리지 않게
  try {
    return await serial(async () => {
      const r = cache.records.get(recordId);
      if (!r) throw fail('NO_RECORD', '묶음을 찾을 수 없어요');
      const p = { ...newPhoto({ id: pid, recordId, now, takenAt: takenAt ?? now, takenAtSource, source, bytes: sizeOf(raw), gps, original: original ? clone(original) : null }), state: 'processing', store, incoming: store };
      if (xform) p.xform = clone(xform);
      if (tempPath) p.tempPath = String(tempPath);
      const ids = r.photoIds.includes(pid) ? r.photoIds : [...r.photoIds, pid];
      await commit({ records: [touch({ ...r, photoIds: ids }, now)], photos: [p] });
      return cache.photos.get(pid);
    });
  } catch (e) {
    throw e;                                                                 // incoming 은 늘 남긴다(그새 묶음이 지워졌어도) — recover 가 「복구된 사진」으로 입양한다. 사진을 잃는 것보다 낫다
  }
}

// 작업본·썸네일 파일 저장 → ready → incoming 삭제.
// keepIncoming: APK 갤러리 원본이 아직이면 incoming 파일과 메타 incoming 을 남긴다(recover 가 「ready + incoming = 갤러리 원본 아직」으로 본다)
export async function finishPhoto(id, { work, thumb, w, h, takenAt, takenAtSource, keepIncoming = false } = {}) {
  if (!cache.photos.has(id)) throw fail('NO_PHOTO', '사진을 찾을 수 없어요');
  const s1 = (await fs.put('work', id, work)).store;
  await fs.put('thumb', id, thumb);
  let res;
  try {
    res = await serial(async () => {
      const cur = cache.photos.get(id);
      if (!cur) throw fail('NO_PHOTO', '사진을 찾을 수 없어요');
      const p = { ...cur, state: 'ready', store: s1, w: num(w), h: num(h), bytes: sizeOf(work), thumbBytes: sizeOf(thumb), error: undefined };
      const inc = cur.incoming ?? cur.store;
      delete p.error; delete p.incoming;
      if (keepIncoming && inc) p.incoming = inc;
      if (takenAt != null) p.takenAt = takenAt;
      if (takenAtSource) p.takenAtSource = takenAtSource;
      await commit({ photos: [p] });
      return { photo: cache.photos.get(id), incoming: cur.incoming ?? cur.store };
    });
  } catch (e) {
    if (e?.code === 'NO_PHOTO') { await fs.remove('work', id).catch(() => {}); await fs.remove('thumb', id).catch(() => {}); }   // 그새 영구 삭제됨 — 고아 파일을 남기지 않는다
    throw e;
  }
  for (const k of ['work', 'thumb']) dropUrl(`${id}:${k}`);
  if (!keepIncoming) await fs.remove('incoming', id, res.incoming).catch(e => console.warn('incoming 을 지우지 못했어요', e));   // ready 로 저장된 뒤에만
  return res.photo;
}

// 갤러리 원본을 넣은 뒤(또는 필요 없어진 뒤) — 메타의 incoming 표지를 먼저 지우고 그다음 파일(반대 순서면 recover 가 없는 파일을 찾는다).
// ready 일 때만(처리 중·실패면 incoming 이 유일한 원본이라 남긴다). 사진 메타가 없으면 파일만. → true(지움) | false
export async function releaseIncoming(id) {
  const r = await serial(async () => {
    const cur = cache.photos.get(id);
    if (!cur) return { inc: undefined };
    if (cur.state !== 'ready' || !cur.incoming) return null;
    const p = { ...cur };
    delete p.incoming;
    await commit({ photos: [p] });
    return { inc: cur.incoming };
  });
  if (!r) return false;
  dropUrl(`${id}:incoming`);
  await fs.remove('incoming', id, r.inc).catch(e => console.warn('incoming 을 지우지 못했어요', e));
  return true;
}

// 실패 — incoming 은 남긴다(다시 처리할 수 있게). error 가 code 를 가지면 errorCode 로 남긴다(BROKEN·NO_SOURCE 는 다시 해도 안 됨)
export function failPhoto(id, error) {
  return serial(async () => {
    const cur = cache.photos.get(id);
    if (!cur) throw fail('NO_PHOTO', '사진을 찾을 수 없어요');
    const p = { ...cur, state: 'failed', error: String(error?.message ?? error ?? '처리 실패') };
    if (error?.code) p.errorCode = String(error.code); else delete p.errorCode;
    await commit({ photos: [p] });
    return cache.photos.get(id);
  });
}

// 처리 실패 → 다시 처리(processing). incoming 이 있어야 한다 → Photo | null(다시 할 수 없음)
export function retryPhoto(id) {
  return serial(async () => {
    const cur = cache.photos.get(id);
    if (!cur || cur.state !== 'failed' || cur.deletedAt) return null;
    const inc = cur.incoming || (await fs.has('incoming', id, cur.store));
    if (!inc) return null;
    const p = { ...cur, state: 'processing', incoming: inc };
    delete p.error; delete p.errorCode;
    await commit({ photos: [p] });
    return cache.photos.get(id);
  });
}

// 재설치 뒤 갤러리 원본으로 되살리기 — 원본 bytes 를 incoming 에 쓰고 processing 으로(patch: xform·original 등). → Photo
export async function reviveIncoming(id, raw, patch = {}) {
  if (!cache.photos.has(id)) throw fail('NO_PHOTO', '사진을 찾을 수 없어요');
  const { store } = await fs.put('incoming', id, raw);
  return serial(async () => {
    const cur = cache.photos.get(id);
    if (!cur) throw fail('NO_PHOTO', '사진을 찾을 수 없어요');
    const p = { ...cur, ...clone(patch), state: 'processing', incoming: store, bytes: sizeOf(raw) };
    delete p.error; delete p.errorCode;
    await commit({ photos: [p] });
    return cache.photos.get(id);
  });
}

// incoming 없이 바로(복원·시험용)
export async function addPhoto(recordId, { id, work, thumb, w, h, takenAt, takenAtSource = 'camera', source = 'incam', gps = null, now = Date.now() } = {}) {
  if (!ready) throw fail('NOT_READY', '저장소가 열려 있지 않아요');
  if (!cache.records.has(recordId)) throw fail('NO_RECORD', '묶음을 찾을 수 없어요');
  const pid = id || freshId('p', cache.photos);
  const s1 = (await fs.put('work', pid, work)).store;
  await fs.put('thumb', pid, thumb);
  try {
    return await serial(async () => {
      const r = cache.records.get(recordId);
      if (!r) throw fail('NO_RECORD', '묶음을 찾을 수 없어요');
      const p = { ...newPhoto({ id: pid, recordId, now, takenAt: takenAt ?? now, takenAtSource, source, w: num(w), h: num(h), bytes: sizeOf(work), thumbBytes: sizeOf(thumb), gps }), state: 'ready', store: s1 };
      await commit({ records: [touch({ ...r, photoIds: r.photoIds.includes(pid) ? r.photoIds : [...r.photoIds, pid] }, now)], photos: [p] });
      return cache.photos.get(pid);
    });
  } catch (e) {
    await fs.remove('work', pid, s1).catch(() => {}); await fs.remove('thumb', pid, s1).catch(() => {});
    throw e;
  }
}

// 사진 메타 고치기(갤러리 원본 기록 등) — 묶음의 rev 는 그대로
export function updatePhoto(id, patch = {}) {
  return serial(async () => {
    const cur = cache.photos.get(id);
    if (!cur) throw fail('NO_PHOTO', '사진을 찾을 수 없어요');
    let next = cur;
    for (const [k, v] of Object.entries(clone(patch) ?? {})) {
      if (v === undefined || PHOTO_FIXED.includes(k) || same(cur[k], v)) continue;
      if (next === cur) next = { ...cur };
      next[k] = v;
    }
    if (next === cur) return cur;
    await commit({ photos: [next] });
    return cache.photos.get(id);
  });
}

// 사진 삭제 — photoIds 에 id 는 남긴다(되살리면 제자리). 묶음 rev+1(사진 번호가 바뀐다)
const trashPhoto = (id, at, now) => serial(async () => {
  const cur = cache.photos.get(id);
  if (!cur) return null;
  if (!!cur.deletedAt === !!at) return cur;
  const r = cache.records.get(cur.recordId);
  const recs = [];
  if (r) recs.push(touch(r.photoIds.includes(id) ? r : { ...r, photoIds: [...r.photoIds, id] }, now));
  await commit({ records: recs, photos: [{ ...cur, deletedAt: at }] });
  return cache.photos.get(id);
});
export const deletePhoto = (id, now = Date.now()) => trashPhoto(id, now, now);
export const restorePhoto = (id, now = Date.now()) => trashPhoto(id, null, now);

export async function purgePhoto(id, now = Date.now()) {
  const gone = await serial(async () => {
    const cur = cache.photos.get(id);
    if (!cur) return null;
    const r = cache.records.get(cur.recordId);
    const recs = r && r.photoIds.includes(id) ? [touch({ ...r, photoIds: r.photoIds.filter(x => x !== id) }, now)] : [];
    await commit({ records: recs, delPhotos: [id], metas: [rememberPurgedPhotos([id])] });
    return cur;
  });
  if (gone) await removeFiles([gone]);
  return !!gone;
}

// ---- 사진 읽기 ----
export async function blob(photoId, kind = 'work') {
  const p = cache.photos.get(photoId);
  if (!p) return null;
  return fs.get(kind, photoId, kind === 'incoming' ? (p.incoming ?? p.store) : p.store);
}
export async function src(photoId, kind = 'thumb') {
  const p = cache.photos.get(photoId);
  if (!p) return null;
  if (kind !== 'incoming' && p.state !== 'ready') return null;               // 작업본이 아직 없다 — 화면은 「처리 중」 자리표시
  const key = `${photoId}:${kind}`;
  if (urls.has(key)) return urls.get(key);
  const u = await fs.url(kind, photoId, kind === 'incoming' ? (p.incoming ?? p.store) : p.store);
  if (!u) return u;
  if (urls.has(key)) {                                                       // 그새 같은 주소를 만든 호출이 먼저 넣었다 — 그것을 쓴다
    if (u !== urls.get(key) && u.startsWith('blob:')) { try { URL.revokeObjectURL(u); } catch { /* 없음 */ } }
    return urls.get(key);
  }
  if (cache.photos.get(photoId) !== p) {                                     // 기다리는 사이 사진이 바뀌었다(다시 처리 등) — 캐시하지 않는다
    return u;
  }
  urls.set(key, u);                                                          // APK 예전 사진(파일 주소)도 캐시 — 다시 그릴 때 브리지 0(속도 감사 #4)
  return u;
}

// ---- 백업·복원 ----
// 삭제 제외 전부(살아 있는 묶음의 살아 있는 사진)
export function dump() {
  const records = [...cache.records.values()].filter(r => !r.deletedAt);
  const live = new Set(records.map(r => r.id));
  const photos = [...cache.photos.values()].filter(p => !p.deletedAt && live.has(p.recordId));
  return { records, photos };
}
// 휴지통 포함 전부(자동 백업·미러용, safety)
export function snapshot() {
  return { records: [...cache.records.values()], photos: [...cache.photos.values()], settings: settings(), lastLocation: cache.meta.get('lastLocation') ?? null, installId: cache.meta.get('installId') ?? '' };
}
export const photosOfAll = recordId => [...(photoIdx.get(recordId) ?? [])].map(id => cache.photos.get(id)).filter(Boolean);

// 들어온 기록을 지금 것과 합친다. 사진 본체: getBlob 으로 받아 쓰거나, 없으면 파일 저장소에 이미 있는지 본다(IDB 만 죽고 OPFS·파일이 산 경우).
// 파일은 먼저 쓰고, 메타는 한 트랜잭션으로(중간에 끊겨도 「일부만 복원된」 상태가 남지 않게).
// 이 기기에서 영구 삭제한 사진(meta purgedPhotoIds + 부른 쪽이 준 purgedPhotoIds)은 들어와도 되살리지 않는다 — 사진 메타도, 묶음 photoIds 에서도 뺀다
export async function merge({ records = [], photos = [], purgedPhotoIds = null } = {}, getBlob = null) {
  if (!ready) throw fail('NOT_READY', '저장소가 열려 있지 않아요');
  await flush();
  const okRec = r => r && typeof r === 'object' && typeof r.id === 'string' && Array.isArray(r.photoIds);
  const okPh = p => p && typeof p === 'object' && typeof p.id === 'string' && typeof p.recordId === 'string';
  const gone = new Set([...(cache.meta.get('purgedPhotoIds') ?? []), ...(Array.isArray(purgedPhotoIds) ? purgedPhotoIds : [])]);
  const live = r => (gone.size && r.photoIds.some(id => gone.has(id)) ? { ...r, photoIds: r.photoIds.filter(id => !gone.has(id)) } : r);
  let skipped = 0;
  const incR = new Map(), incP = new Map();
  for (const r of records) { if (okRec(r)) incR.set(r.id, mergeRecord(incR.get(r.id), live(r))); else skipped++; }
  for (const p of photos) { if (okPh(p) && !gone.has(p.id)) incP.set(p.id, mergePhoto(incP.get(p.id), p)); else skipped++; }
  const known = new Set([...cache.records.keys(), ...incR.keys()]);

  // 사진 파일 먼저(쓰기 줄 밖)
  const outP = [];
  let withFiles = 0, missing = 0;
  for (const p of incP.values()) {
    if (!known.has(p.recordId)) { skipped++; continue; }
    const cur = cache.photos.get(p.id);
    const win = mergePhoto(cur, p);
    if (win === cur) { if (cur) skipped++; continue; }
    const q = { ...p };
    delete q.incoming;
    let store = null;
    if (typeof getBlob === 'function' && q.state === 'ready') {
      try {
        const [w, t] = await Promise.all([getBlob(q.id, 'work'), getBlob(q.id, 'thumb')]);
        if (w && t) { store = (await fs.put('work', q.id, w)).store; await fs.put('thumb', q.id, t); }
      } catch (e) { if (e?.code === 'QUOTA') throw e; console.warn('복원 사진 파일 쓰기 실패', q.id, e); }
    }
    if (!store) store = (await fs.has('thumb', q.id, q.store)) && (await fs.has('work', q.id, q.store));
    if (store) {
      q.store = store; withFiles++;
      // 갤러리 원본이 아직이던 사진(메타에 incoming) — 이 기기에 그 파일이 있으면 표지를 남긴다(부팅 recover 가 원본 줄로 보내거나 치운다 §4.5)
      if (p.incoming && q.state === 'ready') { const inc = await fs.has('incoming', q.id).catch(() => null); if (inc) q.incoming = inc; }
    }
    else if (q.state === 'ready') {                                          // 본체가 어디에도 없다 — 메타는 살리고 「처리 실패」로(갤러리 원본으로 다시 만들 수 있게)
      const inc = await fs.has('incoming', q.id);
      if (inc) { q.state = 'processing'; q.store = inc; q.incoming = inc; }
      else { q.state = 'failed'; q.error = '사진 파일이 없어요'; missing++; }
    }
    outP.push(q);
  }

  return serial(async () => {
    let added = 0, updated = 0;
    const outR = [];
    const finalP = new Map(outP.map(p => [p.id, p]));
    const ownerOf = id => (finalP.get(id) || cache.photos.get(id))?.recordId;
    const mine = (ids, rid) => ids.filter(id => { const o = ownerOf(id); return !o || o === rid; });   // 다른 묶음 사진이면 뺀다
    for (const r of incR.values()) {
      const cur = cache.records.get(r.id);
      const win = mergeRecord(cur, r);
      if (win === cur) {
        // 이 기기가 이김(rev·updatedAt) — 그래도 들어온 쪽이 가진 이 묶음 사진(이번에 함께 들어오는 사진, 또는 메타만 있고 photoIds 에서 빠진 사진)은 붙인다
        // (결정 10 — 안 붙이면 사진 메타만 있고 화면에 안 보인다. 끌기로 rev 가 자주 올라 이 기기가 이기는 일이 늘었다). 자리는 들어온 쪽 앞 이웃 뒤, rev 는 그대로
        const have = new Set(cur?.photoIds || []);
        const extra = new Set((r.photoIds || []).filter(id => !have.has(id) && ownerOf(id) === r.id));
        if (!cur || !extra.size) { skipped++; continue; }
        outR.push({ ...cur, photoIds: mine(mergeIds(cur.photoIds, r.photoIds.filter(id => have.has(id) || extra.has(id))), cur.id) });
        updated++;
        continue;
      }
      const out = clone(win);
      if (cur) out.photoIds = mergeIds(out.photoIds, cur.photoIds);           // 이긴 쪽(들어온 것) 사진 순서 + 이 기기에서 그 뒤 넣은 사진은 이 기기 쪽 앞 이웃 뒤(빼지 않는다)
      out.photoIds = mine(out.photoIds, out.id);
      outR.push(out);
      if (cur) updated++; else added++;
    }
    await commit({ records: outR, photos: outP.map(clone) });
    return { added, updated, skipped, photos: withFiles, missing };
  });
}

export async function usage() {
  const u = await fs.usage();
  return { photos: [...cache.photos.values()].filter(p => !p.deletedAt).length, bytes: u.bytes };
}
