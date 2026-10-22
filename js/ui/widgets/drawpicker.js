// 도면 고르기 시트 — 촬영 화면 [도면] 등에서 도면보관함의 도면을 고른다(docs/도면보관함-설계.md §5.6). 모양·크기는 자료 고르기(docpicker)와 같다(.dp-*).
// pickDrawing({ title, current }) → Promise<drawingId | null(취소)>
// 위: 검색칸(이름·태그·핀 이름, 치는 중인 한글도 — docpicker.makeMatcher), 아래 목록만 스크롤:
//   지금 여기(위치 맞춘 도면 안·50m 안, gps 가 켜져 있을 때) → 고정 → 최근 연 것(최대 5) → 전체(이름순).
// 비었으면 「도면보관함이 비어 있어요」 + [도면 올리기](하나면 올리자마자 그 도면으로 — 그림은 뒤에서 만든다).
import { h, icon, openSheet, syncList, pickFiles } from '../dom.js';
import { uploadFiles, ACCEPT } from '../screens/drawings.js';
import * as D from '../../data/drawings.js';
import * as DT from '../../media/drawtiles.js';
import * as gps from '../../services/gps.js';
import * as G from '../../core/georef.js';
import { makeMatcher } from './docpicker.js';

const RECENT_MAX = 5;
const safe = (f, fb) => { try { const v = f(); return v === undefined ? fb : v; } catch { return fb; } };
const baseName = d => (d.ext && d.name.toLowerCase().endsWith(`.${d.ext}`) ? d.name.slice(0, -(d.ext.length + 1)) : d.name) || d.name;
const kindMark = d => (d.kind === 'pdf' ? 'PDF' : `${d.kind === 'cad' ? '도면' : '그림'} ${String(d.ext || '').toUpperCase()}`);
const hays = new Map();
function hayOf(d) {
  const names = D.pins(d.id).map(p => p.name).join(' ');
  const k = `${d.updatedAt}|${names}`;
  let e = hays.get(d.id);
  if (!e || e.k !== k) { e = { k, text: `${d.name} ${d.tags || ''} ${d.ext} ${names}`.normalize('NFC').toLowerCase() }; hays.set(d.id, e); }
  return e.text;
}

function rowSig(d, cur, extra) { return `${d.updatedAt}|${d.id === cur ? 1 : 0}|${extra || ''}|${DT.buildState(d.id)?.phase || ''}`; }
function makeRow(d, cur, extra, onPick) {
  const isCur = d.id === cur;
  const badge = D.geoBadge(d);
  const st = DT.buildState(d.id);
  return h('button', {
    type: 'button', class: ['dp-row', isCur && 'cur'], 'data-testid': 'drawing-picker-row', 'data-id': d.id,
    'aria-label': `${d.name}${isCur ? ', 보는 중' : ''}`, 'aria-current': isCur ? 'true' : null, title: d.name,
    onclick: () => onPick(d.id),
  },
  h('span', { class: 'dp-ico k-drawing', 'aria-hidden': 'true' }, icon('plan', 22)),
  h('span', { class: 'dp-main' },
    h('span', { class: 'dp-name', text: baseName(d) }),
    h('span', { class: 'dp-sub' },
      isCur ? h('span', { class: 'dp-cur' }, icon('check', 14), '보는 중') : null,
      h('span', { class: 'dp-kind', text: kindMark(d) }),
      h('span', { class: 'dp-size', text: `핀 ${D.pins(d.id).length}` }),
      extra ? h('b', { class: 'dp-dist', text: extra }) : null,
      badge.state !== 'none' ? h('span', { class: 'dp-net', text: badge.text }) : null,
      st && st.phase !== 'error' ? h('span', { class: 'dp-net', text: '그림 만드는 중' }) : null)));
}
function section(name) {
  const head = h('h3', { class: 'dp-sec' });
  const rows = h('div', { class: 'dp-rows', 'data-section': name });
  const el = h('section', { class: 'dp-group', 'data-section': name }, head, rows);
  el.hidden = true;
  return {
    el,
    set(title, items, cur, onPick) {
      el.hidden = !items.length;
      if (head.textContent !== title) head.textContent = title;
      syncList(rows, items, { key: x => x.d.id, sig: x => rowSig(x.d, cur, x.extra), make: x => makeRow(x.d, cur, x.extra, onPick) });
    },
  };
}

export function pickDrawing({ title = '도면 고르기', current = null } = {}) {
  return new Promise(resolve => {
    let picked = null;
    const offs = [];
    openSheet(close => {
      const pick = id => { picked = id; close(); };
      const input = h('input', {
        type: 'text', class: 'dp-q', 'data-testid': 'drawing-picker-search', placeholder: '이름·태그·핀 이름으로 찾기', 'aria-label': '도면 찾기',
        autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search',
      });
      let raf = 0, composing = false, lastFound = [];
      const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
      input.addEventListener('input', later);
      input.addEventListener('compositionstart', () => { composing = true; });
      input.addEventListener('compositionend', () => { composing = false; later(); });
      input.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || composing || e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        if (lastFound.length === 1) pick(lastFound[0].id); else input.blur();
      });
      const clearBtn = h('button', { type: 'button', class: 'dp-clear', 'aria-label': '찾는 글 지우기', onpointerdown: e => e.preventDefault(),
        onclick: () => { input.value = ''; draw(); input.focus({ preventScroll: true }); } }, icon('close', 20));
      const search = h('label', { class: 'dp-search' }, icon('search', 20), input, clearBtn);
      const upBtn = h('button', { type: 'button', class: 'dp-up', 'data-testid': 'drawing-picker-upload', onclick: () => upload() }, icon('upload', 20), '올리기');
      const closeBtn = h('button', { type: 'button', class: 'dp-x', 'aria-label': '닫기', onclick: () => close() }, icon('close', 22));
      const header = h('div', { class: 'dp-head' }, h('h2', { class: 'sheet-title dp-title', text: title }), upBtn, closeBtn);
      const status = h('p', { class: 'dp-status', role: 'status', hidden: true });
      const S = { here: section('here'), pinned: section('pinned'), recent: section('recent'), all: section('all'), found: section('found') };
      const none = h('p', { class: 'dp-none', hidden: true });
      const emptyUp = h('button', { type: 'button', class: 'primary dp-emptybtn', 'data-testid': 'drawing-picker-empty-upload', onclick: () => upload() }, icon('upload', 22), '도면 올리기');
      const empty = h('div', { class: 'dp-empty', 'data-testid': 'drawing-picker-empty', hidden: true },
        h('span', { class: 'dp-ico dp-bigico', 'aria-hidden': 'true' }, icon('plan', 30)),
        h('p', { class: 'dp-empty-t', text: '도면보관함이 비어 있어요' }),
        h('p', { class: 'dp-empty-s', text: 'PDF·DWG·DXF·도면 그림을 올리면 핀을 찍고 길을 찾을 수 있어요' }),
        emptyUp);
      const list = h('div', { class: 'dp-list' }, empty, ...Object.values(S).map(s => s.el), none);
      const body = h('div', { class: 'dp-body', 'data-testid': 'drawing-picker' }, header, search, status, list);
      body.dataset.state = 'loading';
      let ready = false, pos = safe(() => gps.snapshot()?.pos, null) || null;

      function draw() {
        if (!ready) return;
        const all = D.drawings();
        const q = input.value;
        clearBtn.hidden = !q;
        const isEmpty = !all.length;
        empty.hidden = !isEmpty; search.hidden = isEmpty; upBtn.hidden = isEmpty;
        body.dataset.state = isEmpty ? 'empty' : q.trim() ? 'search' : 'list';
        if (isEmpty) { for (const s of Object.values(S)) s.set('', [], current, pick); none.hidden = true; lastFound = []; return; }
        const match = makeMatcher(q);
        if (match) {
          const found = all.filter(d => match(hayOf(d))).sort((a, b) => (b.pinned - a.pinned) || a.name.localeCompare(b.name, 'ko', { numeric: true }));
          lastFound = found;
          for (const k of ['here', 'pinned', 'recent', 'all']) S[k].set('', [], current, pick);
          S.found.set(`찾은 도면 ${found.length}개`, found.map(d => ({ d })), current, pick);
          none.hidden = !!found.length; none.textContent = '맞는 도면이 없어요. 다른 말로 찾아 보세요';
          return;
        }
        lastFound = all; none.hidden = true;
        S.found.set('', [], current, pick);
        const here = pos ? D.drawingsAt(pos, { marginM: 50 }) : [];
        S.here.set('지금 여기', here.map(x => ({ d: x.drawing, extra: x.outsideM > 0 ? `도면 밖 ${G.fmtM(x.outsideM)}` : '지금 도면 안' })), current, pick);
        const shown = new Set(here.map(x => x.drawing.id));
        const pinned = all.filter(d => d.pinned && !shown.has(d.id));
        S.pinned.set('고정', pinned.map(d => ({ d })), current, pick);
        for (const d of pinned) shown.add(d.id);
        const recent = all.filter(d => d.lastOpenedAt && !shown.has(d.id)).sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, RECENT_MAX);
        S.recent.set('최근 연 것', recent.map(d => ({ d })), current, pick);
        const byName = [...all].sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
        S.all.set(`전체 ${all.length}개`, byName.map(d => ({ d })), current, pick);
      }

      let uploading = false;
      function upload() {
        if (uploading) return;
        // 탭 안에서 바로 파일 고르기(지연 호출이면 브라우저가 막는다) — drawings 화면의 올리기와 같은 규칙
        pickFiles({ accept: ACCEPT, multiple: true })
          .then(files => uploadFiles(files, { onStatus: t => { status.hidden = !t; status.textContent = t; } }))
          .then(added => {
            if (!added?.length || picked !== null) return;
            if (added.length === 1) { pick(added[0].id); return; }
            input.value = ''; draw(); list.scrollTop = 0;
          }, e => { console.error('도면 올리기 실패', e); status.hidden = false; status.textContent = '올리지 못했어요'; })
          .finally(() => { uploading = false; upBtn.disabled = false; emptyUp.disabled = false; });
        uploading = true; upBtn.disabled = true; emptyUp.disabled = true;
      }

      D.ready().then(() => { ready = true; draw(); }, err => {
        console.error('도면보관함을 열지 못했어요', err);
        body.dataset.state = 'error'; none.hidden = false; none.textContent = '도면보관함을 열지 못했어요. 앱을 다시 열어 주세요';
      });
      offs.push(D.onDrawings(later), DT.onBuild(later));
      offs.push(safe(() => gps.on(s => {
        const p = s?.pos || null;
        if (!p === !pos && (!p || (p.lat === pos.lat && p.lng === pos.lng))) return;
        pos = p; later();
      }), () => {}));
      return body;
    }, {
      label: title, cls: 'dp-sheet',
      onClose: reason => { for (const f of offs) safe(f); resolve(reason === 'close' ? picked : null); },
    });
  });
}
