// 실시간 지도 엔진 — VWorld WMTS 타일을 <img> 로 깔고, 레이어 div 에 transform(이동·회전·배율)만 바꿔 움직인다(외부 지도 라이브러리 없음).
// 사용자 요구: 「실시간 위치 보기」를 누르면 지도에 내 위치가 보이고, 네이버 지도 길찾기처럼 보는 방향(부채꼴)까지.
// 체감 속도: 손으로 움직이는 동안은 레이어 transform 과 겹침 요소(내 위치·마커) transform 만 쓴다. 타일은 보이는 범위가 바뀔 때만
// 더하고 빼며, <img> 는 풀에서 다시 쓴다. 레이아웃을 읽는 일은 손을 댈 때 getBoundingClientRect 한 번뿐(크기는 ResizeObserver).
// 약관(reference/vworld-brief.md §4·§6): 타일은 브라우저 기본 캐시만 — SW·IDB 에 저장하지 않고 미리 받지도 않는다. crossOrigin 은 비워 둔다.
//
// const m = liveMap({ center:{lat,lng}, zoom:17, layer:'Base'|'Satellite'|'Hybrid', key, rotate:0 })
//   m.el                                  — 붙일 요소(크기는 부모가 정한다: 예) .lm 에 height 를 주거나 flex:1)
//   m.setView({lat,lng}|null, zoom?, {animate=true})   — 손으로 움직이는 중에는 무시(false 를 돌려준다)
//   m.setLayer(layer) · m.setRotation(deg, {animate=true})  — deg = 화면 위쪽이 가리키는 방위(0 북쪽 위, 「진행 방향 위」는 보는 방향)
//   m.setMe({lat,lng,acc,heading}|null)   — 파란 점 + 정확도 원(미터→픽셀) + 보는 방향 부채꼴(heading 이 있을 때, 지도 회전과 합성)
//   m.setMarkers([{id,lat,lng,label,kind}]) · m.onMarker(fn(marker)) · m.onMove(fn({kind:'pan'|'zoom'|'rotate', phase:'start'|'end', center, zoom}))
//   m.center() → {lat,lng} · m.zoom() → number · m.destroy()
// 덧붙임(계약 밖, 쓰면 편함):
//   m.setFollow(false|'pos'|'heading') · m.follow() · m.onFollow(fn(mode)) — 따라가기. 'pos' 는 내 위치를 가운데에, 'heading' 은 거기에 더해
//     보는 방향을 위로 돌리고 내 위치를 조금 아래(앞이 더 보이게)에 둔다. 손으로 끌면 스스로 풀리고 onFollow(false)·onMove 를 부른다.
//     따라가는 동안 두 손가락·두 번 탭 확대는 내 위치를 기준으로 한다(놓치지 않게).
//   m.zoomBy(d, {animate}) · m.rotation() · m.layer() · m.project(lat,lng) → {x,y} · m.unproject(x,y) → {lat,lng}
//   m.onError(fn(message)) — 타일을 못 받을 때 한 번(다시 잘 받으면 다음 실패 때 또 한 번). el 에도 'livemap:error' 이벤트.
//   m.setKey(key) — 설정에서 키를 바꿨을 때.
import { h } from '../dom.js';
import * as TM from '../../core/tilemath.js';
import { VWORLD_KEY } from '../../config.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const ANIM_MS = 300;                     // setView·내 위치 이동(둘이 같아야 따라가기에서 점이 흔들리지 않는다)
const SNAP_MS = 180;                     // 손을 뗀 뒤 정수 확대로 맞추기
const SLOP = 6;                          // 이만큼 움직여야 끌기(그 안은 탭)
const DBL_MS = 300, DBL_PX = 30;
const PAD = 64;                          // 보이는 범위 바깥 미리 받기(px)
const POOL_MAX = 200;
const ERR_TEXT = '지도를 못 불러왔어요(인터넷·키 확인)';
const NOKEY_TEXT = 'VWorld 키를 넣으면 지도가 보여요';
// 못 받은 칸 — src 를 비우면 브라우저가 「깨진 그림」 표시를 그리므로 회색 1px 그림(인라인, 외부 요청 없음)으로 채운다
const GRAY = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3Crect width='1' height='1' fill='%23C9CCC6'/%3E%3C/svg%3E";

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const easeOut = t => 1 - (1 - t) ** 3;
const lerp = (a, b, t) => a + (b - a) * t;
const svg = (tag, attrs) => { const e = document.createElementNS(SVGNS, tag); for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v); return e; };

// ---- <img> 풀(모든 지도가 같이 쓴다) ----
const pool = [];
function takeImg() {
  const im = pool.pop() || Object.assign(document.createElement('img'), { alt: '', decoding: 'async', draggable: false, className: 'lm-t' });
  im.setAttribute('aria-hidden', 'true');
  return im;
}
function freeImg(im) {
  im.onload = im.onerror = null;
  im.removeAttribute('src');                                         // 받는 중이면 요청도 끊긴다
  im.className = 'lm-t';
  im.remove();
  if (pool.length < POOL_MAX) pool.push(im);
}

let gradSeq = 0;

export function liveMap({ center = { lat: 37.5666, lng: 126.9782 }, zoom = 17, layer = 'Base', key = VWORLD_KEY, rotate = 0, compass = true } = {}) {
  // ---- 상태 ----
  let apiKey = String(key || '').trim();
  let curLayer = TM.LAYERS[layer] ? layer : 'Base';
  const c0 = TM.toMerc(center?.lat ?? 37.5666, center?.lng ?? 126.9782);
  let cx = c0.x, cy = c0.y, z = TM.clampZoom(zoom), bearing = TM.normDeg(rotate || 0);
  let W = 0, H = 0;
  let front = null, back = null;
  let raf = 0, alive = true, lastFrame = 0;
  let viewAnim = null, rotAnim = null, inertia = null;
  let follow = false;
  const subs = { marker: new Set(), move: new Set(), follow: new Set(), error: new Set() };
  const stats = { loads: 0, errors: 0, frames: 0, levels: 0 };

  // ---- DOM ----
  const tilesBox = h('div', { class: 'lm-tiles' });
  const ov = h('div', { class: 'lm-ov' });
  const note = h('div', { class: 'lm-note', role: 'status', hidden: true });
  const attr = h('div', { class: 'lm-attr', text: '© VWorld(국토교통부)' });
  const needle = svg('g', {});
  needle.append(svg('path', { d: 'M22 6 L27 22 L17 22 Z', fill: '#C4122F' }), svg('path', { d: 'M22 38 L27 22 L17 22 Z', fill: '#9EA39C' }));
  const nLetter = svg('text', { x: '22', y: '17.5', 'text-anchor': 'middle', 'font-size': '9', 'font-weight': '900', fill: '#fff' });
  nLetter.textContent = 'N';
  needle.append(nLetter);
  const compassSvg = svg('svg', { width: '44', height: '44', viewBox: '0 0 44 44', 'aria-hidden': 'true', focusable: 'false' });
  compassSvg.append(needle);
  const compassBtn = h('button', { type: 'button', class: 'lm-compass', 'aria-label': '북쪽을 위로', hidden: true, onclick: () => {
    if (follow === 'heading') setFollowMode('pos');
    setRotationInner(0, true);
    emitMove('rotate', 'start'); emitMove('rotate', 'end');
  } }, compassSvg);
  const el = h('div', { class: 'lm', role: 'region', 'aria-label': '지도', 'data-testid': 'livemap', 'data-layer': curLayer },
    tilesBox, ov, note, attr, compass ? compassBtn : null);

  // 내 위치: 정확도 원 · 방향 부채꼴 · 점
  const gid = `lmfan${++gradSeq}`;
  const fan = svg('svg', { class: 'lm-fan', width: '140', height: '140', viewBox: '0 0 140 140', 'aria-hidden': 'true', focusable: 'false' });
  const defs = svg('defs', {});
  const grad = svg('radialGradient', { id: gid, cx: '70', cy: '70', r: '68', gradientUnits: 'userSpaceOnUse' });
  grad.append(svg('stop', { offset: '0', 'stop-color': '#1546C9', 'stop-opacity': '.8' }), svg('stop', { offset: '.55', 'stop-color': '#1546C9', 'stop-opacity': '.45' }),
    svg('stop', { offset: '1', 'stop-color': '#1546C9', 'stop-opacity': '0' }));
  defs.append(grad);
  const A = 32 * Math.PI / 180, R = 68;                                 // 보는 방향 ±32°, 반지름 68px(네이버 길찾기의 빛줄기 느낌)
  fan.append(defs, svg('path', { d: `M70 70 L${(70 - R * Math.sin(A)).toFixed(2)} ${(70 - R * Math.cos(A)).toFixed(2)} A${R} ${R} 0 0 1 ${(70 + R * Math.sin(A)).toFixed(2)} ${(70 - R * Math.cos(A)).toFixed(2)} Z`, fill: `url(#${gid})` }));
  const acc = h('div', { class: 'lm-acc' });
  const dot = h('div', { class: 'lm-dot' });
  const meEl = h('div', { class: 'lm-me', 'data-testid': 'livemap-me', hidden: true, 'aria-label': '내 위치' }, acc, fan, dot);
  const mkBox = h('div', { class: 'lm-mks' });
  ov.append(mkBox, meEl);

  // ---- 보기 ----
  const view = () => ({ cx, cy, z, bearing, w: W, h: H });
  const schedule = () => { if (!raf && alive) raf = requestAnimationFrame(frame); };

  // ---- 타일 단계(level) ----
  // 한 단계 = 정수 확대 lz 의 타일을 담는 div. 원점(ox,oy)은 만들 때 가운데 근처 타일 모서리 — 숫자를 작게 두려고
  function makeLevel(lz) {
    const srcs = TM.layerSources(curLayer);
    const s = TM.worldSize(lz);
    const lv = {
      z: lz, layer: curLayer, srcs,
      ox: Math.floor(cx * s / TM.TILE) * TM.TILE, oy: Math.floor(cy * s / TM.TILE) * TM.TILE,
      el: h('div', { class: 'lm-lv', 'data-z': lz }),
      subs: srcs.map((src, i) => h('div', { class: 'lm-src', 'data-src': src.name, 'data-i': i })),
      tiles: new Map(), range: null, pending: 0, tf: '',
    };
    lv.el.append(...lv.subs);
    stats.levels++;
    return lv;
  }
  function dropLevel(lv) {
    if (!lv) return;
    for (const t of lv.tiles.values()) for (const im of t.imgs) freeImg(im);
    lv.tiles.clear();
    lv.el.remove();
  }
  function switchFront(lz) {
    if (back) dropLevel(back);
    back = front;
    if (back) back.el.classList.add('back');
    front = makeLevel(lz);
    tilesBox.append(front.el);                                         // 뒤 단계 위에 — 새 타일이 오기 전에는 뒤 단계가 비쳐 보인다
  }
  function maybeDropBack() {
    if (back && front && front.pending === 0 && front.tiles.size) { dropLevel(back); back = null; }
  }

  // 타일 하나 = 원본(레이어) 수만큼 <img>
  function addTile(lv, t) {
    const entry = { imgs: [], need: lv.srcs.length, done: 0, bad: false };
    const left = t.x * TM.TILE - lv.ox, top = t.y * TM.TILE - lv.oy;
    lv.srcs.forEach((src, i) => {
      const im = takeImg();
      im.style.left = `${left}px`; im.style.top = `${top}px`;
      im.onload = () => { im.onload = im.onerror = null; im.classList.add('on'); stats.loads++; tileOk(); fin(); };
      im.onerror = () => {
        im.onload = im.onerror = null;
        markBad(im, i);
        entry.bad = true; stats.errors++;
        tileFail();
        fin();
      };
      im.dataset.u = TM.tileUrl(apiKey, src, t.z, t.x, t.y);
      lv.subs[i].append(im);
      entry.imgs.push(im);
      im.src = im.dataset.u;
    });
    function fin() { if (++entry.done === entry.need) { lv.pending--; maybeDropBack(); } }
    lv.tiles.set(t.key, entry);
    lv.pending++;
  }
  function markBad(im, i) {
    im.classList.add('bad');
    if (i === 0) im.src = GRAY;                                         // 바닥 원본만 회색 칸(겹침 지명은 그냥 숨김)
    else im.removeAttribute('src');
  }
  function removeTile(lv, k, entry) {
    if (entry.done < entry.need) lv.pending--;
    for (const im of entry.imgs) freeImg(im);
    lv.tiles.delete(k);
  }

  // 보이는 범위가 바뀌었을 때만 타일을 더하고 뺀다. 빼는 것은 범위 밖으로 한 칸 더 나간 것만(왔다 갔다 할 때 다시 받지 않게)
  function updateTiles(lv, v) {
    if (!W || !H || !apiKey) return;
    const r = TM.tileRange(v, lv.z, PAD);
    if (TM.sameRange(r, lv.range)) return;
    lv.range = r;
    const n = 2 ** lv.z;
    const kx0 = Math.max(0, r.x0 - 1), kx1 = Math.min(n - 1, r.x1 + 1), ky0 = Math.max(0, r.y0 - 1), ky1 = Math.min(n - 1, r.y1 + 1);
    for (const [k, e] of lv.tiles) {
      const [, xs, ys] = k.split('/');
      const x = +xs, y = +ys;
      if (x < kx0 || x > kx1 || y < ky0 || y > ky1) removeTile(lv, k, e);
    }
    for (const t of TM.tilesIn(r, v)) if (!lv.tiles.has(t.key)) addTile(lv, t);
    maybeDropBack();
  }

  function levelTransform(lv) {
    const s = 2 ** (z - lv.z), ws = TM.worldSize(lv.z);
    const tx = lv.ox - cx * ws, ty = lv.oy - cy * ws;
    const tf = `translate(${W / 2}px,${H / 2}px) rotate(${-bearing}deg) scale(${s}) translate(${tx}px,${ty}px)`;
    if (tf !== lv.tf) { lv.tf = tf; lv.el.style.transform = tf; }
  }

  // ---- 타일 실패 알림(한 번만) ----
  let errShown = false, errSince = 0, errT = 0;
  function tileFail() {
    if (errShown) return;
    errShown = true; errSince = performance.now();
    showNote(ERR_TEXT);
    clearTimeout(errT);
    errT = setTimeout(() => { if (alive && apiKey) showNote(null); }, 6000);          // 알림 글은 잠깐만(회색 칸은 남는다)
    el.dataset.tileError = '1';
    for (const fn of [...subs.error]) { try { fn(ERR_TEXT); } catch (e) { console.error(e); } }
    try { el.dispatchEvent(new CustomEvent('livemap:error', { detail: { message: ERR_TEXT }, bubbles: true })); } catch { /* 무시 */ }
  }
  function tileOk() {
    if (!errShown || front?.el.querySelector('img.lm-t.bad')) return;  // 회색 칸이 다 풀렸을 때만(같은 순간 받은 다른 타일 때문에 지우지 않게)
    errShown = false;
    clearTimeout(errT);
    delete el.dataset.tileError;
    if (apiKey) showNote(null);
  }
  function showNote(text) { note.hidden = !text; note.textContent = text || ''; }
  // 인터넷이 돌아오면 실패한 칸만 다시
  function onOnline() {
    for (const lv of [front, back]) {
      if (!lv) continue;
      for (const e of lv.tiles.values()) {
        if (!e.bad) continue;
        e.bad = false;
        e.imgs.forEach((im, i) => {
          if (im.classList.contains('on')) return;
          im.classList.remove('bad');
          e.done--;
          if (e.done === e.need - 1) lv.pending++;
          im.onload = () => { im.onload = im.onerror = null; im.classList.add('on'); stats.loads++; tileOk(); if (++e.done === e.need) { lv.pending--; maybeDropBack(); } };
          im.onerror = () => { im.onload = im.onerror = null; markBad(im, i); e.bad = true; stats.errors++; tileFail(); if (++e.done === e.need) { lv.pending--; maybeDropBack(); } };
          im.src = im.dataset.u;
        });
      }
    }
  }
  addEventListener('online', onOnline);

  // ---- 내 위치 ----
  let me = null;                     // { mx, my, acc, heading, lat }
  let meDisp = null;                 // 화면에 그리는 값(부드럽게 따라감)
  let meAnim = null;                 // { from:{mx,my}, t0 }
  let headDisp = null;
  let lastTick = 0;

  // 따라가기 가운데: 'heading' 은 내 위치를 화면 가운데보다 아래(앞이 더 보이게)
  function anchorFor(mx, my, b = bearing, zz = z) {
    const off = follow === 'heading' ? H * 0.18 : 0;
    if (!off) return { x: mx, y: my };
    const p = TM.rotate(0, off, b), s = TM.worldSize(zz);
    return { x: mx - p.x / s, y: my - p.y / s };
  }
  // 확대 기준점(화면): 따라가는 중이면 내 위치 자리
  function zoomAnchorScreen(x, y) {
    if (follow && me) return { x: W / 2, y: H / 2 + (follow === 'heading' ? H * 0.18 : 0) };
    return { x, y };
  }

  // ---- 그리기 ----
  let mkList = [];                   // [{ m, el, mx, my, tf }]
  function placeOverlays(v) {
    for (const k of mkList) {
      const p = TM.mercToScreen(v, k.mx, k.my);
      const tf = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px)`;
      if (tf !== k.tf) { k.tf = tf; k.el.style.transform = tf; }
    }
    if (meDisp) {
      const p = TM.mercToScreen(v, meDisp.mx, meDisp.my);
      meEl.style.transform = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px)`;
      const r = Number.isFinite(me?.acc) && me.acc > 0 ? Math.min(4000, TM.metersToPx(me.acc, me.lat, z)) : 0;
      const rr = r < 12 ? 0 : Math.round(r * 2) / 2;                   // 점보다 작으면 숨김
      if (rr !== acc._r) {
        acc._r = rr;
        acc.style.display = rr ? '' : 'none';
        if (rr) { acc.style.width = acc.style.height = `${rr * 2}px`; acc.style.left = acc.style.top = `${-rr}px`; }
      }
      if (headDisp != null) {
        fan.style.display = '';
        fan.style.transform = `rotate(${(headDisp - bearing).toFixed(1)}deg)`;
      } else fan.style.display = 'none';
    }
    if (compass) {
      const show = Math.abs(TM.deltaDeg(0, bearing)) > 0.5 || follow === 'heading';
      if (compassBtn.hidden === show) compassBtn.hidden = !show;
      if (show) needle.setAttribute('transform', `rotate(${(-bearing).toFixed(1)} 22 22)`);
    }
  }

  function frame(now) {
    raf = 0;
    if (!alive) return;
    stats.frames++;
    const dt = lastFrame ? Math.min(64, now - lastFrame) : 16;
    lastFrame = now;
    let more = false;

    // 내 위치 미끄러지기·방향 부드럽게
    if (meAnim) {
      const t = Math.max(0, Math.min(1, (now - meAnim.t0) / ANIM_MS)), e = easeOut(t);
      meDisp = { mx: lerp(meAnim.from.mx, me.mx, e), my: lerp(meAnim.from.my, me.my, e) };
      if (t >= 1) meAnim = null; else more = true;
    }
    if (me && me.heading != null) {
      if (headDisp == null) headDisp = me.heading;
      const d = TM.deltaDeg(headDisp, me.heading);
      if (Math.abs(d) > 0.2) { headDisp = TM.normDeg(headDisp + d * (1 - Math.exp(-dt / 90))); more = true; } else headDisp = me.heading;
    } else headDisp = null;

    if (rotAnim) {
      const t = Math.max(0, Math.min(1, (now - rotAnim.t0) / rotAnim.dur));
      bearing = TM.normDeg(rotAnim.from + rotAnim.d * easeOut(t));
      if (t >= 1) rotAnim = null; else more = true;
    } else if (follow === 'heading' && headDisp != null && !gesture) bearing = headDisp;

    if (viewAnim) {
      const t = Math.max(0, Math.min(1, (now - viewAnim.t0) / viewAnim.dur)), e = easeOut(t);
      const a = viewAnim.from, b = viewAnim.to;
      // 확대가 바뀌면 화면에서 곧게 가도록 세계 좌표가 아닌 화면 비율로 보간(멀리 튀지 않게)
      z = lerp(a.z, b.z, e);
      cx = lerp(a.cx, b.cx, e); cy = lerp(a.cy, b.cy, e);
      if (viewAnim.anchor) {                                           // 기준점 고정 확대(두 번 탭·스냅): 그 점이 손가락 아래 그대로
        const n = TM.zoomAround({ cx: a.cx, cy: a.cy, z: a.z, bearing, w: W, h: H }, z, viewAnim.anchor.x, viewAnim.anchor.y);
        cx = n.cx; cy = n.cy;
      }
      if (t >= 1) { viewAnim = null; z = b.z; if (!b.keepCenter) { cx = b.cx; cy = b.cy; } emitAnimEnd(); } else more = true;
    }
    if (inertia) {
      const v = inertia;
      const d = TM.dragDelta(view(), v.vx * dt, v.vy * dt);
      cx += d.x; cy += d.y;
      const k = Math.exp(-dt / 325);
      v.vx *= k; v.vy *= k;
      if (Math.hypot(v.vx, v.vy) < 0.02) { inertia = null; emitMove('pan', 'end'); } else more = true;
    }
    // 따라가기: 화면 가운데를 내 위치(그리는 값)에 붙인다 — 같은 값을 쓰니 점이 흔들리지 않는다
    if (follow && meDisp && !gesture && !(viewAnim && !viewAnim.zoomOnly)) {
      const a = anchorFor(meDisp.mx, meDisp.my);
      cx = a.x; cy = a.y;
    }
    cy = TM.clamp(cy, 0, 1); cx = TM.clamp(cx, 0, 1);

    // 타일 단계 고르기: 확대 애니메이션 중이면 도착할 단계, 아니면 지금 확대(경계에서 오락가락하지 않게)
    const target = viewAnim && viewAnim.to.z !== viewAnim.from.z ? viewAnim.to : null;
    const lz = target ? TM.clampZoom(Math.round(target.z)) : TM.levelFor(z, front ? front.z : null);
    if (!front || front.z !== lz || front.layer !== curLayer) switchFront(lz);
    const v = view();
    levelTransform(front);
    if (back) levelTransform(back);
    updateTiles(front, target ? { ...v, cx: target.cx, cy: target.cy, z: target.z } : v);
    placeOverlays(v);
    el.dataset.zoom = z.toFixed(2);
    if (more) schedule();
  }

  // ---- 알림 ----
  const centerLL = () => TM.fromMerc(cx, cy);
  function emitMove(kind, phase) {
    for (const fn of [...subs.move]) { try { fn({ kind, phase, center: centerLL(), zoom: z }); } catch (e) { console.error(e); } }
  }
  let animEndKind = null;
  function emitAnimEnd() { if (animEndKind) { const k = animEndKind; animEndKind = null; emitMove(k, 'end'); } }
  function setFollowMode(mode) {
    mode = mode === 'heading' || mode === 'pos' ? mode : false;
    if (mode === follow) return;
    follow = mode;
    el.dataset.follow = mode || '';
    for (const fn of [...subs.follow]) { try { fn(mode); } catch (e) { console.error(e); } }
  }

  // ---- 조작(손가락) ----
  const pts = new Map();             // pointerId → {x,y}
  let gesture = null;                // { mode:'pan'|'pinch', ... }
  let rect = null, lastTap = null;
  const local = e => ({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  const midDist = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) }; };

  function stopMotion() { viewAnim = null; inertia = null; animEndKind = null; }
  function onDown(e) {
    if (e.button > 0 || e.target.closest?.('.lm-compass')) return;
    if (!pts.size) rect = el.getBoundingClientRect();
    try { el.setPointerCapture(e.pointerId); } catch { /* 무시 */ }
    const p = local(e);
    pts.set(e.pointerId, p);
    if (inertia) { inertia = null; emitMove('pan', 'end'); }
    if (pts.size === 1) {
      stopMotion();
      gesture = { mode: 'pan', sx: p.x, sy: p.y, lx: p.x, ly: p.y, moved: false, t0: e.timeStamp, target: e.target, samples: [{ x: p.x, y: p.y, t: e.timeStamp }] };
    } else if (pts.size === 2) {
      const md = midDist();
      const wasPan = gesture?.mode === 'pan' && gesture.moved;
      gesture = { mode: 'pinch', mx: md.x, my: md.y, d: md.d, d0: md.d, m0x: md.x, m0y: md.y, moved: false, t0: e.timeStamp, wasPan };
      if (!wasPan) emitMove('zoom', 'start');
    }
  }
  function onMoveEv(e) {
    if (!pts.has(e.pointerId) || !gesture) return;
    const p = local(e);
    pts.set(e.pointerId, p);
    if (gesture.mode === 'pan' && pts.size === 1) {
      const g = gesture;
      if (!g.moved) {
        if (Math.hypot(p.x - g.sx, p.y - g.sy) < SLOP) return;
        g.moved = true; g.lx = g.sx; g.ly = g.sy;                       // 끌기 시작 — 처음 닿은 자리부터 따라가게(손가락 아래 땅이 어긋나지 않게)
        if (follow) setFollowMode(false);
        emitMove('pan', 'start');
      }
      if (!(g.afterPinch && follow)) {                                  // 따라가기 중 두 손가락 뒤 남은 손가락은 옮기지 않는다
        const d = TM.dragDelta(view(), p.x - g.lx, p.y - g.ly);
        cx += d.x; cy += d.y;
      }
      g.lx = p.x; g.ly = p.y;
      g.samples.push({ x: p.x, y: p.y, t: e.timeStamp });
      while (g.samples.length > 2 && e.timeStamp - g.samples[0].t > 100) g.samples.shift();
      schedule();
    } else if (gesture.mode === 'pinch' && pts.size >= 2) {
      const g = gesture, md = midDist();
      if (!g.moved && (Math.abs(md.d - g.d0) > 10 || Math.hypot(md.x - g.m0x, md.y - g.m0y) > 10)) g.moved = true;
      const z2 = TM.clampZoom(z + Math.log2(md.d / g.d));
      const an = zoomAnchorScreen(g.mx, g.my);
      const n = TM.zoomAround(view(), z2, an.x, an.y);
      cx = n.cx; cy = n.cy; z = n.z;
      if (!(follow && me)) {                                           // 두 손가락을 같이 옮기면 지도도 따라간다(따라가기 중에는 내 위치 고정)
        const d = TM.dragDelta(view(), md.x - g.mx, md.y - g.my);
        cx += d.x; cy += d.y;
      }
      g.mx = md.x; g.my = md.y; g.d = md.d;
      schedule();
    }
  }
  function onUp(e) {
    if (!pts.has(e.pointerId)) return;
    pts.delete(e.pointerId);
    const g = gesture;
    if (!g) return;
    if (g.mode === 'pinch') {
      if (pts.size === 1) {                                            // 한 손가락이 남으면 이어서 끌기(관성 없이)
        const [p] = [...pts.values()];
        gesture = { mode: 'pan', sx: p.x, sy: p.y, lx: p.x, ly: p.y, moved: true, t0: e.timeStamp, samples: [], afterPinch: g };
        return;
      }
      if (pts.size === 0) { gesture = null; endPinch(g, e.timeStamp); }
      return;
    }
    if (pts.size) return;
    gesture = null;
    if (g.afterPinch) { endPinch(g.afterPinch, e.timeStamp, true); return; }
    if (!g.moved) { onTap(g, e); return; }
    // 관성
    const s = g.samples;
    if (!reduced() && s.length >= 2) {
      const a = s[0], b = s[s.length - 1], dt = Math.max(1, b.t - a.t);
      let vx = (b.x - a.x) / dt, vy = (b.y - a.y) / dt;
      const sp = Math.hypot(vx, vy);
      if (e.timeStamp - b.t < 60 && sp > 0.3) {
        const k = Math.min(1, 3 / sp); vx *= k; vy *= k;
        inertia = { vx, vy };
        schedule();
        return;
      }
    }
    emitMove('pan', 'end');
  }
  function endPinch(g, t, quiet = false) {
    // 두 손가락 탭(움직이지 않고 짧게) → 한 단계 축소
    if (!g.moved && !quiet && t - g.t0 < 300) {
      const an = zoomAnchorScreen(g.mx, g.my);
      animateZoom(Math.round(z) - 1, an, 'zoom');
      return;
    }
    snapZoom(g.mx, g.my, 'zoom');
  }
  // 손을 떼면 가까운 정수 확대로(타일이 또렷하게)
  function snapZoom(ax, ay, kind) {
    const zr = TM.clampZoom(Math.round(z));
    if (Math.abs(zr - z) < 1e-3) { z = zr; schedule(); emitMove(kind, 'end'); return; }
    const an = zoomAnchorScreen(ax, ay);
    animateZoom(zr, an, kind, SNAP_MS);
  }
  function animateZoom(z2, an, kind, dur = 220) {
    z2 = TM.clampZoom(z2);
    animEndKind = kind;
    if (reduced() || !W) {
      const n = TM.zoomAround(view(), z2, an.x, an.y);
      cx = n.cx; cy = n.cy; z = z2; schedule(); emitAnimEnd(); return;
    }
    const n = TM.zoomAround(view(), z2, an.x, an.y);
    viewAnim = { from: { cx, cy, z }, to: { cx: n.cx, cy: n.cy, z: z2 }, t0: performance.now(), dur, anchor: an, zoomOnly: !!follow };
    schedule();
  }
  function onTap(g, e) {
    const now = e.timeStamp;
    const mkEl = g.target?.closest?.('.lm-mk');
    if (mkEl) {
      const k = mkList.find(x => x.el === mkEl);
      if (k) for (const fn of [...subs.marker]) { try { fn(k.m); } catch (err) { console.error(err); } }
      lastTap = null;
      return;
    }
    if (lastTap && now - lastTap.t < DBL_MS && Math.hypot(g.sx - lastTap.x, g.sy - lastTap.y) < DBL_PX) {
      lastTap = null;
      emitMove('zoom', 'start');
      animateZoom(Math.round(z) + 1, zoomAnchorScreen(g.sx, g.sy), 'zoom');
      return;
    }
    lastTap = { t: now, x: g.sx, y: g.sy };
  }
  function onCancel(e) {
    pts.delete(e.pointerId);
    if (!pts.size && gesture) { const g = gesture; gesture = null; if (g.mode === 'pinch' || g.afterPinch) snapZoom(W / 2, H / 2, 'zoom'); else if (g.moved) emitMove('pan', 'end'); }
  }
  // 마우스 휠(개발·태블릿) — 손을 멈추면 정수로
  let wheelT = 0;
  function onWheel(e) {
    e.preventDefault();
    if (!rect || !wheelT) rect = el.getBoundingClientRect();
    if (!wheelT) { stopMotion(); emitMove('zoom', 'start'); }
    const p = local(e);
    const an = zoomAnchorScreen(p.x, p.y);
    const n = TM.zoomAround(view(), TM.clampZoom(z - e.deltaY * (e.deltaMode ? 0.05 : 0.002)), an.x, an.y);
    cx = n.cx; cy = n.cy; z = n.z;
    schedule();
    clearTimeout(wheelT);
    wheelT = setTimeout(() => { wheelT = 0; snapZoom(p.x, p.y, 'zoom'); }, 220);
  }
  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMoveEv);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onCancel);
  el.addEventListener('lostpointercapture', e => { if (pts.has(e.pointerId)) onCancel(e); });
  el.addEventListener('wheel', onWheel, { passive: false });
  el.addEventListener('contextmenu', e => e.preventDefault());

  // ---- 크기 ----
  let ro = null;
  function measure() {
    const r = el.getBoundingClientRect();
    if (r.width !== W || r.height !== H) {
      W = r.width; H = r.height;
      if (front) front.range = null;
      schedule();
    }
  }
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(ents => {
      const cr = ents[ents.length - 1].contentRect;
      if (cr.width !== W || cr.height !== H) { W = cr.width; H = cr.height; if (front) front.range = null; schedule(); }
    });
    ro.observe(el);
  } else queueMicrotask(measure);
  if (!apiKey) showNote(NOKEY_TEXT);

  // ---- 바깥 함수 ----
  function setView(ll, zz, { animate = true } = {}) {
    if (!alive || gesture) return false;
    const m = ll && Number.isFinite(ll.lat) && Number.isFinite(ll.lng) ? TM.toMerc(ll.lat, ll.lng) : { x: cx, y: cy };
    let z2 = zz == null ? z : TM.clampZoom(zz);
    inertia = null;
    // 따라가는 중: 내 위치로 옮기라는 것이면 확대만(가운데는 따라가기가 잡는다), 다른 곳이면 따라가기를 푼다
    if (follow && me && ll) {
      const s = TM.worldSize(z);
      if (Math.hypot((m.x - me.mx) * s, (m.y - me.my) * s) <= 2) {
        if (z2 === z) { schedule(); return true; }
        if (!animate || reduced() || !W || Math.abs(z2 - z) > 1.5) { z = z2; viewAnim = null; }
        else viewAnim = { from: { cx, cy, z }, to: { cx, cy, z: z2 }, t0: performance.now(), dur: ANIM_MS, zoomOnly: true };
        schedule();
        return true;
      }
      setFollowMode(false);
    }
    const sameCenter = Math.abs(m.x - cx) < 1e-12 && Math.abs(m.y - cy) < 1e-12;
    const far = Math.hypot((m.x - cx) * TM.worldSize(z), (m.y - cy) * TM.worldSize(z)) > 2 * Math.max(W, H, 400);
    if (!animate || reduced() || !W || far || Math.abs(z2 - z) > 1.5) {
      viewAnim = null;
      cx = m.x; cy = m.y; z = z2;
    } else if (!sameCenter || z2 !== z) {
      viewAnim = { from: { cx, cy, z }, to: { cx: m.x, cy: m.y, z: z2 }, t0: performance.now(), dur: ANIM_MS };
    }
    schedule();
    return true;
  }
  function setRotationInner(deg, animate) {
    const to = TM.normDeg(Number(deg) || 0);
    const d = TM.deltaDeg(bearing, to);
    if (!animate || reduced() || Math.abs(d) < 0.5) { rotAnim = null; bearing = to; }
    else rotAnim = { from: bearing, d, t0: performance.now(), dur: Math.min(400, 150 + Math.abs(d)) };
    schedule();
  }
  function setRotation(deg, { animate = true } = {}) {
    if (!alive) return;
    if (follow === 'heading') setFollowMode('pos');
    setRotationInner(deg, animate);
  }
  function setLayer(l) {
    if (!TM.LAYERS[l] || l === curLayer) return;
    curLayer = l;
    el.dataset.layer = l;
    schedule();                                                         // 다음 그림에서 새 단계를 만들고, 다 받을 때까지 앞 레이어가 아래에 남는다
  }
  function setMe(p) {
    if (!alive) return;
    if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lng)) {
      me = null; meDisp = null; meAnim = null; headDisp = null;
      meEl.hidden = true;
      schedule();
      return;
    }
    const m = TM.toMerc(p.lat, p.lng);
    const heading = Number.isFinite(p.heading) ? TM.normDeg(p.heading) : null;
    const prev = meDisp;
    me = { mx: m.x, my: m.y, acc: Number.isFinite(p.acc) ? p.acc : null, heading, lat: p.lat };
    meEl.hidden = false;
    const s = TM.worldSize(z);
    const jump = !prev || reduced() || Math.hypot((m.x - prev.mx) * s, (m.y - prev.my) * s) > Math.max(W, H, 400);
    if (jump) { meAnim = null; meDisp = { mx: m.x, my: m.y }; }
    else if (m.x !== prev.mx || m.y !== prev.my) meAnim = { from: { ...prev }, t0: performance.now() };
    if (heading == null) headDisp = null;
    schedule();
  }
  function setMarkers(list) {
    if (!alive) return;
    const old = new Map(mkList.map(k => [k.m.id, k]));
    const next = [];
    for (const m of Array.isArray(list) ? list : []) {
      if (!m || !Number.isFinite(m.lat) || !Number.isFinite(m.lng)) continue;
      const id = m.id ?? `${m.lat},${m.lng}`;
      let k = old.get(id);
      const label = m.label == null ? '' : String(m.label);
      const kind = m.kind || 'pin';
      if (!k) {
        const span = h('span', { text: label });
        const b = h('button', { type: 'button', class: 'lm-mk', 'data-mid': String(id), 'data-kind': kind, 'aria-label': label ? `위치 ${label}` : '위치',
          onclick: ev => { if (ev.detail === 0) for (const fn of [...subs.marker]) { try { fn(k.m); } catch (err) { console.error(err); } } } }, span);
        k = { el: b, span, tf: '' };
      } else old.delete(id);
      if (k.span.textContent !== label) { k.span.textContent = label; k.el.setAttribute('aria-label', label ? `위치 ${label}` : '위치'); }
      if (k.el.dataset.kind !== kind) k.el.dataset.kind = kind;
      const mm = TM.toMerc(m.lat, m.lng);
      Object.assign(k, { m: { ...m, id }, mx: mm.x, my: mm.y });
      next.push(k);
    }
    for (const k of old.values()) k.el.remove();
    next.forEach((k, i) => { if (mkBox.children[i] !== k.el) mkBox.insertBefore(k.el, mkBox.children[i] || null); });
    mkList = next;
    schedule();
  }
  function setFollow(mode) {
    if (!alive) return;
    const was = follow;
    setFollowMode(mode);
    if (follow && me) {
      const tgt = meDisp || { mx: me.mx, my: me.my };
      const b = follow === 'heading' && me.heading != null ? me.heading : bearing;
      const a = anchorFor(tgt.mx, tgt.my, b);
      if (follow === 'heading' && me.heading != null) { rotAnim = null; setRotationInner(me.heading, true); }
      if (!reduced() && W) viewAnim = { from: { cx, cy, z }, to: { cx: a.x, cy: a.y, z }, t0: performance.now(), dur: ANIM_MS };
      else { cx = a.x; cy = a.y; }
    }
    if (was === 'heading' && !follow) { /* 회전은 그대로 둔다(나침반 버튼으로 북쪽 위) */ }
    schedule();
  }
  function destroy() {
    if (!alive) return;
    alive = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(wheelT); clearTimeout(errT);
    ro?.disconnect();
    removeEventListener('online', onOnline);
    dropLevel(front); dropLevel(back);
    front = back = null;
    for (const s of Object.values(subs)) s.clear();
    el.remove();
  }
  const sub = set => fn => { if (typeof fn === 'function') set.add(fn); return () => set.delete(fn); };

  schedule();
  return {
    el,
    setView, setLayer, setRotation, setMe, setMarkers,
    onMarker: sub(subs.marker), onMove: sub(subs.move),
    center: centerLL, zoom: () => z, destroy,
    // 덧붙임
    setFollow, follow: () => follow, onFollow: sub(subs.follow), onError: sub(subs.error),
    zoomBy: (d, { animate = true } = {}) => {
      if (!alive || gesture) return;
      const an = zoomAnchorScreen(W / 2, H / 2);
      if (!animate) { const n = TM.zoomAround(view(), TM.clampZoom(Math.round(z) + d), an.x, an.y); cx = n.cx; cy = n.cy; z = n.z; schedule(); return; }
      stopMotion();
      animateZoom(Math.round(z) + d, an, null);
    },
    rotation: () => bearing, layer: () => curLayer,
    project: (lat, lng) => TM.latLngToScreen(view(), lat, lng),
    unproject: (x, y) => TM.screenToLatLng(view(), x, y),
    setKey(k) {
      const nk = String(k || '').trim();
      if (nk === apiKey) return;
      apiKey = nk;
      dropLevel(back); back = null; dropLevel(front); front = null;
      errShown = false; delete el.dataset.tileError;
      showNote(apiKey ? null : NOKEY_TEXT);
      schedule();
    },
    _stats: () => ({ ...stats, tiles: (front?.tiles.size || 0) + (back?.tiles.size || 0), frontZ: front?.z ?? null, back: !!back, pending: front?.pending ?? 0, pool: pool.length, imgs: el.querySelectorAll('img.lm-t').length }),
  };
}
