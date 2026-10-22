// 자료함 `docs`(SPEC §10.6) — 도면·문서를 올려 두고 현장에서 바로 연다. 컨셉 s-docs 느낌 + CLAUDE.md 사용성 크기 표.
// 바(뒤로·자료함·[올리기]·[⋮]) → 검색 → 지금 위치 근처(노란 상자, 200m·최대 3) → 칩 → 고정 → 전체 → 지운 자료.
// 줄을 누르면 docview, 줄 끝 [⋮] 은 이름·태그·고정·위치 연결·촬영할 때 띄우기·공유·삭제.
// 도면 파일(PDF·DWG·DXF·그림 — drawings.drawingKind)이면 [⋮] 에 [도면보관함으로 옮기기](docs/도면보관함-설계.md §2): 옮기고 자료함에서는 지운다, 5초 [되돌리기].
// DWG·DXF 를 자료함에 올리면 처음 한 번만 "도면은 도면보관함에 넣으면 핀·길찾기가 돼요 [옮기기]".
// docview.js 가 같은 동작을 쓰도록 메뉴·공유·아이콘 도우미를 이름 붙여 내보낸다(라우터는 default 만 쓴다).
// 폴더(v0.1.5, data/folders.js · widgets/folderbar.js): 바 아래 빵 부스러기 → 폴더 줄 → 자료. 줄을 길게 누르면 여러 개 고르기 → [폴더로 옮기기]·[지우기](5초 되돌리기).
//   올리기는 지금 폴더로, 찾기는 전체(결과 줄에 폴더 경로), 근처·고정은 맨 위에서만. 휴대폰 뒤로 = 고르기 풀기 → 위 폴더 → 나가기.
import { h, toast, snackbar, openSheet, textSheet, confirmModal, choose, pickFiles, lockButton } from '../dom.js';
import * as D from '../../data/docs.js';
import * as FD from '../../data/folders.js';
import { folderBar, folderRows, folderMenu, newFolderSheet, newFolderRow, selectHint, pickFolder, selection, whereTag, whereText } from '../widgets/folderbar.js';
import * as store from '../../data/store.js';
import * as gps from '../../services/gps.js';
import * as N from '../../platform/native.js';

// ---- 아이콘(자료함 전용 — 스프라이트에 없는 모양은 여기서 path 로 그린다) ----
const PATHS = {
  drawing: ['M4 4h16v16H4z', 'M4 10h7v10', 'M11 4v4', 'M15 14h5', 'M15 14v6'],
  pdf: ['M6 3h9l4 4v14H6z', 'M14 3v5h5', 'M9 13h6', 'M9 17h4'],
  doc: ['M6 3h9l4 4v14H6z', 'M14 3v5h5', 'M9 12h7', 'M9 15h7', 'M9 18h5'],
  sheet: ['M4 5h16v14H4z', 'M4 10h16', 'M4 14.5h16', 'M10 5v14'],
  slide: ['M3 5h18v11H3z', 'M12 16v4', 'M8 20h8'],
  image: ['M4 5h16v14H4z', 'M4 16l5-5 4 4 3-3 4 4', 'M15.5 8.5h.01'],
  other: ['M6 3h9l4 4v14H6z', 'M14 3v5h5'],
  pin: ['M9 4h6', 'M10 4v6l-3 4h10l-3-4V4', 'M12 14v6'],
  more: ['M12 5h.01', 'M12 12h.01', 'M12 19h.01'],
  upload: ['M12 16V4', 'M7 9l5-5 5 5', 'M5 20h14'],
  search: ['M10.5 4a6.5 6.5 0 1 1 0 13a6.5 6.5 0 1 1 0-13z', 'M20 20l-4.6-4.6'],
  locate: ['M12 21s-6-5.6-6-11a6 6 0 0 1 12 0c0 5.4-6 11-6 11z', 'M12 8.5a1.5 1.5 0 1 1 0 3a1.5 1.5 0 1 1 0-3z'],
  back: ['M15 5l-7 7 7 7'],
  camera: ['M4 8h3l2-3h6l2 3h3v11H4z', 'M12 10a3.5 3.5 0 1 1 0 7a3.5 3.5 0 1 1 0-7z'],
  close: ['M6 6l12 12', 'M18 6L6 18'],
};
export function dxIcon(name, size = 24) {
  const svg = h('svg', { class: 'ic', viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': 'true', focusable: 'false' });
  for (const d of PATHS[name] || PATHS.other) svg.append(h('path', { d }));
  return svg;
}

export const KIND_LABEL = { drawing: '도면', pdf: 'PDF', doc: '문서', sheet: '표', slide: '발표', image: '그림', other: '파일' };
const CHIPS = [['all', '전체'], ['drawing', '도면'], ['pdf', 'PDF'], ['doc', '문서'], ['sheet', '표'], ['image', '그림'], ['pinned', '고정']];
const NEAR_R = 200, NEAR_MAX = 3;
const CHIP_KEY = 'lite.docsChip';
const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* 저장 못 해도 그만 */ } };
const fmtM = m => (m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`);
let backHook = null;                                        // 붙어 있는 자료함 화면의 뒤로(고르기 풀기 → 위 폴더)

// ---- 현재 위치 한 번 얻기(최근 2분 안 값이 있으면 그것, 없으면 GPS 를 잠깐 켜고 10초까지) ----
export async function fixNow({ maxAge = 120000, wait = 10000 } = {}) {
  const fresh = s => (s?.pos && Date.now() - (s.pos.at || 0) <= maxAge ? s.pos : null);
  let p = fresh(gps.snapshot());
  if (p) return p;
  const stop = gps.start();
  try {
    p = await new Promise(resolve => {
      let off = () => {};
      const t = setTimeout(() => { off(); resolve(null); }, wait);
      off = gps.on(s => {
        const q = fresh(s);
        if (q || ['denied', 'unsupported'].includes(s?.state)) { clearTimeout(t); off(); resolve(q); }
      });
      const q = fresh(gps.snapshot());
      if (q) { clearTimeout(t); off(); resolve(q); }
    });
  } finally { stop(); }
  return p;
}

// ---- 원본 파일 공유 ----
export async function shareDoc(d) {
  const blob = await D.docBlob(d.id);
  if (!blob) { toast('파일이 없어요. 다시 올려 주세요'); return; }
  if (N.isNative()) {
    const uri = await N.writeCache(`share/${Date.now()}/${d.name}`, blob);
    await N.shareFiles([uri], { title: d.name });
    return;
  }
  const file = new File([blob], d.name, { type: d.mime || blob.type || 'application/octet-stream' });
  if (navigator.canShare?.({ files: [file] })) {
    try { await navigator.share({ files: [file], title: d.name }); } catch (err) { if (err?.name !== 'AbortError') throw err; }
    return;
  }
  const url = URL.createObjectURL(file);
  const a = h('a', { href: url, download: d.name, style: { display: 'none' } });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  toast('내려받았어요');
}

// ---- 도면보관함으로 옮기기(도면 파일만) ----
// 도면보관함 모듈이 없거나 실패하면 null(메뉴에 안 보이고, 눌러도 조용히 실패 토스트)
let dwgP = null;
let dwgSync = null;                                         // 메뉴를 열 때 동기로 판단하려고(자료함 화면이 열릴 때 미리 불러 둔다 — 모듈만, DB 는 열지 않는다)
const dwgMod = () => (dwgP ||= import('../../data/drawings.js').then(m => (dwgSync = m)).catch(err => { console.warn('도면보관함 모듈 없음', err); dwgP = null; return null; }));
export const prepDrawings = () => dwgMod();
export const canMoveToDrawings = d => !!d && !!dwgSync?.drawingKind?.(d.name);

// 옮기기 = 원본을 도면보관함에 새로 넣고(addDrawingFiles) → 자료함에서는 지우기(휴지통). 되돌리기 = 도면보관함 쪽 영구 삭제 + 자료 되살리기
const MOVE_UNDO_MS = 5000;
export async function moveToDrawings(ids) {
  const M = await dwgMod();
  if (!M) { toast('도면보관함을 열지 못했어요'); return 0; }
  const list = (Array.isArray(ids) ? ids : [ids]).map(id => D.doc(id)).filter(d => d && !d.deletedAt && M.drawingKind?.(d.name));
  if (!list.length) return 0;
  let site = '';
  try { site = store.settings()?.siteName || ''; } catch { /* 설정 없음 */ }
  if (list.length > 1) toast(`옮기는 중… ${list.length}개`, 60000);
  const moved = [];
  await FD.ready().catch(() => null);                       // 폴더 경로를 도면보관함에도 같게(못 열면 맨 위로)
  for (const d of list) {
    try {
      const blob = await D.docBlob(d.id);
      if (!blob) throw Object.assign(new Error('파일 없음'), { code: 'NO_FILE' });
      const { added, failed } = await M.addDrawingFiles([new File([blob], d.name, { type: d.mime || blob.type || '' })], { site: d.site || site, fromDocId: d.id });
      if (!added?.length) throw Object.assign(new Error(failed?.[0]?.reason || '옮기지 못했어요'), { code: failed?.[0]?.code || 'ERROR' });
      await followFolder(d.id, added[0].id);
      await D.deleteDoc(d.id);
      moved.push({ docId: d.id, drawingId: added[0].id });
    } catch (err) {
      console.error('도면보관함으로 옮기지 못했다', d.name, err);
      toast(err?.code === 'QUOTA' ? '저장 공간이 부족해요' : (err?.code === 'NO_FILE' ? '파일이 없어요. 다시 올려 주세요' : `못 옮겼어요: ${err?.message || d.name}`), 4000);
    }
  }
  if (!moved.length) return 0;
  // 그림(타일) 만들기 줄에 미리 세운다 — 열 때 기다리지 않게(drawtiles 가 한가할 때 돈다). 모듈이 없으면 열 때 만든다
  import('../../media/drawtiles.js').then(DT => { for (const m of moved) DT.queueDrawing?.(m.drawingId, { page: 1 })?.catch?.(() => {}); })
    .catch(err => console.warn('도면 그림 줄을 못 세웠다', err));
  // 되돌리기 기회가 지나면 자료함 쪽은 영구 삭제(「지운 자료」에 남아 되살리면 같은 도면이 둘이 되지 않게)
  let undone = false;
  setTimeout(() => { if (!undone) for (const m of moved) D.purgeDoc(m.docId).catch(err => console.warn('옮긴 자료를 치우지 못했다', err)); }, MOVE_UNDO_MS + 500);
  snackbar(moved.length === 1 ? '도면보관함으로 옮겼어요' : `도면 ${moved.length}개를 도면보관함으로 옮겼어요`, {
    actionLabel: '되돌리기', ms: MOVE_UNDO_MS,
    onAction: async () => {
      undone = true;
      for (const m of moved) {
        await D.restoreDoc(m.docId);
        await (M.purgeDrawing || M.deleteDrawing)(m.drawingId).catch(err => console.warn('옮긴 도면을 치우지 못했다', err));
      }
    },
  });
  return moved.length;
}

// 자료함 「101동 › 평면」 안 자료를 옮기면 도면보관함에도 같은 이름 폴더 길을 찾아(없으면 만들어) 그 안에 넣는다. 실패해도 옮기기는 그대로(맨 위)
async function followFolder(docId, drawingId) {
  try {
    const names = FD.path(FD.folderOf('docs', docId)).map(f => f.name);
    if (!names.length) return;
    let parent = null;
    for (const n of names) {
      const hit = FD.folders('drawings', parent).find(f => f.name === n);
      parent = hit ? hit.id : (await FD.createFolder('drawings', parent, n)).id;
    }
    await FD.placeItems('drawings', [drawingId], parent);
  } catch (err) { console.warn('도면보관함 폴더를 맞추지 못했다(맨 위에 둠)', err); }
}

// ---- 지우기(5초 되돌리기) ----
export async function removeDoc(d) {
  await D.deleteDoc(d.id);
  snackbar('자료를 지웠어요', { actionLabel: '되돌리기', onAction: () => D.restoreDoc(d.id) });
}

// ---- 자료 하나의 메뉴(자료함 줄 [⋮], 자료 보기 [⋮]) ----
// nav 가 있으면 '촬영할 때 띄우기'를 보여 준다. { skipPin } — 자료 보기는 바에 고정 버튼이 따로 있다
export async function docMenu(id, nav, { inViewer = false } = {}) {
  const d = D.doc(id);
  if (!d) return;
  const options = [
    { value: 'rename', label: '이름 바꾸기' },
    { value: 'tags', label: '태그 고치기', sub: d.tags || '찾을 때 쓸 말을 적어 둬요' },
    inViewer ? null : { value: 'pin', label: d.pinned ? '고정 풀기' : '맨 위에 고정' },
    d.anchor ? { value: 'unanchor', label: '위치 연결 풀기', sub: '지금은 이 자료에 위치가 연결돼 있어요' }
      : { value: 'anchor', label: '현재 위치 연결', sub: '여기 오면 "지금 위치 근처"에 떠요' },
    nav && !inViewer ? { value: 'capture', label: '촬영할 때 띄우기' } : null,
    { value: 'folder', label: '폴더로 옮기기', sub: whereText('docs', id) ? `지금: ${whereText('docs', id)}` : '지금: 맨 위' },
    canMoveToDrawings(d) ? { value: 'todrawings', label: '도면보관함으로 옮기기', sub: '도면에 핀을 찍고 길을 찾을 수 있어요' } : null,
    { value: 'share', label: '공유(원본 파일)' },
    { value: 'delete', label: '지우기' },
  ].filter(Boolean);
  const pick = await choose({ title: d.name, options });
  if (!pick) return;
  try {
    if (pick === 'rename') {
      const v = await textSheet({ title: '이름 바꾸기', value: d.name, okLabel: '바꾸기' });
      if (v != null && v.trim() && v.trim() !== d.name) { await D.updateDoc(id, { name: v.trim() }); toast('이름을 바꿨어요'); }
    } else if (pick === 'tags') {
      const v = await textSheet({ title: '태그', value: d.tags || '', placeholder: '띄어 쓰면 태그가 나뉘어요', okLabel: '저장' });
      if (v != null) { await D.updateDoc(id, { tags: v }); toast('태그를 저장했어요'); }
    } else if (pick === 'pin') {
      await D.updateDoc(id, { pinned: !d.pinned }); toast(d.pinned ? '고정을 풀었어요' : '맨 위에 고정했어요');
    } else if (pick === 'anchor') {
      toast('위치를 찾는 중이에요…', 10000);
      const p = await fixNow();
      if (!p) { toast('위치를 못 찾았어요. GPS 를 켜고 다시 해 주세요'); return; }
      await D.updateDoc(id, { anchor: { lat: p.lat, lng: p.lng, acc: p.acc, at: p.at || Date.now() } });
      toast('현재 위치를 연결했어요');
    } else if (pick === 'unanchor') {
      await D.updateDoc(id, { anchor: null }); toast('위치 연결을 풀었어요');
    } else if (pick === 'capture') {
      nav.go('capture', { docId: id });
    } else if (pick === 'folder') {
      await FD.ready();
      const to = await pickFolder({ scope: 'docs', current: FD.folderOf('docs', id) });
      if (to == null) return;
      const r = await FD.placeItems('docs', [id], to);
      if (r.moved) snackbar('폴더로 옮겼어요', { actionLabel: '되돌리기', onAction: () => r.undo() });
    } else if (pick === 'todrawings') {
      if (await moveToDrawings(id) && inViewer) nav?.back();
    } else if (pick === 'share') {
      await shareDoc(D.doc(id));
    } else if (pick === 'delete') {
      if (inViewer) nav?.back();
      await removeDoc(d);
    }
  } catch (err) {
    console.error('자료 메뉴 동작 실패', err);
    toast(err?.code === 'QUOTA' ? '저장 공간이 부족해요' : '하지 못했어요');
  }
}

// ---- 올리기 ----
async function upload(folderId = null) {
  const files = await pickFiles({ accept: '', multiple: true });
  if (!files.length) return;
  let site = '';
  try { site = store.settings()?.siteName || ''; } catch { /* 설정 없음 */ }
  const { added, failed } = await D.addDocs(files, {
    site,
    onProgress: (i, n) => { if (n > 1 && i < n) toast(`올리는 중… ${i + 1}/${n}`, 60000); },
  });
  if (folderId && added.length) await FD.placeItems('docs', added.map(d => d.id), folderId).catch(err => { console.warn('올린 자료를 폴더에 못 넣었다', err); toast('폴더에 못 넣어 맨 위에 뒀어요'); });
  if (failed.length && !added.length) toast(failed.length === 1 ? `못 올렸어요: ${failed[0].reason}` : `${failed.length}개를 못 올렸어요`, 4000);
  else if (failed.length) toast(`${added.length}개 올렸어요 · ${failed.length}개는 못 올렸어요(${failed[0].reason})`, 4000);
  else toast(added.length === 1 ? '자료를 올렸어요' : `자료 ${added.length}개를 올렸어요`);
  // CAD 도면(DWG·DXF·DWT)은 도면보관함이 제자리 — 처음 한 번만 알려 준다(PDF 는 문서일 수도 있어 묻지 않는다)
  const cad = added.filter(d => /\.(dwg|dxf|dwt)$/i.test(d.name || ''));
  if (cad.length && !lsGet(CAD_HINT) && await dwgMod()) {
    lsSet(CAD_HINT, '1');
    snackbar('도면은 도면보관함에 넣으면 핀·길찾기가 돼요', { actionLabel: '옮기기', ms: 6000, onAction: () => moveToDrawings(cad.map(d => d.id)) });
  }
}
const CAD_HINT = 'lite.docsCadHint';

// ---- 오프라인 준비: 문서 엔진 미리 받기(SPEC §10.3) ----
// viewer/engines.json 의 주소를 차례로 fetch → PWA 는 sw.js 'av-engines-v1', APK 는 EngineCacheWebViewClient 가 기기에 저장한다
const ENGINES_AT = 'lite.enginesAt';
export async function prefetchEngines({ onProgress, signal, all = false } = {}) {
  const res = await fetch('viewer/engines.json', { cache: 'no-cache' });
  if (!res.ok) throw new Error(`engines.json ${res.status}`);
  const list = (await res.json()).files.filter(f => all || f.main !== false);
  let done = 0, bytes = 0, failed = 0;
  for (const f of list) {
    if (signal?.aborted) break;
    try {
      const r = await fetch(f.url, { mode: 'cors', credentials: 'omit', signal });
      if (!r.ok) throw new Error(String(r.status));
      bytes += (await r.arrayBuffer()).byteLength;               // 본문을 끝까지 읽어야 캐시에 다 들어간다
    } catch (err) { if (signal?.aborted) break; failed++; console.warn('엔진을 받지 못했어요', f.url, err?.message || err); }
    done++;
    try { onProgress?.({ done, total: list.length, bytes, failed }); } catch (e) { console.error(e); }
  }
  if (!signal?.aborted && !failed) lsSet(ENGINES_AT, String(Date.now()));
  return { done, total: list.length, bytes, failed, aborted: !!signal?.aborted };
}
async function engineTotal() {
  try { const j = await (await fetch('viewer/engines.json', { cache: 'no-cache' })).json(); return j.files.filter(f => f.main !== false).reduce((s, f) => s + (f.bytes || 0), 0); }
  catch { return 0; }
}
function enginesSheet() {
  const ac = new AbortController();
  openSheet(close => {
    const at = Number(lsGet(ENGINES_AT) || 0);
    const info = h('p', { class: 'note', text: '와이파이에서 받는 걸 권해요.' });
    const bar = h('div', { class: 'dx-prog', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0' }, h('i'));
    bar.hidden = true;
    const line = h('p', { class: 'dx-progtext', 'data-testid': 'engines-status', role: 'status', text: at ? `받아 둔 날: ${new Date(at).toLocaleDateString('ko-KR')}` : '아직 받지 않았어요' });
    engineTotal().then(t => { if (t) info.textContent = `PDF·도면·한글·엑셀·워드 엔진, 약 ${D.fmtSize(t)}. 와이파이에서 받는 걸 권해요.`; });
    const go = h('button', { type: 'button', class: 'primary', 'data-testid': 'engines-get', text: at ? '다시 받기' : '받기' });
    lockButton(go, async () => {
      bar.hidden = false; go.disabled = true;
      line.textContent = '받는 중…';
      const r = await prefetchEngines({
        signal: ac.signal,
        onProgress: p => {
          const pct = Math.round((p.done / p.total) * 100);
          bar.firstChild.style.width = `${pct}%`; bar.setAttribute('aria-valuenow', String(pct));
          line.textContent = `받는 중… ${p.done}/${p.total} · ${D.fmtSize(p.bytes)}`;
        },
      }).catch(err => { console.error(err); return null; });
      go.disabled = false;
      if (!r) { line.textContent = '목록을 못 읽었어요. 인터넷을 확인해 주세요'; return; }
      if (r.aborted) return;
      line.textContent = r.failed ? `${r.total - r.failed}/${r.total}개 받았어요 · ${r.failed}개 실패(인터넷 확인 뒤 다시 받기)` : `다 받았어요 · ${D.fmtSize(r.bytes)}. 이제 인터넷 없이 열려요`;
      go.textContent = '다시 받기';
    });
    return h('div', { class: 'sheet-body' },
      h('h2', { class: 'sheet-title', text: '오프라인 준비' }),
      h('p', { class: 'dx-sheettext', text: '지하처럼 신호가 없는 곳에서도 도면이 열리게 문서 엔진을 미리 받아 둬요.' }),
      info, bar, line,
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'secondary', 'data-testid': 'sheet-cancel', text: '닫기', onclick: () => close() }), go));
  }, { label: '오프라인 준비', onClose: () => ac.abort() });
}

// ---- 지운 자료 ----
function trashSheet() {
  openSheet(close => {
    const list = h('div', { class: 'rows dx-trash' });
    const draw = () => {
      const items = D.docs({ deleted: true });
      list.replaceChildren(...(items.length ? items.map(d => h('div', { class: 'row dx-trow', 'data-id': d.id },
        h('span', { class: 'body' }, h('span', { class: 't dx-name', text: d.name }),
          h('span', { class: 's', text: `${new Date(d.deletedAt).toLocaleDateString('ko-KR')}에 지움` })),
        h('button', { type: 'button', class: 'dx-small', text: '되살리기', onclick: async () => { await D.restoreDoc(d.id); toast('되살렸어요'); draw(); } }),
        h('button', { type: 'button', class: 'dx-small dx-danger', text: '영구 삭제', onclick: async () => {
          if (!(await confirmModal({ title: '영구 삭제할까요?', text: `${d.name} 파일이 기기에서 지워져요.`, okLabel: '영구 삭제', danger: true }))) return;
          await D.purgeDoc(d.id); draw();
        } })))
        : [h('p', { class: 'note dx-pad', text: '지운 자료가 없어요' })]));
    };
    draw();
    return h('div', { class: 'sheet-body' }, h('h2', { class: 'sheet-title', text: '지운 자료' }),
      h('p', { class: 'note', text: '30일이 지나면 저절로 지워져요.' }), list,
      h('button', { type: 'button', class: 'textbtn', 'data-testid': 'sheet-cancel', text: '닫기', onclick: () => close() }));
  }, { label: '지운 자료' });
}

// ---- 줄 ----
function metaLine(d, extra, where) {
  return h('span', { class: 's' },
    h('span', { class: 'dx-mini', text: KIND_LABEL[d.kind] || '파일' }),
    h('span', { text: D.fmtSize(d.size) }),
    ...String(d.tags || '').split(/\s+/).filter(Boolean).slice(0, 3).map(t => h('span', { class: 'dx-mini', text: t })),
    d.anchor ? h('span', { class: 'dx-anch' }, dxIcon('locate', 16), '위치 연결됨') : null,
    extra || null, where || null);
}
// sel 이 있으면 평소 탭 = 열기, 길게 누르기 = 여러 개 고르기(widgets/folderbar.js selection). where = 찾기 결과의 폴더 경로 표지
function docRow(d, nav, { extra, testid = 'doc-row', sel = null, where = null } = {}) {
  const openIt = () => nav.go('docview', { id: d.id });
  const open = h('button', { type: 'button', class: 'dx-open' },
    h('span', { class: ['docico', `k-${d.kind}`] }, dxIcon(d.pinned ? 'pin' : d.kind)),
    h('span', { class: 'body' }, h('span', { class: 't dx-name', text: d.name }), metaLine(d, extra, where)));
  if (sel) sel.bind(open, d.id, { onOpen: openIt }); else open.onclick = openIt;
  return h('div', { class: 'dx-row', 'data-testid': testid, 'data-id': d.id }, open,
    h('button', { type: 'button', class: 'icbtn dx-menu', 'data-testid': 'doc-menu', 'aria-label': `${d.name} 메뉴`, onclick: () => docMenu(d.id, nav) }, dxIcon('more')));
}

export default {
  onBack() { return backHook?.() || false; },
  mount(root, params, nav) {
    dwgMod();
    const page = h('div', { class: 'dx-page' });
    let chip = CHIPS.some(([v]) => v === lsGet(CHIP_KEY)) ? lsGet(CHIP_KEY) : 'all';
    let q = '';
    let lastPos = null;
    let cur = params.folder || null;                       // 스택 params 에 적어 둔다 — 자료 보기에 다녀와 다시 mount 돼도 그 폴더
    let fReady = false;

    const upBtn = h('button', { type: 'button', class: 'barlink', 'data-testid': 'docs-upload', 'aria-label': '자료 올리기' }, dxIcon('upload', 22), '올리기');
    lockButton(upBtn, () => upload(cur));
    const moreBtn = h('button', { type: 'button', class: 'icbtn', 'data-testid': 'docs-more', 'aria-label': '더 보기', onclick: async () => {
      const n = D.docs({ deleted: true }).length;
      const v = await choose({ title: '자료함', options: [
        { value: 'newfolder', label: '새 폴더' },
        { value: 'engines', label: '오프라인 준비: 문서 엔진 받기', sub: '신호 없는 곳에서도 PDF·도면이 열리게' },
        { value: 'trash', label: `지운 자료 ${n}개`, sub: '되살리기·영구 삭제' },
      ] });
      if (v === 'newfolder') { await FD.ready().catch(() => null); newFolderSheet('docs', cur); }
      if (v === 'engines') enginesSheet();
      if (v === 'trash') trashSheet();
    } }, dxIcon('more'));
    const title = h('h1', { 'data-testid': 'docs-title', text: '자료함' });
    const bar = h('div', { class: 'bar' },
      h('button', { type: 'button', class: 'icbtn', 'aria-label': '뒤로', onclick: () => nav.back() }, dxIcon('back')),
      title, upBtn, moreBtn);

    const input = h('input', { type: 'text', enterkeyhint: 'search', 'data-testid': 'docs-search', placeholder: '이름·태그로 찾기', 'aria-label': '자료 찾기',
      autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false' });
    let qRaf = 0;
    input.addEventListener('input', () => { q = input.value; if (!qRaf) qRaf = requestAnimationFrame(() => { qRaf = 0; drawList(); }); });   // 한 그림에 한 번(빠르게 쳐도 목록은 한 번만)
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    const clearQ = h('button', { type: 'button', class: 'icbtn dx-clear', 'aria-label': '지우기', onclick: () => { input.value = ''; q = ''; drawList(); input.focus(); } }, dxIcon('close', 20));
    const search = h('label', { class: 'dx-search' }, dxIcon('search'), input, clearQ);

    // ---- 폴더·여러 개 고르기 ----
    let shownIds = [];
    const sel = selection({
      onMove: async ids => {
        const to = await pickFolder({ scope: 'docs', current: cur });
        if (to == null) return;
        const r = await FD.placeItems('docs', ids, to);
        sel.clear();
        snackbar(`${r.moved || ids.length}개를 옮겼어요`, { actionLabel: '되돌리기', onAction: () => r.undo() });
      },
      onDelete: async ids => {
        for (const id of ids) await D.deleteDoc(id);
        sel.clear();
        snackbar(`자료 ${ids.length}개를 지웠어요`, { actionLabel: '되돌리기', onAction: async () => { for (const id of ids) await D.restoreDoc(id); } });
      },
      onAll: () => sel.set(shownIds),
      onChange: n => { if (n) hint.done(); },
    });
    const fbar = folderBar({ scope: 'docs', folderId: null, onGo: id => goFolder(id) });
    const frows = folderRows({ scope: 'docs', parentId: null, onOpen: id => goFolder(id), onMenu: id => folderMenu(id, { items: () => D.docs() }), items: () => D.docs() });
    const newRow = newFolderRow({ scope: 'docs', parent: () => cur });
    const hint = selectHint('docs');
    const fwrap = h('div', { class: 'dx-folders' }, frows.el, newRow, hint.el);
    const setTitle = () => { title.textContent = cur ? (FD.folder(cur)?.name || '자료함') : '자료함'; };
    function goFolder(id) {
      cur = FD.resolveFolder(id); params.folder = cur;
      sel.clear(); fbar.set(cur); frows.set(cur);
      setTitle();
      drawNear(); drawList();
      root.scrollTop = 0;
    }
    backHook = () => {
      if (sel.active()) { sel.clear(); return true; }
      if (cur) { goFolder(FD.parentOf(cur)); return true; }
      return false;
    };

    const near = h('div', { class: 'dx-reco', 'data-testid': 'docs-nearby' });
    near.hidden = true;
    const chips = h('div', { class: 'chips dx-chips', role: 'radiogroup', 'aria-label': '종류' },
      ...CHIPS.map(([v, label]) => h('button', { type: 'button', class: 'chip', role: 'radio', 'data-testid': 'docs-chip', 'data-value': v, text: label,
        onclick: () => { chip = v; lsSet(CHIP_KEY, v); sel.clear(); drawList(); } })));
    const listBox = h('div', { class: 'dx-list' });
    page.append(bar, fbar.el, search, near, chips, fwrap, listBox);
    root.append(page, sel.el);                             // 고르기 막대는 화면 맨 끝(아래 고정)

    function drawNear() {
      const items = lastPos && !cur ? D.nearby(lastPos, { radius: NEAR_R }).slice(0, NEAR_MAX) : [];   // 근처는 맨 위에서만
      near.hidden = !items.length;
      if (!items.length) { near.replaceChildren(); return; }
      near.replaceChildren(h('h3', { text: '지금 위치 근처' }),
        ...items.map(({ doc, dist }) => docRow(doc, nav, { testid: 'docs-nearby-row', extra: h('b', { class: 'dx-dist', text: fmtM(dist) }) })));
    }

    function drawList() {
      for (const b of chips.children) { const on = b.dataset.value === chip; b.classList.toggle('sel', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); }
      clearQ.hidden = !q;
      const all = D.docs();
      const nFolders = fReady ? FD.folders('docs', cur).length : 0;
      if (!all.length && !cur && !nFolders) {
        chips.hidden = true; search.hidden = true; fwrap.hidden = true; shownIds = [];
        const up2 = h('button', { type: 'button', class: 'primary dx-emptybtn', text: '올리기' });
        lockButton(up2, () => upload(cur));
        listBox.replaceChildren(h('div', { class: 'dx-empty' },
          h('span', { class: 'docico dx-bigico' }, dxIcon('drawing', 32)),
          h('p', { text: '도면·문서 파일을 올려 두면 현장에서 바로 열어 볼 수 있어요' }),
          h('p', { class: 'note', text: 'PDF · 도면(DWG·DXF) · 한글 · 엑셀 · 워드 · 그림' }), up2), trashLink() || '');
        return;
      }
      chips.hidden = !all.length; search.hidden = !all.length;
      const searching = !!q.trim();
      const kind = chip === 'all' || chip === 'pinned' ? null : chip;
      const found = D.searchDocs(q, { kind, pinned: chip === 'pinned' ? true : null });
      // 찾기·맨 위의 종류 칩은 전체(줄에 폴더 경로), 폴더 안에서는 그 폴더만
      const wide = searching || (!cur && chip !== 'all');
      const base = wide || !fReady ? found : FD.itemsIn('docs', cur, found);
      fwrap.hidden = searching || chip !== 'all' || !fReady;
      hint.show(!cur && !nFolders && base.length >= 5 && !FD.allFolders('docs').length);
      const row = (d, where = wide) => docRow(d, nav, { sel, where: where && fReady ? whereTag('docs', d.id) : null });
      const out = [];
      let shown = [];
      if (chip === 'all' && !searching) {
        let rest = base;
        if (!cur) {
          const pinned = found.filter(d => d.pinned);                      // 고정은 맨 위에서만 — 어느 폴더에 있든 모아 보인다
          if (pinned.length) { out.push(h('h3', { class: 'sec', text: '고정' }), h('div', { class: 'rows' }, ...pinned.map(d => row(d, true)))); shown.push(...pinned); }
          rest = base.filter(d => !d.pinned);
        }
        if (rest.length) {
          out.push(h('h3', { class: 'sec', text: cur ? `자료 ${rest.length}개` : nFolders ? `폴더 밖 자료 ${rest.length}개` : `전체 ${all.length}개` }));
          out.push(h('div', { class: 'rows' }, ...rest.map(d => row(d, false))));
          shown.push(...rest);
        } else if (cur && !nFolders) out.push(h('p', { class: 'note dx-pad', 'data-testid': 'docs-folder-empty', text: '빈 폴더예요. 여기서 올리면 이 폴더에 들어가요' }));
        else if (!cur && !nFolders && all.length) out.push(h('p', { class: 'note', text: '모두 고정돼 있어요' }));
      } else {
        out.push(h('h3', { class: 'sec', text: `찾은 자료 ${base.length}개` }));
        out.push(base.length ? h('div', { class: 'rows' }, ...base.map(d => row(d))) : h('p', { class: 'note', text: searching ? '맞는 자료가 없어요. 다른 말로 찾아 보세요' : cur ? '이 폴더에는 이 종류의 자료가 없어요' : '이 종류의 자료가 없어요' }));
        shown = base;
      }
      shownIds = shown.map(d => d.id);
      out.push(trashLink());
      listBox.replaceChildren(...out.filter(Boolean));
    }
    function trashLink() {
      const n = D.docs({ deleted: true }).length;
      return n ? h('button', { type: 'button', class: 'textbtn', 'data-testid': 'docs-trash', text: `지운 자료 ${n}개`, onclick: trashSheet }) : null;
    }
    const draw = () => { drawNear(); drawList(); };

    let off = () => {}, offF = () => {}, offGps = () => {}, stopGps = () => {}, dead = false;
    const fP = FD.ready().then(() => true, err => { console.warn('폴더를 열지 못했어요(폴더 없이 보여요)', err); return false; });
    Promise.all([D.ready(), fP]).then(([, okF]) => {
      if (dead) return;
      fReady = okF;
      if (okF) {
        cur = FD.resolveFolder(cur); params.folder = cur;
        fbar.set(cur); frows.set(cur); setTitle();
        offF = FD.onFolders(ev => {
          if (ev.folders && cur && FD.resolveFolder(cur) !== cur) return;  // 지금 폴더가 지워졌다 — folderBar 의 onGo 가 위로 데려간다
          setTitle(); drawList();
        });
      } else cur = null;
      draw();
      off = D.onDocs(() => { draw(); frows.refresh(); sel.retain(D.docs()); });
    }, err => { console.error(err); listBox.replaceChildren(h('p', { class: 'note', text: '자료함을 열지 못했어요. 앱을 다시 열어 주세요' })); });
    try {
      stopGps = gps.start();                                 // 이 화면이 보일 때만
      const onSnap = s => { const p = s?.pos || null; const moved = !lastPos !== !p || (p && (p.lat !== lastPos.lat || p.lng !== lastPos.lng)); lastPos = p; if (moved) drawNear(); };
      offGps = gps.on(onSnap);
      onSnap(gps.snapshot());
    } catch (err) { console.warn('GPS 를 켜지 못했어요', err); }

    return () => {
      dead = true; off(); offF(); offGps(); stopGps();
      cancelAnimationFrame(qRaf);
      fbar.destroy(); frows.destroy(); sel.destroy();
      backHook = null;
    };
  },
};
