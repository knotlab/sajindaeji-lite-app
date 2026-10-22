// 자료함 `docs`(SPEC §10.6) — 도면·문서를 올려 두고 현장에서 바로 연다. 컨셉 s-docs 느낌 + CLAUDE.md 사용성 크기 표.
// 바(뒤로·자료함·[올리기]·[⋮]) → 검색 → 지금 위치 근처(노란 상자, 200m·최대 3) → 칩 → 고정 → 전체 → 지운 자료.
// 줄을 누르면 docview, 줄 끝 [⋮] 은 이름·태그·고정·위치 연결·촬영할 때 띄우기·공유·삭제.
// docview.js 가 같은 동작을 쓰도록 메뉴·공유·아이콘 도우미를 이름 붙여 내보낸다(라우터는 default 만 쓴다).
import { h, toast, snackbar, openSheet, textSheet, confirmModal, choose, pickFiles, lockButton } from '../dom.js';
import * as D from '../../data/docs.js';
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
    { value: 'tags', label: '태그 고치기', sub: d.tags || '동·층·공종 같은 말을 적어 두면 찾기 쉬워요' },
    inViewer ? null : { value: 'pin', label: d.pinned ? '고정 풀기' : '맨 위에 고정' },
    d.anchor ? { value: 'unanchor', label: '위치 연결 풀기', sub: '지금은 이 자료에 위치가 연결돼 있어요' }
      : { value: 'anchor', label: '현재 위치 연결', sub: '여기 오면 "지금 위치 근처"에 떠요' },
    nav && !inViewer ? { value: 'capture', label: '촬영할 때 띄우기' } : null,
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
      const v = await textSheet({ title: '태그', value: d.tags || '', placeholder: '예) 101동 5층 평면 타일', okLabel: '저장' });
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
async function upload() {
  const files = await pickFiles({ accept: '', multiple: true });
  if (!files.length) return;
  let site = '';
  try { site = store.settings()?.siteName || ''; } catch { /* 설정 없음 */ }
  const { added, failed } = await D.addDocs(files, {
    site,
    onProgress: (i, n) => { if (n > 1 && i < n) toast(`올리는 중… ${i + 1}/${n}`, 60000); },
  });
  if (failed.length && !added.length) toast(failed.length === 1 ? `못 올렸어요: ${failed[0].reason}` : `${failed.length}개를 못 올렸어요`, 4000);
  else if (failed.length) toast(`${added.length}개 올렸어요 · ${failed.length}개는 못 올렸어요(${failed[0].reason})`, 4000);
  else toast(added.length === 1 ? '자료를 올렸어요' : `자료 ${added.length}개를 올렸어요`);
}

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
function metaLine(d, extra) {
  return h('span', { class: 's' },
    h('span', { class: 'dx-mini', text: KIND_LABEL[d.kind] || '파일' }),
    h('span', { text: D.fmtSize(d.size) }),
    ...String(d.tags || '').split(/\s+/).filter(Boolean).slice(0, 3).map(t => h('span', { class: 'dx-mini', text: t })),
    d.anchor ? h('span', { class: 'dx-anch' }, dxIcon('locate', 16), '위치 연결됨') : null,
    extra || null);
}
function docRow(d, nav, { extra, testid = 'doc-row' } = {}) {
  return h('div', { class: 'dx-row', 'data-testid': testid, 'data-id': d.id },
    h('button', { type: 'button', class: 'dx-open', onclick: () => nav.go('docview', { id: d.id }) },
      h('span', { class: ['docico', `k-${d.kind}`] }, dxIcon(d.pinned ? 'pin' : d.kind)),
      h('span', { class: 'body' }, h('span', { class: 't dx-name', text: d.name }), metaLine(d, extra))),
    h('button', { type: 'button', class: 'icbtn dx-menu', 'data-testid': 'doc-menu', 'aria-label': `${d.name} 메뉴`, onclick: () => docMenu(d.id, nav) }, dxIcon('more')));
}

export default {
  mount(root, params, nav) {
    const page = h('div', { class: 'dx-page' });
    let chip = CHIPS.some(([v]) => v === lsGet(CHIP_KEY)) ? lsGet(CHIP_KEY) : 'all';
    let q = '';
    let lastPos = null;

    const upBtn = h('button', { type: 'button', class: 'barlink', 'data-testid': 'docs-upload', text: '올리기' });
    lockButton(upBtn, upload);
    const moreBtn = h('button', { type: 'button', class: 'icbtn', 'data-testid': 'docs-more', 'aria-label': '더 보기', onclick: async () => {
      const n = D.docs({ deleted: true }).length;
      const v = await choose({ title: '자료함', options: [
        { value: 'engines', label: '오프라인 준비: 문서 엔진 받기', sub: '신호 없는 곳에서도 PDF·도면이 열리게' },
        { value: 'trash', label: `지운 자료 ${n}개`, sub: '되살리기·영구 삭제' },
      ] });
      if (v === 'engines') enginesSheet();
      if (v === 'trash') trashSheet();
    } }, dxIcon('more'));
    const bar = h('div', { class: 'bar' },
      h('button', { type: 'button', class: 'icbtn', 'aria-label': '뒤로', onclick: () => nav.back() }, dxIcon('back')),
      h('h1', { text: '자료함' }), upBtn, moreBtn);

    const input = h('input', { type: 'text', enterkeyhint: 'search', 'data-testid': 'docs-search', placeholder: '이름·태그로 찾기(예: 5층 평면)', 'aria-label': '자료 찾기',
      autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'search' });
    let qRaf = 0;
    input.addEventListener('input', () => { q = input.value; if (!qRaf) qRaf = requestAnimationFrame(() => { qRaf = 0; drawList(); }); });   // 한 그림에 한 번(빠르게 쳐도 목록은 한 번만)
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    const clearQ = h('button', { type: 'button', class: 'icbtn dx-clear', 'aria-label': '지우기', onclick: () => { input.value = ''; q = ''; drawList(); input.focus(); } }, dxIcon('close', 20));
    const search = h('label', { class: 'dx-search' }, dxIcon('search'), input, clearQ);

    const near = h('div', { class: 'dx-reco', 'data-testid': 'docs-nearby' });
    near.hidden = true;
    const chips = h('div', { class: 'chips dx-chips', role: 'radiogroup', 'aria-label': '종류' },
      ...CHIPS.map(([v, label]) => h('button', { type: 'button', class: 'chip', role: 'radio', 'data-testid': 'docs-chip', 'data-value': v, text: label,
        onclick: () => { chip = v; lsSet(CHIP_KEY, v); drawList(); } })));
    const listBox = h('div', { class: 'dx-list' });
    page.append(bar, search, near, chips, listBox);
    root.append(page);

    function drawNear() {
      const items = lastPos ? D.nearby(lastPos, { radius: NEAR_R }).slice(0, NEAR_MAX) : [];
      near.hidden = !items.length;
      if (!items.length) { near.replaceChildren(); return; }
      near.replaceChildren(h('h3', { text: '지금 위치 근처' }),
        ...items.map(({ doc, dist }) => docRow(doc, nav, { testid: 'docs-nearby-row', extra: h('b', { class: 'dx-dist', text: fmtM(dist) }) })));
    }

    function drawList() {
      for (const b of chips.children) { const on = b.dataset.value === chip; b.classList.toggle('sel', on); b.setAttribute('aria-checked', on ? 'true' : 'false'); }
      clearQ.hidden = !q;
      const all = D.docs();
      if (!all.length) {
        chips.hidden = true; search.hidden = true;
        const up2 = h('button', { type: 'button', class: 'primary dx-emptybtn', text: '올리기' });
        lockButton(up2, upload);
        listBox.replaceChildren(h('div', { class: 'dx-empty' },
          h('span', { class: 'docico dx-bigico' }, dxIcon('drawing', 32)),
          h('p', { text: '도면·문서 파일을 올려 두면 현장에서 바로 열어 볼 수 있어요' }),
          h('p', { class: 'note', text: 'PDF · 도면(DWG·DXF) · 한글 · 엑셀 · 워드 · 그림' }), up2), trashLink() || '');
        return;
      }
      chips.hidden = false; search.hidden = false;
      const kind = chip === 'all' || chip === 'pinned' ? null : chip;
      const found = D.searchDocs(q, { kind, pinned: chip === 'pinned' ? true : null });
      const out = [];
      if (chip === 'all' && !q.trim()) {
        const pinned = found.filter(d => d.pinned), rest = found.filter(d => !d.pinned);
        if (pinned.length) out.push(h('h3', { class: 'sec', text: '고정' }), h('div', { class: 'rows' }, ...pinned.map(d => docRow(d, nav))));
        out.push(h('h3', { class: 'sec', text: `전체 ${all.length}개` }));
        if (rest.length) out.push(h('div', { class: 'rows' }, ...rest.map(d => docRow(d, nav))));
        else out.push(h('p', { class: 'note', text: '모두 고정돼 있어요' }));
      } else {
        out.push(h('h3', { class: 'sec', text: `찾은 자료 ${found.length}개` }));
        out.push(found.length ? h('div', { class: 'rows' }, ...found.map(d => docRow(d, nav))) : h('p', { class: 'note', text: q.trim() ? '맞는 자료가 없어요. 다른 말로 찾아 보세요' : '이 종류의 자료가 없어요' }));
      }
      out.push(trashLink());
      listBox.replaceChildren(...out.filter(Boolean));
    }
    function trashLink() {
      const n = D.docs({ deleted: true }).length;
      return n ? h('button', { type: 'button', class: 'textbtn', 'data-testid': 'docs-trash', text: `지운 자료 ${n}개`, onclick: trashSheet }) : null;
    }
    const draw = () => { drawNear(); drawList(); };

    let off = () => {}, offGps = () => {}, stopGps = () => {}, dead = false;
    D.ready().then(() => {
      if (dead) return;
      draw();
      off = D.onDocs(draw);
    }, err => { console.error(err); listBox.replaceChildren(h('p', { class: 'note', text: '자료함을 열지 못했어요. 앱을 다시 열어 주세요' })); });
    try {
      stopGps = gps.start();                                 // 이 화면이 보일 때만
      const onSnap = s => { const p = s?.pos || null; const moved = !lastPos !== !p || (p && (p.lat !== lastPos.lat || p.lng !== lastPos.lng)); lastPos = p; if (moved) drawNear(); };
      offGps = gps.on(onSnap);
      onSnap(gps.snapshot());
    } catch (err) { console.warn('GPS 를 켜지 못했어요', err); }

    return () => { dead = true; off(); offGps(); stopGps(); };
  },
};
