// 큰 도면 타일 — 도면 한 쪽을 높은 해상도 그림으로 한 번 떠서 타일 피라미드로 저장하고, 화면은 보이는 타일만 꺼내 쓴다.
// 「도면보관함」(사용자 요구 2026-10-22: "도면은 따로 모아두자 … 길찾고 핀 가능하게"): 도면을 지도처럼 — 무거운 뷰어 iframe 을 매번 띄우지 않고
//   지도 엔진(ui/widgets/livemap.js 이미지 좌표계 모드)이 이 타일을 깐다.
// 체감 속도: 디코드·줄이기·자르기·인코딩은 전부 워커(drawtile-worker.js, OffscreenCanvas). 메인 스레드는 받은 Blob 을 저장소에 넘기기만 한다.
//
// 저장(data/drawings.js 의 타일 저장소 — OPFS `drawtiles/<id>/<page>-<z>-<x>-<y>.jpg`, 미리보기 `<page>-pv.jpg`, 안 되면 도면 DB 'tiles'):
//   APK 에서도 웹뷰가 직접 쓰는 파일이라 브리지를 타지 않는다(photofs 'doc' 은 APK 에서 타일마다 base64 브리지 — 200장이면 수 초, 그래서 쓰지 않는다).
//   목록표(단계·빈 칸)는 도면 메타 pages[].tiles 에 둔다(동기로 읽힘 — 타일 주소를 만들 때 파일을 열지 않고 빈 칸을 거른다):
//     tiles = { levels:[{w,h,cols,rows,blank:[칸 번호]}], tileSize, upto, ready, store, bytes, at }   (upto = 다 쓴 가장 높은 단계)
// 단계 z: 0 = 가장 작은 단계(한 타일 안에 쏙), levels.length-1 = 원본 해상도(= 쪽 그림 w×h = 핀 좌표 잣대). 단계마다 앞 단계를 반으로(올림).
//   타일 (z,x,y) 는 단계 z 의 [x*T, min((x+1)*T, lw)) × [y*T, …) — 가장자리 타일은 남은 크기만큼(채우지 않음)
//   빈 타일(바탕색 한 가지)은 저장하지 않는다 — 화면은 흰 바닥(미리보기)이 비친다
// 작은 단계부터 쓰고, 단계가 다 써질 때마다 upto 를 올린다 → 다 만들기 전에도 미리보기 + 아래 단계로 도면 보기·핀·위치 맞추기가 다 된다.
//
// 계약
//   buildTiles(drawingId, page, blob, { tileSize=512, format='auto'|'jpeg'|'png', q=0.85, maxPx, maxSide, previewMax=2400, onProgress, signal }) → meta
//   tileUrl(drawingId, page, z, x, y) → Promise<string|null>        빈 칸·아직 안 만든 칸은 null
//   tileSource(drawingId, page) → livemap 이미지 모드 source | null  (쪽 크기를 아직 모르면 null)
//   tilesReady(drawingId, page) → boolean · tilesMeta(drawingId, page) → pages[].tiles | null
//   removeTiles(drawingId, page) · releaseUrls()(도면 저장소가 objectURL 400개 LRU 를 쥔다 — 할 일 없음, 계약 유지)
//   renderPageLarge(iframeEl, { maxSide, maxPx, page, q, signal, detail }) → Blob
//   도면 처리 줄(올린 뒤 뒤에서 한 번에 하나): queueDrawing(id, { page, force }) → Promise · buildState(id) → { phase, pct, page, message } | null
//     · onBuild(fn(id)) → off · resumePending() — 다 못 만든 도면을 다시 줄에 세운다(도면보관함·도면 보기 화면이 부른다)
import * as D from '../data/drawings.js';
import * as N from '../platform/native.js';
import { snapshotFromFrame, snapKind } from './docsnap.js';

const WORKER_URL = new URL('./drawtile-worker.js', import.meta.url);
const VIEWER_URL = new URL('../../viewer/index.html?embed=1', import.meta.url).href;
const PUT_PAR = 3;                     // 저장 동시 실행 수
const IDLE_MS = 60000;                 // 워커가 이만큼 아무 말 없으면 실패로 본다
const FRAME_MS = 120000;               // 숨긴 뷰어가 도면을 열기까지 한도(DWG 엔진을 처음 받으면 오래 걸린다)
const BG = [255, 255, 255];
// 워커가 바로 풀 수 있는 그림(뷰어 없이) — SVG·TIFF·HEIC 는 뷰어로 떠서
const DIRECT = new Set(['png', 'jpg', 'jpeg', 'jfif', 'webp', 'gif', 'bmp', 'avif']);

function checkArgs(id, page) {
  if (typeof id !== 'string' || !id || /[\\/:]|\.\./.test(id)) throw new Error(`도면 id 가 맞지 않아요: ${id}`);
  if (!Number.isInteger(page) || page < 1) throw new Error(`쪽 번호가 맞지 않아요: ${page}`);
}
const abortErr = () => Object.assign(new Error('취소했어요'), { name: 'AbortError' });
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 기기 메모리에 맞춘 해상도 한도 ----
// 원본 단계 RGBA 비트맵 + 아래 단계 캔버스(1/3) + docsnap 이어 붙이기 캔버스까지 한꺼번에 살 수 있다 — 45MP 면 순간 수백 MB
export function sizeLimits() {
  const mem = Number(globalThis.navigator?.deviceMemory) || 4;          // Chrome·안드로이드 웹뷰: 0.25~8(8 이 상한), 없으면 4 로 본다
  if (mem >= 8) return { maxSide: 8000, maxPx: 46e6 };
  if (mem >= 4) return { maxSide: 6000, maxPx: 26e6 };
  return { maxSide: 4096, maxPx: 12e6 };
}

// ---- 목록표·주소 ----
// 도면 DB 에 없는 id(시험·단독으로 buildTiles 만 쓸 때)는 목록표를 메모리에만 둔다
const localMeta = new Map();           // 'id:page' → tiles
export function tilesMeta(id, page) { return D.pageOf(id, page)?.tiles || localMeta.get(`${id}:${page}`) || null; }
export function tilesReady(id, page) { return !!tilesMeta(id, page)?.ready; }
// 그 칸이 저장돼 있을 수 있나(목록표로 — 파일을 열지 않고 빈 칸·아직 안 만든 칸을 거른다)
function tileExists(id, page, z, x, y) {
  const t = tilesMeta(id, page);
  const l = t?.levels?.[z];
  if (!l || z > (t.upto ?? -1) || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= l.cols || y >= l.rows) return false;
  if (l.blank?.length) {
    if (!l._b) Object.defineProperty(l, '_b', { value: new Set(l.blank), enumerable: false });
    if (l._b.has(y * l.cols + x)) return false;
  }
  return true;
}
export async function tileUrl(id, page, z, x, y) {
  if (!tileExists(id, page, z, x, y)) return null;
  const k = memKey(id, page, `${z}/${x}/${y}`);
  const hit = lruGet(urlMem, k);
  if (hit) return hit;
  let p = urlWait.get(k);                                             // 같은 칸을 동시에 두 번 읽지 않게
  if (!p) {
    p = readTile(id, page, z, x, y).then(b => {
      if (!b) return null;
      const u = URL.createObjectURL(b);
      lruSet(urlMem, k, u, 0);
      return u;
    }).catch(() => null).finally(() => urlWait.delete(k));
    urlWait.set(k, p);
  }
  return p;
}
// 이미 읽어 둔 칸이면 바로(동기) — 엔진이 첫 그림에 기다림 없이 깐다. 없으면 null
export function tileUrlNow(id, page, z, x, y) { return tileExists(id, page, z, x, y) ? lruGet(urlMem, memKey(id, page, `${z}/${x}/${y}`)) : null; }

// livemap 이미지 모드 source — 쪽 크기를 정한 뒤부터(미리보기 단계) 보인다
//   previewNow() — 디코드까지 끝난 미리보기 <img>(메모리에 남겨 둔 것) | null : 두 번째 열기는 이것으로 첫 그림에 바로
//   thumbNow() — 맨 아래 단계 타일(목록 썸네일과 같은 그림) 주소 | null : 미리보기가 풀리기 전 잠깐 깔 흐린 바닥
//   tileNow(z,x,y) — 읽어 둔 타일 주소(동기) | null · prefetch(z,x,y) — 한가할 때 미리 읽고 풀어 두기
//   keep(z,x,y,img) — 다 그려진 칸 <img> 를 맡김(디코드된 채 LRU) · take(z,x,y) — 맡긴·미리 푼 <img> 를 꺼냄 | null
export function tileSource(id, page = 1) {
  const pg = D.pageOf(id, page);
  if (!pg?.w || !pg?.h) return null;
  const t = pg.tiles;
  return {
    kind: 'image', w: pg.w, h: pg.h, tileSize: t?.tileSize || 512, levels: t?.levels?.length ? t.levels : null, upto: t?.upto ?? -1,
    tile: (z, x, y) => tileUrl(id, page, z, x, y),
    tileNow: (z, x, y) => tileUrlNow(id, page, z, x, y),
    prefetch: (z, x, y) => prefetchTile(id, page, z, x, y),
    keep: (z, x, y, im) => keepTile(id, page, z, x, y, im),
    take: (z, x, y) => takeTile(id, page, z, x, y),
    preview: pg.preview ? () => previewImg(id, page).then(im => im?.src || null) : null,
    previewImg: pg.preview ? () => previewImg(id, page) : null,
    previewNow: pg.preview ? () => previewNow(id, page) : null,
    thumbNow: () => tileUrlNow(id, page, 0, 0, 0),
    previewW: pg.preview?.w || 0, previewH: pg.preview?.h || 0, bg: '#ffffff',
    sig: `${pg.w}x${pg.h}|${t?.upto ?? -1}|${t?.ready ? 1 : 0}|${t?.at || 0}|${pg.preview ? 1 : 0}`,
  };
}
export function releaseUrls(id, page) { if (id) dropMem(id, page ?? null); }
// → 지운 타일 수(목록표 기준 — 빈 칸 빼고)
export async function removeTiles(id, page) {
  checkArgs(id, page);
  const t = tilesMeta(id, page);
  const n = t?.levels ? t.levels.reduce((s, l) => s + l.cols * l.rows - (l.blank?.length || 0), 0) : 0;
  localMeta.delete(`${id}:${page}`);
  dropMem(id, page);
  await D.clearTiles(id, page);
  return n;
}

// ---- 메모리에 남겨 두기(최근 연 도면 — 두 번째 열기는 파일을 다시 열지 않고 첫 그림에) ----
// 타일 주소(objectURL — OPFS 파일을 가리킬 뿐이라 메모리를 거의 안 먹는다): 최근 URL_MEM 개(LRU)
// 미리보기 <img>(디코드 끝난 것 — 긴 변 2400 이면 장당 약 16MB): 기기 메모리에 맞춘 바이트 상한(LRU)
// 디코드된 타일 <img>(화면에서 뺀 칸·한가할 때 미리 푼 주변·한 단계 위): 바이트 상한(LRU, 512² 한 장 약 1MB)
// 무효화: 그 쪽 그림을 다시 만들기 시작할 때·타일을 지울 때·도면이 지워지거나 쪽 크기·미리보기 크기가 바뀔 때(onDrawings)
const URL_MEM = 600;
function decBudget() {
  const mem = Number(globalThis.navigator?.deviceMemory) || 4;
  return mem >= 8 ? 64e6 : mem >= 4 ? 40e6 : 12e6;
}
function pvBudget() {
  const mem = Number(globalThis.navigator?.deviceMemory) || 4;
  return mem >= 8 ? 96e6 : mem >= 4 ? 48e6 : 20e6;
}
const urlMem = new Map();              // key → { v:url, bytes }
const urlWait = new Map();             // key → Promise<url|null>
const pvMem = new Map();               // 'id|page' → { v:{ img, sig }, bytes }
const pvWait = new Map();              // 'id|page' → Promise<img|null>
const decMem = new Map();              // key → { v:img, bytes }
let pvBytes = 0, decBytes = 0;
const memKey = (id, page, rest) => `${id}|${page}|${rest}`;
function lruGet(m, k) { const e = m.get(k); if (!e) return null; m.delete(k); m.set(k, e); return e.v; }
function lruSet(m, k, v, bytes) {
  const old = m.get(k);
  if (old) { m.delete(k); freeEntry(m, k, old); }
  m.set(k, { v, bytes });
  if (m === pvMem) pvBytes += bytes;
  else if (m === decMem) decBytes += bytes;
  trim(m);
}
function freeEntry(m, k, e) {
  if (m === urlMem) { try { URL.revokeObjectURL(e.v); } catch { /* 무시 */ } }
  else if (m === pvMem) { pvBytes -= e.bytes; const im = e.v.img; if (im && !im.isConnected) { try { URL.revokeObjectURL(im.src); } catch { /* 무시 */ } im.removeAttribute('src'); } }
  else if (m === decMem) decBytes -= e.bytes;                         // 타일 주소는 urlMem 이 쥔다 — 풀어 둔 그림만 놓는다
}
function trim(m) {
  const over = () => (m === urlMem ? m.size > URL_MEM : m === decMem ? decBytes > decBudget() : pvBytes > pvBudget() && m.size > 1);
  for (const [k, e] of m) {
    if (!over()) break;
    if (m === pvMem && e.v.img?.isConnected) continue;               // 지금 화면에 깔린 미리보기는 남긴다
    m.delete(k); freeEntry(m, k, e);
  }
}
// 그 도면(쪽) 것 모두 놓기
function dropMem(id, page = null) {
  const pre = page == null ? `${id}|` : `${id}|${page}|`;
  for (const m of [urlMem, decMem]) for (const [k, e] of [...m]) if (k.startsWith(pre)) { m.delete(k); freeEntry(m, k, e); }
  for (const [k, e] of [...pvMem]) if (`${k}|`.startsWith(pre)) { pvMem.delete(k); freeEntry(pvMem, k, e); }
  for (const m of [urlWait, pvWait]) for (const k of [...m.keys()]) if (`${k}|`.startsWith(pre)) m.delete(k);
  if (page == null) { memPages.delete(id); dirMem.delete(id); } else memPages.get(id)?.delete(page);
}
// 도면이 바뀌면(지움·쪽 크기·미리보기) 그 도면 것만 맞춰 놓는다 — 처음 쓸 때 한 번 구독
let memWatch = false;
function watchMem() {
  if (memWatch) return;
  memWatch = true;
  D.onDrawings(ev => {
    for (const id of ev.drawings) {
      const d = D.drawing(id);
      if (!d || d.deletedAt || d.missingFile) { if (memPages.has(id)) dropMem(id); continue; }
      for (const page of memPages.get(id) || []) {
        const pg = D.pageOf(id, page);
        const pv = pvMem.get(`${id}|${page}`);
        // 타일을 지웠거나(다시 만들기·영구 삭제) 쪽·미리보기 크기가 바뀌었으면 그 쪽 것을 놓는다(진행 중 upto 가 오르는 것은 그대로 맞다)
        if (!pg || !pg.tiles || !pg.preview || (pv && pv.v.sig !== pvSig(pg))) dropMem(id, page);
      }
    }
  });
}
const memPages = new Map();            // id → Set(page) — 메모리에 뭔가 둔 쪽(무효화 확인용)
const notePage = (id, page) => { let s = memPages.get(id); if (!s) memPages.set(id, s = new Set()); s.add(page); };
const pvSig = pg => `${pg.w}x${pg.h}|${pg.preview?.w}x${pg.preview?.h}`;

// 타일 파일 읽기 — OPFS 폴더 손잡이를 도면마다 기억(타일마다 루트부터 폴더 세 번 열던 것을 한 번으로). 안 되면 저장소 함수 그대로
const dirMem = new Map();              // id → Promise<FileSystemDirectoryHandle|null>
let storeKind = null;
async function readTile(id, page, z, x, y) {
  watchMem();
  notePage(id, page);
  if (!storeKind) storeKind = await D.tileStore().catch(() => 'idb');
  if (storeKind === 'opfs') {
    let dp = dirMem.get(id);
    if (!dp) {
      dp = navigator.storage.getDirectory().then(r => r.getDirectoryHandle(D.TILE_DIR)).then(t => t.getDirectoryHandle(id)).catch(() => null);
      dirMem.set(id, dp);
    }
    const dir = await dp;
    if (dir) {
      try { return await (await dir.getFileHandle(D.tileFile(page, z, x, y))).getFile(); } catch { dirMem.delete(id); /* 폴더가 바뀜 — 아래로 */ }
    } else dirMem.delete(id);
  }
  return D.tileBlob(id, page, z, x, y);
}

// 미리보기 한 장 — 읽고 디코드까지 끝낸 <img>(그대로 화면에 붙여도 기다림 없이 그려진다)
export function previewNow(id, page = 1) {
  const pg = D.pageOf(id, page);
  if (!pg?.preview) return null;
  const v = lruGet(pvMem, `${id}|${page}`);
  return v && v.sig === pvSig(pg) && v.img.complete && v.img.naturalWidth ? v.img : null;
}
export function previewImg(id, page = 1) {
  const now = previewNow(id, page);
  if (now) return Promise.resolve(now);
  const pg = D.pageOf(id, page);
  if (!pg?.preview) return Promise.resolve(null);
  const k = `${id}|${page}`;
  let p = pvWait.get(k);
  if (p) return p;
  watchMem();
  const sig = pvSig(pg);
  p = readTile(id, page, 'pv', 0, 0).then(async b => {
    if (!b) return null;
    const im = new Image();
    im.decoding = 'async';
    im.alt = '';
    im.src = URL.createObjectURL(b);
    try { await im.decode(); } catch { await new Promise(r => { if (im.complete) r(); else { im.onload = im.onerror = () => r(); } }); }
    if (!im.naturalWidth) { URL.revokeObjectURL(im.src); return null; }
    if (pvWait.get(k) !== p) { URL.revokeObjectURL(im.src); return null; }   // 그새 무효화됨
    lruSet(pvMem, k, { img: im, sig }, im.naturalWidth * im.naturalHeight * 4);
    return im;
  }).catch(() => null).finally(() => { if (pvWait.get(k) === p) pvWait.delete(k); });
  pvWait.set(k, p);
  return p;
}
// 미리 받아 풀어 두기(한가할 때 엔진이 부른다 — 주변 칸·한 단계 위)
async function prefetchTile(id, page, z, x, y) {
  const k = memKey(id, page, `${z}/${x}/${y}`);
  if (decMem.has(k)) return lruGet(decMem, k)?.src || null;
  const u = await tileUrl(id, page, z, x, y);
  if (!u) return null;
  const im = new Image();
  im.decoding = 'async';
  im.src = u;
  try { await im.decode(); } catch { return u; }
  if (!tileExists(id, page, z, x, y) || decMem.has(k)) return u;      // 그새 다시 만들기 시작했거나 화면이 먼저 맡김
  lruSet(decMem, k, im, im.naturalWidth * im.naturalHeight * 4);
  return u;
}
// 디코드된 칸 <img> 맡기기·꺼내기(엔진이 화면에서 뺀 칸 — 다시 열거나 되돌아올 때 기다림 없이)
function keepTile(id, page, z, x, y, im) {
  if (!im?.complete || !im.naturalWidth || !tileExists(id, page, z, x, y)) return false;
  lruSet(decMem, memKey(id, page, `${z}/${x}/${y}`), im, im.naturalWidth * im.naturalHeight * 4);
  notePage(id, page);
  return true;
}
function takeTile(id, page, z, x, y) {
  const k = memKey(id, page, `${z}/${x}/${y}`);
  const e = decMem.get(k);
  if (!e) return null;
  decMem.delete(k); decBytes -= e.bytes;
  const im = e.v;
  return im.complete && im.naturalWidth ? im : null;
}
// 도면 하나 미리 데우기 — 미리보기(디코드까지)·맨 아래 단계 타일. 줄을 누르는 순간(pointerdown)·목록이 뜬 뒤 한가할 때
//   맞춤으로 열 때 깔릴 단계(화면 크기·밀도로 고름 — livemap 과 같은 규칙)의 칸과 맨 아래 단계(작은 창)를 먼저 풀어 두고, 미리보기는 그다음
export function warm(id, page = null) {
  const d = D.drawing(id);
  if (!d || d.deletedAt || d.missingFile) return Promise.resolve(false);
  const pg = page ? D.pageOf(id, page) : (D.pageOf(id, d.geo?.page || 0) || d.pages?.[0]);
  if (!pg?.preview && !pg?.tiles) return Promise.resolve(false);
  const jobs = [prefetchTile(id, pg.page, 0, 0, 0)];
  const fz = fitLevel(pg);
  const l = fz > 0 ? pg.tiles?.levels?.[fz] : null;
  if (l && l.cols * l.rows <= 12) for (let y = 0; y < l.rows; y++) for (let x = 0; x < l.cols; x++) jobs.push(prefetchTile(id, pg.page, fz, x, y));
  return Promise.all(jobs).catch(() => null).then(() => (pg.preview ? previewImg(id, pg.page) : null)).then(im => !!im, () => false);
}
// 화면에 맞춰 열 때 엔진이 고를 단계(livemap imageGeo.level 과 같은 식 — 도면 보기 화면은 폭 꽉·높이 약 70%)
function fitLevel(pg) {
  const L = pg?.tiles?.levels;
  if (!L?.length || !pg.w || !pg.h || typeof innerWidth !== 'number') return 0;
  const top = L.length - 1, dpr = globalThis.devicePixelRatio || 1;
  const fz = top + Math.log2(Math.min((innerWidth * 0.94) / pg.w, (innerHeight * 0.7 * 0.94) / pg.h));
  const bias = Math.min(1.4, Math.max(0.25, Math.log2(dpr)));
  return Math.max(0, Math.min(Math.min(top, pg.tiles.upto ?? top), Math.round(fz + bias)));
}
// 고정·최근 도면 몇 개를 한가할 때 데운다(미리보기 바이트 상한 안에서) — 도면보관함·도면 보기 화면이 뜰 때(resumePending)
let warmT = 0;
export function warmRecent(n = null) {
  if (warmT || typeof document === 'undefined') return;
  const idle = fn => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 2500 }) : setTimeout(fn, 600));
  warmT = idle(async () => {
    warmT = 0;
    const cap = n ?? Math.max(1, Math.floor(pvBudget() / 16e6) - 1);
    // 고정한 것 → 최근 연(없으면 올린) 순 — 다음에 열 가능성이 큰 것부터
    const when = d => d.lastOpenedAt || d.addedAt || 0;
    const list = D.drawings().filter(d => !d.missingFile && d.pages?.some(p => p.preview || p.tiles))
      .sort((a, b) => ((b.pinned ? 1 : 0) - (a.pinned ? 1 : 0)) || (when(b) - when(a))).slice(0, cap);
    for (const d of list) {
      if (!N.isQuiet(800)) await N.whenQuiet({ quietMs: 800, maxMs: 8000 });
      await warm(d.id).catch(() => {});
    }
  });
}
export function memStats() { return { urls: urlMem.size, previews: pvMem.size, previewMB: Math.round(pvBytes / 1e5) / 10, decoded: decMem.size, decodedMB: Math.round(decBytes / 1e5) / 10, budgetMB: pvBudget() / 1e6, decBudgetMB: decBudget() / 1e6 }; }

// ---- 워커 ----
let seq = 0;
let chain = Promise.resolve();         // 만들기는 한 번에 하나(메모리)
let workerOk = null;
async function probeWorker() {
  if (workerOk !== null) return workerOk;
  workerOk = await new Promise(res => {
    let w;
    try { w = new Worker(WORKER_URL); } catch { res(false); return; }
    const t = setTimeout(() => { w.terminate(); res(false); }, 10000);
    w.onmessage = e => { clearTimeout(t); w.terminate(); res(!!e.data?.ok); };
    w.onerror = () => { clearTimeout(t); w.terminate(); res(false); };
    w.postMessage({ op: 'ping', id: 0 });
  });
  return workerOk;
}

// ---- 만들기 ----
export function buildTiles(id, page, blob, opts = {}) {
  checkArgs(id, page);
  const run = chain.then(() => build(id, page, blob, opts));
  chain = run.catch(() => {});
  return run;
}

async function build(id, page, blob, { tileSize = 512, format = 'auto', q = 0.85, maxPx = sizeLimits().maxPx, maxSide = 0, previewMax = D.PREVIEW_MAX, onProgress, signal } = {}) {
  if (!blob || !(blob.size > 0)) throw Object.assign(new Error('도면 그림이 비어 있어요'), { code: 'EMPTY' });
  if (signal?.aborted) throw abortErr();
  if (!(await probeWorker())) throw Object.assign(new Error('이 기기에서는 도면 타일을 만들 수 없어요(워커 그림 기능 없음)'), { code: 'NO_WORKER' });
  const t0 = performance.now();
  const hasMeta = () => !!D.drawing(id);
  localMeta.delete(`${id}:${page}`);
  dropMem(id, page);                                                  // 메모리에 남긴 예전 그림도
  await D.clearTiles(id, page).catch(() => {});                       // 예전 것(단계 수가 다를 수 있다)

  const w = new Worker(WORKER_URL);
  const jobId = ++seq;
  let size = null, plan = null, store = null, done = null, failed = null;
  let written = 0, bytes = 0, lastTick = 0, idleT = 0, upto = -1;
  const blank = [];                                                   // [z, idx]
  let perLevel = [];                                                  // 단계마다 끝난 칸 수(쓴 것 + 빈 것)
  const queue = [];
  let writing = 0, settle, fail;
  let meta = Promise.resolve();                                       // 메타 쓰기는 순서대로(쪽 크기 → 미리보기 → 단계)
  const finished = new Promise((res, rej) => { settle = res; fail = rej; });
  const levelsNow = () => size.levels.map((l, z) => ({ ...l, blank: blank.filter(b => b[0] === z).map(b => b[1]).sort((a, b) => a - b) }));

  const progress = (force = false) => {
    if (!onProgress || !size) return;
    const now = performance.now();
    if (!force && now - lastTick < 150) return;                      // 150ms 에 한 번까지(화면 글 바꾸기)
    lastTick = now;
    try { onProgress({ done: written + blank.length, total: size.total, tiles: written, bytes, format: plan?.format }); } catch { /* 부른 쪽 오류 무시 */ }
  };
  const kill = err => {
    if (failed) return;
    failed = err;
    clearTimeout(idleT);
    try { w.terminate(); } catch { /* 이미 끝남 */ }
    fail(err);
  };
  const poke = () => { clearTimeout(idleT); idleT = setTimeout(() => kill(new Error('도면 타일 워커가 답하지 않아요')), IDLE_MS); };
  const metaStep = fn => { meta = meta.then(() => (failed ? null : fn())).catch(e => console.warn('도면 메타를 못 썼어요', e)); };
  // 단계 z 가 다 써졌으면 upto 를 올린다(아래 단계부터 차례로)
  const levelDone = () => {
    let u = upto;
    while (u + 1 < size.levels.length && perLevel[u + 1] === size.levels[u + 1].cols * size.levels[u + 1].rows) u++;
    if (u === upto || u === size.levels.length - 1) { upto = u; return; }   // 마지막 단계는 done 에서 한 번에
    upto = u;
    if (hasMeta()) metaStep(() => D.setTiles(id, page, { tiles: { levels: levelsNow(), tileSize, upto: u, ready: false, store, bytes } }));
  };
  // 글 입력 중이면 저장을 잠깐 미룬다(키보드·한글 조합과 다투지 않게 — 워커는 계속 자른다)
  const typingWait = async () => { for (let i = 0; i < 50 && !N.isQuiet(0); i++) await sleep(200); };
  const pump = () => {
    while (!failed && writing < PUT_PAR && queue.length) {
      const t = queue.shift();
      writing++;
      typingWait().then(() => D.putTiles(id, page, [{ z: t.z, x: t.x, y: t.y, blob: t.blob }])).then(r => {
        store = store || r.store;
        written++; bytes += t.blob.size;
        perLevel[t.z] = (perLevel[t.z] || 0) + 1;
        w.postMessage({ op: 'ack', id: jobId, n: 1 });
        progress();
        levelDone();
      }, e => kill(e)).finally(() => { writing--; pump(); check(); });
    }
  };
  const check = () => { if (!failed && done && !writing && !queue.length) settle(); };
  const onAbort = () => kill(abortErr());
  signal?.addEventListener('abort', onAbort, { once: true });

  w.onmessage = e => {
    const m = e.data || {};
    if (m.id !== jobId || failed) return;
    poke();
    if (m.op === 'size') {
      size = m; perLevel = m.levels.map(() => 0);
      if (hasMeta()) metaStep(() => D.setPage(id, page, { w: m.w, h: m.h }));
      progress(true);
    } else if (m.op === 'preview') {
      metaStep(async () => {
        const r = await D.putPreview(id, page, m.blob);
        if (hasMeta()) await D.setTiles(id, page, { tiles: { levels: levelsNow(), tileSize, upto: -1, ready: false, store: r.store, bytes: 0 }, preview: { w: m.w, h: m.h, store: r.store } });
      });
    } else if (m.op === 'plan') { plan = m; progress(true); }
    else if (m.op === 'tile') { queue.push(m); pump(); }
    else if (m.op === 'blank') { blank.push([m.z, m.y * size.levels[m.z].cols + m.x]); perLevel[m.z] = (perLevel[m.z] || 0) + 1; progress(); levelDone(); }
    else if (m.op === 'done') { done = m; clearTimeout(idleT); check(); }
    else if (m.op === 'error') kill(Object.assign(new Error(m.error || '도면 타일을 만들지 못했어요'), { code: /메모리|memory/i.test(m.error) ? 'MEMORY' : /decod|디코드/i.test(m.error) ? 'DECODE' : 'BUILD' }));
  };
  w.onerror = e => { e.preventDefault?.(); kill(new Error(`도면 타일 워커 오류: ${e.message || '알 수 없음'}`)); };
  poke();
  w.postMessage({ op: 'build', id: jobId, blob, tileSize, format, q, maxPx, maxSide, bg: BG, previewMax });

  try {
    await finished;
  } catch (e) {
    signal?.removeEventListener('abort', onAbort);
    while (writing) await sleep(30);                                  // 쓰던 것이 끝난 뒤 치운다(지운 뒤 늦게 써지지 않게)
    await meta;
    await D.clearTiles(id, page).catch(() => {});
    throw e;
  }
  signal?.removeEventListener('abort', onAbort);
  try { w.terminate(); } catch { /* 끝남 */ }
  await meta;
  const levels = levelsNow();
  const tiles = { levels, tileSize, upto: levels.length - 1, ready: true, store, bytes };
  if (hasMeta()) await D.setTiles(id, page, { tiles });
  else localMeta.set(`${id}:${page}`, { ...tiles, w: size.w, h: size.h, at: Date.now() });
  progress(true);
  return {
    ...tiles, w: size.w, h: size.h, format: plan?.format, bg: '#ffffff', tiles: written, blankTiles: blank.length, srcW: size.srcW, srcH: size.srcH,
    ms: { ...done.ms, wall: Math.round(performance.now() - t0) }, sample: plan?.sample,
  };
}

// ---- 도면 쪽을 높은 해상도 그림으로 ----
// 뷰어 iframe(숨겨 둬도 된다: 화면 밖이 아니라 opacity 0 으로 화면 위에 두면 그리기가 멈추지 않는다)에 열린 도면을
// docsnap.snapshotFromFrame 으로 큰 배율로 다시 그린다. 뷰어 사본은 고치지 않는다.
// page: PDF 여러 쪽이면 그 쪽으로 넘긴 뒤 뜬다(docsnap 은 「지금 가장 많이 보이는 쪽」을 뜨므로).
export async function renderPageLarge(iframeEl, { maxSide, maxPx, page = null, q = 0.92, signal, detail = false } = {}) {
  const lim = sizeLimits();
  maxSide = maxSide || lim.maxSide; maxPx = maxPx || lim.maxPx;
  const k = snapKind(iframeEl);
  if (!k.kind) throw Object.assign(new Error(k.reason === 'format' ? '도면(PDF·DWG·DXF)이나 그림만 타일로 만들 수 있어요' : '도면이 아직 열리지 않았어요'), { code: k.reason === 'format' ? 'FORMAT' : 'LOADING', reason: k.reason });
  if (k.kind === 'pdf' && page) {
    const api = iframeEl.contentWindow.AV.active().instance.api;
    if (page > api.pages) throw Object.assign(new Error(`${page}쪽이 없어요(전체 ${api.pages}쪽)`), { code: 'PAGE' });
    if (api.page !== page) {
      api.goPage(page);
      const t = Date.now();
      while (api.page !== page && Date.now() - t < 3000) await sleep(50);
      await sleep(120);                                                // 스크롤 자리 잡기
    }
  }
  const r = await snapshotFromFrame(iframeEl, { maxSide, hardMax: maxSide, maxPx, focusMin: 0, q, signal });
  if (r.unsupported) throw Object.assign(new Error(r.message), { code: 'LOADING', reason: r.reason });
  if (page && r.page !== page) throw Object.assign(new Error(`${page}쪽을 뜨지 못했어요(${r.page}쪽이 떠짐)`), { code: 'PAGE' });
  return detail ? r : r.blob;
}

// 숨긴 뷰어에 파일 하나를 열어 그릴 준비가 될 때까지 → { iframe, close() }
export async function openHidden(blob, name, { timeout = FRAME_MS, signal } = {}) {
  const host = document.createElement('div');
  host.setAttribute('aria-hidden', 'true');
  Object.assign(host.style, { position: 'fixed', left: '0', top: '0', width: '480px', height: '640px', opacity: '0', pointerEvents: 'none', zIndex: '-1', contain: 'strict' });
  const iframe = document.createElement('iframe');
  iframe.title = '도면 그리기(숨김)';
  iframe.tabIndex = -1;
  Object.assign(iframe.style, { width: '100%', height: '100%', border: '0' });
  iframe.src = VIEWER_URL;
  host.append(iframe);
  document.body.append(host);
  const close = () => { try { iframe.contentWindow?.postMessage({ type: 'av:close' }, '*'); } catch { /* 무시 */ } host.remove(); };
  try {
    await new Promise((res, rej) => {
      const t = setTimeout(() => { off(); rej(Object.assign(new Error('뷰어가 뜨지 않았어요'), { code: 'LOADING' })); }, 60000);
      const onMsg = e => { if (e.source === iframe.contentWindow && e.data?.type === 'av:ready') { off(); res(); } };
      const onLoad = () => { off(); res(); };
      const off = () => { clearTimeout(t); removeEventListener('message', onMsg); iframe.removeEventListener('load', onLoad); };
      addEventListener('message', onMsg);
      iframe.addEventListener('load', onLoad);
    });
    const buf = await blob.arrayBuffer();
    iframe.contentWindow.postMessage({ type: 'av:open', name, data: buf }, '*', [buf]);
    const t0 = Date.now();
    for (;;) {
      if (signal?.aborted) throw abortErr();
      const s = snapKind(iframe);
      if (s.kind && s.name === name) break;
      if (s.reason === 'format' && s.name === name) throw Object.assign(new Error('이 파일은 도면으로 그릴 수 없어요'), { code: 'FORMAT' });
      if (s.reason === 'error' && s.name === name) {
        // 뷰어가 엔진(LibreDWG·PDF.js — CDN, 처음 한 번 인터넷)을 못 받았으면 ENGINE(파일 탓이 아님 — 인터넷이 있으면 resumePending 이 다시), 아니면 OPEN
        let why = '';
        try { const er = iframe.contentWindow.AV.active()?.error; why = String(er?.message || er || ''); } catch { /* 무시 */ }
        throw Object.assign(new Error(why || '도면을 열지 못했어요'), { code: /인터넷|CDN/.test(why) ? 'ENGINE' : 'OPEN' });
      }
      if (Date.now() - t0 > timeout) throw Object.assign(new Error('도면을 여는 데 너무 오래 걸려요(처음엔 인터넷 필요)'), { code: 'TIMEOUT' });
      await sleep(250);
    }
    await sleep(300);                                                  // 첫 그리기 자리 잡기
    return { iframe, close };
  } catch (e) { close(); throw e; }
}

// 숨긴 뷰어 이어 쓰기(같은 도면의 여러 쪽) — 줄에 그 도면이 더 없으면 닫는다. 남겨 둬도 30초 뒤엔 닫는다(메모리)
let hidden = null;                     // { id, fr, t }
async function hiddenFor(id, blob, name) {
  if (hidden && hidden.id === id) { clearTimeout(hidden.t); return hidden.fr; }
  closeHidden();
  const fr = await openHidden(blob, name);
  hidden = { id, fr, t: 0 };
  return fr;
}
function closeHidden() { if (!hidden) return; clearTimeout(hidden.t); try { hidden.fr.close(); } catch { /* 이미 닫힘 */ } hidden = null; }
function releaseHidden(id) {
  if (!hidden || hidden.id !== id) return;
  const more = [...queued].filter(k => k.startsWith(`${id}:`)).length > 1;   // 지금 것(아직 줄에 있음) 말고 더
  if (!more) { closeHidden(); return; }
  hidden.t = setTimeout(closeHidden, 30000);
}

// ---- 도면 처리 줄(올린 뒤 뒤에서, 한 번에 하나) ----
const states = new Map();              // id → { phase:'wait'|'render'|'tiles'|'error', pct, page, message }
const buildSubs = new Set();
const queued = new Set();
let jobs = Promise.resolve();
function setState(id, s) {
  if (s) states.set(id, Object.freeze({ ...s })); else states.delete(id);
  for (const fn of [...buildSubs]) { try { fn(id); } catch (e) { console.error(e); } }
}
export const buildState = id => states.get(id) || null;
export function onBuild(fn) { buildSubs.add(fn); return () => buildSubs.delete(fn); }

const ERR_TEXT = { NOFILE: '원본 파일이 없어요', FORMAT: '이 파일은 도면으로 그릴 수 없어요', TIMEOUT: '여는 데 너무 오래 걸려요(처음엔 인터넷 필요)', NO_WORKER: '이 기기에서는 그림을 못 만들어요', MEMORY: '메모리가 모자라요', QUOTA: '저장 공간이 부족해요', ENGINE: '처음 한 번 인터넷이 필요해요. 연결되면 다시 만들어요' };
export function queueDrawing(id, { page = 1, force = false } = {}) {
  const k = `${id}:${page}`;
  if (queued.has(k)) return jobs;
  queued.add(k);
  if (!states.get(id) || states.get(id).phase === 'error') setState(id, { phase: 'wait', pct: 0, page });
  const p = jobs.then(() => processOne(id, page, force)).then(() => setState(id, null), e => {
    console.warn('도면 그림을 못 만들었어요', id, e);
    setState(id, { phase: 'error', pct: 0, page, code: e?.code || 'ERROR', message: ERR_TEXT[e?.code] || '그림을 못 만들었어요', at: Date.now() });
  }).finally(() => queued.delete(k));
  jobs = p.catch(() => {});
  return p;
}
const ENGINE_RETRY_MS = 15000;         // 엔진을 못 받은 도면을 화면에 들어올 때 다시 세우는 간격(오가며 헛걸음 — 숨긴 뷰어 띄우기 — 을 줄인다)
export async function resumePending() {
  await D.ready();
  const online = globalThis.navigator?.onLine !== false;
  for (const d of D.drawings()) {
    const s = states.get(d.id);
    // 오류 난 도면은 다시 세우지 않는다(같은 파일이면 또 실패) — 엔진을 못 받은 것(ENGINE)만, 인터넷이 있고 조금 지났으면 다시
    const retry = s?.code === 'ENGINE' && online && Date.now() - (s.at || 0) > ENGINE_RETRY_MS;
    if (d.missingFile || (s?.phase === 'error' && !retry)) continue;
    if (!d.pages.length) queueDrawing(d.id, { page: 1 });
    else for (const pg of d.pages) if (!pg.tiles?.ready || !pg.preview) queueDrawing(d.id, { page: pg.page });
  }
  warmRecent();                                                       // 최근 연 도면은 한가할 때 미리보기까지 풀어 둔다(누르면 바로)
}
// 인터넷이 돌아오면 엔진을 못 받은 도면을 바로 다시(브라우저·PWA. 앱 웹뷰는 이 알림이 안 올 수 있어 — 화면에 다시 들어올 때 resumePending 이 한다)
if (typeof addEventListener === 'function') addEventListener('online', () => { for (const [id, s] of [...states]) if (s.code === 'ENGINE') queueDrawing(id, { page: s.page || 1 }); });

// ---- [모두 미리 변환] — 아직 그림이 없는 쪽(여러 쪽 PDF 의 2쪽부터 등)까지 지금 다 만든다(지하·오프라인에서 처음 여는 쪽도 바로 뜨게) ----
// 네트워크: PDF·DWG·DXF 는 뷰어 엔진을 처음 한 번 인터넷에서 받는다 → 화면은 셀룰러면 묻고, 아니면 「와이파이 권장」 한 줄.
// netInfo() → { type, cellular, saveData, known }  (Network Information API — 안드로이드 크롬·웹뷰. 없으면 known:false)
export function netInfo() {
  const c = globalThis.navigator?.connection;
  if (!c) return { type: null, cellular: false, saveData: false, known: false };
  const type = c.type || null;
  const cellular = type === 'cellular' || (!type && /(^|-)(2g|3g)$/.test(c.effectiveType || ''));
  return { type, cellular, saveData: !!c.saveData, known: !!(type || c.effectiveType) };
}
// 만들 것 → { pages:[{id,page}], drawings, engines } — engines: 뷰어로 떠야 하는 형식(PDF·CAD)이 끼어 있음(처음엔 인터넷)
export function prebuildPlan() {
  const pages = [];
  const ids = new Set();
  let engines = false;
  for (const d of D.drawings()) {
    if (d.missingFile || d.deletedAt) continue;
    const n = Math.max(1, d.pageCount || 0, d.pages.length);
    for (let p = 1; p <= n; p++) {
      const pg = D.pageOf(d.id, p);
      if (pg?.tiles?.ready && pg.preview) continue;
      pages.push({ id: d.id, page: p });
      ids.add(d.id);
      if (d.kind !== 'image' || !DIRECT.has(d.ext)) engines = true;
    }
  }
  return { pages, drawings: ids.size, engines };
}
// 모두 줄 세우기 → Promise<{ total, done, failed }>. onProgress(done, total) — 한 쪽 끝날 때마다
export async function prebuildAll({ onProgress } = {}) {
  await D.ready();
  const plan = prebuildPlan();
  const total = plan.pages.length;
  let done = 0, failed = 0;
  const tick = () => { try { onProgress?.(done, total); } catch { /* 무시 */ } };
  tick();
  // 실패한 도면(오류 표시)도 다시 — 사용자가 직접 누른 것이므로
  for (const { id } of plan.pages) if (states.get(id)?.phase === 'error') states.delete(id);
  await Promise.all(plan.pages.map(({ id, page }) => queueDrawing(id, { page }).then(() => {
    const pg = D.pageOf(id, page);
    if (pg?.tiles?.ready) done++; else failed++;
    tick();
  })));
  return { total, done, failed };
}

async function processOne(id, page, force) {
  await D.ready();
  const d = D.drawing(id);
  if (!d || d.deletedAt || d.missingFile) return;
  const pg = D.pageOf(id, page);
  if (!force && pg?.tiles?.ready && pg.preview) return;
  await N.whenQuiet({ quietMs: 1200, maxMs: 15000 });                 // 셔터·글 입력과 겹치지 않게
  const blob = await D.drawingBlob(id);
  if (!blob) throw Object.assign(new Error('원본 없음'), { code: 'NOFILE' });
  const lim = sizeLimits();
  // 이미 쪽 크기가 있으면 같은 크기로(핀 좌표가 그대로) — 처음이면 기기 한도
  const maxSide = pg?.w ? Math.max(pg.w, pg.h) : lim.maxSide;
  const onProgress = p => setState(id, { phase: 'tiles', pct: p.total ? Math.round((p.done / p.total) * 100) : 0, page });
  if (d.kind === 'image' && DIRECT.has(d.ext)) {
    try {
      setState(id, { phase: 'tiles', pct: 0, page });
      await buildTiles(id, page, blob, { maxSide, maxPx: lim.maxPx, onProgress });
      return;
    } catch (e) {
      if (e?.code !== 'DECODE' && e?.code !== 'BUILD') throw e;
      console.warn('그림을 바로 못 풀어 뷰어로 떠요', e);
    }
  }
  setState(id, { phase: 'render', pct: 0, page });
  // 숨긴 뷰어는 같은 도면의 다음 쪽이 줄에 있으면 닫지 않고 이어 쓴다(쪽마다 뷰어를 다시 띄우고 PDF 를 다시 읽지 않게)
  const fr = await hiddenFor(id, blob, d.name);
  let r;
  try {
    await N.whenQuiet({ quietMs: 800, maxMs: 10000 });
    r = await renderPageLarge(fr.iframe, { page: d.kind === 'pdf' ? page : null, maxSide, maxPx: lim.maxPx, detail: true });
  } catch (e) { closeHidden(); throw e; } finally { releaseHidden(id); }
  if (r.pages > 1 && D.drawing(id)?.pageCount !== r.pages) await D.updateDrawing(id, { pageCount: r.pages }).catch(() => {});
  setState(id, { phase: 'tiles', pct: 0, page });
  await buildTiles(id, page, r.blob, { maxSide, maxPx: lim.maxPx, onProgress });
}

// 시험용
export function _reset() { workerOk = null; states.clear(); queued.clear(); for (const id of [...memPages.keys()]) dropMem(id); dirMem.clear(); storeKind = null; }
