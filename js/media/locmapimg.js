// 위치도 그림 만들기 — 도면 스냅샷 + 번호 핀 + 제목 띠 + 범례 띠 → JPEG Blob(설계: docs/위치도-설계.md).
// 큰 그림(긴 변 최대 2400px)이라 디코드·그리기·JPEG 인코딩을 모듈 워커(이 파일 자신, OffscreenCanvas.convertToBlob)에서 한다 — 메인 스레드를 막지 않는다.
// 워커·OffscreenCanvas 가 없거나 두 번 실패하면 메인 경로: createImageBitmap → canvas → toDataURL(원본 규칙: 메인 toBlob 금지 — A55 장당 4초).
// 배치·그리기 규칙은 core/locmap.js 하나(워커와 메인이 같은 함수) — 미니 지도(DOM)·내보내기 그림이 같은 자리에 핀을 놓는다.
//
// 계약
//   renderLocMap({ snapBlob | snapUrl, w?, h?, pins, legend?, title?, sub?, maxSide?, q?, size? }) → Promise<Blob(image/jpeg)>
//     pins   = dayPins(...) 결과 또는 [{ n, label?, x, y }] (x·y 0~1, 스냅샷 기준)
//     legend = string[] (core/locmap legend(records)) — 없으면 범례 띠 없음
//     title  = 제목 한 줄(locMapTitle), sub = 둘째 줄(작게, 회색)
//     w, h   = 스냅샷 원래 크기(비율만 쓴다 — 안 주면 그림에서 읽음)
//   결과 Blob 에는 .lm = { w, h, via: 'worker'|'main', ms } 를 붙인다(측정·시험용)
import { locMapLayout, drawLocMap, lmFont } from '../core/locmap.js';

const IN_WORKER = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;   // eslint-disable-line no-undef

// ---------- 공통(워커·메인) ----------
function measurer(ctx) {
  const cache = new Map();
  return (text, px, bold) => {
    const f = lmFont(px, bold);
    if (ctx.font !== f) ctx.font = f;
    const k = `${f}|${text}`;
    let v = cache.get(k);
    if (v === undefined) { v = ctx.measureText(text).width; if (cache.size < 2000) cache.set(k, v); }
    return v;
  };
}
const optsOf = m => ({ pins: m.pins || [], legend: m.legend || null, title: m.title || '', sub: m.sub || '', maxSide: m.maxSide, minSide: m.minSide, size: m.size || 1 });

// ---------- 워커 쪽 ----------
if (IN_WORKER) {
  self.onmessage = async e => {
    const m = e.data || {};
    try {
      if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') throw Object.assign(new Error('OffscreenCanvas 없음'), { code: 'NO_OFFSCREEN' });
      if (m.op === 'ping') { const t = new OffscreenCanvas(2, 2); if (!t.getContext('2d') || typeof t.convertToBlob !== 'function') throw Object.assign(new Error('OffscreenCanvas 2d 없음'), { code: 'NO_OFFSCREEN' }); self.postMessage({ id: m.id, ok: true }); return; }
      if (m.op !== 'render') throw new Error(`모르는 작업: ${m.op}`);
      const t0 = performance.now();
      const bmp = await createImageBitmap(m.blob);
      try {
        const probe = new OffscreenCanvas(8, 8).getContext('2d');
        const L = locMapLayout({ w: m.w || bmp.width, h: m.h || bmp.height, ...optsOf(m) }, measurer(probe));
        const c = new OffscreenCanvas(L.W, L.H);
        drawLocMap(c.getContext('2d'), L, bmp);
        bmp.close();
        const blob = await c.convertToBlob({ type: 'image/jpeg', quality: m.q || 0.88 });
        if (!blob || !blob.size) throw Object.assign(new Error('JPEG 인코딩 실패(메모리 부족일 수 있어요)'), { code: 'ENCODE' });
        self.postMessage({ id: m.id, ok: true, blob, w: L.W, h: L.H, ms: Math.round(performance.now() - t0) });
      } finally { try { bmp.close(); } catch { /* 이미 닫힘 */ } }
    } catch (err) {
      self.postMessage({ id: m.id, ok: false, error: String(err?.message || err), code: err?.code || err?.name || '' });
    }
  };
}

// ---------- 메인 쪽 ----------
// 워커 하나를 띄워 두고 다시 쓴다. 20초 쉬면 닫는다(위치도는 내보낼 때 몇 장뿐)
let wk = null, seq = 0, off = false, fails = 0, idle = null, forced = null;
const calls = new Map();
const usable = () => !IN_WORKER && !off && typeof Worker === 'function' && typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function';
function kill(err) {
  clearTimeout(idle); idle = null;
  try { wk?.terminate(); } catch { /* 이미 닫힘 */ }
  wk = null;
  for (const c of calls.values()) { clearTimeout(c.t); c.rej(err); }
  calls.clear();
}
function get() {
  if (wk) return wk;
  wk = new Worker(new URL('./locmapimg.js', import.meta.url), { type: 'module' });
  wk.onmessage = e => {
    const d = e.data || {}, c = calls.get(d.id);
    if (!c) return;
    calls.delete(d.id); clearTimeout(c.t);
    if (d.ok) { fails = 0; c.res(d); }
    else { if (d.code === 'NO_OFFSCREEN') off = true; c.rej(Object.assign(new Error(d.error || '위치도 워커 실패'), { code: d.code || 'WORKER' })); }
    if (!calls.size) { clearTimeout(idle); idle = setTimeout(() => { if (!calls.size) kill(new Error('닫힘')); }, 20000); }
  };
  wk.onerror = e => {
    e?.preventDefault?.();
    if (++fails >= 2) off = true;                                         // 모듈 워커를 못 띄우는 옛 웹뷰 — 더 띄우지 않는다
    kill(Object.assign(new Error(`위치도 워커 오류 ${e?.message || ''}`), { code: 'WORKER' }));
  };
  return wk;
}
function call(msg, ms = 45000) {
  return new Promise((res, rej) => {
    const w = get(), id = ++seq;
    clearTimeout(idle); idle = null;
    const t = setTimeout(() => { fails++; kill(Object.assign(new Error('위치도 워커 시간 초과'), { code: 'WORKER_TIMEOUT' })); }, ms);
    calls.set(id, { res, rej, t });
    w.postMessage({ ...msg, id });
  });
}

async function srcBlob({ snapBlob, snapUrl }) {
  if (snapBlob instanceof Blob) return snapBlob;
  if (snapBlob instanceof Uint8Array || snapBlob instanceof ArrayBuffer) return new Blob([snapBlob], { type: 'image/jpeg' });
  if (snapUrl) { const r = await fetch(snapUrl); if (!r.ok) throw Object.assign(new Error('도면 그림을 못 읽었어요'), { code: 'NO_SNAP' }); return r.blob(); }
  throw Object.assign(new Error('도면 그림이 없어요'), { code: 'NO_SNAP' });
}

async function decodeMain(blob) {
  try { return await createImageBitmap(blob); }
  catch {
    const url = URL.createObjectURL(blob);
    try { const img = new Image(); img.src = url; await img.decode(); return img; } finally { URL.revokeObjectURL(url); }
  }
}
function b64ToBlob(dataUrl) {
  const i = dataUrl.indexOf(','), s = atob(i > 0 ? dataUrl.slice(i + 1) : '');
  if (!s.length) throw Object.assign(new Error('JPEG 인코딩 실패(메모리 부족일 수 있어요)'), { code: 'ENCODE' });
  const u = new Uint8Array(s.length);
  for (let k = 0; k < s.length; k++) u[k] = s.charCodeAt(k);
  return new Blob([u], { type: 'image/jpeg' });
}
async function renderMain(blob, m) {
  const t0 = performance.now();
  const img = await decodeMain(blob);
  try {
    const iw = img.naturalWidth || img.width, ih = img.naturalHeight || img.height;
    const probe = document.createElement('canvas').getContext('2d');
    const L = locMapLayout({ w: m.w || iw, h: m.h || ih, ...optsOf(m) }, measurer(probe));
    const c = document.createElement('canvas');
    c.width = L.W; c.height = L.H;
    drawLocMap(c.getContext('2d'), L, img);
    const out = b64ToBlob(c.toDataURL('image/jpeg', m.q || 0.88));       // toBlob 금지(원본 규칙)
    c.width = c.height = 0;
    return { blob: out, w: L.W, h: L.H, ms: Math.round(performance.now() - t0) };
  } finally { img.close?.(); }
}

export async function renderLocMap(opts = {}) {
  if (IN_WORKER) throw new Error('워커 안에서는 부르지 않아요');
  const blob = await srcBlob(opts);
  const msg = { blob, w: opts.w || 0, h: opts.h || 0, pins: (opts.pins || []).map(p => ({ n: p.n, label: p.label, x: p.x, y: p.y, id: p.id ?? null })), legend: opts.legend || null, title: opts.title || '', sub: opts.sub || '', maxSide: opts.maxSide, minSide: opts.minSide, q: opts.q, size: opts.size };
  if (forced !== 'main' && usable()) {
    try {
      const r = await call({ op: 'render', ...msg });
      return Object.assign(r.blob, { lm: { w: r.w, h: r.h, via: 'worker', ms: r.ms } });
    } catch (e) {
      if (forced === 'worker') throw e;
      console.warn('위치도 워커 실패 — 메인 스레드로 해요', e);
    }
  }
  const r = await renderMain(blob, msg);
  return Object.assign(r.blob, { lm: { w: r.w, h: r.h, via: 'main', ms: r.ms } });
}

// 시험·측정용
export function _forcePath(p) { forced = p || null; }
export const locMapState = () => ({ usable: usable(), off, running: !!wk, forced });
