// 내보내기 탭 `exporthub`(앱 0.1.7 「한번에 보내기」 — reference/parts/v017.md ## export ①~③, ## check §1.3). params { day } 또는 { from, to }(없으면 오늘)
// 위에서부터: 바 「내보내기」 [⋮] → 날짜 칩(오늘·어제·날짜 고르기·기간) — 고르는 중이면 그 자리에 「n개 고름」 머리 →
//   (기간) 시작 ~ 끝 + 빠른 칩(이번 주·지난주·이번 달) → 카드 하나(보낼 것 / 보내는 순서 / 다 보냈어요 / 보내다 멈췄어요) →
//   「보낼 묶음 n」(아직 안 보낸 것) · 「보낸 묶음 n · 카톡 11:40」(접힘 기억). 줄 탭 = 묶음 상세, 길게 = 고르기(folderbar selection) →
//   아래 고정(탭 막대 위, 엄지 영역): 진행 줄(2초 막대 · [그만] · [엑셀은 나중에]) + 노랑 주 버튼 하나 [오늘 것 한번에 보내기].
// 목록은 사진대지 순서(위가 먼저 — 결정 1, A안). 진행은 services/sendrun.js(화면 밖 — 탭을 오가도, 카톡에 다녀와도 이어짐). 이 화면은 그리기와 누르기만.
// 고른 기간·고르는 중인 묶음은 params 에(router 가 탭마다 마지막 params 를 기억한다 — 카톡에 다녀와 다시 mount 돼도 그대로).
import * as dom from '../dom.js';
import * as store from '../../data/store.js';
import * as sendlog from '../../data/sendlog.js';
import * as sendrun from '../../services/sendrun.js';
import * as sendflow from '../../services/sendflow.js';
import * as exporter from '../../services/exporter.js';
import * as native from '../../platform/native.js';
import * as config from '../../config.js';
import * as thumbW from '../widgets/thumb.js';
import { selection, moreIcon } from '../widgets/folderbar.js';
import { goLabel, goSub, kindText, quickRange, quickOf, modeOf, QUICK } from '../../core/sendplan.js';
import { dayKey, addDays, dayStart, mdw, hm } from '../../core/date.js';
import { oneLine } from '../../core/watermark.js';
import { datePicker } from './day.js';

const { h, icon } = dom;
const toast = (t, ms) => dom.toast?.(t, ms);
const validDay = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
const isApp = () => { try { return !!native.isNative?.(); } catch { return false; } };
const dayText = d => mdw(dayStart(d));
const errText = e => (e?.code === 'QUOTA' ? '저장 공간이 부족해요' : e?.message || String(e || '알 수 없는 오류'));
const fmtMB = sendrun.fmtMB;
const QUICK_LABEL = { thisweek: '이번 주', lastweek: '지난주', thismonth: '이번 달' };
const MAX_SHEET = config.MAX_EXPORT_PHOTOS ?? 100;                         // 사진대지 xlsx 한 파일 사진 수(넘으면 ZIP 하나에 여러 개)

// 화면 밖 — 사진 휴대폰에 저장(⋮)은 화면을 떠나도 이어진다
const job = { kind: null, done: 0, total: 0, ctrl: null };
let live = null, liveSel = null;
const paintLive = () => { try { live?.(); } catch (e) { console.error(e); } };

// 기간 — st.range: 'today' | 'yesterday' | 'pick'(st.pickDay) | 'period'(st.from~st.to)
function rangeOf(st, today) {
  switch (st.range) {
    case 'yesterday': { const d = addDays(today, -1); return { from: d, to: d }; }
    case 'pick': return { from: st.pickDay || today, to: st.pickDay || today };
    case 'period': { let f = st.from || today, t = st.to || f; if (f > t) [f, t] = [t, f]; return { from: f, to: t }; }
    default: return { from: today, to: today };
  }
}
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
  st.pick = null;                                                             // 고르는 중인 묶음 id(없으면 고르기 아님)
}
// 가장 최근 기록 날(오늘 포함, 미래 제외) — 빈 날 안내의 [그 날 보기]
function latestDay(today) {
  let best = null;
  for (const d of store.days?.() || []) if ((d.records || 0) > 0 && d.day <= today && (!best || d.day > best)) best = d.day;
  return best;
}

export default {
  mount(root, params = {}, nav) {
    let dead = false;
    const st = params;
    let today = dayKey(Date.now());
    initState(st, today);
    const app = isApp();
    // 지난 실행이 남긴 보내기(카톡에 다녀오는 사이 앱이 다시 켜짐)를 첫 그림 전에 맡는다 — 부팅 훅(2초 + 한가할 때)보다 먼저 탭을 열어도
    //   「이어서 보내기」 카드가 뜨고, 공유 창을 연 단계는 넘긴 것으로 적힌다(검토: 그 사이 [한번에]가 넘긴 사진을 다시 보냈다)
    try { sendrun.adoptSaved?.(); } catch (e) { console.warn('이어서 보내기 확인 실패', e); }

    // ---- 바 ----
    const deep = (globalThis.__lite?.router?.stackNames?.() || []).length > 1;
    const menuBtn = h('button', { type: 'button', class: 'icbtn', 'aria-label': '내보내기 메뉴', 'data-testid': 'xh-menu', on: { click: () => openMenu() } }, moreIcon());
    const bar = h('div', { class: 'bar' },
      deep ? h('button', { type: 'button', class: 'icbtn', 'aria-label': '뒤로', 'data-testid': 'xh-back', on: { click: () => nav.back() } }, icon('back')) : null,
      h('h1', { text: '내보내기' }), menuBtn);

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
    const chipRow = h('div', { class: 'chips xh-chips', role: 'group', 'aria-label': '날짜' }, ...chips);
    const fromIn = h('input', { type: 'date', class: 'input xh-date', 'aria-label': '시작 날짜', 'data-testid': 'xh-from' });
    const toIn = h('input', { type: 'date', class: 'input xh-date', 'aria-label': '끝 날짜', 'data-testid': 'xh-to' });
    const onDate = () => { st.from = validDay(fromIn.value) ? fromIn.value : today; st.to = validDay(toIn.value) ? toIn.value : st.from; changed(); };
    fromIn.addEventListener('change', onDate); toIn.addEventListener('change', onDate);
    const quick = QUICK.map(k => h('button', { type: 'button', class: 'chip xh-quick', 'data-testid': 'xh-quick', 'data-value': k, 'aria-pressed': 'false', text: QUICK_LABEL[k],
      on: { click: () => { const r = quickRange(k, today); st.range = 'period'; st.from = r.from; st.to = r.to; changed(); } } }));
    const period = h('div', { class: 'xh-period' },
      h('div', { class: 'xh-dates' }, fromIn, h('span', { class: 'xh-tilde', text: '~' }), toIn),
      h('div', { class: 'xh-quicks', role: 'group', 'aria-label': '빠른 기간' }, ...quick));

    // ---- 고르기(길게 누르기 · [고르기]) — folderbar selection 의 머리만(옮기기·지우기 없음), 칩 줄 자리에 ----
    const sel = selection({
      onChange: (n, ids) => { st.pick = n ? ids : null; planDirty = true; if (!dead) { paint(); relift(); } },
      onAll: () => sel.set(curPlan?.records.map(r => r.id) || []),
    });
    sel.el.classList.add('xh-selbar');
    liveSel = sel;
    // folderbar selection 은 고를 때 스낵바 자리를 자기 막대 높이로 올리고, 풀 때 지운다 — 이 화면은 아래 고정 칸 위로 다시 맞춘다
    let myLift = null;
    const relift = () => { myLift?.(); myLift = dom.liftSnack(dock); };

    // ---- 카드: 보낼 것 / 보내는 순서 / 다 보냄 / 이어서 ----
    const kindRow = (k, label) => h('button', { type: 'button', class: 'xh-kind', role: 'switch', 'data-testid': 'xh-kind', 'data-value': k, 'aria-checked': 'true',
      on: { click: () => toggleKind(k) } },
      h('span', { class: 'xh-box', 'aria-hidden': 'true' }, icon('check', 18)),
      h('span', { class: 'xh-kind-t', text: label }),
      h('span', { class: 'xh-kind-s' }));
    const kKakao = kindRow('kakao', '카톡 사진·글'), kExcel = kindRow('excel', '사진대지 엑셀');
    const kindsCard = h('div', { class: 'xh-card xh-kinds', 'data-testid': 'xh-kinds', role: 'group', 'aria-label': '보낼 것' }, kKakao, kExcel);
    const stepsCard = h('div', { class: 'xh-card xh-steps', 'data-testid': 'xh-steps', role: 'list', 'aria-label': '보내는 순서', hidden: true });
    const doneT = h('b'), doneS = h('small');
    const doneCard = h('div', { class: 'xh-card xh-done', 'data-testid': 'xh-done', role: 'status', hidden: true },
      h('span', { class: 'xh-mark done', 'aria-hidden': 'true' }, icon('check', 18)), h('span', { class: 'xh-card-t' }, doneT, doneS));
    const resumeS = h('small');
    const resumeCard = h('div', { class: 'xh-card xh-resume', 'data-testid': 'xh-resume', role: 'status', hidden: true },
      h('span', { class: 'xh-mark fail', 'aria-hidden': 'true', text: '!' }),
      h('span', { class: 'xh-card-t' }, h('b', { text: '보내다 멈췄어요' }), resumeS),
      h('button', { type: 'button', class: 'xh-tbtn', 'data-testid': 'xh-resume-drop', text: '그만두기', on: { click: () => { sendrun.discardSaved(); paint(); } } }));
    const overNote = h('p', { class: 'note xh-over', 'data-role': 'over', hidden: true });
    // 보낼 것이 없는 묶음(준비된 사진·내용·처리 중 사진 없음)은 목록에 두지 않고 한 줄로 알린다 — 「다 보냈어요」와 「보낼 묶음 1」이 함께 뜨던 것(검토)
    const emptyNote = h('p', { class: 'note xh-emptynote', 'data-testid': 'xh-empty-note', hidden: true });

    // ---- 목록 ----
    const todoN = h('span', { class: 'xh-sec-t' });
    const pickBtn = h('button', { type: 'button', class: 'xh-tbtn', 'data-testid': 'xh-pick', text: '고르기', on: { click: () => startPick() } });
    const todoHead = h('div', { class: 'xh-sec', 'data-testid': 'xh-todo-head' }, todoN, pickBtn);
    const todoList = h('div', { class: ['rows', 'xh-list'], 'data-testid': 'xh-list' });
    const sentN = h('span', { class: 'xh-sec-t' });
    const sentBtn = h('button', { type: 'button', class: 'xh-tbtn', 'data-testid': 'xh-sent-toggle', 'aria-expanded': 'false', on: { click: () => toggleSent() } });
    const sentHead = h('div', { class: 'xh-sec', 'data-testid': 'xh-sent-head' }, sentN, sentBtn);
    const sentList = h('div', { class: ['rows', 'xh-list', 'xh-sentlist'], 'data-testid': 'xh-sent-list' });
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

    // ---- 아래 고정 ----
    const autoFill = h('span', { class: 'xh-auto-fill' });
    const autoBar = h('span', { class: 'xh-auto', 'data-testid': 'xh-auto', 'aria-hidden': 'true', hidden: true }, autoFill);
    const runText = h('span', { class: 'xh-run-t' });
    const laterBtn = h('button', { type: 'button', class: 'xh-tbtn', 'data-testid': 'xh-later', text: '엑셀은 나중에', on: { click: () => sendrun.later() } });
    const stopBtn = h('button', { type: 'button', class: 'xh-tbtn', 'data-testid': 'xh-stop', text: '그만', on: { click: () => stopAll() } });
    const runLine = h('div', { class: 'xh-run', 'data-testid': 'xh-progress', hidden: true }, autoBar, runText, laterBtn, stopBtn);   // 장마다 바뀌는 글이라 읽어 주기(status)는 하지 않는다 — 주 버튼 글이 지금 할 일
    const goL = h('b', { class: 'xh-send-l' }), goS = h('small', { class: 'xh-send-s' });
    const goBtn = h('button', { type: 'button', class: 'primary xh-send', 'data-testid': 'xh-send' }, icon('share', 22), h('span', { class: 'xh-send-t' }, goL, goS));
    const againBtn = h('button', { type: 'button', class: 'secondary xh-again', 'data-testid': 'xh-again', text: '다시 보내기…', hidden: true, on: { click: () => againMenu() } });
    const dock = h('div', { class: 'dock xh-dock' }, runLine, goBtn, againBtn);

    root.classList.add('xh-scr');
    root.append(bar, chipRow, sel.el, pick.el, period, kindsCard, stepsCard, doneCard, resumeCard, overNote, todoHead, todoList, sentHead, sentList, emptyNote, empty, dock);

    // ---- 그리기 ----
    // 계획은 store·기간·고른 것·켬끔이 바뀔 때만 다시 짠다(보내는 동안의 진행 알림은 잦다 — 그때는 카드·아래 칸만)
    let curPlan = null, planKey = '', planDirty = true;
    const kindsNow = rg => sendlog.prefs().kinds[modeOf(rg.from, rg.to)];
    function changed() { planDirty = true; if (sel.active()) sel.clear(); paint(); }
    function planOf(rg, picking) {
      const args = { ...rg, ids: picking ? st.pick : null, kinds: kindsNow(rg), today };
      const key = JSON.stringify([args.from, args.to, args.ids, args.kinds, today]);
      if (planDirty || key !== planKey || !curPlan) { planDirty = false; planKey = key; curPlan = sendrun.plan(args); }
      return curPlan;
    }

    function paint() {
      if (dead) return;
      today = dayKey(Date.now());
      const run = sendrun.current(), saved = sendrun.resumable();
      const busy = !!run || !!job.kind;
      const picking = sel.active();
      // 칩
      for (const c of chips) { const on = c.dataset.value === st.range; c.setAttribute('aria-pressed', String(on)); c.classList.toggle('sel', on); c.disabled = busy; }
      pickLabel.textContent = st.range === 'pick' && st.pickDay ? dayText(st.pickDay) : '날짜 고르기';
      chipRow.hidden = picking;
      period.hidden = st.range !== 'period' || picking;
      fromIn.max = today; toIn.max = today;
      if (fromIn.value !== st.from) fromIn.value = st.from;
      if (toIn.value !== st.to) toIn.value = st.to;
      fromIn.disabled = toIn.disabled = busy;
      const rg = rangeOf(st, today);
      const q = st.range === 'period' ? quickOf(rg.from, rg.to, today) : null;
      for (const b of quick) { const on = b.dataset.value === q; b.setAttribute('aria-pressed', String(on)); b.classList.toggle('sel', on); b.disabled = busy; }
      // 계획(보내는 중이면 목록 상태만 — 단계는 그 보내기 것)
      const p = planOf(rg, picking);
      paintList(p, rg, { picking, busy });
      paintCard(p, rg, { run, saved, picking });
      paintDock(p, rg, { run, saved, picking });
      if (!run && !saved && !picking && !job.kind) sendrun.warm(p);
    }

    // 줄 — 시각·사진 수 / 위치(굵게)·꼬리표·내용 한 줄 / 썸네일 한 장(64×48)
    const rowSig = (r, s) => {
      const ps = store.photosOf?.(r.id) || [];
      const f = ps.find(x => x.state === 'ready') || ps[0];
      return JSON.stringify([r.location || '', r.content || '', r.createdAt, ps.length, f?.id || '', f?.state || '', s?.state, s?.newIds?.length || 0, s?.at || 0, s?.pending || 0]);
    };
    function recRow(r, s) {
      const ps = store.photosOf(r.id) || [];
      const f = ps.find(x => x.state === 'ready') || ps[0] || null;
      const loc = oneLine(r.location), content = oneLine(r.content);
      const tags = [];
      if (s?.state === 'more') tags.push(['more', `사진 ${s.newIds.length}장 더`]);
      if (s?.state === 'edited') tags.push(['edited', '보낸 뒤 고침']);
      // ✓ 는 글자가 아니라 스프라이트 아이콘으로 — 글자 「✓」는 기본 글꼴에 없어 처음 그릴 때 대체 글꼴을 찾느라 그림 한 번이 길었다(4배 늦춤 110~280ms, 검증 때 잼)
      if ((s?.state === 'sent' || s?.state === 'edited') && s.at) tags.push(['sent', `카톡 ${hm(s.at)}`, 'check']);
      if (s?.pending) tags.push(['pend', `처리 중 ${s.pending}장`]);
      const row = h('button', { type: 'button', class: 'xh-row', 'data-testid': 'xh-row', 'data-id': r.id, 'data-state': s?.state || 'new' },
        h('span', { class: 'xh-when' }, h('b', { text: hm(r.createdAt) }), h('small', { text: `${ps.length}장` })),
        h('span', { class: 'xh-body' },
          h('b', { class: ['xh-loc', !loc && 'muted'], text: loc || '위치 미입력' }),
          h('span', { class: 'xh-line' }, ...tags.map(([k, t, ic]) => h('span', { class: ['xh-tag', `xh-tag-${k}`] }, ic ? icon(ic, 12) : null, t)),
            content ? h('span', { class: 'xh-content', text: content }) : null)),
        f ? thumbW.thumb(f.id, { className: 'xh-th' }) : h('span', { class: 'xh-th xh-th-none', 'aria-hidden': 'true' }));
      sel.bind(row, r.id, { onOpen: () => nav.go('record', { id: r.id }) });
      return row;
    }
    function fill(list, recs, p, multi) {
      const items = [];
      let last = null;
      for (const r of recs) {
        if (multi && r.day !== last) { items.push({ k: `d:${r.day}`, day: r.day }); last = r.day; }
        items.push({ k: r.id, r });
      }
      dom.syncList(list, items, {
        key: it => it.k,
        sig: it => (it.r ? rowSig(it.r, p.states.get(it.r.id)) : it.day),
        make: it => (it.r ? recRow(it.r, p.states.get(it.r.id)) : h('div', { class: 'xh-dayhead', 'data-day': it.day, text: dayText(it.day) })),
      });
    }
    function paintList(p, rg, { picking, busy }) {
      const multi = rg.from !== rg.to;
      const has = p.records.length > 0;
      const split = !!p.kinds.kakao || picking;                               // 카톡을 끄면(기간 기본) 한 목록 — 「보낸」 나눔은 카톡 기준
      const none = new Set((p.empty || []).map(r => r.id));                  // 보낼 것이 없는 묶음 — 어느 목록에도 두지 않는다(아래 한 줄)
      const todo = split ? p.todo : p.records.filter(r => !none.has(r.id)), sent = split ? p.sent : [];
      emptyNote.hidden = !none.size || picking;
      if (!emptyNote.hidden) {
        let failed = 0;
        for (const r of p.empty) failed += (store.photosOf(r.id) || []).filter(x => x.state === 'failed').length;
        emptyNote.textContent = `보낼 사진·내용이 없는 묶음 ${none.size}개는 뺐어요${failed ? ` · 처리 실패 ${failed}장` : ''}`;
      }
      const open = picking || sendlog.prefs().sentOpen || !todo.length;
      fill(todoList, todo, p, multi);
      fill(sentList, open ? sent : [], p, multi);
      todoHead.hidden = !has || (!todo.length && (split || none.size > 0));
      todoN.textContent = split ? `보낼 묶음 ${todo.length}` : `묶음 ${todo.length}`;
      todoList.hidden = !todo.length;
      pickBtn.hidden = picking || busy;
      sentHead.hidden = !sent.length;
      sentN.textContent = `보낸 묶음 ${sent.length}${p.lastKakaoAt ? ` · 카톡 ${hm(p.lastKakaoAt)}` : ''}`;
      sentBtn.hidden = picking || !todo.length;
      const ph = todoHead.hidden ? sentHead : todoHead;                       // 다 보냈으면 「보낸 묶음 n」 머리에 [고르기](단추는 하나 — 옮겨 단다)
      if (pickBtn.parentNode !== ph) ph.append(pickBtn);
      sentBtn.textContent = open ? '접기' : '펼치기';
      sentBtn.setAttribute('aria-expanded', String(open));
      sentList.hidden = !open || !sent.length;
      empty.hidden = has;
      if (!has) {
        const lead = multi ? '이 기간에는 기록이 없어요' : rg.from === today ? '오늘은 기록이 없어요' : '이 날은 기록이 없어요';
        emptyText.textContent = `${lead} · 위에서 다른 날을 골라요`;
        const ld = latestDay(today);
        const show = ld && !(ld >= rg.from && ld <= rg.to) && !picking;
        emptyGo.hidden = !show;
        if (show) { emptyGo.dataset.day = ld; emptyGo.textContent = ld === addDays(today, -1) ? '어제 보기' : `${dayText(ld)} 보기`; }
      }
      if (picking) sel.retain(p.records);
    }
    // 다 보냈나 — 켠 것 모두(카톡 = 보낼 묶음 없음 · 엑셀 = 그 뒤 안 바뀜). 보낼 것이 아예 없는 빈 묶음은 「보낼 묶음」에 들지 않는다(sendplan empty — 목록과 같은 판정)
    function doneOf(p) {
      if (!p.records.length || (!p.kinds.kakao && !p.kinds.excel)) return null;
      if (p.kinds.kakao && (p.todo.length || !p.lastKakaoAt)) return null;
      if (p.kinds.excel && (!p.excel || p.excel.state !== 'sent')) return null;
      return { kakaoAt: p.kinds.kakao ? p.lastKakaoAt : 0, excelAt: p.kinds.excel ? p.excel.at : 0 };
    }
    function paintCard(p, rg, { run, saved, picking }) {
      const dn = !run && !saved && !picking ? doneOf(p) : null;
      kindsCard.hidden = !!run || !!saved || !!dn || !p.records.length;
      stepsCard.hidden = !run;
      resumeCard.hidden = !saved || !!run;
      doneCard.hidden = !dn;
      if (!kindsCard.hidden) {
        const k = p.kinds, n = picking ? (st.pick?.length || 0) : 0;
        for (const [el, kind] of [[kKakao, 'kakao'], [kExcel, 'excel']]) {
          el.setAttribute('aria-checked', String(!!k[kind]));
          el.querySelector('.xh-kind-s').textContent = kindText(kind, { on: !!k[kind], kakao: p.kakao, excel: p.excel, lastKakaoAt: p.lastKakaoAt, ...rg, today, picked: n });
          el.disabled = !!job.kind;
        }
      }
      if (dn) {
        doneT.textContent = `${rg.from === rg.to ? (rg.from === today ? '오늘 것은' : '이 날 것은') : '이 기간 것은'} 다 보냈어요`;
        doneS.textContent = [dn.kakaoAt ? `카톡 ${hm(dn.kakaoAt)}` : '', dn.excelAt ? `사진대지 ${hm(dn.excelAt)}` : ''].filter(Boolean).join(' · ');
      }
      if (saved && !run) resumeS.textContent = sendrun.leftText(saved);
      if (run) paintSteps(run);
      const n = p.excel?.photoCount || 0, max = MAX_SHEET;
      overNote.hidden = !!run || !p.kinds.excel || n <= max;                 // 100장 넘으면 xlsx 여러 개를 ZIP 하나에(담당 3 엔진 — 막지 않는다)
      if (!overNote.hidden) overNote.textContent = `사진이 ${n}장이라 사진대지는 ${max}장씩 ${Math.ceil(n / max)}개로 나눠 ZIP 하나에 담아요`;
    }

    // 순서표 — 글 복사 · 카톡 1/n … · 사진대지 엑셀. 줄마다 표시(✓ 넘김 · ● 지금 · ○ 기다림 · ! 못함)와 글(색만으로 나타내지 않는다)
    const markOf = state => (state === 'done' ? h('span', { class: 'xh-mark done', 'aria-hidden': 'true' }, icon('check', 16))
      : state === 'fail' ? h('span', { class: 'xh-mark fail', 'aria-hidden': 'true', text: '!' })
        : state === 'skip' ? h('span', { class: 'xh-mark skip', 'aria-hidden': 'true', text: '–' })
          : h('span', { class: ['xh-mark', state === 'cur' ? 'cur' : 'wait'], 'aria-hidden': 'true' }));
    function stepInfo(run, s, cur) {
      const label = sendrun.stepLabel(s);
      if (s.kind === 'kakao') {
        switch (s.state) {
          case 'done': return { m: 'done', t: `${label} · ${s.n}장 넘김` };
          case 'ready': return { m: cur ? 'cur' : 'wait', t: `${label} · ${s.n}장 준비됐어요` };
          case 'sharing': return { m: 'cur', t: `${label} · 보내는 중` };
          case 'fail': return { m: 'fail', t: `${label} · 못 보냈어요${s.error ? ` · ${s.error}` : ''}`, retry: true };
          default: return { m: cur ? 'cur' : 'wait', t: s.total && (cur || s.done) ? `${label} · 만드는 중 ${s.done}/${s.total}` : `${label} · ${s.n}장` };
        }
      }
      const size = s.bytes ? fmtMB(s.bytes) : '';
      const big = s.bytes > sendrun.BIG_MB * 1e6 ? ' · 파일이 커요' : '';
      switch (s.state) {
        case 'done': return { m: 'done', t: `${label} 보냄${size ? ` · ${size}` : ''}` };
        case 'ready': return { m: cur ? 'cur' : 'wait', t: `${label} · ${size} 준비됐어요${big}`, file: true };
        case 'sharing': return { m: 'cur', t: `${label} · 보내는 중`, file: true };
        case 'skip': return { m: 'skip', t: `${label} · 나중에` };
        case 'fail': return { m: 'fail', t: `${label} · ${s.failAt === 'make' ? '못 만들었어요' : '못 보냈어요'}${s.error ? ` · ${s.error}` : ''}`, retry: true };
        default: return { m: cur ? 'cur' : 'wait', t: s.total ? `${label} · 만드는 중 ${s.done}/${s.total}` : `${label} · ${run.plan.excel?.photoCount || 0}장`, bar: s.total ? s.done / s.total : 0 };
      }
    }
    function paintSteps(run) {
      const cur = sendrun.step();
      const rows = [];
      if (run.text) {
        const ok = !!run.copied;
        rows.push({ k: 'text', sig: `t|${ok}`, make: () => h('div', { class: 'xh-step', role: 'listitem', 'data-testid': 'xh-step', 'data-key': 'text', 'data-state': ok ? 'done' : 'fail' },
          markOf(ok ? 'done' : 'fail'),
          h('span', { class: 'xh-step-t', text: ok ? '글 복사함 · 사진 다음에 붙여요' : '글을 복사하지 못했어요' }),
          h('button', { type: 'button', class: 'xh-tbtn', 'data-testid': 'xh-text', text: '글 보기', on: { click: () => textSheet(run.text, ok) } })) });
      }
      if (run.phase === 'prep') rows.push({ k: 'prep', sig: `p|${run.pending}`, make: () => h('div', { class: 'xh-step', role: 'listitem', 'data-testid': 'xh-step', 'data-key': 'prep', 'data-state': 'wait' }, markOf('cur'), h('span', { class: 'xh-step-t', text: `처리 중 사진 ${run.pending}장 기다리는 중` })) });
      for (const s of run.steps) {
        const info = stepInfo(run, s, s === cur);
        const fileName = s.file?.name || '';
        rows.push({
          k: s.key, sig: JSON.stringify([s.state, info.t, info.m, fileName, Math.round((info.bar || 0) * 20)]),
          make: () => {
            // 만든 엑셀 파일이 있으면 글 칸이 곧 결과(xh-excel-result — 파일 이름은 읽어 주기·title 로)
            const withFile = info.file && fileName;
            const kids = [markOf(info.m), withFile
              ? h('span', { class: ['xh-step-t', s === cur && 'cur'], 'data-testid': 'xh-excel-result', 'data-name': fileName, title: fileName }, info.t, h('span', { class: 'xh-sr', 'data-role': 'file-name', text: ` ${fileName}` }))
              : h('span', { class: ['xh-step-t', s === cur && 'cur'], text: info.t })];
            if (info.bar) kids.push(h('span', { class: 'xh-mini', 'aria-hidden': 'true' }, h('i', { style: { transform: `scaleX(${info.bar.toFixed(3)})` } })));
            if (withFile && app) kids.push(h('button', { type: 'button', class: 'xh-tbtn', 'data-testid': 'xh-excel-save', text: '저장', on: { click: () => saveExcel(s.file) } }));   // 앱: 문서 폴더에 한 벌(보냄 표시는 안 함)
            if (info.retry) kids.push(h('button', { type: 'button', class: 'xh-tbtn', 'data-testid': 'xh-step-retry', text: '다시', on: { click: () => sendrun.retry(s.key) } }));
            return h('div', { class: 'xh-step', role: 'listitem', 'data-testid': 'xh-step', 'data-key': s.key, 'data-state': s.state }, ...kids);
          },
        });
      }
      dom.syncList(stepsCard, rows, { key: x => x.k, sig: x => x.sig, make: x => x.make() });
    }

    // 아래 고정 — 진행 줄 + 주 버튼(노랑 하나) / [다시 보내기…](흰 바탕 — 할 일이 없으니 노랑 없음)
    let autoKey = 0;
    function paintAuto(run) {
      const at = run?.autoAt || 0;
      autoBar.hidden = !at;
      if (!at) { autoKey = 0; autoFill.style.transition = 'none'; autoFill.style.transform = 'scaleX(0)'; return; }
      if (autoKey === at) return;
      autoKey = at;
      const ms = Math.max(0, at - Date.now());
      autoFill.style.transition = 'none'; autoFill.style.transform = 'scaleX(0)';
      requestAnimationFrame(() => requestAnimationFrame(() => {
        if (autoKey !== at) return;
        autoFill.style.transition = `transform ${ms}ms linear`; autoFill.style.transform = 'scaleX(1)';   // 막대는 전환 한 번(매 그림 JS 없음)
      }));
    }
    function setGo(label, sub, { disabled = false, busy = false } = {}) {
      goL.textContent = label; goS.textContent = sub || '';
      goS.hidden = !sub;
      goBtn.disabled = disabled;
      goBtn.setAttribute('aria-busy', String(!!busy));
    }
    function paintDock(p, rg, { run, saved, picking }) {
      againBtn.hidden = true; goBtn.hidden = false;
      laterBtn.hidden = true; stopBtn.hidden = false;
      runLine.classList.remove('warn');
      if (job.kind) {
        runLine.hidden = false; paintAuto(null);
        runText.textContent = `사진 저장하는 중 ${job.done}/${job.total}`;
        setGo('사진 저장하는 중', '', { disabled: true, busy: true });
        return;
      }
      if (run) {
        runLine.hidden = false;
        paintAuto(run);
        const s = sendrun.step();
        const kakaoDone = run.steps.filter(x => x.kind === 'kakao' && x.state === 'done').reduce((n, x) => n + (x.n || 0), 0);
        const hasKakao = run.steps.some(x => x.kind === 'kakao');
        if (run.phase === 'prep') { runText.textContent = `처리 중 사진 ${run.pending}장 기다리는 중`; setGo('사진 처리 기다리는 중', `${run.pending}장`, { disabled: true, busy: true }); return; }
        if (!s) { runText.textContent = '마무리하는 중'; setGo('마무리하는 중', '', { disabled: true, busy: true }); return; }
        const label = sendrun.stepLabel(s);
        const ex = s.kind === 'excel';
        laterBtn.hidden = !(ex && hasKakao);
        stopBtn.hidden = !laterBtn.hidden;
        if (run.autoAt) runText.textContent = `${Math.round(Math.max(0, run.autoAt - Date.now()) / 1000) || 1}초 뒤 열어요 · 만지면 멈춰요`;
        else if (run.notice?.kind === 'cancel' && s.state === 'ready') { runText.textContent = '취소했어요 · 다시 누르면 열려요'; runLine.classList.add('warn'); }
        else if (run.notice?.kind === 'tap' && s.state === 'ready') runText.textContent = '준비됐어요 · 눌러서 보내요';
        else if (s.state === 'wait') runText.textContent = ex ? `사진대지 만드는 중 ${s.total ? `${s.done}/${s.total}` : '…'}` : `사진 준비 중 ${s.done}/${s.total}`;
        else if (s.state === 'fail') { runText.textContent = `${s.failAt === 'make' ? '못 만들었어요' : '못 보냈어요'} · ${s.error || '다시 해 보세요'}`; runLine.classList.add('warn'); }
        else if (s.state === 'sharing') runText.textContent = '공유 창을 열었어요';
        else if (ex && kakaoDone) runText.textContent = `카톡 ${kakaoDone}장 보냄 · 엑셀 ${fmtMB(s.bytes)}`;   // 글자 ✓ 는 대체 글꼴을 부른다(첫 그림이 길다) — 「보냄」으로 충분
        else runText.textContent = `${label} 준비됐어요`;
        switch (s.state) {
          case 'ready': setGo(ex ? (app ? '사진대지 엑셀 보내기' : '사진대지 엑셀 내려받기') : `${label} 보내기`, ex ? fmtMB(s.bytes) : `${s.n}장`); break;
          case 'fail': setGo(`${label} 다시`, s.error || ''); break;
          case 'sharing': setGo('보내는 중…', label, { disabled: true, busy: true }); break;
          default: setGo(ex ? `사진대지 만드는 중${s.total ? ` ${s.done}/${s.total}` : '…'}` : `사진 준비 중 ${s.done}/${s.total}`, label, { disabled: true, busy: true });
        }
        return;
      }
      runLine.hidden = true; paintAuto(null);
      if (saved) { setGo('이어서 보내기', sendrun.leftText(saved).replace(/이 남았어요$/, '')); return; }
      if (!p.records.length) { setGo(goLabel({ ...rg, today }), '보낼 기록이 없어요', { disabled: true }); return; }
      if (!picking && doneOf(p)) { goBtn.hidden = true; againBtn.hidden = false; return; }
      const picked = picking ? (st.pick?.length || 0) : 0;
      const kk = p.kinds.kakao ? p.kakao : null, xx = p.kinds.excel ? p.excel : null;
      const parts = p.kParts.length;
      const nothing = (!kk || !kk.recordIds.length) && (!xx || !xx.recordIds.length);
      // 켠 것이 있는데 보낼 것이 하나도 없다 = 묶음이 다 비었거나(사진·내용 없음) 사진이 아직 처리 중 — 「카톡은 다 보냈어요」라고 하지 않는다
      const pend = p.todo.some(r => p.states.get(r.id)?.pending);
      const sub = nothing && (kk || xx) && !p.lastKakaoAt ? (pend ? '사진 처리 중이에요 · 잠시 뒤 보내요' : '보낼 사진·내용이 없어요') : goSub({ kakao: kk, excel: xx, parts });
      setGo(goLabel({ ...rg, today, picked }), sub, { disabled: nothing || (!kk && !xx) });
    }

    // ---- 누르기 ----
    function toggleKind(k) {
      const rg = rangeOf(st, today), mode = modeOf(rg.from, rg.to);
      const cur = sendlog.prefs().kinds[mode];
      sendlog.setPrefs({ kinds: { [mode]: { ...cur, [k]: !cur[k] } } }).then(() => paint(), e => console.warn(e));
    }
    function toggleSent() { sendlog.setPrefs({ sentOpen: !sendlog.prefs().sentOpen }).then(() => paint(), () => {}); }
    function startPick() {
      // 길게 누르기와 같은 고르기 — [고르기]만 눌렀으면 아직 아무것도 안 골랐다: 「보낼 묶음」을 다 고른 채로 시작한다
      const ids = (curPlan?.todo.length ? curPlan.todo : curPlan?.records || []).map(r => r.id);
      if (ids.length) sel.set(ids);
    }
    goBtn.addEventListener('click', () => {
      if (goBtn.disabled) return;
      const run = sendrun.current();
      if (run) { sendrun.next(); return; }
      if (sendrun.resumable()) { sendrun.continueSaved(); return; }
      const rg = rangeOf(st, today);
      const ids = sel.active() ? [...st.pick] : null;
      if (sendflow.isBusy?.()) { toast('보내는 중이에요'); return; }
      if (ids) sel.clear();
      sendrun.start({ ...rg, ids, kinds: kindsNow(rg) }).catch(startFail);
    });
    function startFail(e) { console.error('한번에 보내기 실패', e); toast(`보내지 못했어요 — ${errText(e)}`, 4000); }
    function stopAll() {
      if (job.kind) { job.ctrl?.abort(); return; }
      sendrun.stop();
    }
    async function recopy(text) {
      const ok = await native.copyText(text);
      toast(ok ? '글을 다시 복사했어요' : '글을 복사하지 못했어요');
      const run = sendrun.current();
      if (ok && run) { run.copied = true; paint(); }
    }
    // 보낼 글 시트 — [다시 복사](카톡에서 붙여 넣기 전에 클립보드가 덮였을 때). copied 가 거짓이면 [복사]
    function textSheet(text, copied = true) {
      if (!text) { toast('보낼 글이 없어요'); return; }
      dom.openSheet(close => h('div', { class: 'sheet-body xh-textsheet' },
        h('h2', { class: 'sheet-title', text: '보낼 글' }),
        h('pre', { class: 'xh-pre', 'data-testid': 'xh-text-body', text }),
        h('div', { class: 'sheet-actions' },
          h('button', { type: 'button', class: 'secondary', text: '닫기', on: { click: () => close() } }),
          h('button', { type: 'button', class: 'primary', 'data-testid': 'xh-recopy', text: copied ? '다시 복사' : '복사', on: { click: () => { close(); recopy(text); } } }))),
      { label: '보낼 글' });
    }
    async function saveExcel(file) {
      try {
        const r = await exporter.deliver(file, 'save');
        if (r && r.ok === false) toast(`저장하지 못했어요${r.error ? ` — ${r.error}` : ''}`, 4000);
        else toast(r?.where && r.where !== 'download' ? `${r.where}에 저장했어요` : app ? '문서/현장사진대지 lite에 저장했어요' : '내려받았어요');
      } catch (e) { toast(`저장하지 못했어요 — ${errText(e)}`, 4000); }
    }
    // ⋮ — 보조 기능(사진대지만 · 카톡만 · 사진 저장 · ZIP · 저절로 · 글 보기 · 보냄 표시 지우기)
    async function openMenu() {
      const pr = sendlog.prefs();
      const rg = rangeOf(st, today);
      const run = sendrun.current();
      const opts = run ? [] : [
        { value: 'excel', label: '사진대지만 보내기' },
        { value: 'kakao', label: '카톡 사진·글만 보내기' },
        { value: 'photos', label: app ? '사진 휴대폰에 저장' : '사진 내려받기' },
        { value: 'zip', label: '사진대지에 사진 파일도 넣기(ZIP)', sub: pr.excelFormat === 'zip' ? '켜짐' : '꺼짐' },
      ];
      if (app) opts.push({ value: 'auto', label: '다음 단계 저절로 열기', sub: pr.autoNext ? '켜짐' : '꺼짐' });
      opts.push({ value: 'text', label: '보낼 글 보기' });
      if (!run) opts.push({ value: 'clear', label: rg.from === rg.to ? '이 날 보냄 표시 지우기' : '이 기간 보냄 표시 지우기' });
      const v = await dom.choose({ title: '내보내기', options: opts });
      if (!v || dead) return;
      const ids = sel.active() ? [...st.pick] : null;
      if (v === 'excel' || v === 'kakao') {
        if (sendrun.current()) return;
        if (ids) sel.clear();
        sendrun.start({ ...rg, ids, kinds: { kakao: v === 'kakao', excel: v === 'excel' } }).catch(startFail);
      } else if (v === 'photos') savePhotos(ids || curPlan.records.map(r => r.id));
      else if (v === 'zip') { await sendlog.setPrefs({ excelFormat: pr.excelFormat === 'zip' ? 'xlsx' : 'zip' }); toast(pr.excelFormat === 'zip' ? '사진대지는 xlsx 하나로 보내요' : '사진대지에 사진 파일도 넣어 ZIP으로 보내요'); paint(); }
      else if (v === 'auto') { await sendlog.setPrefs({ autoNext: !pr.autoNext }); toast(pr.autoNext ? '다음 단계는 눌러서 열어요' : '다음 단계를 저절로 열어요'); paint(); }
      else if (v === 'text') textSheet(run?.text || sendrun.textFor(curPlan) || sendrun.lastText());
      else if (v === 'clear') {
        const token = await sendrun.clearMarks(curPlan.records.map(r => r.id));
        if (!token) { toast('지울 보냄 표시가 없어요'); return; }
        dom.snackbar('보냄 표시를 지웠어요', { actionLabel: '되돌리기', onAction: async () => { await sendlog.undo(token); paint(); } });
        paint();
      }
    }
    async function againMenu() {
      const rg = rangeOf(st, today);
      const v = await dom.choose({ title: '다시 보내기', options: [
        { value: 'all', label: '모두 다시 보내기', sub: '카톡 사진·글 → 사진대지 엑셀' },
        { value: 'excel', label: '사진대지만 다시 보내기' },
        { value: 'kakao', label: '카톡 사진·글만 다시 보내기' },
        { value: 'pick', label: '골라서 보내기' },
      ] });
      if (!v || dead || sendrun.current()) return;
      if (v === 'pick') { sel.set(curPlan.records.map(r => r.id)); return; }
      const ids = curPlan.records.map(r => r.id);
      const kinds = v === 'all' ? { kakao: true, excel: true } : { kakao: v === 'kakao', excel: v === 'excel' };
      sendrun.start({ ...rg, ids: v === 'excel' ? null : ids, kinds }).catch(startFail);
    }
    async function savePhotos(ids) {
      if (job.kind || sendflow.isBusy?.()) { toast('보내는 중이에요'); return; }
      Object.assign(job, { kind: 'save', done: 0, total: 0, ctrl: typeof AbortController === 'function' ? new AbortController() : null });
      paintLive();
      try {
        const r = await sendflow.savePhotos(ids, { onProgress: (d, t) => { job.done = d; job.total = t; paintLive(); }, signal: job.ctrl?.signal });
        if (r.busy) toast('보내는 중이에요');
        else if (r.cancelled) toast(r.saved ? `사진 ${r.saved}장까지 저장했어요` : '그만뒀어요');
        else if (!r.ok) toast(`저장하지 못했어요${r.error ? ` — ${r.error}` : ''}`, 4000);
        else toast(r.where === 'download' ? `사진 ${r.saved}장을 내려받았어요` : `${r.where}에 ${r.saved}장 저장했어요`, 3500);
      } finally { Object.assign(job, { kind: null, done: 0, total: 0, ctrl: null }); paintLive(); }
    }

    // ---- 구독 ----
    live = () => { if (!dead) paint(); };
    paint();
    if (st.pick?.length) sel.set(st.pick);                                  // 고르던 중(다른 탭에 다녀옴)
    const schedule = typeof dom.deferWhileTyping === 'function' ? dom.deferWhileTyping(() => paint()) : () => queueMicrotask(paint);
    const off = store.on?.(ch => { if (ch?.records?.size || ch?.photos?.size || ch?.settings || ch?.meta?.has?.('sendLog') || ch?.meta?.has?.('exportPrefs')) { planDirty = true; schedule(); } });
    // 보내는 동안의 알림은 잦다(장마다) — 그림 한 번에 한 번
    let raf = 0;
    const offRun = sendrun.on(() => { if (!dead && !raf) raf = requestAnimationFrame(() => { raf = 0; if (!dead) paint(); }); });
    const tick = setInterval(() => { if (sendrun.current()?.autoAt) paint(); else if (dayKey(Date.now()) !== today) { planDirty = true; schedule(); } }, 1000);   // 2초 막대 글(초) · 자정 넘김

    return () => {
      dead = true;
      live = null;
      if (liveSel === sel) liveSel = null;
      schedule.cancel?.();
      clearInterval(tick);
      cancelAnimationFrame(raf);
      off?.(); offRun?.();
      myLift?.();
      sel.destroy();
      sendrun.cool();
    };
  },
  // 뒤로 — 고르는 중이면 고르기만 푼다
  onBack() { if (liveSel?.active()) { liveSel.clear(); return true; } return false; },
  // 내보내기 탭을 다시 누름(params {}) — 고른 기간 그대로. 날짜를 들고 오면(홈 [내보내기] 등) 그 날짜로 새로
  onReenter(p) { return !(validDay(p?.day) || validDay(p?.from)); },
  // 다른 탭에서 [내보내기] 탭(params {}) — 기억한 상태 그대로, 보내는 중·이어서·고르는 중이 아니면 홈에서 보던 지난 날짜로
  tabEnter(saved, of) {
    try { sendrun.adoptSaved?.(); } catch { /* 없음 */ }                      // 이어서 보낼 것이 있으면 그 기간 그대로(부팅 훅보다 먼저 탭을 눌러도)
    if (sendrun.current() || sendrun.resumable() || job.kind || saved?.pick?.length) return null;
    const hd = of?.('home')?.day;
    const today = dayKey(Date.now());
    if (!validDay(hd) || hd >= today) return null;
    if (saved && saved.range === 'pick' && saved.pickDay === hd) return null;
    if (saved && saved.range === 'yesterday' && hd === addDays(today, -1)) return null;
    return { day: hd };
  },
};
