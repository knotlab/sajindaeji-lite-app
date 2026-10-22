// 도면보관함 `drawings`(docs/도면보관함-설계.md §5.2) — 도면만 따로 모아 두고, 지도처럼 보며 이름 핀을 찍고 길을 찾는다.
// 사용자 요구: "도면은 따로 모아두자. 도면보관함을 따로 만들어서 길찾고 핀 가능하게. 핀에도 이름을 붙일 수 있게".
// 바(뒤로·도면보관함·[올리기]·[⋮] 지운 도면) → 검색 → 지금 여기 도면(노란 상자, 위치 맞춘 도면 안에 서 있을 때) → 줄(누르면 drawview).
// 올리기: 원본만 저장하고 줄이 바로 생긴다(수백 ms). 쪽 그림·타일은 뒤에서(media/drawtiles.js 처리 줄, 한 번에 하나) — 줄에 「그림 만드는 중 40%」.
// 체감 속도: 목록은 바뀐 줄만(syncList), 검색은 한 그림에 한 번. 썸네일은 맨 아래 단계 타일 한 장(≤512px — 미리보기 2400px 를 줄마다 풀지 않는다).
import { h, icon, toast, snackbar, openSheet, textSheet, choose, pickFiles, syncList } from '../dom.js';
import * as D from '../../data/drawings.js';
import * as DT from '../../media/drawtiles.js';
import * as gps from '../../services/gps.js';
import * as store from '../../data/store.js';
import { makeMatcher } from '../widgets/docpicker.js';

export const ACCEPT = '.pdf,.dwg,.dxf,.dwt,image/*';
const safe = (f, fb) => { try { const v = f(); return v === undefined ? fb : v; } catch { return fb; } };
const SVGNS = 'http://www.w3.org/2000/svg';
// 스프라이트에 없는 모양(도면 종류) — 인라인 path
function pathIcon(ds, size = 24) {
  const s = document.createElementNS(SVGNS, 'svg');
  s.setAttribute('class', 'ic'); s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false');
  for (const d of ds) { const p = document.createElementNS(SVGNS, 'path'); p.setAttribute('d', d); s.append(p); }
  return s;
}
export const drawingIcon = (size = 24) => pathIcon(['M4 4h16v16H4z', 'M4 10h7v10', 'M11 4v4', 'M15 14h5', 'M15 14v6'], size);

export const kindText = d => (d.kind === 'pdf' ? 'PDF' : d.kind === 'cad' ? `도면 ${String(d.ext || '').toUpperCase()}` : `그림 ${String(d.ext || '').toUpperCase()}`);
export const baseName = d => (d.ext && d.name.toLowerCase().endsWith(`.${d.ext}`) ? d.name.slice(0, -(d.ext.length + 1)) : d.name) || d.name;
export function buildText(id) {
  const s = DT.buildState(id);
  if (!s) return '';
  if (s.phase === 'error') return s.message || '그림을 못 만들었어요';
  if (s.phase === 'tiles') return `그림 만드는 중 ${s.pct}%`;
  if (s.phase === 'render') return '도면을 그리는 중…';
  return '그림 만들 차례를 기다려요';
}

// ---- 올리기(도면보관함·고르기 시트가 같이 쓴다) ----
// 반드시 탭 핸들러 안에서 부른다(파일 고르기). → 올린 Drawing[]
export async function uploadDrawings({ onStatus } = {}) {
  return uploadFiles(await pickFiles({ accept: ACCEPT, multiple: true }), { onStatus });
}
// 고른 파일 → 도면보관함(원본만 저장, 그림은 뒤에서 줄 세움) → 올린 Drawing[]
export async function uploadFiles(files, { onStatus } = {}) {
  if (!files?.length) return [];
  const site = safe(() => store.settings()?.siteName || '', '');
  const say = t => { try { onStatus?.(t); } catch { /* 무시 */ } };
  say(files.length > 1 ? `올리는 중… 1/${files.length}` : '올리는 중…');
  const { added, failed } = await D.addDrawingFiles(files, { site, onProgress: (i, n) => { if (n > 1 && i < n) say(`올리는 중… ${i + 1}/${n}`); } });
  for (const d of added) DT.queueDrawing(d.id, { page: 1 });
  const msg = failed.length && !added.length ? (failed.length === 1 ? `못 올렸어요: ${failed[0].reason}` : `${failed.length}개를 못 올렸어요(${failed[0].reason})`)
    : failed.length ? `${added.length}개 올렸어요 · ${failed.length}개는 못 올렸어요(${failed[0].reason})`
      : added.length === 1 ? '도면을 올렸어요. 그림은 뒤에서 만들어요' : `도면 ${added.length}개를 올렸어요`;
  say('');
  toast(msg, failed.length ? 4000 : 2200);
  return added;
}

// ---- 도면 하나의 메뉴(목록 줄 [⋮] · 도면 보기 [⋮]) ----
export async function drawingMenu(id, nav, { inView = false } = {}) {
  const d = D.drawing(id);
  if (!d) return;
  const options = [
    { value: 'geo', label: d.geo?.T ? '위치 다시 맞추기' : '위치 맞추기', sub: d.geo?.T ? D.geoBadge(d).text : '맞추면 도면에 내 위치·길찾기가 돼요' },
    { value: 'rename', label: '이름 바꾸기' },
    { value: 'tags', label: '태그 고치기', sub: d.tags || '동·층·공종을 적어 두면 찾기 쉬워요' },
    inView ? null : { value: 'pin', label: d.pinned ? '고정 풀기' : '맨 위에 고정' },
    d.missingFile ? { value: 'relink', label: '원본 파일 다시 넣기', sub: `같은 종류(.${d.ext}) 파일` } : { value: 'rebuild', label: '그림 다시 만들기', sub: '도면이 흐리거나 잘못 그려졌을 때' },
    d.missingFile ? null : { value: 'share', label: '공유(원본 파일)' },
    { value: 'delete', label: '지우기' },
  ].filter(Boolean);
  const pick = await choose({ title: baseName(d), options });
  if (!pick) return;
  try {
    if (pick === 'geo') nav.go('drawgeo', { id, page: d.geo?.page || d.pages[0]?.page || 1 });
    else if (pick === 'rename') {
      const v = await textSheet({ title: '도면 이름', value: baseName(d), okLabel: '바꾸기' });
      if (v != null && v.trim() && v.trim() !== baseName(d)) { await D.updateDrawing(id, { name: v.trim() }); toast('이름을 바꿨어요'); }
    } else if (pick === 'tags') {
      const v = await textSheet({ title: '태그', value: d.tags || '', placeholder: '예) 101동 5층 평면', okLabel: '저장' });
      if (v != null) { await D.updateDrawing(id, { tags: v }); toast('태그를 저장했어요'); }
    } else if (pick === 'pin') {
      await D.updateDrawing(id, { pinned: !d.pinned }); toast(d.pinned ? '고정을 풀었어요' : '맨 위에 고정했어요');
    } else if (pick === 'rebuild') {
      for (const pg of (d.pages.length ? d.pages : [{ page: 1 }])) DT.queueDrawing(id, { page: pg.page, force: true });
      toast('그림을 다시 만들어요. 핀은 그대로예요');
    } else if (pick === 'relink') {
      const [f] = await pickFiles({ accept: `.${d.ext}`, multiple: false });
      if (!f) return;
      await D.relinkDrawingFile(id, f);
      DT.queueDrawing(id, { page: 1, force: true });
      toast('원본을 다시 넣었어요. 그림을 만들어요');
    } else if (pick === 'share') await shareDrawing(id);
    else if (pick === 'delete') {
      if (inView) nav.back();
      const linked = D.linkedRecordCount?.(id) || 0;                         // 묶음 위치도가 같이 빠진다는 것을 알린다(휴지통에서 30일 안에 되살릴 수 있음)
      await D.deleteDrawing(id);
      snackbar(linked ? `도면을 지웠어요 · 묶음 ${linked}개 위치도 함께` : '도면을 지웠어요', { actionLabel: '되돌리기', onAction: () => D.restoreDrawing(id) });
    }
  } catch (err) {
    console.error('도면 메뉴 동작 실패', err);
    toast(err?.code === 'QUOTA' ? '저장 공간이 부족해요' : (err?.code === 'EXT' ? err.message : '하지 못했어요'));
  }
}

async function shareDrawing(id) {
  const d = D.drawing(id);
  const blob = await D.drawingBlob(id);
  if (!blob) { toast('원본 파일이 없어요'); return; }
  const N = await import('../../platform/native.js');
  if (N.isNative()) {
    const uri = await N.writeCache(`share/${Date.now()}/${d.name}`, blob);
    await N.shareFiles([uri], { title: d.name });
    return;
  }
  const file = new File([blob], d.name, { type: d.mime || blob.type || 'application/octet-stream' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: d.name }); } catch (e) { if (e?.name !== 'AbortError') throw e; }
    return;
  }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: d.name, style: { display: 'none' } });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast('내려받았어요');
}

// ---- 썸네일: 맨 아래 단계 타일 한 장(있을 때만, 화면에 보일 때) ----
const thumbIO = typeof IntersectionObserver === 'function' ? new IntersectionObserver(ents => {
  for (const e of ents) {
    if (!e.isIntersecting) continue;
    thumbIO.unobserve(e.target);
    e.target._load?.();
  }
}, { rootMargin: '200px' }) : null;
function thumbOf(d) {
  const box = h('span', { class: 'dw-thumb', 'aria-hidden': 'true' }, drawingIcon(24));
  const pg = d.pages[0];
  if (pg?.tiles && (pg.tiles.upto ?? -1) >= 0) {
    box._load = () => DT.tileUrl(d.id, pg.page, 0, 0, 0).then(u => {
      if (!u) return;
      const im = h('img', { alt: '', decoding: 'async', draggable: false });
      im.onload = () => box.replaceChildren(im);
      im.src = u;
    });
    if (thumbIO) thumbIO.observe(box); else box._load();
  }
  return box;
}

function rowSig(d) {
  const pg = d.pages[0];
  return `${d.updatedAt}|${d.name}|${d.pinned ? 1 : 0}|${D.pins(d.id).length}|${pg?.tiles?.upto ?? -2}|${DT.buildState(d.id)?.phase || ''}|${d.missingFile ? 1 : 0}`;   // 진행률(%)은 줄을 다시 만들지 않고 글만
}
function makeRow(d, nav) {
  const badge = D.geoBadge(d);
  const nPins = D.pins(d.id).length;
  const bt = buildText(d.id);
  const sub = h('span', { class: 'dw-sub' },
    d.pinned ? h('span', { class: 'tag', text: '고정' }) : null,
    h('span', { text: kindText(d) }),
    h('span', { text: `핀 ${nPins}` }),
    h('span', { class: 'dw-geo-badge', 'data-testid': 'dw-geo-badge', 'data-state': badge.state, text: badge.text }));
  const line2 = d.missingFile ? h('span', { class: 'dw-warn', text: '원본 파일을 다시 올려 주세요' })
    : bt ? h('span', { class: ['dw-prog', DT.buildState(d.id)?.phase === 'error' && 'bad'], 'data-testid': 'dw-progress', text: bt }) : null;
  const main = h('button', { type: 'button', class: 'dw-open', 'aria-label': `${baseName(d)} 열기`, onclick: () => nav.go('drawview', { id: d.id }) },
    thumbOf(d),
    h('span', { class: 'dw-main' }, h('span', { class: 'dw-name', text: baseName(d) }), sub, line2));
  const menu = h('button', { type: 'button', class: 'dw-menu', 'data-testid': 'dw-menu', 'aria-label': `${baseName(d)} 메뉴`, onclick: () => drawingMenu(d.id, nav) }, icon('more'));
  return h('div', { class: 'dw-row', 'data-testid': 'dw-row', 'data-id': d.id }, main, menu);
}

// 지운 도면(휴지통) 시트
function trashSheet() {
  openSheet(close => {
    const list = h('div', { class: 'rows' });
    const draw = () => {
      const ds = D.drawings({ deleted: true });
      list.replaceChildren(...(ds.length ? ds.map(d => h('div', { class: 'row' },
        h('span', { class: 'body' }, h('span', { class: 't', text: baseName(d) }), h('span', { class: 's', text: `${new Date(d.deletedAt).toLocaleDateString('ko-KR')}에 지움 · 30일 뒤 사라져요` })),
        h('button', { type: 'button', class: 'secondary dw-restore', text: '되살리기', onclick: async () => { await D.restoreDrawing(d.id); toast('되살렸어요'); draw(); } })))
        : [h('p', { class: 'empty', text: '지운 도면이 없어요' })]));
    };
    draw();
    return h('div', { class: 'sheet-body' }, h('h2', { class: 'sheet-title', text: '지운 도면' }), list,
      h('button', { type: 'button', class: 'textbtn', text: '닫기', onclick: () => close() }));
  }, { label: '지운 도면' });
}

export default {
  mount(root, _params, nav) {
    root.classList.add('dw');
    let alive = true;
    const offs = [];

    // ---- 바 ----
    const upBtn = h('button', { type: 'button', class: 'barlink', 'data-testid': 'dw-upload', 'aria-label': '도면 올리기', onclick: () => doUpload() }, icon('upload', 22), '올리기');
    const moreBtn = h('button', { type: 'button', class: 'icbtn', 'data-testid': 'dw-more', 'aria-label': '지운 도면', onclick: () => trashSheet() }, icon('more'));
    const bar = h('header', { class: 'bar' },
      h('button', { type: 'button', class: 'icbtn', 'aria-label': '뒤로', onclick: () => nav.back() }, icon('back')),
      h('h1', { text: '도면보관함' }), upBtn, moreBtn);

    // ---- 검색 ----
    const input = h('input', {
      type: 'text', class: 'dw-q', 'data-testid': 'dw-search', placeholder: '이름·태그·핀 이름으로 찾기', 'aria-label': '도면 찾기',
      autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search',
    });
    let raf = 0;
    const later = () => { if (!raf && alive) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
    input.addEventListener('input', later);
    input.addEventListener('compositionend', later);
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); input.blur(); } });
    const clearBtn = h('button', { type: 'button', class: 'dw-clear', 'aria-label': '찾는 글 지우기', hidden: true, onpointerdown: e => e.preventDefault(),
      onclick: () => { input.value = ''; draw(); input.focus({ preventScroll: true }); } }, icon('close', 20));
    const search = h('label', { class: 'dw-search' }, icon('search', 20), input, clearBtn);

    const status = h('p', { class: 'dw-status', role: 'status', hidden: true });
    const here = h('div', { class: 'dw-here', 'data-testid': 'dw-here', hidden: true });
    const list = h('div', { class: 'dw-list rows' });
    const none = h('p', { class: 'dw-none', hidden: true, text: '맞는 도면이 없어요. 다른 말로 찾아 보세요' });
    const emptyBtn = h('button', { type: 'button', class: 'primary', 'data-testid': 'dw-empty-upload', onclick: () => doUpload() }, icon('upload', 22), '도면 올리기');
    const empty = h('div', { class: 'dw-empty', 'data-testid': 'dw-empty', hidden: true },
      h('span', { class: 'dw-bigico', 'aria-hidden': 'true' }, drawingIcon(32)),
      h('p', { class: 'dw-empty-t', text: '도면을 올리면 핀을 찍고 길을 찾을 수 있어요' }),
      h('p', { class: 'dw-empty-s', text: 'PDF·DWG·DXF·도면 그림' }),
      emptyBtn);
    root.append(bar, search, status, here, empty, list, none);
    root.dataset.state = 'loading';

    let ready = false;
    const hays = new Map();
    const hayOf = d => {
      const pinNames = D.pins(d.id).map(p => p.name).join(' ');
      const key = `${d.updatedAt}|${pinNames}`;
      let e = hays.get(d.id);
      if (!e || e.key !== key) { e = { key, text: `${d.name} ${d.tags || ''} ${d.ext} ${kindText(d)} ${pinNames}`.normalize('NFC').toLowerCase() }; hays.set(d.id, e); }
      return e.text;
    };

    function draw() {
      if (!ready || !alive) return;
      const all = D.drawings();
      const q = input.value;
      clearBtn.hidden = !q;
      const isEmpty = !all.length;
      empty.hidden = !isEmpty;
      search.hidden = isEmpty;
      root.dataset.state = isEmpty ? 'empty' : 'list';
      const match = makeMatcher(q);
      const shown = match ? all.filter(d => match(hayOf(d))) : all;
      none.hidden = !(match && !shown.length);
      syncList(list, shown, { key: d => d.id, sig: rowSig, make: d => makeRow(d, nav) });
      list.hidden = !shown.length;
      drawHere();
      const trashN = D.drawings({ deleted: true }).length;
      moreBtn.hidden = !trashN;
      moreBtn.setAttribute('aria-label', `지운 도면 ${trashN}개`);
    }

    // 지금 여기 도면 — 위치 맞춘 도면이 있을 때만 GPS 를 켠다
    let stopGps = null, hereSig = '';
    function drawHere() {
      const anyGeo = D.drawings().some(d => d.geo?.T);
      if (anyGeo && !stopGps) { stopGps = gps.start(); offs.push(gps.on(() => drawHere())); }
      const pos = anyGeo ? gps.snapshot()?.pos : null;
      const at = pos && !input.value.trim() ? D.drawingsAt(pos, { marginM: 0 }) : [];
      const top = at[0];
      const sig = top ? `${top.drawing.id}|${top.drawing.name}` : '';
      if (sig === hereSig) return;
      hereSig = sig;
      here.hidden = !top;
      if (!top) { here.replaceChildren(); return; }
      const d = top.drawing;
      here.replaceChildren(
        h('span', { class: 'dw-here-t' }, h('b', { text: baseName(d) }), h('span', { text: '지금 이 도면 안이에요' })),
        h('button', { type: 'button', class: 'primary dw-here-go', 'data-testid': 'dw-here-open', text: '열기', onclick: () => nav.go('drawview', { id: d.id }) }));
    }

    async function doUpload() {
      const say = t => { status.hidden = !t; status.textContent = t; };
      try {
        const added = await uploadDrawings({ onStatus: say });
        if (added.length) { input.value = ''; draw(); }
      } catch (e) {
        console.error('도면 올리기 실패', e);
        say(''); toast(e?.code === 'QUOTA' ? '저장 공간이 부족해요' : '올리지 못했어요');
      }
    }

    D.ready().then(() => {
      if (!alive) return;
      ready = true;
      draw();
      DT.resumePending().catch(e => console.warn('도면 그림 이어 만들기 실패', e));
    }, e => {
      console.error('도면보관함을 열지 못했어요', e);
      root.dataset.state = 'error';
      status.hidden = false; status.textContent = '도면보관함을 열지 못했어요. 앱을 다시 열어 주세요';
    });
    offs.push(D.onDrawings(later));
    // 그림 만드는 진행률 — 단계가 바뀌면 줄을 다시, % 만 바뀌면 그 글만
    const phases = new Map();
    offs.push(DT.onBuild(id => {
      const ph = DT.buildState(id)?.phase || '';
      if (phases.get(id) !== ph) { phases.set(id, ph); later(); return; }
      const t = list.querySelector(`.dw-row[data-id="${CSS.escape(id)}"] .dw-prog`);
      const txt = buildText(id);
      if (t && t.textContent !== txt) t.textContent = txt;
    }));

    return () => {
      alive = false;
      cancelAnimationFrame(raf);
      for (const f of offs) safe(f);
      safe(() => stopGps?.());
    };
  },
};
