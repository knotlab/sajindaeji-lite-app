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
export async function tileUrl(id, page, z, x, y) {
  const t = tilesMeta(id, page);
  const l = t?.levels?.[z];
  if (!l || z > (t.upto ?? -1) || !Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x >= l.cols || y >= l.rows) return null;
  if (l.blank?.length) {
    if (!l._b) Object.defineProperty(l, '_b', { value: new Set(l.blank), enumerable: false });
    if (l._b.has(y * l.cols + x)) return null;
  }
  return D.tileSrc(id, page, z, x, y).catch(() => null);
}
// livemap 이미지 모드 source — 쪽 크기를 정한 뒤부터(미리보기 단계) 보인다
export function tileSource(id, page = 1) {
  const pg = D.pageOf(id, page);
  if (!pg?.w || !pg?.h) return null;
  const t = pg.tiles;
  return {
    kind: 'image', w: pg.w, h: pg.h, tileSize: t?.tileSize || 512, levels: t?.levels?.length ? t.levels : null, upto: t?.upto ?? -1,
    tile: (z, x, y) => tileUrl(id, page, z, x, y),
    preview: pg.preview ? () => D.previewSrc(id, page).catch(() => null) : null,
    previewW: pg.preview?.w || 0, previewH: pg.preview?.h || 0, bg: '#ffffff',
    sig: `${pg.w}x${pg.h}|${t?.upto ?? -1}|${t?.ready ? 1 : 0}|${t?.at || 0}|${pg.preview ? 1 : 0}`,
  };
}
export function releaseUrls() { /* 주소는 data/drawings.js 가 400개까지 기억하고 넘치면 놓는다 */ }
// → 지운 타일 수(목록표 기준 — 빈 칸 빼고)
export async function removeTiles(id, page) {
  checkArgs(id, page);
  const t = tilesMeta(id, page);
  const n = t?.levels ? t.levels.reduce((s, l) => s + l.cols * l.rows - (l.blank?.length || 0), 0) : 0;
  localMeta.delete(`${id}:${page}`);
  await D.clearTiles(id, page);
  return n;
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

async function build(id, page, blob, { tileSize = 512, format = 'auto', q = 0.85, maxPx = sizeLimits().maxPx, maxSide = 0, previewMax = D.PREVIEW_MAX, onProgress, signal } = {}) {
  if (!blob || !(blob.size > 0)) throw Object.assign(new Error('도면 그림이 비어 있어요'), { code: 'EMPTY' });
  if (signal?.aborted) throw abortErr();
  if (!(await probeWorker())) throw Object.assign(new Error('이 기기에서는 도면 타일을 만들 수 없어요(워커 그림 기능 없음)'), { code: 'NO_WORKER' });
  const t0 = performance.now();
  const hasMeta = () => !!D.drawing(id);
  localMeta.delete(`${id}:${page}`);
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
      if ((s.reason === 'error' || s.reason === 'format') && s.name === name) throw Object.assign(new Error(s.reason === 'format' ? '이 파일은 도면으로 그릴 수 없어요' : '도면을 열지 못했어요'), { code: s.reason === 'format' ? 'FORMAT' : 'OPEN' });
      if (Date.now() - t0 > timeout) throw Object.assign(new Error('도면을 여는 데 너무 오래 걸려요(처음엔 인터넷 필요)'), { code: 'TIMEOUT' });
      await sleep(250);
    }
    await sleep(300);                                                  // 첫 그리기 자리 잡기
    return { iframe, close };
  } catch (e) { close(); throw e; }
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

const ERR_TEXT = { NOFILE: '원본 파일이 없어요', FORMAT: '이 파일은 도면으로 그릴 수 없어요', TIMEOUT: '여는 데 너무 오래 걸려요(처음엔 인터넷 필요)', NO_WORKER: '이 기기에서는 그림을 못 만들어요', MEMORY: '메모리가 모자라요', QUOTA: '저장 공간이 부족해요' };
export function queueDrawing(id, { page = 1, force = false } = {}) {
  const k = `${id}:${page}`;
  if (queued.has(k)) return jobs;
  queued.add(k);
  if (!states.get(id) || states.get(id).phase === 'error') setState(id, { phase: 'wait', pct: 0, page });
  const p = jobs.then(() => processOne(id, page, force)).then(() => setState(id, null), e => {
    console.warn('도면 그림을 못 만들었어요', id, e);
    setState(id, { phase: 'error', pct: 0, page, code: e?.code || 'ERROR', message: ERR_TEXT[e?.code] || '그림을 못 만들었어요' });
  }).finally(() => queued.delete(k));
  jobs = p.catch(() => {});
  return p;
}
export async function resumePending() {
  await D.ready();
  for (const d of D.drawings()) {
    if (d.missingFile || states.get(d.id)?.phase === 'error') continue;
    if (!d.pages.length) queueDrawing(d.id, { page: 1 });
    else for (const pg of d.pages) if (!pg.tiles?.ready || !pg.preview) queueDrawing(d.id, { page: pg.page });
  }
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
  const fr = await openHidden(blob, d.name);
  let r;
  try {
    await N.whenQuiet({ quietMs: 800, maxMs: 10000 });
    r = await renderPageLarge(fr.iframe, { page: d.kind === 'pdf' ? page : null, maxSide, maxPx: lim.maxPx, detail: true });
  } finally { fr.close(); }
  if (r.pages > 1 && D.drawing(id)?.pageCount !== r.pages) await D.updateDrawing(id, { pageCount: r.pages }).catch(() => {});
  setState(id, { phase: 'tiles', pct: 0, page });
  await buildTiles(id, page, r.blob, { maxSide, maxPx: lim.maxPx, onProgress });
}

// 시험용
export function _reset() { workerOk = null; states.clear(); queued.clear(); }
