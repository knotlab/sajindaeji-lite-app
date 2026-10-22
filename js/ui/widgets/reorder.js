// 끌어 순서 바꾸기(v0.1.6 — 사용자 요구 「목록 순서같은거 드래그앤드롭으로 이동시킬 수 있게」). 순서 값 계산은 core/order.js.
//
// reorderable(container, {
//   itemSelector = '*',          container 의 바로 아래 자식 중 이것에 맞고 보이는 것이 항목(순서 = DOM 순서). 항목 사이에 다른 자식을 끼우지 않는다(앞·뒤는 괜찮다)
//   keyOf = el => el.dataset.id,
//   mode = 'list' | 'grid',      list: 세로 한 줄(줄 높이가 달라도 된다, 가로로는 안 움직인다) · grid: 같은 크기 칸 격자(사진 3~4열)
//   start = 'longpress' | 'handle',
//     longpress: 항목 어디든 longPressMs 동안 누르면 든다 — 그 전에 moveTolerance 넘게 움직이면 그만(스크롤·날짜 가로 넘기기는 그대로).
//     handle: handleSelector 를 누르는 즉시 든다(longpress 에서도 손잡이는 즉시). 손잡이는 dragHandle() 로 만들면 된다
//   handleSelector = '[data-ro-handle]', longPressMs = 400, moveTolerance = 10,
//   scrollEl = 가장 가까운 overflow-y:auto|scroll 조상 (Element | () => Element) — 가장자리 자동 스크롤
//   edgeInsets = 'auto' | { top, bottom } | () => {…}   'auto' = 스크롤 상자 안의 붙박이(.bar sticky top, .dock sticky bottom)가 가리는 만큼
//   ignoreSelector = 글칸 등(이 안에서 누르면 무시),
//   onLift({ el, key, index, via }), onDrop({ from, to, key, keys, el, via: 'drag'|'key'|'api' }), onCancel({ key, index, el, reason }),
//   onMove({ from, to, key, keys, el, ghost }) — 끄는 중 놓일 자리가 바뀔 때만(매 그림 아님). keys = 지금 놓으면 될 순서(사진 번호 배지를 미리 고칠 때)
//   disabled = false | () => boolean, announce = true | false | (text) => void, vibrate = 10(ms, 0 이면 없음)
// }) → { destroy(), cancel(reason?), dragging(), state(), moveBy(keyOrEl, delta, opts?), moveTo(keyOrEl, index, opts?), setDisabled(v), afterDrag(fn), stats() }
//   from·to = 화면(DOM) 자리(0부터, to = 옮긴 뒤 자리), keys = 옮긴 뒤 전체 key 순서(보이는 항목). 데이터 순서로 바꾸기는 core/order.js
//   (홈처럼 화면이 「최신이 위」면 order.planMove(화면 목록, from, to, { desc: true, now })).
//   onCancel 의 reason: 'noop'(들었다가 제자리에 놓음) | 'escape' | 'multitouch' | 'pointercancel' | 'hidden' | 'resize' | 'changed'(끄는 중 목록이 바뀜) | 'gone' | 'destroy' | 'api'
//
// 동작
// - 들면: 진동 10ms, 떠 있는 사본(.ro-ghost — body 에 position:fixed, 목록 상자의 overflow·contain:paint 에 잘리지 않게)이 손가락을 따라가고
//   원래 항목은 「놓일 자리」(.ro-slot, 내용은 숨긴 점선 칸)로 남아 다른 항목과 함께 transform 만으로 비켜 간다(180ms, 배치 다시 계산 없음).
//   재는 것(getBoundingClientRect)은 들 때 한 번, 놓을 때 한 번뿐 — 끄는 동안은 읽지 않고 transform 만 쓴다(한 그림에 한 번, rAF).
// - 가장자리(스크롤 상자 보이는 높이의 12%, 40~88px)에서는 자동 스크롤(깊이의 제곱, 최고 1.2px/ms). 들자마자 흘러가지 않게 8px 움직인 뒤부터.
// - 놓으면: DOM 에서 항목을 새 자리로 옮기고 FLIP(놓기 전 보이던 자리 → 새 자리, 180ms) — 사본은 그 자리로 내려앉고 사라진다.
//   onDrop 은 놓는 순간(DOM 을 옮긴 직후) 바로 — 저장을 기다리지 않는다. 그 뒤 syncList 가 같은 순서로 다시 그려도 노드를 옮기지 않는다.
// - 취소(Esc·다른 손가락·pointercancel·앱이 숨음·창 크기 바뀜·끄는 중 목록 자식이 바뀜): 모두 제자리로(같은 FLIP), onCancel.
// - 들었다가 놓은 뒤 따라오는 click 은 먹는다(열기로 새지 않게). 다음 pointerdown 이면 풀린다.
// - prefers-reduced-motion: 비켜 가기·내려앉기 움직임 없이 바로(사본이 손가락을 따라가는 것은 그대로).
// 안드로이드 크롬
// - 들어 올린 뒤에는 container 의 touchmove(passive:false)를 막는다 — 안 막으면 세로로 움직이는 순간 스크롤이 시작되고 pointercancel 이 온다.
//   이 리스너는 longpress 일 때만 늘 달아 둔다(터치 시작 때 붙어 있어야 막을 수 있다). 손잡이는 CSS touch-action:none 이라 필요 없다.
// - 들어 올린 동안 그 손가락의 pointermove 는 창(window) 잡기 단계에서 전파를 멈춘다 → 조상 몸짓(홈 날짜 넘기기 daypager)이 그 손가락을 못 본다.
//   pointerup·pointercancel 은 멈추지 않는다(조상이 자기 상태를 풀게).
// - 길게 누르기를 기다리는 동안 조상이 포인터를 잡아가면(daypager 가 가로 끌기를 시작 — gotpointercapture) 기다리기를 그만둔다.
// - contextmenu(안드로이드 길게 누르기 메뉴)·dragstart(그림 끌기)·selectstart 는 누르는 동안 막는다. 기기의 길게 누르기가 더 빠르면 그때 든다.
// 접근성: aria-live 로 「n번째로 옮겼어요」, 끌기 말고 moveBy/moveTo(메뉴 [위로]·[아래로]), 손잡이에 포커스가 있으면 ↑↓(격자는 ←→도), 항목에서는 Alt+↑↓.
import { h } from '../dom.js';

const DUR = 180;                                  // 비켜 가기·내려앉기(ms) — CSS --ro-dur 와 같게
const EASE = 'cubic-bezier(.2,.75,.25,1)';
const HYS = 8;                                    // 놓일 자리 바꾸기 문턱(px) — 경계에서 떨지 않게
const CLICK_MS = 700;                             // 놓은 뒤 따라오는 click 을 먹는 시간
const LIFT_SCALE = 1.03;
const MAX_V = 1.2;                                // 자동 스크롤 최고 속도(px/ms)
const AUTO_AFTER = 8;                             // 든 뒤 이만큼 움직여야 자동 스크롤
const IGNORE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [data-ro-ignore]';

const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const tnow = () => performance.now();
let scaleProp = null;
const hasScaleProp = () => (scaleProp ??= (() => { try { return CSS.supports('scale', '1'); } catch { return false; } })());

// ---------- 알림(화면 읽기) — 모든 목록이 하나를 같이 쓴다 ----------
let liveEl = null, liveT = 0, lastSaid = '';
export function announce(text) {
  if (typeof document === 'undefined' || !text) return;
  lastSaid = text;
  if (!liveEl || !liveEl.isConnected) {
    liveEl = h('div', { class: 'ro-live', role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
    document.body.append(liveEl);
  }
  clearTimeout(liveT);
  liveEl.textContent = '';                        // 같은 말을 거듭해도 읽히게 비웠다가 넣는다
  liveT = setTimeout(() => { if (liveEl) liveEl.textContent = text; }, 40);
}
export const lastAnnouncement = () => lastSaid;  // 시험용

// ---------- 손잡이 ≡ (48px 버튼) — 스프라이트에 그림이 없어 선 셋을 직접 그린다 ----------
export function dragHandle({ label = '순서 바꾸기', className = '' } = {}) {
  const svg = h('svg', { class: 'ic', viewBox: '0 0 24 24', width: 24, height: 24, 'aria-hidden': 'true', focusable: 'false' },
    h('path', { d: 'M5 8h14M5 12h14M5 16h14' }));
  return h('button', { type: 'button', class: ['ro-handle', className], 'aria-label': label, 'aria-keyshortcuts': 'ArrowUp ArrowDown', 'data-ro-handle': '', style: { 'touch-action': 'none' } }, svg);
}

export function reorderable(container, opts = {}) {
  if (!(container instanceof Element)) throw new Error('reorderable: container 가 필요해요');
  const o = {
    itemSelector: '*', keyOf: el => el?.dataset?.id ?? null, mode: 'list', start: 'longpress', handleSelector: '[data-ro-handle]',
    longPressMs: 400, moveTolerance: 10, scrollEl: null, edgeInsets: 'auto', ignoreSelector: IGNORE,
    onLift: null, onDrop: null, onCancel: null, onMove: null, disabled: false, announce: true, vibrate: 10,
    ...opts,
  };
  const grid = o.mode === 'grid';
  const useLong = o.start !== 'handle';
  let disabled = o.disabled;
  let dead = false;
  let st = 'idle';                                 // 'idle' | 'press'(길게 누르기 기다림) | 'lift'(끄는 중)
  let press = null;                                // { id, type, x0, y0, x, y, item, timer }
  let drag = null;                                 // 들 때 잰 모형(아래 lift)
  let raf = 0, lastTs = 0, blockUntil = 0, mo = null;
  const settles = new Set();                       // 내려앉는 중인 일 { timer, done }
  const later = [];                                // afterDrag
  const stat = { lifts: 0, drops: 0, cancels: 0, frames: 0, maxFrameMs: 0, autoScrollPx: 0, lastReason: '', moves: 0 };

  const isDisabled = () => { try { return typeof disabled === 'function' ? !!disabled() : !!disabled; } catch { return true; } };
  const say = text => {
    if (!text || !o.announce) return;
    if (typeof o.announce === 'function') { try { o.announce(text); } catch { /* 무시 */ } return; }
    announce(text);
  };
  const safe = (fn, arg) => { try { fn?.(arg); } catch (e) { console.error('순서 바꾸기 알림 처리 실패', e); } };
  const keyOf = el => { try { return o.keyOf(el); } catch { return null; } };

  container.classList.add('ro', useLong ? 'ro-long' : 'ro-hand');

  // ---------- 항목 ----------
  function items() {
    const out = [];
    for (const el of container.children) if (!el.hidden && el.matches(o.itemSelector)) out.push(el);
    return out;
  }
  function itemOf(t) {
    let el = t instanceof Element ? t : t?.parentElement || null;
    while (el && el.parentElement !== container) el = el.parentElement;
    return el && !el.hidden && el.matches(o.itemSelector) ? el : null;
  }
  function resolveEl(target, list) {
    if (target instanceof Element) return list.includes(target) ? target : itemOf(target);
    return list.find(el => keyOf(el) === target) || null;
  }

  // ---------- 누르기 ----------
  function onDown(e) {
    if (dead || st !== 'idle') return;                       // 두 번째 손가락은 창 듣기(onWinDown)가 맡는다
    blockUntil = 0;                                          // 새로 누르면 앞 끌기의 click 먹기는 끝(빠른 다음 탭을 먹지 않게)
    if (!e.isPrimary || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (isDisabled()) return;
    const item = itemOf(e.target);
    if (!item) return;
    const t = e.target instanceof Element ? e.target : null;
    const ign = t && o.ignoreSelector ? t.closest(o.ignoreSelector) : null;
    if (ign && item.contains(ign)) return;
    const hd = t && o.handleSelector ? t.closest(o.handleSelector) : null;
    const onHandle = !!hd && item.contains(hd);
    if (!onHandle && !useLong) return;
    finishSettles();                                         // 앞 놓기 움직임이 남았으면 끝낸다(새로 재기 전에)
    press = { id: e.pointerId, type: e.pointerType, x0: e.clientX, y0: e.clientY, x: e.clientX, y: e.clientY, item, timer: 0 };
    st = 'press';
    listenWin(true);
    if (onHandle) { lift('handle'); return; }
    press.timer = setTimeout(() => { if (st === 'press') lift('long'); }, o.longPressMs);
  }
  function endPress() {
    if (st !== 'press') return;
    clearTimeout(press?.timer);
    press = null;
    st = 'idle';
    listenWin(false);
  }

  // ---------- 창 듣기(누르는 동안만 단다) ----------
  let winOn = false;
  const CAP = { capture: true, passive: false };
  function listenWin(on) {
    if (on === winOn) return;
    winOn = on;
    const f = on ? 'addEventListener' : 'removeEventListener';
    window[f]('pointermove', onWinMove, CAP);
    window[f]('pointerup', onWinUp, true);
    window[f]('pointercancel', onWinCancel, true);
    window[f]('pointerdown', onWinDown, true);
    window[f]('gotpointercapture', onWinCapture, true);
    window[f]('keydown', onWinKey, true);
    window[f]('blur', onBlur);
    window[f]('resize', onResize);
    document[f]('visibilitychange', onVis);
  }
  const curId = () => (st === 'press' ? press?.id : st === 'lift' ? drag?.id : null);
  function onWinMove(e) {
    if (e.pointerId !== curId()) return;
    if (st === 'press') {
      press.x = e.clientX; press.y = e.clientY;
      if (Math.hypot(e.clientX - press.x0, e.clientY - press.y0) > o.moveTolerance) endPress();
      return;
    }
    e.stopPropagation();                                     // 조상 몸짓(daypager 등)이 이 손가락을 못 보게
    if (e.pointerType !== 'touch' && e.cancelable) e.preventDefault();   // 마우스: 글자 고르기 막기
    const d = drag;
    d.x = e.clientX; d.y = e.clientY;
    if (!d.moved && Math.hypot(d.x - d.x0, d.y - d.y0) > AUTO_AFTER) d.moved = true;
    schedule();
  }
  function onWinUp(e) {
    if (e.pointerId !== curId()) return;
    if (st === 'press') { endPress(); return; }
    if (Number.isFinite(e.clientX) && Number.isFinite(e.clientY) && (e.clientX || e.clientY)) { drag.x = e.clientX; drag.y = e.clientY; }   // 뗀 자리로 마지막 계산
    end('drop');
  }
  function onWinCancel(e) {
    if (e.pointerId !== curId()) return;
    if (st === 'press') endPress();
    else end('cancel', 'pointercancel');
  }
  function onWinDown(e) {                                    // 다른 손가락 → 원래대로
    const id = curId();
    if (id == null || e.pointerId === id) return;
    if (st === 'press') endPress();
    else end('cancel', 'multitouch');
  }
  function onWinCapture(e) {                                 // 기다리는 동안 조상(daypager 가로 끌기 등)이 포인터를 가져갔다
    if (st !== 'press' || e.pointerId !== press.id) return;
    if (e.target instanceof Node && container.contains(e.target)) return;
    endPress();
  }
  function onWinKey(e) {
    if (e.key !== 'Escape' || st === 'idle') return;
    e.preventDefault(); e.stopPropagation();
    if (st === 'press') endPress(); else end('cancel', 'escape');
  }
  function onBlur() { if (st === 'press') endPress(); else if (st === 'lift') end('cancel', 'hidden'); }
  function onVis() { if (document.visibilityState === 'hidden') onBlur(); }
  function onResize() { if (st === 'press') endPress(); else if (st === 'lift') end('cancel', 'resize'); }

  // ---------- 상자 안 듣기 ----------
  function onTouchMove(e) { if (st === 'lift' && e.cancelable) e.preventDefault(); }   // 든 뒤 스크롤(→ pointercancel) 막기
  function onCtx(e) {
    if (st === 'press') { e.preventDefault(); lift('context'); return; }   // 기기 길게 누르기가 먼저 왔다(접근성 「짧게」 설정 등)
    if (st === 'lift') e.preventDefault();
  }
  function onBlockDefault(e) { if (st !== 'idle') e.preventDefault(); }   // dragstart·selectstart
  function onClickCap(e) {
    if (st === 'lift' || (blockUntil && tnow() < blockUntil)) { e.preventDefault(); e.stopPropagation(); blockUntil = 0; }
  }
  function onKey(e) {
    if (dead || st !== 'idle' || e.defaultPrevented) return;
    const up = e.key === 'ArrowUp' || (grid && e.key === 'ArrowLeft');
    const down = e.key === 'ArrowDown' || (grid && e.key === 'ArrowRight');
    if (!up && !down) return;
    const t = e.target instanceof Element ? e.target : null;
    const item = t && itemOf(t);
    if (!item) return;
    const onHandle = !!(o.handleSelector && t.closest(o.handleSelector));
    if (!onHandle && !e.altKey) return;                     // 항목에서는 Alt+화살표만(목록의 다른 키와 다투지 않게)
    if (isDisabled()) return;
    e.preventDefault(); e.stopPropagation();
    moveBy(item, up ? -1 : 1, { via: 'key' });
  }
  container.addEventListener('pointerdown', onDown, { passive: true });
  if (useLong) container.addEventListener('touchmove', onTouchMove, { passive: false });
  container.addEventListener('contextmenu', onCtx);
  container.addEventListener('dragstart', onBlockDefault);
  container.addEventListener('selectstart', onBlockDefault);
  container.addEventListener('click', onClickCap, true);
  container.addEventListener('keydown', onKey);

  // ---------- 스크롤 상자·가장자리 ----------
  function scrollerOf() {
    const s = typeof o.scrollEl === 'function' ? o.scrollEl() : o.scrollEl;
    const docEl = document.scrollingElement || document.documentElement;
    if (s instanceof Element) return { el: s, isDoc: s === docEl || s === document.body };
    for (let x = container.parentElement; x && x !== document.body && x !== document.documentElement; x = x.parentElement) {
      const oy = getComputedStyle(x).overflowY;
      if (oy === 'auto' || oy === 'scroll' || oy === 'overlay') return { el: x, isDoc: false };
    }
    return { el: docEl, isDoc: true };
  }
  // 스크롤 상자 바로 아래 붙박이(sticky/fixed — .bar 위, .dock 아래)가 가리는 높이
  function autoInsets(sc, r) {
    const out = { top: 0, bottom: 0 };
    if (sc.isDoc) return out;
    for (const c of sc.el.children) {
      if (c.contains(container)) continue;
      const cs = getComputedStyle(c);
      if (cs.position !== 'sticky' && cs.position !== 'fixed') continue;
      const cr = c.getBoundingClientRect();
      if (!cr.height || cr.bottom <= r.top || cr.top >= r.bottom) continue;
      if (cs.top !== 'auto' && cr.top - r.top < r.bottom - cr.bottom) out.top = Math.max(out.top, cr.bottom - r.top);
      else if (cs.bottom !== 'auto') out.bottom = Math.max(out.bottom, r.bottom - cr.top);
    }
    return out;
  }
  function edgesOf(sc) {
    const vh = window.innerHeight || document.documentElement.clientHeight;
    let top = 0, bottom = vh;
    const r = sc.isDoc ? { top: 0, bottom: vh } : sc.el.getBoundingClientRect();
    top = Math.max(top, r.top); bottom = Math.min(bottom, r.bottom);
    let ins = typeof o.edgeInsets === 'function' ? o.edgeInsets() : o.edgeInsets;
    if (ins === 'auto') ins = autoInsets(sc, r);
    const t2 = top + (Number(ins?.top) || 0), b2 = bottom - (Number(ins?.bottom) || 0);
    if (b2 - t2 >= 96) { top = t2; bottom = b2; }           // 가린 것을 빼고 너무 좁아지면 빼지 않는다
    return { top, bottom, zone: clamp((bottom - top) * 0.12, 40, 88) };
  }

  // ---------- 들기 ----------
  function lift(via) {
    const p = press;
    clearTimeout(p.timer); p.timer = 0;
    if (dead || !p.item.isConnected || !container.isConnected || isDisabled()) { endPress(); return; }
    // 조상이 이 포인터를 잡아갔으면(daypager 가 가로 끌기를 시작한 뒤 손가락이 멈춰 gotpointercapture 가 아직 안 옴) 들지 않는다
    for (let x = container.parentElement; x; x = x.parentElement) {
      try { if (x.hasPointerCapture?.(p.id)) { endPress(); return; } } catch { /* 무시 */ }
    }
    // 재기(한 번) — 이 뒤로는 놓을 때까지 배치를 읽지 않는다
    const all = items();
    const rAll = all.map(el => el.getBoundingClientRect());
    const list = [], rects = [];
    all.forEach((el, i) => { const r = rAll[i]; if (r.width || r.height) { list.push(el); rects.push(r); } });
    const from = list.indexOf(p.item);
    if (from < 0) { endPress(); return; }
    const sc = scrollerOf();
    const st0 = sc.el.scrollTop;
    const d = {
      id: p.id, type: p.type, via, el: p.item, key: keyOf(p.item), list, rects, from, to: from,
      x0: p.x, y0: p.y, x: p.x, y: p.y, moved: false,
      sc, st0, scTop: st0, maxScroll: Math.max(0, sc.el.scrollHeight - sc.el.clientHeight), edges: edgesOf(sc), sbRestore: null,
      tx: new Float64Array(list.length), ty: new Float64Array(list.length), ghost: null, gx0: rects[from].left, gy0: rects[from].top,
      minTop: Infinity, maxBottom: -Infinity, minLeft: Infinity, maxRight: -Infinity,
    };
    for (const r of rects) { d.minTop = Math.min(d.minTop, r.top); d.maxBottom = Math.max(d.maxBottom, r.bottom); d.minLeft = Math.min(d.minLeft, r.left); d.maxRight = Math.max(d.maxRight, r.right); }
    if (!grid) {
      // 세로 줄 모형: 들어 올린 것을 뺀 나머지의 높이 누적(prefix[k] = 앞 k 개의 높이 + 틈)
      const gaps = [];
      for (let i = 0; i + 1 < rects.length; i++) gaps.push(rects[i + 1].top - rects[i].bottom);
      gaps.sort((a, b) => a - b);
      d.gap = gaps.length ? gaps[gaps.length >> 1] : 0;
      d.oIdx = list.map((_, i) => i).filter(i => i !== from);
      d.prefix = [0];
      for (let k = 0; k < d.oIdx.length; k++) d.prefix.push(d.prefix[k] + rects[d.oIdx[k]].height + d.gap);
    }
    try { if (getComputedStyle(sc.el).scrollBehavior === 'smooth') { d.sbRestore = sc.el.style.scrollBehavior; sc.el.style.scrollBehavior = 'auto'; } } catch { /* 무시 */ }
    d.ghost = makeGhost(p.item, rects[from]);
    drag = d; press = null; st = 'lift';
    stat.lifts++;
    container.classList.add('ro-on');
    p.item.classList.add('ro-slot');
    // 보이는 곳(± 반 화면) 항목은 끄는 동안 미리 합성 레이어로(.ro-wc = will-change) — 비켜 갈 때마다 레이어를 만들고 지우며 다시 그리던 것을
    // 들 때 한 번으로(4배 늦춤 측정: 34ms 넘는 그림 32 → 4개/18번). 긴 목록에서 레이어가 너무 많아지지 않게 화면 근처만
    const span = (d.edges.bottom - d.edges.top) / 2;
    d.wc = list.filter((el, i) => rects[i].bottom > d.edges.top - span && rects[i].top < d.edges.bottom + span);
    for (const el of d.wc) el.classList.add('ro-wc');
    void d.ghost.offsetWidth;                                // 사본의 첫 모습(배율 1)을 굳힌 뒤 커지게
    d.ghost.classList.add('ro-up');
    if (hasScaleProp()) d.ghost.style.scale = String(LIFT_SCALE);
    else d.ghost.style.transform = `scale(${LIFT_SCALE})`;
    if (o.vibrate) { try { if (navigator.userActivation?.hasBeenActive !== false) navigator.vibrate?.(o.vibrate); } catch { /* 진동 없는 기기 */ } }
    mo = typeof MutationObserver === 'function' ? new MutationObserver(() => { if (st === 'lift') end('cancel', 'changed'); }) : null;
    mo?.observe(container, { childList: true });
    say(`${from + 1}번째를 들었어요`);
    safe(o.onLift, { el: d.el, key: d.key, index: from, via });
  }

  function makeGhost(el, r) {
    const g = el.cloneNode(true);
    g.classList.add('ro-ghost');
    g.classList.remove('ro-slot', 'ro-moved');
    for (const x of [g, ...g.querySelectorAll('[id],[data-testid]')]) {
      x.removeAttribute('id');
      if (x.hasAttribute('data-testid')) { x.setAttribute('data-ro-testid', x.getAttribute('data-testid')); x.removeAttribute('data-testid'); }
    }
    g.setAttribute('aria-hidden', 'true');
    g.inert = true;
    g.style.removeProperty('transform');
    g.style.removeProperty('transition');
    Object.assign(g.style, {
      position: 'fixed', left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`,
      margin: '0', right: 'auto', bottom: 'auto', zIndex: '65', pointerEvents: 'none',
    });
    document.body.append(g);
    // 목록 밖(body)이라 :first-child·조상 규칙이 달라진다 — 사본 자신의 계산된 모양을 보고 고친다(이 재기는 사본 하나라 싸다)
    const gs = getComputedStyle(g);
    let bg = gs.backgroundColor;                             // 줄 배경을 목록 상자가 칠하면 비친다 → 가장 가까운 칠한 조상 색(떠 있는 카드처럼)
    for (let x = el; x && isClear(bg); x = x.parentElement) bg = getComputedStyle(x).backgroundColor;
    if (!isClear(bg)) g.style.backgroundColor = bg;
    if (parseFloat(gs.borderTopWidth) > 0 && !(parseFloat(gs.borderBottomWidth) > 0)) g.style.borderTopColor = 'transparent';   // 줄 사이 선은 떼어 낸다
    if (!parseFloat(gs.borderTopLeftRadius)) g.style.borderRadius = '8px';
    return g;
  }
  const isClear = c => !c || c === 'transparent' || /rgba\([^)]*,\s*0\)$/.test(c);

  // ---------- 끄는 동안(한 그림에 한 번) ----------
  function schedule() { if (!raf && st === 'lift') raf = requestAnimationFrame(frame); }
  function frame(ts) {
    raf = 0;
    if (st !== 'lift') return;
    const t0 = tnow();
    const d = drag;
    if (!container.isConnected || !d.el.isConnected) { end('cancel', 'gone'); return; }
    const dt = lastTs ? clamp(ts - lastTs, 0, 48) : 16;
    lastTs = ts;
    // ① 가장자리 자동 스크롤 — 모형 값(d.scTop)만 먼저 바꾸고 읽지 않는다. scrollTop 은 읽든 쓰든 브라우저가 그 자리에서 스타일·배치를 맞추므로
    //    (자동 스크롤로 새로 보이는 썸네일이 불려 오며 스타일이 더러워진다 — 4배 늦춤 프로파일에서 읽기 64ms·쓰기 43ms) transform 을 다 쓴 뒤 맨 끝에 한 번만 쓴다.
    //    값은 들 때 잰 끝값으로 자르니 실제와 같다(기기 화소 반올림 1px 미만 차이는 놓을 때 FLIP 이 실제 자리를 다시 잰다)
    let want = null;
    const v = d.moved ? edgeSpeed(d) : 0;
    if (v) {
      const w = clamp(d.scTop + v * dt, 0, d.maxScroll);
      if (Math.abs(w - d.scTop) >= 0.5) { stat.autoScrollPx += Math.abs(w - d.scTop); d.scTop = w; want = w; }
    }
    place(d);
    if (want != null) d.sc.el.scrollTop = want;
    const ms = tnow() - t0;
    stat.frames++;
    if (ms > stat.maxFrameMs) stat.maxFrameMs = ms;
    if (want != null) schedule();                           // 가장자리에 있는 동안 계속(손가락이 멈춰 있어도)
  }
  function edgeSpeed(d) {
    if (d.maxScroll <= 0) return 0;
    const { top, bottom, zone } = d.edges, y = d.y;
    if (y < top + zone && d.scTop > 0) { const k = clamp((top + zone - y) / zone, 0, 1); return -MAX_V * k * k; }
    if (y > bottom - zone && d.scTop < d.maxScroll) { const k = clamp((y - (bottom - zone)) / zone, 0, 1); return MAX_V * k * k; }
    return 0;
  }
  // 사본 자리 + 놓일 자리 고르기 + 비켜 가기
  function place(d) {
    const r = d.rects[d.from];
    const sd = d.scTop - d.st0;                             // 든 뒤 스크롤된 양(목록이 위로 간 만큼)
    // 사본은 화면 좌표. 가운데가 목록 첫 줄 위끝 ~ 끝 줄 아래끝 안에 있게(넘어가면 손가락과 떨어진다)
    const cy = clamp(r.top + r.height / 2 + (d.y - d.y0), d.minTop - sd, d.maxBottom - sd);
    const gy = cy - (r.top + r.height / 2);
    let gx = 0;
    if (grid) { const cx = clamp(r.left + r.width / 2 + (d.x - d.x0), d.minLeft, d.maxRight); gx = cx - (r.left + r.width / 2); }
    d.ghost.style.transform = hasScaleProp() ? `translate3d(${gx}px,${gy}px,0)` : `translate3d(${gx}px,${gy}px,0) scale(${LIFT_SCALE})`;
    // 놓일 자리 — 들 때 좌표계(스크롤 sd 만큼 더함)
    const ccx = r.left + r.width / 2 + gx, ccy = r.top + r.height / 2 + gy + sd;
    const t = grid ? pickGrid(d, ccx, ccy) : pickList(d, ccy);
    if (t !== d.to) {
      d.to = t; shift(d); stat.moves++;
      if (o.onMove) {
        const keys = d.list.map(keyOf);
        keys.splice(t, 0, keys.splice(d.from, 1)[0]);
        safe(o.onMove, { from: d.from, to: t, key: d.key, keys, el: d.el, ghost: d.ghost });
      }
    }
  }
  // 세로 줄: k 번째(옮긴 뒤 자리)에 놓일 때의 가운데 = top0 + prefix[k] + h/2 — 가장 가까운 k(문턱 HYS)
  function pickList(d, cy) {
    const top0 = d.rects[0].top, half = d.rects[d.from].height / 2;
    const c = k => top0 + d.prefix[k] + half;
    let best = d.to, bd = Math.abs(cy - c(d.to));
    for (let k = 0; k < d.prefix.length; k++) {
      const dist = Math.abs(cy - c(k));
      if (dist + HYS < bd) { best = k; bd = dist; }
    }
    return best;
  }
  // 격자: 칸 가운데가 가장 가까운 자리(문턱 HYS)
  function pickGrid(d, cx, cy) {
    const dist = k => { const r = d.rects[k]; return Math.hypot(cx - (r.left + r.width / 2), cy - (r.top + r.height / 2)); };
    let best = d.to, bd = dist(d.to);
    for (let k = 0; k < d.rects.length; k++) { const v = dist(k); if (v + HYS < bd) { best = k; bd = v; } }
    return best;
  }
  function setT(d, i, x, y) {
    if (Math.abs(d.tx[i] - x) < 0.25 && Math.abs(d.ty[i] - y) < 0.25) return;
    d.tx[i] = x; d.ty[i] = y;
    d.list[i].style.transform = x || y ? `translate3d(${x}px,${y}px,0)` : '';
  }
  function shift(d) {
    const t = d.to, f = d.from, n = d.list.length;
    if (grid) {
      // 옮긴 뒤 k 번째 자리 = 원래 k 번째 칸 자리
      let k = 0;
      for (let i = 0; i < n; i++) {
        if (i === f) continue;
        const nk = k < t ? k : k + 1;
        const a = d.rects[i], b = d.rects[nk];
        setT(d, i, b.left - a.left, b.top - a.top);
        k++;
      }
      const a = d.rects[f], b = d.rects[t];
      setT(d, f, b.left - a.left, b.top - a.top);
      return;
    }
    const top0 = d.rects[0].top, hf = d.rects[f].height + d.gap;
    d.oIdx.forEach((i, k) => setT(d, i, 0, top0 + d.prefix[k] + (k >= t ? hf : 0) - d.rects[i].top));
    setT(d, f, 0, top0 + d.prefix[t] - d.rects[f].top);
  }

  // ---------- 놓기·취소(같은 FLIP) ----------
  function end(kind, reason = 'api') {
    const d = drag;
    if (!d || st !== 'lift') return;
    if (raf) { cancelAnimationFrame(raf); raf = 0; }
    if (kind === 'drop' && container.isConnected && d.el.isConnected) place(d);   // 마지막 손가락 자리로 한 번 더
    st = 'idle'; drag = null; lastTs = 0;
    listenWin(false);
    mo?.disconnect(); mo = null;
    blockUntil = tnow() + CLICK_MS;
    if (d.sbRestore != null) d.sc.el.style.scrollBehavior = d.sbRestore;
    const moved = kind === 'drop' && d.to !== d.from && d.el.isConnected && d.el.parentElement === container;
    const list = d.list.filter(el => el.parentElement === container);
    const fa = document.activeElement;
    const anim = !reducedMotion() && container.isConnected;
    const first = anim ? list.map(el => el.getBoundingClientRect()) : null;
    if (moved) {
      const others = d.list.filter(el => el !== d.el);
      const ref = others[d.to];
      if (ref && ref.parentElement === container) container.insertBefore(d.el, ref);
      else { const lo = others[others.length - 1]; if (lo && lo.parentElement === container) lo.after(d.el); }
      if (fa && d.el.contains(fa) && document.activeElement !== fa) { try { fa.focus({ preventScroll: true }); } catch { /* 무시 */ } }
    }
    const lastR = flip(list, first);
    const home = lastR ? lastR[list.indexOf(d.el)] : null;
    const job = { timer: 0, done: null };
    job.done = () => {
      clearTimeout(job.timer);
      if (!settles.delete(job)) return;
      d.ghost?.remove();
      d.el.classList.remove('ro-slot');
      for (const el of d.wc || []) el.classList.remove('ro-wc');
      if (!settles.size && st === 'idle') container.classList.remove('ro-on');
    };
    settles.add(job);
    if (anim && home && d.ghost) {
      const g = d.ghost;
      g.style.transition = `transform ${DUR}ms ${EASE}, scale ${DUR}ms ${EASE}, box-shadow ${DUR}ms ${EASE}`;
      g.style.transform = `translate3d(${home.left - d.gx0}px,${home.top - d.gy0}px,0)`;
      if (hasScaleProp()) g.style.scale = '1';
      g.classList.remove('ro-up');
      job.timer = setTimeout(job.done, DUR + 40);
    } else job.done();
    if (moved) {
      stat.drops++; stat.lastReason = 'drop';
      const keys = items().map(keyOf);
      say(`${d.to + 1}번째로 옮겼어요`);
      safe(o.onDrop, { from: d.from, to: d.to, key: d.key, keys, el: d.el, via: 'drag' });
    } else {
      const why = kind === 'drop' ? 'noop' : reason;
      stat.cancels++; stat.lastReason = why;
      say(why === 'noop' ? '제자리에 두었어요' : '옮기지 않았어요');
      safe(o.onCancel, { key: d.key, index: d.from, el: d.el, reason: why });
    }
    runLater();
  }

  // FLIP — first(바꾸기 전 보이던 자리, 움직이는 중인 transform 포함)에서 지금 배치 자리로. transform 을 지우고 다시 재서 거꾸로 놓은 뒤 0 으로.
  // first 가 없으면(움직임 끔) transform 만 지운다. → 지금 배치 자리(getBoundingClientRect) | null
  function flip(list, first) {
    container.classList.add('ro-flip');
    for (const el of list) el.style.transform = '';
    if (!first) { container.classList.remove('ro-flip'); return null; }
    const last = list.map(el => el.getBoundingClientRect());
    let any = false;
    list.forEach((el, i) => {
      const dx = first[i].left - last[i].left, dy = first[i].top - last[i].top;
      if (Math.abs(dx) > 0.5 || Math.abs(dy) > 0.5) { el.style.transform = `translate3d(${dx}px,${dy}px,0)`; any = true; }
    });
    if (any) void container.offsetWidth;                    // 거꾸로 놓은 자리를 굳힌다(배치는 이미 깨끗 — 싸다)
    container.classList.add('ro-on');
    container.classList.remove('ro-flip');
    if (any) for (const el of list) if (el.style.transform) el.style.transform = '';
    return last;
  }
  function finishSettles() {
    for (const job of [...settles]) job.done();
  }

  // ---------- 메뉴·키로 옮기기 ----------
  function moveTo(target, index, { via = 'api' } = {}) {
    if (dead || st !== 'idle') return false;
    finishSettles();
    const list = items();
    const el = resolveEl(target, list);
    if (!el) return false;
    const n = list.length, from = list.indexOf(el);
    const want = Math.trunc(Number(index) || 0);
    const to = clamp(want, 0, n - 1);
    if (to === from) { if (want !== to) say(edgeText(want < 0 ? -1 : 1, from, n)); return false; }   // 끝을 넘으려 했을 때만 「맨 위예요」
    const fa = document.activeElement;
    const anim = !reducedMotion();
    const first = anim ? list.map(x => x.getBoundingClientRect()) : null;
    const others = list.filter(x => x !== el);
    if (to < others.length) container.insertBefore(el, others[to]); else others[others.length - 1].after(el);
    if (fa && el.contains(fa) && document.activeElement !== fa) { try { fa.focus({ preventScroll: true }); } catch { /* 무시 */ } }
    if (anim) {
      flip(list, first);
      el.classList.remove('ro-moved'); void el.offsetWidth; el.classList.add('ro-moved');
      const job = { timer: 0, done: null };
      job.done = () => { clearTimeout(job.timer); if (!settles.delete(job)) return; el.classList.remove('ro-moved'); if (!settles.size && st === 'idle') container.classList.remove('ro-on'); };
      settles.add(job);
      job.timer = setTimeout(job.done, 700);
    }
    if (via === 'key') { try { el.scrollIntoView({ block: 'nearest' }); } catch { /* 무시 */ } }
    stat.drops++; stat.lastReason = via;
    say(`${to + 1}번째로 옮겼어요`);
    safe(o.onDrop, { from, to, key: keyOf(el), keys: items().map(keyOf), el, via });
    return true;
  }
  function moveBy(target, delta, opts2 = {}) {
    const list = items();
    const el = resolveEl(target, list);
    if (!el) return false;
    const from = list.indexOf(el);
    const to = from + Math.trunc(Number(delta) || 0);
    if (to < 0 || to > list.length - 1) { say(edgeText(delta, from, list.length)); return false; }
    return moveTo(el, to, opts2);
  }
  const edgeText = (dir, i, n) => (n < 2 ? '옮길 곳이 없어요' : dir < 0 ? (grid ? '맨 앞이에요' : '맨 위예요') : (grid ? '맨 뒤예요' : '맨 아래예요'));

  // ---------- 바깥 ----------
  function cancel(reason = 'api') {
    if (st === 'press') endPress();
    else if (st === 'lift') end('cancel', reason);
  }
  function afterDrag(fn) {
    if (typeof fn !== 'function') return;
    if (st !== 'lift') { fn(); return; }
    if (!later.includes(fn)) later.push(fn);
  }
  function runLater() {
    for (const fn of later.splice(0)) { try { fn(); } catch (e) { console.error('afterDrag 실패', e); } }
  }
  function destroy() {
    if (dead) return;
    cancel('destroy');
    dead = true;
    finishSettles();
    listenWin(false);
    container.removeEventListener('pointerdown', onDown);
    container.removeEventListener('touchmove', onTouchMove);
    container.removeEventListener('contextmenu', onCtx);
    container.removeEventListener('dragstart', onBlockDefault);
    container.removeEventListener('selectstart', onBlockDefault);
    container.removeEventListener('click', onClickCap, true);
    container.removeEventListener('keydown', onKey);
    container.classList.remove('ro', 'ro-long', 'ro-hand', 'ro-on', 'ro-flip');
    later.length = 0;
  }

  return {
    destroy, cancel, moveTo, moveBy, afterDrag,
    dragging: () => st === 'lift',
    state: () => st,
    setDisabled(v) { disabled = v; if (isDisabled()) cancel('disabled'); },
    stats: () => ({ ...stat, state: st, to: drag?.to ?? null, from: drag?.from ?? null, settling: settles.size }),
  };
}
