// 홈 `home`(설계서 §6.1, §10.6, §4.5-5)
// 위: 앱 이름 + 현장명, 톱니. 백업 알림 한 줄(7일 넘으면). 현재 위치 카드(gpsLine). 자료함 줄.
// 오늘 묶음(최신이 위) → 지난 날짜(30개씩 + 더 보기, [다른 날짜 열기]). 아래 dock [기록 시작].
// 1분마다 다시 계산(자정 넘김·백업 n일).
import * as dom from '../dom.js';
import * as store from '../../data/store.js';
import * as gps from '../../services/gps.js';
import * as rowW from '../widgets/recordrow.js';
import * as thumbW from '../widgets/thumb.js';
import * as gpsW from '../widgets/gpsline.js';
import * as config from '../../config.js';
import { dayKey, dayStart, mdw } from '../../core/date.js';
import { datePicker } from './day.js';

const { h, icon } = dom;
const toast = (t, ms) => dom.toast?.(t, ms);
const cnt = v => (typeof v === 'number' ? v : (v?.length ?? 0));
const DAY_MS = 864e5;
const BACKUP_WARN_DAYS = 7;
const PAGE = 30;
// 줄이 보이는 값(같으면 줄을 다시 만들지 않는다). 계산할 수 없으면 NaN — 늘 다시 만든다
const rowSig = r => (typeof rowW.recordRowSig === 'function' ? rowW.recordRowSig(r) : NaN);

// 백업 알림 문구 — 7일이 안 됐으면 null
export function backupNotice(lastBackupAt, oldestAt, now) {
  if (Number.isFinite(lastBackupAt)) {
    const d = Math.floor((now - lastBackupAt) / DAY_MS);
    return d > BACKUP_WARN_DAYS ? `마지막 백업 ${d}일 전이에요 · 백업 파일 만들기` : null;
  }
  if (Number.isFinite(oldestAt) && now - oldestAt > BACKUP_WARN_DAYS * DAY_MS) return '아직 백업 파일이 없어요 · 백업 파일 만들기';
  return null;
}

const daySig = d => `${d.day}|${cnt(d.records)}|${cnt(d.photos)}|${(d.cover || []).slice(0, 4).join(',')}`;

function dayRow(d, nav) {
  const cover = (d.cover || []).slice(0, 4);
  return h('button', { type: 'button', class: 'home-day', 'data-testid': 'day-row', 'data-day': d.day, on: { click: () => nav.go('day', { day: d.day }) } },
    h('span', { class: 'home-day-t' },
      h('b', { text: mdw(dayStart(d.day)) }),
      h('small', { text: `묶음 ${cnt(d.records)} · 사진 ${cnt(d.photos)}` })),
    h('span', { class: 'home-day-th' }, ...cover.map(pid => thumbW.thumb(pid, { className: 'home-day-img' }))),
    icon('chev'));
}

export default {
  mount(root, params, nav) {
    let dead = false, queued = false, shown = 0, shownDay = dayKey(Date.now());
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
    const gpsCard = h('div', { class: 'home-gps', 'data-testid': 'gps-card', role: 'button', tabindex: '0' }, line.el);
    const retryGps = () => {
      const st = gps.snapshot?.()?.state;
      if (st === 'denied') toast('위치 권한이 꺼져 있어요. 휴대폰 설정 > 앱 > 권한에서 위치를 켜 주세요', 4000);
      else if (st === 'off' || st === 'error' || st === 'unsupported') toast(st === 'unsupported' ? '이 기기에선 위치를 쓸 수 없어요' : '위치를 다시 찾아요');
      else return;
      if (st === 'unsupported') return;
      if (typeof gps.retry === 'function') gps.retry().catch?.(e => console.warn('위치 다시 묻기 실패', e));
      else { try { gpsStop?.(); } catch { /* 무시 */ } gpsStop = gps.start?.(); }
    };
    gpsCard.addEventListener('click', retryGps);
    gpsCard.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); retryGps(); } });

    // 자료함 줄
    const docsSub = h('small', { text: '도면·문서 보기' });
    const docsBtn = h('button', { type: 'button', class: 'home-docs', 'data-testid': 'home-docs', on: { click: () => nav.go('docs') } },
      icon('doc'), h('span', { class: 'home-docs-t' }, h('b', { text: '자료함' }), docsSub), icon('chev'));

    // 오늘
    const todayHead = h('span', { class: 'home-sec-t' });
    const todayAll = h('button', { type: 'button', class: 'home-sec-link', 'data-testid': 'today-open', on: { click: () => nav.go('day', { day: dayKey(Date.now()) }) } }, '날짜 화면');
    const todayList = h('div', { class: ['rows', 'home-list'], 'data-testid': 'today-list' });
    const todayEmpty = h('p', { class: 'home-empty', text: '아직 기록이 없어요. 아래 [기록 시작]을 눌러요.' });

    // 지난 날짜
    const pick = datePicker(d => nav.go('day', { day: d }));
    const otherBtn = h('button', { type: 'button', class: 'home-sec-link', 'data-testid': 'day-pick', on: { click: () => pick.open() } }, '다른 날짜 열기');
    const pastList = h('div', { class: ['rows', 'home-days'] });
    const pastEmpty = h('p', { class: 'home-empty', text: '지난 기록이 없어요.' });
    const moreBtn = h('button', { type: 'button', class: 'textbtn home-more', on: { click: () => { shown += PAGE; render(); } } }, '더 보기');

    // dock
    const startSub = h('span', { class: 'start-sub' });
    const startBtn = h('button', { type: 'button', class: 'start', 'data-testid': 'start-btn', on: { click: () => nav.go('capture', { day: dayKey(Date.now()) }) } },
      h('b', { text: '기록 시작' }), startSub);
    const dock = h('div', { class: 'dock home-dock' }, startBtn);

    root.classList.add('home-scr');
    root.append(
      bar, backup, gpsCard, docsBtn,
      h('div', { class: 'home-sec' }, todayHead, todayAll), todayList, todayEmpty,
      h('div', { class: 'home-sec' }, h('span', { class: 'home-sec-t', text: '지난 날짜' }), otherBtn, pick.el), pastList, pastEmpty, moreBtn,
      dock);

    function renderDocs() {
      if (!docsMod?.docs) return;
      try {
        const all = docsMod.docs() || [];
        const pinned = all.filter(d => d.pinned).length;
        docsSub.textContent = all.length ? `자료 ${all.length}개 · 고정 ${pinned}개` : '도면·문서를 올려 두고 현장에서 봐요';
      } catch (e) { console.warn('자료함 개수를 읽지 못했다', e); }
    }

    function render() {
      queued = false;
      if (dead) return;
      const now = Date.now(), today = dayKey(now);
      if (today !== shownDay) { shownDay = today; shown = 0; }
      const s = store.settings?.() || {};
      const site = (s.siteName || '').trim();
      siteName.textContent = site || '현장명 없음 · 설정에서 넣기';
      siteName.classList.toggle('dim', !site);

      // 오늘(최신이 위)
      const recs = [...(store.recordsOfDay(today) || [])].reverse();
      let photos = 0;
      for (const r of recs) photos += cnt(store.photosOf(r.id));
      todayHead.textContent = `오늘 ${mdw(now)} · 묶음 ${recs.length} · 사진 ${photos}`;
      // 바뀐 줄만 다시 만든다(사진 한 장 처리될 때마다 목록 전체·썸네일 전체를 다시 그리지 않게)
      dom.syncList(todayList, recs, { key: r => r.id, sig: rowSig, make: r => rowW.recordRow(r, { onOpen: x => nav.go('record', { id: (x && x.id) || r.id }) }) });
      todayList.hidden = !recs.length;
      todayEmpty.hidden = !!recs.length;

      // 지난 날짜
      const days = (store.days?.() || []).filter(d => d.day !== today && d.day < today);
      if (!shown) shown = PAGE;
      dom.syncList(pastList, days.slice(0, shown), { key: d => d.day, sig: daySig, make: d => dayRow(d, nav) });
      pastList.hidden = !days.length;
      pastEmpty.hidden = !!days.length;
      moreBtn.hidden = days.length <= shown;

      // 백업 알림
      let oldest = null;
      for (const d of days) { const t = dayStart(d.day); if (oldest == null || t < oldest) oldest = t; }
      if (oldest == null && recs.length) oldest = Math.min(...recs.map(r => r.createdAt).filter(Number.isFinite));
      const note = backupNotice(store.meta?.('lastBackupAt', null), oldest, now);
      backup.hidden = !note;
      if (note) backupText.textContent = note;

      const last = (store.lastLocation?.() || '').trim();
      startSub.textContent = last ? `이어서: ${last}` : '위치는 찍으면서 적어요';
      renderDocs();
    }
    const schedule = () => { if (!queued) { queued = true; queueMicrotask(render); } };

    const off = store.on(ch => {
      if (ch?.records?.size || ch?.photos?.size || ch?.settings || ch?.meta?.has?.('lastLocation') || ch?.meta?.has?.('lastBackupAt')) schedule();
    });
    const tick = setInterval(schedule, 60000);
    render();

    // 자료함(J) — 없거나 아직 초기화 전이어도 홈은 돈다
    import('../../data/docs.js').then(m => {
      if (dead) return;
      docsMod = m;
      try { offDocs = m.onDocs?.(() => { if (!dead) renderDocs(); }); } catch { /* 무시 */ }
      renderDocs();
    }).catch(e => console.warn('자료함 모듈을 불러오지 못했다', e));

    return () => {
      dead = true;
      clearInterval(tick);
      off?.(); offDocs?.();
      try { line.destroy?.(); } catch { /* 무시 */ }
      try { gpsStop?.(); } catch { /* 무시 */ }
      dock.remove();
    };
  }
};
