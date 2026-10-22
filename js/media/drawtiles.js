// 큰 도면 타일 — 도면 한 쪽을 높은 해상도 그림으로 한 번 떠서 타일 피라미드로 저장하고, 화면은 보이는 타일만 꺼내 쓴다.
// 「도면보관함」(사용자 요구 2026-10-22: "도면은 따로 모아두자 … 길찾고 핀 가능하게"): 도면을 지도처럼 — 무거운 뷰어 iframe 을 매번 띄우지 않고
//   지도 엔진(livemap '이미지 좌표계' 모드, 통합 때)이 이 타일을 깐다.
// 체감 속도: 디코드·줄이기·자르기·인코딩은 전부 워커(drawtile-worker.js, OffscreenCanvas). 메인 스레드는 받은 Blob 을 저장소에 넘기기만 한다.
//
// 저장(data/photofs.js 'doc' 종류 — 고치지 않고 계약대로):
//   타일   'dtile_<drawingId>_<page>_<z>_<x>_<y>'   JPEG 또는 PNG(도면마다 작은 쪽을 고른다)
//   목록표 'dtile_<drawingId>_<page>_meta'           JSON — 다 쓴 뒤 마지막에 쓴다(이것이 있어야 tilesReady). 중간에 죽으면 반쪽 타일은 removeTiles 가 치운다
// 단계 z: 0 = 가장 작은 단계(한 타일 안에 쏙), levels.length-1 = 원본 해상도. 단계마다 앞 단계를 반으로(올림).
//   단계 z 의 화소 (lx,ly) ↔ 원본 화소 (lx * w / levels[z].w, ly * h / levels[z].h)   — 반올림 탓에 정확히 2^k 배가 아닐 수 있어 단계 크기로 나눈다
//   타일 (z,x,y) 는 단계 z 의 [x*T, min((x+1)*T, lw)) × [y*T, …) — 가장자리 타일은 남은 크기만큼(채우지 않음)
//   빈 타일(바탕색 한 가지)은 저장하지 않는다 — tileUrl 이 null, 화면은 meta.bg 로 칠한다(여백 많은 도면에서 쓰기·용량 절약)
//
// 계약
//   buildTiles(drawingId, page, blob, { tileSize=512, format='auto'|'jpeg'|'png', q=0.85, maxPx, onProgress, signal }) → { w, h, levels, tileSize, ...meta }
//   tileUrl(drawingId, page, z, x, y) → Promise<string|null>        같은 타일은 같은 주소(캐시). 빈 타일·없는 타일은 null
//   tilesReady(drawingId, page) → Promise<boolean>
//   tilesMeta(drawingId, page) → Promise<meta|null>                  { v, w, h, tileSize, levels:[{w,h,cols,rows,blank:[칸 번호]}], format, bg, store, bytes, tiles, createdAt }
//   removeTiles(drawingId, page) → Promise<number>                   지운 타일 수
//   releaseUrls(drawingId?, page?)                                    만들어 둔 objectURL 놓기(화면을 떠날 때)
//   renderPageLarge(iframeEl, { maxSide, maxPx, page, q, signal, detail }) → Blob   (detail:true 면 docsnap 결과 { blob, w, h, page, pages, kind, ms })
import * as photofs from '../data/photofs.js';
import * as N from '../platform/native.js';
import { snapshotFromFrame, snapKind } from './docsnap.js';

const WORKER_URL = new URL('./drawtile-worker.js', import.meta.url);
const PUT_PAR = 3;                     // 저장 동시 실행 수(OPFS·IDB·브리지 모두 몇 개 겹치면 빨라지고 더는 안 빨라진다)
const URL_MAX = 800;                   // 주소 캐시(objectURL) 상한 — 넘으면 오래 안 쓴 것부터 놓는다
const IDLE_MS = 60000;                 // 워커가 이만큼 아무 말 없으면 실패로 본다
const BG = [255, 255, 255];

const keyOf = (id, page, z, x, y) => `dtile_${id}_${page}_${z}_${x}_${y}`;
const metaKey = (id, page) => `dtile_${id}_${page}_meta`;
const prefix = (id, page) => `dtile_${id}_${page}_`;
const TAIL = /^(\d+_\d+_\d+|meta)$/;   // prefix 뒤 — 다른 도면 id(밑줄·숫자로 끝나는 id)의 타일을 지우지 않게 정확히

function checkArgs(id, page) {
  if (typeof id !== 'string' || !id || /[\\/:]|\.\./.test(id)) throw new Error(`도면 id 가 맞지 않아요: ${id}`);
  if (!Number.isInteger(page) || page < 1) throw new Error(`쪽 번호가 맞지 않아요: ${page}`);
}
const abortErr = () => Object.assign(new Error('취소했어요'), { name: 'AbortError' });

// ---- 기기 메모리에 맞춘 해상도 한도 ----
// 원본 단계 RGBA 비트맵 + 아래 단계 캔버스(1/3) + docsnap 이어 붙이기 캔버스까지 한꺼번에 살 수 있다 — 45MP 면 순간 수백 MB
export function sizeLimits() {
  const mem = Number(globalThis.navigator?.deviceMemory) || 4;          // Chrome·안드로이드 웹뷰: 0.25~8(8 이 상한), 없으면 4 로 본다
  if (mem >= 8) return { maxSide: 8000, maxPx: 46e6 };
  if (mem >= 4) return { maxSide: 6000, maxPx: 26e6 };
  return { maxSide: 4096, maxPx: 12e6 };
}

// ---- 목록표(meta) ----
const metaCache = new Map();           // 'id_page' → Promise<meta|null>
const ck = (id, page) => `${id}_${page}`;

export function tilesMeta(id, page) {
  checkArgs(id, page);
  const k = ck(id, page);
  if (!metaCache.has(k)) {
    const p = (async () => {
      const b = await photofs.get('doc', metaKey(id, page)).catch(() => null);
      if (!b) return null;
      try {
        const m = JSON.parse(await b.text());
        return m && m.v === 1 && Array.isArray(m.levels) ? withSets(m) : null;
      } catch { return null; }
    })();
    metaCache.set(k, p);
    p.then(m => { if (!m && metaCache.get(k) === p) metaCache.delete(k); });   // 없음은 기억하지 않는다(만든 뒤 바로 보이게)
  }
  return metaCache.get(k);
}
function withSets(m) {
  // blank 는 칸 번호(y*cols+x) 배열 — tileUrl 이 빠르게 보도록 Set 을 숨은 속성으로
  for (const l of m.levels) Object.defineProperty(l, '_blank', { value: new Set(l.blank || []), enumerable: false });
  return m;
}
export async function tilesReady(id, page) { return !!(await tilesMeta(id, page)); }

// ---- 주소 ----
const urls = new Map();                // 타일 키 → Promise<string|null> (Map 순서 = 최근 쓴 순, LRU)
function dropUrl(k, p) {
  urls.delete(k);
  Promise.resolve(p).then(u => { if (u && u.startsWith('blob:')) URL.revokeObjectURL(u); }, () => {});
}
async function makeUrl(key, store) {
  // APK: 자료(doc)는 Filesystem DATA/docs/<id>. photofs.url 은 먼저 fsStat(브리지 왕복)을 하므로 타일마다 하면 끌 때 늦다 —
  // 목록표가 있다는 건 다 썼다는 뜻이라 확인 없이 뿌리 주소로 바로 만든다(photofs 의 경로 규칙 DIRS.doc='docs', 확장자 없음과 맞춤)
  if (store === 'file' && N.isNative?.()) {
    try { return N.fileSrcSync('DATA', `docs/${key}`); } catch { /* 뿌리 주소를 아직 못 받음 — 아래로 */ }
  }
  return photofs.url('doc', key, store);
}
export async function tileUrl(id, page, z, x, y) {
  const m = await tilesMeta(id, page);
  if (!m) return null;
  const l = m.levels[z];
  if (!l || x < 0 || y < 0 || x >= l.cols || y >= l.rows || !Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (l._blank.has(y * l.cols + x)) return null;
  const k = keyOf(id, page, z, x, y);
  let p = urls.get(k);
  if (p) { urls.delete(k); urls.set(k, p); return p; }               // 최근 씀으로
  p = makeUrl(k, m.store).catch(() => null);
  urls.set(k, p);
  p.then(u => { if (!u && urls.get(k) === p) urls.delete(k); });      // 못 만든 것은 다음에 다시
  if (urls.size > URL_MAX) { const [ok, op] = urls.entries().next().value; dropUrl(ok, op); }
  return p;
}
export function releaseUrls(id, page) {
  const pre = id ? (page ? prefix(id, page) : `dtile_${id}_`) : 'dtile_';
  for (const [k, p] of [...urls]) if (k.startsWith(pre)) dropUrl(k, p);
}

// ---- 지우기 ----
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const it = items[i++]; await fn(it); } }));
}
export async function removeTiles(id, page) {
  checkArgs(id, page);
  const m = await tilesMeta(id, page);
  metaCache.delete(ck(id, page));
  releaseUrls(id, page);
  let keys;
  if (m) {
    keys = [];
    m.levels.forEach((l, z) => { for (let y = 0; y < l.rows; y++) for (let x = 0; x < l.cols; x++) if (!l._blank.has(y * l.cols + x)) keys.push(keyOf(id, page, z, x, y)); });
  } else {
    // 목록표가 없다 = 만들다 말았거나 없음 → 저장소를 훑어 그 도면·쪽 것만
    const pre = prefix(id, page);
    keys = (await photofs.list('doc').catch(() => [])).filter(k => k.startsWith(pre) && TAIL.test(k.slice(pre.length)) && !k.endsWith('_meta'));
  }
  await photofs.remove('doc', metaKey(id, page), m?.store).catch(() => {});   // 목록표부터(지우다 죽어도 「반쯤 있음」으로 보이지 않게)
  await pool(keys, 6, k => photofs.remove('doc', k, m?.store).catch(() => {}));
  return keys.length;
}

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

async function build(id, page, blob, { tileSize = 512, format = 'auto', q = 0.85, maxPx = sizeLimits().maxPx, onProgress, signal } = {}) {
  if (!blob || !(blob.size > 0)) throw Object.assign(new Error('도면 그림이 비어 있어요'), { code: 'EMPTY' });
  if (signal?.aborted) throw abortErr();
  if (!(await probeWorker())) throw Object.assign(new Error('이 기기에서는 도면 타일을 만들 수 없어요(워커 그림 기능 없음)'), { code: 'NO_WORKER' });
  const t0 = performance.now();
  await removeTiles(id, page);                                       // 예전 것(단계 수가 다를 수 있다)

  const w = new Worker(WORKER_URL);
  const jobId = ++seq;
  let plan = null, store = null, done = null, failed = null;
  let written = 0, bytes = 0, lastTick = 0, idleT = 0;
  const blank = [];                                                   // [z, idx]
  const queue = [];
  let writing = 0, settle, fail;
  const finished = new Promise((res, rej) => { settle = res; fail = rej; });

  const progress = (force = false) => {
    if (!onProgress || !plan) return;
    const now = performance.now();
    if (!force && now - lastTick < 100) return;                      // 100ms 에 한 번까지(화면 글 바꾸기)
    lastTick = now;
    try { onProgress({ done: written + blank.length, total: plan.total, tiles: written, bytes, format: plan.format }); } catch { /* 부른 쪽 오류 무시 */ }
  };
  const kill = err => {
    if (failed) return;
    failed = err;
    clearTimeout(idleT);
    try { w.terminate(); } catch { /* 이미 끝남 */ }
    fail(err);
  };
  const poke = () => { clearTimeout(idleT); idleT = setTimeout(() => kill(new Error('도면 타일 워커가 답하지 않아요')), IDLE_MS); };
  const pump = () => {
    while (!failed && writing < PUT_PAR && queue.length) {
      const t = queue.shift();
      writing++;
      photofs.put('doc', keyOf(id, page, t.z, t.x, t.y), t.blob).then(r => {
        store = store || r.store;
        written++; bytes += t.blob.size;
        w.postMessage({ op: 'ack', id: jobId, n: 1 });
        progress();
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
    if (m.op === 'plan') { plan = m; progress(true); }
    else if (m.op === 'tile') { queue.push(m); pump(); }
    else if (m.op === 'blank') { blank.push([m.z, m.y * plan.levels[m.z].cols + m.x]); progress(); }
    else if (m.op === 'done') { done = m; clearTimeout(idleT); check(); }
    else if (m.op === 'error') kill(Object.assign(new Error(m.error || '도면 타일을 만들지 못했어요'), { code: /메모리|memory/i.test(m.error) ? 'MEMORY' : 'BUILD' }));
  };
  w.onerror = e => { e.preventDefault?.(); kill(new Error(`도면 타일 워커 오류: ${e.message || '알 수 없음'}`)); };
  poke();
  w.postMessage({ op: 'build', id: jobId, blob, tileSize, format, q, maxPx, bg: BG });

  try {
    await finished;
  } catch (e) {
    signal?.removeEventListener('abort', onAbort);
    while (writing) await new Promise(r => setTimeout(r, 30));       // 쓰던 것이 끝난 뒤 치운다(지운 뒤 늦게 써지지 않게)
    await removeTiles(id, page).catch(() => {});
    throw e;
  }
  signal?.removeEventListener('abort', onAbort);
  try { w.terminate(); } catch { /* 끝남 */ }

  const levels = plan.levels.map((l, z) => ({ ...l, blank: blank.filter(b => b[0] === z).map(b => b[1]).sort((a, b) => a - b) }));
  const meta = {
    v: 1, drawingId: id, page, w: plan.w, h: plan.h, tileSize, levels, format: plan.format, bg: '#ffffff',
    store: store || null, bytes, tiles: written, blankTiles: blank.length, createdAt: Date.now(),
    srcW: plan.srcW, srcH: plan.srcH,                                 // 원본 그림 크기(maxPx 로 줄여 만들었으면 w·h 와 다르다)
  };
  const { store: ms } = await photofs.put('doc', metaKey(id, page), new Blob([JSON.stringify(meta)], { type: 'application/json' }));
  meta.metaStore = ms;
  metaCache.set(ck(id, page), Promise.resolve(withSets(meta)));
  progress(true);
  return { ...meta, ms: { ...done.ms, wall: Math.round(performance.now() - t0) }, sample: plan.sample };
}

// ---- 도면 쪽을 높은 해상도 그림으로 ----
// 뷰어 iframe(docFrame — 숨겨 둬도 된다: 화면 밖이 아니라 opacity 0 으로 화면 위에 두면 그리기가 멈추지 않는다)에 열린 도면을
// docsnap.snapshotFromFrame 으로 큰 배율로 다시 그린다(PDF: 같은 PDFDocumentProxy 로 그 쪽을 큰 배율로 가로 띠마다, DXF·DWG: CadView 를
// 우리 조각 캔버스에 다시 그림, 그림: 원본을 워커에서). 뷰어 사본은 고치지 않는다.
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
      while (api.page !== page && Date.now() - t < 3000) await new Promise(r => setTimeout(r, 50));
      await new Promise(r => setTimeout(r, 120));                     // 스크롤 자리 잡기
    }
  }
  const r = await snapshotFromFrame(iframeEl, { maxSide, hardMax: maxSide, maxPx, focusMin: 0, q, signal });
  if (r.unsupported) throw Object.assign(new Error(r.message), { code: 'LOADING', reason: r.reason });
  if (page && r.page !== page) throw Object.assign(new Error(`${page}쪽을 뜨지 못했어요(${r.page}쪽이 떠짐)`), { code: 'PAGE' });
  return detail ? r : r.blob;
}

// 시험용
export const _keys = { keyOf, metaKey };
export function _reset() { metaCache.clear(); releaseUrls(); workerOk = null; }
