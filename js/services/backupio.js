// 수동 백업 ZIP 만들기·복원(SPEC §5.6·§4.5-5). 형식은 core/backup.js(makeBackupJson/parseBackupJson).
// ZIP: backup.json + w/<사진ID>.jpg(작업본) + t/<사진ID>.jpg(썸네일). 휴지통 묶음·사진, 설정(키 제외), lastLocation 도 담는다.
// 판 2(v0.1.4): backup.json 의 drawings = 도면보관함 핀·기준점·도면 메타(작음). 도면 원본 파일·타일은 자료함처럼 백업 밖 —
//   복원하면 도면은 「원본 파일을 다시 올려 주세요」(missingFile)로 들어오고 핀 이름·묶음 연결·위치 맞춤은 그대로 산다.
// v0.1.5: backup.json 의 folders = 자료함·도면보관함 폴더와 배치(data/folders.js dumpFolders — 작음). 판 번호는 그대로(2), 칸이 없는 옛 백업도 그대로 읽힌다.
// 만들기: 흐름 쓰기(앱: CACHE/backup/<이름>.tmp → 크기 확인 → 이름 바꾸기, 웹: Blob 조각) — 사진은 한 장씩만 메모리에.
// 읽기: File.slice 로 끝의 중앙 디렉터리부터, 항목은 필요할 때 하나씩(core/zip openZip — 원본 backupzip.js read/readEntry) — 수백 MB 도 통째로 올리지 않는다.
import * as store from '../data/store.js';
import * as N from '../platform/native.js';
import { APP_VERSION } from '../config.js';
import { makeBackupJson, parseBackupJson, backupName } from '../core/backup.js';
import { ZipStream, openZip } from '../core/zip.js';
import { enc, dec } from '../core/xml.js';
import { deliverFile } from './exporter.js';

const MAX_JSON = 64 * 1024 * 1024, MAX_FILE = 32 * 1024 * 1024;              // 항목 하나 상한 — 풀기 전에 걸러 메모리를 지킨다(원본 값)
const tell = (cb, ...a) => { try { cb?.(...a); } catch (e) { console.error(e); } };
const bytesOf = async b => (b ? new Uint8Array(await b.arrayBuffer()) : null);
// 도면보관함(별도 DB) — 없거나 못 열면 조용히 빠진다(사진 백업은 그대로)
async function drawingsMod() {
  try { const dw = await import('../data/drawings.js'); if (typeof dw.ready === 'function') await dw.ready(); return dw; }
  catch (e) { console.warn('도면보관함을 열지 못했어요', e); return null; }
}
// 폴더(별도 DB) — 없거나 못 열면 조용히 빠진다
async function foldersMod() {
  try { const fd = await import('../data/folders.js'); await fd.ready(); return fd; }
  catch (e) { console.warn('폴더를 열지 못했어요', e); return null; }
}
// 폴더 덤프 모양 확인 — { v, folders: [], places: [] } 가 아니면 null(없는 것으로)
export const cleanFoldersDump = d => (d && typeof d === 'object' && Number.isFinite(d.v) && Array.isArray(d.folders) && Array.isArray(d.places) ? d : null);
// backup.json 글·객체 → parseBackupJson 결과 + folders(core/backup.js 가 모르는 칸이라 여기서 붙인다)
export function parseWithFolders(input) {
  let o = input;
  if (typeof input === 'string') { try { o = JSON.parse(input); } catch { o = input; } }    // JSON 이 아니면 parseBackupJson 이 알맞은 말로 던진다
  return { ...parseBackupJson(o), folders: cleanFoldersDump(o?.folders) };
}

// ---- 만들기 ---- → { name, size, blob? | uri?, path?, records, photos, skipped }
let seq = 0;
export async function makeBackup(onProgress, { now = Date.now() } = {}) {
  await store.flush?.();                                                     // 화면이 아직 저장 중인 것까지
  const dw = await drawingsMod();
  let drawings = null;
  try { drawings = dw?.dumpDrawings ? dw.dumpDrawings() : null; } catch (e) { console.warn('도면보관함 백업 실패', e); }
  const fd = await foldersMod();
  let folders = null;
  try { folders = fd ? cleanFoldersDump(fd.dumpFolders()) : null; } catch (e) { console.warn('폴더 백업 실패', e); }
  if (folders && !folders.folders.length && !folders.places.length) folders = null;
  const snap = store.snapshot();                                             // 휴지통 포함 전부
  const json = makeBackupJson({
    records: snap.records, photos: snap.photos, settings: snap.settings, now, drawings,
    appVersion: APP_VERSION, installId: snap.installId || store.meta('installId', ''), lastLocation: snap.lastLocation,
  });
  if (folders && !json.folders) { json.folders = folders; json.counts.folders = folders.folders.filter(f => !f.deletedAt).length; }
  const todo = snap.photos.filter(p => p.state === 'ready');
  const name = backupName(now);
  const sink = N.zipSink(`backup/${now}-${++seq}/${name}`);
  try {
    const zip = new ZipStream(sink.write, { date: new Date(now) });
    await zip.add('backup.json', enc.encode(JSON.stringify(json)));
    let photos = 0, skipped = 0;
    for (const [i, p] of todo.entries()) {
      const work = await bytesOf(await store.blob(p.id, 'work').catch(() => null));
      const thumb = work ? await bytesOf(await store.blob(p.id, 'thumb').catch(() => null)) : null;
      if (work && work.length) {
        await zip.add(`w/${p.id}.jpg`, work);
        if (thumb && thumb.length) await zip.add(`t/${p.id}.jpg`, thumb);
        photos++;
      } else skipped++;                                                      // 파일이 없는 사진은 기록만 실린다(갤러리 원본으로 되살릴 수 있게)
      tell(onProgress, i + 1, todo.length);
    }
    const { size } = await zip.finish();
    const out = await sink.finish(size);
    return { name, size, ...out, at: now, records: json.records.length, photos, skipped, drawings: json.counts.drawings, pins: json.counts.pins };
  } catch (e) {
    await sink.abort().catch(() => {});
    throw e;
  }
}

// how: 'share' | 'save'(앱: 문서/현장사진대지 lite/백업/, 웹: 내려받기). 성공하면 meta lastBackupAt
export async function deliverBackup(result, how = 'save') {
  const r = await deliverFile(result, how, '백업');
  if (r.ok) await store.setMeta('lastBackupAt', Date.now()).catch(e => console.warn('lastBackupAt 저장 실패', e));
  return r;
}

// ---- 복원 ----
// 받는 항목 이름은 backup.json · w/<id>.jpg · t/<id>.jpg 뿐. 역슬래시는 / 로(PC 에서 다시 압축한 ZIP), 절대경로·..·하위 폴더는 꼴에 안 맞아 걸러진다
const ENTRY = /^([wt])\/([A-Za-z0-9_-]{2,64})\.jpg$/;
// PC 에서 폴더째 다시 압축하면 모든 파일이 같은 최상위 폴더 아래에 든다 — 그 한 단계를 벗긴다
const unwrapper = names => {
  const root = names[0]?.split('/')[0];
  return root && names.length > 1 && names.every(n => n.startsWith(`${root}/`)) ? n => n.slice(root.length + 1) : n => n;
};
const isZip = async file => { const h = new Uint8Array(await file.slice(0, 2).arrayBuffer()); return h[0] === 0x50 && h[1] === 0x4B; };

// file: File|Blob(.zip 또는 backup.json) → { added, updated, skipped, photos, missing?, records, settingsFilled, drawings: { added, updated, skipped, missingFiles } | null, folders: { added, updated, skipped } | null }
//   drawings.missingFiles = 원본 파일이 없는 도면 수(도면보관함에서 「원본 파일을 다시 올려 주세요」 — 화면 안내 근거)
export async function restoreBackup(file, onProgress) {
  if (!file || !(file.size > 0)) throw new Error('빈 파일이에요');
  let parsed, getBlob = null;
  if (await isZip(file)) {
    const zip = await openZip(file);
    const files = zip.entries.map(e => ({ e, n: e.name.replace(/\\/g, '/') })).filter(x => !x.n.endsWith('/'));
    const strip = unwrapper(files.map(x => x.n));
    const named = new Map();
    for (const { e, n } of files) { const k = strip(n); if (!named.has(k)) named.set(k, e); }
    const head = named.get('backup.json');
    if (!head) throw new Error('backup.json 이 없는 ZIP 이에요 — 이 앱이 만든 백업 ZIP 이 아니에요');
    parsed = parseWithFolders(dec.decode(await zip.bytes(head, MAX_JSON)));  // 모양이 틀리면 여기서 던진다 — 아직 아무것도 바꾸지 않았다
    const map = new Map();
    for (const [n, e] of named) { const m = ENTRY.exec(n); if (m) map.set(`${m[2]}|${m[1] === 'w' ? 'work' : 'thumb'}`, e); }
    const total = parsed.photos.filter(p => p.state === 'ready').length * 2;
    let done = 0;
    getBlob = async (photoId, kind) => {
      const e = map.get(`${photoId}|${kind}`);
      tell(onProgress, Math.min(total, ++done), total);
      if (!e) return null;
      return new Blob([await zip.bytes(e, MAX_FILE)], { type: 'image/jpeg' });
    };
  } else {
    if (file.size > MAX_JSON) throw new Error('백업 파일이 너무 커요');
    parsed = parseWithFolders(await file.text());                             // JSON 만 — 사진 파일은 이 기기에 있으면 다시 연결된다
  }
  const r = await store.merge({ records: parsed.records, photos: parsed.photos }, getBlob);
  // 설정·직전 위치는 이 기기의 값이 비어 있을 때만 채운다(원본 restoreRecords 규칙)
  const cur = store.settings(), patch = {};
  for (const k of ['siteName', 'author']) if (!String(cur[k] || '').trim() && String(parsed.settings?.[k] || '').trim()) patch[k] = parsed.settings[k];
  if (Object.keys(patch).length) await store.setSettings(patch);
  if (!store.lastLocation() && parsed.lastLocation?.text) await store.setLastLocation(parsed.lastLocation.text, parsed.lastLocation.at || Date.now());
  let drawings = null;
  if (parsed.drawings) {
    const dw = await drawingsMod();
    if (dw?.mergeDrawings) {
      try {
        drawings = await dw.mergeDrawings(parsed.drawings);
        drawings.missingFiles = (dw.drawings?.() ?? []).filter(d => d.missingFile).length;
      } catch (e) { console.warn('도면보관함 복원 실패', e); drawings = { added: 0, updated: 0, skipped: 0, missingFiles: 0, error: e?.message || String(e) }; }
    }
  }
  // 폴더·배치는 자료·도면 다음에(배치는 id 만 가리킨다). 지운 폴더 묘비는 되살리지 않는다(mergeFolders)
  let folders = null;
  if (parsed.folders) {
    const fd = await foldersMod();
    if (fd?.mergeFolders) folders = await fd.mergeFolders(parsed.folders).catch(e => { console.warn('폴더 복원 실패', e); return { added: 0, updated: 0, skipped: 0, error: e?.message || String(e) }; });
  }
  return { ...r, records: parsed.records.length, settingsFilled: Object.keys(patch), drawings, folders };
}

// ---- 재설치 뒤 갤러리 원본으로 사진 되살리기(§4.5-6 다, 원본 restore.js rebuildFromGallery 방식) ----
// 복원 merge 에서 본체가 없어 「처리 실패」가 된 사진 중 갤러리 원본 이름(현장_…_<photoId>.jpg)이 있는 것 →
// native.findOriginals({ names }) → 찾은 content:// 를 읽어 incoming 에 넣고 다시 처리. → { found, missing, failed }
export async function relinkOriginals(onProgress) {
  if (!N.isNative()) return { found: 0, missing: 0, failed: 0 };
  const todo = store.dump().photos.filter(p => !p.deletedAt && p.state === 'failed' && (p.original?.name || p.original?.uri));
  if (!todo.length) return { found: 0, missing: 0, failed: 0 };
  const names = [...new Set(todo.map(p => p.original?.name).filter(Boolean))];
  const items = names.length ? await N.findOriginals({ names }) : [];
  const byName = new Map();
  for (const it of items) if (it?.name && it?.uri && !byName.has(it.name)) byName.set(it.name, it);
  const pipeline = await import('../media/pipeline.js');
  let found = 0, missing = 0, failed = 0;
  for (const [i, p] of todo.entries()) {
    const hit = byName.get(p.original?.name);
    const uris = [hit?.uri, p.original?.uri].filter((u, k, a) => u && a.indexOf(u) === k);   // 이름으로 찾은 것 먼저, 없으면 예전 주소
    let raw = null, used = null;
    for (const u of uris) { try { raw = await N.readBytes(u); if (raw?.length) { used = u; break; } } catch { /* 다음 후보 */ } }
    if (!raw?.length) missing++;
    else {
      try { const done = await pipeline.revive(p.id, raw, { uri: used }); if (done?.state === 'ready') found++; else failed++; }
      catch (e) { failed++; console.warn('갤러리 원본으로 되살리지 못했어요', p.id, e); }
    }
    tell(onProgress, i + 1, todo.length);
  }
  return { found, missing, failed };
}
