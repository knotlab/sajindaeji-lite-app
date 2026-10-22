// 백업 JSON 형식과 합치기 규칙 — 순수 함수(설계서 §5.2·§4.5). 원본 core/backup.js 를 lite 형식으로.
// 같은 JSON 을 쓰는 곳: 수동 백업 ZIP 의 backup.json(backupio, D) · 자동 파일/localStorage 백업·미러(safety, B)
// 판 2(v0.1.4): drawings 칸 = 도면보관함 dumpDrawings()(도면 메타·기준점·핀 — 원본 파일·타일은 빼고, 설계 docs/도면보관함-설계.md §7).
//   판 1 백업도 그대로 읽는다(drawings: null). 판 2 를 판 1 앱이 열면 「더 새 버전 앱의 백업이에요」.
import { ymd, hm } from './date.js';

export const BACKUP_FORMAT = 'sajindaeji-lite-backup';
export const BACKUP_VERSION = 2;

// 백업 파일은 카톡·클라우드로 나간다 — VWorld 키는 싣지 않는다. 받은 settings 객체는 고치지 않고 복사본에서 뺀다
const OMIT_SETTINGS = ['vworldKey'];
const cleanSettings = s => {
  if (!s || typeof s !== 'object') return {};
  const o = { ...s };
  for (const k of OMIT_SETTINGS) delete o[k];
  return o;
};

// records·photos 에는 휴지통(deletedAt) 항목도 그대로 넣는다(설계 비평: 휴지통·설정·lastLocation 도 백업)
// 묶음의 도면 핀 연결 record.pin — { drawingId:'g_…', pinId:'q_…' } 만 복사(다른 칸은 버린다), null 이면 연결 끊기, 모양이 틀리면 undefined(거절).
// 핀 본체(이름·자리)는 도면보관함(data/drawings.js) 한 곳에만 있다
const PIN_ID = { drawingId: /^g_[A-Za-z0-9_-]{1,64}$/, pinId: /^q_[A-Za-z0-9_-]{1,64}$/ };
export function cleanRecordPin(v) {
  if (v === null) return null;
  if (!v || typeof v !== 'object' || !PIN_ID.drawingId.test(String(v.drawingId ?? '')) || !PIN_ID.pinId.test(String(v.pinId ?? ''))) return undefined;
  return { drawingId: String(v.drawingId), pinId: String(v.pinId) };
}

// 도면보관함 덤프 모양 확인 — { v, drawings: [], pins: [] } 가 아니면 null(없는 것으로)
export const cleanDrawingsDump = d => (d && typeof d === 'object' && Number.isFinite(d.v) && Array.isArray(d.drawings) && Array.isArray(d.pins) ? d : null);

// 도면보관함 덤프의 개수 — 도면·핀 + 영구 삭제 기록(tombstone) 수. 줄어듦 판정(dwLoss)에 쓴다
export function dwStatOf(d) {
  const dw = cleanDrawingsDump(d);
  const pd = Array.isArray(dw?.purged?.drawings) ? dw.purged.drawings.length : 0, pp = Array.isArray(dw?.purged?.pins) ? dw.purged.pins.length : 0;
  return { drawings: dw ? dw.drawings.length : 0, pins: dw ? dw.pins.length : 0, purgedDrawings: pd, purgedPins: pp };
}

// → { format, version, at, appVersion, installId, counts: { records, photos, live, drawings, pins, purgedDrawings, purgedPins }, records, photos, settings, lastLocation, drawings }
export function makeBackupJson({ records = [], photos = [], settings = {}, now = Date.now(), appVersion = '', installId = '', lastLocation = null, drawings = null } = {}) {
  const dw = cleanDrawingsDump(drawings);
  return {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, at: now, appVersion, installId,
    counts: { records: records.length, photos: photos.length, live: records.filter(r => !r.deletedAt).length, ...dwStatOf(dw) },
    records, photos, settings: cleanSettings(settings), lastLocation: lastLocation ?? null, drawings: dw,
  };
}

// 문자열·객체 모두 받는다. → { records, photos, settings, lastLocation, drawings, at, installId, appVersion, version } | throws(한국어)
export function parseBackupJson(input) {
  let o;
  try { o = typeof input === 'string' ? JSON.parse(input) : input; } catch { throw new Error('백업 파일을 읽지 못했어요(JSON 아님)'); }
  if (!o || typeof o !== 'object' || o.format !== BACKUP_FORMAT) throw new Error('이 앱의 백업 파일이 아니에요');
  if (!(o.version >= 1)) throw new Error('백업 파일이 손상됐어요');
  if (o.version > BACKUP_VERSION) throw new Error('더 새 버전 앱의 백업이에요. 앱을 업데이트해 주세요');
  const ok = list => Array.isArray(list) && list.every(x => x && typeof x === 'object' && typeof x.id === 'string' && x.id);
  if (!ok(o.records) || !ok(o.photos)) throw new Error('백업 파일이 손상됐어요');
  for (const r of o.records) if (!Array.isArray(r.photoIds)) throw new Error('백업 파일이 손상됐어요');
  return {
    records: o.records, photos: o.photos, settings: cleanSettings(o.settings), lastLocation: o.lastLocation ?? null, drawings: cleanDrawingsDump(o.drawings),
    at: Number.isFinite(o.at) ? o.at : 0, installId: o.installId || '', appVersion: o.appVersion || '', version: o.version,
  };
}

const num = v => (Number.isFinite(v) ? v : 0);   // 없는 값·이상한 값은 0 — 비교가 한쪽으로 쏠리지 않게
// 이길 쪽을 돌려준다: rev 큰 쪽 → 같으면 updatedAt 늦은 쪽 → 그래도 같으면 지금 것(cur). 한쪽이 없으면 있는 쪽.
// 고치지 않고 받은 객체 그대로 돌려준다(저장소가 참조 비교로 바뀐 것만 쓴다)
export function mergeRecord(cur, inc) {
  if (!cur) return inc ?? null;
  if (!inc) return cur;
  if (num(inc.rev) !== num(cur.rev)) return num(inc.rev) > num(cur.rev) ? inc : cur;
  return num(inc.updatedAt) > num(cur.updatedAt) ? inc : cur;
}

// 사진 메타: 지금 것이 ready 가 아니고 들어온 것이 ready 면 들어온 것, 그 밖에는 지금 것(사진은 rev 가 없다)
export function mergePhoto(cur, inc) {
  if (!cur) return inc ?? null;
  if (!inc) return cur;
  return cur.state !== 'ready' && inc.state === 'ready' ? inc : cur;
}

// 설정·lastLocation 은 이 기기의 값이 비어 있을 때만 채운다(원본 restoreRecords 규칙)
export function mergeSettings(cur = {}, inc = {}) {
  const out = { ...(cur || {}) };
  for (const [k, v] of Object.entries(cleanSettings(inc))) {
    if (out[k] === undefined || out[k] === null || out[k] === '') out[k] = v;
  }
  return out;
}

// 목록 합치기 → { list, report: { added, updated, kept } }
export function mergeList(cur = [], inc = [], pick = mergeRecord) {
  const map = new Map(cur.map(x => [x.id, x]));
  const report = { added: 0, updated: 0, kept: 0 };
  for (const x of inc) {
    const a = map.get(x.id);
    if (!a) { map.set(x.id, x); report.added++; continue; }
    const w = pick(a, x);
    if (w !== a) { map.set(x.id, w); report.updated++; } else report.kept++;
  }
  return { list: [...map.values()], report };
}

// 줄어듦 방지(공시체 K_BAK2): 새 백업의 살아 있는 묶음 수가 직전 좋은 백업보다 적으면 true → 덮지 말고 이전 세대를 따로 남긴다
export const liveCount = b => (Number.isFinite(b?.counts?.live) ? b.counts.live : (b?.records || []).filter(r => !r.deletedAt).length);
export const isShrink = (next, prevGood) => !!prevGood && liveCount(next) < liveCount(prevGood);
// 여러 백업 중 가장 좋은 것: 살아 있는 묶음이 많은 쪽 → 같으면 나중 것
export const pickBest = list => (list || []).reduce((b, x) => (!b || liveCount(x) > liveCount(b) || (liveCount(x) === liveCount(b) && num(x.at) > num(b.at)) ? x : b), null);

// 도면 줄어듦(v0.1.4 검토 blocker — 도면 DB 만 잃으면 다음 백업 한 번에 모든 안전판에서 도면이 지워지던 것):
//   next 가 prev 보다 도면·핀이 적은데, 그만큼 영구 삭제 기록(tombstone)이 늘지 않았으면 「잃은 것」.
//   사용자가 일부러 지운 것(휴지통 비우기·30일 정리)은 tombstone 이 같이 늘어 줄어듦이 아니다. 받는 모양: { counts } 또는 줄({ dw, pins, pdw, ppins })
const dwN = b => {
  const c = b?.counts || b || {};
  return { dw: num(c.drawings ?? c.dw), pins: num(c.pins), pdw: num(c.purgedDrawings ?? c.pdw), ppins: num(c.purgedPins ?? c.ppins) };
};
export function dwLoss(next, prev) {
  if (!prev) return false;
  const a = dwN(next), b = dwN(prev);
  return (b.dw - a.dw) > Math.max(0, a.pdw - b.pdw) || (b.pins - a.pins) > Math.max(0, a.ppins - b.ppins);
}
// a 가 b 보다 잃은 게 있다(살아 있는 묶음이 적거나 도면·핀을 잃음)
const worse = (a, b) => !!b && (liveCount(a) < liveCount(b) || dwLoss(a, b));

// localStorage 두 칸(현재·직전) 돌리기 — 공시체 K_BAK2. 가장 좋은 세대가 늘 한 칸에 남게 한다.
//   현재는 늘 새 백업. 직전 칸은 「날이 바뀜」 또는 「새 것이 줄어듦(묶음·도면)」일 때 현재로 밀되, 직전이 현재보다 좋으면 그대로 둔다.
//   「좋다」는 묶음이 먼저(묶음이 더 많으면 좋음), 묶음 수가 같으면 도면을 잃지 않은 쪽(v0.1.4).
// → { cur, prev, pushed } (prev 는 남길 객체, pushed 는 현재를 직전으로 밀었는지)
export function rotateLocal({ cur = null, prev = null, next, today }) {
  const out = { ...next, day: today };
  if (!cur) return { cur: out, prev, pushed: false };
  const shrink = worse(next, cur) || worse(next, prev);
  const prevBetter = !!prev && (liveCount(prev) > liveCount(cur) || (liveCount(prev) === liveCount(cur) && dwLoss(cur, prev)));
  if ((cur.day !== today || shrink) && !prevBetter) return { cur: out, prev: cur, pushed: true };
  return { cur: out, prev, pushed: false };
}

// '사진대지lite-백업-YYYYMMDD-HHmm.zip'
export const backupName = (now = Date.now()) => `사진대지lite-백업-${ymd(now)}-${hm(now).replace(':', '')}.zip`;

// ---- 자동 백업 폴더 목록(index.json) — 속도 감사 #3 ----
// 폴더마다 작은 목록 파일을 두고, 오늘 파일 이름·줄어듦 판정·14세대 보관·가장 좋은 세대를 그것만으로 정한다(원본 store.js readIndex·writeFolder).
// 큰 백업 JSON 은 목록에 없는 파일(옛 폴더·목록 쓰기 전에 끊김)이나 크기가 달라진 파일만 한 번 열어 줄을 만든다.
// 줄 = { name, at, live, n(묶음 전부), ph(사진), dw(도면), pins, pdw·ppins(영구 삭제 기록 수), size? }
export const INDEX_V = 1;
export const AUTO_NAME_RE = /^자동백업-(\d{8})(-줄어듦)?\.json$/;
export const autoName = (now, shrink = false) => `자동백업-${ymd(now)}${shrink ? '-줄어듦' : ''}.json`;
const fin = v => Number.isFinite(v);
export function indexRow(name, b, size) {
  const c = b?.counts || {};
  const row = {
    name, at: num(b?.at), live: liveCount(b), n: fin(c.records) ? c.records : (b?.records || []).length,
    ph: fin(c.photos) ? c.photos : (b?.photos || []).length, dw: fin(c.drawings) ? c.drawings : 0, pins: fin(c.pins) ? c.pins : 0,
    pdw: fin(c.purgedDrawings) ? c.purgedDrawings : 0, ppins: fin(c.purgedPins) ? c.purgedPins : 0,
  };
  if (fin(size)) row.size = size;
  return row;
}
const okRow = x => !!x && typeof x.name === 'string' && AUTO_NAME_RE.test(x.name) && fin(x.at) && fin(x.live) && fin(x.n);   // 이름 꼴까지 — 목록의 이름이 그대로 지울 경로가 된다
// 글 → 줄 목록 | null(깨짐·모르는 판)
export function parseIndex(text) {
  let o;
  try { o = typeof text === 'string' ? JSON.parse(text) : text; } catch { return null; }
  const rows = Array.isArray(o) ? o : (o && o.v === INDEX_V && Array.isArray(o.rows) ? o.rows : null);
  if (!rows) return null;
  const seen = new Set(), out = [];
  for (const r of rows) if (okRow(r) && !seen.has(r.name)) { seen.add(r.name); out.push({ ...r }); }
  return out;
}
export const indexText = rows => JSON.stringify({ v: INDEX_V, rows });
// 목록을 폴더 실제 파일(disk: Map 이름 → 크기|undefined)과 맞춘다 → { rows, need }
//   need = 열어서 줄을 (다시) 만들 파일 이름(줄 없음 · 적힌 크기와 실제 크기가 다름). 폴더에 없는 줄은 뺀다.
//   단 disk 가 비었는데 줄이 있으면(폴더를 못 읽음과 구별 못 함) 줄을 그대로 둔다
export function reconcileIndex(rows = [], disk = new Map()) {
  const names = [...disk.keys()].filter(n => AUTO_NAME_RE.test(n));
  if (!names.length) return { rows: rows.slice(), need: [] };
  const by = new Map(rows.map(r => [r.name, r]));
  const out = [], need = [];
  for (const n of names) {
    const r = by.get(n), size = disk.get(n);
    if (!r || (fin(r.size) && fin(size) && r.size !== size)) need.push(n);
    else out.push(r);
  }
  return { rows: out, need };
}
// 가장 좋은 세대: 살아 있는 묶음이 많은 쪽 → 같으면 나중 것(pickBest 와 같은 규칙, 줄 모양)
export const bestRow = rows => (rows || []).reduce((b, x) => (!b || x.live > b.live || (x.live === b.live && x.at > b.at) ? x : b), null);
// 도면이 가장 많은 세대(도면 → 핀 → 나중 것). 도면이 하나도 없으면 null — 도면 DB 만 잃었을 때 되살릴 곳
export const bestDwRow = rows => (rows || []).reduce((b, x) => {
  const d = num(x.dw), p = num(x.pins);
  if (!(d > 0 || p > 0)) return b;
  return !b || d > num(b.dw) || (d === num(b.dw) && (p > num(b.pins) || (p === num(b.pins) && x.at > b.at))) ? x : b;
}, null);
// 오늘 쓸 파일 이름: 오늘 파일이 더 크면(살아 있는 묶음이 더 많거나 도면·핀을 잃었으면) 덮지 않고 -줄어듦 으로(공시체·9/22 교훈)
//   next: 살아 있는 묶음 수(옛 호출) 또는 { live, dw, pins, pdw, ppins }(indexRow 모양)
export function todayFile(rows, now, next) {
  const n = typeof next === 'number' ? { live: next } : (next || {});
  const name = autoName(now), today = (rows || []).find(r => r.name === name);
  if (!today) return name;
  const shrink = num(n.live) < today.live || (typeof next === 'object' && dwLoss(n, today));
  return shrink ? autoName(now, true) : name;
}
// 지울 이름들: 나중 것 keep 개 + 가장 좋은 세대(묶음) + 도면이 가장 많은 세대 + protect(방금 쓴 파일)는 남긴다
export function planRetention(rows, { keep = 14, protect = [] } = {}) {
  const best = bestRow(rows), bestDw = bestDwRow(rows);
  const stay = new Set([...(rows || []).slice().sort((a, b) => b.at - a.at).slice(0, keep).map(r => r.name), ...protect]);
  if (best) stay.add(best.name);
  if (bestDw) stay.add(bestDw.name);
  return (rows || []).filter(r => !stay.has(r.name)).map(r => r.name);
}
