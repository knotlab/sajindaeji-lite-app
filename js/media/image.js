// 이미지 처리 — 디코드·축소·회전·자르기·JPEG 인코딩(toDataURL 경로)·EXIF 촬영 시각(설계서 §4.3·§5.4, 원본 image.js 이식)
// toBlob 은 쓰지 않는다: 갤럭시 A55 웹뷰에서 장당 약 4초, toDataURL 은 약 0.1초(공시체 util.js 실측 — 되돌리지 말 것)
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
      for (let k = i + 2 + len; k + 1 < u8.length; k++) if (u8[k] === 0xFF && u8[k + 1] === 0xD9) return true;
      return false;
    }
    i += 2 + len;
  }
  return false;                                                   // 그림 자료 전에 끝남
}

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
