// 홈 `home`(설계서 §6.1, §10.6, §4.5-5, v0.1.5 아래 탭 「홈」) — params { day? }
// 위쪽 고정: 앱 이름 + 현장명, 톱니. 백업 알림 한 줄(7일 넘으면). 한 줄에 현재 위치 카드(gpsLine — 누르면 실시간 위치 지도 'map') + [도면]·[자료함] 버튼
//   (v0.1.5 검토: 위쪽 고정이 약 248px 라 360×640 에서 묶음이 1.7개만 보였다 → 한 줄로 줄여 날짜 페이지에 약 70px 더). 위치 맞춘 도면 안에 서 있으면 그 아래 「지금 여기: A-501 · 열기」 한 줄.
// 그 아래 날짜 넘기기(widgets/daypager.js): 가로로 밀어 날짜 이동(오늘보다 뒤는 버팀), 머리 ‹ 날짜 › (날짜를 누르면 날짜 고르기).
//   페이지마다 그 날 묶음 목록 + 「묶음 n · 사진 n」 + [내보내기](그 날짜로 내보내기 탭), 지난 날은 [이 날짜에 사진 추가], 그 날 핀이 있으면 위치도.
//   목록은 사진대지 순서(위가 먼저 — v0.1.7 결정 1 A안, 새 묶음은 맨 아래). 오늘 페이지는 처음 열 때 맨 아래(최신)가 보이고,
//   묶음 상세 등에 다녀오면 보던 자리(params.scroll — 그새 그 날 묶음이 늘었으면 맨 아래).
//   줄을 길게 눌러(450ms — 폴더 고르기와 같은 시간) 끌면 순서가 바뀐다(widgets/reorder.js → store.reorderRecords, 옮긴 묶음만 쓴다) + 5초 [되돌리기].
//   처음 한 번만 안내 한 줄(묶음 2개 이상인 날 — 한 번 끌거나 3번 보였거나 3일 지나면 다시 안 보임, meta hintDragRecord).
// 아래 dock [기록 시작](탭 막대 바로 위 — 노랑은 이것 하나). 지난 날을 보고 있어도 기록은 오늘로.
// 보고 있는 날짜는 params.day 에 적는다(묶음 상세에 다녀와 다시 mount 돼도 같은 날짜 — router 가 같은 params 객체를 쥔다).
// 홈 탭을 다시 누르면 오늘로(onReenter), 안드로이드 뒤로: 지난 날 → 오늘 → 앱 최소화(onBack).
// 1분마다 다시 계산(자정 넘김·백업 n일).
import * as dom from '../dom.js';
import * as store from '../../data/store.js';
import * as gps from '../../services/gps.js';
import * as rowW from '../widgets/recordrow.js';
import * as gpsW from '../widgets/gpsline.js';
import * as config from '../../config.js';
import * as camera from '../../media/camera.js';
import { dayPager } from '../widgets/daypager.js';
import { reorderable } from '../widgets/reorder.js';
import { dayKey, dayStart, dayLabel } from '../../core/date.js';
import { pickImages, addFromGallery, galleryToast, hintLive } from './record.js';
import { locGroups, locRow } from './day.js';

const { h, icon } = dom;
const toast = (t, ms) => dom.toast?.(t, ms);
const cnt = v => (typeof v === 'number' ? v : (v?.length ?? 0));
const DAY_MS = 864e5;
const BACKUP_WARN_DAYS = 7;
const LONG_MS = 450;                                 // 길게 눌러 들기(폴더 고르기 folderbar 와 같은 시간)
const END_SLACK = 24;                                // 이만큼 안이면 「맨 아래를 보고 있다」(px)
const HINT_KEY = 'hintDragRecord';                   // 처음 한 번 안내 — 끌었거나 3번 보였거나 3일 지나면 다시 안 띄운다(record.js hintLive)
const validDay = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d);
// 줄이 보이는 값(같으면 줄을 다시 만들지 않는다). 계산할 수 없으면 NaN — 늘 다시 만든다
const rowSig = r => (typeof rowW.recordRowSig === 'function' ? rowW.recordRowSig(r) : NaN);
const groupSig = g => `${g.drawing.name}|${g.drawing.pages?.length}|${g.pg?.w}x${g.pg?.h}|${g.pg?.preview ? 1 : 0}|${g.pins.map(({ p }) => `${p.id}:${p.x},${p.y}`).join(';')}`;

const router = () => globalThis.__lite?.router;
const canGo = name => (typeof router()?.has === 'function' ? router().has(name) : true);
// 아직 쓸 일이 없는 별도 DB(도면보관함)는 첫 화면이 그려진 뒤 한가할 때 연다 — 부팅·첫 그림을 늦추지 않게
const idle = fn => (typeof requestIdleCallback === 'function' ? requestIdleCallback(fn, { timeout: 1500 }) : setTimeout(fn, 300));
const unIdle = t => (typeof cancelIdleCallback === 'function' ? cancelIdleCallback(t) : clearTimeout(t));

let mounted = null;                                  // onReenter·onBack 이 지금 pager 를 찾게 { pager }

// 도면 타일 보조 줄 — 「3개 · 위치 맞춤 2」, 지금 서 있는 도면이 있으면 「지금 여기: A-501」
export function drawingsSub(list, here) {
  if (!list?.length) return '도면을 올리면 핀·길찾기';
  if (here) return `지금 여기: ${here}`;
  const geo = list.filter(d => d?.geo?.T).length;
  return geo ? `${list.length}개 · 위치 맞춤 ${geo}` : `${list.length}개`;
}

// 백업 알림 문구 — 7일이 안 됐으면 null
export function backupNotice(lastBackupAt, oldestAt, now) {
  if (Number.isFinite(lastBackupAt)) {
    const d = Math.floor((now - lastBackupAt) / DAY_MS);
    return d > BACKUP_WARN_DAYS ? `마지막 백업 ${d}일 전이에요 · 백업 파일 만들기` : null;
  }
  if (Number.isFinite(oldestAt) && now - oldestAt > BACKUP_WARN_DAYS * DAY_MS) return '아직 백업 파일이 없어요 · 백업 파일 만들기';
  return null;
}

// [기록 시작] 보조 글 — 지난 날을 보고 있으면 기록은 오늘로 간다는 것을 알린다
export function startSubText(viewDay, today, last) {
  if (viewDay && viewDay !== today) return `${dayLabel(viewDay).replace(/ \(.\)$/, '')} 보는 중 · 오늘로 찍어요`;
  return last ? `이어서: ${last}` : '위치는 찍으면서 적어요';
}

// 지난 날 [이 날짜에 사진 추가] — 갤러리 → 새 묶음(그 날짜). 보조 버튼(노랑은 [기록 시작] 하나)
function addBtn(day, nav) {
  const b = h('button', { type: 'button', class: 'secondary home-page-add', 'data-testid': 'day-add' }, icon('image'), h('span', { text: '이 날짜에 사진 추가' }));
  dom.lockButton(b, async () => {
    const files = await pickImages({ multiple: true });
    if (!files.length) return;
    try {
      const rec = await store.createRecord({ day, now: Date.now() });     // 묶음을 먼저 저장(§4.5), 위치는 비워 둔다(지난 날짜는 이어받지 않음)
      const res = await addFromGallery(rec.id, files);
      if (!res.ok) { await store.purgeRecord?.(rec.id); toast('사진을 넣지 못했어요. 다른 사진으로 해 주세요'); return; }
      galleryToast(res);
      if (mounted) nav.go('record', { id: rec.id });
    } catch (e) {
      console.error('이 날짜에 사진 추가 실패', e);
      toast(e?.code === 'QUOTA' ? '저장 공간이 모자라요' : '사진을 넣지 못했어요');
    }
  });
  return b;
}

// 기록이 있는 날 중 day 에 가장 가까운 날(같으면 앞날). 오늘보다 뒤는 없다
function nearestDay(day, today) {
  const t = dayStart(day);
  let best = null, bd = Infinity;
  for (const d of store.days?.() || []) {
    if (!(d.records > 0) || d.day === day || d.day > today) continue;
    const dd = Math.abs(dayStart(d.day) - t);
    if (dd < bd || (dd === bd && d.day < best)) { best = d.day; bd = dd; }
  }
  return best;
}

// ---- 날짜 페이지 스크롤 자리(A안) ----
// 처음 그릴 때 한 번: 'end'(맨 아래) | 숫자(그 scrollTop) | 0(맨 위 — 할 일 없음).
// saved = params.scroll { day, top, end, n }(화면을 떠날 때 적음): 맨 아래였거나 그새 그 날 묶음이 늘었으면(촬영·갤러리에서 돌아옴) 맨 아래
export function scrollWant(day, today, n, saved) {
  if (saved && saved.day === day) {
    if (saved.end || n > (Number.isFinite(saved.n) ? saved.n : n)) return 'end';
    return saved.top > 0 ? saved.top : 0;
  }
  return day === today ? 'end' : 0;
}
// 날짜 넘기기가 만든 세로 스크롤 상자(dpg-page)에 — 첫 그림 전(rAF)에 부른다(그때 배치는 어차피 그림에 필요하다)
function setScroll(el, want) {
  const w = el.parentElement;
  if (!w || !el.isConnected || w.hidden) return;
  w.scrollTop = want === 'end' ? w.scrollHeight : want;               // 넘치면 끝으로 잘린다
}
const atEnd = el => { const w = el.parentElement; return !!w && !w.hidden && w.scrollTop + w.clientHeight >= w.scrollHeight - END_SLACK; };

// 처음 한 번 안내 — 한 번 끌었거나(meta 에 시각 숫자) 홈을 3번 열어 보였거나 처음 본 지 3일이 지나면(meta { n, at }) 더는 안 띄운다
//   (검토: 순서를 안 바꾸는 사용자는 이 줄을 늘 봤다 — 360×640 목록 칸 약 331px 중 27px. CLAUDE.md 「한 번 알면 되는 안내는 처음 한 번만」)
let hintGone = false, hintCounted = false;
const hintDone = () => hintGone || !hintLive(store.meta?.(HINT_KEY, null));
function markHint() {
  if (hintGone || typeof store.meta?.(HINT_KEY, null) === 'number') { hintGone = true; return; }   // 이미 끈 적 있음 — 다시 쓰지 않는다
  hintGone = true;
  store.setMeta?.(HINT_KEY, Date.now())?.catch?.(e => console.warn('안내 표지를 남기지 못했다', e));
}
// 이번 홈 화면에서 안내가 보였다 — 화면마다 한 번 센다(쓰기는 한가할 때 — 첫 그림·부팅과 다투지 않게)
function countHint() {
  if (hintCounted || hintDone()) return;
  hintCounted = true;
  idle(() => {
    const v = store.meta?.(HINT_KEY, null);
    if (typeof v === 'number') return;                                     // 그새 끌었다
    store.setMeta?.(HINT_KEY, { n: (v?.n || 0) + 1, at: v?.at || Date.now() })?.catch?.(e => console.warn('안내 표지를 남기지 못했다', e));
  });
}

// 묶음을 끌어 놓음 — 화면(DOM)은 이미 새 순서. 저장은 뒤에서(옮긴 묶음만, store.reorderRecords), 되돌리기는 든 때의 순서로
function dropRecords(day, keys, el) {
  const before = el._before || null;
  el._before = null;
  markHint();
  el._hint.hidden = true;
  dom.snackbar?.('순서를 바꿨어요', {
    actionLabel: '되돌리기',
    onAction: () => (before ? store.reorderRecords(day, before) : null),
  });
  store.reorderRecords(day, keys).catch(e => {
    console.error('순서를 저장하지 못했다', e);
    toast('순서를 저장하지 못했어요. 다시 해 주세요');
    mounted?.pager.refresh(day);                                        // 저장된 순서로 다시
  });
}

// 한 날짜 페이지 — 다시 그릴 때는 같은 요소를 고쳐 쓴다(바뀐 줄만).
// ctx = { nav, M(도면보관함 모듈 — 아직이면 null, 위치도 구역만 빠진다), scroll(params.scroll), refresh(day) }
function dayPage(day, old, ctx) {
  const { nav, M } = ctx;
  const today = dayKey(Date.now());
  const recs = store.recordsOfDay(day) || [];                          // 사진대지 순서(위가 먼저 — A안)
  let el = old;
  // 맨 아래를 보고 있었는데 새 묶음이 끝에 붙으면 계속 맨 아래(바뀌기 전 자리를 그때만 잰다 — 보통 다시 그리기에는 읽지 않는다)
  const follow = !!old && old._today && day === today && recs.length > (old._n ?? recs.length) && recs.at(-1)?.id !== old._last && atEnd(old);
  if (!el || el._today !== (day === today)) {
    if (old) { try { old._ro?.destroy(); } catch { /* 무시 */ } }      // 자정을 넘겨 새로 만든다 — 앞 페이지의 끌기는 걷는다
    el = h('div', { class: 'home-page', 'data-day': day });
    el._today = day === today;
    el._sum = h('span', { class: 'home-page-sum', 'data-testid': 'day-sum' });
    el._xp = h('button', { type: 'button', class: 'home-sec-link home-page-xp', 'data-testid': 'day-export', on: { click: () => nav.go('exporthub', { day }) } }, '내보내기');
    el._list = h('div', { class: ['rows', 'home-list'], 'data-testid': el._today ? 'today-list' : 'day-list' });
    el._empty = h('p', { class: 'home-empty' });
    // 빈 지난 날 — 가장 가까운 기록 날로 한 번에(하루씩 밀어 빈 날을 지나지 않게)
    el._near = h('button', { type: 'button', class: 'secondary home-near', 'data-testid': 'day-near', hidden: true,
      on: { click: () => { const d = el._near.dataset.day; if (validDay(d)) mounted?.pager.go(d, { animate: true }); } } });
    el._locList = h('div', { class: 'day-loc-list' });
    el._loc = h('section', { class: 'day-loc home-page-loc', 'data-testid': 'day-locmap', 'aria-label': '위치도', hidden: true },
      h('h2', { class: 'day-loc-h', text: el._today ? '오늘 위치도' : '이 날 위치도' }), el._locList);
    el._hint = h('p', { class: 'home-hint', 'data-testid': 'day-order-hint', text: '길게 눌러 끌면 순서가 바뀌어요', hidden: true });
    el.append(h('div', { class: 'home-page-head' }, el._sum, el._xp), el._list, el._hint, el._empty, el._near, ...(day < today ? [addBtn(day, nav)] : []), el._loc);
    // 길게 눌러 끌기(목록 줄 = 항목). 날짜 넘기기와 다투지 않는다(든 뒤에는 그 손가락의 움직임을 위로 안 보냄 — reorder.js)
    const pageEl = el;
    el._ro = reorderable(el._list, {
      mode: 'list', start: 'longpress', longPressMs: LONG_MS, keyOf: x => x.dataset.id,
      onLift: () => { pageEl._before = (store.recordsOfDay(day) || []).map(r => r.id); },
      onCancel: () => { pageEl._before = null; },
      onDrop: ({ keys }) => dropRecords(day, keys, pageEl),
    });
    const want = scrollWant(day, today, recs.length, ctx.scroll);
    if (ctx.scroll?.day === day) ctx.scroll = null;                    // 다녀온 자리는 한 번만(캐시에서 빠졌다 다시 그릴 때는 기본으로)
    if (want) requestAnimationFrame(() => setScroll(pageEl, want));
  }
  let photos = 0;
  for (const r of recs) photos += cnt(store.photosOf(r.id));
  el._sum.textContent = `묶음 ${recs.length} · 사진 ${photos}`;
  el._xp.hidden = !recs.length;
  // 길게 누르는 중·끄는 중에는 줄을 건드리지 않는다(줄이 바뀌면 들지 못하거나 끌기가 취소된다) — 뗀 뒤 이 날을 다시 그린다
  if (el._ro && el._ro.state() !== 'idle') el._ro.afterDrag(() => ctx.refresh?.(day));
  else {
    dom.syncList(el._list, recs, { key: r => r.id, sig: rowSig, make: r => rowW.recordRow(r, { onOpen: x => nav.go('record', { id: (x && x.id) || r.id }) }) });
    el._n = recs.length; el._last = recs.at(-1)?.id;
    if (follow) { const pageEl = el; requestAnimationFrame(() => setScroll(pageEl, 'end')); }
  }
  el._hint.hidden = !(recs.length >= 2 && !hintDone());
  if (!el._hint.hidden) countHint();
  el._list.hidden = !recs.length;
  el._empty.hidden = !!recs.length;
  el._empty.textContent = el._today ? '아직 기록이 없어요. 아래 [기록 시작]을 눌러요.' : '이 날짜엔 기록이 없어요.';
  const near = !recs.length && !el._today ? nearestDay(day, today) : null;
  el._near.hidden = !near;
  if (near) { el._near.dataset.day = near; el._near.textContent = `가장 가까운 기록 ${dayLabel(near).replace(/ \(.\)$/, '')} 보기`; }
  // 그 날 위치도 — 도면·쪽별 한 줄(미리보기 한 장 + 핀 점) → 도면 보기
  let groups = [];
  if (M && recs.length) { try { groups = locGroups(M, recs); } catch (e) { console.warn('위치도 묶기 실패', e); } }
  el._loc.hidden = !groups.length;
  dom.syncList(el._locList, groups, { key: g => g.key, sig: groupSig, make: g => locRow(g, M, nav) });
  return el;
}

export default {
  mount(root, params, nav) {
    let dead = false, shownDay = dayKey(Date.now());
    hintCounted = false;                                       // 안내가 보이면 이 화면에서 한 번 센다
    let docsMod = null, offDocs = null;

    // 상단 바
    const siteName = h('b', { class: 'home-site' });
    const settingsBtn = h('button', { type: 'button', class: 'icbtn', 'data-testid': 'settings-btn', 'aria-label': '설정', on: { click: () => nav.go('settings') } }, icon('gear'));
    const bar = h('div', { class: 'bar home-bar' },
      h('div', { class: 'home-title' }, h('small', { class: 'home-app', text: config.APP_NAME || '현장사진대지 lite' }), siteName),
      settingsBtn);
    siteName.addEventListener('click', () => { if (!(store.settings?.().siteName || '').trim()) nav.go('settings'); });

    // 백업 알림
    const backupText = h('span', { class: 'home-backup-t' });
    const backup = h('button', { type: 'button', class: 'home-backup', 'data-testid': 'home-backup', on: { click: () => nav.go('settings') } },
      h('span', { class: 'home-backup-mark', text: '!', 'aria-hidden': 'true' }), backupText, icon('chev'));

    // 현재 위치 카드
    let gpsStop = gps.start?.();
    const line = gpsW.gpsLine({});
    // 누를 수 있다는 단서: 카드 끝 「지도 >」(글자 — 아이콘만으로 알리지 않는다)
    const mapCue = h('span', { class: 'home-gps-map', 'aria-hidden': 'true' }, icon('map', 18), h('span', { text: '지도' }), icon('chev', 16));
    mapCue.hidden = !canGo('map');                              // 지도 화면이 없는 판에서는 단서도 없다
    const gpsCard = h('div', { class: 'home-gps', 'data-testid': 'gps-card', role: 'button', tabindex: '0', 'aria-label': mapCue.hidden ? null : '실시간 위치 지도 열기' }, line.el, mapCue);
    const retryGps = () => {
      const st = gps.snapshot?.()?.state;
      if (st === 'denied') toast('위치 권한이 꺼져 있어요. 휴대폰 설정 > 앱 > 권한에서 위치를 켜 주세요', 4000);
      else if (st === 'off' || st === 'error' || st === 'unsupported') toast(st === 'unsupported' ? '이 기기에선 위치를 쓸 수 없어요' : '위치를 다시 찾아요');
      else { if (canGo('map')) nav.go('map'); return; }          // 찾는 중·잡았음 → 실시간 위치 지도
      if (st === 'unsupported') return;
      if (typeof gps.retry === 'function') gps.retry().catch?.(e => console.warn('위치 다시 묻기 실패', e));
      else { try { gpsStop?.(); } catch { /* 무시 */ } gpsStop = gps.start?.(); }
    };
    gpsCard.addEventListener('click', retryGps);
    gpsCard.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); retryGps(); } });

    // [도면]·[자료함] — 위치 카드 오른쪽의 아이콘+글자 버튼(48px). 개수 등 보조 글은 읽어 주기(aria-label)로만
    const dwgSub = { textContent: '핀·길찾기' };                                  // 보조 글(aria-label 에 붙는다)
    const dwgBtn = h('button', { type: 'button', class: 'home-qbtn', 'data-testid': 'home-drawings', 'aria-label': '도면보관함', on: { click: () => nav.go('drawings') } },
      icon('drawing', 22), h('span', { class: 'home-qbtn-t', text: '도면' }));
    const docsSub = { textContent: '엑셀·문서 보기' };
    const docsBtn = h('button', { type: 'button', class: 'home-qbtn', 'data-testid': 'home-docs', 'aria-label': '자료함', on: { click: () => nav.go('docs') } },
      icon('doc', 22), h('span', { class: 'home-qbtn-t', text: '자료함' }));
    const tiles = h('div', { class: 'home-quick' }, gpsCard, dwgBtn, docsBtn);
    // 지금 서 있는 도면(위치 맞춘 도면 안) — 있을 때만 한 줄, 누르면 그 도면
    let hereId = null;
    const hereName = h('b', { class: 'home-here-n' });
    const hereRow = h('button', { type: 'button', class: 'home-here', 'data-testid': 'home-here', hidden: true, on: { click: () => { if (hereId) nav.go('drawview', { id: hereId }); } } },
      icon('drawing', 18), h('span', { class: 'home-here-t' }, '지금 여기: ', hereName), h('span', { class: 'home-here-go', text: '열기' }), icon('chev', 16));

    // 날짜 넘기기 — 처음은 params.day(묶음 상세에서 돌아옴·지도 마커 등) 아니면 오늘
    let dwgMod = null;
    const today0 = dayKey(Date.now());
    const day0 = validDay(params?.day) && params.day < today0 ? params.day : today0;
    if (day0 === today0) delete params.day;
    const ctx = { nav, M: null, scroll: params.scroll && typeof params.scroll === 'object' ? params.scroll : null, refresh: null };
    const pager = dayPager({
      day: day0, max: today0,
      renderDay: (d, old) => dayPage(d, old, ctx),
      onChange: d => { if (d === dayKey(Date.now())) delete params.day; else params.day = d; paintStart(d); },   // 넘기는 중에 온다 — pager.day() 는 아직 앞 날짜
      onDrop: (d, el) => { try { el?._ro?.destroy(); } catch { /* 무시 */ } },   // 캐시에서 빠진 페이지의 끌기 걷기
    });
    ctx.refresh = d => { if (!dead) pager.refresh(d); };
    mounted = { pager };
    const curPage = () => pager.el.querySelector(`.dpg-page[data-day="${pager.day()}"] > .home-page`);
    // 떠날 때 보던 자리(묶음 상세·촬영에 다녀오면 다시 mount 된다 — router 가 같은 params 를 쥔다)
    function saveScroll() {
      try {
        const el = curPage(), w = el?.parentElement;
        if (!w || w.hidden) return;
        params.scroll = { day: pager.day(), top: Math.round(w.scrollTop), end: atEnd(el), n: el._n ?? 0 };
      } catch { /* 그만 */ }
    }

    // dock
    const startSub = h('span', { class: 'start-sub' });
    const startBtn = h('button', { type: 'button', class: 'start', 'data-testid': 'start-btn', on: { click: () => nav.go('capture', { day: dayKey(Date.now()) }) } },
      h('b', { text: '기록 시작' }), startSub);
    // 손가락이 닿는 순간 카메라 준비를 먼저(떼기까지 100~200ms 벌기) — 없으면 그만
    startBtn.addEventListener('pointerdown', () => { try { camera.warm?.(); } catch (e) { console.warn('카메라 미리 준비 실패', e); } }, { passive: true });
    const dock = h('div', { class: 'dock home-dock' }, startBtn);

    root.classList.add('home-scr', 'home-paged');
    root.append(bar, backup, tiles, hereRow, pager.el, dock);

    function paintStart(d = pager.day()) {
      if (dead) return;
      const t = startSubText(d, dayKey(Date.now()), (store.lastLocation?.() || '').trim());
      if (startSub.textContent !== t) startSub.textContent = t;
    }

    function renderDocs() {
      if (!docsMod?.docs) return;
      try {
        const all = docsMod.docs() || [];
        const pinned = all.filter(d => d.pinned).length;
        docsSub.textContent = all.length ? (pinned ? `${all.length}개 · 고정 ${pinned}` : `자료 ${all.length}개`) : '엑셀·문서 올리기';
        docsBtn.setAttribute('aria-label', `자료함, ${docsSub.textContent}`);
      } catch (e) { console.warn('자료함 개수를 읽지 못했다', e); }
    }

    // 도면 타일 — 위치가 바뀌어도 글이 같으면 DOM 을 건드리지 않는다
    let offDwg = null, offGpsDwg = null, idleT = 0, hereSig = '';
    function renderDrawings() {
      if (!dwgMod?.drawings || dead) return;
      try {
        const list = dwgMod.drawings() || [];
        // 「지금 여기」는 위치 맞춘 도면이 생긴 뒤에만 위치 알림을 본다(약 10m 움직였을 때만 다시 — 글이 바뀔 때만 DOM 에)
        if (!offGpsDwg && typeof gps.on === 'function' && list.some(d => d?.geo?.T)) {
          offGpsDwg = () => {};                                   // 구독 중 표시(알림이 바로 와도 두 번 구독하지 않게)
          offGpsDwg = gps.on(s => {
            const p = s?.pos, sig = p ? `${p.lat.toFixed(4)},${p.lng.toFixed(4)}` : '';
            if (sig !== hereSig) { hereSig = sig; renderDrawings(); }
          });
        }
        const pos = gps.snapshot?.()?.pos;
        const hd = pos && list.length ? dwgMod.drawingsAt?.(pos)?.find(x => x.outsideM === 0)?.drawing : null;
        const here = hd?.name ? hd.name.replace(/\.[A-Za-z0-9]{1,10}$/, '') : '';
        const t = drawingsSub(list, here);
        if (dwgSub.textContent !== t) { dwgSub.textContent = t; dwgBtn.setAttribute('aria-label', `도면보관함, ${t}`); }
        dwgBtn.classList.toggle('here', !!here);
        hereId = hd?.id || null;
        hereRow.hidden = !here;
        if (here && hereName.textContent !== here) hereName.textContent = here;
      } catch (e) { console.warn('도면 개수를 읽지 못했다', e); }
    }

    // 현장명·백업 알림(가장 오래된 기록 날짜로)
    function paintTop(now) {
      const s = store.settings?.() || {};
      const site = (s.siteName || '').trim();
      siteName.textContent = site || '현장명 없음 · 설정에서 넣기';
      siteName.classList.toggle('dim', !site);
      let oldest = null;
      for (const d of store.days?.() || []) { const t = dayStart(d.day); if (oldest == null || t < oldest) oldest = t; }
      const note = backupNotice(store.meta?.('lastBackupAt', null), oldest, now);
      backup.hidden = !note;
      if (note) backupText.textContent = note;
    }

    function render() {
      if (dead) return;
      const ro = curPage()?._ro;
      if (ro && ro.state() !== 'idle') { ro.afterDrag(schedule); return; }   // 길게 누르는 중·끄는 중에 다시 그리면 들지 못하거나 끌기가 취소된다 — 뗀 뒤 한 번
      const now = Date.now(), today = dayKey(now);
      paintTop(now);
      // 날짜 페이지 — 자정을 넘기면 「오늘」을 바꾼다. 현재 페이지는 바로(바뀐 줄만), 이웃은 한 박자 뒤, 나머지 캐시는 다음에 보일 때
      if (today !== shownDay) { shownDay = today; pager.setMax(today); }
      pager.refresh();
      paintStart();
      renderDocs();
    }
    // store 알림 반영은 글 입력이 끝난 뒤 한 번(시트 뒤 목록을 쓰는 동안 다시 그리지 않게)
    let queued = false;
    const schedule = typeof dom.deferWhileTyping === 'function' ? dom.deferWhileTyping(render) : () => { if (!queued) { queued = true; queueMicrotask(() => { queued = false; render(); }); } };

    const off = store.on(ch => {
      if (ch?.records?.size || ch?.photos?.size || ch?.settings || ch?.meta?.has?.('lastLocation') || ch?.meta?.has?.('lastBackupAt')) schedule();
    });
    const tick = setInterval(() => { if (dayKey(Date.now()) !== shownDay) schedule(); else paintStart(); }, 60000);
    // 첫 그림: 날짜 페이지는 dayPager 가 이미 그렸다 — 나머지(현장명·백업·dock 글)만
    paintTop(Date.now());
    paintStart();

    // 자료함(J) — 없거나 아직 초기화 전이어도 홈은 돈다
    import('../../data/docs.js').then(m => {
      if (dead) return;
      docsMod = m;
      try { offDocs = m.onDocs?.(() => { if (!dead) renderDocs(); }); } catch { /* 무시 */ }
      renderDocs();
    }).catch(e => console.warn('자료함 모듈을 불러오지 못했다', e));

    // 도면보관함 — 첫 그림 뒤 한가할 때 연다. 모듈이 없거나 실패해도 홈은 돈다(타일은 기본 글, 날짜 페이지에 위치도만 빠짐)
    idleT = idle(() => {
      idleT = 0;
      import('../../data/drawings.js').then(async m => {
        await m.ready?.();
        if (dead) return;
        dwgMod = m; ctx.M = m;
        try { offDwg = m.onDrawings?.(() => { if (!dead) { renderDrawings(); schedule(); } }); } catch { /* 무시 */ }
        renderDrawings();
        pager.refresh();                                          // 위치도 구역을 채운다(핀이 없으면 그대로 숨김)
      }).catch(e => console.warn('도면보관함 모듈을 불러오지 못했다', e));
    });

    return () => {
      saveScroll();
      dead = true;
      if (mounted?.pager === pager) mounted = null;
      schedule.cancel?.();
      clearInterval(tick);
      off?.(); offDocs?.(); offDwg?.(); offGpsDwg?.();
      if (idleT) unIdle(idleT);
      try { pager.destroy(); } catch { /* 무시 */ }
      try { line.destroy?.(); } catch { /* 무시 */ }
      try { gpsStop?.(); } catch { /* 무시 */ }
      dock.remove();
    };
  },
  // 홈 탭을 다시 누름(params {}) = 오늘로, 지도 마커 등에서 home { day } = 그 날짜로 — 다시 mount 하지 않고 넘긴다
  onReenter(p) {
    if (!mounted) return false;
    const t = dayKey(Date.now());
    const d = validDay(p?.day) && p.day < t ? p.day : t;
    mounted.pager.go(d, { animate: true });
    return true;
  },
  // 안드로이드 뒤로: 지난 날을 보고 있으면 오늘로(그다음 뒤로 = 앱 최소화)
  onBack() {
    const t = dayKey(Date.now());
    if (mounted && mounted.pager.day() !== t) { mounted.pager.go(t, { animate: true }); return true; }
    return false;
  },
};
