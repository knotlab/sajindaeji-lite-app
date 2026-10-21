// 썸네일(SPEC §5.7) — <span.thumb-box> 안에 <img.thumb data-photo-id data-wm> + 워터마크 띠 <div.thumb-wm>.
// 체감 속도(2026-10-21): 썸네일마다 워터마크를 구운 JPEG 를 다시 만들던 것(toDataURL, 동기)을 없앴다.
//  - 그림은 store 썸네일 주소를 그대로(브라우저가 따로 디코드), 워터마크는 render.paintBandDom 이 같은 layout 으로 띠만 겹친다(WYSIWYG).
//    띠를 canvas 로 하지 않는 까닭: 크롬은 canvas 마다 합성 레이어를 만들어, 목록에 수십~수백 개면 스크롤이 무거워졌다.
//  - 화면 가까이 온 것만 그린다(IntersectionObserver). 칸 크기는 ResizeObserver 로 받는다(강제 레이아웃 없음).
//  - 사진·묶음(위치·내용)·설정이 바뀌면 바뀐 썸네일만: 처리 끝 → 그림, 글 바뀜 → 띠만(그림은 그대로). 모듈 하나가 store.on 을 한 번만 구독.
//  - 처리 중: pipeline.preview(id) 가 있으면 그 미리보기(+띠), 없으면 회색 「처리 중」. 실패는 회색 「!」.
// 칸 모양(4:3 가로, object-fit)은 css .thumb 그대로 — 띠는 img 의 object-fit(contain|cover)을 따라 사진 영역 아래에 놓인다.
import * as store from '../../data/store.js';
import * as render from '../../media/render.js';

const live = new Set();                            // 붙어 있는(또는 곧 붙을) .thumb-box
let unsub = null, io = null, ro = null;
let pipe = null;                                   // pipeline 모듈(처리 중 미리보기 — 처음 필요할 때만 부른다)

// 회색 칸 + 글자(인라인 SVG data URI — 외부 리소스 아님)
const cell = (text) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120"><rect width="160" height="120" fill="#8A8F8B"/>` +
  `<text x="80" y="66" font-family="system-ui,sans-serif" font-size="${text.length > 1 ? 22 : 40}" font-weight="800" fill="#fff" text-anchor="middle" dominant-baseline="middle">${text}</text></svg>`)}`;
const PROCESSING = cell('처리 중');
const FAILED = cell('!');
// 불러오는 동안: 1×1 투명 GIF(칸의 어두운 바탕이 보인다). SVG 자리표시는 글자를 넣은 SVG 를 칸마다 그려(메인 스레드) 목록을 처음 띄울 때 느렸다
const BLANK = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

function wmOn() { try { return !!render.screenWatermark(); } catch { return false; } }
const overlay = () => typeof render.paintBandDom === 'function' && typeof render.wmFor === 'function';

function setSrc(img, url) { if (img.getAttribute('src') !== url) img.src = url; }

async function previewOf(id) {
  try {
    if (!pipe) pipe = await import('../../media/pipeline.js');
    if (typeof pipe.preview !== 'function') return null;
    const u = await pipe.preview(id);
    return typeof u === 'string' && u ? u : null;
  } catch { return null; }
}

// 띠 그리기 — 칸 크기·글·설정이 같으면 건너뛴다
function paintWm(box) {
  const img = box._img;
  if (!overlay() || !box._vis) return;
  const on = wmOn();
  const st = img.dataset.state;
  const showing = st === 'ready' || st === 'preview';
  const wm = on && showing ? render.wmFor(img.dataset.photoId, { on, w: img.naturalWidth, h: img.naturalHeight }) : null;
  if (!wm || !box._w || !box._h) { if (box._cv) { box._cv.hidden = true; box._wmKey = ''; } return; }
  if (!box._fit) box._fit = (getComputedStyle(img).objectFit === 'cover') ? 'cover' : 'contain';
  const key = `${wm.key}|${box._w}x${box._h}|${box._fit}`;
  if (key === box._wmKey && box._cv && !box._cv.hidden) return;
  if (!box._cv) { box._cv = document.createElement('div'); box._cv.className = 'thumb-wm'; box._cv.setAttribute('aria-hidden', 'true'); box.append(box._cv); }
  if (render.paintBandDom(box._cv, wm, box._w, box._h, { fit: box._fit })) box._wmKey = key;
}

async function load(box) {
  const img = box._img;
  const id = img.dataset.photoId;
  const my = (box._gen = (box._gen || 0) + 1);
  const p = store.photo?.(id);
  img.dataset.wm = wmOn() ? '1' : '0';
  if (p && p.state && p.state !== 'ready') {
    if (p.state === 'failed') {
      img.dataset.state = 'failed'; setSrc(img, FAILED); img.alt = '사진을 처리하지 못했어요';
      paintWm(box);
      return;
    }
    img.dataset.state = p.state; img.alt = '처리 중';
    const pv = await previewOf(id);
    if (my !== box._gen) return;
    if (pv) { img.dataset.state = 'preview'; setSrc(img, pv); }
    else setSrc(img, PROCESSING);
    paintWm(box);
    return;
  }
  try {
    const url = overlay() && typeof render.thumbSrc === 'function' ? await render.thumbSrc(id) : await render.thumbURL(id);
    if (my !== box._gen) return;
    if (!url) throw new Error('주소 없음');
    img.dataset.state = 'ready';
    img.classList.remove('thumb-err');
    setSrc(img, url);
    paintWm(box);
  } catch (e) {
    if (my !== box._gen) return;
    console.warn('썸네일을 못 그렸어요', id, e);
    img.dataset.state = 'error';
    img.classList.add('thumb-err');
    setSrc(img, FAILED);
    paintWm(box);
  }
}

function ensure() {
  if (!io && typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver(entries => {
      for (const en of entries) {
        const box = en.target;
        if (en.isIntersecting) {
          box._vis = true;
          if (!box._want) { box._want = true; load(box); } else paintWm(box);
        } else box._vis = false;                     // 띠는 그대로 둔다 — 다시 보일 때 다시 만들지 않게
      }
    }, { rootMargin: '300px' });
  }
  if (!ro && typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(entries => {                // 그림(img) 크기를 본다 — 띠는 그림 위에 놓인다
      for (const en of entries) {
        const box = en.target._box, r = en.contentRect;
        if (!box) continue;
        const w = Math.round(r.width * 10) / 10, hh = Math.round(r.height * 10) / 10;
        if (w === box._w && hh === box._h) continue;
        box._w = w; box._h = hh;
        if (box._want) paintWm(box);
      }
    });
  }
  if (!unsub && typeof store.on === 'function') {
    unsub = store.on(ch => {
      for (const box of [...live]) {
        if (!box.isConnected) {
          if (box._seen || Date.now() - box._t > 10000) { live.delete(box); io?.unobserve(box); ro?.unobserve(box._img); }
          continue;
        }
        box._seen = true;
        const img = box._img;
        if (ch?.settings) img.dataset.wm = wmOn() ? '1' : '0';
        if (!box._want) continue;
        const id = img.dataset.photoId;
        if (ch?.photos?.has?.(id)) { load(box); continue; }
        const p = store.photo?.(id);
        if (ch?.settings || (p && ch?.records?.has?.(p.recordId))) paintWm(box);
      }
    });
  }
}

export function thumb(photoId, { className, onClick, alt = '사진' } = {}) {
  ensure();
  const img = document.createElement('img');
  img.className = ['thumb', className].filter(Boolean).join(' ');
  img.dataset.photoId = photoId;
  img.dataset.wm = wmOn() ? '1' : '0';
  img.alt = alt;
  img.decoding = 'async';
  img.draggable = false;
  img.src = BLANK;
  img.dataset.state = 'loading';
  const box = document.createElement('span');
  box.className = 'thumb-box';
  box.append(img);
  box._img = img; img._box = box;
  img.addEventListener('load', () => { if (img.dataset.state === 'preview') paintWm(box); });   // 미리보기 크기를 알게 되면 띠
  if (onClick) {
    img.setAttribute('role', 'button');
    img.tabIndex = 0;
    img.addEventListener('click', e => onClick(photoId, e));
    img.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(photoId, e); } });
  }
  box._t = Date.now();
  live.add(box);
  ro?.observe(img);
  if (io) io.observe(box); else { box._vis = true; box._want = true; load(box); }
  return box;
}
