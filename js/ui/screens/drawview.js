// 도면 보기 `drawview`(docs/도면보관함-설계.md §5.3·§5.4) — params { id, page?, pinId?, guideTo? }
// 도면을 지도처럼(widgets/drawingview.js): 이름 핀 · 위치 맞춘 도면이면 내 위치 파란 점·보는 방향 부채꼴·따라가기·방향 보기.
// 아래 엄지 줄: 위치 맞춘 도면 [따라가기] [방향 보기] [📍 핀 찍기(노랑)] [핀 목록] / 안 맞춘 도면 [위치 맞추기] [📍 핀 찍기] [핀 목록].
// 핀 탭 → 핀 시트: 이름 고치기 · [이 핀으로 길찾기](노랑) · 옮기기 · 메모 · 묶음 열기 · 지우기(5초 되돌리기).
// 길찾기 띠(dwv-guide): 「101동 3층 욕실 · 오른쪽으로 23m」 + 화살표, 도면 위 점선, 도착하면 「거의 다 왔어요」 + 짧은 진동 한 번.
// 가볍게: 위치·방향 알림은 drawingView 가 rAF 한 번에 모아 주는 meState 로만. 글은 바뀔 때만 DOM 에.
import { h, icon, toast, snackbar, openSheet, textSheet, choose, closeTopSheet } from '../dom.js';

// 핀 표지 — 「핀 3」(기본 이름) 또는 「3 101동 3층 욕실 핀」(번호가 두 번 나오지 않게 — 촬영 화면 pinLabel 과 같은 규칙)
const pinLabel = p => {
  const name = String(p?.name || '').trim();
  return !name || name === `핀 ${p?.no}` ? `핀 ${p?.no ?? ''}`.trim() : `${p.no != null ? `${p.no} ` : ''}${name} 핀`;
};
import { drawingView } from '../widgets/drawingview.js';
import * as D from '../../data/drawings.js';
import * as DT from '../../media/drawtiles.js';
import * as G from '../../core/georef.js';
import * as gps from '../../services/gps.js';
import * as heading from '../../services/heading.js';
import { keepAwake } from '../../platform/awake.js';
import { drawingMenu, baseName } from './drawings.js';
import { dayKey } from '../../core/date.js';

const SVGNS = 'http://www.w3.org/2000/svg';
const HINT_KEY = 'lite.dwv.geoHint';
const fin = Number.isFinite;
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 저장 못 해도 그만 */ } };
const setText = (el, t) => { if (el.textContent !== t) el.textContent = t; };
function pathIcon(ds, size = 24, extra = {}) {
  const s = document.createElementNS(SVGNS, 'svg');
  for (const [k, v] of Object.entries({ class: 'ic', viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false', ...extra })) s.setAttribute(k, v);
  for (const d of ds) { const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
}
const followIcon = () => pathIcon(['M12 2v3', 'M12 19v3', 'M2 12h3', 'M19 12h3', 'M12 7a5 5 0 1 1 0 10a5 5 0 1 1 0-10z', 'M12 10.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3z']);
const headIcon = () => pathIcon(['M12 3l5 16-5-3-5 3z']);
const listIcon = () => pathIcon(['M9 6h11', 'M9 12h11', 'M9 18h11', 'M4.5 6h.01', 'M4.5 12h.01', 'M4.5 18h.01']);
const geoIcon = () => pathIcon(['M3 7l6-3 6 3 6-3v13l-6 3-6-3-6 3z', 'M9 4v13', 'M15 7v13']);
const arrowIcon = () => pathIcon(['M12 3l7 17-7-4-7 4z'], 28, { class: 'ic dwv-arrow' });

// 첫 그림이 나간 뒤 한가할 때(없으면 0.4초 뒤)
const later = fn => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 800 }) : setTimeout(fn, 400));

export default {
  mount(root, params, nav) {
    root.classList.add('dwv');
    const id = params?.id;
    let alive = true;
    const offs = [];
    let view = null, guidePin = params?.guideTo || null, arrived = false, placing = null;   // placing: null | { kind:'new' } | { kind:'move', pinId }
    let headingUp = false, followOn = false;

    // ---- 바 ----
    const title = h('h1', { 'data-testid': 'dwv-title' });
    const pageBtn = h('button', { type: 'button', class: 'chip dwv-page', 'data-testid': 'dwv-page', hidden: true, onclick: () => pickPage() });
    const bar = h('header', { class: 'bar' },
      h('button', { type: 'button', class: 'icbtn', 'aria-label': '뒤로', onclick: () => nav.back() }, icon('back')),
      title, pageBtn,
      h('button', { type: 'button', class: 'icbtn', 'aria-label': '도면 메뉴', 'data-testid': 'dwv-menu', onclick: () => drawingMenu(id, nav, { inView: true }) }, icon('more')));

    // ---- 길찾기 띠·정보 줄 ----
    const gArrow = arrowIcon();
    const gName = h('span', { class: 'dwv-guide-n' }), gDir = h('span', { class: 'dwv-guide-d' });
    const gText = h('span', { class: 'dwv-guide-t' }, gName, gDir);     // 위: 핀 이름(작게) · 아래: 「오른쪽으로 23m」(크게) — 360 폭에서도 잘리지 않게
    const gEnd = h('button', { type: 'button', class: 'dwv-guide-end', 'data-testid': 'dwv-guide-end', text: '끝내기', onclick: () => setGuide(null) });
    const guideBand = h('div', { class: 'dwv-guide', 'data-testid': 'dwv-guide', role: 'status', 'aria-live': 'polite', hidden: true }, gArrow, gText, gEnd);
    const infoT = h('span', { class: 'dwv-info-t' });
    const infoBtn = h('button', { type: 'button', class: 'dwv-info-btn', hidden: true });
    const info = h('div', { class: 'dwv-info', 'data-testid': 'dwv-info', role: 'status' }, infoT, infoBtn);

    // ---- 도면 자리 ----
    const stage = h('div', { class: 'dwv-stage', 'data-testid': 'drawview' });

    // ---- 아래 엄지 줄 ----
    const btn = (testid, ic, label, onclick, cls = '') => {
      const t = h('span', { class: 'dwv-btn-t', text: label });
      const b = h('button', { type: 'button', class: ['dwv-btn', cls], 'data-testid': testid, onclick }, ic, t);
      b._t = t;
      return b;
    };
    const followBtn = btn('dwv-follow', followIcon(), '따라가기', () => toggleFollow());
    const headBtn = btn('dwv-heading', headIcon(), '방향 보기', () => toggleHeading());
    const geoBtn = btn('dwv-geo', geoIcon(), '위치 맞추기', () => nav.go('drawgeo', { id, page: view?.page() || 1 }));
    const pinsBtn = btn('dwv-pins', listIcon(), '핀 0', () => pinsSheet());
    const addBtn = h('button', { type: 'button', class: 'primary dwv-add', 'data-testid': 'dwv-pin-add', onclick: () => startPlace({ kind: 'new' }) }, icon('pin', 22), '핀 찍기');
    const dock = h('div', { class: ['dwv-dock', 'dock'] }, followBtn, headBtn, geoBtn, addBtn, pinsBtn);
    // [이 도면으로 찍기] — 도면 위 오른쪽 아래(엄지 자리, 보조). 촬영 화면에서 이 도면이 바로 뜬다(같은 자리면 도면 층 → [카메라] 1탭).
    //   촬영 화면에서 크게 보러 온 것이면 그냥 돌아간다(촬영 화면이 둘 쌓이지 않게)
    const camBtn = h('button', { type: 'button', class: 'dwv-cam', 'data-testid': 'dwv-capture', onclick: () => {
      if (params?.from === 'capture') { nav.back(); return; }
      nav.go('capture', { day: dayKey(Date.now()), drawingId: id, page: view?.page() || params?.page || 1 });
    } }, icon('camera', 22), h('span', { text: '이 도면으로 찍기' }));
    stage.append(camBtn);

    root.append(bar, guideBand, info, stage, dock);

    const d0 = () => D.drawing(id);
    const T = () => D.transformOf(id);
    const geoPage = () => d0()?.geo?.page;
    const isGeo = () => !!(T() && geoPage() === (view?.page() || 1));

    // ---- 그리기 ----
    function drawBar() {
      const d = d0();
      setText(title, d ? baseName(d) : '도면');
      const n = d?.pageCount || d?.pages?.length || 1;
      pageBtn.hidden = !(n > 1);
      if (n > 1) setText(pageBtn, `${view?.page() || 1}/${n}쪽`);
    }
    function drawDock() {
      const geo = isGeo();
      followBtn.hidden = !geo; headBtn.hidden = !geo; geoBtn.hidden = geo;
      dock.dataset.geo = geo ? '1' : '0';
      const n = D.pins(id, { page: view?.page() || 1 }).length;
      setText(pinsBtn._t, `핀 ${n}`);
      setText(followBtn._t, followOn ? '따라가는 중' : '따라가기');   // 지도 화면과 같은 말(64px 칸 — 13px 두 줄까지). 상태는 검정 바탕·aria-pressed 로도
      followBtn.classList.toggle('on', followOn); followBtn.setAttribute('aria-pressed', String(followOn));
      followBtn.setAttribute('aria-label', followOn ? '내 위치 따라가는 중. 눌러서 끄기' : (followOffByDrag ? '다시 따라가기' : '내 위치 따라가기'));
      setText(headBtn._t, headingUp ? '방향 보는 중' : '방향 보기');
      headBtn.setAttribute('aria-label', headingUp ? '보는 방향이 위. 눌러서 도면 그대로' : '보는 방향을 위로');
      headBtn.classList.toggle('on', headingUp); headBtn.setAttribute('aria-pressed', String(headingUp));
      dock.hidden = !!placing;
      camBtn.hidden = !!placing;
    }
    // 정보 줄: 위치 상태(한 줄, 무엇을 하면 되는지)
    let infoKind = '';
    function drawInfo() {
      let t = '', b = '', kind = '';
      const g = gps.snapshot() || {};
      if (placing) { t = placing.kind === 'move' ? '십자를 옮길 자리에 맞추고 [여기로]를 눌러요' : '도면을 끌어 십자를 찍을 자리에 맞춰요'; kind = 'place'; }
      else if (!d0()) { t = '도면을 찾을 수 없어요'; kind = 'missing'; }
      else if (!T()) {
        const first = !lsGet(HINT_KEY);
        t = first ? '위치를 맞추면 도면에 내 위치가 보여요' : '위치 안 맞춘 도면'; b = '맞추기'; kind = first ? 'hint' : 'nogeo';
      } else if (!isGeo()) { t = `위치는 ${geoPage()}쪽에 맞춰 있어요`; kind = 'otherpage'; }
      else if (g.state === 'denied') { t = '위치 권한을 켜 주세요'; b = '다시'; kind = 'denied'; }
      else if (g.state === 'off') { t = '휴대폰 위치(GPS)를 켜 주세요'; b = '다시'; kind = 'gpsoff'; }
      else {
        const m = view?.meState();
        if (!m) { t = '위치 찾는 중…'; kind = 'searching'; }
        else {
          const acc = fin(m.pos?.acc) ? ` · ±${G.fmtM(m.pos.acc)}` : '';
          t = m.outsideM > 0 ? `도면 밖 ${G.fmtM(m.outsideM)}${acc}` : `도면 안${acc}`;
          kind = m.outsideM > 0 ? 'outside' : 'inside';
        }
      }
      setText(infoT, t);
      infoBtn.hidden = !b; setText(infoBtn, b);
      if (infoKind !== kind) { infoKind = kind; info.dataset.kind = kind; }
    }
    infoBtn.addEventListener('click', () => {
      if (infoKind === 'hint' || infoKind === 'nogeo') { lsSet(HINT_KEY, '1'); nav.go('drawgeo', { id, page: view?.page() || 1 }); }
      else if (infoKind === 'denied' || infoKind === 'gpsoff') { Promise.resolve(gps.retry?.()).catch(() => {}); if (infoKind === 'denied') toast('안 되면 휴대폰 설정 > 앱 > 권한에서 위치를 켜 주세요', 4000); }
    });

    // ---- 따라가기·방향 보기 ----
    let followOffByDrag = false, selfFollow = false;
    function applyFollow() {
      if (!view) return;
      // 따라가기를 켜면 걸으며 보기 좋게 확대(맞춤 + 1.6) — 이미 더 크게 보고 있으면 그대로
      const map = view.engine(), m = view.meState();
      if (followOn && map && m && map.zoom() < (map.fitZoom?.() ?? 0) + 1) map.setView({ x: m.x, y: m.y }, (map.fitZoom?.() ?? 0) + 1.6, { animate: true });
      selfFollow = true;
      try { view.setFollow(followOn ? (headingUp ? 'heading' : 'pos') : false); } finally { selfFollow = false; }
      if (!headingUp) view.engine()?.setRotation(0);
    }
    function toggleFollow() {
      if (!view?.meState()) { toast(gps.snapshot()?.state === 'denied' ? '위치 권한을 켜 주세요' : '위치를 찾는 중이에요'); }
      followOn = !followOn; followOffByDrag = false;
      if (!followOn) headingUp = false;
      applyFollow(); drawDock();
    }
    function toggleHeading() {
      headingUp = !headingUp;
      if (headingUp) {
        if (heading.needsPermission?.()) heading.requestPermission?.().catch(() => {});
        followOn = true; followOffByDrag = false;
        if (!fin(heading.snapshot()?.heading)) toast('방향을 찾는 중이에요. 폰을 들고 천천히 돌려 보세요');
      }
      applyFollow(); drawDock();
    }

    // ---- 핀 찍기·옮기기 ----
    function startPlace(p) {
      if (!view?.engine()) { toast('도면 그림을 만드는 중이에요. 잠시만요'); return; }
      placing = p;
      if (p.kind === 'move') {
        const pin = D.pin(p.pinId);
        view.setMode('place', { label: '여기로', at: pin ? { x: pin.x, y: pin.y } : null });
      } else view.setMode('place', { label: '여기에 찍기' });
      followOn = false; applyFollow();
      drawDock(); drawInfo();
    }
    function endPlace() {
      placing = null;
      view?.setMode('view');
      drawDock(); drawInfo();
    }
    async function onPlace(x, y) {
      const p = placing;
      if (!p) return;
      const page = view.page();
      if (p.kind === 'move') {
        endPlace();
        try { await D.updatePin(p.pinId, { x, y, page }); toast('핀을 옮겼어요'); } catch (e) { console.error(e); toast('옮기지 못했어요'); }
        return;
      }
      endPlace();
      // 이름 시트는 탭 안에서 바로(키보드가 뜨게) — 핀은 그 사이 뒤에서 저장(1~2ms)
      const d = d0();
      const no = D.nextPinNo(D.pins(id).concat(D.pins(id, { deleted: true })), d?.pinSeq);
      const pinP = D.addPin({ drawingId: id, page, x, y });
      const nameP = textSheet({ title: '핀 이름', value: '', placeholder: `핀 ${no}`, okLabel: '확인', cancelLabel: '이름 없이' });   // [취소]가 찍기 취소처럼 읽히지 않게
      let pin;
      try { pin = await pinP; } catch (e) { console.error('핀을 못 찍었어요', e); toast('핀을 못 찍었어요'); closeTopSheet(); return; }
      view.setHighlight(pin.id);
      const name = await nameP;
      if (name != null && name.trim()) { try { pin = await D.updatePin(pin.id, { name }); } catch (e) { console.error(e); } }
      toast(`${pinLabel(pin)}을 찍었어요`);
    }

    // ---- 핀 시트 ----
    function pinSheet(pinId) {
      const p0 = D.pin(pinId);
      if (!p0) return;
      view?.setHighlight(pinId);
      openSheet(close => {
        const p = D.pin(pinId) || p0;
        const d = d0();
        const geo = isGeo();
        const me = view?.meState();
        const g = geo && me?.pos ? G.guide({ ...me.pos, heading: me.heading }, p, T()) : null;
        const nameBtn = h('button', { type: 'button', class: 'pin-name', 'data-testid': 'pin-name', 'aria-label': `핀 이름 ${p.name}, 눌러서 고치기` },
          h('span', { class: 'pin-no', text: String(p.no) }), h('span', { class: 'pin-name-t', text: p.name }), icon('edit', 20));
        nameBtn.addEventListener('click', () => {
          close();
          textSheet({ title: '핀 이름', value: p.name, okLabel: '저장' }).then(async v => {
            if (v == null) return;
            try { await D.updatePin(pinId, { name: v }); toast('이름을 고쳤어요'); } catch (e) { console.error(e); toast('고치지 못했어요'); }
          });
        });
        const sub = h('p', { class: 'pin-sub' }, `${d ? baseName(d) : ''} · ${p.page}쪽`, g ? ` · 여기서 ${g.text}` : '');
        const note = p.note ? h('p', { class: 'pin-note-t', text: p.note }) : null;
        const guideB = geo ? h('button', { type: 'button', class: 'primary', 'data-testid': 'pin-guide', onclick: () => { close(); setGuide(pinId); } }, pathIcon(['M5 12h14', 'M13 6l6 6-6 6'], 22), '이 핀으로 길찾기') : null;
        const rec = p.recordId ? recordLabel(p.recordId) : null;
        const recB = p.recordId ? h('button', { type: 'button', class: 'secondary', 'data-testid': 'pin-record', onclick: () => { close(); nav.go('record', { id: p.recordId }); } }, icon('image', 20), rec || '묶음 열기') : null;
        const moveB = h('button', { type: 'button', class: 'secondary', 'data-testid': 'pin-move', onclick: () => { close(); startPlace({ kind: 'move', pinId }); } }, '옮기기');
        const noteB = h('button', { type: 'button', class: 'secondary', 'data-testid': 'pin-note', onclick: () => {
          close();
          textSheet({ title: '메모', value: p.note || '', multiline: true, okLabel: '저장', draftKey: `pinnote:${pinId}` }).then(async v => {
            if (v == null) return;
            try { await D.updatePin(pinId, { note: v }); toast('메모를 저장했어요'); } catch (e) { console.error(e); toast('저장하지 못했어요'); }
          });
        } }, '메모');
        const delB = h('button', { type: 'button', class: 'secondary pin-del', 'data-testid': 'pin-delete', onclick: async () => {
          close();
          if (guidePin === pinId) setGuide(null);
          try {
            await D.deletePin(pinId);
            snackbar(`${pinLabel(p)}을 지웠어요`, { actionLabel: '되돌리기', onAction: () => D.restorePin(pinId) });
          } catch (e) { console.error(e); toast('지우지 못했어요'); }
        } }, icon('trash', 20), '지우기');
        return h('div', { class: 'sheet-body pin-sheet', 'data-testid': 'pin-sheet', 'data-id': pinId },
          nameBtn, sub, note, guideB, recB, h('div', { class: 'btnrow' }, moveB, noteB), delB);
      }, { label: '핀', onClose: () => { if (!guidePin || guidePin !== pinId) view?.setHighlight(guidePin || null); } });
    }
    // 연결된 묶음 이름(있으면) — store 는 동적으로(없어도 시트는 뜬다)
    let storeMod = null;
    import('../../data/store.js').then(m => { storeMod = m; }).catch(() => {});
    function recordLabel(rid) {
      try {
        const r = storeMod?.record?.(rid);
        if (!r) return '묶음 열기';
        const n = storeMod.photosOf?.(rid)?.length ?? 0;
        return `묶음 ${r.no || ''} · 사진 ${n}장`;
      } catch { return '묶음 열기'; }
    }

    // ---- 핀 목록 ----
    function pinsSheet() {
      const page = view?.page() || 1;
      const list = D.pins(id, { page });
      if (!list.length) { toast('아직 핀이 없어요. [핀 찍기]로 찍어요'); return; }
      const me = isGeo() ? view?.meState() : null;
      openSheet(close => {
        const rows = h('div', { class: 'rows dwv-pinlist' });
        const items = list.map(p => {
          const g = me?.pos ? G.guide({ ...me.pos, heading: me.heading }, p, T()) : null;
          return { p, g };
        });
        if (me?.pos) items.sort((a, b) => (a.g?.distanceM ?? 1e9) - (b.g?.distanceM ?? 1e9));
        for (const { p, g } of items) {
          rows.append(h('button', { type: 'button', class: 'row', 'data-testid': 'dwv-pins-row', 'data-id': p.id, onclick: () => { close(); view?.focusPin(p.id); pinSheet(p.id); } },
            h('span', { class: 'pin-no', text: String(p.no) }),
            h('span', { class: 'body' }, h('span', { class: 't', text: p.name }), g ? h('span', { class: 's', text: g.arrived ? '여기예요' : g.text }) : null),
            icon('chev', 20)));
        }
        return h('div', { class: 'sheet-body' }, h('h2', { class: 'sheet-title', text: `핀 ${list.length}개` }), rows);
      }, { label: '핀 목록' });
    }

    // ---- 길찾기 ----
    let gKey = '';
    function setGuide(pinId) {
      guidePin = pinId || null;
      arrived = false; gKey = '';
      view?.setRoute(guidePin);
      view?.setHighlight(guidePin);
      guideBand.hidden = !guidePin;
      if (guidePin) { followOn = true; followOffByDrag = false; applyFollow(); }
      drawGuide(); drawDock();
    }
    function drawGuide() {
      if (!guidePin) return;
      const p = D.pin(guidePin);
      if (!p || p.deletedAt) { setGuide(null); return; }
      const me = view?.meState();
      const tf = T();
      let text, rot = null, kind;
      if (!tf || !isGeo()) { text = '위치를 맞추면 길을 알려 줘요'; kind = 'nogeo'; }
      else if (!me?.pos) { text = '위치 찾는 중…'; kind = 'wait'; }
      else {
        const g = G.guide({ ...me.pos, heading: me.heading }, p, tf);
        if (!g) { text = '위치 찾는 중…'; kind = 'wait'; }
        else if (g.arrived) {
          text = '거의 다 왔어요'; kind = 'arrived';
          if (!arrived) { arrived = true; try { navigator.vibrate?.(120); } catch { /* 진동 없음 */ } }
        } else {
          text = g.turnText || g.text; kind = 'go';
          if (arrived && g.distanceM > g.errM + 10) arrived = false;
          // 화살표: 도면 위 방향 - 지금 도면 회전(화면에서 가리키는 쪽)
          const map = view.engine();
          if (fin(g.angleOnDrawing)) rot = Math.round(g.angleOnDrawing - (map?.rotation?.() || 0));
        }
      }
      const key = `${p.name}|${text}|${rot}|${kind}`;
      if (key === gKey) return;
      gKey = key;
      setText(gName, `${p.no} ${p.name}`);
      setText(gDir, text);
      guideBand.setAttribute('aria-label', `${p.name} · ${text}`);
      guideBand.dataset.kind = kind;
      gArrow.style.display = rot == null ? 'none' : '';
      if (rot != null) gArrow.style.transform = `rotate(${rot}deg)`;
    }

    // ---- 쪽 고르기(여러 쪽 PDF) ----
    async function pickPage() {
      const d = d0();
      const n = d?.pageCount || d?.pages?.length || 1;
      const cur = view?.page() || 1;
      const v = await choose({ title: '쪽 고르기', value: cur, options: Array.from({ length: n }, (_, i) => ({ value: i + 1, label: `${i + 1}쪽`, sub: D.pageOf(id, i + 1)?.tiles?.ready ? `핀 ${D.pins(id, { page: i + 1 }).length}` : '그림을 아직 안 만들었어요' })) });
      if (!v || v === cur) return;
      setGuide(null);
      view?.setPage(v);
      drawBar(); drawDock(); drawInfo();
    }

    // ---- 만들기 ----
    function build() {
      const d = d0();
      if (!d) { setText(title, '도면'); drawInfo(); return; }
      view?.destroy();
      view = drawingView({
        drawingId: id, page: params?.page || 0, me: true,
        highlight: params?.pinId || guidePin || null,
        onPlace, onCancel: () => endPlace(),
        onTapPin: pid => { if (!placing) pinSheet(pid); },
      });
      stage.replaceChildren(view.el, camBtn);
      offs.push(view.onMe(() => { drawInfo(); drawGuide(); }));
      offs.push(view.onFollow(m => {
        if (selfFollow) return;
        if (!m && followOn) { followOn = false; followOffByDrag = true; if (headingUp) headingUp = false; drawDock(); }
      }));
      if (params?.pinId) setTimeout(() => { if (alive) view?.focusPin(params.pinId); }, 0);
      if (guidePin) setGuide(guidePin);
    }

    D.ready().then(() => {
      if (!alive) return;
      build();
      drawBar(); drawDock(); drawInfo();
      // 첫 그림 뒤로 미룬다(도면 빨리 띄우기): 「최근 연 것」 기록(DB 쓰기 → 알림 → 다시 그리기)·남은 그림 이어 만들기·최근 도면 데우기
      later(() => {
        if (!alive) return;
        D.markOpened(id).catch(() => {});
        DT.resumePending().catch(() => {});
      });
    }, e => { console.error('도면보관함을 열지 못했어요', e); setText(infoT, '도면보관함을 열지 못했어요'); });
    offs.push(D.onDrawings(ev => {
      if (!alive) return;
      if (ev.drawings.has(id)) {
        if (!d0() || d0().deletedAt) { nav.back(); return; }
        drawBar(); drawDock(); drawInfo();
      }
      if (ev.pins.size) { drawDock(); drawGuide(); }
    }));
    offs.push(gps.on(() => drawInfo()));
    keepAwake(true);

    return () => {
      alive = false;
      for (const f of offs) { try { f?.(); } catch { /* 무시 */ } }
      view?.destroy(); view = null;
      keepAwake(false);
    };
  },
  // 뒤로: 핀 찍는 중이면 찍기만 끝낸다
  onBack() {
    const el = document.querySelector('.dwvw[data-mode="place"] [data-testid="dwv-place-cancel"]');
    if (el) { el.click(); return true; }
    return false;
  },
};
