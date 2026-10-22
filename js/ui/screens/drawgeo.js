// 위치 맞추기 `drawgeo`(docs/도면보관함-설계.md §5.5) — params { id, page? }
// 도면의 점 ↔ 위경도 기준점을 2개 이상 짝지으면(core/georef.js fit) 도면에 내 위치·방향·길찾기가 된다.
// 방법 두 가지(geo-mode):
//   (가) 지도에서(사무실, 정확): 화면 위아래 반씩 — 위 도면, 아래 VWorld 위성(livemap Hybrid). 둘 다 가운데 십자.
//        두 쪽을 끌어 십자를 같은 자리(건물 모서리·기둥·도로 꺾임)에 맞추고 [이 두 점 짝짓기](노랑). 2점부터 위성 위에 도면을 반투명으로 겹쳐 보여 준다.
//   (나) 현장에서(±5~10m): 도면을 끌어 십자를 지금 서 있는 자리에 맞추고 [여기 서 있어요] → 5초 GPS 평균(averageFixes) → 기준점.
// 위: 품질 띠(geo-quality) — 「기준점 3개 · 정확해요 ±2m」/「오차가 커요 … 멀리 떨어진 기준점을 더 찍어 주세요」/「3번 기준점이 35m 어긋나요」.
// 아래: 기준점 목록(geo-point) — 「1 지도 ±1.5m · 오차 0.8m」, 줄 끝 [지우기](5초 되돌리기). 의심 점은 「어긋남」 글자.
// 2점이 맞춰지면 아래 주 버튼이 [저장 · 맞추기 끝](노랑, geo-save)이 되고 [이 두 점 짝짓기]는 흰 버튼으로(노랑은 하나).
// 저장은 setGeoPoints 한 번(수 ms). 맞춘 채(2점 이상) 뒤로 가면 저장하고 5초 [되돌리기] — 공들여 맞춘 점이 조용히 사라지지 않게(v0.1.4 검토).
// 약관: 위성 타일은 보기만(livemap — 브라우저 기본 캐시). 주소 글은 어디에도 저장하지 않는다. 기준점 위경도는 사용자가 정한 좌표라 저장한다.
import { h, icon, toast, snackbar } from '../dom.js';
import { drawingView } from '../widgets/drawingview.js';
import * as D from '../../data/drawings.js';
import * as G from '../../core/georef.js';
import * as gps from '../../services/gps.js';
import * as vworld from '../../services/vworld.js';
import { keepAwake } from '../../platform/awake.js';
import { baseName } from './drawings.js';

const AVG_MS = 5000, AVG_MAX_MS = 20000, SKY_ACC = 25;
const DEFAULT_CENTER = { lat: 37.5666, lng: 126.9782 };
const LS_MODE = 'lite.drawgeo.mode';
const fin = Number.isFinite;
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 저장 못 해도 그만 */ } };
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
const rid = () => 'k_' + Math.random().toString(36).slice(2, 10);
const SVGNS = 'http://www.w3.org/2000/svg';
function crossEl() {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('viewBox', '0 0 48 48'); s.setAttribute('width', '48'); s.setAttribute('height', '48'); s.setAttribute('aria-hidden', 'true');
  for (const [c, w] of [['#fff', 6], ['#C4122F', 2.5]]) {
    const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', 'M24 2v16M24 30v16M2 24h16M30 24h16');
    p.setAttribute('stroke', c); p.setAttribute('stroke-width', w); p.setAttribute('stroke-linecap', 'round'); p.setAttribute('fill', 'none'); s.append(p);
  }
  return h('div', { class: 'geo-cross', 'aria-hidden': 'true' }, s);
}

let current = null;            // onBack 이 초안을 볼 수 있게

export default {
  mount(root, params, nav) {
    root.classList.add('dgeo');
    const id = params?.id;
    let alive = true;
    const offs = [];
    const d = D.drawing(id);
    const page = params?.page || d?.geo?.page || d?.pages?.[0]?.page || 1;
    let draft = (d?.geo?.page === page ? d.geo.points : []).map(p => ({ ...p }));
    let dirty = false, mode = lsGet(LS_MODE) === 'gps' ? 'gps' : 'map';
    let view = null, map = null, overlay = null, avg = null;
    const before = (d?.geo?.page === page ? d.geo.points : []).map(p => ({ ...p }));   // 들어올 때 기준점(자동 저장 [되돌리기])
    const st = { draft: () => draft, dirty: () => dirty, canSave: () => !!fitNow().T && draft.length >= 2, autoSave: () => save({ auto: true }) };
    current = st;

    // ---- 바 ----
    const saveBtn = h('button', { type: 'button', class: 'primary geo-save', 'data-testid': 'geo-save', hidden: true, onclick: () => save() }, '저장 · 맞추기 끝');
    const bar = h('header', { class: 'bar' },
      h('button', { type: 'button', class: 'icbtn', 'aria-label': '뒤로', onclick: () => nav.back() }, icon('back')),
      h('h1', {}, '위치 맞추기', h('span', { class: 'sub', text: d ? baseName(d) : '' })));
    const quality = h('div', { class: 'geo-quality', 'data-testid': 'geo-quality', role: 'status', 'aria-live': 'polite' });
    const modeMap = h('button', { type: 'button', 'data-testid': 'geo-mode', 'data-value': 'map', onclick: () => setMode('map') }, '지도에서', h('small', { text: '사무실·정확' }));
    const modeGps = h('button', { type: 'button', 'data-testid': 'geo-mode', 'data-value': 'gps', onclick: () => setMode('gps') }, '현장에서', h('small', { text: 'GPS ±5~10m' }));
    const seg = h('div', { class: 'seg geo-seg', role: 'group', 'aria-label': '맞추는 방법' }, modeMap, modeGps);

    // ---- 가운데: 도면(위) · 지도(아래) ----
    const dwPane = h('div', { class: 'geo-pane geo-dw' }, h('span', { class: 'geo-label', text: '도면' }), crossEl());
    const mapHold = h('div', { class: 'geo-maphold' });
    const mapPane = h('div', { class: 'geo-pane geo-map' }, mapHold, h('span', { class: 'geo-label', text: '위성 지도' }), crossEl());
    const stage = h('div', { class: 'geo-stage', 'data-testid': 'drawgeo' }, dwPane, mapPane);

    // ---- 아래: 기준점 목록 + 주 행동 ----
    const pts = h('div', { class: 'geo-points', 'data-testid': 'geo-points' });
    const pairBtn = h('button', { type: 'button', class: 'primary', 'data-testid': 'geo-pair', onclick: () => pair() }, '이 두 점 짝짓기');
    const hereBtn = h('button', { type: 'button', class: 'primary geo-here', 'data-testid': 'geo-here', onclick: () => startAvg() }, '여기 서 있어요 · 5초');
    const avgBox = h('div', { class: 'geo-avg', 'data-testid': 'geo-avg', role: 'status', hidden: true });
    const acts = h('div', { class: 'geo-acts' }, pairBtn, hereBtn, saveBtn);
    const dock = h('div', { class: ['geo-dock', 'dock'] }, pts, avgBox, acts);
    root.append(bar, quality, seg, stage, dock);

    // ---- 계산 ----
    const pg = () => D.pageOf(id, page) || { w: 0, h: 0 };
    let qCache = null, qKey = null;
    function fitNow() {
      const key = draft.map(p => `${p.id}:${p.x},${p.y},${p.lat},${p.lng},${p.acc}`).join('|');
      if (key === qKey) return qCache;
      qKey = key;
      const cp = D.cleanPoints(draft, { page });
      const T = cp.length >= 2 ? G.fit(cp, { model: d?.geo?.model || 'auto', page }) : null;
      const q = G.quality(T, { w: pg().w, h: pg().h });
      qCache = { T, q, res: new Map((q.points || []).map(p => [p.id, p])) };
      return qCache;
    }

    function drawQuality() {
      const { T, q } = fitNow();
      let t, lv;
      if (!draft.length) { t = mode === 'map' ? '도면과 위성 지도에서 같은 자리를 십자에 맞춰 짝지어요' : '도면을 끌어 십자를 지금 서 있는 자리에 맞춰요'; lv = 'none'; }
      else if (!T) { t = `기준점 1개 · 멀리 떨어진 곳에 하나 더 찍어 주세요`; lv = 'none'; }
      else { t = `기준점 ${draft.length}개 · ${q.text}`; lv = q.suspect ? 'poor' : q.level; }
      setText(quality, t);
      quality.dataset.level = lv;
      const can = draft.length >= 2 && !!T && dirty;                         // 맞춰졌으면 아래 주 버튼 = [저장 · 맞추기 끝](노랑 하나)
      saveBtn.hidden = !can;
      for (const b of [pairBtn, hereBtn]) { b.classList.toggle('primary', !can); b.classList.toggle('secondary', can); }
      acts.dataset.save = can ? '1' : '0';
    }
    function drawPoints() {
      const { res, q } = fitNow();
      const rows = draft.map((p, i) => {
        const r = res.get(p.id);
        const sus = q.suspect?.id === p.id;
        const how = p.how === 'gps' ? '현장' : '지도';
        const resT = r && fin(r.resM) && draft.length > 2 ? ` · 오차 ${r.resM < 1 ? '1m 미만' : G.fmtM(r.resM)}` : '';
        return h('div', { class: ['geo-point', sus && 'bad'], 'data-testid': 'geo-point', 'data-id': p.id },
          h('button', { type: 'button', class: 'geo-point-b', onclick: () => focusPoint(p) },
            h('span', { class: 'geo-no', text: String(i + 1) }),
            h('span', { class: 'geo-point-t', text: `${how} ±${G.fmtM(p.acc ?? (p.how === 'gps' ? G.GPS_ACC_M : G.MAP_ACC_M))}${resT}` }),
            sus ? h('b', { class: 'geo-sus', text: '어긋남' }) : null),
          h('button', { type: 'button', class: 'geo-del', 'data-testid': 'geo-point-delete', 'aria-label': `${i + 1}번 기준점 지우기`, onclick: () => removePoint(p.id) }, icon('trash', 20)));
      });
      pts.replaceChildren(...rows);
      pts.hidden = !rows.length;
    }
    function drawMarkers() {
      const dm = draft.map((p, i) => ({ id: p.id, x: p.x, y: p.y, label: String(i + 1), kind: 'pin' }));
      view?.engine()?.setMarkers(dm);
      map?.setMarkers(draft.map((p, i) => ({ id: p.id, lat: p.lat, lng: p.lng, label: String(i + 1), kind: 'pin' })));
      setupOverlay();
    }
    function redraw() { drawQuality(); drawPoints(); drawMarkers(); }

    // ---- 겹쳐 보기(2점부터): 위성 지도 위에 도면 미리보기를 반투명으로(CSS matrix — 그 프레임의 지도 투영으로) ----
    let ovCorners = null;
    function setupOverlay() {
      const { T } = fitNow();
      const p = pg();
      if (!map || !T || !p.preview) { if (overlay) overlay.hidden = true; ovCorners = null; return; }
      ovCorners = [G.toLatLng(T, 0, 0), G.toLatLng(T, p.w, 0), G.toLatLng(T, 0, p.h)];
      if (!overlay) {
        overlay = h('img', { class: 'geo-overlay', 'data-testid': 'geo-overlay', alt: '', decoding: 'async', draggable: false });
        D.previewSrc(id, page).then(u => { if (u && overlay) overlay.src = u; });
        map.el.querySelector('.lm-tiles')?.after(overlay);
      }
      overlay.hidden = false;
      placeOverlay();
    }
    function placeOverlay() {
      if (!overlay || !ovCorners || !map) return;
      const p = pg();
      const [a, b, c] = ovCorners.map(ll => map.project(ll.lat, ll.lng));
      if (!a || !b || !c) return;
      const pw = p.preview.w, ph = p.preview.h;
      overlay.style.width = `${pw}px`; overlay.style.height = `${ph}px`;
      overlay.style.transform = `matrix(${(b.x - a.x) / pw},${(b.y - a.y) / pw},${(c.x - a.x) / ph},${(c.y - a.y) / ph},${a.x},${a.y})`;
    }

    // ---- 동작 ----
    function addPoint(p) {
      draft = [...draft, { id: rid(), page, at: Date.now(), ...p }];
      dirty = true;
      redraw();
      const n = draft.length;
      toast(n === 1 ? '1번 기준점을 찍었어요. 멀리 떨어진 곳에서 하나 더' : `${n}번 기준점을 찍었어요`);
    }
    function removePoint(pid) {
      const i = draft.findIndex(p => p.id === pid);
      if (i < 0) return;
      const gone = draft[i];
      draft = draft.filter(p => p.id !== pid);
      dirty = true;
      redraw();
      snackbar(`${i + 1}번 기준점을 지웠어요`, { actionLabel: '되돌리기', onAction: () => { draft = [...draft.slice(0, i), gone, ...draft.slice(i)]; redraw(); } });
    }
    function focusPoint(p) {
      view?.engine()?.setView({ x: p.x, y: p.y }, null, { animate: true });
      map?.setView({ lat: p.lat, lng: p.lng }, null, { animate: true });
    }
    function pair() {
      const c = view?.center(), m = map?.center();
      if (!c || !m) { toast('도면과 지도가 뜰 때까지 잠시만요'); return; }
      const p = pg();
      if (c.x < 0 || c.y < 0 || c.x > p.w || c.y > p.h) { toast('도면 십자가 쪽 밖에 있어요'); return; }
      addPoint({ x: c.x, y: c.y, lat: m.lat, lng: m.lng, acc: G.MAP_ACC_M, how: 'map' });
    }
    // 현장: 5초 GPS 평균(정확도가 나쁘면 하늘이 보이는 곳 안내, 최대 20초)
    function startAvg() {
      if (avg) { stopAvg(); return; }
      const c = view?.center();
      if (!c) { toast('도면이 뜰 때까지 잠시만요'); return; }
      const fixes = [];
      const t0 = Date.now();
      const take = s => { const q = s?.pos; if (q && (!fixes.length || fixes[fixes.length - 1].at !== q.at)) fixes.push({ lat: q.lat, lng: q.lng, acc: q.acc, at: q.at || Date.now() }); };
      take(gps.snapshot());
      const off = gps.on(take);
      const tick = () => {
        if (!alive || !avg) return;
        const el = Date.now() - t0;
        const good = fixes.filter(f => !fin(f.acc) || f.acc <= SKY_ACC);
        const last = fixes[fixes.length - 1];
        const sec = Math.max(0, Math.ceil((AVG_MS - el) / 1000));
        const accT = last && fin(last.acc) ? ` · ±${G.fmtM(last.acc)}` : '';
        const sky = last && fin(last.acc) && last.acc > SKY_ACC;
        setText(avgBox, sky ? `하늘이 보이는 곳에서 해 주세요${accT}` : (fixes.length ? `그대로 서 계세요 · ${sec}초${accT}` : '위치 찾는 중…'));
        avgBox.style.setProperty('--p', String(Math.min(1, el / AVG_MS)));
        if (el >= AVG_MS && good.length >= 2) { finish(G.averageFixes(good)); return; }
        if (el >= AVG_MAX_MS) { finish(fixes.length ? G.averageFixes(fixes, { maxAcc: 80 }) : null); return; }
        avg.t = setTimeout(tick, 250);
      };
      const finish = r => {
        stopAvg();
        if (!r) { toast(gps.snapshot()?.state === 'denied' ? '위치 권한을 켜 주세요' : '위치를 못 잡았어요. 밖에서 다시 해 주세요'); return; }
        addPoint({ x: c.x, y: c.y, lat: r.lat, lng: r.lng, acc: Math.round(r.acc * 10) / 10, how: 'gps', n: r.n });
      };
      avg = { off, t: 0 };
      avgBox.hidden = false; hereBtn.textContent = '그만하기';
      tick();
    }
    function stopAvg() {
      if (!avg) return;
      clearTimeout(avg.t); avg.off?.();
      avg = null;
      avgBox.hidden = true; hereBtn.textContent = '여기 서 있어요 · 5초';
    }
    // auto: 뒤로 가며 저장 — 5초 [되돌리기](들어올 때 기준점으로)
    async function save({ auto = false } = {}) {
      const { T } = fitNow();
      if (!T || draft.length < 2) { toast('기준점을 2개 이상 찍어 주세요'); return; }
      try {
        const nd = await D.setGeoPoints(id, draft, { page });
        dirty = false;
        const text = `위치를 맞췄어요 · ${D.geoBadge(nd).text}`;
        if (auto) snackbar(text, { actionLabel: '되돌리기', onAction: () => D.setGeoPoints(id, before, { page }).catch(e => console.error('되돌리기 실패', e)) });
        else toast(text);
        nav.back();
      } catch (e) { console.error('위치 맞춤 저장 실패', e); toast('저장하지 못했어요'); }
    }

    // ---- 방법 바꾸기 ----
    function setMode(m) {
      mode = m === 'gps' ? 'gps' : 'map';
      lsSet(LS_MODE, mode);
      stopAvg();
      for (const b of [modeMap, modeGps]) b.setAttribute('aria-pressed', String(b.dataset.value === mode));
      stage.dataset.mode = mode;
      mapPane.hidden = mode !== 'map';
      pairBtn.hidden = mode !== 'map';
      hereBtn.hidden = mode !== 'gps';
      acts.dataset.mode = mode;
      if (mode === 'map') ensureMap(); else { map?.destroy(); map = null; overlay = null; ovCorners = null; }
      drawQuality();
    }
    function mapCenter() {
      const g = gps.snapshot()?.pos;
      if (draft.length) {
        const la = draft.reduce((s, p) => s + p.lat, 0) / draft.length, lo = draft.reduce((s, p) => s + p.lng, 0) / draft.length;
        return { lat: la, lng: lo };
      }
      return g ? { lat: g.lat, lng: g.lng } : DEFAULT_CENTER;
    }
    async function ensureMap() {
      if (map) return;
      try {
        const mod = await import('../widgets/livemap.js');
        if (!alive || map || mode !== 'map') return;
        map = mod.liveMap({ center: mapCenter(), zoom: 18, layer: 'Hybrid', key: vworld.key(), compass: false });
        mapHold.replaceChildren(map.el);
        map.onRender(placeOverlay);
        redraw();
      } catch (e) { console.error('지도를 불러오지 못했어요', e); setText(quality, '지도를 불러오지 못했어요 · 현장에서 맞추기를 써 주세요'); }
    }

    // ---- 시작 ----
    if (!d) { setText(quality, '도면을 찾을 수 없어요'); }
    else {
      view = drawingView({ drawingId: id, page, showPins: 'none', me: false });
      dwPane.prepend(view.el);
      view.ready().then(() => { if (alive) drawMarkers(); });
    }
    const stopGps = gps.start();
    keepAwake(true);
    setMode(mode);
    redraw();
    // 처음 지도 위치: GPS 를 늦게 잡으면 한 번만 옮긴다(기준점이 없을 때)
    let moved = false;
    offs.push(gps.on(s => { if (!moved && s?.pos && !draft.length && map) { moved = true; map.setView({ lat: s.pos.lat, lng: s.pos.lng }, 18, { animate: false }); } }));
    offs.push(D.onDrawings(ev => { if (ev.drawings.has(id)) { qKey = ''; setupOverlay(); drawQuality(); } }));

    return () => {
      alive = false;
      if (current === st) current = null;
      stopAvg();
      for (const f of offs) { try { f?.(); } catch { /* 무시 */ } }
      try { stopGps(); } catch { /* 무시 */ }
      keepAwake(false);
      view?.destroy(); map?.destroy();
    };
  },
  // 맞춘 초안(2점 이상, 변환이 됨)을 두고 뒤로 가면 저장하고 나간다(5초 [되돌리기]). 그 밖(1점·바뀐 것 없음)은 그냥 나간다
  onBack() {
    const c = current;
    if (!c || !c.dirty() || c.draft().length < 2 || !c.canSave()) return false;
    c.autoSave();
    return true;
  },
};
