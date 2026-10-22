// 내보내기 화면(SPEC §6.6) — 기간 칩 → 요약(묶음·사진·워터마크) → [만들기] → 진행률 → 결과 카드 [공유]/[저장].
// 100장이 넘는 날(review-notes 11): 막지 않는다. exporter 가 사진대지를 100장씩 나눠(사진대지_1021_1.xlsx, _2.xlsx) 한 ZIP 에 담는다 — 화면은 그 안내만.
// 웹 공유 한도(review-notes 4): 크롬 Web Share 는 zip 을 못 보낸다 → 웹에서 보낼 수 없으면 [공유]를 숨기고 [내려받기]만 둔다.
// 고른 기간은 params 에 남긴다(공유 앱에 다녀와 다시 mount 돼도 그대로). 만드는 중·결과는 화면 밖(job)에 둔다.
import * as dom from '../dom.js';
import * as store from '../../data/store.js';
import * as exporter from '../../services/exporter.js';
import * as native from '../../platform/native.js';
import * as config from '../../config.js';
import { dayKey, addDays, weekStart, hm, mdw } from '../../core/date.js';

const { h, icon, toast } = dom;
const MAX = config.MAX_EXPORT_PHOTOS ?? 100;

const isApp = () => { try { return !!native.isNative?.(); } catch { return false; } };
const fmtSize = n => (!Number.isFinite(n) ? '' : n >= 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.max(1, Math.round(n / 1e3))}KB`);
const errText = e => (e?.code === 'QUOTA' ? '저장 공간이 부족해요' : e?.message || String(e || '알 수 없는 오류'));
const md = key => { const [, m, d] = key.split('-').map(Number); return `${m}월 ${d}일`; };

function canShareFile(r) {
  if (isApp()) return true;
  try {
    if (!r?.blob || !navigator.canShare) return false;
    return navigator.canShare({ files: [new File([r.blob], r.name, { type: r.blob.type || 'application/zip' })] });
  } catch { return false; }
}
function lock(btn, fn) {
  if (dom.lockButton) return dom.lockButton(btn, fn);
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try { await fn(); } finally { btn.disabled = false; }
  });
}

// 기간 칩 — 'given'(이 날짜)은 params.from 이 들어왔을 때만
function rangeOf(st, now = Date.now()) {
  const today = dayKey(now);
  switch (st.range) {
    case 'given': return { from: st.givenFrom, to: st.givenTo || st.givenFrom };
    case 'yesterday': { const d = addDays(today, -1); return { from: d, to: d }; }
    case 'week': return { from: weekStart(today), to: today };
    case 'custom': {
      let f = st.from || today, t = st.to || f;
      if (f > t) [f, t] = [t, f];
      return { from: f, to: t };
    }
    default: return { from: today, to: today };
  }
}
const rangeText = r => (r.from === r.to ? md(r.from) : `${md(r.from)} ~ ${md(r.to)}`);

const WM_TEXT = { off: '워터마크 없이 내보내요', loc: '위치를 사진에 넣어요', 'loc+content': '위치+내용을 사진에 넣어요' };

// 화면 밖 상태 — 만드는 중에 나갔다 와도 진행·결과가 이어진다
const job = { busy: false, done: 0, total: 0, key: '', result: null, error: null };
let live = null;

export default {
  dark: false,
  mount(root, params = {}, nav) {
    let dead = false;
    const today = dayKey(Date.now());
    // params 를 상태로 쓴다(다시 mount 돼도 같은 선택)
    const st = params;
    if (!st._init) {
      st._init = true;
      st.givenFrom = params.from || null;
      st.givenTo = params.to || params.from || null;
      st.range = st.givenFrom ? (st.givenFrom === today && st.givenTo === today ? 'today' : 'given') : 'today';
      st.from = st.givenFrom || today; st.to = st.givenTo || today;
    }
    const chipsDef = [
      st.givenFrom && !(st.givenFrom === today && st.givenTo === today) ? ['given', st.givenFrom === st.givenTo ? '이 날짜' : '이 기간'] : null,
      ['today', '오늘'], ['yesterday', '어제'], ['week', '이번 주'], ['custom', '직접'],
    ].filter(Boolean);

    const chips = chipsDef.map(([v, label]) => h('button', {
      type: 'button', class: 'xp-chip', 'data-testid': 'export-range', 'data-value': v,
      on: { click: () => { st.range = v; job.result = null; job.error = null; paint(); } },
    }, label));
    const fromIn = h('input', { type: 'date', class: 'input xp-date', 'aria-label': '시작 날짜', 'data-role': 'range-from' });
    const toIn = h('input', { type: 'date', class: 'input xp-date', 'aria-label': '끝 날짜', 'data-role': 'range-to' });
    fromIn.value = st.from; toIn.value = st.to; fromIn.max = today; toIn.max = today;
    const onDate = () => { st.from = fromIn.value || today; st.to = toIn.value || st.from; job.result = null; paint(); };
    fromIn.addEventListener('change', onDate); toIn.addEventListener('change', onDate);
    const custom = h('div', { class: 'xp-custom' }, fromIn, h('span', { class: 'xp-tilde', text: '~' }), toIn);

    const rangeLine = h('p', { class: 'xp-range', 'data-role': 'range-text' });
    const sumBox = h('div', { class: 'xp-sum', 'data-role': 'summary' });
    const warnBox = h('div', { class: 'xp-warns' });
    const wmLine = h('div', { class: 'xp-wm' });
    const progress = h('div', { class: 'xp-progress', role: 'status', hidden: true },
      h('div', { class: 'xp-bar' }, h('div', { class: 'xp-bar-fill' })), h('p', { class: 'xp-progress-text' }));
    const resultBox = h('div', { class: 'xp-result-box' });
    const buildBtn = h('button', { type: 'button', class: 'primary xp-build', 'data-testid': 'export-build' }, icon('table'), h('span', { text: '사진대지 만들기' }));

    buildBtn.addEventListener('click', () => start());

    async function start() {
      if (job.busy) return;
      const r = rangeOf(st);
      let p;
      try { p = exporter.plan(r); } catch (e) { toast(`만들 수 없어요 — ${errText(e)}`); return; }
      if (!p.photoCount) { toast('이 기간에는 사진이 없어요'); return; }
      Object.assign(job, { busy: true, done: 0, total: p.photoCount, key: `${r.from}|${r.to}`, result: null, error: null });
      live?.();
      try {
        const res = await exporter.build(r, (done, total) => { job.done = done; job.total = total; live?.(); });
        job.result = { ...res, photos: p.photoCount, at: Date.now() };
        toast('사진대지를 만들었어요');
      } catch (e) {
        console.warn('내보내기 실패', e);
        job.error = errText(e);
        toast(`만들지 못했어요 — ${job.error}`, 5000);
      } finally { job.busy = false; live?.(); }
    }

    async function deliver(how) {
      const res = job.result;
      if (!res) return;
      try {
        const r = await exporter.deliver(res, how);
        if (r && r.ok === false && !r.cancelled) toast(`${how === 'share' ? '공유' : '저장'}하지 못했어요${r.error ? ` — ${r.error}` : ''}`, 4000);
        else if (how === 'save') toast(r?.where && r.where !== 'download' && r.where !== 'share' ? `${r.where}에 저장했어요` : isApp() ? '문서/현장사진대지 lite에 저장했어요' : '내려받았어요');
      } catch (e) { toast(`${how === 'share' ? '공유' : '저장'}하지 못했어요 — ${errText(e)}`, 4000); }
    }

    let resultSig = '';
    function paintResult() {
      const res = job.result;
      const sig = res ? `${res.name}|${res.size}|${res.at}` : job.error ? `e:${job.error}` : '';
      if (sig === resultSig) return;
      resultSig = sig;
      if (!res) {
        resultBox.replaceChildren(...(job.error ? [h('p', { class: 'xp-error', role: 'alert', text: `만들지 못했어요 — ${job.error}` })] : []));
        return;
      }
      const btns = [];
      if (canShareFile(res)) {
        const sh = h('button', { type: 'button', class: 'secondary xp-act', 'data-testid': 'export-share' }, icon('share'), '공유');
        lock(sh, () => deliver('share'));
        btns.push(sh);
      }
      const sv = h('button', { type: 'button', class: 'secondary xp-act', 'data-testid': 'export-save' }, icon('download'), isApp() ? '저장' : '내려받기');
      lock(sv, () => deliver('save'));
      btns.push(sv);
      btns[0].classList.replace('secondary', 'primary');                     // 만든 뒤 할 일(공유·내려받기)이 주 행동 — 노랑은 하나만
      resultBox.replaceChildren(h('div', { class: 'xp-result', 'data-testid': 'export-result' },
        h('div', { class: 'xp-result-head' }, icon('zip'),
          h('div', { class: 'xp-result-text' },
            h('span', { class: 'xp-file-name', 'data-role': 'file-name', text: res.name }),
            h('span', { class: 'xp-file-meta', text: [`사진 ${res.photos}장`, res.locmaps ? `위치도 ${res.locmaps}장` : '', fmtSize(res.size), `${mdw(res.at)} ${hm(res.at)}`].filter(Boolean).join(' · ') }))),
        res.locmapSkipped ? h('p', { class: 'xp-hint', 'data-role': 'locmap-skipped', text: `위치도 ${res.locmapSkipped}장은 도면 그림이 없어 뺐어요` }) : null,
        h('div', { class: 'xp-result-btns' }, ...btns),
        isApp() ? h('p', { class: 'xp-hint', text: '저장하면 문서/현장사진대지 lite 폴더에 들어가요' }) : null));
    }

    function paint() {
      if (dead) return;
      for (const c of chips) { const on = c.dataset.value === st.range; c.setAttribute('aria-pressed', String(on)); c.classList.toggle('on', on); }
      custom.hidden = st.range !== 'custom';
      const r = rangeOf(st);
      rangeLine.textContent = rangeText(r);
      let p = null;
      try { p = exporter.plan(r); } catch (e) { console.warn('plan 실패', e); }
      const recs = p?.records || [];
      const n = p?.photoCount || 0;
      sumBox.replaceChildren(
        h('div', { class: 'xp-num' }, h('b', { text: String(recs.length) }), h('span', { text: '묶음' })),
        h('div', { class: 'xp-num' }, h('b', { text: String(n) }), h('span', { text: '사진' })),
        h('div', { class: 'xp-num' }, h('b', { text: String(p?.days?.length || 0) }), h('span', { text: '날짜' })));
      const warns = [];
      if (!n) warns.push(h('p', { class: 'xp-empty', text: recs.length ? '사진이 없어요 — 사진을 찍은 날을 골라요' : '이 기간에는 기록이 없어요' }));
      if (n > MAX) {
        const parts = p.parts?.length || Math.ceil(n / MAX);
        warns.push(h('p', { class: 'xp-warn', 'data-role': 'over', text: `사진이 ${n}장이라 사진대지를 ${MAX}장씩 ${parts}개로 나눠 담아요` }));
      }
      const noLoc = recs.filter(x => !String(x.location || '').trim() && (x.photoIds || []).length);
      if (noLoc.length) {
        warns.push(h('button', { type: 'button', class: 'xp-warn xp-warn-btn', 'data-role': 'no-location',
          on: { click: () => nav.go('record', { id: noLoc[0].id }) } },
        h('span', { text: `위치 미입력 묶음 ${noLoc.length}개` }), h('span', { class: 'xp-fix', text: '고치기' }), icon('chev')));
      }
      warnBox.replaceChildren(...warns);
      const mode = store.settings().wmMode;
      wmLine.replaceChildren(h('span', { class: 'xp-wm-text', text: WM_TEXT[mode] || WM_TEXT['loc+content'] }),
        h('button', { type: 'button', class: 'xp-link', 'data-role': 'wm-settings', on: { click: () => nav.go('settings') }, text: '설정에서 바꾸기' }));
      // 다른 기간의 결과는 숨긴다
      if (job.result && job.key !== `${r.from}|${r.to}`) job.result = null;
      paintJob(n);
    }

    function paintJob(n = null) {
      progress.hidden = !job.busy;
      if (job.busy) {
        const pct = job.total ? Math.round((job.done / job.total) * 100) : 0;
        progress.querySelector('.xp-bar-fill').style.width = `${pct}%`;
        progress.querySelector('.xp-progress-text').textContent = `만드는 중… ${job.done}/${job.total}장 · 앱을 끄지 마세요`;
      }
      buildBtn.disabled = job.busy || n === 0;
      buildBtn.setAttribute('aria-busy', String(job.busy));
      buildBtn.lastChild.textContent = job.busy ? '만드는 중…' : job.result ? '다시 만들기' : '사진대지 만들기';
      buildBtn.classList.toggle('primary', !job.result);
      buildBtn.classList.toggle('secondary', !!job.result);
      paintResult();
    }

    const backBtn = h('button', { type: 'button', class: 'icbtn', 'aria-label': '뒤로', on: { click: () => nav.back() } }, icon('back'));
    const wrap = h('div', { class: 'scr-export', 'data-screen': 'export' },
      h('div', { class: 'xp-wrap' },
        h('div', { class: 'bar' }, backBtn, h('h1', { text: '내보내기' })),
        h('p', { class: 'note xp-note', text: '사진대지 엑셀과 사진을 ZIP 하나로 만들어요.' }),
        h('div', { class: 'xp-chips', role: 'group', 'aria-label': '기간' }, ...chips),
        custom,
        h('div', { class: 'xp-card' }, rangeLine, sumBox, wmLine),
        warnBox, progress, resultBox),
      h('div', { class: 'dock xp-dock' }, buildBtn));
    root.append(wrap);

    live = () => { if (!dead) paintJob(); };
    paint();
    let raf = 0;
    const off = store.on?.(() => { if (!raf && !dead) raf = requestAnimationFrame(() => { raf = 0; if (!job.busy) paint(); }); });

    return () => {
      dead = true;
      if (live) live = null;
      if (raf) cancelAnimationFrame(raf);
      off?.();
    };
  },
};
