// 자료 고르기 시트 — 촬영 화면에서 자료함의 도면·엑셀·PDF·한글 등을 골라 띄운다(SPEC §10.6 도면 칩 [바꾸기]·[자료]).
// pickDoc({ title, current }) → Promise<고른 자료 id | null(취소)>
// 위: 검색칸(이름·태그·확장자, 치는 대로 거름 — 한글 조합 중 글자도 맞춘다), 아래 목록만 스크롤:
//   지금 위치 근처(gps.snapshot().pos 있을 때만, 200m·최대 3) → 고정 → 최근 연 것(최대 5) → 전체(이름순).
// 자료가 없으면 「자료함이 비어 있어요」 + [자료 올리기](파일 하나면 올리자마자 그 자료로 연다).
// 글자마다 하는 일: 미리 만들어 둔 소문자 글(문서마다 한 번)에 정규식 하나 — 목록은 한 그림에 한 번, 바뀐 줄만(syncList).
// 처음 여는 형식이 엔진을 받아야 하면(웹: Cache Storage 'av-engines-v1' 에 없음) 줄에 「처음엔 인터넷 필요」. 앱(APK)은 알 수 없어 미리 받기를 했을 때만 생략.
import { h, icon, openSheet, pickFiles, syncList } from '../dom.js';
import * as D from '../../data/docs.js';
import * as gps from '../../services/gps.js';
import * as store from '../../data/store.js';
import * as N from '../../platform/native.js';

const NEAR_R = 200, NEAR_MAX = 3, RECENT_MAX = 5;
const KIND_WORD = { drawing: '도면', pdf: '', doc: '문서', sheet: '표', slide: '발표', image: '그림', other: '파일' };
const KIND_ICON = { drawing: 'plan', pdf: 'doc', doc: 'doc', sheet: 'table', slide: 'image', image: 'image', other: 'doc' };
const fmtM = m => (m < 1000 ? `${Math.round(m)}m` : `${(m / 1000).toFixed(1)}km`);
const safe = (f, fb) => { try { const v = f(); return v === undefined ? fb : v; } catch { return fb; } };

// ---------- 찾기(한글 조합 중에도 끊기지 않게) ----------
// 칸에 「평며」(평면을 치는 중)·「ㅍ」만 있어도 「평면도」가 걸리게, 마지막 글자 하나만 「그 글자로 시작할 수 있는 글자」로 넓힌다.
const SBASE = 0xAC00, SLAST = 0xD7A3;
const CHO = 'ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ';
// 받침이 다음 글자 첫소리로 넘어갈 수 있다(「솧」→「소화」): 홑받침 → 첫소리 번호
const JONG_CHO = { 1: 0, 2: 1, 4: 2, 7: 3, 8: 5, 16: 6, 17: 7, 19: 9, 20: 10, 21: 11, 22: 12, 23: 14, 24: 15, 25: 16, 26: 17, 27: 18 };
// 겹받침 → [남는 받침, 넘어가는 첫소리]
const JONG_SPLIT = { 3: [1, 9], 5: [4, 12], 6: [4, 18], 9: [8, 0], 10: [8, 6], 11: [8, 7], 12: [8, 9], 13: [8, 16], 14: [8, 17], 15: [8, 18], 18: [17, 9] };
const reEsc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const hex = n => `\\u${n.toString(16).padStart(4, '0')}`;
const choRange = c => `[${hex(SBASE + c * 588)}-${hex(SBASE + c * 588 + 587)}]`;
function lastAlts(ch) {
  const c = ch.charCodeAt(0);
  const alts = [reEsc(ch)];
  const ci = CHO.indexOf(ch);
  if (ci >= 0) alts.push(choRange(ci));                                             // 홀자음 ㅍ → 파~핗
  else if (c >= SBASE && c <= SLAST) {
    const s = c - SBASE, jong = s % 28, base = c - jong;
    if (!jong) alts.push(`[${hex(c)}-${hex(c + 27)}]`);                             // 며 → 며~몋(「면」 포함)
    else if (JONG_CHO[jong] != null) alts.push(`${hex(base)}${choRange(JONG_CHO[jong])}`);       // 솧 → 소+ㅎ…
    else if (JONG_SPLIT[jong]) { const [keep, next] = JONG_SPLIT[jong]; alts.push(`${hex(base + keep)}${choRange(next)}`); }
  }
  return alts;
}
// 공백으로 나눈 낱말 모두(AND, 대소문자 무시). 마지막 낱말의 마지막 글자만 넓힌다. 빈 글이면 null
export function makeMatcher(q) {
  const words = String(q ?? '').normalize('NFC').toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return null;
  const last = words.pop();
  const head = reEsc(last.slice(0, -1)), tail = last.slice(-1);
  const re = new RegExp(`${head}(?:${lastAlts(tail).join('|')})`);
  return hay => words.every(w => hay.includes(w)) && re.test(hay);
}
const hays = new Map();                                                              // id → { at, text } (문서마다 한 번)
function hayOf(d) {
  const at = d.updatedAt || d.addedAt || 0;
  let e = hays.get(d.id);
  if (!e || e.at !== at) { e = { at, text: `${d.name} ${d.tags || ''} ${d.ext || ''}`.normalize('NFC').toLowerCase() }; hays.set(d.id, e); }
  return e.text;
}

// ---------- 엔진 준비(처음 여는 형식이면 인터넷이 필요) ----------
// 확장자 → engines.json 의 묶음 이름. 없는 형식(DXF·그림·글)은 엔진 없이 열린다
const ENGINE_GROUP = {
  pdf: 'PDF', dwg: 'DWG 도면', dwt: 'DWG 도면',
  xlsx: '엑셀', xlsm: '엑셀', xlsb: '엑셀', xls: '엑셀', ods: '엑셀', csv: '엑셀', tsv: '엑셀',
  docx: '워드', hwp: '한글(HWP)', hwpx: '한글(HWP)', rtf: 'RTF', doc: '공통(압축·OLE)',
};
const ENGINE_CACHE = 'av-engines-v1';
const ENGINES_AT = 'lite.enginesAt';                                                // 자료함 [오프라인 준비]가 다 받으면 남기는 값
const ENGINES_URL = new URL('../../../viewer/engines.json', import.meta.url).href;
let engineState = null;                                                              // Map(묶음 → true 준비됨 | false 필요) · null 모름
let engineCheck = null;
const enginesAt = () => safe(() => Number(localStorage.getItem(ENGINES_AT) || 0), 0);
export function needsNet(ext) {
  const g = ENGINE_GROUP[String(ext || '').toLowerCase()];
  if (!g || !engineState) return false;
  return engineState.get(g) === false;
}
// 열 때마다 다시 본다(그새 다른 문서를 열어 엔진이 들어왔을 수 있다). 결과가 바뀌면 true
async function checkEngines() {
  if (engineCheck) return engineCheck;
  engineCheck = (async () => {
    const before = engineState ? JSON.stringify([...engineState]) : '';
    if (N.isNative() || typeof caches === 'undefined') { engineState = null; return before !== ''; }   // 앱: 네이티브 저장소라 여기서 못 본다 → 표시 생략
    try {
      const list = (await (await fetch(ENGINES_URL)).json()).files.filter(f => f.main !== false);
      const has = await caches.has(ENGINE_CACHE);
      const cache = has ? await caches.open(ENGINE_CACHE) : null;
      const groups = new Map();
      for (const f of list) (groups.get(f.group) || groups.set(f.group, []).get(f.group)).push(f.url);
      const next = new Map();
      for (const [g, urls] of groups) {
        // 묶음의 앞 두 파일(엔진 본체)만 본다 — PDF 처럼 부속이 수십 개인 것도 열 때마다 가볍게
        let ok = !!cache;
        for (const u of urls.slice(0, 2)) { if (!ok) break; ok = !!(await cache.match(u, { ignoreVary: true })); }
        next.set(g, ok);
      }
      engineState = next;
    } catch (err) {
      console.warn('엔진 준비 상태를 못 읽었어요', err);
      engineState = null;
    }
    return before !== (engineState ? JSON.stringify([...engineState]) : '');
  })().finally(() => { engineCheck = null; });
  return engineCheck;
}

// ---------- 줄 ----------
const baseName = d => (d.ext && d.name.toLowerCase().endsWith(`.${d.ext}`) ? d.name.slice(0, -(d.ext.length + 1)) : d.name) || d.name;
function kindMark(d) {
  const ext = String(d.ext || '').toUpperCase();
  const w = KIND_WORD[d.kind] ?? '파일';
  if (d.kind === 'pdf') return 'PDF';
  return ext ? (w ? `${w} ${ext}` : ext) : w || '파일';
}
function rowSig(d, cur, extra) { return `${d.updatedAt}|${d.id === cur ? 1 : 0}|${needsNet(d.ext) ? 1 : 0}|${extra || ''}`; }
function makeRow(d, cur, extra, onPick) {
  const isCur = d.id === cur;
  return h('button', {
    type: 'button', class: ['dp-row', isCur && 'cur'], 'data-testid': 'doc-picker-row', 'data-id': d.id, 'data-kind': d.kind,
    'aria-label': `${d.name}${isCur ? ', 보는 중' : ''}`, 'aria-current': isCur ? 'true' : null, title: d.name,
    onclick: () => onPick(d.id),
  },
  h('span', { class: ['dp-ico', `k-${d.kind}`], 'aria-hidden': 'true' }, icon(KIND_ICON[d.kind] || 'doc', 22)),
  h('span', { class: 'dp-main' },
    h('span', { class: 'dp-name', text: baseName(d) }),
    h('span', { class: 'dp-sub' },
      isCur ? h('span', { class: 'dp-cur', 'data-testid': 'doc-picker-current' }, icon('check', 14), '보는 중') : null,   // 이름 자리를 줄이지 않게 아랫줄에
      h('span', { class: 'dp-kind', text: kindMark(d) }),
      h('span', { class: 'dp-size', text: D.fmtSize(d.size) }),
      extra ? h('b', { class: 'dp-dist', text: extra }) : null,
      needsNet(d.ext) ? h('span', { class: 'dp-net', 'data-testid': 'doc-picker-net', text: '처음엔 인터넷 필요' }) : null)));
}

// 구역 하나: 머리 + 줄 상자(바뀐 줄만 다시)
function section(name) {
  const head = h('h3', { class: 'dp-sec' });
  const rows = h('div', { class: 'dp-rows', 'data-section': name });
  const el = h('section', { class: 'dp-group', 'data-section': name }, head, rows);
  el.hidden = true;
  return {
    el,
    set(title, items, cur, onPick) {                                                   // items: [{ d, extra }]
      el.hidden = !items.length;
      if (head.textContent !== title) head.textContent = title;
      syncList(rows, items, { key: x => x.d.id, sig: x => rowSig(x.d, cur, x.extra), make: x => makeRow(x.d, cur, x.extra, onPick) });
    },
  };
}

// ---------- 시트 ----------
export function pickDoc({ title = '자료 열기', current = null } = {}) {
  return new Promise(resolve => {
    let picked = null;
    const offs = [];
    openSheet(close => {
      const pick = id => { picked = id; close(); };

      // 검색칸 — 글자마다 목록은 한 그림에 한 번(rAF). 조합 중 글자도 그대로 걸러 깜빡이지 않게(makeMatcher)
      const input = h('input', {
        type: 'text', class: 'dp-q', 'data-testid': 'doc-picker-search', placeholder: '이름·태그·확장자로 찾기', 'aria-label': '자료 찾기',
        autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', enterkeyhint: 'search',
      });
      let composing = false, raf = 0;
      const later = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; draw(); }); };
      input.addEventListener('input', later);
      input.addEventListener('compositionstart', () => { composing = true; });
      input.addEventListener('compositionend', () => { composing = false; later(); });
      input.addEventListener('keydown', e => {
        if (e.key !== 'Enter' || composing || e.isComposing || e.keyCode === 229) return;
        e.preventDefault();
        if (lastFound.length === 1) pick(lastFound[0].id);                            // 하나만 걸렸으면 바로 연다
        else input.blur();                                                             // 아니면 키보드만 내려 목록을 넓게
      });
      const clearBtn = h('button', {
        type: 'button', class: 'dp-clear', 'aria-label': '찾는 글 지우기', onpointerdown: e => e.preventDefault(),
        onclick: () => { input.value = ''; draw(); input.focus({ preventScroll: true }); },
      }, icon('close', 20));
      const search = h('label', { class: 'dp-search' }, icon('search', 20), input, clearBtn);

      const upBtn = h('button', { type: 'button', class: 'dp-up', 'data-testid': 'doc-picker-upload', onclick: () => upload() }, icon('upload', 20), '올리기');
      const closeBtn = h('button', { type: 'button', class: 'dp-x', 'aria-label': '닫기', 'data-testid': 'doc-picker-close', onclick: () => close() }, icon('close', 22));
      const header = h('div', { class: 'dp-head' }, h('h2', { class: 'sheet-title dp-title', text: title }), upBtn, closeBtn);
      const status = h('p', { class: 'dp-status', role: 'status', 'data-testid': 'doc-picker-status' });
      status.hidden = true;

      const S = { fresh: section('fresh'), near: section('near'), pinned: section('pinned'), recent: section('recent'), all: section('all'), found: section('found') };
      const none = h('p', { class: 'dp-none', 'data-testid': 'doc-picker-none' });
      none.hidden = true;
      const emptyUp = h('button', { type: 'button', class: 'primary dp-emptybtn', 'data-testid': 'doc-picker-empty-upload', onclick: () => upload() }, icon('upload', 22), '자료 올리기');
      const empty = h('div', { class: 'dp-empty', 'data-testid': 'doc-picker-empty' },
        h('span', { class: 'dp-ico dp-bigico', 'aria-hidden': 'true' }, icon('folder', 30)),
        h('p', { class: 'dp-empty-t', text: '자료함이 비어 있어요' }),
        h('p', { class: 'dp-empty-s', text: '도면·엑셀·PDF·한글 파일을 올리면 바로 열어 볼 수 있어요' }),
        emptyUp);
      empty.hidden = true;
      const list = h('div', { class: 'dp-list' }, empty, ...Object.values(S).map(s => s.el), none);
      const body = h('div', { class: 'dp-body', 'data-testid': 'doc-picker' }, header, search, status, list);
      body.dataset.state = 'loading';

      let ready = false, lastFound = [], freshIds = [], pos = safe(() => gps.snapshot()?.pos, null) || null;

      function draw() {
        if (!ready) return;
        const all = D.docs();
        const q = input.value;
        clearBtn.hidden = !q;
        const isEmpty = !all.length;
        empty.hidden = !isEmpty;
        search.hidden = isEmpty;
        upBtn.hidden = isEmpty;                                                        // 빈 상태에선 가운데 큰 버튼 하나만
        body.dataset.state = isEmpty ? 'empty' : q.trim() ? 'search' : 'list';
        if (isEmpty) { for (const s of Object.values(S)) s.set('', [], current, pick); none.hidden = true; lastFound = []; return; }
        const match = makeMatcher(q);
        if (match) {
          const found = all.filter(d => match(hayOf(d)))
            .sort((a, b) => (b.pinned - a.pinned) || a.name.localeCompare(b.name, 'ko', { numeric: true }));
          lastFound = found;
          for (const k of ['fresh', 'near', 'pinned', 'recent', 'all']) S[k].set('', [], current, pick);
          S.found.set(`찾은 자료 ${found.length}개`, found.map(d => ({ d })), current, pick);
          none.hidden = !!found.length;
          none.textContent = '맞는 자료가 없어요. 다른 말로 찾아 보세요';
          return;
        }
        lastFound = all;
        none.hidden = true;
        S.found.set('', [], current, pick);
        const byId = new Map(all.map(d => [d.id, d]));
        const fresh = freshIds.map(id => byId.get(id)).filter(Boolean);
        S.fresh.set('방금 올림', fresh.map(d => ({ d })), current, pick);
        const near = pos ? D.nearby(pos, { radius: NEAR_R }).slice(0, NEAR_MAX) : [];
        S.near.set('지금 위치 근처', near.map(x => ({ d: x.doc, extra: fmtM(x.dist) })), current, pick);
        const pinned = all.filter(d => d.pinned);
        S.pinned.set('고정', pinned.map(d => ({ d })), current, pick);
        const shown = new Set([...near.map(x => x.doc.id), ...pinned.map(d => d.id)]);
        const recent = all.filter(d => d.lastOpenedAt && !shown.has(d.id))
          .sort((a, b) => b.lastOpenedAt - a.lastOpenedAt).slice(0, RECENT_MAX);
        S.recent.set('최근 연 것', recent.map(d => ({ d })), current, pick);
        const byName = [...all].sort((a, b) => a.name.localeCompare(b.name, 'ko', { numeric: true }));
        S.all.set(`전체 ${all.length}개`, byName.map(d => ({ d })), current, pick);
      }

      // 올리기 — 탭 안에서 바로 파일 고르기(지연 호출이면 브라우저가 막는다)
      let uploading = false;
      function upload() {
        if (uploading) return;
        const got = pickFiles({ accept: '', multiple: true });
        got.then(async files => {
          if (!files.length || picked !== null) return;
          uploading = true; upBtn.disabled = true; emptyUp.disabled = true;
          status.hidden = false; status.textContent = '올리는 중…';
          const site = safe(() => store.settings()?.siteName || '', '');
          try {
            const { added, failed } = await D.addDocs(files, {
              site,
              onProgress: (i, n) => { if (n > 1 && i < n) status.textContent = `올리는 중… ${i + 1}/${n}`; },
            });
            if (added.length === 1 && !failed.length) { pick(added[0].id); return; }     // 하나면 바로 그 자료로
            freshIds = [...added.map(d => d.id), ...freshIds.filter(id => !added.some(d => d.id === id))];
            status.textContent = failed.length
              ? (added.length ? `${added.length}개 올렸어요 · ${failed.length}개는 못 올렸어요(${failed[0].reason})` : `못 올렸어요: ${failed[0].reason}`)
              : `${added.length}개 올렸어요. 눌러서 열어요`;
            if (added.length) { input.value = ''; draw(); list.scrollTop = 0; }
          } catch (err) {
            console.error('자료 올리기 실패', err);
            status.textContent = err?.code === 'QUOTA' ? '저장 공간이 부족해요' : '올리지 못했어요';
          } finally {
            uploading = false; upBtn.disabled = false; emptyUp.disabled = false;
          }
        });
      }

      // 자료함 준비 → 그리기, 바뀌면 다시(한 그림에 한 번)
      D.ready().then(() => { ready = true; draw(); }, err => {
        console.error('자료함을 열지 못했어요', err);
        body.dataset.state = 'error';
        none.hidden = false; none.textContent = '자료함을 열지 못했어요. 앱을 다시 열어 주세요';
      });
      offs.push(D.onDocs(later));
      // 위치가 바뀌면 근처만 바뀐다 — 보이는 자리(좌표)가 달라졌을 때만
      offs.push(safe(() => gps.on(s => {
        const p = s?.pos || null;
        if (!p === !pos && (!p || (p.lat === pos.lat && p.lng === pos.lng))) return;
        pos = p; later();
      }), () => {}));
      checkEngines().then(changed => { if (changed) later(); });                    // 줄 sig 에 표시 여부가 들어 있어 바뀐 줄만 다시
      return body;
    }, {
      label: title, cls: 'dp-sheet',
      onClose: reason => {
        for (const f of offs) safe(f);
        resolve(reason === 'close' ? picked : null);
      },
    });
  });
}
