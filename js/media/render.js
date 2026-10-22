// 화면·내보내기용 그림(설계서 §5.4, R7) — 내보내기 JPEG 에는 워터마크를 굽고(exportJpeg), 화면(썸네일·크게 보기)은 굽지 않고 띠만 겹친다(thumbSrc/viewSrc + paintBandDom/paintBand, v0.5).
// thumbURL·viewURL(구운 화면 그림)은 시험·예전 호출자용으로 남겨 둔다.
// 규칙(설계 비평 9·참고):
//  - canvas → JPEG 는 전부 toDataURL → bytes → Blob(toBlob 은 A55 웹뷰에서 장당 4초).
//  - 캐시는 썸네일 LRU 300 + 크게 보기 LRU 10 으로 나눈다(1600px 300장이면 100MB 가 넘는다). 키에 워터마크 글자 해시가 들어가 위치·내용·설정을 고치면 자동으로 새 그림.
//  - WYSIWYG: 썸네일도 작업본(work) 크기로 계산한 layout 을 ctx.scale 로 줄여 그린다 — 작은 글꼴의 measureText 차이로 줄바꿈이 어긋나지 않게.
//  - 그리기는 동시에 2개까지.
// 돌려주는 주소는 이 모듈(또는 store)이 관리한다 — 호출자가 revokeObjectURL 하지 않는다.
import * as store from '../data/store.js';
import { wmOpts, watermarkLines, wmKey, watermarkLayout, drawWatermark, wmFont, WM_BAND_COLOR, WM_BAR_COLOR } from '../core/watermark.js';
import { IMG } from '../config.js';
import { decode, dims, canvasToJpeg, encodeJpegFast } from './image.js';

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
export function clearCache() { thumbs.clear(); views.clear(); layouts.clear(); }   // 시험·디버그용

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

// 내보내기·공유 JPEG — wmMode 가 off 면 작업본 bytes 그대로, 아니면 작업본에 구워 q0.85(그리기는 메인, 인코딩은 워커 — image.encodeJpegFast)
export async function exportJpeg(photoId) {
  const { lines, photo } = keyOf(photoId, 'export');
  const b = await store.blob(photoId, 'work');
  if (!b) throw Object.assign(new Error('사진 파일을 찾지 못했어요'), { code: 'NO_WORK' });
  const raw = new Uint8Array(await b.arrayBuffer());
  if (!lines.length) return raw;
  return slot(async () => {
    const img = await decode(raw);
    let c = null;
    try { c = drawFull(img, photo, lines); img.close?.(); return await encodeJpegFast(c, IMG.workQ); }
    finally { img.close?.(); if (c) { c.width = 0; c.height = 0; } }               // 큰 canvas 메모리를 바로 돌려준다
  });
}

