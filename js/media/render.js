// 화면·내보내기용 그림(설계서 §5.4, R7) — 내보내기 JPEG 에는 워터마크를 굽고(exportSet·exportJpeg), 화면(썸네일·크게 보기)은 굽지 않고 띠만 겹친다(thumbSrc/viewSrc + paintBandDom/paintBand, v0.5).
// thumbURL·viewURL(구운 화면 그림)은 시험·예전 호출자용으로 남겨 둔다.
// 규칙(설계 비평 9·참고):
//  - 메인 스레드 canvas → JPEG 는 toDataURL(toBlob 은 A55 웹뷰에서 장당 4초). 내보내기 인코딩·줄이기는 워커(image.encodeJpegSet) — 메인은 그리기만.
//  - 캐시는 썸네일 LRU 300 + 크게 보기 LRU 10 으로 나눈다(1600px 300장이면 100MB 가 넘는다). 키에 워터마크 글자 해시가 들어가 위치·내용·설정을 고치면 자동으로 새 그림.
//  - WYSIWYG: 썸네일도 작업본(work) 크기로 계산한 layout 을 ctx.scale 로 줄여 그린다 — 작은 글꼴의 measureText 차이로 줄바꿈이 어긋나지 않게.
//  - 그리기는 동시에 2개까지.
// 돌려주는 주소는 이 모듈(또는 store)이 관리한다 — 호출자가 revokeObjectURL 하지 않는다.
import * as store from '../data/store.js';
import { wmOpts, watermarkLines, wmKey, watermarkLayout, drawWatermark, wmFont, WM_BAND_COLOR, WM_BAR_COLOR } from '../core/watermark.js';
import { IMG } from '../config.js';
import { decode, dims, canvasToJpeg, encodeJpegSet, workerState } from './image.js';

const THUMB_W = 480, THUMB_H = 360;                     // 썸네일 칸 4:3 (SPEC §6.4 「4:3 가로 칸으로 통일」)
const LETTERBOX = '#2B2F33';                            // 4:3 이 아닌 사진의 남는 칸(검정보다 한 단계 밝게 — 칸 경계가 보이게)
const VIEW_Q = 0.9;

// ---- 설정·키 ----
export function screenWatermark() {
  const s = store.settings();
  return s.wmMode !== 'off' && s.wmOnScreen !== false;
}
function linesOf(photo) {
  if (!photo) return [];
  const o = wmOpts(store.settings());
  const rec = store.record(photo.recordId) || { location: '', content: '' };
  return watermarkLines(rec, photo, o);
}
// kind: 'thumb'|'view' 는 화면 설정(screenWatermark), 'export' 는 wmMode 만. on 을 주면 그것을 따른다
function keyOf(photoId, kind, on) {
  const p = store.photo(photoId);
  if (on === undefined) on = kind === 'export' ? store.settings().wmMode !== 'off' : screenWatermark();
  const lines = on ? linesOf(p) : [];
  return { key: `${photoId}|${kind}|${lines.length ? wmKey(lines) : 'raw'}`, lines, photo: p };
}
export function cacheKey(photoId, kind) { return keyOf(photoId, kind).key; }

// ---- LRU ----
class Lru {
  constructor(max) { this.max = max; this.m = new Map(); }
  get(k) { const v = this.m.get(k); if (v) { this.m.delete(k); this.m.set(k, v); } return v; }
  set(k, v) {
    if (this.m.has(k)) this.drop(k);
    this.m.set(k, v);
    while (this.m.size > this.max) this.drop(this.m.keys().next().value);
  }
  drop(k) { const v = this.m.get(k); this.m.delete(k); if (v?.own) URL.revokeObjectURL(v.url); }
  clear() { for (const k of [...this.m.keys()]) this.drop(k); }
}
const thumbs = new Lru(300), views = new Lru(10);
const inflight = new Map();                             // key → Promise<string|null> (같은 그림을 두 번 그리지 않게)
export function clearCache() { thumbs.clear(); views.clear(); layouts.clear(); exportCacheClear(); }   // 시험·디버그용

// ---- 동시 2개 ----
let running = 0;
const waiters = [];
async function slot(fn) {
  while (running >= 2) await new Promise(r => waiters.push(r));
  running++;
  try { return await fn(); } finally { running--; waiters.shift()?.(); }
}

// ---- 글자 재기(공용 canvas 하나) ----
let mctx = null;
function measure(text, px, bold) {
  if (!mctx) mctx = document.createElement('canvas').getContext('2d');
  mctx.font = wmFont(px, bold);
  return mctx.measureText(text).width;
}

async function load(photoId, kind) {
  const b = await store.blob(photoId, kind);
  if (!b) return null;
  return decode(b);
}

// 작업본 크기(W,H)로 layout 을 계산 — 썸네일·작업본이 같은 줄바꿈
function layoutFor(photo, img, lines) {
  const d = dims(img);
  const W = photo?.w || d.w, H = photo?.h || d.h;
  return { W, H, L: watermarkLayout(W, H, lines, measure) };
}

// 썸네일 4:3 칸 그림 — 사진을 칸 안에 맞춰(contain) 넣고, 사진 영역에 워터마크
function drawThumb(img, photo, lines) {
  const { W, H, L } = layoutFor(photo, img, lines);
  const c = document.createElement('canvas');
  c.width = THUMB_W; c.height = THUMB_H;
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  const k = Math.min(THUMB_W / W, THUMB_H / H);
  const dw = W * k, dh = H * k;
  if (Math.abs(dw - THUMB_W) > 0.5 || Math.abs(dh - THUMB_H) > 0.5) { x.fillStyle = LETTERBOX; x.fillRect(0, 0, THUMB_W, THUMB_H); }
  x.save();
  x.translate((THUMB_W - dw) / 2, (THUMB_H - dh) / 2);
  x.scale(k, k);
  x.drawImage(img, 0, 0, W, H);
  drawWatermark(x, W, H, L);
  x.restore();
  return c;
}
function drawFull(img, photo, lines) {
  const { W, H, L } = layoutFor(photo, img, lines);
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  x.drawImage(img, 0, 0, W, H);
  drawWatermark(x, W, H, L);
  return c;
}
const toURL = (canvas, q) => URL.createObjectURL(new Blob([canvasToJpeg(canvas, q)], { type: 'image/jpeg' }));
const near43 = p => p?.w > 0 && p?.h > 0 && Math.abs(p.w / p.h - 4 / 3) < 0.02;

function cached(lru, key, make) {
  const hit = lru.get(key);
  if (hit) return Promise.resolve(hit.url);
  if (inflight.has(key)) return inflight.get(key);
  const p = (async () => {
    try {
      const v = await make();
      if (v) lru.set(key, v);
      return v?.url ?? null;
    } finally { inflight.delete(key); }
  })();
  inflight.set(key, p);
  return p;
}

// ---- 화면용 띠 겹치기(인코딩 없음) — 썸네일·크게 보기 ----
// 체감 속도(2026-10-21 현장 사용 「다 느림」): 화면용 그림마다 JPEG 를 다시 만들면(toDataURL 은 동기) 목록·뷰어가 그때마다 멈춘다.
// 화면에는 store 의 썸네일·작업본 주소를 <img> 로 그대로 띄우고, 워터마크 띠만 그 위 <canvas> 에 그린다.
// 띠는 작업본 크기(W×H)로 계산한 layout(같은 measure·같은 drawWatermark)을 표시 크기로 줄여 그린다 → 내보내기(exportJpeg)와 같은 줄바꿈·비례(WYSIWYG).
const layouts = new Map();                              // `${W}x${H}|${wmKey}` → layout (글자 재기는 같은 글이면 한 번만)
function layoutCached(W, H, lines) {
  const k = `${W}x${H}|${wmKey(lines)}`;
  let L = layouts.get(k);
  if (!L) {
    L = watermarkLayout(W, H, lines, measure);
    if (layouts.size > 600) layouts.delete(layouts.keys().next().value);
    layouts.set(k, L);
  }
  return L;
}

// 사진 하나의 화면 띠 정보 → { key, W, H, L } | null(화면 워터마크 꺼짐·글 없음).
// w,h: 사진 크기를 아직 모를 때(처리 중 미리보기) 그림 크기 — 긴 변을 작업본 크기로 맞춰 계산한다(작업본과 같은 줄바꿈)
export function wmFor(photoId, { on, w, h } = {}) {
  const p = store.photo(photoId);
  if (!p) return null;
  if (on === undefined) on = screenWatermark();
  if (!on) return null;
  const lines = linesOf(p);
  if (!lines.length) return null;
  let W = p.w, H = p.h;
  if (!(W > 0 && H > 0)) {
    if (!(w > 0 && h > 0)) return null;
    const k = IMG.workMax / Math.max(w, h);
    W = Math.round(w * k); H = Math.round(h * k);
  }
  const L = layoutCached(W, H, lines);
  if (!L.rows.length) return null;
  return { key: `${W}x${H}|${wmKey(lines)}`, W, H, L };
}

// 화면용 주소(인코딩 없음): 썸네일 = store 썸네일, 크게 보기 = store 작업본. 준비 안 된 사진이면 null
export function thumbSrc(photoId) {
  const p = store.photo(photoId);
  return p && p.state === 'ready' ? store.src(photoId, 'thumb') : Promise.resolve(null);
}
export function viewSrc(photoId) {
  const p = store.photo(photoId);
  return p && p.state === 'ready' ? store.src(photoId, 'work') : Promise.resolve(null);
}

// 칸(boxW×boxH, CSS px) 안에 사진이 object-fit(contain|cover)으로 놓였을 때 띠 자리(CSS px)
export function bandRect(boxW, boxH, wm, fit = 'contain') {
  const { W, H, L } = wm;
  const k = fit === 'cover' ? Math.max(boxW / W, boxH / H) : Math.min(boxW / W, boxH / H);
  const dw = W * k, dh = H * k;
  const bh = L.bandH * k;
  return { x: (boxW - dw) / 2, y: (boxH - dh) / 2 + dh - bh, w: dw, h: bh, k };
}

// canvas 를 띠 자리에 놓고 그린다. res:'screen' = 표시 크기×devicePixelRatio(썸네일), 'work' = 작업본 화소 그대로(크게 보기 — 확대해도 내보내기와 같은 화소).
// canvas 크기는 바뀔 때만 다시 잡는다(다시 잡기 = GPU 메모리 재할당). 그렸으면 true
export function paintBand(canvas, wm, boxW, boxH, { fit = 'contain', res = 'screen' } = {}) {
  if (!canvas) return false;
  if (!wm || !(boxW > 0) || !(boxH > 0)) { canvas.hidden = true; return false; }
  const r = bandRect(boxW, boxH, wm, fit);
  const dpr = Math.min(3, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
  const s = res === 'work' ? 1 : Math.min(1, (r.k * dpr));                // 화소/작업본 화소
  const cw = Math.max(1, Math.round(wm.W * s)), ch = Math.max(1, Math.round(wm.L.bandH * s));
  if (canvas.width !== cw) canvas.width = cw;
  if (canvas.height !== ch) canvas.height = ch;
  const st = canvas.style, px = v => `${Math.round(v * 100) / 100}px`;
  const want = [px(r.x), px(r.y), px(r.w), px(r.h)];
  if (st.left !== want[0]) st.left = want[0];
  if (st.top !== want[1]) st.top = want[1];
  if (st.width !== want[2]) st.width = want[2];
  if (st.height !== want[3]) st.height = want[3];
  const x = canvas.getContext('2d');
  if (!x) return false;
  x.setTransform(1, 0, 0, 1, 0, 0);
  x.clearRect(0, 0, cw, ch);
  x.setTransform(cw / wm.W, 0, 0, ch / wm.L.bandH, 0, 0);
  x.translate(0, -(wm.H - wm.L.bandH));
  drawWatermark(x, wm.W, wm.H, wm.L);
  canvas.hidden = false;
  return true;
}

// DOM 줄(line-height 가운데)과 canvas textBaseline:'middle'(글자 칸 가운데)의 기준선 차이(px) — 같은 높이에 글이 오게
function baselineShift(px, bold) {
  try {
    if (!mctx) mctx = document.createElement('canvas').getContext('2d');
    mctx.font = wmFont(px, bold);
    mctx.textBaseline = 'alphabetic';
    const m = mctx.measureText('가Ag');
    mctx.textBaseline = 'middle';
    const mid = mctx.measureText('가Ag').actualBoundingBoxAscent;
    mctx.textBaseline = 'alphabetic';
    const A = m.fontBoundingBoxAscent, D = m.fontBoundingBoxDescent, dMid = m.actualBoundingBoxAscent - mid;   // dMid: 가운데 선이 기준선보다 위인 만큼
    if (![A, D, dMid].every(Number.isFinite)) return 0;
    return (A - D) / 2 - dMid;
  } catch { return 0; }
}

// 목록 썸네일용 띠 — canvas 대신 DOM 글자. canvas 는 하나하나가 합성 레이어가 돼(크롬), 목록에 수십~수백 개면 스크롤마다 합성이 무거워졌다.
// 작업본 크기(W × bandH) 상자에 drawWatermark 와 같은 자리(띠·막대·줄)로 글을 놓고 transform: scale 로 줄인다 — 줄바꿈은 layout 이 정한 그대로(WYSIWYG).
// el 은 빈 div(호출자 소유). 글이 같으면 자식을 다시 만들지 않고 자리·배율만 고친다
export function paintBandDom(el, wm, boxW, boxH, { fit = 'contain' } = {}) {
  if (!el) return false;
  if (!wm || !(boxW > 0) || !(boxH > 0)) { el.hidden = true; return false; }
  const { W, L } = wm;
  if (el._wm !== wm.key) {
    el._wm = wm.key;
    const { bandH, pad, bar, rows, font, lineH } = L;
    const x = L.textX ?? pad + bar * 2;
    const box = (l, t, w, hh, bg) => { const d = document.createElement('i'); Object.assign(d.style, { position: 'absolute', left: `${l}px`, top: `${t}px`, width: `${w}px`, height: `${hh}px`, background: bg }); return d; };
    const kids = [box(pad, pad, bar, bandH - 2 * pad, WM_BAR_COLOR)];
    rows.forEach((r, i) => {
      const s = document.createElement('span');
      s.textContent = r.text;
      Object.assign(s.style, { position: 'absolute', left: `${x}px`, top: `${pad + lineH * i - baselineShift(font, r.bold)}px`, height: `${lineH}px`, lineHeight: `${lineH}px`, font: wmFont(font, r.bold), whiteSpace: 'pre', letterSpacing: '0', color: '#fff' });
      kids.push(s);
    });
    el.replaceChildren(...kids);
    Object.assign(el.style, { position: 'absolute', width: `${W}px`, height: `${bandH}px`, background: WM_BAND_COLOR, transformOrigin: '0 0', overflow: 'hidden', pointerEvents: 'none' });
  }
  const r = bandRect(boxW, boxH, wm, fit);
  const want = { left: `${Math.round(r.x * 100) / 100}px`, top: `${Math.round(r.y * 100) / 100}px`, transform: `scale(${Math.round(r.k * 1e5) / 1e5})` };
  for (const k of Object.keys(want)) if (el.style[k] !== want[k]) el.style[k] = want[k];
  el.hidden = false;
  return true;
}

// 썸네일 주소(4:3). 준비 안 된 사진이면 null. 워터마크가 없고 사진이 4:3 이면 store 주소를 그대로(그리기·인코딩 없이 빠르게)
// (화면 목록은 thumbSrc + paintBand 를 쓴다 — 이것은 시험·예전 호출자용)
export function thumbURL(photoId) {
  const { key, lines, photo } = keyOf(photoId, 'thumb');
  if (!photo || photo.state !== 'ready') return Promise.resolve(null);
  return cached(thumbs, key, async () => {
    if (!lines.length && near43(photo)) { const url = await store.src(photoId, 'thumb'); return url ? { url, own: false } : null; }
    return slot(async () => {
      const img = await load(photoId, 'thumb');
      if (!img) return null;
      try { return { url: toURL(drawThumb(img, photo, lines), IMG.thumbQ), own: true }; } finally { img.close?.(); }
    });
  });
}

// 크게 보기(work 크기). watermark 미지정이면 화면 설정대로
export function viewURL(photoId, { watermark } = {}) {
  const { key, lines, photo } = keyOf(photoId, 'view', watermark === undefined ? undefined : !!watermark);
  if (!photo || photo.state !== 'ready') return Promise.resolve(null);
  return cached(views, key, async () => {
    if (!lines.length) { const url = await store.src(photoId, 'work'); return url ? { url, own: false } : null; }
    return slot(async () => {
      const img = await load(photoId, 'work');
      if (!img) return null;
      try { return { url: toURL(drawFull(img, photo, lines), VIEW_Q), own: true }; } finally { img.close?.(); }
    });
  });
}

// ---- 내보내기 그림 한 벌(v0.1.7) — 한 번 풀고 한 번 굽고, 크기 여러 벌. 같은 그림이면 캐시 ----
// exportSet(photoId, { full, sheet, thumb }) → { key, full?: Blob, sheet?: Blob, thumb?: Blob } (요청한 것만, JPEG Blob)
//   full  : 작업본 크기에 워터마크를 구운 JPEG(q IMG.workQ) — 카톡·사진 파일. 워터마크가 꺼져 있으면 작업본 그대로(바이트 같음)
//   sheet : 긴 변 sheet px(사진대지 칸, q 0.85) · thumb : 긴 변 thumb px(대장 대표 사진, q 0.8) — 0 이면 만들지 않는다
//   워터마크는 full 에 한 번만 굽고 sheet·thumb 는 그 그림의 축소(WYSIWYG). 메인은 작업본을 풀어 띠를 그리기만 하고
//   (OffscreenCanvas → transferToImageBitmap — 복사 없음) 줄이기·인코딩은 워커(image.encodeJpegSet)가 한다.
//   캐시: 사진(id·크기·바이트)과 워터마크 글이 같으면 다시 만들지 않는다(최대 40장 — 기기 메모리가 작으면 20·10장, 바이트 상한도).
//   카톡 굽기(exportJpeg = full)가 남긴 full 에서 엑셀이 sheet·thumb 만 줄여 쓴다 — 워커가 그 JPEG 를 풀어 줄이므로 메인 일 0.
//   비우기 exportCacheClear() — 내보내기 탭을 오래 떠나거나 앱이 뒤로 갈 때(메모리)
//   keep: false — 캐시에 남기지 않는다(묶음 상세 [공유]·사진 저장 같은 한 번 쓰고 끝나는 굽기 — 비울 주인이 없어 세션 내내 남았다, 검토). 있는 것은 그대로 쓴다
const SET_Q = { sheet: 0.85, thumb: 0.8 };
const devMem = (() => { try { const m = Number(globalThis.navigator?.deviceMemory); return m > 0 ? m : 4; } catch { return 4; } })();
const SET_MAX = devMem >= 4 ? 40 : devMem >= 2 ? 20 : 10;
const SET_BYTES = (devMem >= 4 ? 64 : devMem >= 2 ? 32 : 16) * 1048576;
const sets = new Map();                                 // key → { full: Blob|null, fullOwn, sizes: Map<max, Blob>, bytes } — Map 순서 = 오래된 것 먼저(LRU)
const setJobs = new Map();                              // key → Promise(만드는 중 — 같은 그림을 두 번 굽지 않게)
const setStat = { hits: 0, bakes: 0, derives: 0, mainDraws: 0 };
let setBytes = 0;
export function exportCacheClear() { sets.clear(); setBytes = 0; }
export const exportCacheStats = () => ({ entries: sets.size, bytes: setBytes, max: SET_MAX, maxBytes: SET_BYTES, ...setStat });
function setGet(key) { const e = sets.get(key); if (e) { sets.delete(key); sets.set(key, e); } return e; }
function setPut(key, e) {
  const old = sets.get(key);
  if (old) { setBytes -= old.bytes; sets.delete(key); }
  e.bytes = (e.full && e.fullOwn ? e.full.size : 0) + [...e.sizes.values()].reduce((n, b) => n + (b?.size || 0), 0);   // 작업본 그대로(디스크 Blob)는 세지 않는다
  sets.set(key, e); setBytes += e.bytes;
  while (sets.size > 1 && (sets.size > SET_MAX || setBytes > SET_BYTES)) {
    const [k, v] = sets.entries().next().value;
    sets.delete(k); setBytes -= v.bytes;
  }
}
const hasAll = (e, want) => !!e && (!want.full || !!e.full) && (!want.sheet || e.sizes.has(want.sheet)) && (!want.thumb || e.sizes.has(want.thumb));
const pickSet = (key, e, want) => ({ key, ...(want.full ? { full: e.full } : {}), ...(want.sheet ? { sheet: e.sizes.get(want.sheet) } : {}), ...(want.thumb ? { thumb: e.sizes.get(want.thumb) } : {}) });

export async function exportSet(photoId, { full = true, sheet = 0, thumb = 0, keep = true } = {}) {
  const { lines, photo } = keyOf(photoId, 'export');
  const want = { full: !!full, sheet: sheet > 0 ? Math.round(sheet) : 0, thumb: thumb > 0 ? Math.round(thumb) : 0 };
  const key = `${photoId}|${photo?.w || 0}x${photo?.h || 0}|${photo?.bytes || 0}|${lines.length ? wmKey(lines) : 'raw'}`;
  if (!want.full && !want.sheet && !want.thumb) return { key };
  for (let round = 0; round < 4; round++) {
    const e = setGet(key);
    if (hasAll(e, want)) { setStat.hits++; return pickSet(key, e, want); }
    const busy = setJobs.get(key);
    if (busy) { await busy.catch(() => {}); continue; }           // 같은 그림을 만드는 중 — 끝나면 다시 본다(모자란 크기만 이어서)
    if (!keep) { const got = await makeSet(photoId, photo, lines, key, e, want, false); if (hasAll(got, want)) return pickSet(key, got, want); break; }
    const job = makeSet(photoId, photo, lines, key, e, want);
    setJobs.set(key, job);
    try { const got = await job; if (hasAll(got, want)) return pickSet(key, got, want); }
    finally { if (setJobs.get(key) === job) setJobs.delete(key); }
  }
  throw Object.assign(new Error('내보낼 그림을 만들지 못했어요'), { code: 'EXPORT_SET' });
}

async function workBlob(photoId) {
  const b = await store.blob(photoId, 'work');
  if (!b) throw Object.assign(new Error('사진 파일을 찾지 못했어요'), { code: 'NO_WORK' });
  return b;
}
async function makeSet(photoId, photo, lines, key, prev, want, keep = true) {
  const e = { full: prev?.full || null, fullOwn: !!prev?.fullOwn, sizes: new Map(prev?.sizes || []), bytes: 0 };
  const sizes = [];
  if (want.sheet && !e.sizes.has(want.sheet)) sizes.push({ max: want.sheet, q: SET_Q.sheet });
  if (want.thumb && !e.sizes.has(want.thumb) && want.thumb !== want.sheet) sizes.push({ max: want.thumb, q: SET_Q.thumb });
  const needFull = want.full && !e.full;
  const wh = { blobs: true, w0: photo?.w || 0, h0: photo?.h || 0 };
  const keepSizes = blobs => sizes.forEach((s, i) => e.sizes.set(s.max, blobs[i]));
  if (!lines.length) {                                  // 워터마크 없음 — full = 작업본 그대로, 줄이기는 워커가 작업본을 풀어서
    const work = await workBlob(photoId);
    if (needFull) { e.full = work; e.fullOwn = false; }
    if (sizes.length) { keepSizes(await encodeJpegSet(work, sizes, wh)); setStat.derives++; }
  } else if (!needFull && e.full) {                     // 구운 full 이 있다(카톡 굽기 등) — 워커가 그 JPEG 를 풀어 줄인다(메인 일 0)
    if (sizes.length) { keepSizes(await encodeJpegSet(e.full, sizes, wh)); setStat.derives++; }
  } else {                                              // 작업본을 풀어 한 번 굽고 크기 여러 벌
    const all = [...(needFull ? [{ max: 0, q: IMG.workQ }] : []), ...sizes];
    const out = await bake(photoId, photo, lines, all);
    if (needFull) { e.full = out[0]; e.fullOwn = true; }
    keepSizes(needFull ? out.slice(1) : out);
    setStat.bakes++;
  }
  if (keep) setPut(key, e);
  return e;
}
// 작업본 → 띠 구운 그림(메인: 디코드 기다림 + 그리기) → 크기마다 JPEG(워커). 워커가 넘긴 그림을 잃으면 DOM canvas 로 한 번 더(메인 경로)
async function bake(photoId, photo, lines, sizes) {
  const work = await workBlob(photoId);
  return slot(async () => {
    const img = await decode(work);
    try {
      const d = dims(img);
      const W = photo?.w || d.w, H = photo?.h || d.h;
      const L = layoutCached(W, H, lines);
      const bmp = bakeBitmap(img, W, H, L);
      setStat.mainDraws++;
      if (bmp) {
        try { return await encodeJpegSet(bmp, sizes, { blobs: true }); }
        catch (err) { if (workerState().forced === 'worker' || err?.code !== 'WORKER_LOST') throw err; console.warn('워커가 그림을 잃었어요 — 다시 그려 메인에서', err); }
      }
      const c = document.createElement('canvas');
      c.width = W; c.height = H;
      const x = c.getContext('2d');
      x.drawImage(img, 0, 0, W, H);
      drawWatermark(x, W, H, L);
      try { return await encodeJpegSet(c, sizes, { blobs: true }); }
      finally { c.width = 0; c.height = 0; }                                        // 큰 canvas 메모리를 바로 돌려준다
    } finally { img.close?.(); }
  });
}
// OffscreenCanvas 에 그려 ImageBitmap 으로 넘긴다(transferToImageBitmap — 픽셀 복사 없음). 워커를 못 쓰거나 OffscreenCanvas 가 없으면 null(DOM canvas 경로)
function bakeBitmap(img, W, H, L) {
  if (!workerState().usable || workerState().forced === 'main' || typeof OffscreenCanvas !== 'function') return null;
  let c;
  try { c = new OffscreenCanvas(W, H); } catch { return null; }
  const x = c.getContext('2d');
  if (!x || typeof c.transferToImageBitmap !== 'function') return null;
  x.drawImage(img, 0, 0, W, H);
  drawWatermark(x, W, H, L);
  return c.transferToImageBitmap();
}

// 내보내기·공유 JPEG(작업본 크기) — wmMode 가 off 면 작업본 bytes 그대로, 아니면 구운 것(q IMG.workQ). exportSet 의 full(캐시 공유).
//   keep: false 면 새로 구운 것은 캐시에 남기지 않는다(묶음 상세 [공유]·사진 저장 — 한번에 보내기 밖이라 비울 때가 없다)
export async function exportJpeg(photoId, { keep = true } = {}) {
  const s = await exportSet(photoId, { full: true, keep });
  return new Uint8Array(await s.full.arrayBuffer());
}

