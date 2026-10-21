// 묶음 상세 `record`(설계서 §6.3) — params { id }
// 위치·내용 고치기(자유 입력 시트), 정보 줄, 사진 격자(4:3, 2열 기본·많으면 3열) → 크게 보기,
// [사진 더 찍기]·[갤러리에서 추가]·[묶음 삭제](소프트 삭제 + 5초 되돌리기).
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
      h('div', { class: 'rec-fields' }, locBtn, conBtn), info, gpsInfo, grid, empty, delBtn);
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
        placeholder: multi ? '무엇을 찍었는지 적어요' : '예: 101동 5층 복도', draftKey: multi ? `rec-content-${id}` : null
      });
      if (v == null || dead) return;
      const next = multi ? v.replace(/\s+$/, '') : v.trim();
      if (next === (cur()?.[field] || '')) return;
      saving[field] = next; render();
      try { await store.updateRecord(id, { [field]: next }, Date.now()); }   // lastLocation 은 건드리지 않는다
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
    }
    const schedule = () => { if (!queued) { queued = true; queueMicrotask(render); } };

    const off = store.on(ch => {
      if (dead || deleting) return;
      const r = store.record(id);
      const mine = ch?.records?.has?.(id) || ch?.settings
        || (ch?.photos && [...ch.photos].some(pid => store.photo(pid)?.recordId === id || r?.photoIds?.includes(pid)));
      if (mine) schedule();
    });
    render();

    return () => { dead = true; off?.(); dock.remove(); };
  }
};
