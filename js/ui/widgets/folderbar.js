// 폴더 부품 — 자료함(scope 'docs')·도면보관함(scope 'drawings')이 같이 쓴다(data/folders.js).
//   folderBar({ scope, folderId, onGo })          위쪽 빵 부스러기(자료함 › 101동 › 평면). 길면 앞을 … 로 줄이고(누르면 숨은 칸 고르기), 각 칸을 눌러 이동
//   folderRows({ scope, parentId, onOpen, onMenu }) 폴더 줄 목록(폴더 아이콘·이름·안의 개수). 바뀐 줄만 다시(syncList). 길게 누르면 onMenu
//   newFolderSheet(scope, parentId)               → Promise<새 폴더 id | null>
//   folderMenu(folderId)                          이름 바꾸기 · 옮기기 · 지우기(내용은 위 폴더로 + 5초 [되돌리기])
//   pickFolder({ scope, title, current, exclude }) → Promise<folderId | 'root' | null(취소)> — 시트 안에서 폴더 탐색 + [새 폴더] + [여기로]
//   selection({ onChange, onMove, onDelete })     여러 개 선택 + 아래 고정 막대('n개 고름' · [지우기] · [폴더로 옮기기] · [취소])
//   longPress(el, { onTap, onLong })              길게 누르기(450ms, 10px 넘게 움직이면 취소, 누른 뒤 click 은 먹는다)
//   whereText(scope, itemId) / whereTag(…)        찾기 결과 줄에 작게 보일 폴더 경로('101동 › 평면', 맨 위면 '' / null)
// 사용자 글(폴더 이름)은 textContent 로만 — innerHTML 금지.
import { h, icon, openSheet, textSheet, choose, snackbar, toast, syncList, liftSnack } from '../dom.js';
import * as F from '../../data/folders.js';

export const ROOT_LABEL = Object.freeze({ docs: '자료함', drawings: '도면보관함' });
const ITEM_WORD = Object.freeze({ docs: '자료', drawings: '도면' });
const LONG_MS = 450, MOVE_PX = 10;
const said = e => (e?.code && F.MESSAGES[e.code]) || (e?.code === 'QUOTA' ? '저장 공간이 부족해요' : '하지 못했어요');
const safe = f => { try { return f(); } catch (e) { console.error(e); return undefined; } };

// ---------- 길게 누르기 ----------
// 손가락(터치)·마우스 모두. 데스크톱 오른쪽 클릭(contextmenu)도 길게 누르기로. 해제 함수를 돌려준다
export function longPress(el, { onTap, onLong, ms = LONG_MS } = {}) {
  let t = 0, sx = 0, sy = 0, fired = false;
  const stop = () => { clearTimeout(t); t = 0; };
  const long = e => {
    stop(); fired = true;
    try { navigator.vibrate?.(12); } catch { /* 진동 없는 기기 */ }
    onLong?.(e);
  };
  const down = e => {
    if (e.button > 0) return;
    fired = false; sx = e.clientX; sy = e.clientY; stop();
    t = setTimeout(() => long(e), ms);
  };
  const move = e => { if (t && Math.hypot(e.clientX - sx, e.clientY - sy) > MOVE_PX) stop(); };
  const click = e => {
    if (fired) { fired = false; e.preventDefault(); e.stopPropagation(); return; }   // 길게 누른 뒤 따라오는 click 은 먹는다
    onTap?.(e);
  };
  const ctx = e => { e.preventDefault(); if (!fired) long(e); };                    // 안드로이드 길게 누르기 메뉴·오른쪽 클릭
  el.addEventListener('pointerdown', down);
  el.addEventListener('pointermove', move);
  for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.addEventListener(ev, stop);
  el.addEventListener('click', click);
  el.addEventListener('contextmenu', ctx);
  return () => {
    stop();
    el.removeEventListener('pointerdown', down);
    el.removeEventListener('pointermove', move);
    for (const ev of ['pointerup', 'pointercancel', 'pointerleave']) el.removeEventListener(ev, stop);
    el.removeEventListener('click', click);
    el.removeEventListener('contextmenu', ctx);
  };
}

// ---------- 빵 부스러기 ----------
// 맨 위 + 마지막 maxShown 칸만 보이고 그 사이는 「…」. 마지막 칸(지금 폴더)은 누를 수 없는 굵은 글.
// hideAtRoot: 맨 위에 있으면 숨긴다(화면 바 제목이 이미 「자료함」). 지금 폴더가 지워지면 가장 가까운 위 폴더로 onGo
function crumbs(host, { scope, cur, rootLabel, maxShown, go, testid }) {
  const items = [{ id: null, name: rootLabel }, ...F.path(cur)];
  let shown = items, hidden = [];
  if (items.length > maxShown + 2) {
    hidden = items.slice(1, items.length - maxShown);
    shown = [items[0], null, ...items.slice(-maxShown)];
  }
  const out = [];
  shown.forEach((it, i) => {
    if (i) out.push(h('span', { class: 'fb-sep', 'aria-hidden': 'true' }, icon('chev', 16)));
    if (it === null) {
      out.push(h('button', { type: 'button', class: 'fb-crumb fb-dots', 'data-testid': `${testid}-more`, 'aria-label': `위 폴더 ${hidden.length}개 더 보기`,
        onclick: async () => {
          const v = await choose({ title: '어느 폴더로 갈까요', options: hidden.map(f => ({ value: f.id, label: f.name })) });
          if (v) go(v);
        } }, h('span', { text: '…' })));
      return;
    }
    const last = i === shown.length - 1;
    out.push(last
      ? h('span', { class: 'fb-crumb cur', 'aria-current': 'page', 'data-testid': testid, 'data-id': it.id || '' }, h('span', { text: it.name }))
      : h('button', { type: 'button', class: 'fb-crumb', 'data-testid': testid, 'data-id': it.id || '', onclick: () => go(it.id) }, h('span', { text: it.name })));
  });
  host.replaceChildren(...out);
  requestAnimationFrame(() => { host.scrollLeft = host.scrollWidth; });        // 지금 폴더가 보이게(넘칠 때)
  return items;
}

export function folderBar({ scope, folderId = null, onGo, rootLabel = ROOT_LABEL[scope] || '맨 위', maxShown = 2, hideAtRoot = true } = {}) {
  let cur = F.resolveFolder(folderId);
  const el = h('nav', { class: 'fb-bar', 'aria-label': '폴더 위치', 'data-testid': 'folder-bar' });
  const go = id => { safe(() => onGo?.(id || null)); };
  function draw() {
    el.hidden = hideAtRoot && !cur;
    if (el.hidden) { el.replaceChildren(); return; }
    crumbs(el, { scope, cur, rootLabel, maxShown, go, testid: 'folder-crumb' });
  }
  const off = F.onFolders(ev => {
    if (!ev.folders) return;
    const r = F.resolveFolder(cur);
    if (r !== cur) { cur = r; draw(); go(r); return; }                          // 지금 폴더가 지워졌다 → 위로
    draw();
  });
  draw();
  return {
    el,
    set(id) { const r = F.resolveFolder(id); if (r === cur && el.childElementCount) return; cur = r; draw(); },
    current: () => cur,
    destroy: off,
  };
}

// ---------- 폴더 줄 ----------
function countText(scope, c) {
  if (!c) return '비어 있어요';
  const parts = [];
  if (c.folders) parts.push(`폴더 ${c.folders}`);
  if (c.items) parts.push(`${ITEM_WORD[scope] || '항목'} ${c.items}`);
  return parts.length ? parts.join(' · ') : '비어 있어요';
}
// items: () => 살아 있는 자료 목록(id·{id}) — 휴지통 자료를 개수에서 빼려면 준다. 안 주면 배치 기록대로
export function folderRows({ scope, parentId = null, onOpen, onMenu, items = null } = {}) {
  let cur = F.resolveFolder(parentId);
  const el = h('div', { class: 'fb-rows', role: 'list', 'data-testid': 'folder-rows' });
  el.hidden = true;
  const row = (f, text) => {
    const open = h('button', { type: 'button', class: 'fb-open', 'aria-label': `${f.name} 폴더, ${text}` },
      h('span', { class: 'fb-ico', 'aria-hidden': 'true' }, icon('folder', 22)),
      h('span', { class: 'fb-main' }, h('span', { class: 'fb-name', text: f.name }), h('span', { class: 'fb-sub', text })));
    longPress(open, { onTap: () => onOpen?.(f.id), onLong: () => onMenu?.(f.id) });
    return h('div', { class: 'fb-row', role: 'listitem', 'data-testid': 'folder-row', 'data-id': f.id }, open,
      onMenu ? h('button', { type: 'button', class: 'icbtn fb-menu', 'data-testid': 'folder-menu', 'aria-label': `${f.name} 폴더 메뉴`, onclick: () => onMenu(f.id) }, icon('more')) : null);
  };
  function draw() {
    const list = F.folders(scope, cur);
    el.hidden = !list.length;
    const c = list.length ? F.counts(scope, { items: items ? safe(items) || [] : null }) : {};
    syncList(el, list, { key: f => f.id, sig: f => `${f.name}|${countText(scope, c[f.id])}`, make: f => row(f, countText(scope, c[f.id])) });
  }
  const off = F.onFolders(draw);
  draw();
  return {
    el,
    set(id) { cur = F.resolveFolder(id); draw(); },
    refresh: draw,                                                                // 자료가 늘거나 줄면(개수) 부른다
    size: () => el.childElementCount,
    destroy: off,
  };
}

// ---------- 새 폴더 ----------
function whereLabel(scope, parentId) {
  return [ROOT_LABEL[scope] || '맨 위', ...F.path(parentId).map(f => f.name)].join(' › ');
}
export async function newFolderSheet(scope, parentId = null) {
  const v = await textSheet({ title: '새 폴더', placeholder: '폴더 이름', okLabel: '만들기', hint: `${whereLabel(scope, parentId)} 안에 만들어요` });
  if (v == null) return null;
  if (!v.trim()) { toast('폴더 이름을 적어 주세요'); return null; }
  try {
    const f = await F.createFolder(scope, parentId, v);
    toast(f.name === F.cleanFolderName(v) ? '폴더를 만들었어요' : `같은 이름이 있어 「${f.name}」 이름으로 만들었어요`);
    return f.id;
  } catch (e) { console.error('폴더 만들기 실패', e); toast(said(e)); return null; }
}

// ---------- 폴더 메뉴 ----------
// → Promise<'rename' | 'move' | 'delete' | null>
export async function folderMenu(folderId) {
  const f = F.folder(folderId);
  if (!f || f.deletedAt) return null;
  const c = F.counts(f.scope)[f.id] || { folders: 0, items: 0 };
  const has = c.folders || c.items;
  const v = await choose({ title: f.name, options: [
    { value: 'rename', label: '이름 바꾸기' },
    { value: 'move', label: '다른 폴더로 옮기기' },
    { value: 'delete', label: '폴더 지우기', sub: has ? '안에 든 것은 위 폴더로 옮겨요' : '빈 폴더예요' },
  ] });
  if (!v) return null;
  try {
    if (v === 'rename') {
      const n = await textSheet({ title: '폴더 이름 바꾸기', value: f.name, placeholder: '폴더 이름', okLabel: '바꾸기' });
      if (n == null || !n.trim() || F.cleanFolderName(n) === f.name) return null;
      const r = await F.renameFolder(folderId, n);
      toast(r.name === F.cleanFolderName(n) ? '이름을 바꿨어요' : `같은 이름이 있어 「${r.name}」 이름으로 바꿨어요`);
    } else if (v === 'move') {
      const to = await pickFolder({ scope: f.scope, title: `「${f.name}」 어디로 옮길까요`, current: F.parentOf(folderId), exclude: folderId });
      if (to == null) return null;
      await F.moveFolder(folderId, to);
      toast('폴더를 옮겼어요');
    } else if (v === 'delete') {
      const token = await F.deleteFolder(folderId);
      const up = token.moved.folders + token.moved.items;
      snackbar(up ? `「${f.name}」 폴더를 지웠어요 · 안의 ${up}개는 위로 옮겼어요` : `「${f.name}」 폴더를 지웠어요`, {
        actionLabel: '되돌리기',
        onAction: async () => { await F.undoDelete(token); toast('되돌렸어요'); },
      });
    }
    return v;
  } catch (e) { console.error('폴더 메뉴 동작 실패', e); toast(said(e)); return null; }
}

// ---------- 폴더 고르기 시트 ----------
// current: 지금 있는 자리(null = 맨 위) — 여기면 [여기로]가 꺼진다. exclude: 들어갈 수 없는 폴더(옮기는 폴더 자신 — 그 아래도 같이)
// 새 폴더는 시트 안 입력 줄에서(시트는 한 번에 하나라 글 입력 시트를 겹쳐 못 띄운다). 만들면 그 폴더로 들어간다
export function pickFolder({ scope, title = '어느 폴더로 옮길까요', current = null, exclude = null, okLabel = '여기로' } = {}) {
  const ex = new Set((Array.isArray(exclude) ? exclude : [exclude]).filter(Boolean));
  const here = F.resolveFolder(current);
  const blocked = id => [...ex].some(x => id && F.path(id).some(f => f.id === x));
  return new Promise(resolve => {
    let picked = null;
    const offs = [];
    openSheet(close => {
      let at = blocked(here) ? F.parentOf([...ex][0]) : here;
      while (at && blocked(at)) at = F.parentOf(at);
      const crumbHost = h('nav', { class: 'fb-bar fb-pbar', 'aria-label': '보고 있는 폴더', 'data-testid': 'pick-folder-bar' });
      const list = h('div', { class: 'fb-plist', role: 'list', 'data-testid': 'pick-folder-list' });
      const none = h('p', { class: 'fb-pnone', text: '안에 폴더가 없어요' });
      const input = h('input', {
        type: 'text', class: 'sheet-field fb-newq', placeholder: '폴더 이름', 'aria-label': '새 폴더 이름', 'data-testid': 'pick-folder-name',
        autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'done',
      });
      let composing = false;
      input.addEventListener('compositionstart', () => { composing = true; });
      input.addEventListener('compositionend', () => { composing = false; });
      input.addEventListener('keydown', e => { if (e.key === 'Enter' && !composing && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); make(); } });
      const makeBtn = h('button', { type: 'button', class: 'secondary fb-newok', 'data-testid': 'pick-folder-make', text: '만들기', onpointerdown: e => e.preventDefault(), onclick: () => make() });
      const newRow = h('div', { class: 'fb-newrow' }, input, makeBtn);
      newRow.hidden = true;
      const newBtn = h('button', { type: 'button', class: 'secondary', 'data-testid': 'pick-folder-new' }, icon('plus', 20), '새 폴더');
      const okBtn = h('button', { type: 'button', class: 'primary', 'data-testid': 'pick-folder-ok', onclick: () => { picked = at || 'root'; close(); } });
      newBtn.addEventListener('click', () => {
        newRow.hidden = false;
        input.value = '';
        input.focus({ preventScroll: true });                                           // 탭 안에서 바로 — 키보드가 뜬다
      });
      const head = h('div', { class: 'fb-phead' }, h('h2', { class: 'sheet-title fb-ptitle', text: title }),
        h('button', { type: 'button', class: 'icbtn fb-px', 'aria-label': '닫기', 'data-testid': 'pick-folder-close', onclick: () => close() }, icon('close', 22)));
      const body = h('div', { class: 'fb-pbody', 'data-testid': 'pick-folder' }, head, crumbHost, newRow, list, none,
        h('div', { class: 'fb-pacts' }, newBtn, okBtn));

      let creating = false;
      async function make() {
        const name = input.value;
        if (creating) return;
        if (!name.trim()) { input.blur(); newRow.hidden = true; return; }
        creating = true; makeBtn.disabled = true;
        try {
          const f = await F.createFolder(scope, at, name);
          input.value = ''; newRow.hidden = true; input.blur();
          go(f.id);
        } catch (e) { console.error('폴더 만들기 실패', e); toast(said(e)); }
        finally { creating = false; makeBtn.disabled = false; }
      }
      function go(id) { at = F.resolveFolder(id); newRow.hidden = true; draw(); list.scrollTop = 0; }

      const prow = f => {
        const isHere = f.id === here;
        const c = counts[f.id];
        const sub = c && (c.folders || c.items) ? countText(scope, c) : '비어 있어요';
        return h('button', { type: 'button', class: 'fb-prow', role: 'listitem', 'data-testid': 'pick-folder-row', 'data-id': f.id, onclick: () => go(f.id) },
          h('span', { class: 'fb-ico', 'aria-hidden': 'true' }, icon('folder', 22)),
          h('span', { class: 'fb-main' }, h('span', { class: 'fb-name', text: f.name }),
            h('span', { class: 'fb-sub' }, isHere ? h('b', { class: 'fb-here', text: '지금 여기' }) : null, sub)),
          h('span', { class: 'chev', 'aria-hidden': 'true' }, icon('chev', 20)));
      };
      let counts = {};
      function draw() {
        crumbs(crumbHost, { scope, cur: at, rootLabel: ROOT_LABEL[scope] || '맨 위', maxShown: 2, go, testid: 'pick-folder-crumb' });
        const kids = F.folders(scope, at).filter(f => !ex.has(f.id));
        counts = F.counts(scope);
        syncList(list, kids, { key: f => f.id, sig: f => `${f.name}|${countText(scope, counts[f.id])}|${f.id === here ? 1 : 0}`, make: prow });
        none.hidden = !!kids.length;
        const same = (at || null) === (here || null);
        okBtn.disabled = same;
        okBtn.textContent = same ? '지금 여기 있어요' : okLabel;
        okBtn.setAttribute('aria-label', same ? '지금 여기 있어요' : `${[ROOT_LABEL[scope], ...F.path(at).map(f => f.name)].join(' › ')}(으)로 ${okLabel}`);
      }
      offs.push(F.onFolders(ev => { if (ev.folders) { at = F.resolveFolder(at); draw(); } }));
      F.ready().then(draw, e => { console.error(e); none.hidden = false; none.textContent = '폴더를 읽지 못했어요. 앱을 다시 열어 주세요'; });
      draw();
      return body;
    }, {
      label: title, cls: 'fb-sheet',
      onClose: reason => { for (const off of offs) safe(off); resolve(reason === 'close' ? picked : null); },
    });
  });
}

// ---------- 여러 개 선택 ----------
// 화면: 줄을 만들 때 sel.bind(줄의 누르는 칸, id, { onOpen }) — 평소 탭 = onOpen, 길게 누르기 = 선택 모드 시작, 선택 모드에서 탭 = 고르기/풀기.
// sel.el 은 화면(.screen) 맨 끝에 붙인다(아래 고정 막대, 고른 게 없으면 숨김). 뒤로 가기는 화면이 sel.active() 면 sel.clear() 로.
export function selection({ onChange, onMove, onDelete, onAll, moveLabel = '폴더로 옮기기', deleteLabel = '지우기' } = {}) {
  const ids = new Set();
  const rows = new Map();                                                          // id → 누르는 칸(마지막에 bind 한 것)
  const count = h('b', { class: 'fb-selcount', 'aria-live': 'polite', 'data-testid': 'select-count' });
  const busyRun = fn => async () => {
    if (!ids.size || el.dataset.busy) return;
    el.dataset.busy = '1';
    try { await fn([...ids]); } catch (e) { console.error('선택 동작 실패', e); toast(said(e)); } finally { delete el.dataset.busy; }
  };
  const moveBtn = h('button', { type: 'button', class: 'primary', 'data-testid': 'select-move', onclick: busyRun(list => onMove?.(list)) }, icon('folder', 22), moveLabel);
  const delBtn = h('button', { type: 'button', class: 'secondary', 'data-testid': 'select-delete', onclick: busyRun(list => onDelete?.(list)) }, icon('trash', 20), deleteLabel);
  const el = h('div', { class: 'fb-selbar', role: 'toolbar', 'aria-label': '고른 것', 'data-testid': 'select-bar' },
    h('div', { class: 'fb-selhead' }, count,
      onAll ? h('button', { type: 'button', class: 'textbtn fb-selall', 'data-testid': 'select-all', text: '모두 고르기', onclick: () => safe(onAll) }) : null,
      h('button', { type: 'button', class: 'textbtn fb-selx', 'data-testid': 'select-cancel', text: '취소', onclick: () => api.clear() })),
    h('div', { class: 'fb-selbtns' }, onDelete ? delBtn : null, onMove ? moveBtn : null));
  el.hidden = true;
  let unlift = null;

  function mark(id, node) {
    if (!node) return;
    const on = ids.has(id);
    node.classList.toggle('fb-picking', ids.size > 0);
    node.classList.toggle('fb-picked', on);
    if (ids.size) node.setAttribute('aria-pressed', on ? 'true' : 'false'); else node.removeAttribute('aria-pressed');
  }
  function update(all = true) {
    const n = ids.size;
    el.hidden = !n;
    count.textContent = `${n}개 고름`;
    if (n && !unlift) unlift = liftSnack(el);
    if (!n && unlift) { unlift(); unlift = null; }
    if (all) for (const [id, node] of rows) { if (!node.isConnected && !ids.has(id)) { rows.delete(id); continue; } mark(id, node); }
    safe(() => onChange?.(n, [...ids]));
  }
  const api = {
    el,
    toggle(id, on) {
      const want = on == null ? !ids.has(id) : !!on;
      if (want === ids.has(id)) return;
      const was = ids.size;
      if (want) ids.add(id); else ids.delete(id);
      if (!was !== !ids.size) update(); else { mark(id, rows.get(id)); update(false); }   // 모드가 바뀔 때만 모든 줄, 아니면 그 줄만
    },
    has: id => ids.has(id),
    size: () => ids.size,
    ids: () => [...ids],
    active: () => ids.size > 0,
    set(list) { ids.clear(); for (const id of list || []) ids.add(id); update(); },
    clear() { if (!ids.size) return; ids.clear(); update(); },
    retain(alive) { const keep = new Set(Array.from(alive || [], x => (x && typeof x === 'object' ? x.id : x))); let n = 0; for (const id of [...ids]) if (!keep.has(id)) { ids.delete(id); n++; } if (n) update(); },
    // 줄을 만들 때마다 부른다(syncList 가 다시 만든 줄도) — 체크 동그라미를 앞에 끼우고 누르기를 잇는다
    bind(node, id, { onOpen } = {}) {
      if (!node.querySelector(':scope > .fb-check')) node.prepend(h('span', { class: 'fb-check', 'aria-hidden': 'true' }, icon('check', 18)));
      rows.set(id, node);
      longPress(node, {
        onTap: () => { if (ids.size) api.toggle(id); else onOpen?.(id); },
        onLong: () => api.toggle(id, true),
      });
      mark(id, node);
      return node;
    },
    destroy() { ids.clear(); rows.clear(); if (unlift) { unlift(); unlift = null; } },
  };
  return api;
}

// ---------- 찾기 결과 줄의 폴더 경로 ----------
export function whereText(scope, itemId) {
  const fid = F.folderOf(scope, itemId);
  return fid ? F.path(fid).map(f => f.name).join(' › ') : '';
}
// 같은 것을 줄 아랫줄에 끼울 작은 표지(폴더 아이콘 + 경로). 맨 위면 null
export function whereTag(scope, itemId) {
  const t = whereText(scope, itemId);
  return t ? h('span', { class: 'fb-where', 'data-testid': 'item-where', title: t }, icon('folder', 14), h('span', { text: t })) : null;
}
