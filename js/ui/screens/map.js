// 실시간 위치 지도(화면 'map') — 사용자 요구: "실시간 위치 보기 누르면 지도에 위치로 보여 주는 거, 네이버 지도 길찾기처럼 보는 방향이랑".
// 구성: 위 바(뒤로·제목) → 정보 줄(주소·±m·방향) → 지도(ui/widgets/livemap.js) → 아래 엄지 영역 [지도 종류] [방향 보기] [따라가기(노랑)].
// 동작:
//   - 따라가기(처음 켜짐): 지도 가운데가 계속 내 위치를 따라간다. 손가락 하나로 지도를 끌면 꺼지고 버튼이 [다시 따라가기].
//     두 손가락 확대는 끄지 않는다(엔진이 내 위치를 기준으로 확대).
//   - 방향 보기: 북쪽 위 ↔ 보는 방향 위(지도가 내가 보는 쪽으로 돈다, 내 위치는 가운데보다 조금 아래 — 앞이 더 보이게).
//     보는 방향으로 바꾸면 따라가기도 켠다(네이버처럼). 버튼의 나침반 바늘은 늘 화면에서 북쪽을 가리킨다.
//   - 지도 종류: 일반(Base) ↔ 위성(Hybrid = 위성 + 지명). 마지막 고른 것·방향 모드는 이 기기에만 기억(localStorage, 편의).
//   - 오늘 묶음 중 GPS 가 있는 것(첫 GPS 사진)을 번호 마커로, 탭하면 그 묶음 상세(nav.go('record', {id})).
//   - 주소는 gps.snapshot().addr — 메모리에서 읽어 보여 주기만(VWorld 약관: 저장 금지).
//   - 도면보관함에서 위치 맞춘 도면의 핀(data/drawings.js geoMarkers)도 이름 말풍선으로(묶음 번호 마커와 모양·글자가 다르게), 탭하면 그 도면 보기.
//     도면 DB 는 이 화면이 처음 열 때만 연다(동적 import — 없거나 실패하면 묶음 마커만).
// 가볍게: 위치·방향 알림(방향은 초당 최대 10회)은 값만 보고 rAF 한 번에 지도로(setMe·setRotation·setFollow), 글은 바뀔 때만 DOM 에 쓴다.
// 따라가기는 엔진의 setFollow('pos'|'heading') 에 맡긴다(가운데·점 움직임을 엔진이 한 애니메이션으로 맞춘다). 엔진에 없으면 setView 로 직접.
// 지도 엔진은 동적 import — 없거나 실패하면 화면은 뜨고 안내 한 줄.
import { h, icon, toast } from '../dom.js';
import * as gps from '../../services/gps.js';
import * as heading from '../../services/heading.js';
import * as vworld from '../../services/vworld.js';
import * as store from '../../data/store.js';
import { fmtCoord, fmtAcc } from '../../core/geo.js';
import { dayKey } from '../../core/date.js';
import { keepAwake } from '../../platform/awake.js';

const DEFAULT_CENTER = { lat: 37.5666, lng: 126.9782 };   // 위치를 아직 모를 때(서울시청)
const ZOOM_ME = 17, ZOOM_NONE = 15;
const DRAG_SLOP = 10;                                      // 손가락 하나로 이만큼 끌면 「손으로 옮김」 → 따라가기 끔
const AHEAD = 0.18;                                        // (엔진 따라가기가 없을 때) 보는 방향 위면 내 위치를 지도 높이의 18% 아래로
const LS_LAYER = 'lite.map.layer', LS_ORIENT = 'lite.map.orient';
const LAYER_BASE = 'Base', LAYER_SAT = 'Hybrid';           // livemap 레이어 이름(위성 = 위성 사진 + 지명)
const SVGNS = 'http://www.w3.org/2000/svg';

const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 사생활 모드 등 */ } };

// 인라인 SVG(외부 리소스 금지) — h() 는 svg·use·path 만 만들어 여기서 따로
function svg(tag, attrs = {}, ...kids) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  for (const c of kids) el.append(c);
  return el;
}
// 나침반 아이콘: 빨강 바늘 = 북쪽. 바늘 무리(g)를 돌린다
function compassIcon() {
  const needle = svg('g', { class: 'mp-needle' },
    svg('path', { d: 'M12 3.5 15 12H9z', fill: '#C4122F', stroke: 'none' }),
    svg('path', { d: 'M12 20.5 9 12h6z', fill: 'currentColor', stroke: 'none', opacity: '.55' }));
  const el = svg('svg', { class: 'ic mp-compass', width: 24, height: 24, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false', 'data-testid': 'map-compass' },
    svg('circle', { cx: 12, cy: 12, r: 10 }), needle);
  return { el, needle };
}
function layersIcon() {
  return svg('svg', { class: 'ic', width: 24, height: 24, viewBox: '0 0 24 24', 'aria-hidden': 'true', focusable: 'false' },
    svg('path', { d: 'M12 3 2.5 8 12 13l9.5-5z' }), svg('path', { d: 'M2.5 12 12 17l9.5-5' }), svg('path', { d: 'M2.5 16 12 21l9.5-5' }));
}

// 지도 엔진 감싸기 — 계약: liveMap({center, zoom, layer, key}) → { el, setMe, setView, setRotation, setLayer, setMarkers, onMarker, onMove, destroy }
// 덧붙임(있으면 씀): setFollow(false|'pos'|'heading'), onFollow(fn(mode)), zoom()
function wrapEngine(mod, opts) {
  const make = mod?.liveMap || mod?.default;
  if (typeof make !== 'function') throw new Error('liveMap 이 없어요');
  const m = make(opts);
  const el = m?.el;
  if (!(el instanceof Element)) throw new Error('liveMap 이 요소를 주지 않았어요');
  const call = (name, ...a) => { try { return typeof m[name] === 'function' ? m[name](...a) : undefined; } catch (e) { console.error(`livemap.${name} 실패`, e); } };
  return {
    el,
    hasFollow: typeof m.setFollow === 'function' && typeof m.onFollow === 'function',
    setMe: me => call('setMe', me),
    setView: (center, zoom, o) => call('setView', center, zoom, o),
    setRotation: (deg, o) => call('setRotation', deg, o),
    setLayer: l => call('setLayer', l),
    setMarkers: list => call('setMarkers', list),
    setFollow: mode => call('setFollow', mode),
    follow: () => call('follow'),
    onFollow: fn => call('onFollow', fn),
    onMarker: fn => call('onMarker', fn),
    onMove: fn => call('onMove', fn),
    zoom: () => call('zoom') ?? null,
    destroy: () => call('destroy'),
  };
}

// 위도에서 한 화면 픽셀이 몇 m 인가(256 타일 웹 메르카토르)
const mPerPx = (lat, z) => 156543.03392 * Math.cos(lat * Math.PI / 180) / 2 ** z;
// 점 p 에서 방위 brg 로 d m 간 곳
function ahead(p, brg, d) {
  const R = 6371008.8, b = brg * Math.PI / 180, la = p.lat * Math.PI / 180, lo = p.lng * Math.PI / 180, dr = d / R;
  const la2 = Math.asin(Math.sin(la) * Math.cos(dr) + Math.cos(la) * Math.sin(dr) * Math.cos(b));
  const lo2 = lo + Math.atan2(Math.sin(b) * Math.sin(dr) * Math.cos(la), Math.cos(dr) - Math.sin(la) * Math.sin(la2));
  return { lat: la2 * 180 / Math.PI, lng: lo2 * 180 / Math.PI };
}

// 오늘 묶음 → 번호 마커(첫 GPS 사진의 좌표). 번호는 그날 묶음 순번(no 'YYMMDD-NN' 의 NN)
export function dayMarkers(day = dayKey(Date.now())) {
  const out = [];
  let i = 0;
  for (const r of store.recordsOfDay?.(day) ?? []) {
    i++;
    const p = (store.photosOf?.(r.id) ?? []).find(x => Number.isFinite(x?.gps?.lat) && Number.isFinite(x?.gps?.lng));
    if (!p) continue;
    const n = Number(String(r.no || '').split('-')[1]) || i;
    out.push({ id: r.id, lat: p.gps.lat, lng: p.gps.lng, label: String(n), title: r.location || r.no || '' });
  }
  return out;
}

const STATE_TEXT = { off: '위치가 꺼져 있어요', asking: '위치 권한을 묻는 중이에요', denied: '위치 권한이 꺼져 있어요', searching: '위치 찾는 중…', error: '위치를 못 잡았어요', unsupported: '이 기기는 위치를 못 써요' };

export default {
  dark: false,
  mount(root, params, nav) {
    root.classList.add('mp');
    let alive = true;
    const offs = [];

    // ---- 상태 ----
    let follow = true, followOffBy = null;                 // null | 'drag' | 'tap'
    let orient = lsGet(LS_ORIENT) === 'heading' ? 'heading' : 'north';
    let layer = lsGet(LS_LAYER) === LAYER_SAT ? LAYER_SAT : LAYER_BASE;
    let lastHeading = null;                                // 방향을 잠깐 놓쳐도 지도를 북쪽으로 되돌리지 않게
    let zoom = null, stageH = 0;
    const downs = new Map();
    let dragging = false, firstFix = true;
    let map = null, mapFailed = false;
    let sent = { view: null, rot: null, me: null, follow: undefined }, selfFollow = false;

    // ---- 위 바·정보 줄 ----
    const bar = h('header', { class: 'bar' },
      h('button', { type: 'button', class: 'icbtn', 'aria-label': '뒤로', 'data-testid': 'map-back', on: { click: () => nav.back() } }, icon('back')),
      h('h1', { text: '실시간 위치' }));
    const infoMain = h('span', { class: 'mp-addr', 'data-testid': 'map-addr' });
    const infoAcc = h('span', { class: 'mp-acc', 'data-testid': 'map-acc' });
    const infoDir = h('span', { class: 'mp-dir', 'data-testid': 'map-dir' });
    const info = h('div', { class: 'mp-info', 'data-testid': 'map-info', role: 'status', 'aria-live': 'polite' },
      icon('locate', 20), h('span', { class: 'mp-info-t' }, infoMain, h('span', { class: 'mp-info-s' }, infoAcc, infoDir)));

    // ---- 지도 자리 ----
    const note = h('button', { type: 'button', class: 'mp-note', 'data-testid': 'map-note', hidden: true, on: { click: () => onNote() } });
    const holder = h('div', { class: 'mp-holder' });
    const stage = h('div', { class: 'mp-stage', 'data-testid': 'map-stage' }, holder, note);

    // ---- 아래 엄지 영역 ----
    const layerT = h('span', { class: 'mp-btn-t' });
    const layerBtn = h('button', { type: 'button', class: 'mp-btn', 'data-testid': 'map-layer', on: { click: () => toggleLayer() } }, layersIcon(), layerT);
    const cmp = compassIcon();
    const orientT = h('span', { class: 'mp-btn-t' });
    const orientBtn = h('button', { type: 'button', class: 'mp-btn', 'data-testid': 'map-orient', on: { click: () => toggleOrient() } }, cmp.el, orientT);
    const followT = h('span', { class: 'mp-btn-t' });
    const followBtn = h('button', { type: 'button', class: 'mp-btn mp-follow', 'data-testid': 'map-follow', on: { click: () => toggleFollow() } }, icon('locate'), followT);
    const dock = h('div', { class: ['mp-dock', 'dock'] }, layerBtn, orientBtn, followBtn);

    root.append(bar, info, stage, dock);

    const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
    const setAttr = (el, k, v) => { if (el.getAttribute(k) !== v) el.setAttribute(k, v); };

    // ---- 버튼 ----
    function drawButtons() {
      const sat = layer === LAYER_SAT;
      setText(layerT, sat ? '위성' : '일반');
      setAttr(layerBtn, 'aria-label', sat ? '지도 종류: 위성. 눌러서 일반 지도로' : '지도 종류: 일반. 눌러서 위성 지도로');
      layerBtn.dataset.value = sat ? 'satellite' : 'base';
      const hu = orient === 'heading';
      setText(orientT, hu ? '방향 보는 중' : '방향 보기');                    // 도면 보기와 같은 말 — 무엇을 누르면 되는지(지금 상태는 검정 바탕·aria-pressed)
      setAttr(orientBtn, 'aria-pressed', String(hu));
      setAttr(orientBtn, 'aria-label', hu ? '방향 보기: 보는 방향이 위. 눌러서 북쪽 위로' : '방향 보기: 북쪽이 위. 눌러서 보는 방향 위로');
      orientBtn.classList.toggle('on', hu);
      orientBtn.dataset.value = orient;
      setText(followT, follow ? '따라가는 중' : (followOffBy === 'drag' ? '다시 따라가기' : '따라가기'));
      setAttr(followBtn, 'aria-pressed', String(follow));
      setAttr(followBtn, 'aria-label', follow ? '내 위치 따라가는 중. 눌러서 끄기' : '내 위치 따라가기');
      followBtn.classList.toggle('on', follow);
      followBtn.dataset.state = follow ? 'on' : 'off';
    }

    // ---- 정보 줄·안내 ----
    function drawInfo() {
      const g = gps.snapshot() || {};
      const hd = heading.snapshot() || {};
      const pos = g.state === 'ok' ? g.pos : null;
      const a = g.addrState === 'ok' ? g.addr : null;
      setText(infoMain, pos ? ((a && (a.road || a.text || a.parcel)) || fmtCoord(pos.lat, pos.lng)) : (STATE_TEXT[g.state] || '위치 찾는 중…'));
      setText(infoAcc, pos ? fmtAcc(pos.acc) : '');
      setText(infoDir, Number.isFinite(hd.heading) ? heading.fmtHeading(hd.heading) : '');
      if (info.dataset.state !== (g.state || 'off')) info.dataset.state = g.state || 'off';
      drawNote(g, hd);
    }
    // 안내 한 줄 — 가장 급한 것 하나만, 무엇을 하면 되는지
    let noteKind = null;
    function drawNote(g, hd) {
      let kind = null, t = '';
      if (g.state === 'denied') { kind = 'denied'; t = '위치 권한이 꺼져 있어요 · 눌러서 다시 묻기'; }
      else if (g.state === 'off') { kind = 'gpsoff'; t = '휴대폰 위치(GPS)를 켜 주세요 · 눌러서 다시 찾기'; }
      else if (g.state === 'unsupported') { kind = 'unsupported'; t = '이 기기는 위치를 못 써요'; }
      else if (g.state === 'error') { kind = 'gpserr'; t = '위치를 못 잡았어요 · 눌러서 다시 찾기'; }
      else if (!map && mapFailed) { kind = 'nomap'; t = '지도를 불러오지 못했어요 · 눌러서 다시'; }
      else if (!vworld.key()) { kind = 'nokey'; t = 'VWorld 키가 없어요 · 눌러서 설정에서 넣기'; }
      else if (hd.needsCalibration) { kind = 'calib'; t = '방향이 흔들려요 · 폰을 8자로 움직여 주세요'; }
      else if (orient === 'heading' && hd.state === 'permission') { kind = 'perm'; t = '눌러서 나침반을 켜 주세요'; }
      else if (orient === 'heading' && hd.state === 'nocompass') { kind = 'nocompass'; t = '이 폰은 나침반이 없어요 · 걸으면 가는 방향으로 돌아요'; }
      if (kind === noteKind && note.textContent === t) return;
      noteKind = kind;
      note.hidden = !kind;
      setText(note, t);
      if (kind) note.dataset.kind = kind; else delete note.dataset.kind;
    }
    function onNote() {
      if (noteKind === 'denied' || noteKind === 'gpsoff' || noteKind === 'gpserr') {
        if (noteKind === 'denied') toast('안 되면 휴대폰 설정 > 앱 > 권한에서 위치를 켜 주세요', 4000);
        Promise.resolve(gps.retry?.()).catch(e => console.warn('위치 다시 묻기 실패', e));
      } else if (noteKind === 'nokey') nav.go('settings');
      else if (noteKind === 'nomap') loadMap();
      else if (noteKind === 'perm') askCompass();
    }

    // ---- 조작 ----
    function toggleLayer() {
      layer = layer === LAYER_SAT ? LAYER_BASE : LAYER_SAT;
      lsSet(LS_LAYER, layer);
      map?.setLayer(layer);
      drawButtons();
    }
    function askCompass() {
      // iOS: 사용자 탭 안에서 바로 불러야 한다(await 앞에서)
      if (!heading.needsPermission()) return;
      heading.requestPermission().then(r => { if (r !== 'granted') toast('나침반을 못 켰어요. 설정에서 동작·방향 접근을 켜 주세요', 4000); drawInfo(); });
    }
    function toggleOrient() {
      orient = orient === 'heading' ? 'north' : 'heading';
      lsSet(LS_ORIENT, orient);
      if (orient === 'heading') {
        askCompass();
        if (!follow) { follow = true; followOffBy = null; }   // 네이버처럼 — 보는 방향 모드는 내 자리에서 본다
      }
      sent.follow = undefined;                               // 엔진 따라가기 모드를 다시 정한다
      drawButtons(); drawInfo(); schedule();
    }
    function toggleFollow() {
      follow = !follow;
      followOffBy = follow ? null : 'tap';
      if (follow && !gps.snapshot()?.pos) toast('위치를 찾는 중이에요');
      sent.follow = undefined; sent.view = null;
      drawButtons(); schedule();
    }
    function userMoved() {
      if (!follow) return;
      follow = false; followOffBy = 'drag';
      drawButtons(); schedule();
    }

    // 손가락 하나로 끌면 따라가기 끔(두 손가락 확대는 그대로) — 엔진 쪽 onFollow(false) 와 별개로 여기서도 본다(엔진이 달라도 같게)
    const onDown = e => { downs.set(e.pointerId, { x: e.clientX, y: e.clientY }); if (downs.size > 1) dragging = true; };
    const onMoveP = e => {
      const d = downs.get(e.pointerId);
      if (!d || downs.size !== 1 || dragging) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > DRAG_SLOP) { dragging = true; userMoved(); }
    };
    const onUp = e => { downs.delete(e.pointerId); if (!downs.size) { dragging = false; schedule(); } };
    const pOpt = { capture: true, passive: true };
    stage.addEventListener('pointerdown', onDown, pOpt);
    stage.addEventListener('pointermove', onMoveP, pOpt);
    for (const t of ['pointerup', 'pointercancel']) stage.addEventListener(t, onUp, pOpt);

    // ---- 지도에 반영(rAF 한 번에 모아서) ----
    let raf = 0;
    function schedule() { if (!raf && alive) raf = requestAnimationFrame(apply); }
    function apply() {
      raf = 0;
      if (!map || !alive) return;
      const g = gps.snapshot() || {};
      const hd = heading.snapshot() || {};
      const pos = g.pos || null;                           // 권한이 꺼져도 마지막 위치는 남겨 보여 준다
      if (Number.isFinite(hd.heading)) lastHeading = hd.heading;
      const hu = orient === 'heading';

      // 내 위치(점·정확도 원·부채꼴)
      if (pos) {
        const me = { lat: pos.lat, lng: pos.lng, acc: pos.acc, heading: Number.isFinite(hd.heading) ? hd.heading : null };
        const k = `${me.lat.toFixed(6)},${me.lng.toFixed(6)},${Math.round(me.acc ?? -1)},${me.heading == null ? '-' : Math.round(me.heading)}`;
        if (k !== sent.me) { map.setMe(me); sent.me = k; }
      } else if (sent.me !== null) { map.setMe(null); sent.me = null; }

      if (map.hasFollow) {
        // 엔진 따라가기: 'heading' 이면 엔진이 me.heading 으로 돌리고 내 위치를 조금 아래에 둔다
        const mode = follow && pos ? (hu ? 'heading' : 'pos') : false;
        if (mode !== sent.follow) {
          sent.follow = mode; selfFollow = true;                  // 내가 바꾼 것의 onFollow 알림은 「손으로 옮김」이 아니다
          try {
            if (firstFix && mode) { map.setView({ lat: pos.lat, lng: pos.lng }, ZOOM_ME, { animate: false }); firstFix = false; }
            map.setFollow(mode);
          } finally { selfFollow = false; }
          if (mode !== 'heading') sent.rot = null;          // 따라가기 밖에서는 회전을 직접
        }
        if (mode !== 'heading') {
          const want = hu && Number.isFinite(lastHeading) ? lastHeading : 0;
          if (sent.rot == null || Math.abs(heading.angleDiff(want, sent.rot)) >= 0.5) { map.setRotation(want); sent.rot = want; }
        } else if (Number.isFinite(lastHeading)) sent.rot = lastHeading;
      } else {
        // 엔진에 따라가기가 없으면 직접: 회전 + 가운데(보는 방향 위면 앞쪽으로 띄움)
        const want = hu && Number.isFinite(lastHeading) ? lastHeading : 0;
        if (sent.rot == null || Math.abs(heading.angleDiff(want, sent.rot)) >= 0.5) { map.setRotation(want); sent.rot = want; }
        if (follow && pos && !downs.size) {
          let c = { lat: pos.lat, lng: pos.lng };
          const z = zoom ?? map.zoom() ?? ZOOM_ME;
          if (hu && Number.isFinite(lastHeading) && stageH > 0) c = ahead(c, lastHeading, stageH * AHEAD * mPerPx(pos.lat, z));
          const k = `${c.lat.toFixed(7)},${c.lng.toFixed(7)}`;
          if (firstFix) { map.setView(c, ZOOM_ME, { animate: false }); firstFix = false; sent.view = k; zoom = ZOOM_ME; }
          else if (k !== sent.view) { map.setView(c, undefined, { animate: true }); sent.view = k; }
        }
      }
      const rot = hu && Number.isFinite(lastHeading) ? lastHeading : 0;
      cmp.needle.setAttribute('transform', `rotate(${(-rot).toFixed(1)} 12 12)`);
    }

    // ---- 구독 ----
    offs.push(gps.on(() => { drawInfo(); schedule(); }));
    offs.push(heading.on(() => { drawInfo(); schedule(); }));
    const stopGps = gps.start();
    const stopHeading = heading.start();
    keepAwake(true);

    // 오늘 묶음 마커 — store 가 바뀌면 300ms 모아서, 보이는 값이 같으면 그대로
    let markT = 0, markSig = '', dwg = null;
    function dwgMarkers() {
      if (!dwg) return [];
      try {
        return dwg.geoMarkers().map(m => ({ ...m, label: String(dwg.pin(m.pinId)?.no ?? ''), name: m.label, kind: 'dwgpin' }));
      } catch (e) { console.error('도면 핀 마커를 못 만들었어요', e); return []; }
    }
    function drawMarkers() {
      markT = 0;
      if (!map || !alive) return;
      let list = [];
      try { list = dayMarkers(); } catch (e) { console.error('마커를 못 만들었어요', e); }
      const dl = dwgMarkers();
      stage.dataset.dwgMarkers = String(dl.length);
      list = [...dl, ...list];                                 // 묶음 번호 마커가 위에(나중에 그린 것이 위)
      const sig = list.map(m => `${m.id}:${m.label}:${m.name || ''}:${m.lat.toFixed(6)},${m.lng.toFixed(6)}`).join('|');
      if (sig === markSig) return;
      markSig = sig;
      map.setMarkers(list);
      stage.dataset.markers = String(list.length - dl.length);   // 묶음 마커 수(도면 핀은 data-dwg-markers)
    }
    if (typeof store.on === 'function') offs.push(store.on(ch => { if (!ch || ch.records?.size || ch.photos?.size) { clearTimeout(markT); markT = setTimeout(drawMarkers, 300); } }));
    // 도면 핀(위치 맞춘 도면) — 도면 DB 를 연 뒤 한 번, 바뀌면 300ms 모아서
    import('../../data/drawings.js').then(async m => {
      await m.ready();
      if (!alive) return;
      dwg = m;
      offs.push(m.onDrawings(() => { clearTimeout(markT); markT = setTimeout(drawMarkers, 300); }));
      drawMarkers();
    }).catch(e => console.warn('도면 핀을 지도에 못 올렸어요', e));

    // 지도 높이(엔진 따라가기가 없을 때 앞쪽 띄우기 계산) — 크기가 바뀔 때만 읽는다
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') { ro = new ResizeObserver(es => { stageH = es[0]?.contentRect?.height || 0; schedule(); }); ro.observe(stage); }

    // ---- 지도 엔진 ----
    async function loadMap() {
      mapFailed = false;
      const p = gps.snapshot()?.pos;
      const center = p ? { lat: p.lat, lng: p.lng } : (params?.center || DEFAULT_CENTER);
      try {
        const mod = await import('../widgets/livemap.js');
        if (!alive) return;
        map?.destroy();
        zoom = p ? ZOOM_ME : ZOOM_NONE;
        map = wrapEngine(mod, { center, zoom, layer, key: vworld.key(), compass: false });
        firstFix = !p;
        holder.replaceChildren(map.el);
        map.onMarker(mk => {
          if (!alive) return;
          if (mk?.kind === 'dwgpin' && mk.drawingId) { nav.go('drawview', { id: mk.drawingId, pinId: mk.pinId }); return; }
          const id = typeof mk === 'object' ? mk?.id : mk;
          if (id) nav.go('record', { id });
        });
        map.onMove(ev => { if (Number.isFinite(ev?.zoom)) zoom = ev.zoom; });
        if (map.hasFollow) map.onFollow(mode => { if (!selfFollow && !mode && follow && sent.follow) { sent.follow = false; userMoved(); } });
        sent = { view: p ? `${p.lat.toFixed(7)},${p.lng.toFixed(7)}` : null, rot: null, me: null, follow: undefined };
        stage.dataset.ready = '1';
        drawMarkers();
        schedule();
      } catch (e) {
        console.error('지도를 불러오지 못했어요', e);
        mapFailed = true;
        stage.dataset.ready = 'fail';
      }
      drawInfo();
    }

    drawButtons();
    drawInfo();
    loadMap();

    return () => {
      alive = false;
      cancelAnimationFrame(raf); raf = 0;
      clearTimeout(markT);
      for (const off of offs) { try { off?.(); } catch { /* 무시 */ } }
      ro?.disconnect();
      try { stopHeading(); } catch { /* 무시 */ }
      try { stopGps(); } catch { /* 무시 */ }
      keepAwake(false);
      map?.destroy(); map = null;
    };
  },
};
