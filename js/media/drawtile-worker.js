// 큰 도면 타일 워커(클래식 워커 — drawtiles.js 가 띄운다). 메인 스레드는 기다리기만 한다(디코드·줄이기·자르기·인코딩 전부 여기서).
// 받는 것: { op:'build', id, blob, tileSize, format:'auto'|'jpeg'|'png', q, maxPx, bg:[r,g,b] }
//          { op:'ack', id, n }   — 메인이 타일 n 개를 저장했다(그만큼 더 보내도 된다: 저장보다 너무 앞서가며 메모리를 쌓지 않게)
//          { op:'ping', id }
// 보내는 것: { op:'plan', id, w, h, srcW, srcH, levels:[{w,h,cols,rows}], total, format, sample }
//          { op:'tile', id, z, x, y, blob }               — 빈 타일(바탕색 한 가지)은 보내지 않는다
//          { op:'blank', id, z, x, y }
//          { op:'done', id, ms:{decode, levels, tiles, total}, bytes, tiles, blank }
//          { op:'error', id, error }
// 단계(z): 0 = 가장 작은 단계(한 타일 안), levels.length-1 = 원본 해상도. 각 단계는 앞 단계를 반으로(올림) 줄인 것.
// 순서: 작은 단계부터 보낸다 — 다 만들기 전에도 개요(z 0~2)가 먼저 저장돼 화면에 뜰 수 있게.
'use strict';

const INFLIGHT = 24;                  // 저장 확인을 기다리지 않고 앞서 보낼 타일 수
const SAMPLE = 8;                     // 형식 고르기('auto')에 쓸 원본 단계 타일 수
const PNG_SLACK = 1.1;                // PNG 가 JPEG 의 1.1 배 안이면 PNG(무손실 — 가는 선·글자가 번지지 않음)
const TOL = 6;                        // 빈 타일 판정: 바탕색과 채널마다 이만큼까지 같다고 본다(JPEG 원본의 잡티)

let job = null;                       // 지금 하는 일 { id, sent, acked, wake }

self.onmessage = e => {
  const m = e.data || {};
  if (m.op === 'ping') {
    const ok = typeof OffscreenCanvas === 'function' && typeof OffscreenCanvas.prototype.convertToBlob === 'function' && typeof createImageBitmap === 'function';
    self.postMessage({ op: 'pong', id: m.id, ok });
    return;
  }
  if (m.op === 'ack') {
    if (job && job.id === m.id) { job.acked += m.n || 1; const w = job.wake; job.wake = null; if (w) w(); }
    return;
  }
  if (m.op === 'build') build(m).catch(err => self.postMessage({ op: 'error', id: m.id, error: String((err && err.message) || err) }));
};

function waitCredit() {
  if (job.sent - job.acked < INFLIGHT) return null;
  return new Promise(res => { job.wake = res; });
}

function canvas(w, h, read) {
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d', { alpha: false, willReadFrequently: !!read });
  return { c, g };
}

// 바탕색 한 가지뿐인가(getImageData 한 번 — 512² 에 1ms 안팎)
function isBlank(g, w, h, bg) {
  const d = g.getImageData(0, 0, w, h).data;
  const r = bg[0], gg = bg[1], b = bg[2];
  for (let i = 0; i < d.length; i += 4) {
    if (Math.abs(d[i] - r) > TOL || Math.abs(d[i + 1] - gg) > TOL || Math.abs(d[i + 2] - b) > TOL) return false;
  }
  return true;
}

async function encode(c, fmt, q) {
  const blob = await c.convertToBlob(fmt === 'png' ? { type: 'image/png' } : { type: 'image/jpeg', quality: q });
  if (!blob || !blob.size) throw new Error('타일 인코딩 실패(빈 결과 — 메모리 부족일 수 있어요)');
  return blob;
}

// 한 타일을 그 단계 그림 src 에서 잘라 tile 캔버스에 — 가장자리 타일은 남은 크기만큼(채우지 않는다)
function cut(t, src, T, x, y, lw, lh) {
  const tw = Math.min(T, lw - x * T), th = Math.min(T, lh - y * T);
  if (t.c.width !== tw || t.c.height !== th) { t.c.width = tw; t.c.height = th; }
  t.g.drawImage(src, x * T, y * T, tw, th, 0, 0, tw, th);
  return { tw, th };
}

async function build(m) {
  const T0 = performance.now();
  const T = m.tileSize || 512, q = m.q || 0.85, bg = m.bg || [255, 255, 255];
  job = { id: m.id, sent: 0, acked: 0, wake: null };

  // ① 디코드(너무 크면 디코드하면서 줄인다 — 메모리 한도)
  let full = await createImageBitmap(m.blob);
  let W = full.width, H = full.height;
  const srcW = W, srcH = H;
  if (m.maxPx && W * H > m.maxPx) {
    const k = Math.sqrt(m.maxPx / (W * H));
    const w2 = Math.max(1, Math.floor(W * k)), h2 = Math.max(1, Math.floor(H * k));
    full.close();
    full = await createImageBitmap(m.blob, { resizeWidth: w2, resizeHeight: h2, resizeQuality: 'high' });
    W = full.width; H = full.height;
  }
  const T1 = performance.now();

  // ② 단계 크기 — 원본에서 반씩(올림), 가장 작은 단계가 한 타일 안에 들어올 때까지
  const sizes = [[W, H]];
  while (sizes[0][0] > T || sizes[0][1] > T) sizes.unshift([Math.ceil(sizes[0][0] / 2), Math.ceil(sizes[0][1] / 2)]);
  const L = sizes.length;
  const levels = sizes.map(([w, h]) => ({ w, h, cols: Math.ceil(w / T), rows: Math.ceil(h / T) }));
  const total = levels.reduce((s, l) => s + l.cols * l.rows, 0);

  // 원본 단계에 흰 바탕을 깐다(투명 PNG 도면 그림 — 투명이 검게 인코딩되지 않게). JPEG 원본이면 그대로 비트맵을 쓴다
  // (alpha:false 캔버스에 그리면 투명 부분이 검정이 되므로, 단계 캔버스는 늘 바탕색을 먼저 칠한다)
  const fill = g => { g.fillStyle = `rgb(${bg[0]},${bg[1]},${bg[2]})`; g.fillRect(0, 0, g.canvas.width, g.canvas.height); };
  let top = full;
  if (m.blob.type !== 'image/jpeg') {
    const f = canvas(W, H);
    fill(f.g); f.g.drawImage(full, 0, 0);
    full.close(); full = null;
    top = f.c;
  }

  // ③ 아래 단계들(작은 쪽) — 앞 단계를 반으로. 품질 'high'(밉맵·고급 필터)라 가는 선이 끊기지 않고 옅어진다
  const pics = new Array(L);
  pics[L - 1] = top;
  for (let z = L - 2; z >= 0; z--) {
    const [w, h] = sizes[z];
    const s = canvas(w, h);
    fill(s.g);
    s.g.imageSmoothingEnabled = true; s.g.imageSmoothingQuality = 'high';
    s.g.drawImage(pics[z + 1], 0, 0, w, h);
    pics[z] = s.c;
  }
  const T2 = performance.now();

  // ④ 형식 고르기 — 원본 단계에서 고루 뽑은 빈 아닌 타일 몇 개를 두 형식으로 인코딩해 본다
  const t = canvas(T, T, true);
  let fmt = m.format === 'png' || m.format === 'jpeg' ? m.format : null;
  const sample = { jpeg: 0, png: 0, n: 0 };
  if (!fmt) {
    const lv = levels[L - 1], n = lv.cols * lv.rows;
    const step = Math.max(1, Math.floor(n / (SAMPLE * 3)));
    for (let i = Math.floor(step / 2); i < n && sample.n < SAMPLE; i += step) {
      const x = i % lv.cols, y = Math.floor(i / lv.cols);
      const { tw, th } = cut(t, pics[L - 1], T, x, y, lv.w, lv.h);
      if (isBlank(t.g, tw, th, bg)) continue;
      sample.jpeg += (await encode(t.c, 'jpeg', q)).size;
      sample.png += (await encode(t.c, 'png', q)).size;
      sample.n++;
    }
    fmt = sample.n && sample.png <= sample.jpeg * PNG_SLACK ? 'png' : 'jpeg';
  }
  self.postMessage({ op: 'plan', id: m.id, w: W, h: H, srcW, srcH, levels, total, format: fmt, sample });

  // ⑤ 자르기·인코딩 — 작은 단계부터. 한 단계를 다 보내면 그 단계 캔버스는 놓는다
  let bytes = 0, tiles = 0, blank = 0;
  for (let z = 0; z < L; z++) {
    const lv = levels[z];
    for (let y = 0; y < lv.rows; y++) {
      for (let x = 0; x < lv.cols; x++) {
        const { tw, th } = cut(t, pics[z], T, x, y, lv.w, lv.h);
        if (isBlank(t.g, tw, th, bg)) { blank++; self.postMessage({ op: 'blank', id: m.id, z, x, y }); continue; }
        const w = waitCredit();
        if (w) await w;
        const blob = await encode(t.c, fmt, q);
        bytes += blob.size; tiles++;
        job.sent++;
        self.postMessage({ op: 'tile', id: m.id, z, x, y, blob });
      }
    }
    if (z < L - 1) { pics[z].width = pics[z].height = 0; pics[z] = null; }
  }
  try { if (top.close) top.close(); else { top.width = top.height = 0; } } catch (e) { /* 이미 놓음 */ }
  t.c.width = t.c.height = 0;
  const T3 = performance.now();
  self.postMessage({ op: 'done', id: m.id, bytes, tiles, blank, ms: { decode: Math.round(T1 - T0), levels: Math.round(T2 - T1), tiles: Math.round(T3 - T2), total: Math.round(T3 - T0) } });
  job = null;
}
