// 핀 지도 — 도면 스냅샷(그림 한 장) 위에 묶음 핀(번호)을 보여 주고(view), 찍는다(place).
// 사용자 요구: "도면 띄운 다음에 사진 찍으면서 도면에 위치도 찍을 수 있게". 지연에 민감하므로 가볍게:
//   · 큰 그림은 한 번만 디코드(img.decode) — 그림 요소 하나에 transform 만 건다(will-change, transform-origin 0 0). 레이아웃·다시 그리기 없음.
//   · 포인터 이동은 값만 바꾸고 그리기는 rAF 한 번으로 모은다(이벤트마다 DOM 쓰기 없음). DOM 을 읽는 건 크기가 바뀔 때(ResizeObserver)뿐.
//   · 핀은 그림과 따로 겹친 층 — 화면 확대와 상관없이 크기 일정(30px, 지금 묶음 38px). 겹침 풀기는 손을 뗄 때만(움직이는 동안 핀이 춤추지 않게).
// 확대·이동은 screens/viewer.js 의 zoomer 방식(두 손가락 확대 + 확대 중심 따라 이동, 한 손가락 이동, 두 번 탭)을 새로 구현 — 1~8배(맞춤 기준).
// place 모드: 가운데 십자 + [여기에 찍기](장갑 낀 손가락이 자리를 가리지 않게) 와 탭한 자리에 바로 찍기 둘 다. 찍은 핀(지금 묶음)은 끌어서 미세 조정.
// 좌표는 모두 그림 기준 0~1 비율(x 오른쪽, y 아래). pins 는 core/locmap.js dayPins() 결과({ id, label, x, y, … })를 그대로 받아도 된다.
// 위치도 JPEG(내보내기)는 media/locmapimg.js renderLocMap 몫 — 여기서는 화면만.
import { h, icon } from '../dom.js';

const MIN_Z = 1, MAX_Z = 8, DOUBLE_K = 2.5, FOCUS_Z = 3;
const TAP_MS = 300, TAP_SLOP = 10, DOUBLE_SLOP = 36, DRAG_SLOP = 3;
const PIN = 30, PIN_ON = 38;                 // css/pinmap.css 의 --pm-pin / --pm-pin-on 과 같게
const ANIM_MS = 180;
const reduced = () => { try { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const r5 = v => Math.round(v * 1e5) / 1e5;
const okXY = p => Number.isFinite(p?.x) && Number.isFinite(p?.y);
const DRAFT = '__draft';

// pins: [{ id, x, y, label, active, dim? }]
//   active = 지금 묶음(크게). place 모드에서는 active 핀이 찍고 옮기는 핀이다(x·y 가 null 이면 아직 안 찍음).
//   active 핀이 없는데 찍으면 placeLabel 번호로 임시 핀을 만든다.
//   dim = 흐리게(그 날 다른 묶음). 안 주면 active 핀이 있을 때 나머지를 흐리게(번호는 그대로 읽힘).
// 덤(계약 밖, 있어도 되고 안 써도 됨): gestures=false(미니 지도 — 손짓 없음, 페이지 스크롤 그대로), controls(+/− 단추), placeLabel,
//   반환에 setSrc(src, w, h)(다시 찍은 스냅샷), placed() → {x,y}|null, view() → 지금 보이는 비율 사각형, zoom() → 배율.
export function pinMap({ src, w = 0, h: ih = 0, pins = [], view = null, mode = 'view', onPlace, onTapPin,
  gestures = true, controls = gestures, placeLabel = '' } = {}) {
  let W = 0, H = 0, fit = 1, z = 1, tx = 0, ty = 0;
  let iw = w || 0, ihh = ih || 0;
  let ready = false, dead = false, raf = 0, anim = 0, settleT = 0, initView = view;
  let list = [];                              // 정리된 핀 [{ id, x, y, label, active, dim }]
  const nodes = new Map();                    // id → { el, badge, ox, oy, sig }
  let drag = null, pinch = null, tap = null, last = { t: -1e9, x: 0, y: 0 };
  const ptr = new Map();

  // ---------- DOM ----------
  const img = h('img', { class: 'pm-img', alt: '', draggable: 'false', 'aria-hidden': 'true' });
  img.decoding = 'async';
  const pinLayer = h('div', { class: 'pm-pins' });
  const cross = h('div', { class: 'pm-cross', 'data-testid': 'pin-cross', 'aria-hidden': 'true' }, h('i'), h('i'), h('b'));
  const msg = h('p', { class: 'pm-msg' }, '도면 그림을 여는 중…');
  const zin = h('button', { type: 'button', class: 'pm-zbtn', 'aria-label': '확대', 'data-testid': 'pin-zoom-in', onclick: () => zoomBy(DOUBLE_K / 1.25) }, icon('plus', 22));
  const zout = h('button', { type: 'button', class: 'pm-zbtn', 'aria-label': '축소', 'data-testid': 'pin-zoom-out', onclick: () => zoomBy(1.25 / DOUBLE_K) }, icon('minus', 22));
  const zbox = h('div', { class: 'pm-zoom' }, zin, zout);
  zbox.hidden = !controls;
  const stage = h('div', {
    class: 'pm-stage', 'data-testid': 'pinmap-stage', 'data-zoom': '1', tabindex: gestures ? '0' : null, role: gestures ? 'application' : null,
    'aria-label': gestures ? '도면 지도. 두 손가락으로 확대, 끌어서 이동해요' : null,
  }, img, pinLayer, cross, msg, zbox);
  const hint = h('p', { class: 'pm-hint', role: 'status', 'aria-live': 'polite' });
  const placeBtn = h('button', { type: 'button', class: 'pm-place', 'data-testid': 'pin-place', onclick: () => placeAtCenter() }, icon('locate', 22), h('span', {}, '여기에 찍기'));
  const bar = h('div', { class: 'pm-bar' }, hint, placeBtn);
  const el = h('div', { class: 'pinmap', 'data-testid': 'pinmap', 'data-mode': mode, 'data-ready': '0' }, stage, bar);
  if (!gestures) el.classList.add('pm-static');

  // ---------- 좌표 ----------
  const sc = () => fit * z;
  const toScreen = (x, y) => [tx + x * iw * sc(), ty + y * ihh * sc()];
  const toImage = (px, py) => [(px - tx) / (iw * sc()), (py - ty) / (ihh * sc())];
  // 화면 위치는 손짓을 시작할 때 한 번만 읽는다(이동 중 getBoundingClientRect 가 스타일 계산을 강제하지 않게)
  let box = null;
  const at = e => { const r = box || stage.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };

  // 화면 밖으로 끌리지 않게: view 는 그림이 화면을 벗어나지 않게(작으면 가운데), place 는 그림의 어느 점이든 십자(가운데)에 올 수 있게.
  function clampView() {
    z = clamp(z, MIN_Z, MAX_Z);
    const sw = iw * sc(), sh = ihh * sc();
    if (mode === 'place') {
      tx = clamp(tx, W / 2 - sw, W / 2); ty = clamp(ty, H / 2 - sh, H / 2);
    } else {
      tx = sw <= W ? (W - sw) / 2 : clamp(tx, W - sw, 0);
      ty = sh <= H ? (H - sh) / 2 : clamp(ty, H - sh, 0);
    }
  }
  function zoomAround(px, py, nz) {
    nz = clamp(nz, MIN_Z, MAX_Z);
    const k = nz / z;
    tx = px - (px - tx) * k; ty = py - (py - ty) * k; z = nz;
    clampView(); paint();
  }
  function zoomBy(k) { if (ready) { stopAnim(); zoomAround(W / 2, H / 2, z * k); settleSoon(); } }

  // ---------- 그리기(rAF 한 번에 모음) ----------
  function paint() { if (!raf && !dead) raf = requestAnimationFrame(draw); }
  function draw() {
    raf = 0;
    if (!ready || dead) return;
    const s = sc();
    img.style.transform = `translate3d(${tx}px,${ty}px,0) scale(${s})`;
    for (const p of list) {
      const n = nodes.get(p.id);
      if (!n) continue;
      if (!okXY(p)) { if (!n.el.hidden) n.el.hidden = true; continue; }
      if (n.el.hidden) n.el.hidden = false;
      n.el.style.transform = `translate3d(${(tx + p.x * iw * s).toFixed(1)}px,${(ty + p.y * ihh * s).toFixed(1)}px,0)`;
    }
    const zs = String(Math.round(z * 100) / 100);
    if (stage.dataset.zoom !== zs) stage.dataset.zoom = zs;
    zin.disabled = z >= MAX_Z - 1e-3; zout.disabled = z <= MIN_Z + 1e-3;
  }

  // ---------- 핀 ----------
  function norm(arr) {
    const out = [];
    const seen = new Set();
    for (const p of arr || []) {
      if (!p || p.id == null || seen.has(String(p.id))) continue;
      seen.add(String(p.id));
      out.push({ id: String(p.id), x: Number.isFinite(p.x) ? clamp(+p.x, 0, 1) : null, y: Number.isFinite(p.y) ? clamp(+p.y, 0, 1) : null,
        label: p.label == null ? '' : String(p.label), active: !!p.active, dim: p.dim });
    }
    return out;
  }
  function build(p) {
    const badge = h('span', { class: 'pm-badge' }, p.label);
    const pinEl = h('button', { type: 'button', class: 'pm-pin', 'data-testid': 'pin', 'data-id': p.id, tabindex: '-1' },
      h('span', { class: 'pm-dot', 'aria-hidden': 'true' }), badge);
    pinEl.addEventListener('click', e => { if (e.detail === 0 && mode === 'view') onTapPin?.(p.id); });   // 키보드(Enter)만 — 손가락 탭은 stage 가 판단
    return { el: pinEl, badge, ox: 0, oy: 0, sig: '' };
  }
  function syncPins() {
    const anyActive = list.some(p => p.active);
    const keep = new Set();
    for (const p of list) {
      keep.add(p.id);
      let n = nodes.get(p.id);
      if (!n) { n = build(p); nodes.set(p.id, n); }
      const dim = p.dim ?? (anyActive && !p.active);
      const sig = `${p.label}|${p.active}|${dim}`;
      if (n.sig !== sig) {
        n.sig = sig;
        n.badge.textContent = p.label;
        n.el.classList.toggle('is-on', p.active);
        n.el.classList.toggle('is-dim', !!dim);
        n.el.setAttribute('aria-label', `${p.label ? `${p.label}번 ` : ''}핀${p.active ? ' (지금 묶음)' : ''}`);
      }
    }
    for (const [id, n] of nodes) if (!keep.has(id)) { n.el.remove(); nodes.delete(id); }
    // 그리는 순서: 흐린 것 → 보통 → 지금 묶음(맨 위). 순서가 같으면 DOM 을 건드리지 않는다
    const order = [...list].sort((a, b) => rank(a) - rank(b));
    order.forEach((p, i) => { const e = nodes.get(p.id).el; if (pinLayer.children[i] !== e) pinLayer.insertBefore(e, pinLayer.children[i] || null); });
    const tappable = mode === 'view' && !!onTapPin && gestures;
    el.dataset.tap = tappable ? '1' : '0';
    for (const p of list) nodes.get(p.id).el.tabIndex = tappable && okXY(p) ? 0 : -1;
  }
  const rank = p => (p.active ? 2 : (p.dim ?? list.some(q => q.active)) ? 0 : 1);

  // 겹치면 번호가 읽히게 조금 비켜 놓는다(지금 묶음은 제자리). 비킨 핀은 제자리에 작은 점을 남긴다.
  function untangle() {
    if (!ready) return;
    const placed = [];
    const order = [...list].filter(okXY).sort((a, b) => (b.active - a.active));
    for (const p of order) {
      const n = nodes.get(p.id);
      const [px, py] = toScreen(p.x, p.y);
      const d = p.active ? PIN_ON : PIN;
      let best = [0, 0];
      if (!p.active && placed.length) {
        const free = (ox, oy) => placed.every(q => Math.hypot(px + ox - q.x, py + oy - q.y) >= (d + q.d) / 2 + (q.on ? 3 : 0) - 2);   // 지금 묶음 핀은 흰 테까지 피한다
        if (!free(0, 0)) {
          best = null;
          for (const [ring, steps] of [[1.15, 12], [1.9, 16]]) {
            for (let i = 0; i < steps && !best; i++) {
              const a = -Math.PI / 4 + i * 2 * Math.PI / steps;
              const ox = Math.cos(a) * d * ring, oy = Math.sin(a) * d * ring;
              if (free(ox, oy)) best = [ox, oy];
            }
            if (best) break;
          }
          best = best || [0, 0];
        }
      }
      placed.push({ x: px + best[0], y: py + best[1], d, on: p.active });
      const [ox, oy] = [Math.round(best[0]), Math.round(best[1])];
      if (n.ox !== ox || n.oy !== oy) {
        n.ox = ox; n.oy = oy;
        n.el.style.setProperty('--ox', `${ox}px`); n.el.style.setProperty('--oy', `${oy}px`);
        n.el.classList.toggle('is-off', ox !== 0 || oy !== 0);
      }
    }
  }
  function settleSoon(ms = 120) { clearTimeout(settleT); settleT = setTimeout(() => { settleT = 0; if (!dead) untangle(); }, ms); }

  // ---------- 찍기 ----------
  function activePin() { return list.find(p => p.active) || null; }
  function setHint() {
    if (mode !== 'place') return;
    const a = activePin();
    hint.textContent = a && okXY(a) ? '찍었어요. 핀을 끌어 옮겨도 돼요' : '누른 곳에 찍혀요. 십자로 맞춰도 돼요';
    placeBtn.lastChild.textContent = a && okXY(a) ? '여기로 옮기기' : '여기에 찍기';
  }
  function place(x, y, emit = true) {
    if (mode !== 'place' || !ready) return;
    x = r5(clamp(x, 0, 1)); y = r5(clamp(y, 0, 1));
    let a = activePin();
    if (!a) { a = { id: DRAFT, x: null, y: null, label: placeLabel, active: true }; list.push(a); syncPins(); }
    a.x = x; a.y = y;
    el.dataset.placed = '1';
    setHint(); paint(); untangle();
    if (emit) { try { onPlace?.(x, y); } catch (err) { console.error('핀 찍기 처리 실패', err); } }
  }
  function placeAtCenter() {
    if (!ready) return;
    const [x, y] = toImage(W / 2, H / 2);
    place(x, y);
  }

  // ---------- 손짓 ----------
  function startPinch() {
    const [a, b] = [...ptr.values()];
    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z, tx, ty, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }
  function onDown(e) {
    if (!ready || e.button > 0 || e.target.closest?.('.pm-zoom')) return;
    stopAnim();
    if (!ptr.size && !drag) box = stage.getBoundingClientRect();
    const p = at(e);
    const pinEl = e.target.closest?.('.pm-pin');
    const a = activePin();
    if (mode === 'place' && ptr.size === 0 && pinEl && a && pinEl.dataset.id === a.id && okXY(a)) {  // 지금 묶음 핀 끌기
      const [sx, sy] = toScreen(a.x, a.y);
      drag = { id: e.pointerId, x0: p.x, y0: p.y, sx, sy, moved: false };
      pinEl.classList.add('is-drag');
      try { stage.setPointerCapture(e.pointerId); } catch { /* 합성 이벤트 */ }
      e.preventDefault();
      return;
    }
    if (drag) return;
    ptr.set(e.pointerId, p);
    try { stage.setPointerCapture(e.pointerId); } catch { /* 합성 이벤트 */ }
    if (ptr.size === 1) tap = { id: e.pointerId, t: e.timeStamp, x: p.x, y: p.y, moved: false, pin: pinEl?.dataset.id || null };
    else { tap = null; startPinch(); }
  }
  function onMove(e) {
    if (drag && drag.id === e.pointerId) {
      const p = at(e);
      const dx = p.x - drag.x0, dy = p.y - drag.y0;
      if (!drag.moved && Math.hypot(dx, dy) < DRAG_SLOP) return;
      drag.moved = true;
      const a = activePin();
      if (!a) return;
      const [x, y] = toImage(drag.sx + dx, drag.sy + dy);
      a.x = clamp(x, 0, 1); a.y = clamp(y, 0, 1);
      paint();
      return;
    }
    const prev = ptr.get(e.pointerId);
    if (!prev) return;
    const p = at(e);
    ptr.set(e.pointerId, p);
    if (tap && Math.hypot(p.x - tap.x, p.y - tap.y) > TAP_SLOP) tap.moved = true;
    if (ptr.size >= 2 && pinch) {
      const [a, b] = [...ptr.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      const nz = clamp(pinch.z * d / pinch.d, MIN_Z, MAX_Z), k = nz / pinch.z;
      z = nz;
      tx = mx - (pinch.mx - pinch.tx) * k;
      ty = my - (pinch.my - pinch.ty) * k;
      clampView(); paint();
    } else if (ptr.size === 1 && (!tap || tap.moved)) {
      tx += p.x - prev.x; ty += p.y - prev.y;
      clampView(); paint();
    }
  }
  function onUp(e) {
    if (drag && drag.id === e.pointerId) {
      const d = drag;
      drag = null;
      try { stage.releasePointerCapture(e.pointerId); } catch { /* 이미 풀림 */ }
      const a = activePin();
      if (a) nodes.get(a.id)?.el.classList.remove('is-drag');
      if (d.moved && a && e.type === 'pointerup') place(a.x, a.y);
      else if (d.moved && a) { const [x, y] = toImage(d.sx, d.sy); a.x = x; a.y = y; paint(); }   // 취소면 제자리
      untangle();
      return;
    }
    const p = ptr.get(e.pointerId);
    if (!p) return;
    const t = tap && tap.id === e.pointerId ? tap : null;
    const isTap = e.type === 'pointerup' && t && !t.moved && e.timeStamp - t.t < TAP_MS;
    ptr.delete(e.pointerId);
    try { stage.releasePointerCapture(e.pointerId); } catch { /* 이미 풀림 */ }
    if (ptr.size >= 2) startPinch(); else pinch = null;
    tap = null;
    if (!ptr.size) settleSoon(0);
    if (!isTap) return;
    const dbl = e.timeStamp - last.t < TAP_MS && Math.hypot(p.x - last.x, p.y - last.y) < DOUBLE_SLOP;
    if (dbl) {                                                               // 두 번 탭: 그 자리를 2.5배씩, 끝까지면 맞춤으로
      last = { t: -1e9, x: 0, y: 0 };
      animateTo(z >= MAX_Z - 1e-3 ? MIN_Z : z * DOUBLE_K, ...toImage(p.x, p.y), p.x, p.y);
      return;
    }
    last = { t: e.timeStamp, x: p.x, y: p.y };
    if (mode === 'place') {                                                  // 탭한 자리에 바로(기다리지 않음 — 두 번 탭이면 같은 자리에서 확대만 더해진다)
      const [x, y] = toImage(p.x, p.y);
      if (x >= -0.01 && x <= 1.01 && y >= -0.01 && y <= 1.01) place(x, y);
    } else if (t.pin) onTapPin?.(t.pin);
  }
  function onWheel(e) {
    if (!ready) return;
    e.preventDefault();
    stopAnim();
    box = null;
    const p = at(e);
    zoomAround(p.x, p.y, z * Math.exp(-clamp(e.deltaY, -120, 120) * 0.0025));
    settleSoon();
  }
  function onKey(e) {
    if (!ready || e.target !== stage) return;
    const step = 0.15;
    const k = e.key;
    if (k === 'ArrowLeft') tx += W * step; else if (k === 'ArrowRight') tx -= W * step;
    else if (k === 'ArrowUp') ty += H * step; else if (k === 'ArrowDown') ty -= H * step;
    else if (k === '+' || k === '=') { zoomBy(DOUBLE_K / 1.25); e.preventDefault(); return; }
    else if (k === '-') { zoomBy(1.25 / DOUBLE_K); e.preventDefault(); return; }
    else if (k === 'Enter' && mode === 'place') { placeAtCenter(); e.preventDefault(); return; }
    else return;
    e.preventDefault();
    clampView(); paint(); settleSoon();
  }
  if (gestures) {
    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
    stage.addEventListener('wheel', onWheel, { passive: false });
    stage.addEventListener('keydown', onKey);
  }

  // ---------- 움직임(맞춤 이동·두 번 탭) — rAF 로 값만 보간, 움직임 줄이기면 바로 ----------
  function stopAnim() { if (anim) { cancelAnimationFrame(anim); anim = 0; } }
  // 배율 nz 로, 그림 점 (cx,cy) 가 화면 점 (px,py) 에 오게
  function animateTo(nz, cx, cy, px = W / 2, py = H / 2) {
    stopAnim();
    nz = clamp(nz, MIN_Z, MAX_Z);
    const z0 = z, [c0x, c0y] = toImage(px, py);
    const end = () => { z = nz; tx = px - cx * iw * fit * z; ty = py - cy * ihh * fit * z; clampView(); paint(); settleSoon(0); };
    if (reduced()) { end(); return; }
    const t0 = performance.now();
    const step = now => {
      const k = Math.min(1, (now - t0) / ANIM_MS), e = 1 - (1 - k) ** 3;
      z = z0 + (nz - z0) * e;
      const ix = c0x + (cx - c0x) * e, iy = c0y + (cy - c0y) * e;
      tx = px - ix * iw * fit * z; ty = py - iy * ihh * fit * z;
      clampView(); draw();
      if (k < 1 && !dead) anim = requestAnimationFrame(step); else { anim = 0; end(); }
    };
    anim = requestAnimationFrame(step);
  }

  // ---------- 크기 ----------
  function measure(width, height) {
    if (!width || !height || !iw || !ihh) return;
    const first = !W || !H;
    const [cx, cy] = first ? [0.5, 0.5] : toImage(W / 2, H / 2);
    W = width; H = height;
    fit = Math.min(W / iw, H / ihh);
    if (first && ready) { applyView(initView); return; }
    tx = W / 2 - cx * iw * sc(); ty = H / 2 - cy * ihh * sc();
    clampView(); paint(); settleSoon(60);
  }
  function applyView(v) {
    if (!W || !H) return;
    if (v && [v.x, v.y, v.w, v.h].every(Number.isFinite) && v.w > 0 && v.h > 0) {
      z = clamp(Math.min(W / (v.w * iw), H / (v.h * ihh)) / fit, MIN_Z, MAX_Z);
      const cx = v.x + v.w / 2, cy = v.y + v.h / 2;
      tx = W / 2 - cx * iw * sc(); ty = H / 2 - cy * ihh * sc();
    } else { z = 1; tx = (W - iw * fit) / 2; ty = (H - ihh * fit) / 2; }                // 맞춤 — 가운데(place 는 이동 한계가 넓어 직접 가운데로)
    clampView(); draw(); untangle();
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(en => {
    const r = en[0]?.contentRect;
    if (r) measure(Math.round(r.width), Math.round(r.height));
  }) : null;
  ro?.observe(stage);

  // ---------- 그림 ----------
  let loadTok = 0;
  async function load(url, nw, nh) {
    const my = ++loadTok;
    ready = false; el.dataset.ready = '0';
    msg.hidden = false; msg.textContent = '도면 그림을 여는 중…';
    if (!url) { msg.textContent = '도면 그림이 없어요'; return; }
    const next = new Image();
    next.decoding = 'async';
    next.src = url;
    try { await next.decode(); }                                             // 큰 그림 디코드는 한 번, 메인 스레드 밖에서
    catch (err) {
      if (next.naturalWidth) { /* decode 를 못 하는 브라우저 — 그래도 로드됨 */ }
      else { if (my === loadTok && !dead) msg.textContent = '도면 그림을 열지 못했어요. 다시 찍어 주세요'; console.warn('핀 지도 그림 실패', err); return; }
    }
    if (dead || my !== loadTok) return;
    iw = nw || next.naturalWidth; ihh = nh || next.naturalHeight;
    img.style.width = `${iw}px`; img.style.height = `${ihh}px`;
    img.src = url;                                                           // 같은 주소 — 이미 디코드된 그림을 그대로 쓴다
    ready = true; el.dataset.ready = '1'; msg.hidden = true;
    const r = stage.getBoundingClientRect();
    W = 0; H = 0;
    measure(Math.round(r.width), Math.round(r.height));
    if (!W) return;                                                          // 아직 안 보임 — ResizeObserver 가 크기를 주면 그때
  }

  // ---------- 시작 ----------
  list = norm(pins);
  syncPins();
  setMode(mode);
  load(src, iw, ihh);

  function setMode(m) {
    mode = m === 'place' ? 'place' : 'view';
    el.dataset.mode = mode;
    cross.hidden = mode !== 'place';
    bar.hidden = mode !== 'place';
    if (mode === 'place') el.dataset.placed = okXY(activePin()) ? '1' : '0';
    setHint();
    syncPins();
    if (ready) { clampView(); paint(); settleSoon(0); }
  }

  return {
    el,
    setPins(next) {
      const a = activePin();
      list = norm(next);
      if (mode === 'place' && a?.id === DRAFT && okXY(a) && !list.some(p => p.active)) list.push(a);   // 찍어 둔 임시 핀은 남긴다
      syncPins(); setHint(); paint(); untangle();
    },
    setMode,
    focus(id) {
      const p = list.find(q => q.id === String(id));
      if (!p || !okXY(p) || !ready) return false;
      animateTo(Math.max(z, FOCUS_Z), p.x, p.y);
      return true;
    },
    setSrc(nextSrc, nw = 0, nh = 0) { initView = null; load(nextSrc, nw, nh); },
    placed() { const a = activePin(); return a && okXY(a) ? { x: a.x, y: a.y } : null; },
    view() {
      if (!ready || !W) return null;
      const [x0, y0] = toImage(0, 0), [x1, y1] = toImage(W, H);
      return { x: r5(clamp(x0, 0, 1)), y: r5(clamp(y0, 0, 1)), w: r5(clamp(x1, 0, 1) - clamp(x0, 0, 1)), h: r5(clamp(y1, 0, 1) - clamp(y0, 0, 1)) };
    },
    zoom: () => z,
    destroy() {
      if (dead) return;
      dead = true;
      stopAnim(); cancelAnimationFrame(raf); clearTimeout(settleT);
      ro?.disconnect();
      img.removeAttribute('src');
      nodes.clear();
      el.remove();
    },
  };
}
