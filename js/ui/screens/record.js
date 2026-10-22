// 묶음 상세 `record`(설계서 §6.3) — params { id }
// 위치·내용 고치기(자유 입력 시트), 정보 줄, 사진 격자(4:3, 2열 기본·많으면 3열) → 크게 보기,
// [사진 더 찍기]·[갤러리에서 추가]·[묶음 삭제](소프트 삭제 + 5초 되돌리기).
// 도면 위치(rec-pin, docs/도면보관함-설계.md §5.7): 핀이 있으면 미니 위치도(이 핀 진하게, 그 날 같은 도면의 다른 핀은 흐리게) + 핀 이름 고치기
//   + [도면에서 보기](drawview { id, pinId }) + [핀 지우기](5초 되돌리기). 핀이 없으면 [도면에 위치 찍기](도면 고르기 → 찍기 시트).
//   핀은 도면보관함(data/drawings.js) 한 곳에만 있고, 묶음에는 record.pin = { drawingId, pinId } 만. 도면 모듈·위젯이 없으면 이 칸은 조용히 빠진다.
// 위치를 여기서 고쳐도 lastLocation 은 바꾸지 않는다(이어받기는 촬영 화면에서만).
import * as dom from '../dom.js';
import * as store from '../../data/store.js';
import * as pipeline from '../../media/pipeline.js';
import * as thumbW from '../widgets/thumb.js';
import { dayLabel, hm, dayKey } from '../../core/date.js';
import * as geo from '../../core/geo.js';

const { h, icon } = dom;
const toast = (t, ms) => dom.toast?.(t, ms);

// 파일 고르기 — dom.pickFiles 가 있으면 그것(입력칸은 body 에 1개), 없으면 같은 방식으로 직접
export function pickImages({ multiple = true } = {}) {
  if (typeof dom.pickFiles === 'function') return Promise.resolve(dom.pickFiles({ multiple, accept: 'image/*' })).then(f => [...(f || [])]);
  return new Promise(resolve => {
    document.querySelectorAll('input[data-f-pick]').forEach(x => x.remove());
    const inp = h('input', { type: 'file', accept: 'image/*', 'data-f-pick': '1', 'aria-hidden': 'true', style: { position: 'fixed', left: '-9999px', top: '0', opacity: '0' } });
    inp.multiple = multiple;
    let done = false;
    const end = files => { if (done) return; done = true; inp.remove(); resolve(files); };
    inp.addEventListener('change', () => end([...(inp.files || [])]));
    inp.addEventListener('cancel', () => end([]));
    document.body.append(inp);
    inp.click();
  });
}

// 갤러리 사진을 묶음에 넣는다 → { ok, failed }
export async function addFromGallery(recordId, files) {
  if (!files?.length) return { ok: 0, failed: 0 };
  const r = await pipeline.ingestFiles(recordId, files, { source: 'gallery' });
  const ok = typeof r?.ok === 'number' ? r.ok : (r?.ok?.length ?? 0);
  const failed = typeof r?.failed === 'number' ? r.failed : (r?.failed?.length ?? 0);
  return { ok, failed };
}

export function galleryToast({ ok, failed }) {
  if (!ok && !failed) return;
  toast(failed ? `사진 ${ok}장을 넣었어요 · ${failed}장은 못 넣었어요` : `사진 ${ok}장을 넣었어요`);
}

function cell(p, i, recordId, nav) {
  const ready = !p.state || p.state === 'ready';
  const inner = ready
    ? thumbW.thumb(p.id, { className: 'rec-img' })
    : h('span', { class: ['rec-ph', p.state === 'failed' ? 'fail' : ''], text: p.state === 'failed' ? '처리 실패' : '처리 중…' });
  return h('button', {
    type: 'button', class: 'rec-cell', 'data-testid': 'rec-photo', 'data-id': p.id, 'aria-label': `사진 ${i + 1} 크게 보기`,
    on: { click: () => nav.go('viewer', { recordId, photoId: p.id }) }
  }, inner, h('span', { class: 'rec-no', text: String(i + 1) }));
}

// ---------- 도면 위치(도면보관함 연결) — 날짜 화면도 같이 쓴다 ----------
// 모듈은 처음 쓸 때 한 번만 불러온다(없으면 null — 화면은 그 칸만 빼고 돈다)
let dwgP = null, dvP = null, pmP = null, pickP = null;
export function drawingsMod() {
  return (dwgP ||= import('../../data/drawings.js').then(async m => { await m.ready?.(); return m; })
    .catch(e => { console.warn('도면보관함을 열지 못했다', e); dwgP = null; return null; }));
}
const dvMod = () => (dvP ||= import('../widgets/drawingview.js').catch(e => { console.warn('도면 보기 위젯 없음(미리보기 한 장으로)', e?.message || e); return null; }));
const pmMod = () => (pmP ||= import('../widgets/pinmap.js').catch(() => null));
const pickMod = () => (pickP ||= import('../widgets/drawpicker.js').catch(() => null));
const live = (M, p) => !!p && !p.deletedAt && !!M.drawing(p.drawingId) && !M.drawing(p.drawingId).deletedAt;

// 묶음의 핀: record.pin 이 가리키는 핀 → 없으면 그 묶음에 연결된 첫 핀(record.pin 을 아직 안 쓰는 판과도 맞게)
export function pinOfRecord(M, r) {
  if (!M || !r) return null;
  const ref = r.pin && typeof r.pin === 'object' ? r.pin : null;
  const p = ref?.pinId ? M.pin?.(ref.pinId) : null;
  if (live(M, p)) return p;
  return (M.pinsOfRecord?.(r.id) || [])[0] || null;
}
// 그 날 묶음들의 핀(지운 묶음·지운 도면 빼고) — [{ p, r }]
export function dayPinList(M, recs) {
  const out = [];
  if (!M) return out;
  for (const r of recs || []) for (const p of M.pinsOfRecord?.(r.id) || []) out.push({ p, r });
  return out;
}
export const dropExt = n => String(n || '').replace(/\.[A-Za-z0-9]{1,10}$/, '');

// 미니 위치도를 box 에 단다 → 위젯({ destroy() }) | null.  drawingView(타일 지도, 계약)가 있으면 그것, 없으면 미리보기 한 장 + pinMap.
//   pins = [{ id, x, y(쪽 그림 픽셀), no, active, dim }]  — pinMap 폴백에서만 쓴다(drawingView 는 스스로 핀을 읽는다)
export async function mountMini(box, M, { drawingId, page = 1, pins = [], highlight = null, showPins = 'all', mode = 'view', onPlace = null, onCancel = null, placeLabel = '', isDead = () => false } = {}) {
  const msg = t => box.replaceChildren(h('p', { class: 'rec-pin-msg', text: t }));
  const dv = await dvMod();
  if (isDead()) return null;
  if (typeof dv?.drawingView === 'function') {
    try {
      // 미니(view)는 핀을 가운데에 두되 도면 전체가 거의 보이게 조금만 확대(fitOffset 0.5) — 「도면의 어디쯤」이 한눈에
      const v = dv.drawingView({ drawingId, page, mode, me: mode === 'place', highlight, showPins, compact: mode === 'view', fitOffset: mode === 'view' ? 0.5 : undefined,
        onPlace: onPlace || undefined, onCancel: onCancel || undefined });   // placeLabel(번호)은 pinMap 용 — 위젯의 placeLabel 은 단추 글이라 넘기지 않는다
      box.dataset.kind = 'dv';                                 // 도면 보기 위젯: 찍기는 [여기에 찍기] 한 번으로 끝(부르는 쪽이 닫는다)
      box.replaceChildren(v.el);
      return v;
    } catch (e) { console.warn('도면 보기 위젯을 못 띄웠다 — 미리보기 한 장으로', e); }
  }
  const pg = M.pageOf?.(drawingId, page);
  let src = null;
  try { src = await M.previewSrc?.(drawingId, page); } catch { src = null; }
  const pm = await pmMod();
  if (isDead()) return null;
  if (typeof pm?.pinMap !== 'function' || !src || !pg?.w || !pg?.h) { msg('도면 그림을 만드는 중이에요. 잠시 뒤 다시 열어 보세요'); return null; }
  const pv = pg.preview || { w: pg.w, h: pg.h };
  const v = pm.pinMap({
    src, w: pv.w, h: pv.h, mode, gestures: mode === 'place', controls: mode === 'place', placeLabel,
    pins: pins.map(q => ({ id: q.id, x: q.x / pg.w, y: q.y / pg.h, label: q.no ? String(q.no) : '', active: !!q.active, dim: q.dim })),
    onPlace: onPlace ? (fx, fy) => onPlace(fx * pg.w, fy * pg.h) : undefined,
  });
  box.dataset.kind = 'pm';                                   // 미리보기 한 장: 누르면 바로 찍히고 끌어서 옮긴다(부르는 쪽 [완료]로 닫음)
  box.replaceChildren(v.el);
  return v;
}

// 도면 고르기 — widgets/drawpicker.js(계약)가 있으면 그것, 없으면 하나뿐이면 그것·여럿이면 목록 시트
export async function chooseDrawing(M, { title = '어느 도면에 찍을까요?', current = null } = {}) {
  const pk = await pickMod();
  if (typeof pk?.pickDrawing === 'function') return pk.pickDrawing({ title, current });
  const list = M.drawings?.() || [];
  if (!list.length) return null;
  if (list.length === 1) return list[0].id;
  return dom.choose({ title, value: current, options: list.map(d => ({ value: d.id, label: d.name, sub: M.geoBadge?.(d)?.text || '' })) });
}

function firstGps(photos) {
  for (const p of photos) if (p.gps && Number.isFinite(p.gps.lat)) return p.gps;
  return null;
}

export default {
  mount(root, params, nav) {
    const id = params?.id;
    let dead = false, deleting = false, queued = false;

    const title = h('h1', { text: '묶음' });
    const shareBtn = h('button', { type: 'button', class: 'icbtn', 'data-testid': 'rec-share', 'aria-label': '공유' }, icon('share'));
    const bar = h('div', { class: 'bar' },
      h('button', { type: 'button', class: 'icbtn', 'aria-label': '뒤로', on: { click: () => nav.back() } }, icon('back')),
      title, shareBtn);

    const locVal = h('span', { class: 'rec-val' });
    const conVal = h('span', { class: 'rec-val multi' });
    const locBtn = h('button', { type: 'button', class: 'rec-field', 'data-testid': 'rec-location' },
      h('span', { class: 'rec-lab', text: '위치' }), locVal, icon('edit'));
    const conBtn = h('button', { type: 'button', class: 'rec-field', 'data-testid': 'rec-content' },
      h('span', { class: 'rec-lab', text: '내용' }), conVal, icon('edit'));
    const info = h('p', { class: 'rec-info' });
    const gpsInfo = h('p', { class: 'rec-info rec-gps' });
    const pinBox = h('div', { class: 'rec-pin', 'data-testid': 'rec-pin' });
    pinBox.hidden = true;
    const grid = h('div', { class: 'rec-grid' });
    const empty = h('p', { class: 'rec-empty', text: '사진이 없어요. 아래 [사진 더 찍기]로 찍어요.' });
    const delBtn = h('button', { type: 'button', class: 'textbtn rec-del', 'data-testid': 'rec-delete' }, icon('trash'), h('span', { text: '묶음 삭제' }));

    const moreBtn = h('button', { type: 'button', class: 'primary rec-more', 'data-testid': 'rec-more-shots' }, icon('camera'), h('span', { text: '사진 더 찍기' }));
    const addBtn = h('button', { type: 'button', class: 'secondary rec-add', 'data-testid': 'rec-add-photo' }, icon('image'), h('span', { text: '갤러리에서 추가' }));
    // 지난 날짜 묶음: 지금 카메라로 찍는 일보다 갤러리에서 넣는 일이 주 행동 — 노랑을 [갤러리에서 추가]로
    if ((store.record(id)?.day || dayKey(Date.now())) !== dayKey(Date.now())) {
      moreBtn.classList.replace('primary', 'secondary'); addBtn.classList.replace('secondary', 'primary');
    }
    const dock = h('div', { class: 'dock rec-dock' }, addBtn, moreBtn);

    const body = h('div', { class: 'rec-body' },
      h('div', { class: 'rec-fields' }, locBtn, conBtn), info, gpsInfo, pinBox, grid, empty, delBtn);
    const missing = h('p', { class: 'rec-empty', text: '이 묶음을 찾을 수 없어요. 지웠다면 설정 > 휴지통에서 되살릴 수 있어요.' });
    root.classList.add('rec-scr');
    root.append(bar, body, missing, dock);

    const cur = () => { const r = store.record(id); return r && !r.deletedAt ? r : null; };
    const saving = { location: null, content: null };                       // 저장 중인 글 — 확인을 누르면 화면에 먼저 보인다(저장 줄이 밀려 있어도)

    async function edit(field) {
      const r = cur(); if (!r) return;
      const multi = field === 'content';
      const v = await dom.textSheet({
        title: multi ? '내용' : '위치', value: r[field] || '', multiline: multi,
        placeholder: multi ? '무엇을 찍었는지 적어요' : '어디서 찍었는지 적어요', draftKey: multi ? `rec-content-${id}` : null
      });
      if (v == null || dead) return;
      const next = multi ? v.replace(/\s+$/, '') : v.trim();
      if (next === (cur()?.[field] || '')) return;
      saving[field] = next; render();
      try {
        await store.updateRecord(id, { [field]: next }, Date.now());           // lastLocation 은 건드리지 않는다
        if (field === 'location' && M) Promise.resolve(M.syncRecordPinNames?.(id, next)).catch(e => console.warn('핀 이름을 따라 바꾸지 못했다', e));   // 기본 이름 핀만 따라감
      }
      catch (e) { console.error('묶음을 고치지 못했다', e); toast('저장하지 못했어요. 다시 해 주세요'); }
      finally { if (saving[field] === next) { saving[field] = null; schedule(); } }
    }
    locBtn.addEventListener('click', () => edit('location'));
    conBtn.addEventListener('click', () => edit('content'));

    const lock = (btn, fn) => (typeof dom.lockButton === 'function' ? dom.lockButton(btn, fn) : btn.addEventListener('click', fn));
    lock(shareBtn, async () => {
      try { const share = await import('../../services/share.js'); const { afterShare } = await import('../widgets/sharefollow.js'); await afterShare(await share.shareRecord(id)); }
      catch (e) { if (e?.name !== 'AbortError') { console.error('공유 실패', e); toast('공유하지 못했어요'); } }
    });
    moreBtn.addEventListener('click', () => nav.go('capture', { recordId: id }));
    lock(addBtn, async () => {
      const files = await pickImages({ multiple: true });
      if (!files.length || dead) return;
      try { galleryToast(await addFromGallery(id, files)); }
      catch (e) { console.error('갤러리 사진 넣기 실패', e); toast(e?.code === 'QUOTA' ? '저장 공간이 모자라요' : '사진을 넣지 못했어요'); }
    });
    lock(delBtn, async () => {
      if (!cur()) return;
      deleting = true;
      try { await store.deleteRecord(id, Date.now()); }
      catch (e) { deleting = false; console.error('묶음 삭제 실패', e); toast('지우지 못했어요'); return; }
      nav.back();
      dom.snackbar?.('묶음을 지웠어요', {
        actionLabel: '되돌리기',
        onAction: () => store.restoreRecord(id, Date.now()).catch(e => { console.error(e); toast('되돌리지 못했어요'); })
      });
    });

    // ---------- 도면 위치 ----------
    let M = null, offDwg = null, pinSig = '', mini = null, miniTok = 0, placing = false;
    const dropMini = () => { miniTok++; try { mini?.destroy?.(); } catch { /* 무시 */ } mini = null; };
    const linkRecord = pin => store.updateRecord(id, { pin }, Date.now()).catch(e => console.warn('묶음에 핀을 잇지 못했다', e));

    function renderPin(r) {
      if (!M || !r) { pinBox.hidden = true; return; }
      const p = pinOfRecord(M, r);
      const d = p ? M.drawing(p.drawingId) : null;
      const others = p ? dayPinList(M, store.recordsOfDay(r.day)).map(x => x.p).filter(q => q.id !== p.id && q.drawingId === p.drawingId && q.page === p.page) : [];
      const sig = p ? [p.id, p.page, p.x, p.y, p.no, p.name, d?.name, d?.pages?.length, M.pageOf?.(p.drawingId, p.page)?.preview ? 1 : 0, others.map(q => `${q.id}:${q.x},${q.y}`).join(';')].join('|')
        : `none|${(M.drawings?.() || []).length}`;
      if (sig === pinSig) return;
      pinSig = sig;
      dropMini();
      if (!p) {
        const n = (M.drawings?.() || []).length;
        pinBox.hidden = !n;                                                    // 도면이 하나도 없으면 칸을 두지 않는다(화면에 꼭 필요한 것만)
        pinBox.classList.remove('has');
        if (!n) { pinBox.replaceChildren(); return; }
        pinBox.replaceChildren(h('button', { type: 'button', class: 'rec-pin-add', 'data-testid': 'rec-pin-add', on: { click: () => placeFlow() } },
          icon('pin', 22), h('span', { class: 'rec-pin-t' }, h('b', { text: '도면에 위치 찍기' }), h('small', { text: '도면을 골라 이 묶음 자리를 눌러요' })), icon('chev', 20)));
        return;
      }
      pinBox.hidden = false;
      pinBox.classList.add('has');
      const open = () => nav.go('drawview', { id: p.drawingId, page: p.page, pinId: p.id });
      const mapBox = h('div', { class: 'rec-pin-map' }, h('p', { class: 'rec-pin-msg', text: '도면을 여는 중…' }));
      const hit = h('button', { type: 'button', class: 'rec-pin-hit', 'data-testid': 'rec-pin-map', 'aria-label': `${p.name} 도면에서 크게 보기`, on: { click: open } });
      const where = [p.no ? `${p.no}번 핀` : null, dropExt(d?.name), (d?.pages?.length || 0) > 1 ? `${p.page}쪽` : null].filter(Boolean).join(' · ');
      const nameB = h('b', { text: p.name || '이름 없는 핀' });
      const nameBtn = h('button', { type: 'button', class: 'rec-pin-name', 'data-testid': 'rec-pin-name', 'aria-label': `핀 이름 ${p.name} 고치기` },
        icon('pin', 20), h('span', { class: 'rec-pin-t' }, nameB, h('small', { text: where })), icon('edit', 20));
      nameBtn.addEventListener('click', async () => {
        const v = await dom.textSheet({ title: '핀 이름', value: p.name || '', placeholder: '이름을 적어요' });
        if (v == null || dead || v.trim() === (p.name || '')) return;
        if (v.trim()) nameB.textContent = v.trim();                           // 화면에 먼저(비우면 「핀 n」은 저장 뒤 알림으로)
        try { await M.updatePin(p.id, { name: v }); }
        catch (e) { console.error('핀 이름을 저장하지 못했다', e); toast('저장하지 못했어요. 다시 해 주세요'); pinSig = ''; renderPin(cur()); }
      });
      const viewBtn = h('button', { type: 'button', class: 'secondary rec-pin-open', 'data-testid': 'rec-pin-open', on: { click: open } }, icon('drawing', 20), h('span', { text: '도면에서 보기' }));
      const delPin = h('button', { type: 'button', class: 'textbtn rec-pin-del', 'data-testid': 'rec-pin-delete' }, h('span', { text: '핀 지우기' }));
      lock(delPin, async () => {
        const ref = { drawingId: p.drawingId, pinId: p.id };
        try { await M.deletePin(p.id); } catch (e) { console.error('핀 지우기 실패', e); toast('지우지 못했어요'); return; }
        await linkRecord(null);
        dom.snackbar?.('핀을 지웠어요', {
          actionLabel: '되돌리기',
          onAction: async () => { await M.restorePin(p.id); await linkRecord(ref); },
        });
      });
      pinBox.replaceChildren(
        h('div', { class: 'rec-pin-mapwrap' }, mapBox, hit),
        nameBtn,
        h('div', { class: 'rec-pin-acts' }, viewBtn, delPin));
      const tok = ++miniTok;
      mountMini(mapBox, M, {
        drawingId: p.drawingId, page: p.page, highlight: p.id, showPins: { pinIds: [p.id] },          // 이 핀 진하게, 나머지(그 날 다른 핀 포함)는 흐리게
        pins: [{ ...p, active: true }, ...others.map(q => ({ ...q, dim: true }))],
        isDead: () => dead || tok !== miniTok,
      }).then(v => { if (dead || tok !== miniTok) { try { v?.destroy?.(); } catch { /* 무시 */ } return; } mini = v; })
        .catch(e => { console.warn('미니 위치도 실패', e); mapBox.replaceChildren(h('p', { class: 'rec-pin-msg', text: '도면 그림을 못 열었어요' })); });
    }

    // 핀 없음 → 도면 고르기 → 찍기 시트. 누르면 바로 핀이 생기고(저장 수 ms) 끌어서 옮기면 따라 저장. [완료] 뒤 5초 [되돌리기]
    async function placeFlow() {
      if (!M || placing) return;
      placing = true;
      try {
        const r0 = cur(); if (!r0) return;
        const last = dayPinList(M, store.recordsOfDay(r0.day)).map(x => x.p).sort((a, b) => b.createdAt - a.createdAt)[0];
        const did = await chooseDrawing(M, { current: last?.drawingId || null });
        if (!did || dead) return;
        const d = M.drawing(did);
        if (!d) return;
        const page = (last?.drawingId === did ? last.page : null) ?? d.geo?.page ?? d.pages?.[0]?.page ?? 1;
        let made = null, chain = Promise.resolve(), view = null, vtok = 0;
        const doneBtn = h('button', { type: 'button', class: 'secondary', 'data-testid': 'rec-place-done', text: '취소' });
        let closeSheet = () => {};
        const onXY = (x, y) => {
          if (!Number.isFinite(x) || !Number.isFinite(y)) return;
          doneBtn.textContent = '완료';
          if (boxRef?.dataset.kind === 'dv') queueMicrotask(() => closeSheet());   // 도면 보기 위젯은 [여기에 찍기]가 확인 — 바로 닫는다
          chain = chain.then(async () => {
            if (!made) {
              made = await M.addPin({ drawingId: did, page, x, y, recordId: id, recordLabel: (cur()?.location || '').trim() });
              await linkRecord({ drawingId: did, pinId: made.id });
            } else await M.updatePin(made.id, { x, y });
          }).catch(e => { console.error('핀 저장 실패', e); toast('핀을 저장하지 못했어요'); });
        };
        let boxRef = null;
        dom.openSheet(close => {
          closeSheet = close;
          doneBtn.addEventListener('click', () => close());
          const box = boxRef = h('div', { class: 'rec-place-map', 'data-testid': 'rec-place-map' }, h('p', { class: 'rec-pin-msg', text: '도면을 여는 중…' }));
          const others = M.pins?.(did, { page }) || [];
          const actions = h('div', { class: 'sheet-actions' }, doneBtn);
          const tok = ++vtok;
          mountMini(box, M, { drawingId: did, page, mode: 'place', onPlace: onXY, onCancel: () => close(), placeLabel: String((d.pinSeq || 0) + 1), pins: others.map(q => ({ ...q, dim: true })), isDead: () => tok !== vtok })
            .then(v => {
              if (tok !== vtok) { try { v?.destroy?.(); } catch { /* 무시 */ } return; }
              view = v;
              if (box.dataset.kind === 'dv') actions.hidden = true;   // 위젯이 [여기에 찍기]·[취소]를 엄지 자리에 둔다
            })
            .catch(e => { console.warn('찍기 지도 실패', e); box.replaceChildren(h('p', { class: 'rec-pin-msg', text: '도면을 못 열었어요' })); });
          return h('div', { class: 'sheet-body rec-place-body' },
            h('h2', { class: 'sheet-title', text: '이 묶음 자리를 눌러요' }),
            h('p', { class: 'rec-place-sub', text: dropExt(d.name) }),
            box, actions);
        }, {
          label: '도면에 위치 찍기', cls: 'rec-place-sheet',
          onClose: () => {
            vtok++; try { view?.destroy?.(); } catch { /* 무시 */ }
            chain.then(() => {
              if (!made || dead) return;
              const pid = made.id;
              dom.snackbar?.(`핀을 찍었어요 · ${made.name}`, {
                actionLabel: '되돌리기',
                onAction: async () => { await (M.purgePin || M.deletePin)(pid); await linkRecord(null); },
              });
            });
          },
        });
      } finally { placing = false; }
    }

    function render() {
      queued = false;
      if (dead) return;
      const r = cur();
      body.hidden = !r; dock.hidden = !r; shareBtn.hidden = !r; missing.hidden = !!r;
      if (!r) { title.textContent = '묶음'; return; }
      title.textContent = `묶음 ${r.no || ''}`.trim();
      const loc = (saving.location ?? r.location ?? '').trim(), con = (saving.content ?? r.content ?? '').trim();
      locVal.textContent = loc || '위치 미입력 · 눌러서 쓰기';
      locVal.classList.toggle('dim', !loc);
      conVal.textContent = con || '내용 없음 · 눌러서 쓰기';
      conVal.classList.toggle('dim', !con);

      const photos = store.photosOf(id) || [];
      const times = photos.map(p => p.takenAt).filter(Number.isFinite);
      const first = times.length ? Math.min(...times) : null;
      info.textContent = [dayLabel(r.day), first != null ? `처음 ${hm(first)}` : null, `사진 ${photos.length}장`].filter(Boolean).join(' · ');
      const g = firstGps(photos);
      gpsInfo.hidden = !g;
      if (g) gpsInfo.textContent = `GPS ${geo.fmtCoord ? geo.fmtCoord(g.lat, g.lng) : `${g.lat.toFixed(5)}, ${g.lng.toFixed(5)}`}${Number.isFinite(g.acc) ? ` ${geo.fmtAcc ? geo.fmtAcc(g.acc) : `±${Math.round(g.acc)}m`}` : ''}`;

      grid.classList.toggle('cols-3', photos.length > 8);
      dom.syncList(grid, photos, { key: p => p.id, sig: p => `${photos.indexOf(p)}|${!p.state || p.state === 'ready' ? 'ready' : p.state}`, make: p => cell(p, photos.indexOf(p), id, nav) });   // 바뀐 칸만
      grid.hidden = !photos.length;
      empty.hidden = !!photos.length;
      renderPin(r);
    }
    // store 알림 반영은 글 입력이 끝난 뒤 한 번(내용 시트를 쓰는 동안 사진 처리 알림마다 격자를 다시 맞추지 않게). [확인] 직후 글은 edit() 가 바로 그린다
    const schedule = typeof dom.deferWhileTyping === 'function' ? dom.deferWhileTyping(render) : () => { if (!queued) { queued = true; queueMicrotask(render); } };

    const off = store.on(ch => {
      if (dead || deleting) return;
      const r = store.record(id);
      const mine = ch?.records?.has?.(id) || ch?.settings
        || (ch?.photos && [...ch.photos].some(pid => store.photo(pid)?.recordId === id || r?.photoIds?.includes(pid)));
      if (mine) schedule();
    });
    render();

    // 도면보관함(별도 DB)은 첫 그림 뒤에 연다 — 없거나 실패하면 도면 위치 칸만 빠진다
    drawingsMod().then(m => {
      if (dead || !m) return;
      M = m;
      try { offDwg = m.onDrawings?.(() => { if (!dead && !deleting) schedule(); }); } catch { /* 무시 */ }
      renderPin(cur());
    });

    return () => { dead = true; schedule.cancel?.(); off?.(); offDwg?.(); dropMini(); dock.remove(); };
  }
};
