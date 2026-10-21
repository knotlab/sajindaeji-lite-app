// 화면·내보내기용 그림 — 썸네일(4:3 칸)·크게 보기·내보내기 JPEG 에 워터마크를 굽는다(설계서 §5.4, R7)
// 규칙(설계 비평 9·참고):
//  - canvas → JPEG 는 전부 toDataURL → bytes → Blob(toBlob 은 A55 웹뷰에서 장당 4초).
//  - 캐시는 썸네일 LRU 300 + 크게 보기 LRU 10 으로 나눈다(1600px 300장이면 100MB 가 넘는다). 키에 워터마크 글자 해시가 들어가 위치·내용·설정을 고치면 자동으로 새 그림.
//  - WYSIWYG: 썸네일도 작업본(work) 크기로 계산한 layout 을 ctx.scale 로 줄여 그린다 — 작은 글꼴의 measureText 차이로 줄바꿈이 어긋나지 않게.
//  - 그리기는 동시에 2개까지.
// 돌려주는 주소는 이 모듈(또는 store)이 관리한다 — 호출자가 revokeObjectURL 하지 않는다.
import * as store from '../data/store.js';
import { wmOpts, watermarkLines, wmKey, watermarkLayout, drawWatermark, wmFont } from '../core/watermark.js';
import { IMG } from '../config.js';
import { decode, dims, canvasToJpeg } from './image.js';

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
export function clearCache() { thumbs.clear(); views.clear(); }   // 시험·디버그용

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

// 썸네일 주소(4:3). 준비 안 된 사진이면 null. 워터마크가 없고 사진이 4:3 이면 store 주소를 그대로(그리기·인코딩 없이 빠르게)
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

// 내보내기·공유 JPEG — wmMode 가 off 면 작업본 bytes 그대로, 아니면 작업본에 구워 q0.85
export async function exportJpeg(photoId) {
  const { lines, photo } = keyOf(photoId, 'export');
  const b = await store.blob(photoId, 'work');
  if (!b) throw Object.assign(new Error('사진 파일을 찾지 못했어요'), { code: 'NO_WORK' });
  const raw = new Uint8Array(await b.arrayBuffer());
  if (!lines.length) return raw;
  return slot(async () => {
    const img = await decode(raw);
    try { return canvasToJpeg(drawFull(img, photo, lines), IMG.workQ); } finally { img.close?.(); }
  });
}

