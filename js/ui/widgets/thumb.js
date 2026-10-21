// 썸네일 <img>(SPEC §5.7) — 지연 로딩(IntersectionObserver), render.thumbURL(화면 워터마크 설정 반영), data-photo-id·data-wm.
// 칸은 4:3 가로(css .thumb), object-fit: contain + 어두운 바탕 — 세로 사진이어도 아래쪽 워터마크 띠가 잘리지 않는다(설계 비평 UX-3).
// 사진·묶음(위치·내용)·설정이 바뀌면 스스로 다시 그린다(모듈 하나가 store.on 을 한 번만 구독). 처리 중 사진은 회색 「처리 중」, 실패는 회색 「!」.
import * as store from '../../data/store.js';
import * as render from '../../media/render.js';

const live = new Set();                            // 붙어 있는(또는 곧 붙을) 썸네일
let unsub = null;
let io = null;

// 회색 칸 + 글자(인라인 SVG data URI — 외부 리소스 아님)
const cell = (text) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
  `<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120"><rect width="160" height="120" fill="#8A8F8B"/>` +
  `<text x="80" y="66" font-family="system-ui,sans-serif" font-size="${text.length > 1 ? 22 : 40}" font-weight="800" fill="#fff" text-anchor="middle" dominant-baseline="middle">${text}</text></svg>`)}`;
const PROCESSING = cell('처리 중');
const FAILED = cell('!');

function wmOn() { try { return !!render.screenWatermark(); } catch { return false; } }

async function load(img) {
  const id = img.dataset.photoId;
  const my = (img._gen = (img._gen || 0) + 1);
  const p = store.photo?.(id);
  img.dataset.wm = wmOn() ? '1' : '0';
  if (p && p.state && p.state !== 'ready') {
    img.dataset.state = p.state;
    img.src = p.state === 'failed' ? FAILED : PROCESSING;
    img.alt = p.state === 'failed' ? '사진을 처리하지 못했어요' : '처리 중';
    return;
  }
  try {
    const url = await render.thumbURL(id);
    if (my !== img._gen) return;
    if (!url) throw new Error('주소 없음');
    img.dataset.state = 'ready';
    img.classList.remove('thumb-err');
    img.src = url;
  } catch (e) {
    if (my !== img._gen) return;
    console.warn('썸네일을 못 그렸어요', id, e);
    img.dataset.state = 'error';
    img.classList.add('thumb-err');
    img.src = FAILED;
  }
}

function want(img) { img._want = true; load(img); }

function ensure() {
  if (!io && typeof IntersectionObserver === 'function') {
    io = new IntersectionObserver(entries => {
      for (const en of entries) if (en.isIntersecting) { io.unobserve(en.target); want(en.target); }
    }, { rootMargin: '200px' });
  }
  if (!unsub && typeof store.on === 'function') {
    unsub = store.on(ch => {
      for (const img of [...live]) {
        if (!img.isConnected) { if (img._seen || Date.now() - img._t > 10000) live.delete(img); continue; }
        img._seen = true;
        if (ch?.settings) img.dataset.wm = wmOn() ? '1' : '0';
        if (!img._want) continue;
        const id = img.dataset.photoId;
        const p = store.photo?.(id);
        if (ch?.settings || ch?.photos?.has?.(id) || (p && ch?.records?.has?.(p.recordId))) load(img);
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
  img.src = PROCESSING;
  img.dataset.state = 'loading';
  if (onClick) {
    img.setAttribute('role', 'button');
    img.tabIndex = 0;
    img.addEventListener('click', e => onClick(photoId, e));
    img.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(photoId, e); } });
  }
  img._t = Date.now();
  live.add(img);
  if (io) io.observe(img); else want(img);
  return img;
}
