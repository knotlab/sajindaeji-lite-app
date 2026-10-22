// 도면 스냅샷 — 뷰어 iframe(docFrame, www/viewer/index.html?embed=1)에 지금 떠 있는 도면을 그림(JPEG)으로 담는다.
// 「도면에 핀하기」(사용자 요구 2026-10-22): 도면 크게에서 찾아 둔 자리 → [위치 찍기] → 이 그림 위 핀 지도에서 정확한 자리를 탭.
// 뷰어 사본은 고치지 않는다(SPEC §10.2) — 같은 출처 iframe 이라 window.AV 를 바깥에서 읽기만 한다.
//   AV.active()                       지금 보이는 문서(Doc: file·name·viewer·state·instance·els.stage)
//   PDF  : AV.active().instance.api   { pdf(PDFDocumentProxy), page, pages, rotation } — 뷰어가 「확장 앱용」으로 내놓은 것
//   도면 : AV.active().cad.view       CadView(2D canvas — WebGL 아님). DXF·DWG 가 같은 CadView 를 쓴다
//   그림 : .av-image-inner > img | canvas(TIFF·HEIC 축소본)
// 형식별 전략
//   PDF  — 화면 canvas 는 쓰지 않는다(화면 배율·보이는 쪽만 그려 있고 확대하면 조각(detail)으로 나뉨).
//          같은 PDFDocumentProxy 로 그 쪽을 원하는 배율로 다시 그린다 — 가로 띠 조각마다(뷰어 renderDetail 과 같은 transform 이동).
//   도면 — CadView.draw() 를 화면 canvas 대신 우리 조각 canvas 에 돌린다(Object.create(view) 로 g·cv·W·H·dpr·view 만 바꿔 끼움 —
//          화면 상태는 건드리지 않음). 범위 = 도면 전체(맞춤과 같은 sc.ext), 흰 종이 + 흰 바탕에서 안 보이는 밝은 색은 진하게.
//          레이어 켜기·끄기는 화면 그대로 따른다.
//   그림 — 원본 파일을 워커에서 줄이며 디코드(createImageBitmap resize)·회전. SVG·TIFF·HEIC 는 화면 요소를 비트맵으로 떠서 워커로.
//   그 밖(엑셀·문서·3D·동영상…) → { unsupported: true, reason: 'format' }
// 메인 스레드를 오래 막지 않게: canvas 그리기는 래스터가 미뤄졌다가 한 번에 일어난다(8MP 한 장 = 시험기 메인 1.7초 멈춤, 2026-10-22 실측)
//   → 약 1MP 조각마다 그리고 바로 ImageBitmap 으로 떠서(그 조각만 래스터) 한 박자 쉬고, 붙이기·JPEG 인코딩은 워커에서.
// 범위: 「쪽 전체 + 지금 보던 영역(view, 0~1 비율)」 — 핀 지도가 처음 그 영역으로 확대해 열 수 있게.
//   보던 영역이 작으면(크게 확대해 둠) 그 영역이 최소 focusMin px 이 되도록 해상도를 올린다(한 변 hardMax·화소 maxPx 상한).
// 인코딩 워커는 이 파일 안 글자로 만든 블롭 워커(OffscreenCanvas.convertToBlob) — 따로 파일 없음.
//   워커가 없으면 메인 toDataURL(느림, 폴백). canvas.toBlob 은 A55 웹뷰에서 수 초라 쓰지 않는다(SPEC §4.3).

const Q = 0.9;                        // 선 도면이라 사진(0.85)보다 조금 높게 — 글자·가는 선이 덜 뭉개지게
const TILE = 512;                     // 도면 첫 조각 한 변(px) — 조각 시간을 보고 384~1024 로 조절(더 잘게는 조각마다 드는 고정 비용이 커서 오히려 느림)
const PDF_TILE_PX = 1.2e6;            // PDF 조각(가로 띠) 화소 — 조각마다 pdf.js 가 그리기 명령을 다시 돌리므로 너무 잘게는 안 나눈다
const CAD_MARGIN = 0.03;              // 도면 둘레 여백(긴 변 비율)

// ---- 무엇을 담을 수 있나 ----

function avOf(iframeEl) {
  try {
    const w = iframeEl?.contentWindow;
    const AV = w?.AV;
    return AV && typeof AV.active === 'function' ? { w, AV } : null;
  } catch { return null; }                                             // 다른 출처면 못 읽는다
}

const IMAGE_VIEWERS = new Set(['image', 'tiff', 'heic']);

// → { kind: 'pdf'|'cad'|'image'|null, reason?: 'noframe'|'empty'|'loading'|'error'|'format', name?, viewer? }
// 촬영 화면이 [위치 찍기] 버튼을 켤지·끌지 정할 때(가볍다 — DOM 을 거의 읽지 않음)
// name 은 뷰어에 열린 파일 이름 — 문서를 막 바꾼 직후엔 앞 문서가 아직 active 일 수 있으니 docs.doc(id).name 과 맞춰 볼 것
export function snapKind(iframeEl) {
  const f = avOf(iframeEl);
  if (!f) return { kind: null, reason: 'noframe' };
  let d;
  try { d = f.AV.active(); } catch { d = null; }
  if (!d) return { kind: null, reason: 'empty' };
  const viewer = d.viewer?.id || null, base = { name: d.name, viewer };
  if (d.state === 'error') return { kind: null, reason: 'error', ...base };
  if (d.state !== 'ready' || !d.els?.stage) return { kind: null, reason: 'loading', ...base };
  if (viewer === 'pdf') return d.instance?.api?.pdf ? { kind: 'pdf', ...base } : { kind: null, reason: 'loading', ...base };
  if (d.viewer?.family === 'cad') return d.cad?.view ? { kind: 'cad', ...base } : { kind: null, reason: 'loading', ...base };
  if (IMAGE_VIEWERS.has(viewer)) return d.els.stage.querySelector('.av-image-inner > img, .av-image-inner > canvas') ? { kind: 'image', ...base } : { kind: null, reason: 'loading', ...base };
  return { kind: null, reason: 'format', ...base };
}

const REASON_TEXT = {
  noframe: '도면을 먼저 띄워 주세요',
  empty: '도면을 먼저 띄워 주세요',
  loading: '도면을 여는 중이에요. 잠시 뒤 다시 눌러 주세요',
  error: '도면을 열지 못해 위치를 찍을 수 없어요',
  format: '도면(PDF·DWG·DXF)이나 그림에서만 위치를 찍을 수 있어요',
};
export const reasonText = reason => REASON_TEXT[reason] || '도면을 담지 못했어요';

// ---- 크기 정하기 ----

// 쪽 크기 pw×ph(임의 단위)와 보던 영역 → 결과 크기 { w, h, k }(k = 결과 px / 단위)
export function planSize(pw, ph, view, { maxSide = 2400, focusMin = 1000, hardMax = 4096, maxPx = 8e6, minSide = 0 } = {}) {
  let k = maxSide / Math.max(pw, ph);
  if (view && view.w > 0 && view.h > 0) {
    const vpx = Math.max(view.w * pw, view.h * ph) * k;              // 보던 영역의 긴 변이 결과에서 몇 px 인가
    if (vpx < focusMin) k *= focusMin / vpx;                         // 크게 확대해 보던 곳 — 그 부분이 뭉개지지 않게
  }
  k = Math.min(k, hardMax / Math.max(pw, ph), Math.sqrt(maxPx / (pw * ph)));
  if (minSide) k = Math.max(k, minSide / Math.max(pw, ph));
  return { w: Math.max(1, Math.round(pw * k)), h: Math.max(1, Math.round(ph * k)), k };
}

const clamp01 = v => Math.min(1, Math.max(0, v));
function fracRect(x0, y0, x1, y1) {                                   // 0~1 로 자른 사각형(보이는 데가 없으면 null)
  const a = clamp01(Math.min(x0, x1)), b = clamp01(Math.min(y0, y1)), c = clamp01(Math.max(x0, x1)), d = clamp01(Math.max(y0, y1));
  if (c - a < 1e-6 || d - b < 1e-6) return null;
  const r = n => Math.round(n * 1e5) / 1e5;
  return { x: r(a), y: r(b), w: r(c - a), h: r(d - b) };
}
// 화면 사각형 el(쪽·그림 상자)에서 viewport 사각형 vp 와 겹치는 부분 → el 기준 비율
function domView(elRect, vpRect) {
  if (!elRect.width || !elRect.height) return null;
  return fracRect((vpRect.left - elRect.left) / elRect.width, (vpRect.top - elRect.top) / elRect.height,
    (vpRect.right - elRect.left) / elRect.width, (vpRect.bottom - elRect.top) / elRect.height);
}

// 한 박자 쉬기 — 그림을 한 번 그리게 하고(rAF) 입력도 받게(setTimeout). 숨은 탭이면 rAF 가 안 오니 80ms 한도
function yieldFrame() {
  return new Promise(res => {
    let done = false;
    const go = () => { if (!done) { done = true; setTimeout(res, 0); } };
    try { requestAnimationFrame(go); } catch { /* 없음 */ }
    setTimeout(go, 80);
  });
}

const tagOf = v => Object.prototype.toString.call(v);
const isBlobLike = v => /\[object (Blob|File)\]/.test(tagOf(v));    // 뷰어 iframe 의 File 은 이쪽 Blob 의 instanceof 가 아니다(다른 realm)
const abortErr = () => Object.assign(new Error('취소했어요'), { name: 'AbortError' });

// 조각 그리기 — draw(canvas, ox, oy, tw, th) 로 조각 하나를 그리고 바로 비트맵으로 뜬다(그 순간 그 조각만 래스터).
// 조각 사이에 한 박자 쉰다. adapt: 조각 하나(그리기 + 뜨기)가 target ms 를 넘으면 다음 줄부터 조각을 줄인다(min px 까지 —
// 너무 가벼우면 max 까지 키운다. 그리기 비용이 넓이에 비례하는 도면용. PDF 는 조각마다 명령 전체를 다시 돌려 줄여도 덜 줄어서 안 쓴다).
// → { tiles: [{ bmp, x, y }], maxMs(조각 하나 최대) }
async function drawTiles(doc, W, H, tw0, th0, draw, signal, tileLog, adapt) {
  const c = doc.createElement('canvas');
  const tiles = [];
  let maxMs = 0, tw0n = tw0, th0n = th0;
  try {
    for (let oy = 0; oy < H;) {
      const th = Math.min(th0n, H - oy);
      let rowMax = 0;
      for (let ox = 0; ox < W;) {
        if (signal?.aborted) throw abortErr();
        const tw = Math.min(tw0n, W - ox);
        if (c.width !== tw || c.height !== th) { c.width = tw; c.height = th; }
        const t1 = performance.now();
        await draw(c, ox, oy, tw, th);
        const t2 = performance.now();
        tiles.push({ bmp: await createImageBitmap(c), x: ox, y: oy });
        const t3 = performance.now();
        const ms = adapt ? t3 - t1 : t3 - t2;                         // PDF 그리기는 pdf.js 가 나눠 하므로 뜨기(래스터)만
        maxMs = Math.max(maxMs, ms); rowMax = Math.max(rowMax, ms);
        tileLog?.push(Math.round(ms));
        ox += tw;
        await yieldFrame();
      }
      oy += th;
      if (adapt && rowMax > adapt.target && tw0n > adapt.min) {
        tw0n = th0n = Math.max(adapt.min, Math.round(tw0n / Math.sqrt(rowMax / adapt.target)));
      } else if (adapt && rowMax < adapt.target / 3 && tw0n < adapt.max) {
        tw0n = th0n = Math.min(adapt.max, Math.round(tw0n * 1.5));    // 가벼운 도면 — 조각을 키워 박자(프레임) 수를 줄인다
      }
    }
  } catch (e) {
    for (const t of tiles) try { t.bmp.close(); } catch { /* 무시 */ }
    throw e;
  } finally { c.width = c.height = 0; }
  return { tiles, maxMs };
}

// ---- 인코딩 워커(블롭 워커 — 파일 하나 더 만들지 않는다) ----
// 요청 { id, w, h, q, tiles: [{ bmp, x, y }] }                  조각을 w×h 에 붙여 JPEG
//      { id, w, h, q, src: Blob|ImageBitmap, sw, sh, rot, flip }  그림 하나(Blob 이면 워커에서 sw×sh 로 줄이며 디코드) → 돌려 그려 JPEG
// → { id, ok, blob, ms } | { id, ok:false, error }
const WORKER_SRC = `'use strict';
async function bitmapOf(src, sw, sh) {
  if (!(src instanceof Blob)) return src;
  if (sw > 0 && sh > 0) {
    try {
      const b = await createImageBitmap(src, { imageOrientation: 'from-image', resizeWidth: sw, resizeHeight: sh, resizeQuality: 'high' });
      if (b.width === sw && b.height === sh) return b;
      b.close();                         // 줄이기·방향(EXIF) 순서가 브라우저마다 달라 비가 뒤집혔다 → 그대로 디코드
    } catch (e) { /* 줄이며 디코드를 못 하는 브라우저 — 그대로 */ }
  }
  return createImageBitmap(src, { imageOrientation: 'from-image' });
}
self.onmessage = async e => {
  const m = e.data || {};
  if (m.op === 'ping') { self.postMessage({ id: m.id, ok: typeof OffscreenCanvas === 'function' && typeof OffscreenCanvas.prototype.convertToBlob === 'function' }); return; }
  const t0 = performance.now();
  let bmp = null;
  try {
    const c = new OffscreenCanvas(m.w, m.h);
    const g = c.getContext('2d', { alpha: false });
    g.fillStyle = '#fff'; g.fillRect(0, 0, m.w, m.h);
    if (m.tiles) {
      for (const t of m.tiles) { g.drawImage(t.bmp, t.x, t.y); t.bmp.close(); }
    } else {
      bmp = await bitmapOf(m.src, m.sw, m.sh);
      const rot = ((m.rot || 0) % 360 + 360) % 360, flip = m.flip === -1 ? -1 : 1;
      g.imageSmoothingQuality = 'high';
      g.translate(m.w / 2, m.h / 2);
      g.rotate(rot * Math.PI / 180);
      g.scale(flip, 1);
      const sw = rot % 180 ? m.h : m.w, sh = rot % 180 ? m.w : m.h;   // 돌리기 전 그림 크기
      g.drawImage(bmp, -sw / 2, -sh / 2, sw, sh);
    }
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: m.q || 0.9 });
    if (!blob || !blob.size) throw new Error('JPEG 인코딩 실패(빈 결과 — 메모리 부족일 수 있어요)');
    self.postMessage({ id: m.id, ok: true, blob, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) });
  } finally {
    try { if (bmp && bmp.close) bmp.close(); } catch (e) {}
    if (m.tiles) for (const t of m.tiles) try { t.bmp.close(); } catch (e) {}
  }
};`;

let wk = null, wkOk = null, wkSeq = 0, wkIdle = 0, wkFails = 0;
const wkWait = new Map();
function worker() {
  if (wkOk === false) return null;
  if (wk) return wk;
  try {
    const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
    wk = new Worker(url);
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    wk.onmessage = e => { const p = wkWait.get(e.data?.id); if (p) { wkWait.delete(e.data.id); p.res(e.data); } };
    wk.onerror = e => { console.warn('도면 스냅샷 워커 오류', e?.message || e); killWorker(new Error('워커 오류')); };
  } catch (e) { console.warn('도면 스냅샷 워커를 못 띄워요', e); wkOk = false; return null; }
  return wk;
}
function killWorker(err) {
  try { wk?.terminate(); } catch { /* 이미 끝남 */ }
  wk = null;
  for (const p of wkWait.values()) p.rej(err);
  wkWait.clear();
}
function call(msg, transfer = []) {
  const w = worker();
  if (!w) return Promise.reject(Object.assign(new Error('워커 없음'), { code: 'NO_WORKER' }));
  clearTimeout(wkIdle);
  const id = ++wkSeq;
  return new Promise((res, rej) => {
    const timer = setTimeout(() => { if (wkWait.delete(id)) { rej(new Error('워커가 답하지 않아요')); killWorker(new Error('시간 초과')); } }, 30000);
    wkWait.set(id, { res: v => { clearTimeout(timer); res(v); }, rej: e => { clearTimeout(timer); rej(e); } });
    w.postMessage({ id, ...msg }, transfer);
  }).finally(() => {
    clearTimeout(wkIdle);
    wkIdle = setTimeout(() => { if (!wkWait.size) killWorker(new Error('쉼')); }, 30000);   // 30초 놀면 내린다(메모리)
  });
}
async function workerReady() {
  if (wkOk !== null) return wkOk;
  try { wkOk = !!(await call({ op: 'ping' })).ok; } catch { wkOk = false; }
  if (!wkOk) killWorker(new Error('워커 안 됨'));
  return wkOk;
}

// 메인 스레드 폴백 — toDataURL(동기, 느림). 워커가 없는 오래된 웹뷰에서만
function mainEncode(job, source) {
  const { w, h, rot = 0, flip = 1, q = Q } = job;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { alpha: false });
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  if (job.tiles) for (const t of job.tiles) g.drawImage(t.bmp, t.x, t.y);
  else {
    g.imageSmoothingQuality = 'high';
    g.translate(w / 2, h / 2); g.rotate(rot * Math.PI / 180); g.scale(flip, 1);
    const sw = rot % 180 ? h : w, sh = rot % 180 ? w : h;
    g.drawImage(source, -sw / 2, -sh / 2, sw, sh);
  }
  const url = c.toDataURL('image/jpeg', q);
  c.width = c.height = 0;
  const bin = atob(url.slice(url.indexOf(',') + 1)), u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return new Blob([u8], { type: 'image/jpeg' });
}

function closeJob(job) {
  if (job.tiles) for (const t of job.tiles) try { t.bmp.close(); } catch { /* 무시 */ }
  else if (job.src && !isBlobLike(job.src)) try { job.src.close(); } catch { /* 무시 */ }
}

// job = { w, h, q, tiles } | { w, h, q, src, sw, sh, rot, flip } → { blob, via: 'worker'|'main', ms }
async function encode(job) {
  const q = job.q ?? Q;
  if (wkFails < 2 && await workerReady()) {
    const transfer = job.tiles ? job.tiles.map(t => t.bmp) : isBlobLike(job.src) ? [] : [job.src];
    try {
      const r = await call({ ...job, q }, transfer);
      if (r.ok) return { blob: r.blob.type ? r.blob : new Blob([r.blob], { type: 'image/jpeg' }), via: 'worker', ms: r.ms };
      throw new Error(r.error);
    } catch (e) {
      wkFails++;
      console.warn('워커 인코딩 실패 — 메인에서 해요', e);
      if (transfer.some(b => !b.width)) throw Object.assign(new Error('그림을 담지 못했어요. 다시 눌러 주세요'), { code: 'ENCODE', cause: e });   // 이미 넘겨 버림
    }
  }
  const t0 = performance.now();
  let source = job.src, own = false;
  try {
    if (!job.tiles && isBlobLike(source)) { source = await createImageBitmap(source, { imageOrientation: 'from-image' }); own = true; }
    return { blob: mainEncode({ ...job, q }, source), via: 'main', ms: Math.round(performance.now() - t0) };
  } finally {
    if (own) try { source.close(); } catch { /* 무시 */ }
    closeJob(job);
  }
}

// ---- PDF ----
async function snapPdf(F, d, opt) {
  const api = d.instance.api, stage = d.els.stage;
  const scroller = stage.querySelector('.av-pdf-scroll') || stage;
  const vr = scroller.getBoundingClientRect();
  // 가장 많이 보이는 쪽(뷰어가 아는 지금 쪽 ± 1 — 쪽이 수백 장이어도 몇 개만 잰다)
  const cur = api.page || 1, N = api.pages || 1;
  let n = cur, best = -1, view = null;
  for (let i = Math.max(1, cur - 1); i <= Math.min(N, cur + 1); i++) {
    const pe = stage.querySelector(`.av-pdf-page[data-n="${i}"]`);
    if (!pe) continue;
    const r = pe.getBoundingClientRect();
    const a = Math.max(0, Math.min(r.right, vr.right) - Math.max(r.left, vr.left)) * Math.max(0, Math.min(r.bottom, vr.bottom) - Math.max(r.top, vr.top));
    if (a > best) { best = a; n = i; view = domView(r, vr); }
  }
  const t0 = performance.now();
  const pg = await api.pdf.getPage(n);
  const rotation = ((pg.rotate || 0) + (api.rotation || 0)) % 360;
  const vp1 = pg.getViewport({ scale: 1, rotation });
  const size = planSize(vp1.width, vp1.height, view, opt);
  const vp = pg.getViewport({ scale: size.k, rotation });
  const sx = size.w / vp.width, sy = size.h / vp.height;             // 반올림 보정
  let task = null;
  const onAbort = () => { try { task?.cancel(); } catch { /* 끝남 */ } };
  opt.signal?.addEventListener('abort', onAbort, { once: true });
  const th = Math.max(256, Math.min(size.h, Math.floor(PDF_TILE_PX / size.w)));
  try {
    // 뷰어 쪽 문서의 canvas(pdf.js 와 같은 realm). 조각 자리만큼 옮겨 그린다(pdf.js 는 15ms 조각 + rAF 로 나눠 그린다)
    const { tiles, maxMs } = await drawTiles(F.w.document, size.w, size.h, size.w, th, async (c, ox, oy) => {
      task = pg.render({ canvas: c, viewport: vp, transform: [sx, 0, 0, sy, -ox, -oy] });
      await task.promise;
    }, opt.signal, opt._tileLog);
    return { tiles, w: size.w, h: size.h, page: n, pages: N, view, renderMs: performance.now() - t0, maxTileMs: maxMs, label: N > 1 ? `${n}쪽` : '' };
  } finally { opt.signal?.removeEventListener('abort', onAbort); }
}

// ---- 도면(DXF·DWG — CadView) ----
function lum(rgb) {
  const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f((rgb >> 16) & 255) + 0.7152 * f((rgb >> 8) & 255) + 0.0722 * f(rgb & 255);
}
// 흰 종이에서 안 보이는 밝은 색(ACI 2 노랑·7 흰색 트루컬러 등)을 흰색과 대비 3:1 까지만 진하게 — 색은 남긴다
function paperColor(c, cache) {
  if (c === -3 || c < 0) return '#000000';
  let s = cache.get(c);
  if (s) return s;
  let rgb = c & 0xffffff;
  const want = 1.05 / 3 - 0.05;
  for (let i = 0; i < 40 && lum(rgb) > want; i++) {
    const r = ((rgb >> 16) & 255) * 0.88, g = ((rgb >> 8) & 255) * 0.88, b = (rgb & 255) * 0.88;
    rgb = (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
  }
  s = '#' + rgb.toString(16).padStart(6, '0');
  cache.set(c, s);
  return s;
}

async function snapCad(F, d, opt) {
  const view = d.cad.view, e = view.sc?.ext;
  if (!e || !e.every(Number.isFinite) || e[2] <= e[0] || e[3] <= e[1]) throw Object.assign(new Error('도면에 그릴 것이 없어요'), { code: 'EMPTY' });
  const m = CAD_MARGIN * Math.max(e[2] - e[0], e[3] - e[1]);
  const R = [e[0] - m, e[1] - m, e[2] + m, e[3] + m], RW = R[2] - R[0], RH = R[3] - R[1];
  // 지금 화면이 보던 도면 범위
  const [wx0, wyT] = view.toWorld(0, 0), [wx1, wyB] = view.toWorld(view.W, view.H);
  const vf = fracRect((wx0 - R[0]) / RW, (R[3] - wyT) / RH, (wx1 - R[0]) / RW, (R[3] - wyB) / RH);
  const size = planSize(RW, RH, vf, opt);
  // CSS px 배율 d: 선 굵기 1 CSS px = d 결과 px. 2400 결과에서 1.5 — 핀 지도가 줄여 보여 줘도 선이 사라지지 않게
  const dpr = Math.min(3, Math.max(1, Math.max(size.w, size.h) / 1600));
  const s = size.k / dpr;                                             // 도면 단위 → CSS px
  const cache = new Map();
  // 화면 CadView 를 원형으로 둔 대역 — 그리기 상태(g·cv·W·H·dpr·view)만 우리 것. slow 를 늘 false 로 둬 화면 사본(snapCv)을 만들지 않게
  const fake = Object.create(view, {
    g: { value: null, writable: true }, cv: { value: null, writable: true },
    W: { value: 1, writable: true }, H: { value: 1, writable: true }, dpr: { value: dpr, writable: true },
    view: { value: { s, tx: 0, ty: 0 }, writable: true },
    paper: { value: true, writable: true },
    bg: { value: '#FFFFFF' }, fg: { value: '#000000' },               // 뷰어 테마(어두운 모델 공간)와 상관없이 흰 종이
    measure: { value: { on: false, a: null, b: null, cur: null, hover: null } },
    slow: { get: () => false, set: () => {} },
    snapCv: { value: null, writable: true }, snapView: { value: null, writable: true },
    lastMs: { value: 0, writable: true }, work: { value: 0, writable: true },
    col: { value: c => paperColor(c, cache) },
  });
  const t0 = performance.now();
  const { tiles, maxMs } = await drawTiles(F.w.document, size.w, size.h, TILE, TILE, (c, ox, oy, tw, th) => {
    if (fake.cv !== c) { fake.cv = c; fake.g = c.getContext('2d', { alpha: false }); }
    fake.W = tw / dpr; fake.H = th / dpr;
    fake.view = { s, tx: -R[0] * s - ox / dpr, ty: R[3] * s - oy / dpr };
    fake.draw();
  }, opt.signal, opt._tileLog, { target: 40, min: 384, max: 1024 });
  return { tiles, w: size.w, h: size.h, page: 1, pages: 1, view: vf, renderMs: performance.now() - t0, maxTileMs: maxMs, label: '' };
}

// ---- 그림 ----
async function snapImage(F, d, opt) {
  const stage = d.els.stage;
  const inner = stage.querySelector('.av-image-inner');
  const box = inner?.parentElement;
  const src = inner?.querySelector(':scope > img') || inner?.querySelector(':scope > canvas:not(.detail)');
  if (!inner || !box || !src) throw Object.assign(new Error('그림이 아직 안 그려졌어요'), { code: 'LOADING' });
  const iw = parseFloat(inner.style.width) || src.naturalWidth || src.width, ih = parseFloat(inner.style.height) || src.naturalHeight || src.height;
  const tf = inner.style.transform || '';
  const rot = ((+(/rotate\((-?[\d.]+)deg\)/.exec(tf)?.[1] || 0) % 360) + 360) % 360;
  const flip = /scaleX\(\s*-1\s*\)/.test(tf) ? -1 : 1;
  const bw = rot % 180 ? ih : iw, bh = rot % 180 ? iw : ih;
  const pz = stage.querySelector('.av-pz') || stage;
  const view = domView(box.getBoundingClientRect(), pz.getBoundingClientRect());
  // 그림은 원본 화소보다 키우지 않는다(작은 그림을 늘려 봐야 흐리기만) — 쪽 크기 단위 = 원본 px
  const size = planSize(bw, bh, view, { ...opt, hardMax: Math.min(opt.hardMax ?? 4096, Math.max(bw, bh)) });
  const sw = rot % 180 ? size.h : size.w, sh = rot % 180 ? size.w : size.h;   // 돌리기 전 크기
  const t0 = performance.now();
  const isSvg = src.tagName === 'IMG' && (/svg/i.test(d.file?.type || '') || /\.svg$/i.test(d.name || ''));
  let payload;
  if (src.tagName === 'IMG' && !isSvg && d.file) payload = d.file;     // 원본 파일 → 워커가 줄이며 디코드(메인 0)
  else {
    // SVG(워커는 SVG 를 못 푼다)·TIFF/HEIC 축소본 canvas — 화면 요소에서 비트맵을 뜬다
    payload = await createImageBitmap(src, isSvg ? { resizeWidth: sw, resizeHeight: sh, resizeQuality: 'high' } : {});
  }
  return { src: payload, sw, sh, rot, flip, w: size.w, h: size.h, page: 1, pages: 1, view, renderMs: performance.now() - t0, label: '' };
}

// ---- 계약 ----
// snapshotFromFrame(iframeEl, opts) → { blob, w, h, page, pages, kind, view, name, viewer, label, ms }
//                                   | { unsupported: true, reason, message, kind: null, name?, viewer? }
//   view: { x, y, w, h } — 결과 그림 기준 0~1, 스냅샷 순간 화면에 보이던 부분(없으면 null)
//   name: 뷰어에 열린 파일 이름 / label: 여러 쪽 PDF 면 'n쪽'
//   opts: { maxSide = 2400, focusMin = 1000, hardMax = 4096, maxPx = 8e6, q = 0.9, signal }
//   ms: { render, encode, total, maxTile(조각 하나 최대 — 메인 멈춤 근사), via: 'worker'|'main' }
//   실패는 던진다 — err.code: 'EMPTY'(그릴 것 없음) | 'LOADING' | 'ENCODE' | 그 밖, 취소는 err.name 'AbortError'
export async function snapshotFromFrame(iframeEl, opts = {}) {
  const opt = { maxSide: 2400, focusMin: 1000, hardMax: 4096, maxPx: 8e6, q: Q, ...opts };
  const T0 = performance.now();
  const k = snapKind(iframeEl);
  if (!k.kind) return { unsupported: true, reason: k.reason, message: reasonText(k.reason), kind: null, name: k.name, viewer: k.viewer };
  const F = avOf(iframeEl), d = F.AV.active();
  const r = k.kind === 'pdf' ? await snapPdf(F, d, opt) : k.kind === 'cad' ? await snapCad(F, d, opt) : await snapImage(F, d, opt);
  if (opt.signal?.aborted) { closeJob(r); throw abortErr(); }
  const t1 = performance.now();
  const enc = await encode(r.tiles ? { tiles: r.tiles, w: r.w, h: r.h, q: opt.q } : { src: r.src, sw: r.sw, sh: r.sh, rot: r.rot, flip: r.flip, w: r.w, h: r.h, q: opt.q });
  const ms = { render: Math.round(r.renderMs), encode: Math.round(performance.now() - t1), total: Math.round(performance.now() - T0), via: enc.via };
  if (r.maxTileMs != null) ms.maxTile = Math.round(r.maxTileMs);
  return { blob: enc.blob, w: r.w, h: r.h, page: r.page, pages: r.pages, kind: k.kind, view: r.view, name: d.name, viewer: k.viewer, label: r.label, ms };
}

// 시험용
export const _workerState = () => ({ ok: wkOk, live: !!wk, fails: wkFails });
export function _forceMain(on) { wkOk = on ? false : null; if (on) killWorker(new Error('강제 메인')); }
