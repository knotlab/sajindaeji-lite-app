// 내보내기 탭 `exporthub`(v0.1.5 — 아래 탭 막대 「홈 / 내보내기」의 둘째). params { day } 또는 { from, to }(없으면 오늘)
// 위 바 「내보내기」 → 날짜 칩(오늘 / 어제 / 날짜 고르기 / 기간, 기본 오늘) → 그 기간 묶음 목록(줄마다 체크, 기본 모두) →
// 아래 고정(탭 막대 위, 엄지 영역): 보조 [사진대지 엑셀]·[사진만 저장] + 맨 아래 주 버튼 [카톡으로 보내기](노랑 — 고른 묶음·사진 수).
// 카톡 보내기는 services/sendflow.js(글 먼저 복사 → 사진 굽기 → 한도마다 나눠 공유). 엑셀은 exporter.plan/build/deliver 에 고른 묶음(recordIds)만.
// 고른 기간·뺀 묶음·보낸 뒤 안내는 params 에 둔다(카톡에 다녀와 다시 mount 돼도 그대로 — router 가 탭마다 마지막 params 를 기억한다).
// 만드는 중인 일은 화면 밖(job) — 나갔다 와도 진행이 이어진다. 결과 안내는 지금 붙은 화면의 params(liveSt)에 쓴다.
// 보내기 중 탭을 떠나면: 굽기는 촬영 화면에서 쉬고(셔터·글 입력 지연 방지), 다 구워져도 공유 창을 저절로 띄우지 않는다 —
//   탭 배지 + 돌아와 [사진 보내기]를 누를 때 연다(검토 반영 v0.1.5: 촬영 화면 위에 공유 창이 떠 카메라가 닫혔다).
// 목록은 바뀐 줄만 다시 만든다(dom.syncList), 체크는 줄을 다시 만들지 않고 aria-checked 만 바꾼다. 썸네일은 줄마다 3장까지(지연 로딩).
import * as dom from '../dom.js';
import * as store from '../../data/store.js';
import * as exporter from '../../services/exporter.js';
import * as sendflow from '../../services/sendflow.js';
import * as native from '../../platform/native.js';
import * as config from '../../config.js';
import * as thumbW from '../widgets/thumb.js';
import { dayKey, addDays, dayStart, mdw, hm } from '../../core/date.js';
import { oneLine } from '../../core/watermark.js';
import { datePicker } from './day.js';

const { h, icon } = dom;
const toast = (t, ms) => dom.toast?.(t, ms);
const MAX_THUMBS = 3;
const MAX_SHEET = config.MAX_EXPORT_PHOTOS ?? 100;                         // 사진대지 한 파일 사진 수(넘으면 나눠 한 ZIP 에 — exporter)
const validDay = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
const isApp = () => { try { return !!native.isNative?.(); } catch { return false; } };
const fmtSize = n => (!Number.isFinite(n) ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1e3))}KB`);
const errText = e => (e?.code === 'QUOTA' ? '저장 공간이 부족해요' : e?.message || String(e || '알 수 없는 오류'));
const dayText = d => mdw(dayStart(d));

// 화면 밖 상태 — 만드는 중에 탭을 바꿨다 와도 진행이 이어진다
// copied: 글을 복사했나(보내기 중) · waiting: 구운 사진이 공유를 기다림 { run, resolve } — 내보내기 탭이 안 보일 때
const job = { kind: null, done: 0, total: 0, ctrl: null, copied: null, waiting: null };
let live = null, liveSt = null;
const paintLive = () => { try { live?.(); } catch (e) { console.error(e); } };
const lite = () => globalThis.__lite || {};
// 내보내기 탭이 지금 보이나(겹친 화면·다른 탭이 아니고 화면이 붙어 있음)
const hubVisible = () => !!live && (lite().router?.currentName?.() ?? 'exporthub') === 'exporthub' && (typeof document === 'undefined' || document.visibilityState !== 'hidden');
const setBadge = n => { try { lite().tabs?.setBadge?.('exporthub', n); } catch { /* 탭 막대 없음 */ } };
const sleep = ms => new Promise(r => setTimeout(r, ms));
// 장마다 굽기 전에: 촬영 화면이 열려 있으면 떠날 때까지 쉰다, 글 입력 중이면 끝날 때까지(최대 몇 초)
async function bakeHold() {
  while (lite().router?.currentName?.() === 'capture' && job.kind) await sleep(400);
  try { await native.whenQuiet?.({ quietMs: 300, maxMs: 3000 }); } catch { /* 그냥 굽는다 */ }
}

// 기간 — st.range: 'today' | 'yesterday' | 'pick'(st.pickDay) | 'period'(st.from~st.to)
function rangeOf(st, today) {
  switch (st.range) {
    case 'yesterday': { const d = addDays(today, -1); return { from: d, to: d }; }
    case 'pick': return { from: st.pickDay || today, to: st.pickDay || today };
    case 'period': { let f = st.from || today, t = st.to || f; if (f > t) [f, t] = [t, f]; return { from: f, to: t }; }
    default: return { from: today, to: today };
  }
}
// 들어온 params → 처음 상태(한 번만)
function initState(st, today) {
  if (st._xh) return;
  st._xh = true;
  const f = validDay(st.from) ? st.from : validDay(st.day) ? st.day : null;
  const t = validDay(st.to) ? st.to : f;
  st.from = f || addDays(today, -6); st.to = t || today;
  if (!f) st.range = 'today';
  else if (f !== t) st.range = 'period';
  else if (f === today) st.range = 'today';
  else if (f === addDays(today, -1)) st.range = 'yesterday';
  else { st.range = 'pick'; st.pickDay = f; }
  st.off = new Set();                                                         // 뺀 묶음 id — 새로 생긴 묶음은 들어간 채로
  st.notice = null;                                                           // 보낸 뒤 안내 { copied, sent, total, ids }
}

// 그 기간 묶음 — 화면은 홈과 같게 최신이 위(날짜도 최신 날이 위). 보내는 순서·사진대지 순서는 sendflow·exporter 가 따로 정한다(날짜 → 만든 시각)
function recordsIn({ from, to }) {
  if (from === to) return [...(store.recordsOfDay(from) || [])].reverse();
  const days = (store.days?.() || []).map(d => d.day).filter(d => d >= from && d <= to).sort().reverse();
  return days.flatMap(d => [...(store.recordsOfDay(d) || [])].reverse());
}
const readyOf = r => (store.photosOf(r.id) || []).filter(p => p.state === 'ready');
const pendingOf = r => (store.photosOf(r.id) || []).filter(p => p.state !== 'ready' && p.state !== 'failed').length;
// 가장 최근 기록 날(오늘 포함, 미래 제외) — 빈 날 안내의 [그 날 보기]
function latestDay(today) {
  let best = null;
  for (const d of store.days?.() || []) if ((d.records || 0) > 0 && d.day <= today && (!best || d.day > best)) best = d.day;
  return best;
}

const rowSig = r => {
  const ids = (store.photosOf?.(r.id) ?? []).map(p => `${p.id}:${p.state}`);
  return JSON.stringify([r.location || '', r.content || '', r.createdAt, ids.length, ids.slice(0, MAX_THUMBS)]);
};

function recRow(r, onToggle) {
  const photos = store.photosOf(r.id) || [];
  const ready = photos.filter(p => p.state === 'ready').length;
  const loc = oneLine(r.location);
  const content = oneLine(r.content);
  const shown = photos.slice(0, MAX_THUMBS);
  const more = photos.length - shown.length;
  const meta = `${hm(r.createdAt)} · ${photos.length}장${ready < photos.length ? ` (처리 중 ${photos.length - ready})` : ''}`;
  return h('button', {
    type: 'button', class: 'xh-row', role: 'checkbox', 'aria-checked': 'true', 'data-testid': 'xh-row', 'data-id': r.id,
    on: { click: () => onToggle(r.id) },
  },
  h('span', { class: 'xh-check', 'aria-hidden': 'true' }, icon('check', 18)),
  h('span', { class: 'xh-body' },
    h('span', { class: 'xh-head' },
      h('b', { class: ['xh-loc', !loc && 'muted'], text: loc || '위치 미입력' }),
      h('span', { class: 'xh-meta', text: meta })),
    content ? h('span', { class: 'xh-content', text: content }) : null,
    shown.length ? h('span', { class: 'xh-thumbs' },
      shown.map(p => thumbW.thumb(p.id, { className: 'xh-th' })),
      more > 0 ? h('span', { class: 'xh-more', text: `+${more}` }) : null) : null));
}

// 엑셀 결과 시트 — [공유](앱·공유 가능한 브라우저) / [저장|내려받기]. 탭 안에서 deliver 를 부른다(공유 창은 사용자 탭 안에서만)
function canShareFile(r) {
  if (isApp()) return true;
  try { return !!(r?.blob && navigator.canShare?.({ files: [new File([r.blob], r.name, { type: r.blob.type || 'application/zip' })] })); } catch { return false; }
}
function resultSheet(res) {
  const deliver = async how => {
    try {
      const r = await exporter.deliver(res, how);
      if (r && r.ok === false && !r.cancelled) toast(`${how === 'share' ? '공유' : '저장'}하지 못했어요${r.error ? ` — ${r.error}` : ''}`, 4000);
      else if (how === 'save') toast(r?.where && r.where !== 'download' && r.where !== 'share' ? `${r.where}에 저장했어요` : isApp() ? '문서/현장사진대지 lite에 저장했어요' : '내려받았어요');
    } catch (e) { toast(`${how === 'share' ? '공유' : '저장'}하지 못했어요 — ${errText(e)}`, 4000); }
  };
  dom.openSheet(close => {
    const share = canShareFile(res);
    const btns = [];
    if (share) btns.push(h('button', { type: 'button', class: 'primary', 'data-testid': 'xh-excel-share', onclick: () => { close(); deliver('share'); } }, icon('share'), '공유'));
    btns.push(h('button', { type: 'button', class: share ? 'secondary' : 'primary', 'data-testid': 'xh-excel-save', onclick: () => { close(); deliver('save'); } }, icon('download'), isApp() ? '저장' : '내려받기'));
    return h('div', { class: 'sheet-body xh-result', 'data-testid': 'xh-excel-result' },
      h('h2', { class: 'sheet-title', text: '사진대지를 만들었어요' }),
      h('div', { class: 'xh-file' }, icon('zip'),
        h('span', { class: 'xh-file-t' },
          h('b', { 'data-role': 'file-name', text: res.name }),
          h('small', { text: [`묶음 ${res.records}`, `사진 ${res.photos}장`, res.locmaps ? `위치도 ${res.locmaps}장` : '', fmtSize(res.size)].filter(Boolean).join(' · ') }))),
      res.skipped ? h('p', { class: 'note', text: `사진 ${res.skipped}장은 만들지 못해 뺐어요` }) : null,
      res.locmapSkipped ? h('p', { class: 'note', text: `위치도 ${res.locmapSkipped}장은 도면 그림이 없어 뺐어요` }) : null,
      h('div', { class: 'sheet-actions xh-result-btns' }, ...btns.reverse()));            // 주 버튼이 오른쪽(엄지)
  }, { label: '사진대지를 만들었어요' });
}

export default {
  mount(root, params = {}, nav) {
    let dead = false;
    const st = params;
    liveSt = st;
    let today = dayKey(Date.now());
    initState(st, today);
    setBadge(0);

    // ---- 위 바 ----
    // 탭으로 열면(스택 한 칸) 뒤로 버튼 없음, 날짜 화면 등에서 go 로 들어오면 뒤로 버튼
    const deep = (globalThis.__lite?.router?.stackNames?.() || []).length > 1;
    const bar = h('div', { class: 'bar' },
      deep ? h('button', { type: 'button', class: 'icbtn', 'aria-label': '뒤로', 'data-testid': 'xh-back', on: { click: () => nav.back() } }, icon('back')) : null,
      h('h1', { text: '내보내기' }));

    // ---- 날짜 칩 ----
    const pick = datePicker(d => { st.range = 'pick'; st.pickDay = d; changed(); });
    const chip = (v, label, onClick) => h('button', { type: 'button', class: 'chip xh-chip', 'data-testid': 'xh-range', 'data-value': v, 'aria-pressed': 'false', on: { click: onClick } }, label);
    const pickLabel = h('span', { text: '날짜 고르기' });
    const chips = [
      chip('today', '오늘', () => { st.range = 'today'; changed(); }),
      chip('yesterday', '어제', () => { st.range = 'yesterday'; changed(); }),
      chip('pick', [icon('cal', 18), pickLabel], () => pick.open()),
      chip('period', '기간', () => { st.range = 'period'; changed(); }),
    ];
    const fromIn = h('input', { type: 'date', class: 'input xh-date', 'aria-label': '시작 날짜', 'data-testid': 'xh-from' });
    const toIn = h('input', { type: 'date', class: 'input xh-date', 'aria-label': '끝 날짜', 'data-testid': 'xh-to' });
    const onDate = () => { st.from = validDay(fromIn.value) ? fromIn.value : today; st.to = validDay(toIn.value) ? toIn.value : st.from; changed(); };
    fromIn.addEventListener('change', onDate); toIn.addEventListener('change', onDate);
    const period = h('div', { class: 'xh-period' }, fromIn, h('span', { class: 'xh-tilde', text: '~' }), toIn);

    // ---- 목록 ----
    const sumText = h('span', { class: 'xh-sum', 'data-testid': 'xh-sum' });
    const allBtn = h('button', { type: 'button', class: 'xh-all', 'data-testid': 'xh-all', on: { click: () => toggleAll() } });
    const head = h('div', { class: 'xh-sec' }, sumText, allBtn);
    const list = h('div', { class: ['rows', 'xh-list'], 'data-testid': 'xh-list' });
    const emptyText = h('span');
    const emptyGo = h('button', { type: 'button', class: 'secondary xh-empty-go', 'data-testid': 'xh-empty-go', hidden: true });
    const empty = h('div', { class: 'xh-empty', 'data-testid': 'xh-empty' }, emptyText, emptyGo);
    emptyGo.addEventListener('click', () => {
      const d = emptyGo.dataset.day;
      if (!validDay(d)) return;
      st.range = d === addDays(today, -1) ? 'yesterday' : d === today ? 'today' : 'pick';
      if (st.range === 'pick') st.pickDay = d;
      changed();
    });
    const overNote = h('p', { class: 'note xh-over', 'data-role': 'over', hidden: true });   // 엑셀이 여러 파일로 나뉠 때 미리 한 줄

    // ---- 보낸 뒤 안내(카톡에서 돌아왔을 때 보이게 아래 고정 칸 맨 위) ----
    const noticeText = h('b', { class: 'xh-notice-t' });
    const noticeSub = h('small', { class: 'xh-notice-s' });
    const recopy = h('button', { type: 'button', class: 'xh-notice-btn', 'data-testid': 'xh-recopy', text: '다시 복사' });
    const notice = h('div', { class: 'xh-notice', 'data-testid': 'xh-notice', role: 'status' },
      h('span', { class: 'xh-notice-ic', 'aria-hidden': 'true' }, icon('check', 20)),
      h('span', { class: 'xh-notice-body' }, noticeText, noticeSub),
      recopy,
      h('button', { type: 'button', class: 'xh-notice-x', 'aria-label': '안내 닫기', on: { click: () => { st.notice = null; paintDock(); } } }, icon('close', 20)));
    dom.lockButton(recopy, async () => {
      const r = await sendflow.copyRecordsText(st.notice?.ids || []);
      toast(r.ok ? '글을 다시 복사했어요' : '글을 복사하지 못했어요');
      if (r.ok && st.notice) { st.notice.copied = true; paintDock(); }
    });

    // ---- 아래 고정 ----
    const progFill = h('span', { class: 'xh-prog-fill' });
    const progText = h('span', { class: 'xh-prog-t' });
    const stopBtn = h('button', { type: 'button', class: 'xh-prog-stop', 'data-testid': 'xh-stop', text: '그만', on: { click: () => job.ctrl?.abort() } });
    const prog = h('div', { class: 'xh-prog', 'data-testid': 'xh-progress', role: 'status' },
      h('span', { class: 'xh-prog-bar' }, progFill), progText, stopBtn);
    const excelBtn = h('button', { type: 'button', class: 'secondary xh-subbtn', 'data-testid': 'xh-excel' }, icon('table', 20), h('span', { text: '사진대지 엑셀' }));
    const photosBtn = h('button', { type: 'button', class: 'secondary xh-subbtn', 'data-testid': 'xh-photos' }, icon('download', 20), h('span', { text: '사진만 저장' }));
    const sendSub = h('small', { class: 'xh-send-s' });
    const sendLabel = h('b', { text: '카톡으로 보내기' });
    const sendBtn = h('button', { type: 'button', class: 'primary xh-send', 'data-testid': 'xh-send' },
      icon('share', 22), h('span', { class: 'xh-send-t' }, sendLabel, sendSub));
    const dock = h('div', { class: 'dock xh-dock' }, notice, prog, h('div', { class: 'btnrow xh-subrow' }, excelBtn, photosBtn), sendBtn);

    root.classList.add('xh-scr');
    root.append(bar, h('div', { class: 'chips xh-chips', role: 'group', 'aria-label': '날짜' }, ...chips), pick.el, period, head, overNote, list, empty, dock);

    // ---- 고른 것 ----
    let recs = [];
    const picked = () => recs.filter(r => !st.off.has(r.id));
    const countOf = rs => rs.reduce((n, r) => n + readyOf(r).length, 0);
    const pendingIn = rs => rs.reduce((n, r) => n + pendingOf(r), 0);
    function toggle(id) { if (st.off.has(id)) st.off.delete(id); else st.off.add(id); paintChecks(); }
    function toggleAll() {
      const allOn = recs.length && recs.every(r => !st.off.has(r.id));
      if (allOn) for (const r of recs) st.off.add(r.id); else st.off.clear();
      paintChecks();
    }

    // ---- 그리기 ----
    function changed() { st.off.clear(); st.notice = null; paint(); }

    function paint() {
      if (dead) return;
      today = dayKey(Date.now());
      for (const c of chips) { const on = c.dataset.value === st.range; c.setAttribute('aria-pressed', String(on)); c.classList.toggle('sel', on); }
      pickLabel.textContent = st.range === 'pick' && st.pickDay ? dayText(st.pickDay) : '날짜 고르기';
      period.hidden = st.range !== 'period';
      fromIn.max = today; toIn.max = today;
      if (fromIn.value !== st.from) fromIn.value = st.from;
      if (toIn.value !== st.to) toIn.value = st.to;
      const rg = rangeOf(st, today);
      recs = recordsIn(rg);
      const multi = rg.from !== rg.to;
      // 여러 날이면 날짜 머리 줄을 끼운다
      const items = [];
      let last = null;
      for (const r of recs) {
        if (multi && r.day !== last) { items.push({ k: `d:${r.day}`, day: r.day }); last = r.day; }
        items.push({ k: r.id, r });
      }
      dom.syncList(list, items, {
        key: it => it.k,
        sig: it => (it.r ? rowSig(it.r) : it.day),
        make: it => (it.r ? recRow(it.r, toggle) : h('div', { class: 'xh-dayhead', 'data-day': it.day, text: dayText(it.day) })),
      });
      list.hidden = !recs.length;
      empty.hidden = !!recs.length;
      if (!recs.length) {
        // 무엇을 하면 되는지 한 줄 + 가장 최근 기록 날이 있으면 [그 날 보기]
        const lead = multi ? '이 기간에는 기록이 없어요' : rg.from === today ? '오늘은 기록이 없어요' : '이 날은 기록이 없어요';
        emptyText.textContent = `${lead} · 위에서 다른 날을 골라요`;
        const ld = latestDay(today);
        const show = ld && !(ld >= rg.from && ld <= rg.to);
        emptyGo.hidden = !show;
        if (show) { emptyGo.dataset.day = ld; emptyGo.textContent = ld === addDays(today, -1) ? '어제 보기' : `${dayText(ld)} 보기`; }
      }
      for (const id of [...st.off]) if (!recs.some(r => r.id === id)) st.off.delete(id);
      paintChecks();
    }

    function paintChecks() {
      if (dead) return;
      for (const row of list.children) {
        if (!row.dataset.id) continue;
        row.setAttribute('aria-checked', String(!st.off.has(row.dataset.id)));
      }
      const all = recs.length && recs.every(r => !st.off.has(r.id));
      allBtn.hidden = !recs.length;
      allBtn.textContent = all ? '모두 해제' : '모두 선택';
      const rg = rangeOf(st, today);
      const when = rg.from === rg.to ? dayText(rg.from) : `${dayText(rg.from)}~${dayText(rg.to)}`;
      sumText.textContent = recs.length ? `${when} · 묶음 ${recs.length} · 사진 ${countOf(recs)}` : when;
      paintDock();
    }

    function paintDock() {
      if (dead) return;
      const sel = picked();
      const n = countOf(sel);
      const busy = !!job.kind;
      const parts = sendflow.partsFor(n, { native: isApp() });
      const pend = pendingIn(sel);
      const waiting = !!job.waiting;
      sendSub.textContent = waiting ? '사진이 준비됐어요 · 눌러서 보내요'
        : !recs.length ? '보낼 기록이 없어요'
        : !sel.length ? '보낼 묶음을 골라요'
        : `묶음 ${sel.length} · 사진 ${n}장${pend ? ` · ${pend}장 처리 중` : ''}${n ? (parts > 1 ? ` · ${parts}번에 나눠요` : '') : pend ? '' : ' · 글만 복사해요'}`;
      sendBtn.disabled = waiting ? false : busy || !sel.length;
      const xparts = Math.ceil(n / MAX_SHEET);
      overNote.hidden = xparts < 2;
      if (xparts > 1) overNote.textContent = `사진이 ${n}장이라 엑셀은 ${MAX_SHEET}장씩 ${xparts}개로 나눠 담아요`;
      excelBtn.disabled = busy || !sel.length || !n;
      photosBtn.disabled = busy || !n;
      sendBtn.setAttribute('aria-busy', String(job.kind === 'send' && !waiting));
      sendLabel.textContent = waiting ? '사진 보내기' : job.kind === 'send' ? '사진 만드는 중…' : '카톡으로 보내기';
      prog.hidden = !busy;
      if (busy) {
        const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
        progFill.style.width = `${pct}%`;
        const what = job.kind === 'excel' ? '사진대지 만드는 중' : job.kind === 'save' ? '사진 저장하는 중'
          : job.copied ? '글 복사함 · 사진 만드는 중' : '보낼 사진 만드는 중';
        progText.textContent = waiting ? (job.copied ? '글 복사함 · 사진 준비됐어요' : '사진 준비됐어요') : `${what} ${job.done}/${job.total}`;
        stopBtn.hidden = job.kind === 'excel';                                // 엑셀은 exporter 가 그만두기를 받지 않는다
      }
      const nt = st.notice;
      notice.hidden = !nt || busy;
      if (nt) {
        // 「글은 복사했어요 — 카톡에서 붙여 넣으세요」를 두 줄로(360 폭에서 세 줄로 접히지 않게)
        // 사진을 다 넘겼으면 사진 수는 줄인다(주 버튼에 이미 보인다). 덜 넘겼을 때만 「사진 9장 중 4장 넘김」
        const partial = nt.total && nt.sent < nt.total ? `사진 ${nt.total}장 중 ${nt.sent}장 넘김` : '';
        noticeText.textContent = nt.copied ? '글은 복사했어요' : '글을 복사하지 못했어요';
        noticeSub.textContent = [nt.copied ? '카톡에서 붙여 넣으세요' : '', partial].filter(Boolean).join(' · ') || (nt.total ? `사진 ${nt.sent}장 넘김` : '글만');
        notice.classList.toggle('warn', !nt.copied);
        recopy.textContent = nt.copied ? '다시 복사' : '글 복사';
      }
    }

    // ---- 일 ----
    async function runJob(kind, fn) {
      if (job.kind) return;
      Object.assign(job, { kind, done: 0, total: 0, ctrl: typeof AbortController === 'function' ? new AbortController() : null, copied: null, waiting: null });
      paintLive();
      const onProgress = (d, t) => { job.done = d; job.total = t; paintLive(); };
      try { await fn(onProgress, job.ctrl?.signal); }
      finally { Object.assign(job, { kind: null, done: 0, total: 0, ctrl: null, copied: null, waiting: null }); setBadge(0); paintLive(); }
    }
    // 결과 안내는 지금 붙은 화면의 params 에(탭을 오가며 다시 mount 돼도 보이게 — 같은 객체를 router 가 기억한다)
    const setNotice = v => { (liveSt || st).notice = v; if (liveSt && liveSt !== st) st.notice = v; };

    // 첫 공유를 열지 — 내보내기 탭이 보이면 토스트 뒤 바로, 아니면 배지를 달고 돌아와 누를 때까지 기다린다
    function firstShare(run) {
      const go = () => {
        if (job.copied) toast('글을 복사했어요 — 카톡에서 사진 보낸 뒤 붙여 넣어요', 3000);
        return run();
      };
      if (hubVisible()) return go();
      return new Promise(resolve => {
        const sig = job.ctrl?.signal;
        const onAbort = () => { if (job.waiting) { job.waiting = null; setBadge(0); paintLive(); } resolve(null); };
        sig?.addEventListener?.('abort', onAbort, { once: true });
        job.waiting = { run: () => { sig?.removeEventListener?.('abort', onAbort); job.waiting = null; setBadge(0); paintLive(); resolve(go()); } };
        setBadge(1);
        const where = lite().router?.currentName?.();
        if (where !== 'capture') toast('보낼 사진이 준비됐어요 — 내보내기 탭에서 보내요', 3000);   // 촬영 중에는 셔터 둘레를 가리지 않는다(배지만)
        paintLive();
      });
    }

    dom.lockButton(sendBtn, () => {
      if (job.waiting) { job.waiting.run(); return; }                         // 돌아와 [사진 보내기] — 탭 안에서 공유 창을 연다
      return runJob('send', async (onProgress, signal) => {
        let ids = picked().map(r => r.id);
        if (!ids.length) return;
        setNotice(null);
        // 처리 중인 사진이 있으면 잠깐(최대 4초) 기다렸다가 — 그래도 남으면 빼고 알린다
        const pend0 = pendingIn(picked());
        if (pend0 && typeof lite().pipeline?.idle === 'function') {
          progText.textContent = `사진 ${pend0}장 처리 기다리는 중`;
          await Promise.race([lite().pipeline.idle(), sleep(4000)]);
          if (signal?.aborted) return;
        }
        const left = ids.reduce((n, id) => { const r = store.record(id); return n + (r ? pendingOf(r) : 0); }, 0);
        const r = await sendflow.sendRecords(ids, {
          onProgress, signal, hold: bakeHold, first: firstShare,
          onCopied: ok => { job.copied = !!ok; paintLive(); },
        });
        if (left) toast(`${left}장은 아직 처리 중이라 뺐어요`, 3500);
        if (r.busy) { toast('보내는 중이에요'); return; }
        if (r.textOnly) { setNotice({ copied: r.copied, sent: 0, total: 0, ids }); toast(r.copied ? '글을 복사했어요 — 카톡에서 붙여 넣으세요' : '글을 복사하지 못했어요'); return; }
        if (r.error && !r.sent) { toast(`보내지 못했어요 — ${r.error}`, 4000); if (r.copied) setNotice({ copied: true, sent: 0, total: r.total, ids }); return; }
        if (r.cancelled && !r.sent) { if (r.copied) setNotice({ copied: true, sent: 0, total: r.total, ids }); return; }
        setNotice({ copied: r.copied, sent: r.sent, total: r.total, ids });
        if (r.skipped) toast(`사진 ${r.skipped}장은 만들지 못해 뺐어요`, 3500);
        else if (r.where === 'download') toast(`사진 ${r.sent}장을 내려받았어요`);
      });
    });

    dom.lockButton(excelBtn, () => runJob('excel', async onProgress => {
      const rg = rangeOf(st, today);
      const ids = picked().map(r => r.id);
      let p;
      try { p = exporter.plan({ ...rg, recordIds: ids }); } catch (e) { toast(`만들 수 없어요 — ${errText(e)}`); return; }
      if (!p.photoCount) { toast('고른 묶음에 사진이 없어요'); return; }
      try {
        const res = await exporter.build({ ...rg, recordIds: ids }, onProgress);
        resultSheet({ ...res, photos: res.photos ?? p.photoCount });          // 그새 다른 탭에 갔어도 결과는 띄운다(만든 파일을 놓치지 않게)
      } catch (e) { console.warn('사진대지 만들기 실패', e); toast(`만들지 못했어요 — ${errText(e)}`, 5000); }
    }));

    dom.lockButton(photosBtn, () => runJob('save', async (onProgress, signal) => {
      const r = await sendflow.savePhotos(picked().map(x => x.id), { onProgress, signal, hold: bakeHold });
      if (r.busy) { toast('보내는 중이에요'); return; }
      if (r.cancelled) { if (r.saved) toast(`사진 ${r.saved}장까지 저장했어요`); return; }
      if (!r.ok) { toast(`저장하지 못했어요${r.error ? ` — ${r.error}` : ''}`, 4000); return; }
      toast(r.where === 'download' ? `사진 ${r.saved}장을 내려받았어요` : `${r.where}에 ${r.saved}장 저장했어요`, 3500);
    }));

    live = () => { if (!dead) paintDock(); };
    paint();
    // store 알림은 글 입력이 끝난 뒤 한 번(일 하는 동안은 목록을 그대로 — 고른 것이 바뀌지 않게)
    const schedule = typeof dom.deferWhileTyping === 'function' ? dom.deferWhileTyping(() => { if (!job.kind) paint(); else paintDock(); }) : () => queueMicrotask(paint);
    const off = store.on?.(ch => { if (ch?.records?.size || ch?.photos?.size || ch?.settings) schedule(); });
    const tick = setInterval(() => { if (dayKey(Date.now()) !== today) schedule(); }, 60000);   // 자정 넘김

    return () => {
      dead = true;
      live = null;
      if (liveSt === st) liveSt = null;
      if (job.waiting) setBadge(1);
      schedule.cancel?.();
      clearInterval(tick);
      off?.();
    };
  },
  // 내보내기 탭을 다시 누름(params {}) — 고른 기간·체크를 그대로 둔다. 날짜를 들고 오면(홈 [내보내기] 등) 그 날짜로 새로 연다
  onReenter(p) { return !(validDay(p?.day) || validDay(p?.from)); },
  // 다른 탭에서 [내보내기] 탭을 누름(params {}) — router 가 기억한 상태(saved)를 그대로 쓰되,
  //   보낸 뒤 안내·뺀 묶음·하는 일이 없으면 홈에서 보던 지난 날짜로 연다(홈에서 어제로 넘기고 [내보내기] 탭 → 어제)
  tabEnter(saved, of) {
    if (job.kind || saved?.notice || saved?.off?.size) return null;
    const hd = of?.('home')?.day;
    const today = dayKey(Date.now());
    if (!validDay(hd) || hd >= today) return null;
    if (saved && saved.range === 'pick' && saved.pickDay === hd) return null;
    if (saved && saved.range === 'yesterday' && hd === addDays(today, -1)) return null;
    return { day: hd };
  },
};
