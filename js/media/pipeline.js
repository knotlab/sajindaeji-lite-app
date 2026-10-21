// 들어온 사진 처리 — 디스크 먼저 → 줄이기 → 준비됨 → (APK) 갤러리 원본, 부팅 복구(설계서 §4.5·§5.4, 원본 capture.js processPhoto·recover)
// 순서(§4.5, 공시체 BUGREPORT: 카메라 중 프로세스가 죽어 사진이 통째로 사라진 사고):
//   ① store.addIncoming — 원본 bytes 를 incoming 에 쓰고 Photo(processing)+record.photoIds 를 같이 저장. ingest() 는 여기까지 기다린다
//   ② (줄) jpegComplete 검사 → exifTakenAt(gallery/syscam) → makeWorkAndThumbFast(워커, turns·aspect 적용) → store.finishPhoto(ready, incoming 삭제)
//      (APK incam·갤러리 저장 켬) 작업본을 만드는 동안 원본을 original 에도 써 둔다 — incoming 이 지워진 뒤 앱이 죽어도 갤러리 원본을 잃지 않게
//   ③ (APK && saveToGallery && incam) 「원본 줄」(사진이 화면에 뜬 뒤, 처리 줄이 비었을 때) original → 풀 해상도 회전·자르기(워커)
//      → native.saveOriginal({ bytes, name, prefer: settings.galleryPref }) → photo.original → original 삭제. 부팅 recover 가 남은 original 을 이어서 넣는다
//      syscam 은 Shot.take 가 이미 갤러리에 넣었다 → 그 결과를 original 에 적고 임시 파일은 ready 저장 뒤에만 지운다
// 처리는 한 번에 하나씩(줄), 촬영은 막지 않는다. 회전·자르기 정보(xform)는 photo.xform 에 남겨 recover 때도 같은 그림이 나온다.
// 즉시 미리보기: ingest 에 preview(셔터 순간 320px Blob, camera.shoot 의 shot.preview — 없으면 shotInfo 에서 찾음)를 주면
//   처리하는 동안 preview(photoId) 가 그 주소를 돌려준다(썸네일이 「처리 중」 대신 사진을 보인다). 처리가 끝나고 잠시 뒤 해제.
import * as store from '../data/store.js';
import * as native from '../platform/native.js';
import { uid } from '../core/model.js';
import { dayKey } from '../core/date.js';
import { jpegComplete, exifTakenAt, makeWorkAndThumbFast, transformFull } from './image.js';
import { shotInfo } from './camera.js';

const MIN_TS = Date.UTC(1990, 0, 1);
const msOf = t => (Number.isFinite(t) && t > MIN_TS ? t : null);
const msg = e => e?.message || String(e);
const p2 = n => String(n).padStart(2, '0');
// 갤러리 원본 이름 — 현장_YYYYMMDD_HHmmss_<photoId>.jpg (photoId 가 들어 있어 재설치 뒤 다시 연결된다)
export function originalName(id, ts = Date.now()) {
  const t = new Date(ts);
  return `현장_${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}_${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}_${id}.jpg`;
}
const hasXform = x => !!x && ((x.turns % 4) || x.aspect);
const fsMod = () => import('../data/photofs.js');

// ---- 즉시 미리보기 ----
const previews = new Map();               // id → objectURL
const PREVIEW_KEEP_MS = 15000;            // 준비됨 뒤에도 잠깐 둔다 — 썸네일이 워터마크 그림을 받기 전까지 이 주소를 보이고 있을 수 있다
// 처리 중 사진의 셔터 순간 그림 주소 | null(없음·이미 해제). 주소는 이 모듈이 해제한다(호출자는 revoke 하지 않는다)
export const preview = id => previews.get(id) || null;
function setPreview(id, src) {
  if (!id || !src) return;
  let u = null;
  try { u = typeof src === 'string' ? src : URL.createObjectURL(src); } catch { return; }
  dropPreview(id);
  previews.set(id, u);
}
function dropPreview(id) {
  const u = previews.get(id);
  if (!u) return;
  previews.delete(id);
  if (u.startsWith('blob:')) { try { URL.revokeObjectURL(u); } catch { /* 이미 해제 */ } }
}
function dropPreviewLater(id) { if (previews.has(id)) setTimeout(() => dropPreview(id), PREVIEW_KEEP_MS); }

// ---- 처리 줄 ----
let lane = Promise.resolve();
const queued = new Set();                 // 줄에 서 있거나 처리 중인 사진 — 사진마다 한 번만
const mem = new Map();                    // id → { raw, xform, original, tempPath } (방금 들어온 것 — incoming 을 다시 읽지 않게)
const pendFns = new Set();
let active = 0;                           // 디스크 저장 중 + 줄
const idleWaiters = [];
function bump(d) {
  active += d;
  for (const fn of pendFns) { try { fn(active); } catch (e) { console.error(e); } }
  if (!active) idleWaiters.splice(0).forEach(f => f());
}
export const pending = () => active;
export function onPending(fn) { pendFns.add(fn); return () => pendFns.delete(fn); }
export const idle = () => (active ? new Promise(r => idleWaiters.push(r)) : Promise.resolve());

function enqueue(id) {
  if (queued.has(id)) return lane;
  queued.add(id); bump(1);
  const p = lane.then(() => processPhoto(id)).catch(e => console.error('사진 처리 실패', id, e)).finally(() => { queued.delete(id); mem.delete(id); dropPreviewLater(id); bump(-1); });
  lane = p;
  return p;
}

// SD로 하랬는데 본체로 갔으면 토스트(한 세션에 한 번, 공시체 문구 방식)
let sdToastShown = false;
async function notice(text) {
  try { (await import('../ui/dom.js')).toast(text); } catch { console.info(text); }
}

async function readIncoming(p) {
  const b = await store.blob(p.id, 'incoming');
  return b ? new Uint8Array(await b.arrayBuffer()) : null;
}

// 처리 시간 기록(측정·디버그용 — 마지막 20장)
const timings = [];
export const lastTimings = () => timings.slice();

// APK 앱 안 카메라 + 갤러리 저장 켬 → 갤러리 원본이 필요한 사진
function wantsOriginal(p) {
  if (!p || !native.isNative() || p.source !== 'incam' || p.original?.savedTo) return false;
  return store.settings().saveToGallery !== false;
}

async function processPhoto(id) {
  const p = store.photo(id);
  if (!p || p.state !== 'processing') return;
  const m = mem.get(id) || {};
  const t0 = performance.now();
  try {
    const raw = m.raw || await readIncoming(p);
    if (!raw || !raw.length) throw Object.assign(new Error('원본 파일을 찾지 못했어요'), { code: 'NO_SOURCE' });
    if (!jpegComplete(raw)) throw Object.assign(new Error('사진 파일이 중간에 끊겼어요'), { code: 'BROKEN' });
    const patch = {};
    if (p.source === 'gallery' || p.source === 'syscam') {
      const exif = exifTakenAt(raw);
      if (exif != null) { patch.takenAt = exif; if (p.takenAtSource === 'file' || p.takenAtSource === 'manual') patch.takenAtSource = 'exif'; }
    }
    const xform = m.xform || p.xform || null;
    // 갤러리 원본용 사본 — 작업본을 만드는 동안(워커) 같이 쓴다. incoming 은 ready 저장 때 지워지므로 그 전에 끝나 있어야 한다
    const keepOrig = wantsOriginal(p) ? fsMod().then(fs => fs.put('original', id, raw)).then(() => true, e => { console.warn('갤러리 원본 사본을 못 썼어요 — 바로 넣어요', e); return false; }) : null;
    const r = await makeWorkAndThumbFast(raw, hasXform(xform) ? xform : {});
    const kept = keepOrig ? await keepOrig : false;
    const done = await store.finishPhoto(id, { work: r.work.blob, thumb: r.thumb.blob, w: r.work.w, h: r.work.h, ...patch });
    timings.push({ id, via: r.via, workerMs: r.ms, totalMs: Math.round(performance.now() - t0), bytes: raw.length });
    if (timings.length > 20) timings.shift();
    await afterReady(done, raw, xform, m, kept);
  } catch (e) {
    console.warn('사진 처리 실패', id, e);
    if (e?.code === 'NO_PHOTO') return;                                     // 그새 영구 삭제됨
    await store.failPhoto(id, { message: msg(e), code: e?.code || e?.name || '' }).catch(err => console.error('실패 표시도 못 했어요', id, err));
  }
}

// 준비됨 뒤 — 갤러리 원본(APK). 실패해도 사진은 저장돼 있다(original.error)
//   kept(원본 사본을 original 에 써 둠)면 원본 줄로 넘기고 바로 돌아온다(다음 사진 처리를 막지 않게). 못 썼으면 예전처럼 여기서 바로
async function afterReady(p, raw, xform, m, kept = false) {
  if (!p || !native.isNative()) return;
  const s = store.settings();
  const tempPath = m.tempPath || p.tempPath || null;
  if (p.source === 'syscam') {
    const o = m.original || p.original;
    if (o && !p.original?.at) await store.updatePhoto(p.id, { original: { name: o.name ?? null, savedTo: o.savedTo ?? null, uri: o.uri ?? null, at: Date.now() } }).catch(() => {});
    if (tempPath) { await native.deleteTemp(tempPath); await store.updatePhoto(p.id, { tempPath: null }).catch(() => {}); }
    return;
  }
  if (p.source !== 'incam' || s.saveToGallery === false || p.original?.savedTo) return;
  if (kept) { queueOriginal(p.id); return; }
  await saveOriginalOf(p, raw, xform);
}

// ---- 원본 줄(APK 갤러리 원본) ----
// 처리 줄이 빌 때 하나씩(사진이 먼저 뜨게). 4장 넘게 밀리면 처리 줄을 기다리지 않는다(메모리·디스크가 쌓이지 않게)
const origQ = [];
const origSet = new Set();
let origRun = null;
function queueOriginal(id) {
  if (origSet.has(id)) return;
  origSet.add(id); origQ.push(id);
  kickOriginals();
}
function kickOriginals() {
  if (origRun) return;
  origRun = runOriginals().finally(() => { origRun = null; if (origQ.length) kickOriginals(); });   // 끝나는 순간 들어온 것까지
}
async function runOriginals() {
  while (origQ.length) {
    while (queued.size && origQ.length < 4) await lane.catch(() => {});
    const id = origQ.shift();
    try { await saveKeptOriginal(id); } catch (e) { console.warn('갤러리 원본 저장 실패', id, e); } finally { origSet.delete(id); }
  }
}
// 원본 줄이 빌 때까지(시험·측정용)
export const originalsIdle = async () => { while (origRun) await origRun; };
async function saveKeptOriginal(id) {
  const fs = await fsMod();
  const p = store.photo(id);
  if (!p) { await fs.remove('original', id).catch(() => {}); return; }                    // 그새 영구 삭제
  if (p.state !== 'ready') return;                                                         // 다시 처리 중 — 끝나면 다시 줄에 선다
  if (!wantsOriginal(p)) { await fs.remove('original', id).catch(() => {}); return; }      // 이미 넣었거나 갤러리 저장을 껐다
  const b = await fs.get('original', id);
  if (!b || !b.size) return;
  await saveOriginalOf(p, b, p.xform || null);
  await fs.remove('original', id).catch(() => {});                                         // 실패해도 지운다(original.error — [다시 저장]은 작업본으로)
}

async function saveOriginalOf(p, raw, xform) {
  const s = store.settings(), prefer = s.galleryPref === 'phone' ? 'phone' : 'sd';
  const name = p.original?.name || originalName(p.id, p.takenAt || p.createdAt);
  let bytes = raw;
  try {
    if (hasXform(xform)) bytes = await transformFull(raw, xform, 0.92);    // 풀 해상도로 돌리고 잘라 q0.92(설계 비평 7) — 워커에서
  } catch (e) { console.warn('원본 회전 실패 — 돌리지 않은 원본을 넣어요', e); bytes = raw; }
  const r = await native.saveOriginal({ bytes, name, prefer });
  const at = Date.now();
  const original = r?.ok ? { name, savedTo: r.savedTo ?? null, uri: r.uri ?? null, at } : { name, savedTo: null, uri: null, at, error: String(r?.error || '갤러리에 넣지 못했어요') };
  await store.updatePhoto(p.id, { original }).catch(e => console.warn('원본 기록 실패', e));
  if (r?.ok && prefer === 'sd' && r.savedTo === '휴대폰' && !sdToastShown) { sdToastShown = true; notice('SD카드에 못 넣어 휴대폰에 저장했어요'); }
  return original;
}

// 갤러리에 못 넣은 사진 다시 저장(설정 [다시 저장]) — 작업본밖에 없으면 작업본으로. → { saved, failed }
export async function retryOriginals() {
  if (!native.isNative()) return { saved: 0, failed: 0 };
  let saved = 0, failed = 0;
  for (const p of store.dump().photos) {
    if (p.state !== 'ready' || p.source !== 'incam' || !p.original?.error) continue;
    const b = await store.blob(p.id, 'work');
    if (!b) { failed++; continue; }
    const o = await saveOriginalOf(p, new Uint8Array(await b.arrayBuffer()), null);
    if (o.error) { failed++; break; } else saved++;                         // 한 번 실패하면 멈춘다(SD 가 빠졌으면 나머지도 실패)
  }
  return { saved, failed };
}

// 처리 실패 사진 다시 처리(크게 보기의 [다시 처리], 부팅 recover) → true(준비됨) | false
const NO_RETRY = new Set(['BROKEN', 'NO_SOURCE']);                       // 다시 해도 안 되는 실패
export const canRetry = p => !!p && p.state === 'failed' && !p.deletedAt && !NO_RETRY.has(p.errorCode) && !!p.incoming;
export async function reprocess(id) {
  const p = await store.retryPhoto(id);
  if (!p) return false;
  await enqueue(id);
  return store.photo(id)?.state === 'ready';
}

// 갤러리 원본 bytes 로 작업본·썸네일을 다시 만든다(재설치 뒤 원본 다시 연결) → 최종 Photo
//   incam 원본은 이미 돌리고 잘라 넣었으므로(saveOriginalOf) xform 을 비운다. syscam 원본은 찍힌 그대로라 둔다
export async function revive(id, raw, { uri = null } = {}) {
  const p = store.photo(id);
  if (!p) throw Object.assign(new Error('사진을 찾을 수 없어요'), { code: 'NO_PHOTO' });
  const patch = {};
  if (p.source === 'incam') patch.xform = null;
  if (uri && p.original) patch.original = { ...p.original, uri };
  await store.reviveIncoming(id, raw, patch);
  mem.set(id, { raw, xform: patch.xform === null ? null : p.xform || null });
  await enqueue(id);
  return store.photo(id);
}

// ---- 들어오기 ----
// ingest(recordId, blob, { source, takenAt, takenAtSource, gps, turns?, aspect?, id?, original?, tempPath? }) → Photo(processing)
//   원본이 디스크에 안전하게 들어간 뒤 돌아온다(처리는 줄에서 이어짐 — 끝은 store.on 으로 ready/failed 가 알린다).
//   { wait: true } 면 처리까지 기다려 최종 Photo 를 돌려준다.
//   preview: 셔터 순간 그림(Blob | 주소) — 처리하는 동안 preview(photoId) 로 보인다. 없으면 camera.shotInfo(blob).preview
export async function ingest(recordId, blob, { source = 'incam', takenAt, takenAtSource, gps = null, turns, aspect, id, original = null, tempPath = null, preview: pv = null, wait = false, now = Date.now() } = {}) {
  bump(1);
  let photo;
  const pid = id || uid('p');
  try {
    const shot = blob instanceof Blob ? shotInfo(blob) : null;
    const info = turns != null || aspect != null ? { turns: turns || 0, aspect: aspect || null } : shot;
    const xform = hasXform(info) ? { turns: info.turns || 0, aspect: info.aspect || null } : null;
    setPreview(pid, pv || shot?.preview || null);                           // 메타가 저장돼 사진 줄에 칸이 생기는 순간 이미 그림이 있게
    const raw = blob instanceof Uint8Array ? blob : new Uint8Array(await blob.arrayBuffer());
    const orig = original ? { name: original.name ?? null, savedTo: original.savedTo ?? null, uri: original.uri ?? null, at: now } : null;
    photo = await store.addIncoming(recordId, { id: pid, raw, takenAt: takenAt ?? now, takenAtSource: takenAtSource || (source === 'incam' ? 'camera' : 'file'), source, gps, xform, tempPath, original: orig, now });
    mem.set(pid, { raw, xform, original, tempPath });
    const p = enqueue(pid);
    if (wait) { await p; return store.photo(pid); }
    return photo;
  } catch (e) {
    if (!photo) dropPreview(pid);
    throw e;
  } finally { bump(-1); }
}

// 갤러리·휴대폰 카메라 앱(웹 <input>) 파일 여러 장 — 한 장씩 디스크에 넣고 처리. 한 장이 실패해도 계속 → { ok, failed }
export async function ingestFiles(recordId, files, { source = 'gallery' } = {}) {
  const ids = [];
  let failed = 0;
  for (const f of Array.from(files || [])) {
    try {
      const lm = msOf(f.lastModified);
      const when = source === 'syscam' ? { takenAt: Date.now(), takenAtSource: 'camera' } : lm != null ? { takenAt: lm, takenAtSource: 'file' } : { takenAt: Date.now(), takenAtSource: 'manual' };
      const p = await ingest(recordId, f, { source, ...when });
      ids.push(p.id);
    } catch (e) { failed++; console.warn('가져오기 실패', f?.name, e); }
  }
  await idle();
  for (const id of ids) if (store.photo(id)?.state !== 'ready') failed++;
  return { ok: ids.length - ids.filter(id => store.photo(id)?.state !== 'ready').length, failed };
}

// APK: 휴대폰 카메라 앱(네이티브 Shot.take — 임시 파일 경로를 photoId 로 미리 정해 앱이 죽어도 listTemp 로 되살린다) → ingest.
// 웹: null(호출자가 <input capture> + ingestFiles). 취소면 null. 묶음은 부르기 전에 저장돼 있어야 한다(§4.5)
export async function shootSystem(recordId, { gps = null } = {}) {
  if (!native.isNative()) return null;
  if (!store.record(recordId)) throw Object.assign(new Error('묶음을 찾을 수 없어요'), { code: 'NO_RECORD' });
  if (sysShot) throw Object.assign(new Error('이미 카메라가 열려 있어요'), { code: 'BUSY' });
  const id = uid('p'), s = store.settings();
  sysShot = id;
  try {
    // 카메라 앱을 띄운 사이 앱이 죽으면 이 기록으로 원래 묶음·좌표에 되살린다(공시체 BUGREPORT) — 띄우기 전에 디스크에
    await store.setMeta('pendingShot', { photoId: id, recordId, gps, at: Date.now() });
    let r;
    try { r = await native.take({ photoId: id, prefer: s.galleryPref === 'phone' ? 'phone' : 'sd' }); }
    catch (e) { if (e?.code === 'CANCEL') { await clearPending(id); return null; } throw e; }
    const at = Date.now();
    if (r.sdMissed && !sdToastShown) { sdToastShown = true; notice('SD카드에 못 넣어 휴대폰에 저장했어요'); }
    const bytes = await native.readBytes(r.path);
    const p = await ingest(recordId, bytes, { id, source: 'syscam', takenAt: at, takenAtSource: 'camera', gps, original: { name: r.name, savedTo: r.savedTo, uri: r.uri }, tempPath: r.path });
    await clearPending(id);
    return p;
  } finally { sysShot = null; }   // 그 밖의 실패는 pendingShot 을 남긴다 — 임시 파일이 있으면 recover 가 원래 묶음으로 입양한다
}
let sysShot = null;               // 지금 카메라 앱이 찍는 중인 photoId(두 번 띄우지 않게, recover 가 건드리지 않게)
export const systemBusy = () => !!sysShot;
async function clearPending(id) {
  const ps = store.meta('pendingShot', null);
  if (ps && (!id || ps.photoId === id)) await store.setMeta('pendingShot', null).catch(() => {});
}
// 카메라 앱 중 죽었다 살아난 사진이 들어갈 곳 — 원래 묶음이 살아 있으면 거기(좌표도), 아니면 「복구된 사진」
async function targetOf(pid) {
  const ps = store.meta('pendingShot', null);
  if (ps && pid && ps.photoId === pid) {
    const r = store.record(ps.recordId);
    if (r && !r.deletedAt) return { rid: r.id, gps: ps.gps || null };
  }
  return { rid: await rescueRecord(), gps: null };
}

// ---- 부팅 복구 ----
// appRestoredResult(카메라 앱을 띄운 사이 앱이 죽었다 살아남)는 store 가 열리기 전에 올 수 있다 → 큐에 담아 recover 가 소비
const restored = [];
// app.js 가 native.onRestored 를 받아 넘긴다(여기서 따로 구독하지 않는다 — 두 번 받지 않게) → recover 결과 | null
// 부팅 때 app.js 는 recover 전에 queueRestored 로 먼저 넣는다 — 첫 recover 가 힌트(갤러리 저장 정보) 없이 임시 파일을 입양하지 않게
export function queueRestored(e) {
  if (e?.pluginId !== 'Shot' || (e.methodName && e.methodName !== 'take')) return false;
  restored.push(e);
  return true;
}
export async function handleRestored(e) {
  if (!queueRestored(e)) return null;
  if (store.isReady?.() === false) return null;                           // 아직 안 열림 — 부팅 recover 가 소비
  if (recovering) await recovering;
  return recover();
}

let recovering = null;
// processing 재처리, 주인 없는 incoming·카메라 앱 임시 파일 입양 → { resumed, adopted }
export function recover() {
  if (recovering) return recovering;
  recovering = recoverNow().finally(() => { recovering = null; });
  return recovering;
}

let rescueRec = null;
async function rescueRecord() {
  if (rescueRec && store.record(rescueRec) && !store.record(rescueRec).deletedAt) return rescueRec;
  const r = await store.createRecord({ day: dayKey(Date.now()), content: '복구된 사진' });
  rescueRec = r.id;
  return r.id;
}

async function recoverNow() {
  const res = { resumed: 0, adopted: 0 };
  // ① processing — incoming 에서 다시
  for (const p of store.dump().photos) if (p.state === 'processing' && !queued.has(p.id)) { enqueue(p.id); res.resumed++; }
  // ①-2 일시적 실패(용량·메모리·저장 순간 오류)로 failed 가 된 사진 — incoming 이 남아 있으면 다시(부팅 때 한 번씩)
  for (const p of store.dump().photos) {
    if (!canRetry(p) || queued.has(p.id)) continue;
    try { if (await store.retryPhoto(p.id)) { enqueue(p.id); res.resumed++; } } catch (e) { console.warn('다시 처리 못 함', p.id, e); }
  }

  // ② 주인 없는 incoming(메타 저장 전에 죽음·DB 오류) → 「복구된 사진」 묶음
  let ids = [];
  try { ids = await (await import('../data/photofs.js')).list('incoming'); } catch (e) { console.warn('incoming 목록 실패', e); }
  for (const oid of ids) {
    if (store.photo(oid) || queued.has(oid)) continue;
    try {
      const fs = await import('../data/photofs.js');
      const b = await fs.get('incoming', oid);
      if (!b || !b.size) { await fs.remove('incoming', oid).catch(() => {}); continue; }
      const raw = new Uint8Array(await b.arrayBuffer());
      const rid = await rescueRecord();
      await ingest(rid, raw, { id: oid, source: 'incam', takenAt: Date.now(), takenAtSource: 'file' });
      res.adopted++;
    } catch (e) { console.warn('주인 없는 사진을 살리지 못했어요', oid, e); }
  }

  // ③ (APK) 카메라 앱 결과·임시 파일
  if (native.isNative()) {
    const hints = new Map();
    while (restored.length) {
      const e = restored.shift(), d = e?.data ?? {};
      if (e?.success !== false && !d.cancelled && d.path) hints.set(d.photoId || d.path, d);
    }
    const temps = await native.listTemp().catch(() => []);
    const seen = new Set();
    const one = async (path, name, at, hint) => {
      if (!path || seen.has(path)) return;
      seen.add(path);
      const m = /(p_[0-9a-z]{4,32})/i.exec(name || path);
      const pid = hint?.photoId || (m ? m[1] : null);
      if (pid && pid === sysShot) return;                                    // 지금 찍는 중(카메라 앱이 쓰는 중인 파일)
      const cur = pid ? store.photo(pid) : null;
      const orig = hint?.savedTo ? { name: hint.name ?? null, savedTo: hint.savedTo, uri: hint.uri ?? null, at: Date.now() } : null;
      if (cur) {                                                             // 이미 들어온 사진의 남은 임시 파일
        if (orig && !cur.original?.savedTo) await store.updatePhoto(cur.id, { original: orig }).catch(() => {});   // 힌트 없이 먼저 입양됐으면 갤러리 정보를 채운다
        if (cur.state === 'ready' || cur.deletedAt) await native.deleteTemp(path);
        return;
      }
      try {
        const raw = await native.readBytes(path);
        if (!raw?.length) { await native.deleteTemp(path); return; }
        const { rid, gps } = await targetOf(pid);
        await ingest(rid, raw, { id: pid && !store.photo(pid) ? pid : undefined, source: 'syscam', takenAt: msOf(at) ?? Date.now(), takenAtSource: hint ? 'camera' : 'file', gps, original: orig, tempPath: path });
        if (pid) await clearPending(pid);
        res.adopted++;
      } catch (e) { console.warn('카메라 임시 파일을 살리지 못했어요', path, e); }
    };
    for (const d of hints.values()) await one(d.path, d.name, Date.now(), d);
    for (const t of temps) await one(t.path, t.name, t.at, null);
    // 남은 pendingShot — 이미 들어왔거나 하루 넘게 임시 파일이 안 나타나면 치운다(지금 찍는 중이면 그대로)
    const ps = store.meta('pendingShot', null);
    if (ps && ps.photoId !== sysShot && (store.photo(ps.photoId) || Date.now() - (ps.at || 0) > 864e5)) await clearPending(ps.photoId);
    // ④ 갤러리에 넣기 전에 앱이 죽어 남은 원본 사본 → 원본 줄로(사진이 아직 처리 중이면 처리가 끝난 뒤 afterReady 가 다시 세운다)
    try {
      const fs = await fsMod();
      for (const oid of await fs.list('original')) {
        const cur = store.photo(oid);
        if (!cur) { if (!queued.has(oid)) await fs.remove('original', oid).catch(() => {}); continue; }
        if (cur.state === 'ready') queueOriginal(oid);
      }
    } catch (e) { console.warn('남은 갤러리 원본을 잇지 못했어요', e); }
    retryOriginals().catch(() => {});
  }
  return res;
}
