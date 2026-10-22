// 날짜 넘기기(v0.1.5 — 사용자 요구 「홈에서는 횡스크롤로 날짜 이동」, 「지연시간 없이 팍팍」).
// dayPager({ day, max, renderDay(day, oldEl) → Element, onChange(day), header = true, step?, min?, onDrop?, animMs = 220 })
//   → { el, go(day, { animate }), day(), refresh(day?), setMax(max), destroy(), stats() }
// - day·max 는 'YYYY-MM-DD'(max = 오늘 — 그보다 뒤로는 못 간다, 고무줄처럼 버팀). min 을 주면 그보다 앞도 버팀.
// - step(day, dir) → 'YYYY-MM-DD' | null 을 주면 이웃 날짜를 그것으로(기록 있는 날로만 건너뛰기 등). 없으면 달력 하루씩.
// - renderDay(day, oldEl): 그 날 페이지 내용. 다시 그릴 때(refresh) 전의 요소를 넘긴다 — 그 자리에서 고쳐(syncList) 같은 요소를 돌려줘도 된다.
// - onChange(day): 날짜가 바뀌면(넘기기·버튼·날짜 고르기·go). 넘기는 움직임이 시작된 다음 그림에 부른다(움직임을 막지 않게).
// - onDrop(day, el): 캐시에서 빠진 페이지(정리할 것이 있으면).
// 속도 원칙:
// - 끄는 동안은 트랙의 transform 만 바꾼다(배치·그리기 없음 — 손가락 그대로). 떼면 transform 전환(합성 스레드)으로 넘김/제자리.
// - 그리는 건 현재 ±1 날짜만. 넘기면 새 이웃은 움직임이 끝난 뒤 한 박자 쉬고 그린다(다음에 끌기 시작하면 바로 그린다).
// - 그린 페이지는 최대 5개 캐시(현재 ±1 은 늘 남김). 캐시 페이지는 문서에 붙인 채 숨긴다(썸네일 관찰이 끊기지 않게 — thumb.sweep 은 떨어진 칸만 놓는다).
// - 폭은 ResizeObserver 로 받는다(끌기 시작에 배치를 강제로 읽지 않게). 처음 한 번만 clientWidth.
// 세로 스크롤과 다투지 않게: 넘기는 판·페이지는 touch-action: pan-y(브라우저가 세로를 맡는다) + 처음 움직임 방향으로 가로/세로를 정한다.
// 접근성: ‹ › 버튼(aria-label 에 날짜), 날짜를 누르면 날짜 고르기, ←·→ 키, 바뀐 날짜는 aria-live 로 읽는다. 옆 페이지는 inert.
import { h, icon } from '../dom.js';
import { dayKey, dayLabel, addDays } from '../../core/date.js';

const SLOP = 8;                                  // 방향을 정하는 움직임(px)
const CACHE = 5;
const COMMIT_FRAC = 0.28;                        // 폭의 이만큼 끌면 넘김
const FLICK_V = 0.35;                            // px/ms — 이보다 빠르게 튕기면 짧게 끌어도 넘김
const MIN_FLICK_DX = 24;
const EASE = 'cubic-bezier(.2,.75,.25,1)';
const validDay = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
const reducedMotion = () => { try { return matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };
const now = () => performance.now();

// 끄는 거리를 넘을 곳이 없을 때(오늘보다 뒤 등) — 갈수록 무거워진다(최대 폭의 약 1/4)
export function rubber(dx, w) {
  const s = Math.sign(dx), x = Math.abs(dx), k = Math.max(1, w) * 0.55;
  return s * (1 - 1 / (x / k + 1)) * k * 0.5;
}

// 머리 글: '10월 22일 (수) · 오늘'
export function dayTitle(day, today) {
  const base = dayLabel(day);
  if (day === today) return `${base} · 오늘`;
  if (day === addDays(today, -1)) return `${base} · 어제`;
  return base;
}

export function dayPager({
  day, max, min = null, renderDay, onChange = null, header = true, step = null, onDrop = null, animMs = 220,
} = {}) {
  if (typeof renderDay !== 'function') throw new Error('dayPager: renderDay 가 필요해요');
  let maxDay = validDay(max) ? max : dayKey(Date.now());
  let cur = validDay(day) ? (day > maxDay ? maxDay : day) : maxDay;
  let dead = false;
  const cache = new Map();                       // day → { wrap, el, stale, top }
  const stat = { renders: 0, renderMs: 0, maxRenderMs: 0, commits: 0, settles: 0 };

  // ---------- 이웃 날짜 ----------
  function stepDay(d, dir) {
    let n = null;
    if (typeof step === 'function') { try { n = step(d, dir); } catch (e) { console.warn('dayPager step 실패', e); n = null; } }
    else n = addDays(d, dir);
    if (!validDay(n)) return null;
    if (n > maxDay) return null;
    if (min && n < min) return null;
    if (dir > 0 && n <= d) return null;
    if (dir < 0 && n >= d) return null;
    return n;
  }
  let prevDay = stepDay(cur, -1), nextDay = stepDay(cur, 1);

  // ---------- 틀 ----------
  const live = h('div', { class: 'dpg-live', 'aria-live': 'polite', 'aria-atomic': 'true' });
  const track = h('div', { class: 'dpg-track' });
  const vp = h('div', { class: 'dpg-vp', 'data-testid': 'dpg-viewport', role: 'region', 'aria-label': '날짜별 기록' }, track);
  const titleText = h('span', { class: 'dpg-title-t' });
  const dateIn = h('input', { type: 'date', class: 'dpg-date', 'aria-hidden': 'true', tabindex: '-1' });
  const prevBtn = h('button', { type: 'button', class: 'dpg-nav prev', 'data-testid': 'dpg-prev' }, icon('left'));
  const nextBtn = h('button', { type: 'button', class: 'dpg-nav next', 'data-testid': 'dpg-next' }, icon('right'));
  const titleBtn = h('button', { type: 'button', class: 'dpg-title', 'data-testid': 'dpg-title', 'aria-label': '날짜 고르기' },
    titleText, icon('cal', 18));
  const head = header ? h('div', { class: 'dpg-head' }, prevBtn, titleBtn, nextBtn, dateIn) : null;
  const el = h('div', { class: ['dpg', 'scroll'], 'data-testid': 'daypager' }, head, live, vp);

  // ---------- 페이지 그리기·캐시 ----------
  function draw(d, e) {
    const t0 = now();
    let node = null;
    try { node = renderDay(d, e?.el || null); } catch (err) {
      console.error('날짜 페이지를 그리지 못했어요', d, err);
      node = h('p', { class: 'dpg-err', text: '이 날짜를 열지 못했어요. 다시 넘겨 보세요.' });
    }
    const ms = now() - t0;
    stat.renders++; stat.renderMs += ms; stat.maxRenderMs = Math.max(stat.maxRenderMs, ms);
    if (!(node instanceof Element)) node = h('div');
    return node;
  }
  function ensure(d) {
    if (!d) return null;
    let e = cache.get(d);
    if (e) {
      cache.delete(d); cache.set(d, e);          // 최근에 쓴 것으로
      if (e.stale) {
        e.stale = false;
        const node = draw(d, e);
        if (node !== e.el) { e.wrap.replaceChildren(node); e.el = node; }
      }
      return e;
    }
    const wrap = h('div', { class: 'dpg-page', 'data-day': d, 'data-testid': 'dpg-page', hidden: true });
    e = { wrap, el: null, stale: false, top: 0, k: null };
    e.el = draw(d, null);
    wrap.append(e.el);
    cache.set(d, e);
    track.append(wrap);
    trim();
    return e;
  }
  function trim() {
    if (cache.size <= CACHE) return;
    for (const [d, e] of cache) {
      if (cache.size <= CACHE) break;
      if (d === cur || d === prevDay || d === nextDay || d === sideDay) continue;
      cache.delete(d);
      e.wrap.remove();
      try { onDrop?.(d, e.el); } catch (err) { console.warn('dayPager onDrop 실패', err); }
    }
  }

  // 자리: 현재 0, 이전 -1, 다음 +1. sideDay(날짜 고르기로 먼 날짜로 갈 때 잠깐 옆자리에 두는 날짜)
  let sideDay = null, sideK = 0;
  function place(e, k) {
    const wrap = e.wrap;
    if (k == null) {
      if (e.k != null && !wrap.hidden) e.top = wrap.scrollTop;   // 숨기기 전 스크롤 자리(다시 보일 때 그대로)
      wrap.hidden = true;
      e.k = null;
      return;
    }
    const wasHidden = wrap.hidden;
    if (e.k !== k) { wrap.style.transform = k ? `translate3d(${k * 100}%,0,0)` : 'none'; e.k = k; }
    wrap.hidden = false;
    if (wasHidden && e.top) wrap.scrollTop = e.top;
    const isCur = k === 0;
    wrap.inert = !isCur;
    if (isCur) wrap.removeAttribute('aria-hidden'); else wrap.setAttribute('aria-hidden', 'true');
  }
  function layout() {
    for (const [d, e] of cache) {
      let k = null;
      if (d === cur) k = 0;
      else if (sideDay && d === sideDay) k = sideK;
      else if (d === prevDay && !(sideDay && sideK === -1)) k = -1;
      else if (d === nextDay && !(sideDay && sideK === 1)) k = 1;
      place(e, k);
    }
  }

  // ---------- 머리 ----------
  function paintHead(d = cur) {
    if (!head) return;
    const p = d === cur ? prevDay : stepDay(d, -1), n = d === cur ? nextDay : stepDay(d, 1);
    titleText.textContent = dayTitle(d, maxDay);
    titleBtn.setAttribute('aria-label', `${dayLabel(d)}, 날짜 고르기`);
    prevBtn.disabled = !p; nextBtn.disabled = !n;
    prevBtn.setAttribute('aria-label', p ? `이전 날짜 ${dayLabel(p)}` : '이전 날짜 없음');
    nextBtn.setAttribute('aria-label', n ? `다음 날짜 ${dayLabel(n)}` : '다음 날짜 없음');
  }
  const announce = d => { live.textContent = dayTitle(d, maxDay); };

  // ---------- 움직임 ----------
  let W = 0, offset = 0, anim = null, prepT = 0;
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(en => { const b = en[0]?.contentRect; if (b?.width) W = b.width; }) : null;
  ro?.observe(vp);
  const width = () => W || (W = vp.clientWidth || 360);
  const setX = x => { offset = x; track.style.transform = x ? `translate3d(${x}px,0,0)` : 'none'; };

  // 움직임이 끝나면 새 이웃을 한 박자 뒤에 그린다
  function schedulePrep() { if (!prepT) prepT = setTimeout(prep, 30); }
  function prep() {
    if (prepT) { clearTimeout(prepT); prepT = 0; }
    if (dead) return;
    ensure(prevDay); ensure(nextDay);
    layout();
    trim();
  }

  // dir: +1 다음 날(왼쪽으로 밀림), -1 이전 날, 0 제자리. to: 갈 날짜(먼 날짜 점프 때)
  function animateTo(dir, { v = 0, to = null } = {}) {
    if (anim) finish(false);
    const target = dir ? (to || (dir > 0 ? nextDay : prevDay)) : null;
    if (dir && !target) dir = 0;
    const toX = -dir * width();
    const dist = Math.abs(toX - offset);
    const speed = Math.max(Math.abs(v), 1.4);
    const ms = reducedMotion() ? 0 : Math.round(Math.min(animMs, Math.max(120, dist / speed)));
    anim = { dir, target, timer: 0 };
    if (dir) { stat.commits++; paintHead(target); }
    if (!ms || dist < 0.5) { finish(true); return; }
    track.style.transition = `transform ${ms}ms ${EASE}`;
    setX(toX);
    const a = anim;
    a.timer = setTimeout(() => { if (anim === a) finish(true); }, ms + 80);   // transitionend 가 안 올 때
    if (dir) requestAnimationFrame(() => { if (anim === a) fireChange(target); });
  }
  let firedFor = null;
  function fireChange(d) {
    if (firedFor === d) return;
    firedFor = d;
    try { onChange?.(d); } catch (err) { console.error('dayPager onChange 실패', err); }
  }
  // 움직임 끝 — 자리 바꾸기(같은 그림 안에서 트랙 0 + 페이지 자리 이동이라 보이는 것은 그대로)
  function finish() {
    const a = anim;
    if (!a) return;
    anim = null;
    clearTimeout(a.timer);
    track.style.transition = 'none';
    if (a.dir && a.target) {
      cur = a.target;
      sideDay = null; sideK = 0;
      prevDay = stepDay(cur, -1); nextDay = stepDay(cur, 1);
      ensure(cur);
      layout();
      setX(0);
      stat.settles++;
      paintHead();
      announce(cur);
      fireChange(cur);
      schedulePrep();
    } else {
      if (sideDay) { sideDay = null; sideK = 0; layout(); }
      setX(0);
      paintHead();
    }
  }
  track.addEventListener('transitionend', e => { if (e.target === track && e.propertyName === 'transform' && anim) finish(); });

  // 움직이는 중에 다시 잡으면: 가던 곳으로 자리를 바로 바꾸고, 지금 보이는 위치에서 이어서 끈다
  function catchAnim() {
    if (!anim) return;
    let x = offset;
    try { const m = new DOMMatrixReadOnly(getComputedStyle(track).transform); x = m.m41; } catch { /* 그대로 */ }
    const a = anim;
    finish();
    if (a.dir) x += a.dir * width();
    setX(x);
  }

  // ---------- 손가락 ----------
  let g = null;                                   // { id, x0, y0, base, mode: 'wait'|'drag'|'off', pts: [[t,x]] }
  let blockClickUntil = 0;
  function onDown(e) {
    if (dead || g || !e.isPrimary) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    blockClickUntil = 0;                          // 새로 누르면 앞 끌기의 click 막기는 끝(빠른 다음 탭을 먹지 않게)
    if (anim) catchAnim();
    if (prepT) prep();                            // 아직 안 그린 이웃이 있으면 지금(끌기 시작 전)
    g = { id: e.pointerId, x0: e.clientX, y0: e.clientY, base: offset, mode: offset ? 'drag' : 'wait', pts: [[e.timeStamp, e.clientX]] };
    if (g.mode === 'drag') startDrag(e);
  }
  function startDrag(e) {
    g.mode = 'drag';
    ensure(prevDay); ensure(nextDay); layout();
    try { vp.setPointerCapture(e.pointerId); } catch { /* 이미 끝남 */ }
    el.classList.add('dragging');
  }
  function onMove(e) {
    if (!g || e.pointerId !== g.id) return;
    const dx = e.clientX - g.x0, dy = e.clientY - g.y0;
    if (g.mode === 'wait') {
      if (Math.abs(dx) < SLOP && Math.abs(dy) < SLOP) return;
      if (Math.abs(dx) > Math.abs(dy) * 1.15) startDrag(e);
      else { g.mode = 'off'; return; }          // 세로 — 브라우저 스크롤에 맡긴다
    }
    if (g.mode !== 'drag') return;
    if (e.cancelable && e.pointerType !== 'touch') e.preventDefault();   // 마우스 끌기에 글자 고르기 막기
    const w = width();
    let x = g.base + dx;
    if (x > 0 && !prevDay) x = rubber(x, w);
    else if (x < 0 && !nextDay) x = rubber(x, w);
    x = Math.max(-w, Math.min(w, x));
    setX(x);
    const t = e.timeStamp;
    g.pts.push([t, e.clientX]);
    while (g.pts.length > 2 && t - g.pts[0][0] > 100) g.pts.shift();
  }
  function onUp(e) {
    if (!g || e.pointerId !== g.id) return;
    const s = g;
    g = null;
    el.classList.remove('dragging');
    if (s.mode !== 'drag') return;
    blockClickUntil = now() + 400;
    if (e.type === 'pointercancel') { animateTo(0); return; }
    const p0 = s.pts[0], p1 = s.pts.at(-1);
    const dt = Math.max(1, p1[0] - p0[0]);
    const v = (e.timeStamp - p1[0] > 80) ? 0 : (p1[1] - p0[1]) / dt;   // 멈췄다 떼면 속도 0
    const w = width(), x = offset;
    let dir = 0;
    if (x < 0 && nextDay && (x < -w * COMMIT_FRAC || (v < -FLICK_V && x < -MIN_FLICK_DX))) dir = 1;
    else if (x > 0 && prevDay && (x > w * COMMIT_FRAC || (v > FLICK_V && x > MIN_FLICK_DX))) dir = -1;
    if (dir && Math.sign(v) === dir && Math.abs(v) > FLICK_V) dir = 0;   // 반대로 튕겨 돌려놓음
    animateTo(dir, { v });
  }
  // 끈 뒤에 따라오는 click(마우스 — 같은 줄에서 누르고 뗌)은 먹는다. 다음 pointerdown 이나 0.4초면 풀린다
  function onClickCap(e) { if (now() < blockClickUntil) { e.stopPropagation(); e.preventDefault(); blockClickUntil = 0; } }
  vp.addEventListener('pointerdown', onDown, { passive: true });
  vp.addEventListener('pointermove', onMove);
  vp.addEventListener('pointerup', onUp, { passive: true });
  vp.addEventListener('pointercancel', onUp, { passive: true });
  vp.addEventListener('click', onClickCap, true);
  // 가로로 끄는 중에는 터치 스크롤 몸짓을 막는다 — 안 막으면 브라우저가 (pan-y 라 움직이지도 않는) 가로 관성 스크롤을 남겨,
  // 넘긴 직후 1~2초 동안 다음 탭(줄 열기·탭 막대)의 click 을 「관성 멈추기」로 먹었다(CDP 터치로 확인).
  // 세로 스크롤은 막지 않는다(끌기 전·세로로 정한 몸짓은 그대로) — 이 리스너 때문에 기다리는 것은 몸짓의 첫 touchmove 한 번뿐.
  const onTouchMove = e => { if (g && g.mode === 'drag' && e.cancelable) e.preventDefault(); };
  vp.addEventListener('touchmove', onTouchMove, { passive: false });

  // ---------- 버튼·날짜 고르기·키 ----------
  prevBtn.addEventListener('click', () => { if (prevDay) go(prevDay, { animate: true }); });
  nextBtn.addEventListener('click', () => { if (nextDay) go(nextDay, { animate: true }); });
  titleBtn.addEventListener('click', () => {
    dateIn.max = maxDay;
    if (min) dateIn.min = min;
    dateIn.value = cur;
    try { if (typeof dateIn.showPicker === 'function') { dateIn.showPicker(); return; } } catch { /* 아래로 */ }
    dateIn.focus(); dateIn.click();
  });
  dateIn.addEventListener('change', () => {
    const v = dateIn.value;
    if (!validDay(v) || v === cur) return;
    go(v > maxDay ? maxDay : v, { animate: true });
  });
  function onKey(e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    const t = e.target;
    if (t instanceof HTMLElement && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
    if (e.key === 'ArrowLeft' && prevDay) { e.preventDefault(); go(prevDay, { animate: true }); }
    else if (e.key === 'ArrowRight' && nextDay) { e.preventDefault(); go(nextDay, { animate: true }); }
  }
  el.addEventListener('keydown', onKey);

  // ---------- 바깥 API ----------
  function go(d, { animate = false } = {}) {
    if (dead || !validDay(d)) return;
    if (d > maxDay) d = maxDay;
    if (min && d < min) d = min;
    if (anim) finish();
    if (d === cur) { paintHead(); return; }
    const dir = d > cur ? 1 : -1;
    const near = (dir > 0 ? nextDay : prevDay) === d;
    if (!animate || reducedMotion()) {
      cur = d; sideDay = null;
      prevDay = stepDay(cur, -1); nextDay = stepDay(cur, 1);
      ensure(cur); layout(); setX(0);
      paintHead(); announce(cur); fireChange(cur);
      schedulePrep();
      return;
    }
    if (!near) { sideDay = d; sideK = dir; }      // 먼 날짜: 그 쪽 옆자리에 잠깐 두고 넘긴다
    ensure(d); layout();
    animateTo(dir, { to: d });
    if (anim) announce(d);
  }

  function refresh(d) {
    if (dead) return;
    if (validDay(d)) {
      const e = cache.get(d);
      if (!e) return;
      if (d === cur) { e.stale = true; ensure(d); }
      else { e.stale = true; if (d === prevDay || d === nextDay) schedulePrep(); }
      return;
    }
    for (const [k, e] of cache) e.stale = true;
    ensure(cur);
    schedulePrep();
  }

  function setMax(m) {
    if (!validDay(m) || m === maxDay) return;
    maxDay = m;
    if (cur > maxDay) { go(maxDay); return; }
    prevDay = stepDay(cur, -1); nextDay = stepDay(cur, 1);
    paintHead();
    schedulePrep();
  }

  function destroy() {
    if (dead) return;
    dead = true;
    clearTimeout(prepT); prepT = 0;
    if (anim) { clearTimeout(anim.timer); anim = null; }
    ro?.disconnect();
    vp.removeEventListener('pointerdown', onDown);
    vp.removeEventListener('pointermove', onMove);
    vp.removeEventListener('pointerup', onUp);
    vp.removeEventListener('pointercancel', onUp);
    vp.removeEventListener('click', onClickCap, true);
    vp.removeEventListener('touchmove', onTouchMove);
    el.removeEventListener('keydown', onKey);
    for (const [d, e] of cache) { try { onDrop?.(d, e.el); } catch { /* 무시 */ } }
    cache.clear();
    el.remove();
  }

  // 첫 그림: 현재만 바로, 이웃은 한 박자 뒤
  ensure(cur);
  layout();
  paintHead();
  schedulePrep();

  return {
    el, go, refresh, setMax, destroy,
    day: () => cur,
    stats: () => ({ ...stat, cached: [...cache.keys()], prev: prevDay, next: nextDay, offset }),
  };
}
