// 도면 보기 부품 — 도면보관함 도면을 지도처럼(livemap 이미지 좌표계 + drawtiles 타일) + 이름 핀 + (위치 맞춘 도면이면) 내 위치·보는 방향.
// 사용자 요구: "도면은 따로 모아두자. 도면보관함을 따로 만들어서 길찾고 핀 가능하게. 핀에도 이름을". 도면 보기·촬영 화면·묶음 상세가 같이 쓴다.
// 체감 속도: 뷰어 iframe 을 띄우지 않는다 — 한 번 떠 둔 타일(OPFS objectURL)과 미리보기 한 장. 움직임은 엔진이 transform 만.
//   위치·방향 알림은 rAF 한 번에 모아 setMe 하나(값이 바뀔 때만). 핀은 바뀔 때만 setMarkers.
//
// drawingView({ drawingId, page = 0, mode = 'view'|'place', me = false, highlight = null, showPins = 'all'|'none'|{ recordId }|{ recordIds }|{ pinIds },
//               compact = false, onPlace(x, y), onTapPin(pinId), onCancel?, placeLabel?, center?:{x,y}, fitOffset? })
//   → { el, setMode(m, { label, at }), focusPin(id, { zoom }), refresh(), destroy(),
//       // 덧붙임: engine() · center() → {x,y} · page() · setPage(n) · setHighlight(id) · setShowPins(v) · setRoute(pinId|{x,y}|null)
//       //        setFollow(false|'pos'|'heading') · follow() · onFollow(fn) · fit() · meState() → { x, y, accPx, outsideM, pos, heading, angle } | null
//       //        transform() → T | null · onMe(fn(state)) → off · ready() → Promise(엔진이 뜬 뒤)
//       //        placeNow() — 찍기 모드에서 지금 십자 자리로 onPlace(부모가 확정 버튼을 따로 둘 때 — 촬영 화면은 셔터 위 줄) }
//   page 0 = 위치 맞춘 쪽(없으면 1쪽). me:true 면 위치 맞춘 쪽일 때 gps·heading 을 켜고(참조 계수) 파란 점·정확도 원·부채꼴을 그린다.
//   showPins 객체: 그 묶음(recordId/recordIds)·그 핀(pinIds) 은 진하게, 나머지는 흐리게(others:'hide' 면 숨김).
//   mode 'place': 가운데 십자 + [여기에 찍기](노랑)·[취소](onCancel 이 있을 때) → onPlace(x, y)(쪽 그림 픽셀). 도면을 탭하면 그 자리로 옮긴다.
//     위치 맞춘 도면이고 GPS ±15m 안이면 처음 십자를 내 위치에 둔다(1탭).
//   compact: 손동작 없음·나침반 없음(작은 미리 보기 — 누르면 부모가 받는다). 핀 탭은 onTapPin.
//   data-testid: drawing-view, dwv-pin[data-id](핀), dwv-me(내 위치), dwv-cross, dwv-place-ok, dwv-place-cancel, dwv-status
import { h, isTyping, onTyping } from '../dom.js';
import { liveMap } from './livemap.js';
import * as D from '../../data/drawings.js';
import * as DT from '../../media/drawtiles.js';
import * as G from '../../core/georef.js';
import * as gps from '../../services/gps.js';
import * as heading from '../../services/heading.js';

const ME_FIRST_M = 15;                  // 핀 찍기 십자를 내 위치에 먼저 둘 GPS 정확도
const fin = Number.isFinite;
const SVGNS = 'http://www.w3.org/2000/svg';
function crossSvg() {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 48 48'); s.setAttribute('width', '48'); s.setAttribute('height', '48'); s.setAttribute('aria-hidden', 'true');
  for (const [d, c, w] of [['M24 2v16M24 30v16M2 24h16M30 24h16', '#fff', 6], ['M24 2v16M24 30v16M2 24h16M30 24h16', '#000', 2.5]]) {
    const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); p.setAttribute('stroke', c); p.setAttribute('stroke-width', w); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('fill', 'none'); s.append(p);
  }
  const c = document.createElementNS(SVGNS, 'circle'); c.setAttribute('cx', '24'); c.setAttribute('cy', '24'); c.setAttribute('r', '3'); c.setAttribute('fill', '#C4122F'); c.setAttribute('stroke', '#fff'); c.setAttribute('stroke-width', '1.5'); s.append(c);
  return s;
}

export function drawingView({
  drawingId, page = 0, mode = 'view', me = false, highlight = null, showPins = 'all', compact = false,
  onPlace = null, onTapPin = null, onCancel = null, placeLabel = '여기에 찍기', center = null, fitOffset = null,
} = {}) {
  let alive = true, map = null, srcSig = '', curPage = page || 0, curMode = mode === 'place' ? 'place' : 'view';
  let hl = highlight, show = showPins, route = null, T = null, meOn = false, stopG = null, stopH = null;
  let placeAt = null, okLabel = placeLabel, wantFocus = null, followMode = false;
  const offs = [], meSubs = new Set(), followSubs = new Set();
  let readyRes = null;
  const readyP = new Promise(r => { readyRes = r; });

  const status = h('div', { class: 'dwvw-status', role: 'status', 'data-testid': 'dwv-status', hidden: true });
  const chip = h('div', { class: 'dwvw-chip', role: 'status', hidden: true });
  const cross = h('div', { class: 'dwvw-cross', 'data-testid': 'dwv-cross', hidden: true }, crossSvg());
  const okBtn = h('button', { type: 'button', class: 'primary dwvw-ok', 'data-testid': 'dwv-place-ok', onclick: () => place() });
  const cancelBtn = h('button', { type: 'button', class: 'secondary dwvw-cancel', 'data-testid': 'dwv-place-cancel', text: '취소', onclick: () => { try { onCancel?.(); } catch (e) { console.error(e); } } });
  const placeBar = h('div', { class: 'dwvw-place', hidden: true }, cancelBtn, okBtn);
  const host = h('div', { class: 'dwvw-host' });
  const el = h('div', { class: ['dwvw', compact && 'compact'], 'data-testid': 'drawing-view', 'data-id': drawingId || '', 'data-mode': curMode }, host, status, chip, cross, placeBar);

  const pageNo = () => {
    if (curPage > 0) return curPage;
    const d = D.drawing(drawingId);
    return d?.geo?.page || d?.pages?.[0]?.page || 1;
  };

  // ---- 핀 → 마커 ----
  function kindOf(p) {
    if (hl && p.id === hl) return 'dpinsel';
    if (show && typeof show === 'object') {
      const strong = (show.recordId && p.recordId === show.recordId) || (show.recordIds?.includes?.(p.recordId)) || (show.pinIds?.includes?.(p.id));
      if (strong) return 'dpin';
      return show.others === 'hide' ? null : 'dpinmuted';
    }
    return 'dpin';
  }
  let mkSig = '';
  function drawPins() {
    if (!map) return;
    const list = [];
    if (show !== 'none' || hl) {
      for (const p of D.pins(drawingId, { page: pageNo() })) {
        if (show === 'none' && p.id !== hl) continue;
        const kind = kindOf(p);
        if (!kind) continue;
        list.push({ id: p.id, x: p.x, y: p.y, label: String(p.no), name: p.name, kind, testid: 'dwv-pin', dataId: p.id });
      }
      // 고른 핀은 맨 위에(겹칠 때 가리지 않게)
      list.sort((a, b) => (a.kind === 'dpinsel') - (b.kind === 'dpinsel') || (a.kind === 'dpin') - (b.kind === 'dpin'));
    }
    const sig = list.map(m => `${m.id}:${m.x},${m.y}:${m.kind}:${m.name}:${m.label}`).join('|');
    if (sig === mkSig) return;
    mkSig = sig;
    map.setMarkers(list);
    el.dataset.pins = String(list.length);
  }

  // ---- 상태 글(그림 만드는 중·없음) ----
  function drawStatus() {
    const d = D.drawing(drawingId);
    const st = DT.buildState(drawingId);
    const pg = D.pageOf(drawingId, pageNo());
    let big = '', small = '';
    if (!d) big = '도면을 찾을 수 없어요';
    else if (!map) {
      if (d.missingFile) big = '원본 파일을 다시 올려 주세요';
      else if (st?.phase === 'error') big = st.message || '그림을 못 만들었어요';
      else if (st?.phase === 'tiles') big = `그림 만드는 중 ${st.pct}%`;
      else big = '도면을 그리는 중이에요…';
    } else if (pg && !pg.tiles?.ready && st) small = st.phase === 'tiles' ? `그림 만드는 중 ${st.pct}%` : '그림 만드는 중…';
    status.hidden = !big; if (status.textContent !== big) status.textContent = big;
    chip.hidden = !small || compact; if (chip.textContent !== small) chip.textContent = small;
    el.dataset.state = !d ? 'missing' : map ? (pg?.tiles?.ready ? 'ready' : 'partial') : (st?.phase === 'error' ? 'error' : 'building');
  }

  // ---- 엔진 ----
  function ensureMap() {
    const pn = pageNo();
    const src = DT.tileSource(drawingId, pn);
    if (!src) {
      const d = D.drawing(drawingId);
      if (d && !d.missingFile && !d.deletedAt && !DT.buildState(drawingId)) DT.queueDrawing(drawingId, { page: pn });
      drawStatus();
      return;
    }
    if (map) {
      if (src.sig !== srcSig) { srcSig = src.sig; map.setSource(src); }
      drawStatus();
      return;
    }
    srcSig = src.sig;
    const focus = wantFocus ? D.pin(wantFocus) : (hl ? D.pin(hl) : null);
    const c = center || (focus && focus.page === pn ? { x: focus.x, y: focus.y } : null);
    map = liveMap({ source: src, center: c, fitOffset: fin(fitOffset) ? fitOffset : (c ? (compact ? 1.2 : 1.6) : 0), compass: !compact, gestures: !compact });
    wantFocus = null;
    host.replaceChildren(map.el);
    map.onMarker(m => { try { onTapPin?.(m.id); } catch (e) { console.error(e); } });
    map.onTap(ev => { if (curMode === 'place') map.setView(ev.at, null, { animate: true }); });
    map.onFollow(m => { followMode = m; for (const fn of [...followSubs]) { try { fn(m); } catch (e) { console.error(e); } } });
    map.el.querySelector('.lm-me')?.setAttribute('data-testid', 'dwv-me');
    if (!pg0()?.tiles?.ready) DT.queueDrawing(drawingId, { page: pn });       // 다 못 만들었으면 이어서
    drawPins();
    setupMe();
    applyRoute();
    applyMode();
    drawStatus();
    readyRes?.(api);
  }
  const pg0 = () => D.pageOf(drawingId, pageNo());

  // ---- 내 위치(위치 맞춘 쪽일 때만) ----
  let offMe = [];
  let meLate = false, offTypeMe = null;      // 글 입력 중이라 미룬 내 위치 그리기
  function stopMe() {
    for (const f of offMe) { try { f(); } catch { /* 무시 */ } }
    offMe = [];
    try { stopG?.(); stopH?.(); } catch { /* 무시 */ }
    stopG = stopH = null;
    meOn = false;
    meLate = false; offTypeMe?.(); offTypeMe = null;
  }
  function setupMe() {
    T = D.transformOf(drawingId);
    const d = D.drawing(drawingId);
    const want = !!(me && T && d?.geo?.page === pageNo() && map);
    if (map) map.setNorth?.(T ? G.northOnDrawing(T) : null);
    if (want === meOn) { if (want) { meKey = ''; scheduleMe(); } return; }
    if (want) {
      meOn = true;
      stopG = gps.start(); stopH = heading.start();
      offMe = [gps.on(scheduleMe), heading.on(scheduleMe)];
      scheduleMe();
    } else {
      stopMe();
      map?.setMe(null);
      meState = null; meKey = '';
      emitMe();
    }
  }
  let meRaf = 0, meKey = '', meState = null;
  // 글 입력 중(키보드·한글 조합)에는 내 위치·방향을 그리지 않고 미뤄 둔다 — 끝나면 한 번(docs/속도-감사.md: 입력과 다투지 않기)
  function scheduleMe() {
    if (!alive) return;
    if (isTyping()) {
      meLate = true;
      if (!offTypeMe) offTypeMe = onTyping(v => { if (v || !meLate) return; meLate = false; scheduleMe(); });
      return;
    }
    if (!meRaf) meRaf = requestAnimationFrame(applyMe);
  }
  function applyMe() {
    meRaf = 0;
    if (!alive || !map || !meOn || !T) return;
    const g = gps.snapshot() || {}, hd = heading.snapshot() || {};
    const pos = g.pos;
    if (!pos) { if (meKey) { map.setMe(null); meKey = ''; meState = null; emitMe(); } return; }
    const q = G.toXY(T, pos.lat, pos.lng);
    if (!q) return;
    const mpp = G.metersPerPx(T);
    const accPx = fin(pos.acc) && mpp ? pos.acc / mpp : null;
    const ang = fin(hd.heading) ? G.drawingAngle(T, hd.heading) : null;
    const pg = pg0();
    const outside = pg ? G.outsideM(T, pg.w, pg.h, pos.lat, pos.lng) : null;
    meState = Object.freeze({ x: q.x, y: q.y, accPx, outsideM: outside, pos, heading: fin(hd.heading) ? hd.heading : null, angle: ang });
    const k = `${q.x.toFixed(1)},${q.y.toFixed(1)},${Math.round(accPx ?? -1)},${ang == null ? '-' : Math.round(ang)}`;
    if (k !== meKey) { meKey = k; map.setMe({ x: q.x, y: q.y, accPx, heading: ang }); }
    emitMe();
  }
  function emitMe() { for (const fn of [...meSubs]) { try { fn(meState); } catch (e) { console.error(e); } } }

  // ---- 길찾기 점선 ----
  function applyRoute() {
    if (!map) return;
    if (!route) { map.setRoute(null); return; }
    const p = typeof route === 'string' ? D.pin(route) : route;
    map.setRoute(p && fin(p.x) ? { x: p.x, y: p.y } : null);
  }

  // ---- 찍기 모드 ----
  function applyMode() {
    el.dataset.mode = curMode;
    const placing = curMode === 'place';
    cross.hidden = !placing;
    placeBar.hidden = !placing || compact;
    cancelBtn.hidden = !onCancel;
    if (okBtn.textContent !== okLabel) okBtn.textContent = okLabel;
    if (!placing || !map) return;
    let at = placeAt;
    if (!at && meState && fin(meState.pos?.acc) && meState.pos.acc <= ME_FIRST_M && !(meState.outsideM > 0)) at = { x: meState.x, y: meState.y };
    if (at) map.setView(at, Math.max(map.zoom(), (map.fitZoom?.() ?? 0) + 1.5), { animate: true });
    placeAt = null;
  }
  function place() {
    if (!map) return;
    const c = map.center();
    const pg = pg0();
    const x = Math.max(0, Math.min(pg?.w ?? c.x, c.x)), y = Math.max(0, Math.min(pg?.h ?? c.y, c.y));
    try { onPlace?.(Math.round(x * 100) / 100, Math.round(y * 100) / 100); } catch (e) { console.error(e); }
  }

  // ---- 구독 ----
  offs.push(D.onDrawings(ev => {
    if (!alive) return;
    if (ev.drawings.has(drawingId)) { ensureMap(); setupMe(); }
    if (ev.pins.size) drawPins();
  }));
  offs.push(DT.onBuild(id => { if (id === drawingId && alive) { drawStatus(); if (!map) ensureMap(); } }));

  D.ready().then(() => { if (alive) ensureMap(); }, e => {
    console.error('도면보관함을 열지 못했어요', e);
    status.hidden = false; status.textContent = '도면보관함을 열지 못했어요';
  });
  drawStatus();

  // ---- 바깥 함수 ----
  const api = {
    el,
    setMode(m, { label, at } = {}) {
      curMode = m === 'place' ? 'place' : 'view';
      okLabel = label || placeLabel;
      placeAt = at && fin(at.x) ? at : null;
      applyMode();
    },
    focusPin(id, { zoom } = {}) {
      const p = D.pin(id);
      if (!p) return;
      if (p.page !== pageNo()) { wantFocus = id; api.setPage(p.page); if (!map) return; }
      if (!map) { wantFocus = id; return; }
      map.setFollow(false);
      map.setView({ x: p.x, y: p.y }, fin(zoom) ? zoom : Math.max(map.zoom(), (map.fitZoom?.() ?? 0) + 1.6), { animate: true });
    },
    refresh() { mkSig = ''; ensureMap(); drawPins(); setupMe(); drawStatus(); },
    destroy() {
      if (!alive) return;
      alive = false;
      cancelAnimationFrame(meRaf);
      for (const f of offs) { try { f?.(); } catch { /* 무시 */ } }
      stopMe();
      meSubs.clear(); followSubs.clear();
      map?.destroy(); map = null;
      el.remove();
    },
    // 덧붙임
    engine: () => map,
    center: () => map?.center() || null,
    page: pageNo,
    setPage(n) {
      if (!(n > 0) || n === pageNo()) return;
      curPage = n; srcSig = ''; mkSig = ''; meKey = '';
      stopMe(); meState = null;
      map?.destroy(); map = null;
      host.replaceChildren();
      ensureMap();
    },
    setHighlight(id) { hl = id || null; drawPins(); },
    placeNow() { if (curMode === 'place') place(); },
    setShowPins(v) { show = v; drawPins(); },
    setRoute(r) { route = r || null; applyRoute(); },
    setFollow(m) { map?.setFollow(m); },
    follow: () => followMode,
    onFollow(fn) { followSubs.add(fn); return () => followSubs.delete(fn); },
    fit() { map?.fit(); },
    meState: () => meState,
    onMe(fn) { meSubs.add(fn); return () => meSubs.delete(fn); },
    transform: () => T,
    ready: () => readyP,                // 엔진이 뜬 뒤(쪽 그림이 있을 때) 풀린다
  };
  Object.defineProperty(el, '__dwv', { value: api });                // 시험용(www/dev)
  return api;
}
