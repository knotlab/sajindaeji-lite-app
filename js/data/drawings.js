// 도면보관함 데이터 — 사용자 요구: "도면은 따로 모아두자. 도면보관함을 따로 만들어서 길찾고 핀 가능하게. 핀에도 이름을 붙일 수 있게".
// 자료함(data/docs.js — 엑셀·문서)과 따로: 도면(PDF 도면·DWG·DXF·도면 그림)만. 설계: docs/도면보관함-설계.md
//
// 저장
// - 메타: 별도 IndexedDB `sajindaeji-lite-drawings` v2 — store 'drawings'(Drawing), 'pins'(Pin, 색인 drawingId·recordId), 'tiles'(타일 IDB 폴백),
//   'meta'(v2: 'purged' = 영구 삭제한 도면·핀 id — store.js purgedIds 와 같은 방식. 복구 후보가 「일부러 지운 것」을 잃은 것으로 보지 않게)
//   사진·자료·스냅샷 DB 와 나눈다(스키마 충돌 없게, 백업 크기 따로).
// - 원본 파일: data/photofs.js put('doc', 'dwgfile_'+id) — 자료함 파일과 같은 저장소(APK DATA/docs, 웹 OPFS docs/, 폴백 IDB)
// - 타일 피라미드: OPFS `drawtiles/<drawingId>/<page>-<z>-<x>-<y>.jpg`(미리보기 한 장은 `<page>-pv.jpg`), 안 되면 이 DB 'tiles' 에 ArrayBuffer.
//   OPFS 는 APK 에서도 웹뷰가 직접 쓰는 파일(브리지 0). 타일 만드는 워커는 같은 경로에 createSyncAccessHandle 로 바로 써도 된다
//   (그러면 setTiles 로 메타만 알린다) — 경로 약속은 TILE_DIR·tileFile() 로 내보낸다.
// 읽기(drawings·drawing·pins·pin·transformOf …)는 동기(메모리 캐시) — initDrawings()/ready() 뒤에. 쓰기는 직렬 큐 + Promise.
// 핀의 위경도는 저장하지 않는다 — 기준점 변환(core/georef.js)으로 그때그때 계산(transformOf 캐시). 주소(VWorld)는 어디에도 저장하지 않는다.
//
// 이 파일 맨 위(순수 부분)는 DOM·저장소 없이 node 에서 시험한다(tests/unit/drawings-model.test.mjs) — photofs 는 필요할 때 동적 import.
import * as G from '../core/georef.js';

export const DB_NAME = 'sajindaeji-lite-drawings';
const DB_VER = 2;
export const PURGED_MAX = 5000;                       // 영구 삭제 기록(tombstone) 상한 — 오래된 것부터 버린다
export const MAX_BYTES = 200 * 1024 * 1024;          // 한 파일 상한(자료함과 같음)
export const TRASH_MS = 30 * 24 * 60 * 60 * 1000;    // 휴지통 30일
export const TILE_SIZE = 256;
export const TILE_DIR = 'drawtiles';
export const PREVIEW_MAX = 2400;                     // 미리보기 한 장(작은 창·위치도 내보내기) 긴 변
const URL_CACHE_MAX = 400;                           // 타일 objectURL 캐시(넘치면 오래된 것부터 놓는다)

// =====================================================================
// 순수 부분
// =====================================================================

// 확장자 → 도면 종류. 자료함 kindOf 의 drawing·pdf·image 와 같은 묶음(dwf 는 뷰어가 못 그려서 뺀다)
export const DRAWING_EXT = Object.freeze({
  cad: Object.freeze(['dwg', 'dxf', 'dwt']),
  pdf: Object.freeze(['pdf']),
  image: Object.freeze(['png', 'jpg', 'jpeg', 'jfif', 'webp', 'gif', 'bmp', 'tif', 'tiff', 'svg', 'heic', 'heif', 'avif']),
});
const KIND_OF = new Map(Object.entries(DRAWING_EXT).flatMap(([k, xs]) => xs.map(x => [x, k])));
const MIME = { pdf: 'application/pdf', dxf: 'image/vnd.dxf', dwg: 'image/vnd.dwg', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml', tif: 'image/tiff', tiff: 'image/tiff' };

export const extOf = name => (/\.([A-Za-z0-9]{1,10})$/.exec(String(name ?? '')) ?? [])[1]?.toLowerCase() ?? '';
export const drawingKind = name => KIND_OF.get(extOf(name)) ?? null;   // 'cad' | 'pdf' | 'image' | null
export const isDrawingFile = name => !!drawingKind(name);
export const KIND_LABEL = Object.freeze({ cad: '도면', pdf: 'PDF', image: '그림' });

// 보이지 않는 글자(제어·폭 없는 글자·방향 바꿈·BOM)와 경로 글자를 걷는다(docs.cleanName 과 같은 규칙)
const HIDDEN = new RegExp(`[${[[0x00, 0x1f], [0x7f, 0x9f], [0x200b, 0x200f], [0x202a, 0x202e], [0x2066, 0x2069], [0xfeff, 0xfeff]].map(([a, b]) => `${String.fromCharCode(a)}-${String.fromCharCode(b)}`).join('')}]`, 'g');
export function cleanName(name) {
  const s = String(name ?? '').normalize('NFC').replace(HIDDEN, '').replace(/[\\/:*?"<>|]/g, '_').trim().replace(/^\.+/, '').trim();
  return s || '도면';
}
// 핀 이름(자유 입력 한 줄): 보이지 않는 글자·줄바꿈을 걷고 60자까지
export const PIN_NAME_MAX = 60;
export function cleanPinName(s) {
  return String(s ?? '').normalize('NFC').replace(/[\r\n\t]+/g, ' ').replace(HIDDEN, '').replace(/\s+/g, ' ').trim().slice(0, PIN_NAME_MAX);
}
export const cleanNote = s => String(s ?? '').normalize('NFC').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 2000);

function rid(prefix) {
  const c = globalThis.crypto;
  const b = c?.getRandomValues ? c.getRandomValues(new Uint8Array(6)) : Uint8Array.from({ length: 6 }, () => Math.random() * 256);
  return prefix + Array.from(b, x => x.toString(36).padStart(2, '0')).join('').slice(0, 8);
}
export const newId = kind => rid(kind === 'pin' ? 'q_' : 'g_');
export const fileIdOf = id => 'dwgfile_' + id;

const fin = v => typeof v === 'number' && Number.isFinite(v);
const r2 = v => Math.round(v * 100) / 100;            // 픽셀 좌표는 소수 둘째 자리까지(큰 도면에서도 0.01px)

// Drawing = { id:'g_…', name, ext, kind, mime, size, addedAt, updatedAt, lastOpenedAt, tags, pinned, site,
//   fileId, fileStore, missingFile?, fromDocId?, pinSeq,
//   pages: [{ page, w, h, tiles: { levels, tileSize, ready, store, bytes, at } | null, preview: { w, h, store } | null, snapAt }],
//   geo: { page, points:[{ id, x, y, page, lat, lng, acc, how:'map'|'gps', at, n? }], model, T, q:{ estM, level, text, ok }, at } | null,
//   deletedAt }
export function newDrawing({ id = newId('drawing'), name, size = 0, mime = '', now = Date.now(), site = '', fromDocId = null } = {}) {
  const n = cleanName(name), ext = extOf(n);
  return {
    id, name: n, ext, kind: drawingKind(n) || 'image', mime: mime || MIME[ext] || 'application/octet-stream', size: Number(size) || 0,
    addedAt: now, updatedAt: now, lastOpenedAt: null, tags: '', pinned: false, site: String(site || ''),
    fileId: fileIdOf(id), fileStore: null, fromDocId: fromDocId || null, pinSeq: 0,
    pages: [], geo: null, deletedAt: null,
  };
}

// Pin = { id:'q_…', drawingId, page, x, y, no, name, nameAuto, note, color, recordId, createdAt, updatedAt, deletedAt }
//   x·y: 그 쪽 그림 픽셀(page.w×page.h 기준). no: 그 도면의 핀 순번(짧은 표지). nameAuto: 기본 이름(묶음 위치 글을 따라감)
export const PIN_COLORS = Object.freeze(['yellow', 'red', 'blue', 'green', 'black']);
export function newPin({ id = newId('pin'), drawingId, page = 1, x, y, no = 1, name = '', nameAuto = false, note = '', color = null, recordId = null, now = Date.now() } = {}) {
  return {
    id, drawingId, page: Number(page) || 1, x: r2(+x), y: r2(+y), no, name: cleanPinName(name), nameAuto: !!nameAuto, note: cleanNote(note),
    color: PIN_COLORS.includes(color) ? color : null, recordId: recordId || null, createdAt: now, updatedAt: now, deletedAt: null,
  };
}

// 다음 핀 순번: 도면의 pinSeq 와 '핀 n' 이름들 중 큰 것 + 1(지운 핀 포함 — 같은 번호가 다시 나오지 않게)
export function nextPinNo(pinList = [], seq = 0) {
  let n = Number(seq) || 0;
  for (const p of pinList) {
    if (fin(p?.no)) n = Math.max(n, p.no);
    const m = /^핀 (\d+)$/.exec(p?.name || '');
    if (m) n = Math.max(n, Number(m[1]));
  }
  return n + 1;
}
// 기본 이름: 묶음 핀이면 묶음 위치 글(recordLabel), 아니면 '핀 n'
export function defaultPinName({ no, recordLabel = '' } = {}) {
  const r = cleanPinName(recordLabel);
  return r || `핀 ${no}`;
}

// 타일 피라미드 — z 0 = 가장 작은(한 타일에 들어감), 마지막 = 원래 크기(w×h). 각 단계는 앞 단계의 2배
// → [{ z, w, h, cols, rows, scale }] (scale = 그 단계 픽셀 / 원래 픽셀)
export function pyramid(w, h, tileSize = TILE_SIZE) {
  w = Math.round(+w); h = Math.round(+h);
  if (!(w > 0 && h > 0 && tileSize > 0)) return [];
  const top = Math.max(0, Math.ceil(Math.log2(Math.max(w, h) / tileSize)));
  const out = [];
  for (let z = 0; z <= top; z++) {
    const scale = 2 ** (z - top);
    const lw = Math.max(1, Math.ceil(w * scale)), lh = Math.max(1, Math.ceil(h * scale));
    out.push({ z, w: lw, h: lh, cols: Math.ceil(lw / tileSize), rows: Math.ceil(lh / tileSize), scale });
  }
  return out;
}
export const tileCount = levels => levels.reduce((s, l) => s + l.cols * l.rows, 0);
// 화면 배율(화면 px / 원래 px) → 쓸 단계(조금 흐리지 않게 한 단계 위를 고른다: 단계 scale ≥ 화면 배율 × dpr)
export function levelFor(levels, k, dpr = 1) {
  if (!levels?.length) return null;
  const need = k * dpr;
  for (const l of levels) if (l.scale >= need * 0.999) return l;
  return levels[levels.length - 1];
}
// 원래 픽셀 사각형(보이는 범위) → 그 단계의 타일 [{ z, x, y }]
export function tilesInRect(level, rect, tileSize = TILE_SIZE) {
  if (!level) return [];
  const s = level.scale;
  const x0 = Math.max(0, Math.floor(rect.x * s / tileSize)), y0 = Math.max(0, Math.floor(rect.y * s / tileSize));
  const x1 = Math.min(level.cols - 1, Math.floor((rect.x + rect.w) * s / tileSize)), y1 = Math.min(level.rows - 1, Math.floor((rect.y + rect.h) * s / tileSize));
  const out = [];
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out.push({ z: level.z, x, y });
  return out;
}
// 타일 파일 이름(OPFS drawtiles/<drawingId>/ 안) — z 가 'pv' 면 미리보기 한 장
export const tileFile = (page, z, x = 0, y = 0) => (z === 'pv' ? `${page}-pv.jpg` : `${page}-${z}-${x}-${y}.jpg`);
export const tileKey = (drawingId, page, z, x, y) => `${drawingId}/${tileFile(page, z, x, y)}`;

// 쪽 그림 크기가 바뀌면(더 높은 해상도로 다시 뜸) 핀·기준점을 같은 비율로 옮긴다 → 바뀐 것만 돌려준다
export function rescaleXY(items, page, from, to) {
  if (!from?.w || !from?.h || !to?.w || !to?.h) return [];
  const kx = to.w / from.w, ky = to.h / from.h;
  if (Math.abs(kx - 1) < 1e-9 && Math.abs(ky - 1) < 1e-9) return [];
  return items.filter(p => (p.page ?? 1) === page && fin(p.x)).map(p => ({ ...p, x: r2(p.x * kx), y: r2(p.y * ky) }));
}

// 기준점 정리 — 숫자가 아닌 것·범위 밖은 버리고, how·acc·at 을 채운다
export function cleanPoints(points, { page = 1, now = Date.now() } = {}) {
  return (points || []).filter(p => p && fin(+p.x) && fin(+p.y) && fin(+p.lat) && fin(+p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180)
    .map(p => Object.freeze({
      id: p.id || rid('k_'), x: r2(+p.x), y: r2(+p.y), page: Number(p.page ?? page) || 1,
      lat: Math.round(+p.lat * 1e7) / 1e7, lng: Math.round(+p.lng * 1e7) / 1e7,
      acc: fin(+p.acc) && +p.acc > 0 ? Math.round(+p.acc * 10) / 10 : (p.how === 'gps' ? G.GPS_ACC_M : G.MAP_ACC_M),
      how: p.how === 'gps' ? 'gps' : 'map', at: fin(p.at) ? p.at : now, ...(fin(p.n) ? { n: p.n } : {}),
    }));
}
// 기준점 → geo(저장할 모양). 2점 미만이면 points 만 들고 T 는 null
export function buildGeo(points, { page = 1, model = 'auto', now = Date.now(), w = 0, h = 0 } = {}) {
  const pts = cleanPoints(points, { page, now }).filter(p => p.page === page);
  if (!pts.length) return null;
  const T = G.fit(pts, { model, page });
  const q = G.quality(T, { w, h });
  return { page, points: pts, model, T, q: { estM: q.estM, level: q.level, text: q.text, ok: q.ok, suspect: q.suspect?.id ?? null }, at: now };
}
// 목록 줄 표지: 위치 맞춤 여부(글자로 — 색만으로 나타내지 않는다)
export function geoBadge(d) {
  const g = d?.geo;
  if (!g || !g.T) return { state: 'none', text: g?.points?.length ? `기준점 ${g.points.length}개 · 하나 더` : '위치 안 맞춤' };
  const pm = G.fmtM(g.q?.estM);
  if (g.q?.level === 'poor' || g.q?.suspect) return { state: 'poor', text: `위치 맞춤 · 오차 큼 ±${pm}` };
  return { state: 'ok', text: `위치 맞춤 ±${pm}` };
}

// 검색 — 이름·태그·확장자·핀 이름, 공백으로 나눈 AND, 대소문자 무시(NFC). (치는 중인 한글은 화면이 docpicker makeMatcher 로 거른다)
export function matchDrawing(d, q, pinNames = '') {
  const words = String(q ?? '').normalize('NFC').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const hay = `${d.name} ${d.tags || ''} ${d.ext} ${KIND_LABEL[d.kind] || ''} ${pinNames}`.normalize('NFC').toLowerCase();
  return words.every(w => hay.includes(w));
}
const recent = d => d.lastOpenedAt || d.addedAt || 0;
export const drawingOrder = (a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || (recent(b) - recent(a));

// ---- 백업(작은 JSON: 도면 메타 + 기준점 + 핀 + 영구 삭제 기록. 원본 파일·타일은 빼고) ----
export const DUMP_V = 1;
const stripDrawing = d => ({
  ...d, fileStore: null,
  pages: (d.pages || []).map(p => ({ page: p.page, w: p.w, h: p.h, tiles: null, preview: null, snapAt: p.snapAt ?? null })),
});
// purged: { drawings: [id], pins: [id] } — 영구 삭제 기록(있으면 백업에 같이 — 복원한 기기도 지운 것을 되살리지 않게)
export function makeDump(drawingList, pinList, purged = null) {
  const out = { v: DUMP_V, drawings: drawingList.map(stripDrawing), pins: pinList.map(p => ({ ...p })) };
  if (purged && (purged.drawings?.length || purged.pins?.length)) out.purged = { drawings: [...(purged.drawings || [])], pins: [...(purged.pins || [])] };
  return out;
}
// 둘 중 새것(updatedAt) — 같으면 이 기기 것. 복원으로 들어온 도면은 원본 파일이 없으니 missingFile(저장소 부분이 파일을 찾으면 다시 잇는다)
// skip: { drawings: Set|[], pins: Set|[] } — 이 기기에서 영구 삭제한 것(되살리지 않는다)
export function mergeDump(cur = { drawings: [], pins: [] }, inc = { drawings: [], pins: [] }, skip = {}) {
  const out = { drawings: [], pins: [], added: 0, updated: 0, skipped: 0 };
  const sd = new Set(skip.drawings || []), sp = new Set(skip.pins || []);
  const dm = new Map(cur.drawings.map(d => [d.id, d]));
  for (const d of inc?.drawings || []) {
    if (!d?.id || !/^g_/.test(d.id) || (sd.has(d.id) && !dm.has(d.id))) { out.skipped++; continue; }
    const c = dm.get(d.id);
    if (!c) { out.drawings.push({ ...stripDrawing(d), missingFile: true }); out.added++; continue; }
    if ((d.updatedAt || 0) > (c.updatedAt || 0)) {
      // 이 기기의 파일·타일은 그대로 두고 메타(이름·태그·기준점·지움)만 새것으로
      out.drawings.push({ ...c, name: d.name, tags: d.tags, pinned: d.pinned, site: d.site, geo: d.geo, deletedAt: d.deletedAt ?? null,
        pinSeq: Math.max(c.pinSeq || 0, d.pinSeq || 0), updatedAt: d.updatedAt });
      out.updated++;
    } else out.skipped++;
  }
  const pm = new Map(cur.pins.map(p => [p.id, p]));
  for (const p of inc?.pins || []) {
    if (!p?.id || !/^q_/.test(p.id) || !p.drawingId || ((sp.has(p.id) || sd.has(p.drawingId)) && !pm.has(p.id))) { out.skipped++; continue; }
    const c = pm.get(p.id);
    if (!c) { out.pins.push({ ...p }); out.added++; }
    else if ((p.updatedAt || 0) > (c.updatedAt || 0)) { out.pins.push({ ...p }); out.updated++; }
    else out.skipped++;
  }
  return out;
}

// =====================================================================
// 저장소 부분(브라우저)
// =====================================================================

let dbName = DB_NAME, dbP = null;
let cache = new Map();          // id → Drawing(얼림)
let pinCache = new Map();       // id → Pin(얼림)
const tCache = new Map();       // drawingId → { geo, T } (geo 객체가 같으면 다시 계산하지 않음)
let queue = Promise.resolve();
const subs = new Set();
const pend = { drawings: new Set(), pins: new Set(), real: false };
let notifyQueued = false;
let purged = { drawings: [], pins: [] };   // 영구 삭제 기록(넣은 순서, PURGED_MAX 까지) — 'meta' 'purged'
let tileBackend = null;         // 'opfs' | 'idb'
const urls = new Map();         // tileKey → objectURL (넣은 순서 = 오래된 순)

const fsMod = () => import('./photofs.js');
const err = (code, message) => Object.assign(new Error(message), { code });
const reqP = rq => new Promise((res, rej) => { rq.onsuccess = () => res(rq.result); rq.onerror = () => rej(rq.error); });

function openDb() {
  if (dbP) return dbP;
  const p = new Promise((resolve, reject) => {
    if (!globalThis.indexedDB) { reject(err('NO_IDB', '이 환경에서는 저장소를 쓸 수 없어요')); return; }
    const rq = indexedDB.open(dbName, DB_VER);
    rq.onupgradeneeded = () => {
      const db = rq.result;
      if (!db.objectStoreNames.contains('drawings')) db.createObjectStore('drawings', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('pins')) {
        const s = db.createObjectStore('pins', { keyPath: 'id' });
        s.createIndex('drawingId', 'drawingId'); s.createIndex('recordId', 'recordId');
      }
      if (!db.objectStoreNames.contains('tiles')) db.createObjectStore('tiles', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });   // v2
    };
    rq.onsuccess = () => {
      const db = rq.result;
      const drop = () => { if (dbP === p) dbP = null; try { db.close(); } catch { /* 이미 닫힘 */ } };
      db.onclose = drop;                  // 웹뷰가 강제로 닫음(메모리 압박) → 다음 쓰기에서 다시 연다(§4.5-1)
      db.onversionchange = drop;
      resolve(db);
    };
    rq.onerror = () => reject(rq.error);
    rq.onblocked = () => console.warn('도면 DB 열기가 막혔어요(다른 탭)');
  });
  dbP = p;
  p.catch(() => { if (dbP === p) dbP = null; });
  return p;
}

// fn(stores) 은 동기로 요청만 건다. 커밋(oncomplete) 뒤 resolve. 연결이 닫혀 있었으면 한 번 다시
async function run(names, mode, fn) {
  for (let i = 0; ; i++) {
    try {
      const db = await openDb();
      return await new Promise((resolve, reject) => {
        const t = db.transaction(names, mode);
        const os = Object.fromEntries(names.map(n => [n, t.objectStore(n)]));
        let out;
        try { out = fn(os); } catch (e) { try { t.abort(); } catch { /* 끝남 */ } reject(e); return; }
        t.oncomplete = () => resolve(typeof IDBRequest !== 'undefined' && out instanceof IDBRequest ? out.result : out);
        t.onerror = () => reject(t.error);
        t.onabort = () => reject(t.error || new Error('abort'));
      });
    } catch (e) {
      if (e?.name === 'QuotaExceededError') throw Object.assign(e, { code: 'QUOTA' });
      const closed = e?.name === 'InvalidStateError' || /clos/i.test(e?.message || '');
      if (!closed || i >= 1) throw e;
      dbP = null;
    }
  }
}

function serial(fn) {
  const p = queue.then(fn);
  queue = p.catch(() => {});
  return p;
}

// init: 처음 열 때 캐시를 채운 알림(바뀐 게 아니다 — ev.init, 백업·미러는 무시한다)
function changed(kind, ids, { init = false } = {}) {
  for (const id of ids) pend[kind].add(id);
  if (!init) pend.real = true;
  if (notifyQueued) return;
  notifyQueued = true;
  queueMicrotask(() => {
    notifyQueued = false;
    const ev = { drawings: new Set(pend.drawings), pins: new Set(pend.pins), init: !pend.real };
    pend.drawings.clear(); pend.pins.clear(); pend.real = false;
    for (const fn of [...subs]) { try { fn(ev); } catch (e) { console.error(e); } }
  });
}

const freezeDrawing = d => Object.freeze({ ...d, pages: Object.freeze((d.pages || []).map(p => Object.freeze({ ...p }))) });

async function saveDrawing(d) {
  const f = freezeDrawing(d);
  await run(['drawings'], 'readwrite', s => { s.drawings.put(f); });
  cache.set(f.id, f);
  changed('drawings', [f.id]);
  return f;
}
async function savePins(list) {
  if (!list.length) return [];
  const fz = list.map(p => Object.freeze({ ...p }));
  await run(['pins'], 'readwrite', s => { for (const p of fz) s.pins.put(p); });
  for (const p of fz) pinCache.set(p.id, p);
  changed('pins', fz.map(p => p.id));
  return fz;
}

// ---- 시작 ----
let initP = null;
// 부팅에서 부르지 않아도 된다 — 화면이 ready() 로 한 번만 연다(사진 화면 부팅을 늦추지 않게)
export function initDrawings(opts = {}) {
  initP = initImpl(opts);
  initP.catch(() => { initP = null; });
  return initP;
}
export function ready() { return initP || initDrawings(); }
async function initImpl({ dbName: name, now = Date.now() } = {}) {
  if (name && name !== dbName) { dbName = name; dbP = null; tileBackend = null; }
  const [ds, ps, pg] = await run(['drawings', 'pins', 'meta'], 'readonly', s => [s.drawings.getAll(), s.pins.getAll(), s.meta.get('purged')]).then(rs => rs.map(r => r.result));
  cache = new Map(ds.map(d => [d.id, freezeDrawing(d)]));
  pinCache = new Map(ps.map(p => [p.id, Object.freeze(p)]));
  purged = { drawings: Array.isArray(pg?.drawings) ? pg.drawings.slice(-PURGED_MAX) : [], pins: Array.isArray(pg?.pins) ? pg.pins.slice(-PURGED_MAX) : [] };
  tCache.clear();
  for (const d of [...cache.values()]) {             // 휴지통 30일 지난 도면 영구 삭제
    if (d.deletedAt && now - d.deletedAt > TRASH_MS) await purgeNow(d.id).catch(e => console.warn('지난 도면을 비우지 못했어요', e));
  }
  const oldPins = [...pinCache.values()].filter(p => p.deletedAt && now - p.deletedAt > TRASH_MS).map(p => p.id);
  if (oldPins.length) {
    const tomb = withPurged([], oldPins);
    await run(['pins', 'meta'], 'readwrite', s => { for (const id of oldPins) s.pins.delete(id); s.meta.put(tomb); });
    setPurged(tomb);
    for (const id of oldPins) pinCache.delete(id);
    changed('pins', oldPins);
  }
  if (cache.size) changed('drawings', cache.keys(), { init: true });   // 화면이 처음 그리게 — 비었으면 알리지 않는다(백업·미러를 깨우지 않게)
}
// 영구 삭제 기록 — 새 기록(meta 줄)을 만들어 트랜잭션 안에서 put, 커밋 뒤 setPurged
function withPurged(dIds = [], pIds = []) {
  const add = (list, ids) => { const s = new Set(ids); return [...list.filter(x => !s.has(x)), ...ids].slice(-PURGED_MAX); };
  return { key: 'purged', drawings: add(purged.drawings, dIds), pins: add(purged.pins, pIds) };
}
function setPurged(row) { purged = { drawings: row.drawings, pins: row.pins }; }
// 영구 삭제한 도면·핀 id(백업·복구 판단용) → { drawings: [], pins: [] }
export const purgedIds = () => ({ drawings: purged.drawings.slice(), pins: purged.pins.slice() });
// 도면보관함이 「통째로 빈」 상태인지 — 도면이 하나도 없고(휴지통 포함) 영구 삭제 기록도 없음 = DB 를 잃었을 수 있다.
//   일부러 다 지운 것(기록이 남음)은 비었다고 보지 않는다(부팅 복구 질문이 다시 뜨지 않게)
export const looksLost = () => cache.size === 0 && purged.drawings.length === 0 && purged.pins.length === 0;

// fn({ drawings: Set<id>, pins: Set<id> }) — 같은 틱 변경은 한 번에
export function onDrawings(fn) { subs.add(fn); return () => subs.delete(fn); }

// ---- 도면 읽기(동기) ----
export function drawings({ deleted = false } = {}) {
  return [...cache.values()].filter(d => !!d.deletedAt === !!deleted)
    .sort(deleted ? (a, b) => b.deletedAt - a.deletedAt : drawingOrder);
}
export function drawing(id) { return id ? cache.get(id) : undefined; }
export function pageOf(id, page = 1) { return drawing(id)?.pages.find(p => p.page === page) || null; }
export function searchDrawings(q, { geo = null } = {}) {
  return drawings().filter(d => {
    if (geo !== null && !!d.geo?.T !== !!geo) return false;
    const names = q ? pins(d.id).map(p => p.name).join(' ') : '';
    return matchDrawing(d, q, names);
  });
}

// ---- 도면 쓰기 ----
// files: FileList | File[] | Blob(+name). 도면이 아니면(엑셀·문서) 그 파일만 failed. 하나씩 차례로(메모리)
// opts: { now, site, onProgress(i, n, name), fromDocId } — 자료함에서 옮겨 올 때 fromDocId(원래 자료는 부르는 쪽이 지운다)
export function addDrawingFiles(files, { now, site = '', onProgress, fromDocId = null } = {}) {
  const list = Array.from(files?.length != null && !(files instanceof Blob) ? files : [files]).filter(Boolean);
  return serial(async () => {
    await ready();
    const fs = await fsMod();
    const added = [], failed = [];
    let i = 0;
    for (const f of list) {
      const name = cleanName(f?.name);
      try { onProgress?.(i, list.length, name); } catch (e) { console.error(e); }
      try {
        if (!isDrawingFile(name)) throw err('NOT_DRAWING', '도면 파일이 아니에요(PDF·DWG·DXF·그림)');
        const size = Number(f?.size);
        if (!Number.isFinite(size) || size <= 0) throw err('EMPTY', '빈 파일이에요');
        if (size > MAX_BYTES) throw err('TOO_BIG', '200MB 넘는 파일은 못 올려요');
        const d = newDrawing({ name, size, mime: f.type, now: now ?? Date.now(), site, fromDocId });
        const { store } = await fs.put('doc', d.fileId, f);
        d.fileStore = store;
        try { added.push(await saveDrawing(d)); }
        catch (e) { await fs.remove('doc', d.fileId, store).catch(() => {}); throw e; }
      } catch (e) {
        console.warn('도면을 올리지 못했어요', name, e);
        failed.push({ name, code: e?.code || 'ERROR', reason: e?.code === 'QUOTA' ? '저장 공간이 부족해요' : (e?.code && e.message) || '저장하지 못했어요' });
      }
      i++;
    }
    try { onProgress?.(list.length, list.length, ''); } catch (e) { console.error(e); }
    return { added, failed };
  });
}

function patch(id, fn) {
  return serial(async () => {
    await ready();
    const cur = cache.get(id);
    if (!cur) throw err('NO_DRAWING', '도면이 없어요');
    const d = { ...cur, pages: cur.pages.map(p => ({ ...p })) };
    const out = await fn(d);
    return saveDrawing(out || d);
  });
}

// patch: { name?, tags?, pinned?, site?, pageCount? } — 이름을 바꿔도 확장자는 지킨다(뷰어가 확장자로 형식을 고른다)
export function updateDrawing(id, p = {}, now = Date.now()) {
  return patch(id, d => {
    if ('name' in p) { let n = cleanName(p.name); if (d.ext && extOf(n) !== d.ext) n = `${n}.${d.ext}`; d.name = n; }
    if ('tags' in p) d.tags = String(p.tags ?? '').normalize('NFC').trim();
    if ('pinned' in p) d.pinned = !!p.pinned;
    if ('site' in p) d.site = String(p.site ?? '');
    if ('pageCount' in p) d.pageCount = Math.max(1, Math.round(+p.pageCount) || 1);   // 여러 쪽 PDF(쪽 고르기) — media/drawtiles.js 가 처음 뜰 때 알린다
    d.updatedAt = now;
  });
}
export function markOpened(id, now = Date.now()) { return patch(id, d => { d.lastOpenedAt = now; }); }
export function deleteDrawing(id, now = Date.now()) { return patch(id, d => { d.deletedAt = now; d.updatedAt = now; }); }
export function restoreDrawing(id, now = Date.now()) { return patch(id, d => { d.deletedAt = null; d.updatedAt = now; }); }

// 영구 삭제: 원본 파일·타일·핀까지
export function purgeDrawing(id) { return serial(() => purgeNow(id)); }
async function purgeNow(id) {
  {
    const cur = cache.get(id);
    if (!cur) return;
    const fs = await fsMod();
    await fs.remove('doc', cur.fileId, cur.fileStore || undefined).catch(e => console.warn('도면 파일을 지우지 못했어요', e));
    await clearTilesNow(id, null).catch(e => console.warn('도면 타일을 지우지 못했어요', e));
    const gonePins = [...pinCache.values()].filter(p => p.drawingId === id);
    const pinIds = gonePins.map(p => p.id);
    const tomb = withPurged([id], pinIds);
    await run(['drawings', 'pins', 'meta'], 'readwrite', s => { s.drawings.delete(id); for (const pid of pinIds) s.pins.delete(pid); s.meta.put(tomb); });
    setPurged(tomb);
    cache.delete(id); tCache.delete(id);
    for (const pid of pinIds) pinCache.delete(pid);
    changed('drawings', [id]); if (pinIds.length) changed('pins', pinIds);
    unlinkRecords(gonePins);
  }
}
// 영구 삭제한 핀에 이어진 묶음의 record.pin 을 푼다(store.purgeRecord 가 핀 연결을 푸는 것과 짝 — 끊어진 참조가 백업에 남지 않게).
// 뒤에서(기다리지 않음). 저장소가 안 열려 있으면(시험·부팅 전) 건너뛴다 — 묶음 화면은 없는 핀을 「핀 없음」으로 본다
function unlinkRecords(list) {
  const pairs = list.filter(p => p?.recordId).map(p => [p.recordId, p.id]);
  if (!pairs.length) return;
  import('./store.js').then(async S => {
    if (!S.isReady?.()) return;
    for (const [rid, pid] of pairs) {
      const r = S.record(rid);
      if (r?.pin?.pinId === pid) await S.updateRecord(rid, { pin: null }).catch(e => console.warn('묶음 핀 연결을 풀지 못했어요', rid, e));
    }
  }).catch(() => {});
}
// 도면에 이어진 묶음 수(살아 있는 핀 중 recordId 가 있는 것) — 도면을 지울 때 알린다
export const linkedRecordCount = drawingId => new Set([...pinCache.values()].filter(p => p.drawingId === drawingId && !p.deletedAt && p.recordId).map(p => p.recordId)).size;

// 원본 파일(Blob) — 뷰어(docFrame)로 쪽을 그려 타일을 뜰 때
export async function drawingBlob(id) {
  await ready();
  const d = cache.get(id);
  if (!d || d.missingFile) return null;
  const fs = await fsMod();
  const b = await fs.get('doc', d.fileId, d.fileStore || undefined);
  if (!b) return null;
  return b.type || !d.mime ? b : new Blob([b], { type: d.mime });
}
// 복원 뒤 원본 파일 다시 넣기(백업에는 파일이 없다). 확장자가 다르면 거절
export function relinkDrawingFile(id, file) {
  return serial(async () => {
    await ready();
    const cur = cache.get(id);
    if (!cur) throw err('NO_DRAWING', '도면이 없어요');
    if (extOf(file?.name) !== cur.ext) throw err('EXT', `같은 종류(.${cur.ext}) 파일을 골라 주세요`);
    const fs = await fsMod();
    const { store } = await fs.put('doc', cur.fileId, file);
    const d = { ...cur, fileStore: store, missingFile: false, size: Number(file.size) || cur.size, updatedAt: Date.now() };
    delete d.missingFile;
    return saveDrawing(d);
  });
}

// 쪽 그림 크기 정하기(타일 만들기 전에). 크기가 바뀌면 그 쪽 핀·기준점을 같은 비율로 옮기고 타일은 다시 만들어야 함(ready:false)
// info: { w, h, snapAt? }
export function setPage(id, page, info = {}, now = Date.now()) {
  return serial(async () => {
    await ready();
    const cur = cache.get(id);
    if (!cur) throw err('NO_DRAWING', '도면이 없어요');
    const w = Math.round(+info.w), h = Math.round(+info.h);
    if (!(w > 0 && h > 0)) throw err('SIZE', '쪽 크기가 없어요');
    const pages = cur.pages.map(p => ({ ...p }));
    let pg = pages.find(p => p.page === page);
    const from = pg ? { w: pg.w, h: pg.h } : null;
    if (!pg) { pg = { page, w, h, tiles: null, preview: null, snapAt: null }; pages.push(pg); pages.sort((a, b) => a.page - b.page); }
    const resized = from && (from.w !== w || from.h !== h);
    Object.assign(pg, { w, h, snapAt: info.snapAt ?? now });
    if (resized) { pg.tiles = null; pg.preview = null; }
    const d = { ...cur, pages, updatedAt: now };
    if (resized) {
      const moved = rescaleXY([...pinCache.values()].filter(p => p.drawingId === id), page, from, { w, h }).map(p => ({ ...p, updatedAt: now }));
      if (moved.length) await savePins(moved);
      if (d.geo?.page === page) {
        const pts = rescaleXY(d.geo.points, page, from, { w, h });
        d.geo = buildGeo(pts, { page, model: d.geo.model, now, w, h });
      }
    }
    return saveDrawing(d);
  });
}

// 타일 만든 결과 알리기: tiles = { levels, tileSize, upto, ready, store, bytes } / preview = { w, h, store }
//   levels = 전체 단계 수(pyramid(page.w, page.h).length), upto = 지금까지 만든 가장 높은 z(미리보기로 아래 단계부터 먼저 → 고해상도는 한가할 때),
//   ready = 모든 단계 다 만듦. upto 를 안 주면 ready 면 levels-1, 아니면 -1
export function setTiles(id, page, { tiles, preview } = {}, now = Date.now()) {
  return patch(id, d => {
    const pg = d.pages.find(p => p.page === page);
    if (!pg) throw err('NO_PAGE', '쪽 크기를 먼저 정해 주세요(setPage)');
    if (tiles !== undefined) pg.tiles = tiles ? { levels: tiles.levels, tileSize: tiles.tileSize || TILE_SIZE, upto: fin(tiles.upto) ? tiles.upto : (tiles.ready ? tiles.levels - 1 : -1),
      ready: !!tiles.ready, store: tiles.store || null, bytes: tiles.bytes || 0, at: now } : null;
    if (preview !== undefined) pg.preview = preview ? { w: preview.w, h: preview.h, store: preview.store || null } : null;
  });
}

// ---- 타일 파일 ----
async function opfsOk() {
  try {
    if (!globalThis.navigator?.storage?.getDirectory) return false;
    const root = await navigator.storage.getDirectory();
    const dir = await root.getDirectoryHandle(TILE_DIR, { create: true });
    const fh = await dir.getFileHandle('.probe', { create: true });
    if (typeof fh.createWritable !== 'function') return false;
    const w = await fh.createWritable(); await w.write(new Uint8Array([1])); await w.close();
    await dir.removeEntry('.probe').catch(() => {});
    return true;
  } catch { return false; }
}
// force: 시험용 'opfs' | 'idb'
export async function tileStore({ force } = {}) {
  if (force) tileBackend = force;
  if (!tileBackend) tileBackend = (await opfsOk()) ? 'opfs' : 'idb';
  return tileBackend;
}
async function tileDir(drawingId, create) {
  const root = await navigator.storage.getDirectory();
  const top = await root.getDirectoryHandle(TILE_DIR, { create });
  return top.getDirectoryHandle(drawingId, { create });
}
const toBuf = async b => (b instanceof ArrayBuffer ? b : ArrayBuffer.isView(b) ? b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) : b.arrayBuffer());

// 타일 여러 장 한 번에: list = [{ z, x, y, blob }] (z 'pv' = 미리보기). → { store, bytes }
export async function putTiles(drawingId, page, list) {
  const store = await tileStore();
  let bytes = 0;
  if (store === 'opfs') {
    const dir = await tileDir(drawingId, true);
    for (const t of list) {
      const fh = await dir.getFileHandle(tileFile(page, t.z, t.x, t.y), { create: true });
      const w = await fh.createWritable();
      await w.write(t.blob); await w.close();
      bytes += t.blob.size ?? t.blob.byteLength ?? 0;
      dropUrl(tileKey(drawingId, page, t.z, t.x, t.y));
    }
    return { store, bytes };
  }
  const rows = [];
  for (const t of list) { const buf = await toBuf(t.blob); bytes += buf.byteLength; rows.push({ key: tileKey(drawingId, page, t.z, t.x, t.y), drawingId, buf, size: buf.byteLength }); }
  await run(['tiles'], 'readwrite', s => { for (const r of rows) s.tiles.put(r); });
  for (const t of list) dropUrl(tileKey(drawingId, page, t.z, t.x, t.y));
  return { store, bytes };
}
export const putTile = (drawingId, page, z, x, y, blob) => putTiles(drawingId, page, [{ z, x, y, blob }]);
export const putPreview = (drawingId, page, blob) => putTiles(drawingId, page, [{ z: 'pv', x: 0, y: 0, blob }]);

export async function tileBlob(drawingId, page, z, x, y) {
  const store = await tileStore();
  if (store === 'opfs') {
    try { return await (await (await tileDir(drawingId, false)).getFileHandle(tileFile(page, z, x, y))).getFile(); } catch { /* 없으면 IDB 도 본다 */ }
  }
  const row = await run(['tiles'], 'readonly', s => s.tiles.get(tileKey(drawingId, page, z, x, y))).catch(() => null);
  return row?.buf ? new Blob([row.buf], { type: 'image/jpeg' }) : null;
}
// 화면 주소(<img src>) — objectURL 을 넣은 순서대로 400개까지 기억, 넘치면 오래된 것부터 놓는다(이미 그린 <img> 는 그대로 보인다)
export async function tileSrc(drawingId, page, z, x, y) {
  const k = tileKey(drawingId, page, z, x, y);
  const hit = urls.get(k);
  if (hit) { urls.delete(k); urls.set(k, hit); return hit; }
  const b = await tileBlob(drawingId, page, z, x, y);
  if (!b) return null;
  if (urls.has(k)) return urls.get(k);
  const u = URL.createObjectURL(b);
  urls.set(k, u);
  while (urls.size > URL_CACHE_MAX) { const [ok, ou] = urls.entries().next().value; urls.delete(ok); URL.revokeObjectURL(ou); }
  return u;
}
export const previewBlob = (drawingId, page) => tileBlob(drawingId, page, 'pv');
export const previewSrc = (drawingId, page) => tileSrc(drawingId, page, 'pv');
function dropUrl(k) { const u = urls.get(k); if (u) { URL.revokeObjectURL(u); urls.delete(k); } }

async function clearTilesNow(drawingId, page) {
  for (const k of [...urls.keys()]) if (k.startsWith(drawingId + '/') && (page == null || k.startsWith(`${drawingId}/${page}-`))) dropUrl(k);
  const store = await tileStore();
  if (store === 'opfs') {
    try {
      const root = await navigator.storage.getDirectory();
      const top = await root.getDirectoryHandle(TILE_DIR, { create: false });
      if (page == null) await top.removeEntry(drawingId, { recursive: true });
      else {
        const dir = await top.getDirectoryHandle(drawingId, { create: false });
        const names = [];
        for await (const [name] of dir.entries()) if (name.startsWith(`${page}-`)) names.push(name);
        for (const n of names) await dir.removeEntry(n).catch(() => {});
      }
    } catch { /* 폴더 없음 */ }
  }
  const lo = page == null ? `${drawingId}/` : `${drawingId}/${page}-`;
  await run(['tiles'], 'readwrite', s => { s.tiles.delete(IDBKeyRange.bound(lo, lo + '￿')); }).catch(() => {});
}
// 그 쪽(page 없으면 모든 쪽) 타일 지우기 + 메타 ready:false
export async function clearTiles(drawingId, page = null) {
  await clearTilesNow(drawingId, page);
  if (!cache.get(drawingId)) return;
  await patch(drawingId, d => { for (const p of d.pages) if (page == null || p.page === page) { p.tiles = null; p.preview = null; } });
}

// ---- 위치 맞추기(기준점) ----
// points: [{ id?, x, y, lat, lng, acc?, how:'map'|'gps', at?, n? }] 그 쪽 그림 픽셀 ↔ 위경도. opts: { page, model }
// → 저장된 Drawing. 2점 미만이면 기준점만 두고 변환 없음. 빈 배열이면 위치 맞춤 지우기
export function setGeoPoints(id, points, { page, model = 'auto', now = Date.now() } = {}) {
  return patch(id, d => {
    const pg = page ?? d.geo?.page ?? d.pages[0]?.page ?? 1;
    const size = d.pages.find(p => p.page === pg) || {};
    d.geo = points?.length ? buildGeo(points, { page: pg, model, now, w: size.w, h: size.h }) : null;
    d.updatedAt = now;
    tCache.delete(id);
  });
}
// 변환(core/georef.js T) — 없으면 null. 저장된 T 를 쓰고, 없거나 판이 다르면 기준점으로 다시 계산(메모리 캐시)
export function transformOf(id) {
  const d = cache.get(id);
  const g = d?.geo;
  if (!g) return null;
  const c = tCache.get(id);
  if (c && c.geo === g) return c.T;
  const T = G.isTransform(g.T) ? g.T : G.fit(g.points, { model: g.model || 'auto', page: g.page });
  tCache.set(id, { geo: g, T });
  return T;
}
export function geoQuality(id) {
  const d = cache.get(id), T = transformOf(id);
  const pg = d?.pages.find(p => p.page === d.geo?.page) || {};
  return G.quality(T, { w: pg.w, h: pg.h });
}

// ---- 핀 읽기(동기) ----
export function pins(drawingId, { page = null, deleted = false } = {}) {
  const out = [];
  for (const p of pinCache.values()) {
    if (p.drawingId !== drawingId || !!p.deletedAt !== !!deleted) continue;
    if (page != null && p.page !== page) continue;
    out.push(p);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt || a.no - b.no);
}
export function pin(id) { return id ? pinCache.get(id) : undefined; }
export function pinsOfRecord(recordId) {
  if (!recordId) return [];
  return [...pinCache.values()].filter(p => p.recordId === recordId && !p.deletedAt && !cache.get(p.drawingId)?.deletedAt)
    .sort((a, b) => a.createdAt - b.createdAt);
}
// 핀 위경도(그 도면 변환이 있고 같은 쪽일 때) — 저장하지 않고 계산만
export function pinLatLng(p) {
  const q = typeof p === 'string' ? pinCache.get(p) : p;
  if (!q) return null;
  const d = cache.get(q.drawingId);
  if (!d?.geo || d.geo.page !== q.page) return null;
  return G.toLatLng(transformOf(q.drawingId), q.x, q.y);
}
// 지도(map 화면)에 도면 핀 — 위치 맞춘 도면의 살아 있는 핀. livemap setMarkers 모양 + drawingId·pinId
export function geoMarkers({ drawingId = null } = {}) {
  const out = [];
  for (const d of drawings()) {
    if (drawingId && d.id !== drawingId) continue;
    if (!transformOf(d.id)) continue;
    for (const p of pins(d.id, { page: d.geo.page })) {
      const ll = pinLatLng(p);
      if (ll) out.push({ id: `dwg:${p.id}`, lat: ll.lat, lng: ll.lng, label: p.name, kind: 'dwgpin', pinId: p.id, drawingId: d.id, recordId: p.recordId });
    }
  }
  return out;
}
// 지금 위치가 안에 있거나 가까운 도면(위치 맞춘 것만) — 촬영 화면 「이 도면 띄우기」 제안·도면보관함 맨 위
// → [{ drawing, outsideM, x, y }] 안(0m)부터 가까운 순
export function drawingsAt(pos, { marginM = 50 } = {}) {
  if (!pos || !fin(pos.lat) || !fin(pos.lng)) return [];
  const out = [];
  for (const d of drawings()) {
    const T = transformOf(d.id);
    if (!T) continue;
    const pg = d.pages.find(p => p.page === d.geo.page);
    if (!pg?.w) continue;
    const m = G.outsideM(T, pg.w, pg.h, pos.lat, pos.lng);
    if (m == null || m > marginM) continue;
    const q = G.toXY(T, pos.lat, pos.lng);
    out.push({ drawing: d, outsideM: m, x: q.x, y: q.y });
  }
  return out.sort((a, b) => a.outsideM - b.outsideM);
}

// ---- 핀 쓰기 ----
// addPin({ drawingId, page, x, y, name?, note?, color?, recordId?, recordLabel?, now }) → Pin
//   name 을 비우면 기본 이름: recordLabel(묶음 위치 글 — 부르는 쪽이 record.location 을 준다)이 있으면 그것(nameAuto), 없으면 '핀 n'
export function addPin({ drawingId, page = 1, x, y, name = '', note = '', color = null, recordId = null, recordLabel = '', now = Date.now() } = {}) {
  return serial(async () => {
    await ready();
    const d = cache.get(drawingId);
    if (!d) throw err('NO_DRAWING', '도면이 없어요');
    if (!fin(+x) || !fin(+y)) throw err('XY', '핀 자리가 없어요');
    const no = nextPinNo(pins(drawingId, { deleted: false }).concat(pins(drawingId, { deleted: true })), d.pinSeq);
    const given = cleanPinName(name);
    const auto = !given;
    const p = newPin({ drawingId, page, x, y, no, name: given || defaultPinName({ no, recordLabel }), nameAuto: auto && (!!cleanPinName(recordLabel) || !!recordId), note, color, recordId, now });
    const fz = Object.freeze(p);
    const nd = freezeDrawing({ ...d, pinSeq: no, updatedAt: now });
    await run(['pins', 'drawings'], 'readwrite', s => { s.pins.put(fz); s.drawings.put(nd); });
    pinCache.set(fz.id, fz); cache.set(nd.id, nd);
    changed('pins', [fz.id]); changed('drawings', [nd.id]);
    return fz;
  });
}

function patchPin(id, fn) {
  return serial(async () => {
    await ready();
    const cur = pinCache.get(id);
    if (!cur) throw err('NO_PIN', '핀이 없어요');
    const p = { ...cur };
    fn(p);
    const [out] = await savePins([p]);
    return out;
  });
}
// patch: { name?, x?, y?, page?, note?, color?, recordId? } — 이름을 비우면 기본 이름('핀 n')으로, 직접 고친 이름은 더 따라가지 않는다
export function updatePin(id, p = {}, now = Date.now()) {
  return patchPin(id, q => {
    if ('name' in p) { const n = cleanPinName(p.name); q.name = n || `핀 ${q.no}`; q.nameAuto = false; }
    if ('x' in p && fin(+p.x)) q.x = r2(+p.x);
    if ('y' in p && fin(+p.y)) q.y = r2(+p.y);
    if ('page' in p && fin(+p.page)) q.page = +p.page;
    if ('note' in p) q.note = cleanNote(p.note);
    if ('color' in p) q.color = PIN_COLORS.includes(p.color) ? p.color : null;
    if ('recordId' in p) q.recordId = p.recordId || null;
    q.updatedAt = now;
  });
}
export function deletePin(id, now = Date.now()) { return patchPin(id, q => { q.deletedAt = now; q.updatedAt = now; }); }
export function restorePin(id, now = Date.now()) { return patchPin(id, q => { q.deletedAt = null; q.updatedAt = now; }); }
export function purgePin(id) {
  return serial(async () => {
    if (!pinCache.has(id)) return;
    const gone = pinCache.get(id);
    const tomb = withPurged([], [id]);
    await run(['pins', 'meta'], 'readwrite', s => { s.pins.delete(id); s.meta.put(tomb); });
    setPurged(tomb);
    pinCache.delete(id);
    changed('pins', [id]);
    unlinkRecords([gone]);
  });
}
// 묶음 위치 글이 바뀌면 그 묶음의 「기본 이름」 핀만 따라 바꾼다(직접 고친 이름은 그대로) → 바꾼 개수
export function syncRecordPinNames(recordId, label, now = Date.now()) {
  return serial(async () => {
    await ready();
    const n = cleanPinName(label);
    const list = [...pinCache.values()].filter(p => p.recordId === recordId && p.nameAuto && !p.deletedAt)
      .map(p => ({ ...p, name: n || `핀 ${p.no}`, nameAuto: true, updatedAt: now })).filter(p => p.name !== pinCache.get(p.id).name);
    await savePins(list);
    return list.length;
  });
}

// ---- 백업·복원(작은 JSON) ----
export function dumpDrawings() {
  return makeDump([...cache.values()], [...pinCache.values()], purged);
}
// → { added, updated, skipped, relinked } — 원본 파일이 없는 도면은 missingFile(도면보관함에 「원본 파일을 다시 올려 주세요」).
//   원본 파일 경로는 id 로 정해진다(photofs 'doc'/'dwgfile_'+id) — APK 는 DATA/docs 에 있어 IDB 를 잃어도 남는다. 있으면 다시 잇는다(relinked)
//   이 기기에서 영구 삭제한 도면·핀은 되살리지 않고, 들어온 영구 삭제 기록은 합친다
export function mergeDrawings(dump) {
  return serial(async () => {
    await ready();
    if (!dump || dump.v !== DUMP_V) return { added: 0, updated: 0, skipped: 0, relinked: 0 };
    const r = mergeDump({ drawings: [...cache.values()], pins: [...pinCache.values()] }, dump, purged);
    let relinked = 0;
    const inMerge = new Set(r.drawings.map(d => d.id));
    const lost = [...r.drawings.filter(d => d.missingFile), ...[...cache.values()].filter(d => d.missingFile && !inMerge.has(d.id))];
    if (lost.length) {
      const fs = await fsMod().catch(() => null);
      for (const d of lost) {
        const st = await Promise.resolve(fs?.has?.('doc', d.fileId || fileIdOf(d.id))).catch(() => null);
        if (!st) continue;
        const nd = { ...d, fileId: d.fileId || fileIdOf(d.id), fileStore: st };
        delete nd.missingFile;
        const i = r.drawings.findIndex(x => x.id === d.id);
        if (i >= 0) r.drawings[i] = nd; else r.drawings.push(nd);
        relinked++;
      }
    }
    const inP = dump.purged && typeof dump.purged === 'object' ? dump.purged : null;
    const newD = (inP?.drawings || []).filter(id => typeof id === 'string' && !cache.has(id) && !purged.drawings.includes(id));
    const newP = (inP?.pins || []).filter(id => typeof id === 'string' && !pinCache.has(id) && !purged.pins.includes(id));
    const tomb = newD.length || newP.length ? withPurged(newD, newP) : null;
    const ds = r.drawings.map(freezeDrawing), ps = r.pins.map(p => Object.freeze(p));
    if (ds.length || ps.length || tomb) {
      await run(['drawings', 'pins', 'meta'], 'readwrite', s => { for (const d of ds) s.drawings.put(d); for (const p of ps) s.pins.put(p); if (tomb) s.meta.put(tomb); });
      if (tomb) setPurged(tomb);
    }
    for (const d of ds) { cache.set(d.id, d); tCache.delete(d.id); }
    for (const p of ps) pinCache.set(p.id, p);
    if (ds.length) changed('drawings', ds.map(d => d.id));
    if (ps.length) changed('pins', ps.map(p => p.id));
    return { added: r.added, updated: r.updated, skipped: r.skipped, relinked };
  });
}

export async function usage() {
  await ready();
  let count = 0, bytes = 0, tiles = 0;
  for (const d of cache.values()) { count++; bytes += d.size || 0; for (const p of d.pages) tiles += p.tiles?.bytes || 0; }
  return { count, bytes, tiles, pins: [...pinCache.values()].filter(p => !p.deletedAt).length };
}

// 시험용: 메모리 상태 비우기(DB 는 그대로)
export function _reset() { cache = new Map(); pinCache = new Map(); purged = { drawings: [], pins: [] }; tCache.clear(); initP = null; dbP = null; tileBackend = null; for (const u of urls.values()) URL.revokeObjectURL(u); urls.clear(); }
