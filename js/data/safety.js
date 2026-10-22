// 메타데이터 안전판(설계서 §4.5) — IndexedDB 가 통째로 또는 일부 사라지는 사고(공시체 2026-08, 원본 현장사진대지 9/22)에 대비해 여러 겹으로 남긴다.
//   ① 미러(APK): 묶음이 바뀌면(1초 묶어서) DATA/mirror/r-<id>.json(묶음 + 그 묶음의 모든 사진 메타), mirror/meta.json(설정·lastLocation 등),
//      mirror/drawings.json(도면보관함 핀·기준점·도면 메타 — v0.1.4)
//   ② 자동 파일 백업(APK): 메타 전체 JSON 을 DATA/backup/ 와 DOCUMENTS/현장사진대지 lite/백업/ 에 원자적 쓰기, 14세대, 줄어듦 방지.
//      폴더마다 index.json(이름·시각·묶음 수 — core/backup.js indexRow)을 두고, 보관 정리·줄어듦 판정·부팅 복구 확인은 그것만 읽는다(속도 감사 #1·#3)
//   ③ localStorage 백업(웹·APK 둘 다 — 저장 계층이 달라 IDB 와 같이 죽는 일이 드물다): 현재 + 직전 세대 하나, 용량 초과는 조용히.
//      작은 머리 키(K_HEAD: 시각·개수·묶음 id)로 돌리기·복구 확인을 해 큰 JSON 을 읽지 않는다. APK 에서는 하루 한 번(파일 백업이 있으니)
//   ④ 복구 후보 찾기(checkRestore) → 사용자가 고르면 restoreFrom. 사진 본체는 파일 저장소에 남아 있으면 그대로 다시 연결된다
// 도면보관함(별도 DB)만 잃는 사고(v0.1.4 검토 blocker): 줄어듦 판정(core/backup.js dwLoss)이 도면·핀 수도 본다 —
//   영구 삭제 기록(tombstone)만큼 줄어든 것은 정상, 그 밖에 줄면 「잃은 것」 → 덮지 않고 따로 남긴다
//   (localStorage 직전 칸·K_DWKEEP, 파일 -줄어듦·도면이 가장 많은 세대, 미러 drawings-prev.json). 덤프를 못 뜨면(null) 직전 것을 옮겨 싣는다
// 쓰는 쪽(미러·백업·localStorage)의 겹은 그대로, 읽는 쪽만 줄였다: 부팅 때 미러는 파일 이름만(r-<id>.json → id), 백업은 index.json 만,
//   잃은 것이 보일 때만 그 본문을 읽는다(원본 store.js listShards·findOffer).
// 폴더(v0.1.5, data/folders.js — 자료함·도면보관함 폴더와 배치): 백업 JSON 의 folders 칸, 미러 mirror/folders.json, localStorage K_FDKEEP 한 칸.
//   폴더 DB 가 비었는데(못 열었거나 잃음 — 지운 폴더는 묘비가 30일 남아 일부러 비는 일은 드물다) 직전 덤프가 있으면 그것을 옮겨 싣고,
//   처음 열 때 폴더 DB 가 통째로 비어 있으면 보관 칸·미러에서 조용히 합친다(mergeFolders — 이 기기 것이 늘 이기고 묘비는 되살리지 않는다).
// 미러·하루 백업 쓰기는 한가할 때(native.whenQuiet — 최근 2초 안에 셔터·글 입력이 없고 글 칸이 비활성, 2026-10-22 폰 "찍은 직후 글이 늦게 쳐짐").
//   백그라운드로 갈 때(onPause)는 미러만 바로 쓰고, 파일 백업은 바뀐 게 있고 마지막 파일 백업 뒤 10분이 지났거나 날이 바뀌었을 때만(속도 감사 #2).
import * as N from '../platform/native.js';
import * as store from './store.js';
import {
  makeBackupJson, parseBackupJson, rotateLocal, cleanDrawingsDump, dwStatOf, dwLoss,
  parseIndex, indexText, indexRow, reconcileIndex, bestRow, bestDwRow, todayFile, planRetention, AUTO_NAME_RE,
} from '../core/backup.js';
import { dayKey } from '../core/date.js';
import { APP_VERSION } from '../config.js';

const DATA = 'DATA', DOCS = 'DOCUMENTS';
const DOC_ROOT = N.DOC_ROOT || '현장사진대지 lite';
const K_BAK = 'sajindaeji-lite.autobackup.v1';
const K_BAK2 = 'sajindaeji-lite.autobackup.prev.v1';
const K_HEAD = 'sajindaeji-lite.autobackup.head.v1';                       // { cur: Head, prev: Head } — Head = { at, day, live, n, ids, dw, pins, pdw, ppins }
const K_DWKEEP = 'sajindaeji-lite.autobackup.drawings.v1';                  // 도면보관함 덤프만(작다) — 잃은 것 없이 바뀔 때만 새로(도면 DB 만 잃었을 때 되살릴 곳)
const K_FDKEEP = 'sajindaeji-lite.autobackup.folders.v1';                   // 폴더 덤프만(작다) — 비지 않았을 때만 새로(폴더 DB 만 잃었을 때 되살릴 곳)
const MIRROR_DELAY = 1000;
const KEEP = 14;
const DAY = 864e5;
const FILE_GAP = 10 * 60 * 1000;                                             // 백그라운드 파일 백업 최소 간격(같은 날)
// 이것만 바뀐 건 백업할 변화가 아니다(촬영 화면이 자주 쓰는 표지 포함 — 셔터 한 번에 앱 전환마다 전체 백업이 돌던 것)
const QUIET_META = ['lastAutoBackup', 'lastAutoBackupAt', 'restoreSnooze', 'restoreVerified', 'lastShotAt', 'captureLayout', 'captureDoc', 'captureDrawing', 'pendingShot'];
const MIRROR_META = ['settings', 'lastLocation', 'installId', 'seqMax', 'purgedIds', 'lastBackupAt'];
const FOLDERS = [
  { dir: DATA, folder: 'backup', label: '앱 안' },
  { dir: DOCS, folder: `${DOC_ROOT}/백업`, label: '문서 폴더' },             // 앱을 지워도 남는다(최선 노력)
];
const fkey = f => `${f.dir}:${f.folder}`;

let started = false, dirty = true, mirrorTimer = null, mirrorMeta = false, mirrorDw = false, mirrorFd = false;
const mirrorIds = new Set();
let mirrorChain = Promise.resolve(), backupChain = Promise.resolve();
const offs = [];
let mirrorNames = null;                                                      // Set(파일 이름) — 한 실행 안에서 readdir 한 번(seedMirror·checkRestore 가 나눠 씀)
const idxCache = new Map();                                                  // 폴더 → { rows, reconciled }

const native = () => !!N.isNative?.();
const ls = () => { try { return globalThis.localStorage || null; } catch { return null; } };
const readLs = key => { try { const t = ls()?.getItem(key); return t ? JSON.parse(t) : null; } catch { return null; } };

// 도면보관함(별도 DB) — 부팅에서 열지 않는다. 백업·복구 때만 동적으로(없으면 조용히 빠짐)
let dwMod = null;
async function drawingsMod({ open = true } = {}) {
  try {
    if (!dwMod) dwMod = await import('./drawings.js');
    if (open && typeof dwMod.ready === 'function') await dwMod.ready();
    return dwMod;
  } catch (e) { console.warn('도면보관함을 열지 못했어요(백업에서 뺌)', e); return null; }
}
let lastDump = null;                                                         // 이 실행에서 마지막으로 뜬 덤프(못 뜰 때 옮겨 싣기)
async function drawingsDump() {
  const dw = await drawingsMod();
  try { const d = dw?.dumpDrawings ? cleanDrawingsDump(dw.dumpDrawings()) : null; if (d) lastDump = d; return d; } catch { return null; }
}
// 백업에 실을 덤프 — 도면 DB 를 못 열면(null) drawings:null 로 멀쩡한 칸을 덮지 않게 직전 것을 옮겨 싣는다(이 실행 → localStorage 보관 → 미러)
async function dumpForBackup() {
  const d = await drawingsDump();
  if (d) return d;
  if (lastDump) return lastDump;
  const kept = cleanDrawingsDump(readLs(K_DWKEEP)?.dump);
  if (kept) return kept;
  if (native()) { try { const m = await readMirrorDrawings(); if (m?.dump) return m.dump; } catch { /* 없음 */ } }
  return null;
}

// 폴더(별도 DB) — 부팅에서 열지 않는다(모듈만 불러 구독). 백업·복구 때만 연다
let fdMod = null;
async function foldersMod({ open = true } = {}) {
  try {
    if (!fdMod) fdMod = await import('./folders.js');
    if (open) await fdMod.ready();
    return fdMod;
  } catch (e) { console.warn('폴더를 열지 못했어요(백업에서 뺌)', e); return null; }
}
const cleanFd = d => (d && typeof d === 'object' && Number.isFinite(d.v) && Array.isArray(d.folders) && Array.isArray(d.places) ? d : null);
const hasFd = d => !!d && (d.folders.length > 0 || d.places.length > 0);
// backup.json 글·객체 → parseBackupJson 결과 + folders(core/backup.js 가 모르는 칸)
function parseFull(input) {
  let o = input;
  if (typeof input === 'string') { try { o = JSON.parse(input); } catch { o = input; } }
  return { ...parseBackupJson(o), folders: cleanFd(o?.folders) };
}
let lastFd = null;                                                           // 이 실행에서 마지막으로 뜬 비지 않은 폴더 덤프
// 폴더 DB 는 여기서 새로 열지 않는다 — 떠날 때(pagehide) 백업이 IndexedDB 열기를 기다리다 페이지가 닫혀
//   localStorage 백업이 통째로 빠졌다(v0.1.5 검증, e2e §9-9). 이 실행에서 아직 안 열었으면 바뀐 것도 없다 → 직전 덤프를 옮겨 싣는다
async function foldersForBackup() {
  const F = await foldersMod({ open: false });
  let d = null;
  try { d = F && (typeof F.isOpen !== 'function' || F.isOpen()) ? cleanFd(F.dumpFolders()) : null; } catch { d = null; }
  if (hasFd(d)) { lastFd = d; return d; }
  if (lastFd) return lastFd;                                                 // 이 실행에서 연 것이 가장 새롭다
  const carry = await newestKeptFd();
  return hasFd(carry) ? carry : null;
}
// 보관 칸(K_FDKEEP)·미러(folders.json) 중 at 이 가장 새로운 덤프 — 순서를 고정하면 하루 한 번만 쓰던 옛 보관 칸이
//   최신 미러를 이겨 오늘 파일 백업을 옛 폴더 상태로 덮었다(검토 때 재현, v0.1.5). 보관 칸은 이제 폴더가 바뀔 때마다 새로 쓴다
async function newestKeptFd() {
  const k = readLs(K_FDKEEP);
  const cands = [{ at: Number(k?.at) || 0, dump: cleanFd(k?.dump) }];
  if (native()) { const m = await readMirrorFolders({ withAt: true }).catch(() => null); if (m) cands.push(m); }
  let best = null;
  for (const c of cands) if (hasFd(c.dump) && (!best || c.at > best.at)) best = c;
  return best?.dump || null;
}
// 처음 열 때 폴더 DB 가 통째로 비어 있으면(묘비·배치 하나 없음) 보관 칸·미러 중 가장 새로운 것을 합친다
async function healFolders(F) {
  try {
    if (hasFd(cleanFd(F.dumpFolders()))) return;
    const keep = await newestKeptFd();
    if (!hasFd(keep)) return;
    const r = await F.mergeFolders(keep);
    if (r?.added) console.info('폴더를 되살렸어요', r);
  } catch (e) { console.warn('폴더 되살리기 실패', e); }
}

// ---- 시작 ----
export async function startSafety() {
  if (started) return;
  started = true;
  offs.push(store.on(ev => {
    const metaKeys = [...ev.meta];
    if (ev.records.size || ev.photos.size || ev.settings || metaKeys.some(k => !QUIET_META.includes(k))) dirty = true;
    if (!native()) return;
    ev.records.forEach(id => mirrorIds.add(id));
    if (ev.settings || metaKeys.some(k => MIRROR_META.includes(k))) mirrorMeta = true;
    if (mirrorIds.size || mirrorMeta) scheduleMirror();
  }));
  // 도면·핀이 바뀌면 백업할 변화 + 미러 drawings.json (모듈만 불러 구독 — DB 는 열지 않는다)
  drawingsMod({ open: false }).then(dw => {
    if (!started || typeof dw?.onDrawings !== 'function') return;
    offs.push(dw.onDrawings(ev => { if (ev?.init) return; dirty = true; if (native()) { mirrorDw = true; scheduleMirror(); } }));   // 처음 열기(init)는 바뀐 게 아니다
  });
  // 폴더가 바뀌면 같게(미러 folders.json). 처음 열기는 바뀐 게 아니고, 그때 통째로 비었으면 되살린다
  foldersMod({ open: false }).then(F => {
    if (!started || typeof F?.onFolders !== 'function') return;
    offs.push(F.onFolders(ev => {
      if (ev?.init) { healFolders(F); return; }
      dirty = true; if (native()) { mirrorFd = true; scheduleMirror(); }
      // 보관 칸은 바뀔 때마다 바로(덤프가 작다) — APK 의 localStorage 백업은 하루 한 번이라 그것만 믿으면 낡는다
      try { const d = cleanFd(F.dumpFolders()); if (hasFd(d)) { lastFd = d; const L = ls(); if (L) keepFoldersLocal(L, d, Date.now()); } } catch (e) { console.warn('폴더 보관 칸 쓰기 실패', e); }
    }));
  });
  offs.push(N.onPause?.(() => {
    flushMirror();
    const now = Date.now(), last = lastAutoBackup()?.at || 0;
    const newDay = dayKey(last) !== dayKey(now);
    if (!native()) { if (dirty || newDay) backupNow({ reason: 'pause' }).catch(e => console.warn('자동 백업 실패', e)); return; }   // 웹: localStorage 가 유일한 자동 안전판
    if (newDay || (dirty && now - last >= FILE_GAP)) backupNow({ reason: 'pause' }).catch(e => console.warn('자동 백업 실패', e));
  }) || (() => {}));
  // 앱을 켠 채 날이 바뀌어도 하루 한 번은 남게
  const timer = setInterval(() => quiet().then(daily).catch(() => {}), 60 * 60 * 1000);
  offs.push(() => clearInterval(timer));
  if (native()) await seedMirror().catch(e => console.warn('미러 처음 쓰기 실패', e));
  quiet().then(daily).catch(e => console.warn('자동 백업 실패', e));       // 부팅을 기다리게 하지 않는다 — 첫 화면·첫 셔터가 먼저
}
const quiet = () => (N.whenQuiet ? N.whenQuiet({ quietMs: 2000, maxMs: 60000 }) : Promise.resolve());

// 글 입력 중 붙잡기(app.js 가 dom.onTyping 으로 잇는다) — 미러·백업은 이미 native.whenQuiet(글 칸 포커스·최근 입력)을 기다리므로
// 여기서는 입력 시작을 「바쁨」으로 찍어 2초 더 미루기만 한다(풀 때 따로 할 일 없음)
export function hold(on) { if (on) N.markBusy?.(); }

// 시험용 — 구독·타이머를 끄고 캐시를 비운다
export function stopSafety() {
  offs.splice(0).forEach(f => { try { f(); } catch { /* 없음 */ } });
  clearTimeout(mirrorTimer); mirrorTimer = null;
  started = false;
  mirrorNames = null; idxCache.clear(); mirrorDwStat = undefined; lastDump = null; lastFd = null;
}

async function daily() {
  const last = lastAutoBackup()?.at || 0;
  if (last && dayKey(last) === dayKey(Date.now())) return null;
  return backupNow({ reason: 'daily' });
}

// ---- 미러(APK) ----
let mirrorWaiting = false;
function scheduleMirror() {
  if (mirrorTimer || mirrorWaiting) return;
  mirrorTimer = setTimeout(() => {
    mirrorTimer = null; mirrorWaiting = true;
    const q = N.whenQuiet ? N.whenQuiet({ quietMs: 2000, maxMs: 15000 }) : Promise.resolve();
    q.then(() => { if (mirrorWaiting) { mirrorWaiting = false; flushMirror(); } });
  }, MIRROR_DELAY);
}
function flushMirror() {
  clearTimeout(mirrorTimer); mirrorTimer = null; mirrorWaiting = false;
  if (!native()) { mirrorIds.clear(); mirrorMeta = false; mirrorDw = false; mirrorFd = false; return mirrorChain; }
  const ids = [...mirrorIds]; mirrorIds.clear();
  const withMeta = mirrorMeta; mirrorMeta = false;
  const withDw = mirrorDw; mirrorDw = false;
  const withFd = mirrorFd; mirrorFd = false;
  mirrorChain = mirrorChain.then(async () => {
    for (const id of ids) await writeShard(id).catch(e => console.warn('미러 쓰기 실패', id, e));   // 쓸 때 그 시점의 최신 캐시를 읽는다
    if (withMeta) await writeMirrorMeta().catch(e => console.warn('미러 meta 쓰기 실패', e));
    if (withDw) await writeMirrorDrawings().catch(e => console.warn('미러 도면 쓰기 실패', e));
    if (withFd) await writeMirrorFolders().catch(e => console.warn('미러 폴더 쓰기 실패', e));
  });
  return mirrorChain;
}
export const mirrorIdle = () => flushMirror();

async function writeShard(id) {
  const name = `r-${id}.json`, path = `mirror/${name}`, r = store.record(id);
  if (!r) { await N.fsDelete(DATA, path).catch(() => {}); mirrorNames?.delete(name); return; }   // 영구 삭제된 묶음
  await N.atomicWrite(DATA, path, JSON.stringify({ v: 1, at: Date.now(), record: r, photos: store.photosOfAll(id) }));
  mirrorNames?.add(name);
}
async function writeMirrorMeta() {
  const m = {};
  for (const k of MIRROR_META) { const v = k === 'settings' ? store.meta('settings') : store.meta(k); if (v !== undefined) m[k] = v; }
  await N.atomicWrite(DATA, 'mirror/meta.json', JSON.stringify({ v: 1, at: Date.now(), meta: m }));
  mirrorNames?.add('meta.json');
}
// drawings.json = 지금 도면보관함. 새 덤프가 지금 미러보다 잃은 게 있으면(tombstone 으로 설명 안 됨) 지금 미러를 drawings-prev.json 으로 돌린 뒤 쓴다
//   (이미 있는 prev 가 더 크면 그대로). 지금 미러의 개수는 이 실행에서 한 번만 읽는다
let mirrorDwStat;                                                            // undefined = 아직 모름, null = 파일 없음
async function readMirrorFile(name) {
  try { const o = JSON.parse(await N.fsRead(DATA, `mirror/${name}`, { utf8: true })); const dump = cleanDrawingsDump(o?.dump); return dump ? { ...o, dump, counts: dwStatOf(dump) } : null; } catch { return null; }
}
async function writeMirrorDrawings() {
  const d = await drawingsDump();
  if (!d) return;                                                            // 도면 DB 를 못 열었다 — 멀쩡한 미러를 덮지 않는다
  const stat = dwStatOf(d);
  const names = await listMirror();
  if (mirrorDwStat === undefined) mirrorDwStat = names.has('drawings.json') ? ((await readMirrorFile('drawings.json'))?.counts || null) : null;
  if (mirrorDwStat && dwLoss(stat, mirrorDwStat)) {
    const prev = names.has('drawings-prev.json') ? (await readMirrorFile('drawings-prev.json'))?.counts : null;
    if (!prev || !dwLoss(mirrorDwStat, prev)) {
      try { await N.fsCopy(DATA, 'mirror/drawings.json', DATA, 'mirror/drawings-prev.json'); names.add('drawings-prev.json'); }
      catch (e) { console.warn('미러 도면 직전 칸 남기기 실패 — 덮지 않아요', e); return; }
    }
  }
  await N.atomicWrite(DATA, 'mirror/drawings.json', JSON.stringify({ v: 1, at: Date.now(), counts: stat, dump: d }));
  mirrorDwStat = stat;
  names.add('drawings.json');
}
// folders.json = 지금 폴더·배치. 비었으면(못 열었거나 잃음) 멀쩡한 미러를 덮지 않는다
async function writeMirrorFolders() {
  const F = await foldersMod();
  const d = F ? cleanFd(F.dumpFolders()) : null;
  if (!hasFd(d)) return;
  await N.atomicWrite(DATA, 'mirror/folders.json', JSON.stringify({ v: 1, at: Date.now(), dump: d }));
  mirrorNames?.add('folders.json');
}
// withAt: { at, dump } 로(가장 새로운 것 고르기용)
async function readMirrorFolders({ withAt = false } = {}) {
  const names = await listMirror();
  if (!names.has('folders.json')) return null;
  try {
    const o = JSON.parse(await N.fsRead(DATA, 'mirror/folders.json', { utf8: true }));
    const dump = cleanFd(o?.dump);
    return withAt ? (dump ? { at: Number(o?.at) || 0, dump } : null) : dump;
  } catch { return null; }
}
async function listMirror() {
  if (!mirrorNames) mirrorNames = new Set((await N.fsList(DATA, 'mirror')).map(f => f.name));
  return mirrorNames;
}
// 업데이트 뒤 처음 켰을 때 등 — 미러 조각이 없는 묶음을 한 번 채운다(목록은 checkRestore 와 나눠 쓴다)
async function seedMirror() {
  const have = await listMirror();
  for (const r of store.snapshot().records) if (!have.has(`r-${r.id}.json`)) mirrorIds.add(r.id);
  if (!have.has('meta.json')) mirrorMeta = true;
  if (mirrorIds.size || mirrorMeta) await flushMirror();
}
const shardIds = names => [...names].flatMap(n => { const m = /^r-(.+)\.json$/.exec(n); return m ? [m[1]] : []; });

// 잃은 묶음의 조각만 읽는다(+ meta·drawings) → 후보 본문
async function readMirror(ids) {
  const records = [], photos = [];
  let at = 0;
  for (const id of ids) {
    try {
      const o = JSON.parse(await N.fsRead(DATA, `mirror/r-${id}.json`, { utf8: true }));
      if (!o?.record?.id) continue;
      records.push(o.record); photos.push(...(Array.isArray(o.photos) ? o.photos : []));
      at = Math.max(at, Number(o.at) || 0);
    } catch { /* 깨진 조각은 건너뛴다 */ }
  }
  let meta = {};
  try { meta = JSON.parse(await N.fsRead(DATA, 'mirror/meta.json', { utf8: true }))?.meta || {}; } catch { /* 없음 */ }
  const drawings = (await readMirrorDrawings())?.dump || null;
  const folders = await readMirrorFolders().catch(() => null);
  return { source: 'mirror', records, photos, settings: meta.settings || null, lastLocation: meta.lastLocation || null, drawings, folders, at };
}
// drawings.json·drawings-prev.json 중 도면이 더 많은 쪽(같으면 핀 → 지금 것)
async function readMirrorDrawings() {
  const names = await listMirror();
  const a = names.has('drawings.json') ? await readMirrorFile('drawings.json') : null;
  const b = names.has('drawings-prev.json') ? await readMirrorFile('drawings-prev.json') : null;
  if (!a || !b) return a || b;
  return dwLoss(a.counts, b.counts) ? b : a;
}

// ---- 자동 백업 ----
async function snapshotJson(now, today) {
  const s = store.snapshot();                                                // 첫 await 전에(같은 틱) — backupNow 의 dirty 내리기와 짝
  const drawings = await dumpForBackup();
  const b = makeBackupJson({ records: s.records, photos: s.photos, settings: s.settings, lastLocation: s.lastLocation, now, appVersion: APP_VERSION, installId: s.installId, drawings });
  const folders = await foldersForBackup();
  if (folders && !b.folders) { b.folders = folders; b.counts.folders = folders.folders.filter(f => !f.deletedAt).length; }
  b.day = today;                                                             // localStorage 돌리기용 — 파일과 같은 글을 한 번만 만든다
  return b;
}

// localStorage — 현재 + 직전 세대(core/backup.js rotateLocal: 가장 좋은 세대는 늘 한 칸에 남는다, 공시체 K_BAK2)
// 돌리기는 머리(K_HEAD)만 보고 정한다(큰 JSON 을 두 번 parse 하지 않게). 머리가 없으면(옛 판) 한 번만 본문으로 만든다.
// 용량(보통 5MB)이 모자라면 사진 메타를 줄인 판으로 한 번 더 — 그래도 안 되면 false(lastAutoBackup.localFailed 로 설정에 알린다)
const slimPhoto = p => ({ id: p.id, recordId: p.recordId, createdAt: p.createdAt, takenAt: p.takenAt, takenAtSource: p.takenAtSource, source: p.source,
  state: p.state, gps: p.gps ? { lat: p.gps.lat, lng: p.gps.lng, acc: p.gps.acc ?? null } : null, original: p.original?.name ? { name: p.original.name } : null, deletedAt: p.deletedAt ?? null });
const headOf = b => {
  const s = dwStatOf(b?.drawings);
  return { at: Number(b?.at) || 0, day: b?.day || (b?.at ? dayKey(b.at) : ''), live: liveOf(b), n: (b?.records || []).length,
    ids: (b?.records || []).map(r => r?.id).filter(Boolean), dw: s.drawings, pins: s.pins, pdw: s.purgedDrawings, ppins: s.purgedPins };
};
const liveOf = b => (Number.isFinite(b?.counts?.live) ? b.counts.live : (b?.records || []).filter(r => !r.deletedAt).length);
// rotateLocal 이 보는 모양(묶음 + 도면 개수)
const asRot = h => (h ? { day: h.day, counts: { live: h.live, drawings: h.dw || 0, pins: h.pins || 0, purgedDrawings: h.pdw || 0, purgedPins: h.ppins || 0 } } : null);
function localHeads() {
  const h = readLs(K_HEAD);
  if (h && typeof h === 'object' && ('cur' in h)) return { cur: h.cur || null, prev: h.prev || null };
  const L = ls();
  if (!L || (!L.getItem(K_BAK) && !L.getItem(K_BAK2))) return { cur: null, prev: null };
  const cur = readLs(K_BAK), prev = readLs(K_BAK2);                          // 옛 판 — 한 번만
  const out = { cur: cur ? headOf(cur) : null, prev: prev ? headOf(prev) : null };
  try { L.setItem(K_HEAD, JSON.stringify(out)); } catch { /* 다음에 */ }
  return out;
}
function writeLocal(b, text, today) {
  const L = ls();
  if (!L) return false;
  const heads = localHeads();
  const r = rotateLocal({ cur: asRot(heads.cur), prev: asRot(heads.prev), next: { counts: { live: liveOf(b), ...dwStatOf(b.drawings) } }, today });
  keepDrawingsLocal(L, b.drawings, b.at);
  keepFoldersLocal(L, b.folders, b.at);
  const put = (t, head, mustPush) => {
    let prevHead = heads.prev;
    if (r.pushed) { try { L.setItem(K_BAK2, L.getItem(K_BAK)); prevHead = heads.cur; } catch (e) { if (mustPush) throw e; } }
    L.setItem(K_BAK, t);
    try { L.setItem(K_HEAD, JSON.stringify({ cur: head, prev: prevHead })); } catch { L.removeItem(K_HEAD); }   // 머리를 못 쓰면 지워서 다음에 본문으로 다시
  };
  const head = headOf(b);
  try { put(text, head, true); return true; } catch (e) { console.warn('localStorage 백업 — 줄인 판으로 다시', e?.name); }
  try { put(JSON.stringify({ ...b, photos: b.photos.map(slimPhoto), slim: true }), head, false); return true; }
  catch (e) { console.warn('localStorage 백업 건너뜀(용량)', e?.name); return false; }
}

// 도면 덤프 따로 한 칸(작다) — 잃은 것 없이 바뀌었을 때만 새로. 웹에서는 localStorage 가 유일한 자동 안전판이라 두 칸 돌리기와 따로 지킨다
function keepDrawingsLocal(L, d, at) {
  const dump = cleanDrawingsDump(d);
  if (!dump) return;
  try {
    const old = readLs(K_DWKEEP);
    const oldDump = cleanDrawingsDump(old?.dump);
    if (oldDump && dwLoss(dwStatOf(dump), dwStatOf(oldDump))) return;      // 잃은 것이 있다 — 예전 것을 그대로 둔다
    const text = JSON.stringify({ v: 1, at, dump });
    if (!oldDump && !dump.drawings.length && !dump.pins.length) return;     // 도면을 안 쓰면 칸을 만들지 않는다
    if (L.getItem(K_DWKEEP) !== text) L.setItem(K_DWKEEP, text);
  } catch (e) { console.warn('도면 보관 칸 쓰기 실패', e?.name); }
}

// 폴더 덤프 따로 한 칸(작다) — 비지 않았을 때만 새로
function keepFoldersLocal(L, d, at) {
  const dump = cleanFd(d);
  if (!hasFd(dump)) return;
  try {
    const text = JSON.stringify({ v: 1, at, dump });
    if (L.getItem(K_FDKEEP) !== text) L.setItem(K_FDKEEP, text);
  } catch (e) { console.warn('폴더 보관 칸 쓰기 실패', e?.name); }
}

// ---- 백업 폴더 목록(index.json) ----
const readText = async (f, name) => N.fsRead(f.dir, `${f.folder}/${name}`, { utf8: true });
async function rowOf(f, name, size) {
  try { return indexRow(name, JSON.parse(await readText(f, name)), size); } catch { return null; }   // 깨진 파일은 목록에서 뺀다
}
// 폴더를 다 훑어 목록을 만든다(index 가 없는 옛 폴더 — 한 번만) → rows
async function scanFolder(f, have = []) {
  const disk = new Map((await N.fsList(f.dir, f.folder)).filter(x => AUTO_NAME_RE.test(x.name)).map(x => [x.name, Number.isFinite(Number(x.size)) ? Number(x.size) : undefined]));
  const { rows, need } = reconcileIndex(have, disk);
  for (const n of need) { const r = await rowOf(f, n, disk.get(n)); if (r) rows.push(r); }
  return { rows, changed: need.length > 0 || rows.length !== have.length };
}
// 목록만 읽기(부팅 복구 확인) — index.json 하나. 없거나 깨졌으면 폴더를 훑어 만들고 써 둔다
async function readIndex(f) {
  const c = idxCache.get(fkey(f));
  if (c) return c.rows;
  let rows = null;
  try { rows = parseIndex(await N.fsRead(f.dir, `${f.folder}/index.json`, { utf8: true })); } catch { rows = null; }
  if (rows) { idxCache.set(fkey(f), { rows, reconciled: false }); return rows; }
  const s = await scanFolder(f);
  idxCache.set(fkey(f), { rows: s.rows, reconciled: true });
  if (s.rows.length) await N.atomicWrite(f.dir, `${f.folder}/index.json`, indexText(s.rows)).catch(e => console.warn('백업 목록 쓰기 실패', e));
  return s.rows;
}
// 쓰기 전 — 실행마다 한 번 폴더 실제 파일과 맞춘다(목록 쓰기 전에 끊긴 날·바깥에서 지운 파일)
async function reconciledIndex(f) {
  const rows = await readIndex(f);
  const c = idxCache.get(fkey(f));
  if (c?.reconciled) return c.rows;
  const s = await scanFolder(f, rows);
  idxCache.set(fkey(f), { rows: s.rows, reconciled: true });
  return s.rows;
}

// 하루 한 파일(자동백업-YYYYMMDD.json). 오늘 파일이 더 크면 덮지 않고 -줄어듦 파일로. 14세대 + 가장 좋은 것은 늘 남긴다.
// 브리지: 본 JSON(쓰기+이름 바꾸기) + index(쓰기+이름 바꾸기) + 지울 것이 있을 때만 지우기 — 다른 백업 본문은 읽지 않는다
async function writeFolder(f, b, text, size, now) {
  const rows = await reconciledIndex(f);
  const file = todayFile(rows, now, indexRow('', b));                       // 묶음·도면 어느 쪽이든 줄면 -줄어듦 으로
  await N.atomicWrite(f.dir, `${f.folder}/${file}`, text);
  let list = [...rows.filter(x => x.name !== file), indexRow(file, b, size)];
  try {
    for (const gone of planRetention(list, { keep: KEEP, protect: [file] })) {
      const ok = await N.fsDelete(f.dir, `${f.folder}/${gone}`).then(() => true, async () => !(await N.fsStat(f.dir, `${f.folder}/${gone}`)));
      if (ok) list = list.filter(x => x.name !== gone);
    }
  } catch (e) { console.warn('백업 보관 정리 실패', e); }
  idxCache.set(fkey(f), { rows: list, reconciled: true });
  try { await N.atomicWrite(f.dir, `${f.folder}/index.json`, indexText(list)); }
  catch (e) { console.warn('백업 목록 쓰기 실패', e); idxCache.set(fkey(f), { rows: list, reconciled: false }); }   // 다음 쓰기 때 폴더와 다시 맞춘다
}

// → { ok, where: string[] }
export function backupNow({ reason = 'manual', now = Date.now() } = {}) {
  const p = backupChain.then(async () => {
    await store.flush();
    const today = dayKey(now);
    const wasDirty = dirty;
    dirty = false;                                                           // snapshotJson 이 같은 틱에 store 스냅숏을 뜬다 — 그 뒤 변화는 구독이 다시 켠다
    const b = await snapshotJson(now, today);
    if (!b.records.length) { dirty = dirty || wasDirty; return { ok: false, where: [], reason: 'empty' }; }   // 빈 DB 로 멀쩡한 백업을 덮지 않는다
    const where = [];
    const text = JSON.stringify(b);                                          // 한 번만 만들어 localStorage·파일 양쪽에
    const app = native();
    // APK: localStorage 는 하루 한 번(파일 백업이 있다), 웹: 매번(유일한 자동 안전판)
    const headDay = app ? localHeads().cur?.day : null;
    const doLocal = !app || headDay !== today || reason === 'manual';
    const localOk = doLocal ? writeLocal(b, text, today) : null;
    if (localOk) where.push('이 브라우저');
    if (app) {
      const size = typeof Blob === 'function' ? new Blob([text]).size : text.length;
      for (const f of FOLDERS) {
        try { await writeFolder(f, b, text, size, now); where.push(f.label); }
        catch (e) { if (f.dir === DATA) console.warn('[자동 백업 앱 안]', e); }   // 문서 폴더는 기기·권한 따라 막힐 수 있다
      }
      if (localOk === null && !where.length) { if (writeLocal(b, text, today)) where.push('이 브라우저'); }   // 파일이 다 막혔으면 오늘 것도 localStorage 에
    }
    if (!where.length) dirty = true;
    const info = { at: now, where, reason };
    if (localOk === false && ls()) info.localFailed = true;                  // 웹은 이것이 유일한 자동 안전판 — 설정에 알린다
    try { await store.setMeta('lastAutoBackup', info); await store.setMeta('lastAutoBackupAt', now); } catch (e) { console.warn('백업 기록 실패', e); }
    return { ok: where.length > 0, where };
  });
  backupChain = p.then(() => {}, () => {});
  return p;
}

export function lastAutoBackup() {
  const m = store.isReady?.() ? store.meta('lastAutoBackup', null) : null;
  if (m?.at) return { at: m.at, where: m.where || [], localFailed: !!m.localFailed };
  const h = localHeads().cur;
  return h?.at ? { at: h.at, where: ['이 브라우저'] } : null;
}

// ---- 복구 ----
// 부팅 때(첫 화면 뒤 한가할 때): 후보 중 「지금 DB 에 없는 묶음」(영구 삭제한 것 제외)이 있는 것 → 가장 많이 되살리는 것. 없으면 null.
//   localStorage = 머리의 묶음 id, 미러 = 조각 파일 이름, 파일 백업 = index.json 의 개수(묶음 수가 지금 DB + 영구 삭제 수보다 많을 때만 그 한 파일 본문을 열어 확인).
//   도면보관함이 통째로 비었는데 후보에 도면이 있으면 그것도 「잃은 것」(missingDrawings)으로 센다.
// → { source, records, photos, settings, lastLocation, drawings, at, missing, missingDrawings, sig }
export async function checkRestore({ now = Date.now() } = {}) {
  const purged = new Set(store.meta('purgedIds', []));
  const lostOf = ids => ids.filter(id => id && !store.record(id) && !purged.has(id)).sort();
  const have = store.snapshot().records.length;
  const cands = [];
  let dwEmpty = false;
  const add = (c, lost, dw) => { if (lost.length || (dwEmpty && dw > 0)) cands.push({ ...c, missing: lost.length, missingDrawings: dwEmpty ? dw : 0, sig: lost.length ? `${c.source}:${lost.length}:${lost[0]}` : `${c.source}:dw:${dw}` }); };

  // 목록만 먼저(작은 머리·이름·index) — 도면 DB 는 후보 중 도면이 있는 것이 있을 때만 연다(부팅에서 도면 DB 를 열지 않게)
  const heads = localHeads();
  const kept = readLs(K_DWKEEP);
  const keptN = cleanDrawingsDump(kept?.dump)?.drawings?.length || 0;
  let names = null;
  const rows = new Map();
  if (native()) {
    try { names = await listMirror(); } catch (e) { console.warn('미러 확인 실패', e); }
    for (const f of FOLDERS) { try { rows.set(fkey(f), await readIndex(f)); } catch { /* 폴더 없음·권한·깨짐 */ } }
  }
  const maybeDw = (heads.cur?.dw || 0) > 0 || (heads.prev?.dw || 0) > 0 || keptN > 0
    || !!(names && (names.has('drawings.json') || names.has('drawings-prev.json'))) || [...rows.values()].some(rs => !!bestDwRow(rs));
  if (maybeDw) dwEmpty = await drawingsEmpty();

  for (const [slot, key] of [['cur', K_BAK], ['prev', K_BAK2]]) {
    const hd = heads[slot];
    if (!hd) continue;
    add({ source: 'local', at: hd.at, load: async () => ({ source: 'local', ...parseFull(readLs(key)) }) }, lostOf(Array.isArray(hd.ids) ? hd.ids : []), hd.dw || 0);
  }
  if (dwEmpty && keptN > 0) add({ source: 'local', at: Number(kept.at) || 0, load: async () => ({ source: 'local', records: [], photos: [], drawings: cleanDrawingsDump(kept.dump), at: Number(kept.at) || 0 }) }, [], keptN);
  if (native()) {
    if (names) {
      try {
        const lost = lostOf(shardIds(names));
        const dwN = dwEmpty && (names.has('drawings.json') || names.has('drawings-prev.json')) ? ((await readMirrorDrawings())?.counts?.drawings || 0) : 0;
        add({ source: 'mirror', at: 0, load: () => readMirror(lost) }, lost, dwN);
      } catch (e) { console.warn('미러 확인 실패', e); }
    }
    const ver = store.meta('restoreVerified', null) || {}, verNow = {};
    for (const f of FOLDERS) {
      try {
        const rs = rows.get(fkey(f));
        const best = bestRow(rs);
        if (!best) continue;
        // 개수로 보아 잃은 것이 있을 수 있다 — 그 한 파일만 열어 확인. 영구 삭제 수로 빼지 않는다(백업에 한 번도 안 들어간 빈 묶음 정리도 purgedIds 에 쌓여
        //   일부 손실을 가리던 것, v0.1.4 검토). 대신 열어 보고 잃은 게 없으면 「이 파일·이 개수까지 확인함」을 남겨 다음 부팅부터는 다시 열지 않는다
        //   (묶음이 그보다 줄면 — 일부 손실·영구 삭제 — 다시 연다. DB 를 통째로 잃으면 이 표지도 같이 사라진다)
        const vk = `${best.name}|${best.at}|${best.n}`, v = ver[fkey(f)];
        if (best.n > have && !(v?.k === vk && have >= v.have)) {
          const parsed = parseFull(await readText(f, best.name));
          const lost = lostOf(parsed.records.map(r => r.id));
          add({ source: 'file', at: parsed.at, load: async () => ({ source: 'file', ...parsed }) }, lost, parsed.drawings?.drawings?.length || 0);
          if (!lost.length) verNow[fkey(f)] = { k: vk, have };
        }
        const bd = dwEmpty ? bestDwRow(rs) : null;                           // 도면 DB 만 잃음 — 도면이 가장 많은 세대
        if (bd && !(best.n > have && bd.name === best.name)) {
          add({ source: 'file', at: bd.at, load: async () => ({ source: 'file', ...parseFull(await readText(f, bd.name)) }) }, [], bd.dw);
        }
      } catch { /* 폴더 없음·권한·깨짐 */ }
    }
    if (Object.keys(verNow).length) store.setMeta('restoreVerified', { ...ver, ...verNow })?.catch?.(() => {});
  }
  let best = null;
  for (const c of cands) {
    if (!best || c.missing > best.missing || (c.missing === best.missing && (c.missingDrawings > best.missingDrawings
      || (c.missingDrawings === best.missingDrawings && (c.at || 0) > (best.at || 0))))) best = c;
  }
  if (!best) return null;
  const sn = store.meta('restoreSnooze', null);
  if (sn?.sig === best.sig && now < (sn.until || 0)) return null;
  let body;
  try { body = await best.load(); } catch (e) { console.warn('복구 후보를 읽지 못했어요', e); return null; }
  const { load, ...rest } = best;
  return { ...body, ...rest, at: body.at || best.at || 0 };
}
// 도면보관함이 통째로 비었는지(영구 삭제 기록도 없음 = DB 를 잃었을 수 있다). 일부러 다 지운 것은 비었다고 보지 않는다
async function drawingsEmpty() {
  const dw = await drawingsMod();
  try {
    if (typeof dw?.looksLost === 'function') return dw.looksLost();
    return !!dw?.drawings && dw.drawings().length === 0 && dw.drawings({ deleted: true }).length === 0;
  } catch { return false; }
}

// [나중에] — 같은 상황이면 7일 동안 다시 묻지 않는다
export const snoozeRestore = (cand, now = Date.now()) => store.setMeta('restoreSnooze', { sig: cand?.sig || '', until: now + 7 * DAY });

// → { added, updated, photos, missing, drawings?, folders? }
//   잃은 묶음이 없는 후보(도면만 비었음)는 도면만 합친다 — 묶음까지 합치면 영구 삭제한 묶음이 되살아난다(v0.1.4 검토).
//   묶음을 합칠 때도 영구 삭제 기록(purgedIds)에 있는 묶음·그 사진은 거른다
export async function restoreFrom(cand) {
  if (!cand || !Array.isArray(cand.records)) throw new Error('되살릴 기록이 없어요');
  let r = { added: 0, updated: 0, photos: 0, missing: 0 };
  if (!(cand.missing === 0 && cand.missingDrawings > 0)) {
    const purged = new Set(store.meta('purgedIds', []));
    const records = cand.records.filter(x => x && !purged.has(x.id));
    const photos = (cand.photos || []).filter(p => p && !purged.has(p.recordId));
    r = await store.merge({ records, photos }, null);
  }
  if (cand.settings && store.meta('settings') === undefined) await store.setSettings(cand.settings);   // 이 기기 값이 비어 있을 때만
  if (cand.lastLocation && store.meta('lastLocation') === undefined) await store.setMeta('lastLocation', cand.lastLocation);
  let drawings = null;
  if (cand.drawings) {
    const dw = await drawingsMod();
    if (dw?.mergeDrawings) drawings = await dw.mergeDrawings(cand.drawings).catch(e => { console.warn('도면보관함 되살리기 실패', e); return null; });
  }
  let folders = null;
  if (cleanFd(cand.folders)) {
    const F = await foldersMod();
    if (F?.mergeFolders) folders = await F.mergeFolders(cand.folders).catch(e => { console.warn('폴더 되살리기 실패', e); return null; });
  }
  return { added: r.added, updated: r.updated, photos: r.photos, missing: r.missing, drawings, folders };
}

// 브라우저가 저장소를 비우지 않게 보호됐는지(설정 정보 표시용). 모르면 null
export async function storageProtected() {
  try { return navigator.storage?.persisted ? await navigator.storage.persisted() : null; } catch { return null; }
}
