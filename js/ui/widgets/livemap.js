// 실시간 지도 엔진 — VWorld WMTS 타일을 <img> 로 깔고, 레이어 div 에 transform(이동·회전·배율)만 바꿔 움직인다(외부 지도 라이브러리 없음).
// 사용자 요구: 「실시간 위치 보기」를 누르면 지도에 내 위치가 보이고, 네이버 지도 길찾기처럼 보는 방향(부채꼴)까지.
// 같은 엔진이 「도면보관함」 도면도 그린다(이미지 좌표계 모드, docs/도면보관함-설계.md §6.2) — 도면을 지도처럼, 같은 손맛.
// 체감 속도: 손으로 움직이는 동안은 레이어 transform 과 겹침 요소(내 위치·마커) transform 만 쓴다. 타일은 보이는 범위가 바뀔 때만
// 더하고 빼며, <img> 는 풀에서 다시 쓴다. 레이아웃을 읽는 일은 손을 댈 때 getBoundingClientRect 한 번뿐(크기는 ResizeObserver).
// 약관(reference/vworld-brief.md §4·§6): 타일은 브라우저 기본 캐시만 — SW·IDB 에 저장하지 않고 미리 받지도 않는다. crossOrigin 은 비워 둔다.
//
// const m = liveMap({ center:{lat,lng}, zoom:17, layer:'Base'|'Satellite'|'Hybrid', key, rotate:0 })
//   m.el                                  — 붙일 요소(크기는 부모가 정한다: 예) .lm 에 height 를 주거나 flex:1)
//   m.setView({lat,lng}|null, zoom?, {animate=true})   — 손으로 움직이는 중에는 무시(false 를 돌려준다)
//   m.setLayer(layer) · m.setRotation(deg, {animate=true})  — deg = 화면 위쪽이 가리키는 방위(0 북쪽 위, 「진행 방향 위」는 보는 방향)
//   m.setMe({lat,lng,acc,heading}|null)   — 파란 점 + 정확도 원(미터→픽셀) + 보는 방향 부채꼴(heading 이 있을 때, 지도 회전과 합성)
//   m.setMarkers([{id,lat,lng,label,kind,name?}]) · m.onMarker(fn(marker)) · m.onMove(fn({kind:'pan'|'zoom'|'rotate', phase:'start'|'end', center, zoom}))
//   m.center() → {lat,lng} · m.zoom() → number · m.destroy()
// 덧붙임(계약 밖, 쓰면 편함):
//   m.setFollow(false|'pos'|'heading') · m.follow() · m.onFollow(fn(mode)) — 따라가기. 'pos' 는 내 위치를 가운데에, 'heading' 은 거기에 더해
//     보는 방향을 위로 돌리고 내 위치를 조금 아래(앞이 더 보이게)에 둔다. 손으로 끌면 스스로 풀리고 onFollow(false)·onMove 를 부른다.
//     따라가는 동안 두 손가락·두 번 탭 확대는 내 위치를 기준으로 한다(놓치지 않게).
//   m.zoomBy(d, {animate}) · m.rotation() · m.layer() · m.project(lat,lng) → {x,y} · m.unproject(x,y) → {lat,lng}
//   m.onError(fn(message)) — 타일을 못 받을 때 한 번(다시 잘 받으면 다음 실패 때 또 한 번). el 에도 'livemap:error' 이벤트.
//   m.setKey(key) — 설정에서 키를 바꿨을 때.
//   m.onTap(fn({ x, y, at })) — 마커가 아닌 곳을 한 번 탭(두 번 탭 확대와 겹치지 않게 300ms 뒤). at = 그 자리 좌표({lat,lng} 또는 이미지 {x,y})
//   m.onRender(fn()) — 그림을 그린 뒤마다(겹쳐 그리는 쪽이 같은 프레임에 맞추게 — 가볍게 쓸 것)
//   m.setRoute(target|null) — 내 위치 → target 점선(길찾기). target 은 {lat,lng} 또는 이미지 {x,y}
//
// 이미지 좌표계 모드(도면 타일 피라미드 — media/drawtiles.js 가 만든 것):
//   liveMap({ source: { kind:'image', w, h, tileSize:512, levels:[{w,h,cols,rows,blank?}], tile:(z,x,y)=>Promise<url|null>, preview?:()=>Promise<url|null>,
//             previewW, previewH, bg }, center?:{x,y}, zoom?, fitOffset?, rotate, compass, gestures=true, namesZoom? })
//   zoom 을 안 주면 크기를 안 뒤 화면에 맞춤(+fitOffset). gestures:false 면 손동작 없음(작은 미리 보기 — 탭은 부모로 간다, 마커 탭은 onMarker)
//   좌표는 그 쪽 그림 픽셀 {x,y}(0..w, 0..h). setView({x,y}, z) · setMe({x,y,accPx,heading /* 도면 위 각도 */}) · setMarkers([{id,x,y,label,name,kind}])
//   z: 단계 번호와 같은 잣대(z = levels.length-1 이면 원래 크기 1:1). 소수 확대 그대로(손을 떼도 정수로 맞추지 않음 — 도면은 맞춤 배율이 소수).
//   단계 고르기는 화면 배율 0.7~1.4 사이(조금 또렷하게), 맨 위 단계를 4배(z+2)까지 늘린다. 화면에 맞춤 = m.fit().
//   타일 주소는 비동기 — 받는 사이 범위가 바뀌어 치운 칸은 버린다. null(빈 칸·아직 안 만든 칸)은 그 칸을 비워 아래 미리보기 한 장이 비친다.
//   VWorld 키 안내·저작권 줄은 이 모드에서 숨긴다. setSource(src) — 타일이 더 만들어졌을 때(보던 자리 그대로).
//   setRotation(deg) 의 deg = 화면 위가 가리키는 「도면 위 각도」(0 = 도면 그대로). setNorth(deg|null) — 나침반 바늘이 도면 위 북쪽을 가리키게.
import { h, isTyping } from '../dom.js';
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
const R_EARTH = 6378137;
const D2R = Math.PI / 180;
// 못 받은 칸 — src 를 비우면 브라우저가 「깨진 그림」 표시를 그리므로 회색 1px 그림(인라인, 외부 요청 없음)으로 채운다
const GRAY = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='1' height='1'%3E%3Crect width='1' height='1' fill='%23C9CCC6'/%3E%3C/svg%3E";

const fin = Number.isFinite;
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
  im.style.width = im.style.height = '';                             // 이미지 모드 칸 크기(지도 칸은 css 256.5px)
  im.remove();
  if (pool.length < POOL_MAX) pool.push(im);
}

// ---- 좌표계 ----
// 정규 좌표 n = {x,y}, 세계 픽셀(확대 z) = n × S0 × 2^z. 화면 계산은 웹 메르카토르와 똑같고 S0·타일 격자만 다르다.
function mercGeo() {
  return {
    image: false, S0: TM.TILE, tile: TM.TILE, maxX: 1, maxY: 1, zmax: TM.MAX_Z,
    zmin: () => TM.MIN_Z,
    toN: p => (p && fin(p.lat) && fin(p.lng) ? TM.toMerc(p.lat, p.lng) : null),
    fromN: (x, y) => TM.fromMerc(x, y),
    grid(lz) { const n = 2 ** lz; return { cols: n, rows: n, kx: 1, ky: 1, lw: n * TM.TILE, lh: n * TM.TILE }; },
    level: (z, cur) => TM.levelFor(z, cur),
    accN: (m, lat) => m / (2 * Math.PI * R_EARTH * Math.cos(TM.clamp(lat ?? 0, -85, 85) * D2R)),
  };
}
function imageGeo(src, bias) {
  const W = Math.max(1, +src.w || 1), H = Math.max(1, +src.h || 1), T = +src.tileSize || 512;
  const levels = Array.isArray(src.levels) && src.levels.length ? src.levels : null;
  const top = levels ? levels.length - 1 : Math.max(0, Math.ceil(Math.log2(Math.max(W, H) / T)));
  const S = Math.max(W, H);
  return {
    image: true, S0: S / 2 ** top, tile: T, W, H, S, top, levels, maxX: W / S, maxY: H / S, zmax: top + 2,
    zmin: null,                                                       // 화면 크기에 따라(맞춤 - 1) — 엔진이 채운다
    toN: p => (p && fin(p.x) && fin(p.y) ? { x: p.x / S, y: p.y / S } : null),
    fromN: (x, y) => ({ x: x * S, y: y * S }),
    grid(lz) {
      const l = levels?.[lz];
      if (!l) return null;
      const f = 2 ** (top - lz);                                      // 단계 크기는 반올림(올림) 탓에 정확히 2^k 배가 아닐 수 있다
      return { cols: l.cols, rows: l.rows, kx: W / f / l.w, ky: H / f / l.h, lw: l.w, lh: l.h, blank: l._bset || (l._bset = new Set(l.blank || [])) };
    },
    level(z, cur) {
      if (!levels) return null;
      const zz = z + bias;
      const r = TM.clamp(Math.round(zz), 0, top);
      if (cur == null || !fin(cur) || cur < 0 || cur > top) return r;
      return Math.abs(zz - cur) > 0.7 ? r : cur;
    },
    accN: m => m / S,                                                 // 이미지 모드는 정확도도 쪽 픽셀(accPx)
  };
}

let gradSeq = 0;

export function liveMap({ center = null, zoom = null, layer = 'Base', key = VWORLD_KEY, rotate = 0, compass = true, source = null, gestures = true, namesZoom = null, fitOffset = 0 } = {}) {
  // ---- 상태 ----
  const imageMode = source?.kind === 'image';
  // 이미지 모드 단계 고르기: 기기 화소 하나에 도면 화소가 0.7~1.4 개 오게(고밀도 화면은 한 단계 위) — 맞춤 배율에서도 미리보기보다 흐리지 않게
  const BIAS = TM.clamp(Math.log2(globalThis.devicePixelRatio || 1), 0.25, 1.4);
  let src = imageMode ? source : null;
  let GEO = imageMode ? imageGeo(src, BIAS) : mercGeo();
  let apiKey = imageMode ? '' : String(key || '').trim();
  let curLayer = imageMode ? 'image' : (TM.LAYERS[layer] ? layer : 'Base');
  let cx, cy;
  {
    const c0 = imageMode ? GEO.toN(center) || { x: GEO.maxX / 2, y: GEO.maxY / 2 } : TM.toMerc(center?.lat ?? 37.5666, center?.lng ?? 126.9782);
    cx = c0.x; cy = c0.y;
  }
  let pendingFit = imageMode && !(center && fin(zoom));                // 이미지 모드: 크기를 알게 되면 화면에 맞춤
  // 맞춤 유지(이미지 모드): 사용자가 손대기 전(손짓·setView·확대)까지는 크기가 바뀌면 다시 맞춘다 —
  //   상자가 자라는 중(작은 창 → 크게)에 처음 잰 작은 크기로 맞춘 채 남지 않게. 'mid' = 그림 가운데, 'center' = 처음 준 가운데
  let autoFit = pendingFit ? (center ? 'center' : 'mid') : null;
  let fitOff = fitOffset;
  let z = imageMode ? (fin(zoom) ? zoom : 0) : TM.clampZoom(zoom ?? 17);
  let bearing = TM.normDeg(rotate || 0);
  let north = null;                                                   // 이미지 모드 나침반 바늘(도면 위 북쪽)
  let W = 0, H = 0;
  let front = null, back = null;
  let raf = 0, alive = true, lastFrame = 0;
  let viewAnim = null, rotAnim = null, inertia = null;
  let follow = false;
  let namesOn = null;
  const subs = { marker: new Set(), move: new Set(), follow: new Set(), error: new Set(), tap: new Set(), render: new Set() };
  const stats = { loads: 0, errors: 0, frames: 0, levels: 0, blank: 0, memHits: 0, kept: 0, prefetched: 0 };

  const ws = zz => GEO.S0 * 2 ** zz;                                  // 세계 크기(px)
  function zminNow() {
    if (!GEO.image) return TM.MIN_Z;
    const f = fitZoom();
    return fin(f) ? Math.min(f - 1, GEO.top) : -4;
  }
  const clampZ = zz => TM.clamp(fin(zz) ? zz : 0, zminNow(), GEO.zmax);

  // ---- DOM ----
  const tilesBox = h('div', { class: 'lm-tiles' });
  const ov = h('div', { class: 'lm-ov' });
  const note = h('div', { class: 'lm-note', role: 'status', hidden: true });
  const attr = imageMode ? null : h('div', { class: 'lm-attr', text: '© VWorld(국토교통부)' });
  const needle = svg('g', {});
  needle.append(svg('path', { d: 'M22 6 L27 22 L17 22 Z', fill: '#C4122F' }), svg('path', { d: 'M22 38 L27 22 L17 22 Z', fill: '#9EA39C' }));
  const nLetter = svg('text', { x: '22', y: '17.5', 'text-anchor': 'middle', 'font-size': '9', 'font-weight': '900', fill: '#fff' });
  nLetter.textContent = 'N';
  needle.append(nLetter);
  const compassSvg = svg('svg', { width: '44', height: '44', viewBox: '0 0 44 44', 'aria-hidden': 'true', focusable: 'false' });
  compassSvg.append(needle);
  const compassBtn = h('button', { type: 'button', class: 'lm-compass', 'aria-label': imageMode ? '도면 그대로 보기' : '북쪽을 위로', hidden: true, onclick: () => {
    if (follow === 'heading') setFollowMode('pos');
    setRotationInner(0, true);
    emitMove('rotate', 'start'); emitMove('rotate', 'end');
  } }, compassSvg);
  const el = h('div', { class: ['lm', imageMode && 'lm-img', !gestures && 'lm-still'], role: 'region', 'aria-label': imageMode ? '도면' : '지도', 'data-testid': 'livemap', 'data-layer': curLayer },
    tilesBox, ov, note, attr, compass ? compassBtn : null);

  // 이미지 모드 바닥: 미리보기 한 장(없으면 흰 종이) — 타일이 오기 전·빈 칸에 비친다
  // 빨리 보이기(0.1.5 「도면 빨리 띄우기」): ① 디코드 끝난 미리보기가 메모리에 있으면(src.previewNow — 최근 연 도면) 첫 그림에 바로
  //   ② 없으면 목록 썸네일과 같은 맨 아래 단계 한 장(src.thumbNow — 이미 읽힌 것)을 흐린 바닥으로 먼저 ③ 미리보기를 읽고 디코드한 뒤 붙인다.
  //   미리보기가 깔려 있고 지금 확대가 미리보기 1:1 근처면(미리보기가 그 타일 단계보다 선명하고 크게 줄이지 않아도 되면) 타일은 받지 않는다(tilesNeeded).
  //   크게 줄여 보는 맞춤·작은 창은 타일 단계(워커가 고급 필터로 미리 줄인 그림)를 쓴다 — 미리보기를 GPU 로 3배 넘게 줄이면 가는 선이 끊겨 보인다.
  let started = false;
  let base = null, baseImg = null, thumbImg = null, pvReady = false, baseW = 0, baseH = 0, baseTf = '', pvGen = 0;
  const call = f => { try { return typeof f === 'function' ? f() : null; } catch { return null; } };
  function attachPreview(im) {
    if (!im || !alive || baseImg) return;
    if (im.isConnected) im = im.cloneNode();                            // 다른 지도가 같은 그림을 쓰는 중 — 같은 주소(디코드 캐시)
    im.className = 'lm-pv';
    im.alt = ''; im.draggable = false; im.decoding = 'async'; im.setAttribute('aria-hidden', 'true');
    baseImg = im;
    base.append(im);
    const on = () => {
      if (baseImg !== im || !alive) return;
      im.onload = im.onerror = null; im.classList.add('on'); pvReady = true; thumbImg?.remove(); thumbImg = null;
      if (started) schedule();                                        // 만드는 중(동기로 붙음)이면 끝에서 한 번 그린다
    };
    if (im.complete && im.naturalWidth) on(); else { im.onload = on; im.onerror = () => { im.onload = im.onerror = null; }; }
  }
  function makeBase() {
    if (!GEO.image) return;
    const pw = +src.previewW, ph = +src.previewH;
    baseW = pw > 0 ? pw : 1024; baseH = ph > 0 ? ph : Math.max(1, Math.round(1024 * GEO.H / GEO.W));
    if (!base) {
      base = h('div', { class: 'lm-base', style: { background: src.bg || '#fff', visibility: 'hidden' } });   // 크기를 알고 자리를 잡은 뒤 보인다(첫 그림이 엉뚱한 자리에 번쩍이지 않게)
      tilesBox.prepend(base);
    }
    base.style.width = `${baseW}px`; base.style.height = `${baseH}px`;
    baseTf = '';
    if (baseImg) return;
    const gen = ++pvGen;
    const now = call(src.previewNow);
    if (now) { attachPreview(now); return; }
    const th = call(src.thumbNow);
    if (th && !thumbImg) {
      thumbImg = h('img', { class: 'lm-pv lm-thumb', alt: '', decoding: 'async', draggable: false, 'aria-hidden': 'true' });
      thumbImg.onload = () => { thumbImg?.classList.add('on'); };
      thumbImg.src = th;
      base.append(thumbImg);
    }
    const p = typeof src.previewImg === 'function' ? call(src.previewImg)
      : typeof src.preview === 'function' ? Promise.resolve(call(src.preview)).then(u => {
        if (!u) return null;
        const im = h('img', { alt: '', decoding: 'async', draggable: false });
        im.src = u;
        return im;
      }) : null;
    Promise.resolve(p).then(im => { if (gen === pvGen) attachPreview(im); }, () => {});
  }
  // 그 타일 단계가 필요한가(확대 zz 에서) — 미리보기가 그 단계보다 선명하고, 미리보기 화소가 기기 화소 1.5개 안팎으로만 줄면 미리보기 한 장으로 충분
  const DPR = globalThis.devicePixelRatio || 1;
  function tilesNeeded(lz, zz = z) {
    if (!GEO.image || lz == null) return lz != null;
    if (!pvReady) return true;
    const l = GEO.levels?.[lz];
    if (!l || l.w > baseW * 1.02) return true;
    const shown = GEO.W * 2 ** (zz - GEO.top) * DPR;                 // 지금 쪽 그림 가로가 차지하는 기기 화소
    const ratio = baseW / Math.max(1, shown);                         // 미리보기 화소 ÷ 기기 화소(1 = 딱 맞음, 3 = 3배로 줄임)
    return ratio > (front ? 1.35 : 1.6);                              // 경계에서 오락가락하지 않게 조금 띄운다
  }
  makeBase();

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
  // 길찾기 점선(내 위치 → 목표) — 켜져 있을 때만 줄 끝 좌표를 바꾼다
  const routeSvg = svg('svg', { class: 'lm-route', 'aria-hidden': 'true', focusable: 'false' });
  const routeLine = svg('line', { x1: '0', y1: '0', x2: '0', y2: '0' });
  routeSvg.append(routeLine);
  routeSvg.style.display = 'none';
  ov.append(routeSvg, mkBox, meEl);

  // ---- 보기 ----
  const view = () => ({ cx, cy, z, bearing, w: W, h: H });
  const schedule = () => { if (!raf && alive) raf = requestAnimationFrame(frame); };

  // ---- 화면 ↔ 정규 좌표(세계 크기 ws 로 — tilemath 와 같은 식) ----
  function n2s(v, mx, my) {
    const s = ws(v.z);
    const p = TM.rotate((mx - v.cx) * s, (my - v.cy) * s, -(v.bearing || 0));
    return { x: v.w / 2 + p.x, y: v.h / 2 + p.y };
  }
  function s2n(v, sx, sy) {
    const s = ws(v.z);
    const p = TM.rotate(sx - v.w / 2, sy - v.h / 2, v.bearing || 0);
    return { x: v.cx + p.x / s, y: v.cy + p.y / s };
  }
  function dragD(v, dx, dy) {
    const s = ws(v.z);
    const p = TM.rotate(dx, dy, v.bearing || 0);
    return { x: -p.x / s, y: -p.y / s };
  }
  function zoomAt(v, z2, ax, ay) {
    const m = s2n(v, ax, ay);
    const s2 = ws(z2);
    const p = TM.rotate(ax - v.w / 2, ay - v.h / 2, v.bearing || 0);
    return { cx: m.x - p.x / s2, cy: m.y - p.y / s2, z: z2 };
  }
  // 정수 단계 lz 의 보이는 타일 범위(포함). 돌아 있으면 칸 대각선 반지름만큼
  function tileRange(v, lz, pad) {
    const g = GEO.grid(lz);
    if (!g) return null;
    const scale = 2 ** (v.z - lz);
    const rot = Math.abs(TM.deltaDeg(0, v.bearing || 0)) > 1e-6;
    let hx = rot ? Math.hypot(v.w, v.h) / 2 : v.w / 2, hy = rot ? hx : v.h / 2;
    hx = (hx + pad) / scale; hy = (hy + pad) / scale;
    const s = ws(lz), ccx = v.cx * s, ccy = v.cy * s;
    const tw = GEO.tile * g.kx, th = GEO.tile * g.ky;
    return {
      z: lz,
      x0: TM.clamp(Math.floor((ccx - hx) / tw), 0, g.cols - 1), x1: TM.clamp(Math.floor((ccx + hx) / tw), 0, g.cols - 1),
      y0: TM.clamp(Math.floor((ccy - hy) / th), 0, g.rows - 1), y1: TM.clamp(Math.floor((ccy + hy) / th), 0, g.rows - 1),
    };
  }
  function tilesIn(r, v, g) {
    const out = [];
    const s = ws(r.z), tw = GEO.tile * g.kx, th = GEO.tile * g.ky;
    const ccx = v.cx * s / tw - 0.5, ccy = v.cy * s / th - 0.5;
    for (let y = r.y0; y <= r.y1; y++) for (let x = r.x0; x <= r.x1; x++) out.push({ z: r.z, x, y, key: `${r.z}/${x}/${y}`, d: (x - ccx) ** 2 + (y - ccy) ** 2 });
    out.sort((a, b) => a.d - b.d);
    return out;
  }
  // 화면에 맞춤 확대(이미지 모드) — 돌아 있으면 돌린 상자로
  function fitZoom() {
    if (!GEO.image || !W || !H) return null;
    const r = bearing * D2R, c = Math.abs(Math.cos(r)), s = Math.abs(Math.sin(r));
    const bw = GEO.W * c + GEO.H * s, bh = GEO.W * s + GEO.H * c;
    return GEO.top + Math.log2(Math.min((W * 0.94) / bw, (H * 0.94) / bh));
  }

  // ---- 타일 단계(level) ----
  // 한 단계 = 정수 확대 lz 의 타일을 담는 div. 원점(ox,oy)은 만들 때 가운데 근처 타일 모서리 — 숫자를 작게 두려고
  function makeLevel(lz) {
    const srcs = GEO.image ? [{ name: 'img' }] : TM.layerSources(curLayer);
    const g = GEO.grid(lz);
    const s = ws(lz), tw = GEO.tile * (g?.kx || 1), th = GEO.tile * (g?.ky || 1);
    const lv = {
      z: lz, layer: curLayer, srcs, g,
      ox: Math.floor(cx * s / tw) * tw, oy: Math.floor(cy * s / th) * th,
      el: h('div', { class: 'lm-lv', 'data-z': lz }),
      subs: srcs.map((sr, i) => h('div', { class: 'lm-src', 'data-src': sr.name, 'data-i': i })),
      tiles: new Map(), range: null, pending: 0, tf: '',
    };
    lv.el.append(...lv.subs);
    stats.levels++;
    return lv;
  }
  function dropLevel(lv) {
    if (!lv) return;
    for (const [k, t] of lv.tiles) { t.dead = true; for (const im of t.imgs) releaseTileImg(k, im); }
    lv.tiles.clear();
    lv.el.remove();
  }
  // 이미지 모드: 다 그려진 칸 <img> 는 풀로 돌리지 않고 source 에 맡긴다(source.keep — 디코드된 채 LRU) → 다시 열거나 되돌아올 때 그대로 꺼내 첫 그림에
  function releaseTileImg(k, im) {
    if (GEO.image && typeof src?.keep === 'function' && im.classList.contains('on') && im.complete && im.naturalWidth) {
      const [zs, xs, ys] = k.split('/');
      im.onload = im.onerror = null;
      im.remove();
      if (call(() => src.keep(+zs, +xs, +ys, im))) return;
    }
    freeImg(im);
  }
  function switchFront(lz) {
    if (back) dropLevel(back);
    back = front;
    // 확대해 들어갈 때: 앞 단계가 미리보기보다 흐리면 남겨 두지 않는다 — 새 칸이 올 때까지 더 선명한 미리보기가 비친다
    if (back && GEO.image && pvReady && lz > back.z && (GEO.levels?.[back.z]?.w || 0) <= baseW) { dropLevel(back); back = null; }
    if (back) back.el.classList.add('back');
    front = makeLevel(lz);
    tilesBox.append(front.el);                                         // 뒤 단계 위에 — 새 타일이 오기 전에는 뒤 단계가 비쳐 보인다
  }
  function maybeDropBack() {
    if (back && front && front.pending === 0 && front.tiles.size) { dropLevel(back); back = null; }
  }

  // 타일 하나 = 원본(레이어) 수만큼 <img>
  function addTile(lv, t) {
    const entry = { imgs: [], need: lv.srcs.length, done: 0, bad: false, dead: false };
    lv.tiles.set(t.key, entry);
    lv.pending++;
    const fin1 = () => { if (entry.dead) return; if (++entry.done === entry.need) { lv.pending--; maybeDropBack(); } };
    if (GEO.image) { addImageTile(lv, t, entry, fin1); return; }
    const left = t.x * TM.TILE - lv.ox, top = t.y * TM.TILE - lv.oy;
    lv.srcs.forEach((sr, i) => {
      const im = takeImg();
      im.style.left = `${left}px`; im.style.top = `${top}px`;
      im.onload = () => { im.onload = im.onerror = null; im.classList.add('on'); stats.loads++; tileOk(); fin1(); };
      im.onerror = () => {
        im.onload = im.onerror = null;
        markBad(im, i);
        entry.bad = true; stats.errors++;
        tileFail();
        fin1();
      };
      im.dataset.u = TM.tileUrl(apiKey, sr, t.z, t.x, t.y);
      lv.subs[i].append(im);
      entry.imgs.push(im);
      im.src = im.dataset.u;
    });
  }
  // 이미지 모드 칸: 주소가 비동기(objectURL). 빈 칸(바탕색 한 가지)은 묻지도 않는다
  function addImageTile(lv, t, entry, fin1) {
    const g = lv.g, T = GEO.tile;
    if (g.blank?.has(t.y * g.cols + t.x)) { entry.blank = true; stats.blank++; fin1(); return; }
    // 맡겨 둔(디코드된) 칸이 있으면 그 <img> 를 그대로 — 기다림 없이 이 프레임에 보인다
    const kept = typeof src.take === 'function' ? call(() => src.take(t.z, t.x, t.y)) : null;
    const im = kept || takeImg();
    const tw = Math.min(T, g.lw - t.x * T), th = Math.min(T, g.lh - t.y * T);
    im.style.left = `${(t.x * T * g.kx - lv.ox).toFixed(2)}px`; im.style.top = `${(t.y * T * g.ky - lv.oy).toFixed(2)}px`;
    im.style.width = `${(tw * g.kx + 0.5).toFixed(2)}px`; im.style.height = `${(th * g.ky + 0.5).toFixed(2)}px`;
    lv.subs[0].append(im);
    entry.imgs.push(im);
    if (kept) {
      im.className = 'lm-t on'; im.alt = ''; im.draggable = false; im.setAttribute('aria-hidden', 'true');
      stats.memHits++; stats.kept++; fin1();
      return;
    }
    const put = u => {
      if (entry.dead) return;
      if (!u) { entry.blank = true; stats.blank++; fin1(); return; }            // 아직 안 만든 칸·빈 칸 — 바닥이 비친다
      im.onload = () => { im.onload = im.onerror = null; im.classList.add('on'); stats.loads++; fin1(); };
      im.onerror = () => { im.onload = im.onerror = null; entry.bad = true; stats.errors++; fin1(); };
      im.src = u;
    };
    // 이미 읽어 둔 칸(최근 연 도면·미리 받은 칸)은 기다림 없이 바로
    const now = typeof src.tileNow === 'function' ? call(() => src.tileNow(t.z, t.x, t.y)) : null;
    if (now) { stats.memHits++; put(now); return; }
    let p;
    try { p = src.tile(t.z, t.x, t.y); } catch { p = null; }
    Promise.resolve(p).then(put, () => { if (!entry.dead) { entry.bad = true; fin1(); } });
  }
  function markBad(im, i) {
    im.classList.add('bad');
    if (i === 0) im.src = GRAY;                                         // 바닥 원본만 회색 칸(겹침 지명은 그냥 숨김)
    else im.removeAttribute('src');
  }
  function removeTile(lv, k, entry) {
    if (entry.done < entry.need) lv.pending--;
    entry.dead = true;
    for (const im of entry.imgs) releaseTileImg(k, im);
    lv.tiles.delete(k);
  }

  // 보이는 범위가 바뀌었을 때만 타일을 더하고 뺀다. 빼는 것은 범위 밖으로 한 칸 더 나간 것만(왔다 갔다 할 때 다시 받지 않게)
  function updateTiles(lv, v) {
    if (!W || !H || (!GEO.image && !apiKey) || !lv.g) return;
    const r = tileRange(v, lv.z, PAD);
    if (!r || TM.sameRange(r, lv.range)) return;
    lv.range = r;
    const g = lv.g;
    const kx0 = Math.max(0, r.x0 - 1), kx1 = Math.min(g.cols - 1, r.x1 + 1), ky0 = Math.max(0, r.y0 - 1), ky1 = Math.min(g.rows - 1, r.y1 + 1);
    for (const [k, e] of lv.tiles) {
      const [, xs, ys] = k.split('/');
      const x = +xs, y = +ys;
      if (x < kx0 || x > kx1 || y < ky0 || y > ky1) removeTile(lv, k, e);
    }
    for (const t of tilesIn(r, v, g)) if (!lv.tiles.has(t.key)) addTile(lv, t);
    maybeDropBack();
  }

  function levelTransform(lv) {
    const s = 2 ** (z - lv.z), w = ws(lv.z);
    const tx = lv.ox - cx * w, ty = lv.oy - cy * w;
    const tf = `translate(${W / 2}px,${H / 2}px) rotate(${-bearing}deg) scale(${s}) translate(${tx}px,${ty}px)`;
    if (tf !== lv.tf) { lv.tf = tf; lv.el.style.transform = tf; }
  }
  function baseTransform() {
    if (!base || !W || !H) return;
    const w = ws(z), k = (GEO.W / baseW / GEO.S) * w;                  // 바닥 요소 1px → 세계 px
    const tf = `translate(${W / 2}px,${H / 2}px) rotate(${-bearing}deg) translate(${-cx * w}px,${-cy * w}px) scale(${k})`;
    if (tf !== baseTf) { baseTf = tf; base.style.transform = tf; }
    if (base.style.visibility) base.style.visibility = '';
  }

  // ---- 타일 실패 알림(한 번만, 지도 모드) ----
  let errShown = false, errT = 0;
  function tileFail() {
    if (errShown || GEO.image) return;
    errShown = true;
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
    if (GEO.image) return;
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
  let me = null;                     // { mx, my, accN, heading }
  let meDisp = null;                 // 화면에 그리는 값(부드럽게 따라감)
  let meAnim = null;                 // { from:{mx,my}, t0 }
  let headDisp = null;
  let route = null;                  // { mx, my } 길찾기 목표

  // 따라가기 가운데: 'heading' 은 내 위치를 화면 가운데보다 아래(앞이 더 보이게)
  function anchorFor(mx, my, b = bearing, zz = z) {
    const off = follow === 'heading' ? H * 0.18 : 0;
    if (!off) return { x: mx, y: my };
    const p = TM.rotate(0, off, b), s = ws(zz);
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
      const p = n2s(v, k.mx, k.my);
      const tf = `translate(${p.x.toFixed(1)}px,${p.y.toFixed(1)}px)`;
      if (tf !== k.tf) { k.tf = tf; k.el.style.transform = tf; }
    }
    let mp = null;
    if (meDisp) {
      mp = n2s(v, meDisp.mx, meDisp.my);
      meEl.style.transform = `translate(${mp.x.toFixed(1)}px,${mp.y.toFixed(1)}px)`;
      const r = fin(me?.accN) && me.accN > 0 ? Math.min(4000, me.accN * ws(z)) : 0;
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
    if (route && mp) {
      const q = n2s(v, route.mx, route.my);
      if (routeSvg.style.display) routeSvg.style.display = '';
      routeLine.setAttribute('x1', mp.x.toFixed(1)); routeLine.setAttribute('y1', mp.y.toFixed(1));
      routeLine.setAttribute('x2', q.x.toFixed(1)); routeLine.setAttribute('y2', q.y.toFixed(1));
    } else if (!routeSvg.style.display) routeSvg.style.display = 'none';
    if (compass) {
      const show = Math.abs(TM.deltaDeg(0, bearing)) > 0.5 || follow === 'heading';
      if (compassBtn.hidden === show) compassBtn.hidden = !show;
      if (show) {
        const nd = GEO.image ? (fin(north) ? north - bearing : -bearing) : -bearing;
        needle.setAttribute('transform', `rotate(${nd.toFixed(1)} 22 22)`);
      }
    }
    // 이름 핀: 확대가 작으면 번호만(겹침 방지), 크면 이름까지
    if (namesZoomNow() != null) {
      const on = z >= namesZoomNow();
      if (on !== namesOn) { namesOn = on; el.dataset.names = on ? '1' : '0'; }
    }
  }
  function namesZoomNow() {
    if (fin(namesZoom)) return namesZoom;
    if (!GEO.image) return null;
    const f = fitZoom();
    return fin(f) ? f + 0.9 : null;
  }

  function frame(now) {
    raf = 0;
    if (!alive) return;
    stats.frames++;
    const dt = lastFrame ? Math.min(64, now - lastFrame) : 16;
    lastFrame = now;
    let more = false;

    if (pendingFit && W && H) {
      pendingFit = false;
      const f = fitZoom();
      if (fin(f)) { z = clampZ(f + (fin(fitOff) ? fitOff : 0)); if (!center || autoFit === 'mid') { cx = GEO.maxX / 2; cy = GEO.maxY / 2; } }
    }

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
      z = lerp(a.z, b.z, e);
      cx = lerp(a.cx, b.cx, e); cy = lerp(a.cy, b.cy, e);
      if (viewAnim.anchor) {                                           // 기준점 고정 확대(두 번 탭·스냅): 그 점이 손가락 아래 그대로
        const n = zoomAt({ cx: a.cx, cy: a.cy, z: a.z, bearing, w: W, h: H }, z, viewAnim.anchor.x, viewAnim.anchor.y);
        cx = n.cx; cy = n.cy;
      }
      if (t >= 1) { viewAnim = null; z = b.z; if (!b.keepCenter && !b.anchored) { cx = b.cx; cy = b.cy; } emitAnimEnd(); } else more = true;
    }
    if (inertia) {
      const v = inertia;
      const d = dragD(view(), v.vx * dt, v.vy * dt);
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
    if (GEO.image) {
      // 도면 밖으로 너무 나가지 않게(가운데가 쪽 안 — 내 위치를 따라갈 때는 쪽 밖이어도 그대로)
      if (!(follow && meDisp)) { cx = TM.clamp(cx, 0, GEO.maxX); cy = TM.clamp(cy, 0, GEO.maxY); }
    } else { cy = TM.clamp(cy, 0, 1); cx = TM.clamp(cx, 0, 1); }

    // 타일 단계 고르기: 확대 애니메이션 중이면 도착할 단계, 아니면 지금 확대(경계에서 오락가락하지 않게)
    const target = viewAnim && viewAnim.to.z !== viewAnim.from.z ? viewAnim.to : null;
    // 이미지 모드는 크기를 알기 전(맞춤 전 z=0)에 단계를 고르지 않는다 — 맞춘 확대에서 처음 고르게(그 단계로 굳지 않게)
    const lz0 = GEO.image && (!W || !H) ? null : target ? GEO.level(target.z, null) : GEO.level(z, front ? front.z : null);
    const lz = tilesNeeded(lz0, target ? target.z : z) ? lz0 : null;
    if (lz != null && (!front || front.z !== lz || front.layer !== curLayer)) switchFront(lz);
    else if (lz == null && GEO.image && (front || back)) { dropLevel(back); back = null; dropLevel(front); front = null; }   // 미리보기가 더 선명 — 타일은 놓는다
    const v = view();
    baseTransform();
    if (front) levelTransform(front);
    if (back) levelTransform(back);
    if (front) updateTiles(front, target ? { ...v, cx: target.cx, cy: target.cy, z: target.z } : v);
    placeOverlays(v);
    el.dataset.zoom = z.toFixed(2);
    for (const fn of subs.render) { try { fn(); } catch (e) { console.error(e); } }
    if (more) schedule();
    else if (GEO.image && !gesture) schedulePrefetch();
  }

  // ---- 한가할 때 미리 받기(이미지 모드만 — VWorld 타일은 약관상 미리 받지 않는다) ----
  // 멈춰 있을 때(움직임·손짓 없음) requestIdleCallback 으로: ① 한 단계 확대했을 때 보일 칸(가운데부터) ② 지금 단계 화면 둘레 한 줄.
  // 읽고 디코드까지 해 두면(source.prefetch — drawtiles 가 LRU 로 쥔다) 두 번 탭·두 손가락 확대·끌기에서 바로 선명. 손을 대면 멈춘다.
  let pfT = 0, pfGen = 0, pfSig = '';
  const PF_MAX = 12;
  const ric = typeof requestIdleCallback === 'function' ? fn => requestIdleCallback(fn, { timeout: 1200 }) : fn => setTimeout(fn, 300);
  const cic = typeof cancelIdleCallback === 'function' ? cancelIdleCallback : clearTimeout;
  function stopPrefetch() { if (pfT) { cic(pfT); pfT = 0; } pfGen++; }
  function schedulePrefetch() {
    if (pfT || !alive || typeof src?.prefetch !== 'function' || !W || !H || viewAnim || inertia || isTyping()) return;
    if (front && front.pending) return;                                // 지금 보이는 칸이 먼저
    const sig = `${cx.toFixed(5)},${cy.toFixed(5)},${z.toFixed(3)},${bearing.toFixed(1)},${W}x${H},${front?.z ?? '-'}`;
    if (sig === pfSig) return;
    pfT = ric(() => { pfT = 0; pfSig = sig; runPrefetch(); });
  }
  async function runPrefetch() {
    const gen = ++pfGen;
    const v = view();
    const want = [];
    const add = (lz, r, limit) => {
      const g = r && GEO.grid(lz);
      if (!g) return;
      let n = 0;
      for (const t of tilesIn(r, v, g)) {
        if (n >= limit) break;
        if (g.blank?.has(t.y * g.cols + t.x)) continue;
        if (front && front.z === lz && front.tiles.has(t.key)) continue;
        want.push(t); n++;
      }
    };
    // ① 확대해 들어갈 때 쓸 단계(지금보다 한 단계 위) — 그 단계를 고르게 되는 확대에서 화면 가운데 칸부터
    //   미리보기가 덮는 단계(1:1 근처)는 건너뛰고 그 위 단계 — 두 손가락으로 크게 벌렸을 때 바로 선명하게
    if (GEO.levels) {
      let lzIn = Math.min(GEO.top, Math.max(GEO.level(Math.min(GEO.zmax, z + 1), null) ?? 0, (front?.z ?? GEO.level(z, null) ?? -1) + 1));
      let zAt = Math.max(z + 0.5, lzIn - BIAS);                      // 그 단계가 처음 골라지는 확대 근처
      for (let i = 0; i < 2 && lzIn < GEO.top && !tilesNeeded(lzIn, zAt); i++) { lzIn++; zAt = Math.max(z + 0.5, lzIn - BIAS); }
      if (lzIn !== front?.z && tilesNeeded(lzIn, zAt)) add(lzIn, tileRange({ ...v, z: zAt }, lzIn, 0), 8);
    }
    // ② 지금 단계 화면 둘레 한 줄(끌면 바로 보일 칸)
    if (front) {
      const r = tileRange(v, front.z, PAD + GEO.tile);
      if (r) add(front.z, r, PF_MAX - want.length);
    }
    for (const t of want.slice(0, PF_MAX)) {
      if (gen !== pfGen || !alive || gesture || viewAnim || inertia) return;
      try { await src.prefetch(t.z, t.x, t.y); stats.prefetched++; } catch { /* 없으면 그만 */ }
    }
  }

  // ---- 알림 ----
  const centerOut = () => GEO.fromN(cx, cy);
  function emitMove(kind, phase) {
    for (const fn of [...subs.move]) { try { fn({ kind, phase, center: centerOut(), zoom: z }); } catch (e) { console.error(e); } }
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
  let rect = null, lastTap = null, tapT = 0;
  const local = e => ({ x: e.clientX - rect.left, y: e.clientY - rect.top });
  const midDist = () => { const [a, b] = [...pts.values()]; return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)) }; };

  function stopMotion() { viewAnim = null; inertia = null; animEndKind = null; }
  function onDown(e) {
    if (e.button > 0 || e.target.closest?.('.lm-compass')) return;
    stopPrefetch();
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
        autoFit = null;
        if (follow) setFollowMode(false);
        emitMove('pan', 'start');
      }
      if (!(g.afterPinch && follow)) {                                  // 따라가기 중 두 손가락 뒤 남은 손가락은 옮기지 않는다
        const d = dragD(view(), p.x - g.lx, p.y - g.ly);
        cx += d.x; cy += d.y;
      }
      g.lx = p.x; g.ly = p.y;
      g.samples.push({ x: p.x, y: p.y, t: e.timeStamp });
      while (g.samples.length > 2 && e.timeStamp - g.samples[0].t > 100) g.samples.shift();
      schedule();
    } else if (gesture.mode === 'pinch' && pts.size >= 2) {
      const g = gesture, md = midDist();
      if (!g.moved && (Math.abs(md.d - g.d0) > 10 || Math.hypot(md.x - g.m0x, md.y - g.m0y) > 10)) g.moved = true;
      autoFit = null;
      const z2 = clampZ(z + Math.log2(md.d / g.d));
      const an = zoomAnchorScreen(g.mx, g.my);
      const n = zoomAt(view(), z2, an.x, an.y);
      cx = n.cx; cy = n.cy; z = n.z;
      if (!(follow && me)) {                                           // 두 손가락을 같이 옮기면 지도도 따라간다(따라가기 중에는 내 위치 고정)
        const d = dragD(view(), md.x - g.mx, md.y - g.my);
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
  // 손을 떼면 가까운 정수 확대로(타일이 또렷하게). 이미지 모드는 그대로(맞춤 배율이 소수 — 단계 고르기가 또렷함을 맡는다)
  function snapZoom(ax, ay, kind) {
    if (GEO.image) { schedule(); emitMove(kind, 'end'); return; }
    const zr = TM.clampZoom(Math.round(z));
    if (Math.abs(zr - z) < 1e-3) { z = zr; schedule(); emitMove(kind, 'end'); return; }
    const an = zoomAnchorScreen(ax, ay);
    animateZoom(zr, an, kind, SNAP_MS);
  }
  function animateZoom(z2, an, kind, dur = 220) {
    z2 = clampZ(z2);
    autoFit = null;
    animEndKind = kind;
    if (reduced() || !W) {
      const n = zoomAt(view(), z2, an.x, an.y);
      cx = n.cx; cy = n.cy; z = z2; schedule(); emitAnimEnd(); return;
    }
    const n = zoomAt(view(), z2, an.x, an.y);
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
      clearTimeout(tapT); tapT = 0;
      emitMove('zoom', 'start');
      // 이미지 모드 두 번 탭: 한 단계(2배) 확대 — 정수로 맞추지 않고 지금 배율에서
      animateZoom(GEO.image ? z + 1 : Math.round(z) + 1, zoomAnchorScreen(g.sx, g.sy), 'zoom');
      return;
    }
    lastTap = { t: now, x: g.sx, y: g.sy };
    if (subs.tap.size) {
      clearTimeout(tapT);
      const sx = g.sx, sy = g.sy;
      tapT = setTimeout(() => {
        tapT = 0;
        if (!alive) return;
        const n = s2n(view(), sx, sy), at = GEO.fromN(n.x, n.y);
        for (const fn of [...subs.tap]) { try { fn({ x: sx, y: sy, at }); } catch (err) { console.error(err); } }
      }, DBL_MS);
    }
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
    autoFit = null;
    const p = local(e);
    const an = zoomAnchorScreen(p.x, p.y);
    const n = zoomAt(view(), clampZ(z - e.deltaY * (e.deltaMode ? 0.05 : 0.002)), an.x, an.y);
    cx = n.cx; cy = n.cy; z = n.z;
    schedule();
    clearTimeout(wheelT);
    wheelT = setTimeout(() => { wheelT = 0; snapZoom(p.x, p.y, 'zoom'); }, 220);
  }
  if (gestures) {
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMoveEv);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointercancel', onCancel);
    el.addEventListener('lostpointercapture', e => { if (pts.has(e.pointerId)) onCancel(e); });
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('contextmenu', e => e.preventDefault());
  }

  // ---- 크기 ----
  let ro = null;
  function resized(w, h) {
    if (w === W && h === H) return;
    const first = !W || !H;
    W = w; H = h;
    if (front) front.range = null;
    if (autoFit && GEO.image && !gesture && w && h) pendingFit = true;   // 아직 손대지 않았으면 새 크기에 다시 맞춘다
    // 처음 크기를 안 순간(ResizeObserver 는 그리기 직전)에 바로 한 번 그린다 — 다음 프레임까지 빈 상자로 한 번 더 기다리지 않게
    if (first && w && h && alive) { if (raf) { cancelAnimationFrame(raf); raf = 0; } frame(performance.now()); return; }
    schedule();
  }
  function measure() { const r = el.getBoundingClientRect(); resized(r.width, r.height); }
  if (typeof ResizeObserver === 'function') {
    ro = new ResizeObserver(ents => { const cr = ents[ents.length - 1].contentRect; resized(cr.width, cr.height); });
    ro.observe(el);
  } else queueMicrotask(measure);
  if (!imageMode && !apiKey) showNote(NOKEY_TEXT);

  // ---- 바깥 함수 ----
  function setView(ll, zz, { animate = true } = {}) {
    if (!alive || gesture) return false;
    const m = GEO.toN(ll) || { x: cx, y: cy };
    const given = !!GEO.toN(ll);
    let z2 = zz == null ? z : clampZ(zz);
    inertia = null;
    pendingFit = false; autoFit = null;
    // 따라가는 중: 내 위치로 옮기라는 것이면 확대만(가운데는 따라가기가 잡는다), 다른 곳이면 따라가기를 푼다
    if (follow && me && given) {
      const s = ws(z);
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
    const far = Math.hypot((m.x - cx) * ws(z), (m.y - cy) * ws(z)) > 2 * Math.max(W, H, 400);
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
    if (GEO.image || !TM.LAYERS[l] || l === curLayer) return;
    curLayer = l;
    el.dataset.layer = l;
    schedule();                                                         // 다음 그림에서 새 단계를 만들고, 다 받을 때까지 앞 레이어가 아래에 남는다
  }
  function setMe(p) {
    if (!alive) return;
    const m = GEO.toN(p);
    if (!m) {
      me = null; meDisp = null; meAnim = null; headDisp = null;
      meEl.hidden = true;
      schedule();
      return;
    }
    const hd = fin(p.heading) ? TM.normDeg(p.heading) : null;
    const prev = meDisp;
    const accN = GEO.image ? (fin(p.accPx) && p.accPx > 0 ? GEO.accN(p.accPx) : null) : (fin(p.acc) ? GEO.accN(p.acc, p.lat) : null);
    me = { mx: m.x, my: m.y, accN, heading: hd };
    meEl.hidden = false;
    const s = ws(z);
    const jump = !prev || reduced() || Math.hypot((m.x - prev.mx) * s, (m.y - prev.my) * s) > Math.max(W, H, 400);
    if (jump) { meAnim = null; meDisp = { mx: m.x, my: m.y }; }
    else if (m.x !== prev.mx || m.y !== prev.my) meAnim = { from: { ...prev }, t0: performance.now() };
    if (hd == null) headDisp = null;
    schedule();
  }
  const fire = k => { for (const fn of [...subs.marker]) { try { fn(k.m); } catch (err) { console.error(err); } } };
  function setMarkers(list) {
    if (!alive) return;
    const old = new Map(mkList.map(k => [k.m.id, k]));
    const next = [];
    for (const m of Array.isArray(list) ? list : []) {
      const mm = GEO.toN(m);
      if (!m || !mm) continue;
      const id = m.id ?? (GEO.image ? `${m.x},${m.y}` : `${m.lat},${m.lng}`);
      let k = old.get(id);
      const label = m.label == null ? '' : String(m.label);
      const name = m.name == null ? '' : String(m.name);
      const kind = m.kind || 'pin';
      const aria = name ? `${label ? label + ' ' : ''}${name}` : (label ? `위치 ${label}` : '위치');
      if (!k) {
        const span = h('span', { class: 'lm-no', text: label });
        const nm = h('span', { class: 'lm-nm', text: name });
        const b = h('button', { type: 'button', class: 'lm-mk', 'data-mid': String(id), 'data-kind': kind, 'aria-label': aria,
          onclick: ev => { if (ev.detail === 0 || !gestures) fire(k); } }, span, nm);
        k = { el: b, span, nm, tf: '' };
      } else old.delete(id);
      if (k.span.textContent !== label) k.span.textContent = label;
      if (k.nm.textContent !== name) { k.nm.textContent = name; k.nm.hidden = !name; }
      k.nm.hidden = !name;
      if (k.el.getAttribute('aria-label') !== aria) k.el.setAttribute('aria-label', aria);
      if (k.el.dataset.kind !== kind) k.el.dataset.kind = kind;
      if (m.testid && k.el.dataset.testid !== m.testid) k.el.dataset.testid = m.testid;
      if (m.dataId != null && k.el.dataset.id !== String(m.dataId)) k.el.dataset.id = String(m.dataId);
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
    if (mode) autoFit = null;
    setFollowMode(mode);
    if (follow && me) {
      const tgt = meDisp || { mx: me.mx, my: me.my };
      const b = follow === 'heading' && me.heading != null ? me.heading : bearing;
      const a = anchorFor(tgt.mx, tgt.my, b);
      if (follow === 'heading' && me.heading != null) { rotAnim = null; setRotationInner(me.heading, true); }
      if (!reduced() && W) viewAnim = { from: { cx, cy, z }, to: { cx: a.x, cy: a.y, z }, t0: performance.now(), dur: ANIM_MS };
      else { cx = a.x; cy = a.y; }
    }
    schedule();
  }
  function setRoute(t) {
    const m = GEO.toN(t);
    route = m ? { mx: m.x, my: m.y } : null;
    schedule();
  }
  // 타일이 더 만들어졌거나(upto) 다시 만들어졌을 때 — 보던 자리·확대는 그대로, 단계만 다시 깐다
  function setSource(s) {
    if (!alive || !GEO.image || s?.kind !== 'image') return;
    const keep = GEO.fromN(cx, cy);
    const sameSize = +s.w === GEO.W && +s.h === GEO.H;
    src = s;
    GEO = imageGeo(src, BIAS);
    if (sameSize) { const n = GEO.toN(keep); cx = n.x; cy = n.y; } else pendingFit = true;
    dropLevel(back); back = null; dropLevel(front); front = null;
    if (!baseImg || !sameSize) { if (baseImg) { baseImg.remove(); baseImg = null; pvReady = false; } makeBase(); }
    pfSig = '';
    schedule();
  }
  function fit({ animate = true } = {}) {
    const f = fitZoom();
    fitOff = 0;
    if (!fin(f)) { pendingFit = true; autoFit = 'mid'; schedule(); return; }
    setFollowMode(false);
    setView(GEO.fromN(GEO.maxX / 2, GEO.maxY / 2), f, { animate });
    autoFit = GEO.image ? 'mid' : null;                                 // 맞춘 뒤 크기가 바뀌어도 맞춤 유지
  }
  function destroy() {
    if (!alive) return;
    alive = false;
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    clearTimeout(wheelT); clearTimeout(errT); clearTimeout(tapT);
    stopPrefetch();
    ro?.disconnect();
    removeEventListener('online', onOnline);
    dropLevel(front); dropLevel(back);
    front = back = null;
    for (const s of Object.values(subs)) s.clear();
    el.remove();
  }
  const sub = set => fn => { if (typeof fn === 'function') set.add(fn); return () => set.delete(fn); };

  started = true;
  schedule();
  const api = {
    el,
    setView, setLayer, setRotation, setMe, setMarkers,
    onMarker: sub(subs.marker), onMove: sub(subs.move),
    center: centerOut, zoom: () => z, destroy,
    // 덧붙임
    setFollow, follow: () => follow, onFollow: sub(subs.follow), onError: sub(subs.error),
    onTap: sub(subs.tap), onRender: sub(subs.render), setRoute,
    zoomBy: (d, { animate = true } = {}) => {
      if (!alive || gesture) return;
      const an = zoomAnchorScreen(W / 2, H / 2);
      const z2 = GEO.image ? z + d : Math.round(z) + d;
      if (!animate) { const n = zoomAt(view(), clampZ(z2), an.x, an.y); cx = n.cx; cy = n.cy; z = n.z; schedule(); return; }
      stopMotion();
      animateZoom(z2, an, null);
    },
    rotation: () => bearing, layer: () => curLayer,
    project: (a, b) => { const n = GEO.image ? GEO.toN({ x: a, y: b }) : GEO.toN({ lat: a, lng: b }); return n ? n2s(view(), n.x, n.y) : null; },
    unproject: (x, y) => { const n = s2n(view(), x, y); return GEO.fromN(n.x, n.y); },
    size: () => ({ w: W, h: H }),
    setKey(k) {
      if (GEO.image) return;
      const nk = String(k || '').trim();
      if (nk === apiKey) return;
      apiKey = nk;
      dropLevel(back); back = null; dropLevel(front); front = null;
      errShown = false; delete el.dataset.tileError;
      showNote(apiKey ? null : NOKEY_TEXT);
      schedule();
    },
    // 이미지 모드
    setSource, fit, fitZoom,
    setNorth(deg) { north = fin(deg) ? TM.normDeg(deg) : null; schedule(); },
    // sharp: 지금 확대에 맞는 그림이 다 그려짐(타일 단계가 필요 없으면 미리보기, 필요하면 그 단계 칸이 다 옴) — 측정·시험용
    _stats: () => ({ ...stats, sharp: !W || !H ? false : GEO.image ? (front ? front.pending === 0 && !back && front.tiles.size > 0 : pvReady) : (!!front && front.pending === 0 && !back), preview: pvReady, tiles: (front?.tiles.size || 0) + (back?.tiles.size || 0), frontZ: front?.z ?? null, back: !!back, pending: front?.pending ?? 0, pool: pool.length, imgs: el.querySelectorAll('img.lm-t').length, z, cx, cy, bearing }),
  };
  Object.defineProperty(el, '__lm', { value: api });                  // 시험용(www/dev) — 화면 코드는 쓰지 않는다
  return api;
}
