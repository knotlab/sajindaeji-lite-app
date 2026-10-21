// 크게 보기 `viewer` (SPEC §6.5) — 담당 G. params: { recordId, photoId }
// 원본 photoview.js 의 zoomer()(두 손가락 1~5배, 확대 중 한 손가락 이동, 두 번 탭 1↔2.5배)를 옮기고,
// 확대 안 된 상태에서 좌우로 밀면 이전/다음을 더했다. 넘기면 확대 초기화.
// 그림은 store 작업본 주소(render.viewSrc) 그대로 + 워터마크 띠 canvas 겹치기(render.paintBand, 작업본 화소 그대로 — 내보내기와 같은 모양).
// 예전처럼 사진마다 1600px JPEG 를 다시 만들지 않는다(toDataURL 동기 — 넘길 때마다 멈췄다). [워터마크 끄고 보기/켜고 보기]는 띠만 숨기고 보인다(이 화면에서만 임시).
import * as dom from '../dom.js';
import * as store from '../../data/store.js';
import * as render from '../../media/render.js';
import * as pipeline from '../../media/pipeline.js';
import * as native from '../../platform/native.js';
import { whenText } from '../../core/watermark.js';
import { fmtCoord, fmtAcc } from '../../core/geo.js';

const MAX_ZOOM = 5, DOUBLE_ZOOM = 2.5;
const TAP_MS = 300, TAP_SLOP = 10, DOUBLE_SLOP = 30;
const SWIPE_MIN = 56;                                                        // 이만큼 밀면 넘긴다(px)

function el(tag, attrs, ...kids) {
  const { onclick, hidden, ...rest } = attrs || {};
  const node = dom.h(tag, rest, ...kids);
  if (onclick) node.addEventListener('click', onclick);
  if (hidden) node.hidden = true;
  return node;
}
const ic = name => (typeof dom.icon === 'function' ? dom.icon(name) : document.createTextNode(''));
function safe(f, fallback) { try { const v = f(); return v === undefined ? fallback : v; } catch (err) { console.warn(err); return fallback; } }

// ---- 확대 제스처(원본 zoomer 이식 + 좌우 밀기) ----
// stage 가 포인터를 받아 img 에 translate·scale 을 건다(transform-origin 0 0 — CSS). 버튼이 받은 포인터는 건드리지 않는다.
export function zoomer(stage, img, { onSwipe } = {}) {
  let s = 1, tx = 0, ty = 0, pinch = null, tap = null, last = { t: -1e9, x: 0, y: 0 }, swipe = null;
  const ptr = new Map();
  const at = e => { const r = stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  function apply() {
    const r = stage.getBoundingClientRect();
    s = Math.min(MAX_ZOOM, s);
    if (s < 1.001) { s = 1; tx = 0; ty = 0; }
    else { tx = Math.min(0, Math.max(r.width * (1 - s), tx)); ty = Math.min(0, Math.max(r.height * (1 - s), ty)); }
    img.style.transition = '';
    img.style.transform = s === 1 ? '' : `translate(${tx}px, ${ty}px) scale(${s})`;
    stage.dataset.zoom = String(Math.round(s * 100) / 100);
  }
  function startPinch() {
    const [a, b] = [...ptr.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, s, tx, ty, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }
  function toggle(p) {
    if (s > 1.05) { s = 1; tx = 0; ty = 0; }
    else { tx = p.x - (p.x - tx) * (DOUBLE_ZOOM / s); ty = p.y - (p.y - ty) * (DOUBLE_ZOOM / s); s = DOUBLE_ZOOM; }
    apply();
  }

  stage.addEventListener('pointerdown', e => {
    if (e.target.closest?.('button')) return;
    const p = at(e);
    ptr.set(e.pointerId, p);
    try { stage.setPointerCapture(e.pointerId); } catch { /* 합성 이벤트 */ }
    if (ptr.size === 1) {
      tap = { id: e.pointerId, t: e.timeStamp, x: p.x, y: p.y, moved: false };
      swipe = s === 1 ? { id: e.pointerId, x: p.x, y: p.y, dx: 0, dy: 0 } : null;
    } else { tap = null; swipe = null; img.style.transform = s === 1 ? '' : img.style.transform; startPinch(); }
  });

  stage.addEventListener('pointermove', e => {
    const prev = ptr.get(e.pointerId);
    if (!prev) return;
    const p = at(e);
    ptr.set(e.pointerId, p);
    if (tap && Math.hypot(p.x - tap.x, p.y - tap.y) > TAP_SLOP) tap.moved = true;
    if (ptr.size >= 2 && pinch) {
      const [a, b] = [...ptr.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const ns = Math.min(MAX_ZOOM, Math.max(1, pinch.s * d / pinch.d)), k = ns / pinch.s;
      s = ns;
      tx = mx - (pinch.mx - pinch.tx) * k;
      ty = my - (pinch.my - pinch.ty) * k;
      apply();
    } else if (ptr.size === 1 && s > 1) {
      tx += p.x - prev.x; ty += p.y - prev.y;
      apply();
    } else if (ptr.size === 1 && swipe && swipe.id === e.pointerId) {      // 확대 안 됨 — 손가락을 따라 옆으로
      swipe.dx = p.x - swipe.x; swipe.dy = p.y - swipe.y;
      if (Math.abs(swipe.dx) > Math.abs(swipe.dy)) img.style.transform = `translateX(${swipe.dx}px)`;
    }
  });

  const up = e => {
    const p = ptr.get(e.pointerId);
    if (!p) return;
    const isTap = e.type === 'pointerup' && tap && tap.id === e.pointerId && !tap.moved && e.timeStamp - tap.t < TAP_MS;
    const sw = swipe && swipe.id === e.pointerId ? swipe : null;
    ptr.delete(e.pointerId);
    try { stage.releasePointerCapture(e.pointerId); } catch { /* 이미 풀림 */ }
    if (ptr.size >= 2) startPinch(); else pinch = null;
    tap = null; swipe = null;
    if (sw && s === 1) {
      const go = e.type === 'pointerup' && Math.abs(sw.dx) >= SWIPE_MIN && Math.abs(sw.dx) > Math.abs(sw.dy) * 1.5;
      img.style.transition = 'transform .15s ease-out';
      img.style.transform = '';
      if (go) { onSwipe?.(sw.dx < 0 ? 1 : -1); return; }
    }
    if (!isTap) return;
    if (e.timeStamp - last.t < TAP_MS && Math.hypot(p.x - last.x, p.y - last.y) < DOUBLE_SLOP) { last = { t: -1e9, x: 0, y: 0 }; toggle(p); }
    else last = { t: e.timeStamp, x: p.x, y: p.y };
  };
  stage.addEventListener('pointerup', up);
  stage.addEventListener('pointercancel', up);

  return {
    reset() { s = 1; tx = 0; ty = 0; pinch = null; tap = null; swipe = null; ptr.clear(); last = { t: -1e9, x: 0, y: 0 }; apply(); },
    scale: () => s,
  };
}

function mount(root, params = {}, nav = {}) {
  if (!params.recordId && params.photoId) params.recordId = safe(() => store.photo(params.photoId)?.recordId, undefined);
  let cur = params.photoId;
  let dead = false, leaving = false, token = 0;
  const s0 = safe(() => store.settings(), {});
  const screenWm = () => (typeof render.screenWatermark === 'function' ? !!safe(() => render.screenWatermark(), false) : (s0.wmMode !== 'off' && s0.wmOnScreen !== false));
  let wmOn = screenWm();
  let wmTouched = false;                                                    // 이 화면에서 직접 바꿨으면 설정 변경 알림에 끌려가지 않는다

  const liveIds = () => {
    const r = store.record(params.recordId);
    if (!r || r.deletedAt) return [];
    return safe(() => store.photosOf(r.id), []).map(p => p.id);
  };

  const closeBtn = el('button', { type: 'button', class: 'vw-close', 'aria-label': '닫기', onclick: () => leave() }, ic('close'), '닫기');
  const pos = el('span', { class: 'vw-pos', 'data-testid': 'viewer-pos' });
  const shareBtn = el('button', { type: 'button', class: 'icbtn vw-ic', 'aria-label': '공유', 'data-testid': 'viewer-share' }, ic('share'));
  const delBtn = el('button', { type: 'button', class: 'icbtn vw-ic', 'aria-label': '삭제', 'data-testid': 'viewer-delete' }, ic('trash'));
  const lock = (b, f) => (typeof dom.lockButton === 'function' ? dom.lockButton(b, f) : b.addEventListener('click', f));
  lock(shareBtn, doShare);
  lock(delBtn, doDelete);
  const top = el('div', { class: 'vw-top' }, closeBtn, pos, el('span', { class: 'vw-flex' }), shareBtn, delBtn);

  const img = el('img', { class: 'vw-img', alt: '', draggable: 'false', 'data-testid': 'viewer-img' });
  img.decoding = 'async';
  img.hidden = true;
  const band = el('canvas', { class: 'vw-band', 'aria-hidden': 'true' });
  band.hidden = true;
  const pic = el('div', { class: 'vw-pic' }, img, band);                   // 확대·밀기는 그림과 띠를 같이 움직인다
  const ph = el('div', { class: 'vw-ph' });
  const prevBtn = el('button', { type: 'button', class: 'vw-nav prev', 'aria-label': '이전 사진', 'data-testid': 'viewer-prev', onclick: () => step(-1) }, ic('left'));
  const nextBtn = el('button', { type: 'button', class: 'vw-nav next', 'aria-label': '다음 사진', 'data-testid': 'viewer-next', onclick: () => step(1) }, ic('right'));
  const stage = el('div', { class: 'vw-stage', 'data-zoom': '1' }, pic, ph, prevBtn, nextBtn);
  const zoom = zoomer(stage, pic, { onSwipe: d => step(d) });
  const overlay = typeof render.viewSrc === 'function' && typeof render.paintBand === 'function';
  let stageW = 0, stageH = 0;
  function paintBand() {
    if (!overlay) return;
    const id = img.dataset.photoId;
    const wm = wmOn && !img.hidden && id ? safe(() => render.wmFor(id, { on: true, w: img.naturalWidth, h: img.naturalHeight }), null) : null;
    render.paintBand(band, wm, stageW, stageH, { fit: 'contain', res: 'work' });
  }
  const sro = typeof ResizeObserver === 'function' ? new ResizeObserver(en => {
    const r = en[0]?.contentRect; if (!r) return;
    if (Math.round(r.width) === stageW && Math.round(r.height) === stageH) return;
    stageW = Math.round(r.width); stageH = Math.round(r.height);
    paintBand();
  }) : null;
  sro?.observe(stage);
  img.addEventListener('load', () => { if (!dead && !stageW) { stageW = stage.clientWidth; stageH = stage.clientHeight; } paintBand(); });
  const warm = [];                                                         // 앞뒤 1장 미리 받아 디코드(넘길 때 바로 보이게)

  const infoLoc = el('p', { class: 'vw-loc' });
  const infoContent = el('p', { class: 'vw-content', 'data-testid': 'viewer-content' });   // 묶음 내용 — 워터마크를 끄거나 '위치만'이어도 보이게
  const infoMeta = el('p', { class: 'vw-meta' });
  const infoOrig = el('p', { class: 'vw-orig' });
  const wmBtn = el('button', { type: 'button', class: 'vw-wm', 'data-testid': 'viewer-wm-toggle', onclick: () => { wmOn = !wmOn; wmTouched = true; paint(true); } });
  const info = el('div', { class: 'vw-info' }, infoLoc, infoContent, infoMeta, infoOrig, wmBtn);

  let retrying = false;
  async function retryCur() {                                                // 처리 실패 → 다시 처리(원본 incoming 이 남아 있을 때)
    if (retrying) return;
    retrying = true;
    const id = cur;
    ph.replaceChildren('다시 처리하는 중…');
    try { const ok = await pipeline.reprocess(id); if (!ok) dom.toast?.('다시 처리하지 못했어요'); }
    catch (err) { console.warn('다시 처리 실패', err); dom.toast?.('다시 처리하지 못했어요'); }
    finally { retrying = false; if (!dead) paint(true); }
  }

  root.append(el('div', { class: 'vw' }, top, stage, info));

  function leave() {
    if (leaving) return;
    leaving = true;
    nav.back ? nav.back() : history.back();
  }

  async function show(id, force) {
    const p = store.photo(id);
    const my = ++token;
    if (!p || p.state !== 'ready') {
      img.hidden = true; img.removeAttribute('src'); band.hidden = true; img.dataset.photoId = '';
      ph.hidden = false;
      ph.textContent = !p ? '사진을 찾을 수 없어요' : p.state === 'failed' ? '이 사진은 처리하지 못했어요' : '처리 중이에요…';
      if (p?.state === 'failed' && !retrying && safe(() => pipeline.canRetry(p), false)) {
        ph.replaceChildren(el('div', { class: 'vw-retry' }, el('span', {}, '이 사진은 처리하지 못했어요'),
          el('button', { type: 'button', class: 'vw-retry-btn', 'data-testid': 'viewer-retry', onclick: () => retryCur() }, '다시 처리')));
      }
      img.dataset.wm = '0';
      return;
    }
    const key = `${id}|${wmOn}`;
    if (!force && img.dataset.key === key && !img.hidden) return;
    let url = null;
    try { url = overlay ? await render.viewSrc(id) : await render.viewURL(id, { watermark: wmOn }); }
    catch (err) { console.warn('사진을 그리지 못했어요', err); }
    if (dead || my !== token) return;
    if (!url) { img.hidden = true; band.hidden = true; ph.hidden = false; ph.textContent = '사진을 불러오지 못했어요'; return; }
    const same = img.dataset.photoId === id && img.getAttribute('src') === url;
    if (img.dataset.photoId !== id) { img.removeAttribute('src'); band.hidden = true; }   // 다른 사진이면 옛 사진·띠가 남지 않게
    if (!same) img.src = url;
    img.dataset.photoId = id; img.dataset.key = key; img.dataset.wm = wmOn ? '1' : '0';
    img.hidden = false; ph.hidden = true;
    if (same || img.complete) paintBand();                                   // 같은 그림이면 띠만(워터마크 켜고 끄기·글 바뀜)
    // 앞뒤 1장 미리 받아 두기 — 디코드는 브라우저가 따로 한다(인코딩 없음)
    const ids = liveIds(), i = ids.indexOf(id);
    warm.length = 0;
    for (const n of [ids[i + 1], ids[i - 1]]) {
      if (!n || store.photo(n)?.state !== 'ready') continue;
      if (overlay) render.viewSrc(n).then(u => { if (!u || dead) return; const im = new Image(); im.decoding = 'async'; im.src = u; im.decode?.().catch(() => {}); warm.push(im); }).catch(() => {});
      else render.viewURL(n, { watermark: wmOn }).catch(() => {});
    }
  }

  function paint(force = false) {
    if (dead || leaving) return;
    const ids = liveIds();
    if (!ids.length) { leave(); return; }
    if (!ids.includes(cur)) {                                                // 지워졌으면 그 자리 다음 사진으로
      const all = store.record(params.recordId)?.photoIds || [];
      const at = all.indexOf(cur);
      cur = all.slice(at + 1).find(x => ids.includes(x)) || [...all.slice(0, Math.max(0, at))].reverse().find(x => ids.includes(x)) || ids[0];
      params.photoId = cur;
      zoom.reset();
    }
    const i = ids.indexOf(cur);
    pos.textContent = `${i + 1} / ${ids.length}`;
    prevBtn.disabled = i <= 0; nextBtn.disabled = i >= ids.length - 1;
    prevBtn.hidden = nextBtn.hidden = ids.length < 2;

    const settings = safe(() => store.settings(), {});
    wmBtn.hidden = settings.wmMode === 'off';
    wmBtn.textContent = wmOn ? '워터마크 끄고 보기' : '워터마크 켜고 보기';
    wmBtn.setAttribute('aria-pressed', String(wmOn));

    const p = store.photo(cur), r = store.record(params.recordId);
    const locT = (r?.location || '').trim();
    infoLoc.textContent = locT || '위치 미입력';
    infoLoc.classList.toggle('is-empty', !locT);
    const conT = (r?.content || '').trim();
    infoContent.textContent = conT;
    infoContent.hidden = !conT;
    const bits = [p ? safe(() => whenText(p), '') : ''];
    if (p?.gps && Number.isFinite(p.gps.lat)) bits.push(`${fmtCoord(p.gps.lat, p.gps.lng)} ${fmtAcc(p.gps.acc)}`.trim());
    infoMeta.textContent = bits.filter(Boolean).join(' · ');
    let orig = '';
    if (safe(() => native.isNative(), false) && p) {
      if (p.original?.savedTo) orig = `원본: ${p.original.savedTo} 갤러리에 저장됨`;
      else if (p.original?.error) orig = '원본을 갤러리에 못 넣었어요 · 설정에서 다시 저장';
      else if (p.source === 'gallery') orig = '갤러리에서 가져온 사진';
    }
    infoOrig.textContent = orig;
    infoOrig.hidden = !orig;
    infoOrig.classList.toggle('bad', !!p?.original?.error && !p?.original?.savedTo);
    show(cur, force);
  }

  function step(dir) {
    const ids = liveIds(), to = ids[ids.indexOf(cur) + dir];
    if (!to) return;
    cur = to; params.photoId = to;
    zoom.reset();
    paint();
  }

  async function doShare() {
    try {
      const share = await import('../../services/share.js');                  // 공유 모듈은 누를 때만 부른다
      const { afterShare } = await import('../widgets/sharefollow.js');
      await afterShare(await share.sharePhoto(cur));                          // 취소는 조용히, 활성화가 끝났으면 [공유하기] 시트
    }
    catch (err) { console.error('공유 실패', err); dom.toast?.('공유하지 못했어요'); }
  }

  async function doDelete() {
    const id = cur;
    try { await store.deletePhoto(id, Date.now()); }
    catch (err) { console.error('사진 삭제 실패', err); dom.toast?.('사진을 지우지 못했어요'); return; }
    const undo = async () => {
      try { await store.restorePhoto(id, Date.now()); }
      catch (err) { console.error('되돌리기 실패', err); dom.toast?.('되돌리지 못했어요'); }
    };
    if (typeof dom.snackbar === 'function') dom.snackbar('사진을 지웠어요', { actionLabel: '되돌리기', onAction: undo });
    else dom.toast?.('사진을 지웠어요');
    paint();                                                                 // 다음 사진으로(없으면 닫힘)
  }

  const onKey = e => {
    if (e.key === 'ArrowLeft') step(-1);
    else if (e.key === 'ArrowRight') step(1);
  };
  document.addEventListener('keydown', onKey);

  const off = safe(() => store.on(ch => {
    if (dead) return;
    if (ch?.settings && !wmTouched) wmOn = screenWm();
    paint(!!ch?.settings || !!ch?.records?.has?.(params.recordId));
  }), null);

  if (!store.photo(cur) || !liveIds().includes(cur)) {
    if (liveIds().length) { cur = liveIds()[0]; params.photoId = cur; }
  }
  paint();
  return () => {
    dead = true;
    sro?.disconnect();
    warm.length = 0;
    band.width = 0; band.height = 0;
    document.removeEventListener('keydown', onKey);
    if (typeof off === 'function') off();
  };
}

export default { dark: true, mount };
