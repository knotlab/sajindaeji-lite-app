// 사진 처리 Web Worker — 디코드·회전·자르기·축소·JPEG 인코딩을 메인 스레드 밖에서(글 입력·화면이 멈추지 않게, 2026-10-21 현장 "다 느림")
// 클래식 워커(import 없음) — image.js 의 transformCanvas 와 같은 규칙(① 시계 방향 turns×90° ② 돌린 그림 가운데 aspect 자르기 ③ 긴 변 maxSide)을 따로 둔다.
//   메인 스레드 canvas.toBlob 은 A55 웹뷰에서 장당 약 4초였지만(공시체 실측) 워커의 convertToBlob 은 메인을 막지 않는다.
// 요청 { id, op, blob, w0?, h0?, turns, aspect, ... } → 응답 { id, ok, ... } | { id, ok:false, error, code }
//   op 'work' : 작업본(maxSide workMax, q workQ) + 썸네일(thumbMax, thumbQ) → { work: Blob, thumb: Blob, w, h, tw, th, ms }
//   op 'full' : 풀 해상도 회전·자르기(갤러리 원본, q) → { blob, w, h, ms }
//   op 'frame': 셔터 프레임(ImageBitmap 또는 VideoFrame, 넘겨받음 — 메인 스레드 인코딩 0, 2026-10-22 폰 "찍을 때 딜레이") → 조각을 나오는 대로 먼저 보낸다
//               { id, part:'preview', blob }(사진 줄 칸) → { id, part:'full', blob, w, h }(원본 = incoming·갤러리 원본)
//               → 마지막 응답 { work, thumb, w, h, tw, th, ms }(작업본은 full canvas 에서 줄인다 — 다시 디코드하지 않는다)
//   op 'encode': 다 그린 그림(ImageBitmap, 넘겨받음)을 JPEG 로만 → { blob, w, h, ms } — 내보내기·카톡 보내기 굽기(워터마크는 메인에서 그리고 인코딩만 여기서, v0.1.5)
//               sizes 를 주면(v0.1.7) 크기 여러 벌을 한 번에 → { blobs: [Blob], dims: [{ w, h }], ms } (sizes 순서).
//               sizes = [{ max, q }] — max 0 = 원래 크기, 원래보다 키우지 않는다. 그림 대신 JPEG blob(+ 알면 w0·h0)을 주면 여기서 푼다
//               (가장 큰 요청 크기로 줄이며 디코드). blob 입력에서 원래 크기 그대로인 칸은 다시 인코딩하지 않고 받은 blob 을 돌려준다(바이트 같음)
//               — 사진대지 칸(1000px)·대장 대표 사진(480px) 줄이기: 0.1.6 까지 메인 toDataURL 이 엑셀 만들기 긴 작업의 83% 였다
//   op 'ping' : { ok: true } (OffscreenCanvas 가 없으면 ok:false code:'NO_OFFSCREEN')
'use strict';

function cropRect(W, H, aspect) {
  if (!(aspect > 0) || !(W > 0) || !(H > 0)) return { x: 0, y: 0, w: W, h: H };
  let w = W, h = W / aspect;
  if (h > H) { h = H; w = H * aspect; }
  w = Math.min(W, Math.round(w)); h = Math.min(H, Math.round(h));
  return { x: Math.round((W - w) / 2), y: Math.round((H - h) / 2), w, h };
}

// 결과 크기 계산은 원본(방향 적용) 크기 W×H 기준 — 미리 줄인 비트맵을 써도 image.transformCanvas 와 같은 크기·같은 그림이 나온다
function plan(W, H, turns, aspect, maxSide) {
  const k = ((turns % 4) + 4) % 4;
  const RW = k % 2 ? H : W, RH = k % 2 ? W : H;
  const c0 = aspect ? cropRect(RW, RH, aspect) : { x: 0, y: 0, w: RW, h: RH };
  const s = Math.min(1, maxSide / Math.max(c0.w, c0.h));
  return { k, RW, RH, c0, s, w: Math.max(1, Math.round(c0.w * s)), h: Math.max(1, Math.round(c0.h * s)) };
}
function draw(src, W, H, p) {
  const c = new OffscreenCanvas(p.w, p.h);
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.scale(p.w / p.c0.w, p.h / p.c0.h);
  x.translate(-p.c0.x, -p.c0.y);
  x.translate(p.RW / 2, p.RH / 2);
  x.rotate(p.k * Math.PI / 2);
  x.drawImage(src, -W / 2, -H / 2, W, H);
  return c;
}
function shrink(src, maxSide) {
  const s = Math.min(1, maxSide / Math.max(src.width, src.height));
  const c = new OffscreenCanvas(Math.max(1, Math.round(src.width * s)), Math.max(1, Math.round(src.height * s)));
  const x = c.getContext('2d');
  x.imageSmoothingQuality = 'high';
  x.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
async function jpeg(canvas, q) {
  const b = await canvas.convertToBlob({ type: 'image/jpeg', quality: q });
  if (!b || !b.size) throw Object.assign(new Error('JPEG 인코딩 실패(빈 결과 — 메모리 부족일 수 있어요)'), { code: 'ENCODE' });
  return b;
}

// 디코드 — 줄일 수 있으면 디코드하면서 줄인다(createImageBitmap resize). 방향(EXIF)은 늘 반영.
// 줄인 비트맵의 가로세로 비가 기대(방향 적용 크기)와 다르면(브라우저마다 resize 와 방향 적용 순서가 다를 수 있음) 버리고 그대로 디코드
async function decode(blob, w0, h0, scale) {
  if (w0 > 0 && h0 > 0 && scale < 0.9) {
    try {
      const rw = Math.max(1, Math.round(w0 * scale)), rh = Math.max(1, Math.round(h0 * scale));
      const b = await createImageBitmap(blob, { imageOrientation: 'from-image', resizeWidth: rw, resizeHeight: rh, resizeQuality: 'high' });
      if (Math.abs(b.width - rw) <= 1 && Math.abs(b.height - rh) <= 1) return { bmp: b, W: w0, H: h0 };
      b.close();
    } catch { /* 아래로 */ }
  }
  const b = await createImageBitmap(blob, { imageOrientation: 'from-image' });
  return { bmp: b, W: b.width, H: b.height };
}

async function work(m) {
  const t0 = performance.now();
  // 원본 크기를 모르면(머리 읽기 실패) 줄이지 않고 디코드
  let W = m.w0, H = m.h0;
  const pre = W > 0 && H > 0 ? plan(W, H, m.turns || 0, m.aspect || null, m.workMax) : null;
  const d = await decode(m.blob, W, H, pre ? pre.s : 1);
  W = d.W; H = d.H;
  try {
    const p = plan(W, H, m.turns || 0, m.aspect || null, m.workMax);
    const wc = draw(d.bmp, W, H, p);
    d.bmp.close();
    const tc = shrink(wc, m.thumbMax);
    const [wb, tb] = await Promise.all([jpeg(wc, m.workQ), jpeg(tc, m.thumbQ)]);
    return { work: wb, thumb: tb, w: wc.width, h: wc.height, tw: tc.width, th: tc.height, ms: Math.round(performance.now() - t0) };
  } finally { try { d.bmp.close(); } catch { /* 이미 닫힘 */ } }
}

async function full(m) {
  const t0 = performance.now();
  const d = await decode(m.blob, 0, 0, 1);
  try {
    const p = plan(d.W, d.H, m.turns || 0, m.aspect || null, m.maxSide || Infinity);
    const c = draw(d.bmp, d.W, d.H, p);
    d.bmp.close();
    return { blob: await jpeg(c, m.q || 0.92), w: c.width, h: c.height, ms: Math.round(performance.now() - t0) };
  } finally { try { d.bmp.close(); } catch { /* 이미 닫힘 */ } }
}

async function frame(m) {
  const t0 = performance.now();
  const bmp = m.bitmap;
  const W = bmp?.displayWidth || bmp?.width || 0, H = bmp?.displayHeight || bmp?.height || 0;   // ImageBitmap 또는 VideoFrame
  if (!W || !H) throw Object.assign(new Error('빈 프레임'), { code: 'NO_FRAME' });
  const turns = m.turns || 0, aspect = m.aspect || null;
  try {
    if (m.pvMax > 0) {
      const pc = draw(bmp, W, H, plan(W, H, turns, aspect, m.pvMax));
      self.postMessage({ id: m.id, part: 'preview', blob: await jpeg(pc, m.pvQ || 0.7) });
    }
    const fc = draw(bmp, W, H, plan(W, H, turns, aspect, Infinity));
    bmp.close();
    self.postMessage({ id: m.id, part: 'full', blob: await jpeg(fc, m.q || 0.92), w: fc.width, h: fc.height });
    const wc = shrink(fc, m.workMax), tc = shrink(wc, m.thumbMax);
    const [wb, tb] = await Promise.all([jpeg(wc, m.workQ), jpeg(tc, m.thumbQ)]);
    return { work: wb, thumb: tb, w: wc.width, h: wc.height, tw: tc.width, th: tc.height, ms: Math.round(performance.now() - t0) };
  } finally { try { bmp.close(); } catch { /* 이미 닫힘 */ } }
}

async function encode(m) {
  if (Array.isArray(m.sizes) && m.sizes.length) return encodeSet(m);
  const t0 = performance.now();
  const bmp = m.bitmap;
  if (!bmp?.width || !bmp?.height) throw Object.assign(new Error('빈 그림'), { code: 'NO_FRAME' });
  try {
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    bmp.close();
    return { blob: await jpeg(c, m.q || 0.85), w: c.width, h: c.height, ms: Math.round(performance.now() - t0) };
  } finally { try { bmp.close(); } catch { /* 이미 닫힘 */ } }
}

// 크기 여러 벌(v0.1.7) — 칸마다 원본(그림)에서 바로 줄인다(작은 칸을 큰 칸에서 다시 줄이지 않음 — 두 번 흐려지지 않게)
async function encodeSet(m) {
  const t0 = performance.now();
  const sizes = m.sizes.map(s => ({ max: s && s.max > 0 ? Math.round(s.max) : 0, q: (s && s.q) || 0.85 }));
  const fromBlob = !m.bitmap;
  let bmp = m.bitmap || null, W = 0, H = 0;
  if (bmp) { W = bmp.width; H = bmp.height; }
  else {
    if (!(m.blob instanceof Blob) || !m.blob.size) throw Object.assign(new Error('빈 그림'), { code: 'NO_FRAME' });
    const w0 = m.w0 > 0 ? m.w0 : 0, h0 = m.h0 > 0 ? m.h0 : 0;
    const need = sizes.some(s => !s.max) ? 0 : Math.max(...sizes.map(s => s.max));
    const d = await decode(m.blob, w0, h0, need && w0 && h0 ? Math.min(1, need / Math.max(w0, h0)) : 1);
    bmp = d.bmp; W = d.W; H = d.H;
  }
  if (!W || !H) { try { bmp.close(); } catch { /* 이미 닫힘 */ } throw Object.assign(new Error('빈 그림'), { code: 'NO_FRAME' }); }
  try {
    const jobs = sizes.map(s => {
      const k = s.max ? Math.min(1, s.max / Math.max(W, H)) : 1;
      const w = Math.max(1, Math.round(W * k)), h = Math.max(1, Math.round(H * k));
      if (fromBlob && k === 1) return { w, h, blob: m.blob };                        // 원래 크기 — 받은 JPEG 그대로
      const c = new OffscreenCanvas(w, h);
      const x = c.getContext('2d');
      x.imageSmoothingQuality = 'high';
      x.drawImage(bmp, 0, 0, w, h);
      return { w, h, c, q: s.q };
    });
    bmp.close();
    const blobs = await Promise.all(jobs.map(j => j.blob || jpeg(j.c, j.q)));
    return { blobs, dims: jobs.map(j => ({ w: j.w, h: j.h })), ms: Math.round(performance.now() - t0) };
  } finally { try { bmp.close(); } catch { /* 이미 닫힘 */ } }
}

self.onmessage = async e => {
  const m = e.data || {};
  try {
    if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') throw Object.assign(new Error('OffscreenCanvas 없음'), { code: 'NO_OFFSCREEN' });
    let r;
    if (m.op === 'ping') {
      const t = new OffscreenCanvas(2, 2);
      if (!t.getContext('2d') || typeof t.convertToBlob !== 'function') throw Object.assign(new Error('OffscreenCanvas 2d 없음'), { code: 'NO_OFFSCREEN' });
      r = {};
    } else if (m.op === 'work') r = await work(m);
    else if (m.op === 'full') r = await full(m);
    else if (m.op === 'frame') r = await frame(m);
    else if (m.op === 'encode') r = await encode(m);
    else throw new Error(`모르는 작업: ${m.op}`);
    self.postMessage({ id: m.id, ok: true, ...r });
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String(err?.message || err), code: err?.code || err?.name || '' });
  }
};
