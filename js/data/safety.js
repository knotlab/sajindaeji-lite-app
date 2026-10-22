// 메타데이터 안전판(설계서 §4.5) — IndexedDB 가 통째로 또는 일부 사라지는 사고(공시체 2026-08, 원본 현장사진대지 9/22)에 대비해 여러 겹으로 남긴다.
//   ① 미러(APK): 묶음이 바뀌면(1초 묶어서) DATA/mirror/r-<id>.json(묶음 + 그 묶음의 모든 사진 메타), mirror/meta.json(설정·lastLocation 등)
//   ② 자동 파일 백업(APK): 메타 전체 JSON 을 DATA/backup/ 와 DOCUMENTS/현장사진대지 lite/백업/ 에 원자적 쓰기, 14세대, 줄어듦 방지
//   ③ localStorage 백업(웹·APK 둘 다 — 저장 계층이 달라 IDB 와 같이 죽는 일이 드물다): 현재 + 직전 세대 하나, 용량 초과는 조용히
//   ④ 복구 후보 찾기(checkRestore) → 사용자가 고르면 restoreFrom. 사진 본체는 파일 저장소에 남아 있으면 그대로 다시 연결된다
// 미러·하루 백업 쓰기는 한가할 때(native.whenQuiet — 최근 2초 안에 셔터·글 입력이 없고 글 칸이 비활성, 2026-10-22 폰 "찍은 직후 글이 늦게 쳐짐").
//   브리지 직렬화(JSON 통째 복사)가 메인 스레드를 막기 때문. 백그라운드로 갈 때(onPause)는 기다리지 않고 바로 쓴다.
import * as N from '../platform/native.js';
import * as store from './store.js';
import { makeBackupJson, parseBackupJson, liveCount, pickBest, rotateLocal } from '../core/backup.js';
import { ymd, dayKey } from '../core/date.js';
import { APP_VERSION } from '../config.js';

const DATA = 'DATA', DOCS = 'DOCUMENTS';
const DOC_ROOT = N.DOC_ROOT || '현장사진대지 lite';
const K_BAK = 'sajindaeji-lite.autobackup.v1';
const K_BAK2 = 'sajindaeji-lite.autobackup.prev.v1';
const MIRROR_DELAY = 1000;
const KEEP = 14;
const DAY = 864e5;
const QUIET_META = ['lastAutoBackup', 'lastAutoBackupAt', 'restoreSnooze'];   // 이것만 바뀐 건 백업할 변화가 아니다
const MIRROR_META = ['settings', 'lastLocation', 'installId', 'seqMax', 'purgedIds', 'lastBackupAt'];
const FOLDERS = [
  { dir: DATA, folder: 'backup', label: '앱 안' },
  { dir: DOCS, folder: `${DOC_ROOT}/백업`, label: '문서 폴더' },             // 앱을 지워도 남는다(최선 노력)
];
const NAME_RE = /^자동백업-\d{8}(-줄어듦)?\.json$/;

let started = false, dirty = true, mirrorTimer = null, mirrorMeta = false;
const mirrorIds = new Set();
let mirrorChain = Promise.resolve(), backupChain = Promise.resolve();
const offs = [];

const native = () => !!N.isNative?.();
const ls = () => { try { return globalThis.localStorage || null; } catch { return null; } };
const readLs = key => { try { const t = ls()?.getItem(key); return t ? JSON.parse(t) : null; } catch { return null; } };

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
  offs.push(N.onPause?.(() => {
    flushMirror();
    const last = lastAutoBackup()?.at || 0;
    if (dirty || dayKey(last) !== dayKey(Date.now())) backupNow({ reason: 'pause' }).catch(e => console.warn('자동 백업 실패', e));
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

// 시험용 — 구독·타이머를 끈다
export function stopSafety() {
  offs.splice(0).forEach(f => { try { f(); } catch { /* 없음 */ } });
  clearTimeout(mirrorTimer); mirrorTimer = null;
  started = false;
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
  if (!native()) { mirrorIds.clear(); mirrorMeta = false; return mirrorChain; }
  const ids = [...mirrorIds]; mirrorIds.clear();
  const withMeta = mirrorMeta; mirrorMeta = false;
  mirrorChain = mirrorChain.then(async () => {
    for (const id of ids) await writeShard(id).catch(e => console.warn('미러 쓰기 실패', id, e));   // 쓸 때 그 시점의 최신 캐시를 읽는다
    if (withMeta) await writeMirrorMeta().catch(e => console.warn('미러 meta 쓰기 실패', e));
  });
  return mirrorChain;
}
export const mirrorIdle = () => flushMirror();

async function writeShard(id) {
  const path = `mirror/r-${id}.json`, r = store.record(id);
  if (!r) { await N.fsDelete(DATA, path).catch(() => {}); return; }           // 영구 삭제된 묶음
  await N.atomicWrite(DATA, path, JSON.stringify({ v: 1, at: Date.now(), record: r, photos: store.photosOfAll(id) }));
}
async function writeMirrorMeta() {
  const m = {};
  for (const k of MIRROR_META) { const v = k === 'settings' ? store.meta('settings') : store.meta(k); if (v !== undefined) m[k] = v; }
  await N.atomicWrite(DATA, 'mirror/meta.json', JSON.stringify({ v: 1, at: Date.now(), meta: m }));
}
// 업데이트 뒤 처음 켰을 때 등 — 미러 조각이 없는 묶음을 한 번 채운다
async function seedMirror() {
  const have = new Set((await N.fsList(DATA, 'mirror')).map(f => f.name));
  for (const r of store.snapshot().records) if (!have.has(`r-${r.id}.json`)) mirrorIds.add(r.id);
  if (!have.has('meta.json')) mirrorMeta = true;
  if (mirrorIds.size || mirrorMeta) await flushMirror();
}

async function readMirror() {
  const files = (await N.fsList(DATA, 'mirror')).filter(f => /^r-.+\.json$/.test(f.name));
  if (!files.length) return null;
  const records = [], photos = [];
  let at = 0;
  for (const f of files) {
    try {
      const o = JSON.parse(await N.fsRead(DATA, `mirror/${f.name}`, { utf8: true }));
      if (!o?.record?.id) continue;
      records.push(o.record); photos.push(...(Array.isArray(o.photos) ? o.photos : []));
      at = Math.max(at, Number(o.at) || 0);
    } catch { /* 깨진 조각은 건너뛴다 */ }
  }
  let meta = {};
  try { meta = JSON.parse(await N.fsRead(DATA, 'mirror/meta.json', { utf8: true }))?.meta || {}; } catch { /* 없음 */ }
  return { source: 'mirror', records, photos, settings: meta.settings || null, lastLocation: meta.lastLocation || null, at };
}

// ---- 자동 백업 ----
function snapshotJson(now) {
  const s = store.snapshot();
  return makeBackupJson({ records: s.records, photos: s.photos, settings: s.settings, lastLocation: s.lastLocation, now, appVersion: APP_VERSION, installId: s.installId });
}

// localStorage — 현재 + 직전 세대(core/backup.js rotateLocal: 가장 좋은 세대는 늘 한 칸에 남는다, 공시체 K_BAK2)
// 용량(보통 5MB)이 모자라면 사진 메타를 줄인 판으로 한 번 더 — 그래도 안 되면 false(lastAutoBackup.localFailed 로 설정에 알린다)
const slimPhoto = p => ({ id: p.id, recordId: p.recordId, createdAt: p.createdAt, takenAt: p.takenAt, takenAtSource: p.takenAtSource, source: p.source,
  state: p.state, gps: p.gps ? { lat: p.gps.lat, lng: p.gps.lng, acc: p.gps.acc ?? null } : null, original: p.original?.name ? { name: p.original.name } : null, deletedAt: p.deletedAt ?? null });
function writeLocal(b, today) {
  const L = ls();
  if (!L) return false;
  const put = (obj, mustPush) => {
    const r = rotateLocal({ cur: readLs(K_BAK), prev: readLs(K_BAK2), next: obj, today });
    if (r.pushed) { try { L.setItem(K_BAK2, L.getItem(K_BAK)); } catch (e) { if (mustPush) throw e; } }
    L.setItem(K_BAK, JSON.stringify(r.cur));
  };
  try { put(b, true); return true; } catch (e) { console.warn('localStorage 백업 — 줄인 판으로 다시', e?.name); }
  try { put({ ...b, photos: b.photos.map(slimPhoto), slim: true }, false); return true; }
  catch (e) { console.warn('localStorage 백업 건너뜀(용량)', e?.name); return false; }
}

async function readFolderList(f) {
  const files = (await N.fsList(f.dir, f.folder)).filter(x => NAME_RE.test(x.name));
  const out = [];
  for (const x of files) {
    try {
      const o = JSON.parse(await N.fsRead(f.dir, `${f.folder}/${x.name}`, { utf8: true }));
      out.push({ name: x.name, at: Number(o.at) || 0, counts: o.counts, records: o.records, o });
    } catch { /* 깨진 파일은 목록에서 뺀다 */ }
  }
  return out;
}

// 하루 한 파일(자동백업-YYYYMMDD.json). 오늘 파일이 더 크면 덮지 않고 -줄어듦 파일로. 14세대 + 가장 좋은 것은 늘 남긴다
async function writeFolder(f, b, text, now) {
  const list = await readFolderList(f);
  const name = `자동백업-${ymd(now)}.json`;
  const today = list.find(x => x.name === name);
  const file = today && liveCount(b) < liveCount(today.o) ? `자동백업-${ymd(now)}-줄어듦.json` : name;
  await N.atomicWrite(f.dir, `${f.folder}/${file}`, text);
  try {
    const all = [...list.filter(x => x.name !== file), { name: file, at: now, o: b }];
    const best = pickBest(all.map(x => x.o));
    const keep = new Set(all.slice().sort((a, b2) => b2.at - a.at).slice(0, KEEP).map(x => x.name));
    for (const x of all) if (!keep.has(x.name) && x.o !== best && x.name !== file) await N.fsDelete(f.dir, `${f.folder}/${x.name}`).catch(() => {});
  } catch (e) { console.warn('백업 보관 정리 실패', e); }
}

// → { ok, where: string[] }
export function backupNow({ reason = 'manual', now = Date.now() } = {}) {
  const p = backupChain.then(async () => {
    await store.flush();
    const b = snapshotJson(now);
    if (!b.records.length) return { ok: false, where: [], reason: 'empty' };   // 빈 DB 로 멀쩡한 백업을 덮지 않는다
    dirty = false;                                                           // 여기부터 스냅숏까지 await 없음 — 이후 변화는 구독이 다시 켠다
    const where = [];
    const today = dayKey(now);
    const localOk = writeLocal(b, today);
    if (localOk) where.push('이 브라우저');
    if (native()) {
      const text = JSON.stringify(b);
      for (const f of FOLDERS) {
        try { await writeFolder(f, b, text, now); where.push(f.label); }
        catch (e) { if (f.dir === DATA) console.warn('[자동 백업 앱 안]', e); }   // 문서 폴더는 기기·권한 따라 막힐 수 있다
      }
    }
    if (!where.length) dirty = true;
    const info = { at: now, where, reason };
    if (!localOk && ls()) info.localFailed = true;                            // 웹은 이것이 유일한 자동 안전판 — 설정에 알린다
    try { await store.setMeta('lastAutoBackup', info); await store.setMeta('lastAutoBackupAt', now); } catch (e) { console.warn('백업 기록 실패', e); }
    return { ok: where.length > 0, where };
  });
  backupChain = p.then(() => {}, () => {});
  return p;
}

export function lastAutoBackup() {
  const m = store.isReady?.() ? store.meta('lastAutoBackup', null) : null;
  if (m?.at) return { at: m.at, where: m.where || [], localFailed: !!m.localFailed };
  const l = readLs(K_BAK);
  return l?.at ? { at: l.at, where: ['이 브라우저'] } : null;
}

// ---- 복구 ----
function localCandidates() {
  const out = [];
  for (const key of [K_BAK, K_BAK2]) {
    const o = readLs(key);
    if (!o) continue;
    try { const b = parseBackupJson(o); out.push({ source: 'local', ...b }); } catch { /* 깨짐 */ }
  }
  return out;
}
async function fileCandidates() {
  const out = [];
  for (const f of FOLDERS) {
    try {
      const list = await readFolderList(f);
      const best = pickBest(list.map(x => x.o));
      if (best) out.push({ source: 'file', ...parseBackupJson(best) });
    } catch { /* 폴더 없음·권한 */ }
  }
  return out;
}

// 부팅 때: 후보 중 「지금 DB 에 없는 묶음」(영구 삭제한 것 제외)이 있는 것 → 가장 많이 되살리는 것. 없으면 null
// → { source, records, photos, settings, lastLocation, at, missing, sig }
export async function checkRestore({ now = Date.now() } = {}) {
  const cands = [...localCandidates()];
  if (native()) {
    const m = await readMirror().catch(() => null);
    if (m) cands.push(m);
    cands.push(...(await fileCandidates()));
  }
  const purged = new Set(store.meta('purgedIds', []));
  let best = null;
  for (const c of cands) {
    const lost = c.records.filter(r => r && !store.record(r.id) && !purged.has(r.id)).map(r => r.id).sort();
    if (!lost.length) continue;
    const cand = { ...c, missing: lost.length, sig: `${c.source}:${lost.length}:${lost[0]}` };
    if (!best || cand.missing > best.missing || (cand.missing === best.missing && (cand.at || 0) > (best.at || 0))) best = cand;
  }
  if (!best) return null;
  const sn = store.meta('restoreSnooze', null);
  if (sn?.sig === best.sig && now < (sn.until || 0)) return null;
  return best;
}

// [나중에] — 같은 상황이면 7일 동안 다시 묻지 않는다
export const snoozeRestore = (cand, now = Date.now()) => store.setMeta('restoreSnooze', { sig: cand?.sig || '', until: now + 7 * DAY });

// → { added, updated, photos, missing }
export async function restoreFrom(cand) {
  if (!cand || !Array.isArray(cand.records)) throw new Error('되살릴 기록이 없어요');
  const r = await store.merge({ records: cand.records, photos: cand.photos || [] }, null);
  if (cand.settings && store.meta('settings') === undefined) await store.setSettings(cand.settings);   // 이 기기 값이 비어 있을 때만
  if (cand.lastLocation && store.meta('lastLocation') === undefined) await store.setMeta('lastLocation', cand.lastLocation);
  return { added: r.added, updated: r.updated, photos: r.photos, missing: r.missing };
}

// 브라우저가 저장소를 비우지 않게 보호됐는지(설정 정보 표시용). 모르면 null
export async function storageProtected() {
  try { return navigator.storage?.persisted ? await navigator.storage.persisted() : null; } catch { return null; }
}
