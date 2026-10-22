// 날짜 화면 `day`(설계서 §6.2) — params { day }
// v0.1.5: 앱에는 더 등록하지 않는다(router 가 'day' 를 홈 { day } 로 돌린다 — 홈이 가로로 밀어 날짜를 넘긴다).
//   이 파일은 datePicker·locGroups·locRow(홈·내보내기 탭이 씀)를 내보내는 곳으로 남는다.
// 기록이 없는 날짜도 연다(review-notes 10: 홈 [다른 날짜 열기] → 이 화면 → [이 날짜에 사진 추가]).
// ◀ ▶ 는 기록 있는 이전/다음 날로, 가운데 달력 버튼은 아무 날짜로. 목록은 오래된 것이 위(사진대지 순서).
// '오늘 위치도'(day-locmap, docs/도면보관함-설계.md §5.7): 그 날 묶음들의 핀을 도면·쪽별로 묶어 작은 미리보기(그림 한 장 + 점) + 핀 수 → drawview.
//   도면보관함 모듈이 없거나 그 날 핀이 없으면 구역째 숨긴다. 미리보기는 도면의 미리보기 한 장(previewSrc)만 — 타일·뷰어를 띄우지 않는다(가볍게).
import * as dom from '../dom.js';
import * as store from '../../data/store.js';
import * as rowW from '../widgets/recordrow.js';
import { dayKey, dayLabel, dayStart, mdw, isToday } from '../../core/date.js';
import { pickImages, addFromGallery, galleryToast, drawingsMod, dayPinList, dropExt } from './record.js';

const { h, icon } = dom;
const toast = (t, ms) => dom.toast?.(t, ms);
const cnt = v => (typeof v === 'number' ? v : (v?.length ?? 0));
const validDay = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
// 줄이 보이는 값(같으면 줄을 다시 만들지 않는다). 계산할 수 없으면 NaN — 늘 다시 만든다
const rowSig = r => (typeof rowW.recordRowSig === 'function' ? rowW.recordRowSig(r) : NaN);

// 위치도 줄 — 미리보기 칸(고정 104×78)에 그림을 비율대로 맞추고 핀 자리에 점. 칸 크기가 정해져 있어 배치를 읽지 않는다
const TH_W = 104, TH_H = 78;
// 그 날 핀 → 도면·쪽별 묶음 [{ key, drawing, page, pg, pins: [{ p, r }] }] (처음 찍은 핀 순)
export function locGroups(M, recs) {
  const map = new Map();
  for (const it of dayPinList(M, recs)) {
    const key = `${it.p.drawingId}:${it.p.page}`;
    let g = map.get(key);
    if (!g) { const d = M.drawing(it.p.drawingId); if (!d) continue; g = { key, drawing: d, page: it.p.page, pg: M.pageOf?.(d.id, it.p.page) || null, pins: [] }; map.set(key, g); }
    g.pins.push(it);
  }
  const list = [...map.values()];
  for (const g of list) g.pins.sort((a, b) => a.p.createdAt - b.p.createdAt);
  return list.sort((a, b) => a.pins[0].p.createdAt - b.pins[0].p.createdAt);
}
const groupSig = g => `${g.drawing.name}|${g.drawing.pages?.length}|${g.pg?.w}x${g.pg?.h}|${g.pg?.preview ? 1 : 0}|${g.pins.map(({ p }) => `${p.id}:${p.x},${p.y}`).join(';')}`;

export function locRow(g, M, nav) {
  const th = h('span', { class: 'day-loc-th', 'aria-hidden': 'true' }, icon('drawing', 28));
  const pages = g.drawing.pages?.length || 0;
  const sub = [`핀 ${g.pins.length}개`, pages > 1 ? `${g.page}쪽` : null, g.pins.slice(0, 2).map(({ p }) => p.name).filter(Boolean).join(', ')].filter(Boolean).join(' · ');
  const row = h('button', { type: 'button', class: 'day-loc-row', 'data-testid': 'day-locmap-row', 'data-id': g.drawing.id,
    on: { click: () => nav.go('drawview', { id: g.drawing.id, page: g.page }) } },
  th, h('span', { class: 'day-loc-t' }, h('b', { text: dropExt(g.drawing.name) }), h('small', { text: sub })), icon('chev', 20));
  const pg = g.pg;
  if (pg?.w && pg?.h) {
    Promise.resolve(M.previewSrc?.(g.drawing.id, g.page)).then(src => {
      if (!src) return;
      const k = Math.min(TH_W / pg.w, TH_H / pg.h), w = Math.round(pg.w * k), hh = Math.round(pg.h * k);
      const img = h('img', { class: 'day-loc-img', alt: '', draggable: 'false', decoding: 'async', src, style: { width: `${w}px`, height: `${hh}px` } });
      const fit = h('span', { class: 'day-loc-fit', style: { width: `${w}px`, height: `${hh}px` } }, img,
        ...g.pins.map(({ p }) => h('i', { class: 'day-loc-dot', style: { left: `${((p.x / pg.w) * 100).toFixed(2)}%`, top: `${((p.y / pg.h) * 100).toFixed(2)}%` } })));
      img.addEventListener('load', () => th.replaceChildren(fit), { once: true });
    }).catch(() => { /* 그림이 아직 없으면 아이콘 그대로 */ });
  }
  return row;
}

// 숨은 날짜 입력칸 → 고르면 fn(day). 미래 날짜는 막는다
export function datePicker(onPick) {
  const inp = h('input', { type: 'date', class: 'f-date-input', 'aria-label': '날짜 고르기', tabindex: '-1' });
  inp.addEventListener('change', () => {
    const v = inp.value;
    inp.value = '';
    if (!validDay(v)) return;
    if (v > dayKey(Date.now())) { toast('앞으로 올 날짜는 열 수 없어요'); return; }
    onPick(v);
  });
  const open = () => {
    inp.max = dayKey(Date.now());
    try { if (typeof inp.showPicker === 'function') { inp.showPicker(); return; } } catch { /* 아래로 */ }
    inp.focus(); inp.click();
  };
  return { el: inp, open };
}

export default {
  mount(root, params, nav) {
    const now0 = Date.now();
    const day = validDay(params?.day) ? params.day : dayKey(now0);
    let dead = false, queued = false;

    const bar = h('div', { class: 'bar' },
      h('button', { type: 'button', class: 'icbtn', 'aria-label': '뒤로', on: { click: () => nav.back() } }, icon('back')),
      h('h1', { text: dayLabel(day) }),
      h('button', { type: 'button', class: 'barlink', 'data-testid': 'day-export', on: { click: () => nav.go('exporthub', { day }) } }, '내보내기'));

    const pick = datePicker(d => { if (d !== day) nav.replace('day', { day: d }); });
    const prevBtn = h('button', { type: 'button', class: 'day-nav-btn prev', 'data-testid': 'day-prev' });
    const nextBtn = h('button', { type: 'button', class: 'day-nav-btn next', 'data-testid': 'day-next' });
    const calBtn = h('button', { type: 'button', class: 'day-nav-cal', 'aria-label': '다른 날짜 고르기', on: { click: () => pick.open() } }, icon('cal'), h('span', { text: '날짜 고르기' }));
    const dnav = h('div', { class: 'day-nav' }, prevBtn, calBtn, nextBtn, pick.el);

    const sum = h('p', { class: 'day-sum', 'data-testid': 'day-sum' });
    const locList = h('div', { class: 'day-loc-list' });
    const locSec = h('section', { class: 'day-loc', 'data-testid': 'day-locmap', 'aria-label': '위치도' },
      h('h2', { class: 'day-loc-h', text: isToday(day, now0) ? '오늘 위치도' : '이 날 위치도' }), locList);
    locSec.hidden = true;
    let M = null, offDwg = null;
    const list = h('div', { class: ['rows', 'day-list'], 'data-testid': 'day-list' });
    const empty = h('p', { class: 'day-empty' });

    const today = isToday(day, now0);
    let dockBtn;
    if (today) {
      const sub = h('span', { class: 'start-sub' });
      dockBtn = h('button', { type: 'button', class: 'start', 'data-testid': 'start-btn', on: { click: () => nav.go('capture', { day }) } },
        h('b', { text: '기록 시작' }), sub);
      dockBtn._sub = sub;
    } else {
      dockBtn = h('button', { type: 'button', class: 'primary day-add', 'data-testid': 'day-add' }, icon('image'), h('span', { text: '이 날짜에 사진 추가' }));
      const run = async () => {
        const files = await pickImages({ multiple: true });
        if (!files.length || dead) return;
        let rec = null;
        try {
          rec = await store.createRecord({ day, now: Date.now() });     // 묶음을 먼저 저장(§4.5), 위치는 비워 둔다(지난 날짜는 이어받지 않음)
          const res = await addFromGallery(rec.id, files);
          if (!res.ok) {
            await store.purgeRecord?.(rec.id);
            toast('사진을 넣지 못했어요. 다른 사진으로 해 주세요');
            return;
          }
          galleryToast(res);
          if (!dead) nav.go('record', { id: rec.id });
        } catch (e) {
          console.error('이 날짜에 사진 추가 실패', e);
          toast(e?.code === 'QUOTA' ? '저장 공간이 모자라요' : '사진을 넣지 못했어요');
        }
      };
      if (typeof dom.lockButton === 'function') dom.lockButton(dockBtn, run); else dockBtn.addEventListener('click', run);
    }
    const dock = h('div', { class: 'dock day-dock' }, dockBtn);

    root.classList.add('day-scr');
    root.append(bar, dnav, sum, locSec, list, empty, dock);

    function neighbors() {
      const all = (store.days?.() || []).map(d => d.day).filter(d => d !== day);   // 내림차순
      const t = dayKey(Date.now());
      let prev = null, next = null;
      for (const d of all) { if (d < day && (!prev || d > prev)) prev = d; if (d > day && (!next || d < next)) next = d; }
      if (!next && day < t) next = t;                                             // 오늘은 기록이 없어도 갈 수 있게
      return { prev, next };
    }
    function navBtn(btn, target, dir) {
      btn.replaceChildren();
      if (dir < 0) btn.append(icon('left'), h('span', { text: target ? mdw(dayStart(target)) : '이전 없음' }));
      else btn.append(h('span', { text: target ? (isToday(target) ? '오늘' : mdw(dayStart(target))) : '다음 없음' }), icon('right'));
      btn.disabled = !target;
      btn.setAttribute('aria-label', target ? `${dir < 0 ? '이전' : '다음'} 기록 날짜 ${dayLabel(target)}` : (dir < 0 ? '이전 기록 없음' : '다음 기록 없음'));
      btn.onclick = target ? () => nav.replace('day', { day: target }) : null;
    }

    function render() {
      queued = false;
      if (dead) return;
      const recs = store.recordsOfDay(day) || [];                 // createdAt 오름차순(오래된 것 위)
      let photos = 0;
      for (const r of recs) photos += cnt(store.photosOf(r.id));
      sum.textContent = `묶음 ${recs.length} · 사진 ${photos}`;
      dom.syncList(list, recs, { key: r => r.id, sig: rowSig, make: r => rowW.recordRow(r, { onOpen: x => nav.go('record', { id: (x && x.id) || r.id }) }) });   // 바뀐 줄만
      empty.hidden = !!recs.length;
      empty.textContent = today ? '아직 기록이 없어요. 아래 [기록 시작]을 눌러요.' : '이 날짜엔 기록이 없어요. 아래 [이 날짜에 사진 추가]로 넣어요.';
      renderLoc(recs);
      const { prev, next } = neighbors();
      navBtn(prevBtn, prev, -1); navBtn(nextBtn, next, 1);
      if (dockBtn._sub) {
        const last = (store.lastLocation?.() || '').trim();
        dockBtn._sub.textContent = last ? `이어서: ${last}` : '위치는 찍으면서 적어요';
      }
    }
    function renderLoc(recs) {
      if (!M) { locSec.hidden = true; return; }
      let groups = [];
      try { groups = locGroups(M, recs); } catch (e) { console.warn('위치도 묶기 실패', e); }
      locSec.hidden = !groups.length;
      dom.syncList(locList, groups, { key: g => g.key, sig: groupSig, make: g => locRow(g, M, nav) });
    }
    const schedule = typeof dom.deferWhileTyping === 'function' ? dom.deferWhileTyping(render) : () => { if (!queued) { queued = true; queueMicrotask(render); } };   // 글 입력 중이면 끝난 뒤 한 번
    const off = store.on(ch => { if (ch?.records?.size || ch?.photos?.size || ch?.settings || ch?.meta?.has?.('lastLocation')) schedule(); });
    render();

    // 도면보관함(별도 DB)은 첫 그림 뒤에 — 없으면 위치도 구역만 빠진다
    drawingsMod().then(m => {
      if (dead || !m) return;
      M = m;
      try { offDwg = m.onDrawings?.(() => { if (!dead) schedule(); }); } catch { /* 무시 */ }
      renderLoc(store.recordsOfDay(day) || []);
    });

    return () => { dead = true; schedule.cancel?.(); off?.(); offDwg?.(); dock.remove(); };
  }
};
