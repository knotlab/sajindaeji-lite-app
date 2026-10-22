// 이미지 처리 — 디코드·축소·회전·자르기·JPEG 인코딩·EXIF 촬영 시각(설계서 §4.3·§5.4, 원본 image.js 이식)
// 무거운 처리(작업본·썸네일·갤러리 원본)는 Web Worker(imgworker.js, OffscreenCanvas.convertToBlob)에서 — 메인 스레드는 기다리기만 한다
//   (2026-10-21 현장 "다 느림": 12MP 디코드·toDataURL 이 메인 스레드를 0.5초 넘게 막아 글 입력·화면이 끊겼다).
//   워커·OffscreenCanvas 가 없거나 실패하면 예전 경로(메인 스레드 toDataURL)로.
//   셔터 프레임(frameJpegs, 2026-10-22)도 워커에서 — 메인 스레드는 ImageBitmap 을 넘기기만 한다(인코딩 0).
// 메인 스레드에서는 toBlob 을 쓰지 않는다: 갤럭시 A55 웹뷰에서 장당 약 4초, toDataURL 은 약 0.1초(공시체 util.js 실측 — 되돌리지 말 것)
// 워터마크 그리기는 옮기지 않았다 — core/watermark.js 가 맡는다
import { IMG } from '../config.js';

export function b64ToBytes(b64) { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
export function bytesToB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000)); return btoa(s); }

// 중간에 끊긴 JPEG(저장 공간 부족·SD 빠짐·끊긴 복사)는 크롬이 남은 부분을 회색으로 채워 그려 버린다 — 반쯤 빈 사진이 「준비됨」이 되지 않게 막는다.
// 본 그림의 SOS 뒤에 EOI(FFD9)가 있는지 본다. EOI 뒤에 붙은 꼬리(삼성 동영상 사진 등)는 괜찮고, 머리 모양이 낯설면 판단하지 않는다(true).
export function jpegComplete(u8) {
  if (!u8 || u8.length < 4 || u8[0] !== 0xFF || u8[1] !== 0xD8) return true;
  let i = 2;
  while (i + 1 < u8.length) {
    if (u8[i] !== 0xFF) return true;                              // 낯선 머리 — 판단하지 않는다
    const m = u8[i + 1];
    if (m === 0xFF) { i++; continue; }                            // 채움 바이트
    if (m === 0xD9) return false;                                 // 그림 없이 끝남
    if ((m >= 0xD0 && m <= 0xD7) || m === 0x01) { i += 2; continue; }
    if (i + 3 >= u8.length) return false;                         // 머리 중간에서 끊김
    const len = (u8[i + 2] << 8) | u8[i + 3];
    if (m === 0xDA) {                                             // 압축 자료에는 FF D9 가 나오지 않는다(FF 는 FF 00 으로 채운다)
      // 끝에서부터 찾는다(보통 마지막 2바이트가 EOI — 수 MB 를 앞에서부터 훑지 않게). 「SOS 뒤 어딘가에 EOI」와 같은 판정
      for (let k = u8.length - 2, lo = i + 2 + len; k >= lo; k--) if (u8[k] === 0xFF && u8[k + 1] === 0xD9) return true;
      return false;
    }
    i += 2 + len;
  }
  return false;                                                   // 그림 자료 전에 끝남
}

// JPEG 머리에서 크기·EXIF 방향 → { w, h, orientation } (w,h 는 방향을 적용한 뒤 크기) | null. 앞부분(약 256KB)만 넘겨도 된다.
// 셔터 때 크기를 알려고 12MP 를 통째로 디코드하지 않게(설계 비평 7)
export function jpegInfo(u8) {
  try {
    if (u8 instanceof ArrayBuffer) u8 = new Uint8Array(u8);
    if (!u8 || u8.length < 4 || u8[0] !== 0xFF || u8[1] !== 0xD8) return null;
    let i = 2, orientation = 1;
    while (i + 9 < u8.length) {
      if (u8[i] !== 0xFF) return null;
      const m = u8[i + 1];
      if (m === 0xFF) { i++; continue; }
      if ((m >= 0xD0 && m <= 0xD7) || m === 0x01) { i += 2; continue; }
      const len = (u8[i + 2] << 8) | u8[i + 3];
      if (m === 0xDA || m === 0xD9) return null;
      if (m === 0xE1 && u8[i + 4] === 0x45 && u8[i + 5] === 0x78 && u8[i + 6] === 0x69 && u8[i + 7] === 0x66) orientation = tiffOrientation(u8, i + 10, len - 8) || 1;
      if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
        const h = (u8[i + 5] << 8) | u8[i + 6], w = (u8[i + 7] << 8) | u8[i + 8];
        if (!w || !h) return null;
        return orientation >= 5 && orientation <= 8 ? { w: h, h: w, orientation } : { w, h, orientation };
      }
      i += 2 + len;
    }
  } catch { /* 깨진 머리 */ }
  return null;
}
function tiffOrientation(u8, t, size) {
  try {
    const dv = new DataView(u8.buffer, u8.byteOffset + t, Math.min(size, u8.length - t));
    const le = dv.getUint16(0) === 0x4949;
    if (dv.getUint16(2, le) !== 42) return 0;
    const off = dv.getUint32(4, le), n = dv.getUint16(off, le);
    for (let k = 0; k < n; k++) { const e = off + 2 + k * 12; if (dv.getUint16(e, le) === 0x0112) return dv.getUint16(e + 8, le); }
  } catch { /* 없음 */ }
  return 0;
}
const HEAD = 256 * 1024;
async function headOf(input) {
  if (input instanceof Uint8Array) return input.subarray(0, HEAD);
  if (input instanceof ArrayBuffer) return new Uint8Array(input, 0, Math.min(HEAD, input.byteLength));
  if (input instanceof Blob) return new Uint8Array(await input.slice(0, HEAD).arrayBuffer());
  return null;
}
// Blob 이든 bytes 든 → { w, h, orientation } | null
export async function jpegInfoOf(input) { try { return jpegInfo(await headOf(input)); } catch { return null; } }

export async function decode(input) {
  if (input instanceof ArrayBuffer) input = new Uint8Array(input);
  if (input instanceof Uint8Array && !jpegComplete(input)) throw new Error('JPEG 가 중간에 끊겼어요(파일이 덜 써짐)');
  const blob = input instanceof Blob ? input : typeof input === 'string' ? await (await fetch(input)).blob() : new Blob([input], { type: 'image/jpeg' });
  try { return await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
  catch {
    const url = URL.createObjectURL(blob);
    try { const img = new Image(); img.src = url; await img.decode(); return img; } finally { URL.revokeObjectURL(url); }
  }
}
export const dims = img => ({ w: img.naturalWidth || img.videoWidth || img.width, h: img.naturalHeight || img.videoHeight || img.height });

// 가운데 기준, 비율 aspect(가로/세로)인 가장 큰 직사각형 — 순수 함수
export function cropRect(W, H, aspect) {
  if (!(aspect > 0) || !(W > 0) || !(H > 0)) return { x: 0, y: 0, w: W, h: H };
  let w = W, h = W / aspect;
  if (h > H) { h = H; w = H * aspect; }
  w = Math.min(W, Math.round(w)); h = Math.min(H, Math.round(h));
  return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h };
}

// 변환 그리기 — ① 시계 방향 quarterTurns×90° 회전 → ② (aspect 가 있으면) 돌린 그림 가운데에서 aspect 비율로 자르기 → ③ 긴 변 maxSide 로 축소.
// 자르기를 회전 뒤 공간에서 하는 이유: 가운데 자르기는 회전에 대해 대칭이라, 화면 좌표의 screenAspect 상자 = 돌린 그림의 세계 비율 r 상자(camera.js)
export function transformCanvas(src, { turns = 0, aspect = null, maxSide = Infinity } = {}) {
  const k = ((turns % 4) + 4) % 4;
  const { w: W, h: H } = dims(src);
  const RW = k % 2 ? H : W, RH = k % 2 ? W : H;
  const c0 = aspect ? cropRect(RW, RH, aspect) : { x: 0, y: 0, w: RW, h: RH };
  const s = Math.min(1, maxSide / Math.max(c0.w, c0.h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(c0.w * s)); c.height = Math.max(1, Math.round(c0.h * s));
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.scale(c.width / c0.w, c.height / c0.h);
  x.translate(-c0.x, -c0.y);
  x.translate(RW / 2, RH / 2);
  x.rotate(k * Math.PI / 2);
  x.drawImage(src, -W / 2, -H / 2, W, H);
  return c;
}

// 시계 방향 quarterTurns×90° 돌린 새 canvas(SPEC §5.4 추가 함수)
export const rotateCanvas = (source, quarterTurns) => transformCanvas(source, { turns: quarterTurns });

function draw(img, maxSide) { return transformCanvas(img, { maxSide }); }

export function toJpegBase64(canvas, q) {
  const url = canvas.toDataURL('image/jpeg', q), i = url.indexOf(',');
  const b64 = i > 0 ? url.slice(i + 1) : '';
  if (!b64) throw new Error('JPEG 인코딩 실패(빈 결과 — 메모리 부족일 수 있어요)');   // 0바이트 작업본을 「준비됨」으로 쓰지 않게
  return b64;
}
// canvas → JPEG bytes / Blob (toDataURL 경로 — toBlob 금지)
export const canvasToJpeg = (canvas, q) => b64ToBytes(toJpegBase64(canvas, q));
export const canvasToBlob = (canvas, q) => new Blob([canvasToJpeg(canvas, q)], { type: 'image/jpeg' });

export async function resize(input, maxSide, q) {
  const img = await decode(input);
  try { const c = draw(img, maxSide); return { base64: toJpegBase64(c, q), w: c.width, h: c.height }; } finally { img.close?.(); }
}

// 작업본(긴 변 1600, q0.85) + 썸네일(긴 변 480, q0.8). turns·aspect 를 주면 회전·가운데 자르기까지(camera.shoot 의 takePhoto 결과).
// 썸네일은 작업본 canvas 에서 줄인다(12MP 를 두 번 그리지 않게)
export async function makeWorkAndThumb(input, { turns = 0, aspect = null } = {}) {
  const img = await decode(input);
  let work;
  try { work = transformCanvas(img, { turns, aspect, maxSide: IMG.workMax }); } finally { img.close?.(); }
  const thumb = draw(work, IMG.thumbMax);
  return { work: { base64: toJpegBase64(work, IMG.workQ), w: work.width, h: work.height }, thumb: { base64: toJpegBase64(thumb, IMG.thumbQ), w: thumb.width, h: thumb.height } };
}
export async function shrinkForSheet(u8) {
  try { const r = await resize(u8, 1000, 0.8); const out = b64ToBytes(r.base64); return out.length < u8.length ? out : u8; }
  catch { return u8; }
}

// ---- Web Worker(imgworker.js) ----
// 하나를 띄워 두고 다시 쓴다(띄우는 데 수십 ms). 30초 쉬면 닫아 메모리를 돌려준다.
// 워커가 안 뜨거나(옛 웹뷰·스크립트 못 받음) OffscreenCanvas 가 없으면 두 번째 실패부터는 메인 스레드 경로만 쓴다.
let wk = null, wkSeq = 0, wkOff = false, wkFails = 0, wkIdle = null;
const wkCalls = new Map();
const workerUsable = () => !wkOff && typeof Worker === 'function' && typeof OffscreenCanvas === 'function' && typeof createImageBitmap === 'function';
function wkKill(err) {
  clearTimeout(wkIdle); wkIdle = null;
  try { wk?.terminate(); } catch { /* 이미 닫힘 */ }
  wk = null;
  for (const c of wkCalls.values()) { clearTimeout(c.t); c.rej(err); }
  wkCalls.clear();
}
function wkGet() {
  if (wk) return wk;
  wk = new Worker(new URL('./imgworker.js', import.meta.url));
  wk.onmessage = e => {
    const d = e.data || {}, c = wkCalls.get(d.id);
    if (!c) return;
    if (d.part) { try { c.onPart?.(d); } catch (err) { console.error(err); } return; }   // 중간 조각(frame 의 미리보기·원본) — 끝 응답은 아직
    wkCalls.delete(d.id); clearTimeout(c.t);
    if (d.ok) { wkFails = 0; c.res(d); }
    else {
      if (d.code === 'NO_OFFSCREEN') wkOff = true;
      c.rej(Object.assign(new Error(d.error || '워커 처리 실패'), { code: d.code || 'WORKER' }));
    }
    if (!wkCalls.size) { clearTimeout(wkIdle); wkIdle = setTimeout(() => { if (!wkCalls.size) wkKill(new Error('닫힘')); }, 30000); }
  };
  wk.onerror = e => {
    e?.preventDefault?.();
    if (++wkFails >= 2) wkOff = true;                                       // 스크립트를 못 받는 환경 — 더 띄우지 않는다
    wkKill(Object.assign(new Error(`워커 오류 ${e?.message || ''}`), { code: 'WORKER' }));
  };
  return wk;
}
// transfer: 넘길 것(ImageBitmap 등 — 복사 없이 옮긴다), onPart(d): 끝 응답 전에 오는 조각
function wkCall(msg, ms = 60000, { transfer = [], onPart = null } = {}) {
  return new Promise((res, rej) => {
    const w = wkGet(), id = ++wkSeq;
    clearTimeout(wkIdle); wkIdle = null;
    const t = setTimeout(() => { wkFails++; wkKill(Object.assign(new Error('워커 시간 초과'), { code: 'WORKER_TIMEOUT' })); }, ms);
    wkCalls.set(id, { res, rej, t, onPart });
    try { w.postMessage({ ...msg, id }, transfer); }
    catch (e) { wkCalls.delete(id); clearTimeout(t); rej(Object.assign(e instanceof Error ? e : new Error(String(e)), { code: 'WORKER_POST' })); }   // 넘길 수 없는 것(오래된 웹뷰의 VideoFrame 등) — 워커는 그대로
  });
}
const asBlob = input => (input instanceof Blob ? input : new Blob([input instanceof ArrayBuffer ? new Uint8Array(input) : input], { type: 'image/jpeg' }));
// 시험·측정용: 'worker' | 'main' 강제(null 이면 자동)
let forced = null;
export function _forcePath(p) { forced = p || null; }
export const workerState = () => ({ usable: workerUsable(), off: wkOff, running: !!wk, forced });

// 작업본·썸네일을 Blob 으로 → { work: { blob, w, h }, thumb: { blob, w, h }, via: 'worker'|'main', ms }
// makeWorkAndThumb 와 같은 그림·같은 크기. 워커가 실패하면 메인 스레드 경로로 한 번 더
export async function makeWorkAndThumbFast(input, { turns = 0, aspect = null } = {}) {
  if (input instanceof ArrayBuffer) input = new Uint8Array(input);
  if (input instanceof Uint8Array && !jpegComplete(input)) throw new Error('JPEG 가 중간에 끊겼어요(파일이 덜 써짐)');
  const t0 = performance.now();
  if (forced !== 'main' && workerUsable()) {
    try {
      const info = await jpegInfoOf(input);
      const r = await wkCall({ op: 'work', blob: asBlob(input), w0: info?.w || 0, h0: info?.h || 0, turns, aspect, workMax: IMG.workMax, workQ: IMG.workQ, thumbMax: IMG.thumbMax, thumbQ: IMG.thumbQ });
      return { work: { blob: r.work, w: r.w, h: r.h }, thumb: { blob: r.thumb, w: r.tw, h: r.th }, via: 'worker', ms: Math.round(performance.now() - t0) };
    } catch (e) {
      if (forced === 'worker') throw e;
      console.warn('워커 처리 실패 — 메인 스레드로 해요', e);
    }
  }
  const m = await makeWorkAndThumb(input, { turns, aspect });
  const jb = b64 => new Blob([b64ToBytes(b64)], { type: 'image/jpeg' });
  return { work: { blob: jb(m.work.base64), w: m.work.w, h: m.work.h }, thumb: { blob: jb(m.thumb.base64), w: m.thumb.w, h: m.thumb.h }, via: 'main', ms: Math.round(performance.now() - t0) };
}

// 풀 해상도 회전·자르기(갤러리 원본, q0.92) → Blob. xform 이 없으면 입력 그대로
export async function transformFull(input, { turns = 0, aspect = null } = {}, q = 0.92) {
  if (!((turns % 4) || aspect)) return asBlob(input);
  if (forced !== 'main' && workerUsable()) {
    try { return (await wkCall({ op: 'full', blob: asBlob(input), turns, aspect, q }, 90000)).blob; }
    catch (e) { if (forced === 'worker') throw e; console.warn('워커 원본 회전 실패 — 메인 스레드로 해요', e); }
  }
  const img = await decode(input);
  try { return canvasToBlob(transformCanvas(img, { turns, aspect }), q); } finally { img.close?.(); }
}

// 셔터 프레임(ImageBitmap — 워커로 넘어가 닫힌다) → 워커가 미리보기 → 원본(q) → 작업본·썸네일을 차례로(메인 스레드 인코딩 0).
// → { preview: Promise<Blob|null>, full: Promise<{ blob, w, h }>, prepared: Promise<{ work:{blob,w,h}, thumb:{blob,w,h}, via:'worker', ms }> }
//   full 은 원본이 나오는 즉시(작업본을 기다리지 않음 — 「찍은 즉시 디스크」), prepared 는 pipeline 이 다시 디코드하지 않고 쓴다.
// 워커를 못 쓰면 null(호출자가 메인 스레드 경로로). 워커가 도중에 실패하면 full 이 거부된다(프레임은 이미 넘어갔다 — 호출자가 다시 잡는다)
export const frameWorkerReady = () => forced !== 'main' && workerUsable();   // camera 가 VideoFrame(워커 전용)을 잡아도 되나
// bitmap: ImageBitmap 또는 VideoFrame(넘겨받아 워커가 닫는다)
export function frameJpegs(bitmap, { turns = 0, aspect = null, q = 0.92, pvMax = 320, pvQ = 0.7 } = {}) {
  if (forced === 'main' || !workerUsable() || !bitmap) return null;
  let pvRes, fullRes, fullRej;
  const preview = new Promise(r => { pvRes = r; });
  const full = new Promise((r, j) => { fullRes = r; fullRej = j; });
  const t0 = performance.now();
  const done = wkCall({ op: 'frame', bitmap, turns, aspect, q, pvMax, pvQ, workMax: IMG.workMax, workQ: IMG.workQ, thumbMax: IMG.thumbMax, thumbQ: IMG.thumbQ }, 60000, {
    transfer: [bitmap],
    onPart: d => { if (d.part === 'preview') pvRes(d.blob || null); else if (d.part === 'full') fullRes({ blob: d.blob, w: d.w, h: d.h }); },
  });
  done.then(() => { pvRes(null); fullRej(new Error('원본 조각이 오지 않았어요')); }, e => { pvRes(null); fullRej(e); });   // 이미 받았으면 아무 일 없음
  const prepared = done.then(r => ({ work: { blob: r.work, w: r.w, h: r.h }, thumb: { blob: r.thumb, w: r.tw, h: r.th }, via: 'worker', ms: Math.round(performance.now() - t0) }));
  prepared.catch(() => {});                                                // 안 쓰고 버려도 처리 안 된 거부가 되지 않게
  full.catch(() => {});
  return { preview, full, prepared };
}

// 다 그린 canvas → JPEG bytes. 워커가 되면 그림만 넘겨(createImageBitmap — 복사, 메인 수 ms) 워커가 인코딩한다
//   (내보내기·카톡 보내기 굽기: 메인 toDataURL 이 1920×1440 장당 60~70ms, 4배 늦춘 폰 약 250ms 화면을 막았다 — v0.1.5 검토).
//   워커가 없거나 실패하면 예전 경로(메인 toDataURL — toBlob 금지 규칙 그대로)
export async function encodeJpegFast(canvas, q) {
  const [u] = await encodeJpegSet(canvas, [{ max: 0, q }]);
  return u;
}

// 그림 하나 → 크기 여러 벌 JPEG(v0.1.7 내보내기 — 사진대지 칸 1000px·대장 480px 줄이기를 메인 toDataURL 에서 워커로).
//   src  : ImageBitmap(워커로 넘긴다 — 닫힌다) · canvas · OffscreenCanvas(복사해 넘김) · Blob·Uint8Array·ArrayBuffer(JPEG — 워커가 푼다, 메인 일 0)
//   sizes: [{ max, q }] — max 0(또는 없음) = 원래 크기, 원래보다 키우지 않는다. 결과는 sizes 순서
//   opts : blobs(true 면 Blob[] — 캐시·다른 워커로 넘길 때 메모리를 덜 쓴다. 기본 Uint8Array[]), w0·h0(JPEG 원래 크기 — 주면 머리를 읽지 않는다)
//   JPEG 입력에서 원래 크기 그대로인 칸은 다시 인코딩하지 않는다(받은 바이트 그대로 — 워터마크 없는 작업본 = 바이트 같음).
//   워커가 없거나 실패하면 메인(toDataURL — toBlob 금지 규칙 그대로). 넘겨준 ImageBitmap 이 워커에서 실패해 사라졌으면 code 'WORKER_LOST'(호출자가 다시 그린다)
export async function encodeJpegSet(src, sizes, { blobs = false, w0 = 0, h0 = 0 } = {}) {
  const list = (Array.isArray(sizes) ? sizes : []).map(s => ({ max: s?.max > 0 ? Math.round(s.max) : 0, q: s?.q > 0 && s.q <= 1 ? s.q : IMG.workQ }));
  if (!list.length) return [];
  const jpegIn = src instanceof Blob || src instanceof Uint8Array || src instanceof ArrayBuffer;
  const isBmp = !jpegIn && typeof ImageBitmap === 'function' && src instanceof ImageBitmap;
  const done = async out => (blobs ? out : Promise.all(out.map(async b => new Uint8Array(await b.arrayBuffer()))));
  if (forced !== 'main' && workerUsable()) {
    try {
      if (jpegIn) {
        const blob = asBlob(src);
        let W = w0, H = h0;
        if (!(W > 0 && H > 0)) { const info = await jpegInfoOf(blob); W = info?.w || 0; H = info?.h || 0; }
        return done((await wkCall({ op: 'encode', blob, w0: W, h0: H, sizes: list })).blobs);
      }
      const bmp = isBmp ? src : await createImageBitmap(src);
      return done((await wkCall({ op: 'encode', bitmap: bmp, sizes: list }, 60000, { transfer: [bmp] })).blobs);
    } catch (e) {
      if (forced === 'worker') throw e;
      if (isBmp && !(src.width > 0)) throw Object.assign(e instanceof Error ? e : new Error(String(e)), { code: 'WORKER_LOST' });
      console.warn('워커 인코딩 실패 — 메인 스레드로 해요', e);
    }
  }
  return done(await encodeSetMain(src, list, jpegIn));
}
// 메인 스레드 경로 — 칸마다 원본에서 바로 줄여 toDataURL
async function encodeSetMain(src, list, jpegIn) {
  const img = jpegIn ? await decode(src) : src;
  try {
    const { w: W, h: H } = dims(img);
    if (!W || !H) throw new Error('빈 그림이에요');
    const out = [];
    for (const s of list) {
      const k = s.max ? Math.min(1, s.max / Math.max(W, H)) : 1;
      if (jpegIn && k === 1) { out.push(asBlob(src)); continue; }
      const reuse = k === 1 && typeof HTMLCanvasElement === 'function' && img instanceof HTMLCanvasElement;
      const c = reuse ? img : document.createElement('canvas');
      if (!reuse) {
        c.width = Math.max(1, Math.round(W * k)); c.height = Math.max(1, Math.round(H * k));
        const x = c.getContext('2d');
        x.imageSmoothingQuality = 'high';
        x.drawImage(img, 0, 0, c.width, c.height);
      }
      out.push(new Blob([canvasToJpeg(c, s.q)], { type: 'image/jpeg' }));
      if (!reuse) { c.width = 0; c.height = 0; }
    }
    return out;
  } finally { if (jpegIn || (typeof ImageBitmap === 'function' && img instanceof ImageBitmap)) img.close?.(); }
}

// 셔터 순간 미리보기 — video(또는 그림)를 돌리고 잘라 긴 변 maxSide 로 작게 그린 JPEG Blob(약 320px, 몇 ms)
export function snapshot(src, { turns = 0, aspect = null, maxSide = 320, q = 0.7 } = {}) {
  const { w, h } = dims(src);
  if (!w || !h) return null;
  return canvasToBlob(transformCanvas(src, { turns, aspect, maxSide }), q);
}

// JPEG APP1 Exif → IFD0 → ExifIFD(0x8769) → DateTimeOriginal(0x9003) 'YYYY:MM:DD HH:MM:SS' (기기 현지 시각)
// 파일 앞부분만 넘겨도 된다(APP1 은 앞쪽 64KB 안) — 예: new Uint8Array(await file.slice(0, 128 * 1024).arrayBuffer())
export function exifTakenAt(u8) {
  try {
    if (u8 instanceof ArrayBuffer) u8 = new Uint8Array(u8);
    if (!u8 || u8[0] !== 0xFF || u8[1] !== 0xD8) return null;
    let i = 2;
    while (i + 10 < u8.length && u8[i] === 0xFF) {
      const m = u8[i + 1], len = (u8[i + 2] << 8) | u8[i + 3];
      if (m === 0xDA || m === 0xD9) return null;
      if (m === 0xE1 && u8[i + 4] === 0x45 && u8[i + 5] === 0x78 && u8[i + 6] === 0x69 && u8[i + 7] === 0x66 && u8[i + 8] === 0 && u8[i + 9] === 0) return tiffDate(u8, i + 10, len - 8);
      i += 2 + len;
    }
  } catch { /* 깨진 EXIF 는 없는 것으로 */ }
  return null;
}
function tiffDate(u8, t, size) {
  const dv = new DataView(u8.buffer, u8.byteOffset + t, Math.min(size, u8.length - t));
  const le = dv.getUint16(0) === 0x4949;
  const g16 = o => dv.getUint16(o, le), g32 = o => dv.getUint32(o, le);
  if (g16(2) !== 42) return null;
  const find = (off, tag) => { const n = g16(off); for (let k = 0; k < n; k++) { const e = off + 2 + k * 12; if (g16(e) === tag) return e; } return -1; };
  const ex = find(g32(4), 0x8769); if (ex < 0) return null;
  const dt = find(g32(ex + 8), 0x9003); if (dt < 0) return null;
  const cnt = g32(dt + 4), vo = cnt > 4 ? g32(dt + 8) : dt + 8;
  let s = ''; for (let k = 0; k < cnt - 1; k++) s += String.fromCharCode(dv.getUint8(vo + k));
  const m = /^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/.exec(s);
  if (!m || +m[1] < 1990) return null;
  const ts = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]).getTime();
  return Number.isFinite(ts) ? ts : null;
}
