// 문서 뷰어 iframe 한 개를 감싼 부품(SPEC §10.2·§10.5) — 자료 보기 화면과 촬영 화면이 같이 쓴다.
// 원본 js/ui/viewer.js 방식: iframe src=viewer/index.html?embed=1 → av:ready 또는 load 중 먼저 오는 것(60초 한도)
// → postMessage({ type:'av:open', name, data: ArrayBuffer }, '*', [data])(옮겨 보냄 — 이쪽에 복사본이 안 남는다).
// iframe 은 한 번 만들면 DOM 에서 옮기지 않는다(옮기면 다시 로드돼 확대 위치·열린 파일이 날아감). 배치 전환은 CSS 로만.
// 같은 문서를 다시 open 하면 아무것도 안 한다(확대 위치 유지).
import { h } from '../dom.js';
import * as D from '../../data/docs.js';

const SRC = new URL('../../../viewer/index.html?embed=1', import.meta.url).href;   // 이 모듈 기준(앱 루트·www/dev 시험 페이지 어디서 써도 같은 뷰어)
const UP_MS = 60000;
const HINT = 'PDF·도면은 처음 열 때 인터넷에서 엔진을 받아 기기에 저장해요.';
const HINT_KEY = 'lite.viewerHint';

// 뷰어 사본은 고치지 않는다 — 같은 출처 iframe 이라 바깥에서 스타일만 넣는다.
// 늘: 도구 막대 버튼을 손가락 크기로, 넘치면 옆으로 밀기, 임베드에서 안 쓰는 정보·내려받기는 숨김(쪽 수 칸이 들어가게)
// 오른쪽 .core-actions(전체 화면 하나)는 숨긴다 — 바깥 화면이 이미 꽉 차 있고, 줄어든 #vbars 위에 겹쳐 「다음 쪽」을 가렸다. [100%]도 숨겨 쪽 넘김이 360 폭에 들어오게
const EMBED_CSS = '#toolbar{overflow-x:auto;scrollbar-width:none}#toolbar::-webkit-scrollbar{display:none}'
  + '#vbars{overflow-x:auto;scrollbar-width:none}#vbars::-webkit-scrollbar{display:none}'
  + '#toolbar .tb-btn{height:40px;min-width:40px}#btn-info,#btn-download,.core-actions{display:none!important}'
  + '#toolbar .tb-zoom{display:none!important}';                       // 배율 글(누르면 100%) — 쪽 넘김이 들어갈 자리
// 작은 창(만질 수 없음): 도구 막대를 숨겨 그 자리까지 도면에.
// 뷰어 #main 은 grid-template-rows: 막대(40px) 1fr 이라 막대만 숨기면 #stages 가 40px 첫 줄로 올라가 도면이 손톱만 해진다
// → 줄을 하나(1fr)로 바꿔 무대가 창 전체를 쓰게 한다
const PASSIVE_CSS = '#toolbar{display:none!important}#main{grid-template-rows:minmax(0,1fr)!important}';

// hint=false: 처음 한 번 안내 띠를 띄우지 않는다(촬영 화면 — 작은 창을 가리지 않게). 대신 늦게 열리면 '여는 중' 글에 이유를 붙인다
export function docFrame({ onState, hint: hintOn = true } = {}) {
  const note = h('div', { class: 'df-note', role: 'status', 'data-testid': 'docframe-note' });
  const shield = h('div', { class: 'df-shield', 'aria-hidden': 'true' });
  const hint = h('div', { class: 'df-hint', role: 'status' });              // 처음 한 번 안내 — 전역 토스트 대신 이 창 아래 띠(촬영 화면 내용 줄을 가리지 않게)
  note.hidden = true; shield.hidden = true; hint.hidden = true;
  const el = h('div', { class: 'docframe', 'data-testid': 'docframe' }, note, shield, hint);
  function hintOnce() {
    if (!hintOn) return;
    try { if (localStorage.getItem(HINT_KEY)) return; localStorage.setItem(HINT_KEY, '1'); } catch { /* 저장 못 해도 안내는 한다 */ }
    hint.textContent = HINT; hint.hidden = false;
    setTimeout(() => { hint.hidden = true; }, 6000);
  }
  const fdoc = () => { try { return frame?.contentDocument || null; } catch { return null; } };
  function styleIn(id, css, on) {
    const d = fdoc();
    if (!d?.head) return;
    let s = d.getElementById(id);
    if (on && !s) { s = d.createElement('style'); s.id = id; s.textContent = css; d.head.append(s); }
    else if (!on && s) s.remove();
  }
  // 맞춤 — 뷰어의 [화면 맞춤]·[폭 맞춤] 버튼을 대신 누른다(뷰어 사본은 고치지 않음, 버튼은 숨겨져 있어도 click() 은 된다).
  // 작은 창 = 화면 맞춤(한눈에 쪽 전체), 크게 = 폭 맞춤(확대 자유). 뷰어는 맞춤 모드면 무대 크기가 바뀔 때 스스로 다시 맞추지만,
  // 엔진(PDF·도면)마다 다르고 첫 그리기가 늦으므로 창 크기가 바뀔 때마다 바깥에서도 한 번 더 누른다.
  const zoomBtn = word => {
    const d = fdoc();
    if (!d) return null;
    const bs = [...d.querySelectorAll('#toolbar .active button'), ...d.querySelectorAll('#toolbar button')];
    return bs.find(x => (x.title || '').startsWith(word)) || null;
  };
  const press = word => { const b = zoomBtn(word); if (!b) return false; try { b.click(); } catch { /* 뷰어 안 오류 무시 */ } return true; };
  let fitTimers = [], fitPoll = 0, forced = false;
  // 사용자가 크게 볼 때 직접 확대했으면(확대·축소 버튼, 두 손가락, 휠) 배치를 바꿔도 맞춤을 누르지 않는다 — 찾아 둔 자리가 찍을 때마다 사라지지 않게
  let userZoomed = false;
  function watchZoom() {
    const d = fdoc();
    if (!d || d.__liteZoomWatch) return;
    d.__liteZoomWatch = true;
    const pts = new Set();
    d.addEventListener('click', e => {
      if (!e.isTrusted || !interactive) return;
      const t = e.target?.closest?.('button')?.title || '';
      if (/^(확대|축소|100%)/.test(t)) userZoomed = true;
      else if (/^(화면 맞춤|폭 맞춤)/.test(t)) userZoomed = false;
    }, true);
    d.addEventListener('wheel', () => { if (interactive) userZoomed = true; }, { capture: true, passive: true });
    d.addEventListener('pointerdown', e => { pts.add(e.pointerId); if (interactive && pts.size >= 2) userZoomed = true; }, true);
    const up = e => pts.delete(e.pointerId);
    d.addEventListener('pointerup', up, true); d.addEventListener('pointercancel', up, true);
  }
  // 새 문서가 실제로 그려졌나 — 앞 문서의 무대(data-doc)는 뺀다(문서를 바꾼 직후 남은 앞 문서 버튼을 누르지 않게)
  let staleDocs = new Set();
  function drawn() {
    const d = fdoc();
    const st = d?.querySelector('#stages > .stage.active');
    if (!st || staleDocs.has(st.dataset.doc)) return false;
    if (st.querySelector('.av-busy')) return false;                         // 뷰어의 '여는 중·엔진 내려받는 중' 상자
    for (const n of st.children) { const r = n.getBoundingClientRect(); if (r.width > 24 && r.height > 24) return true; }
    return false;
  }
  function clearFit() { fitTimers.forEach(clearTimeout); fitTimers = []; clearInterval(fitPoll); fitPoll = 0; }
  // 작은 창: 뷰어가 버튼을 만들 때까지(엔진을 처음 받으면 수십 초) 기다렸다가 누르고, 늦게 그려지는 쪽을 위해 몇 번 더
  function fitPassive() {
    clearFit();
    const go = () => {
      if (interactive || dead || !shown || userZoomed) { clearFit(); return true; }
      if (!drawn() || !press('화면 맞춤')) return false;
      forced = true;
      fitTimers = [300, 900, 2000].map(ms => setTimeout(() => { if (!interactive && !dead) press('화면 맞춤'); }, ms));
      return true;
    };
    if (go()) return;
    const until = Date.now() + UP_MS;
    fitPoll = setInterval(() => { if (go() || Date.now() > until) { clearInterval(fitPoll); fitPoll = 0; } }, 250);
  }
  // 창 크기가 바뀜(배치 전환·화면 회전·키보드·자리 이동) — 움직임(150ms)이 끝난 뒤 한 번
  let sizeT = 0, lastSize = '';
  const sizeRo = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const k = `${el.clientWidth}x${el.clientHeight}`;
    if (k === lastSize) return;
    lastSize = k;
    clearTimeout(sizeT);
    sizeT = setTimeout(() => {
      if (dead || !shown || !el.clientWidth || !el.clientHeight) return;
      if (!interactive) fitPassive();
      try { frame?.contentWindow?.dispatchEvent(new Event('resize')); } catch { /* 다른 출처면 무시 */ }
    }, 220);
  }) : null;
  sizeRo?.observe(el);
  function applyFrameStyle() {
    styleIn('lite-embed', EMBED_CSS, true);
    styleIn('lite-passive', PASSIVE_CSS, !interactive);
  }
  let frame = null, up = null, loads = 0;
  let cur = null;               // 띄웠거나 띄우는 중인 docId
  let shown = null;             // 실제로 뷰어에 넘긴 docId
  let token = 0, dead = false;
  const taps = new Set();
  let interactive = true;

  const state = (s, extra = {}) => { el.dataset.state = s; try { onState?.({ state: s, id: cur, ...extra }); } catch (e) { console.error(e); } };
  const say = text => { note.textContent = text; note.hidden = !text; };

  const onMsg = e => {
    if (!frame || e.source !== frame.contentWindow) return;
    if (e.data?.type === 'av:ready') up?.ok();
  };
  const onLoad = () => {
    loads++;
    applyFrameStyle();
    watchZoom();
    up?.ok();
    if (loads > 1 && shown && !dead) {          // 누가 iframe 을 옮겨 다시 로드됐다 — 띄우던 문서를 다시 넘긴다
      console.warn('뷰어 iframe 이 다시 로드됐어요 — 문서를 다시 열어요');
      const id = shown; shown = null; cur = null; open(id);
    }
  };

  // 뷰어가 메시지를 받을 준비가 되면 풀리는 약속(한 번 풀리면 계속 풀린 상태)
  function ensureFrame() {
    if (frame) return up.promise;
    frame = h('iframe', { class: 'df-frame', src: SRC, title: '문서 보기', 'data-testid': 'docframe-iframe', allow: 'fullscreen' });
    let ok, ko;
    const promise = new Promise((res, rej) => { ok = res; ko = rej; });
    const timer = setTimeout(() => ko(new Error('뷰어가 뜨지 않았어요')), UP_MS);
    up = { promise, ok: () => { clearTimeout(timer); ok(); } };
    promise.catch(() => {});
    window.addEventListener('message', onMsg);
    frame.addEventListener('load', onLoad);
    el.prepend(frame);
    return promise;
  }

  async function open(docId) {
    if (dead) return;
    if (docId && docId === cur) return;        // 같은 문서 — 그대로 둔다
    const my = ++token;
    cur = docId || null;
    if (!cur) { close(); return; }
    await D.ready().catch(err => console.warn('자료함을 열지 못했어요', err));
    if (my !== token || dead) return;
    const d = D.doc(cur);
    if (!d || d.deletedAt) { say('자료를 찾을 수 없어요'); state('error', { message: 'missing' }); return; }
    say('여는 중…'); state('loading');
    hintOnce();
    // 안내 띠를 안 띄우는 곳(촬영 화면): '여는 중' 글을 뷰어가 실제로 그릴 때까지 남기고(엔진 받기는 뷰어 안에서 일어난다),
    // 2.5초 넘게 걸리면 이유를 붙인다
    if (!hintOn) setTimeout(() => { if (my === token && !dead && !note.hidden) say('여는 중… 처음엔 엔진을 받아 저장해요'); }, 2500);
    try {
      const [blob] = await Promise.all([D.docBlob(cur), ensureFrame()]);
      if (my !== token || dead) return;
      if (!blob) { say('파일이 없어요. 자료를 다시 올려 주세요'); state('error', { message: 'nofile' }); return; }
      const buf = await blob.arrayBuffer();
      if (my !== token || dead || !frame?.contentWindow) return;
      staleDocs = new Set([...(fdoc()?.querySelectorAll('#stages > .stage') || [])].map(x => x.dataset.doc));
      if (shown) frame.contentWindow.postMessage({ type: 'av:close' }, '*');
      frame.contentWindow.postMessage({ type: 'av:open', name: d.name, data: buf }, '*', [buf]);
      shown = cur;
      forced = false;                           // 새 문서는 뷰어 기본 맞춤(폭)에서 시작
      userZoomed = false;
      if (hintOn) say('');
      else waitDrawn(my);
      state('open');
      applyFrameStyle();
      if (!interactive) fitPassive();
    } catch (err) {
      if (my !== token || dead) return;
      console.warn('문서를 뷰어에 넘기지 못했어요', err);
      cur = null;
      say('문서를 열지 못했어요. 잠시 뒤 다시 열어 주세요');
      state('error', { message: String(err?.message || err) });
    }
  }

  // 촬영 화면: 그려질 때까지(한도 UP_MS) '여는 중' 글을 남긴다
  function waitDrawn(my) {
    const until = Date.now() + UP_MS;
    const t = setInterval(() => {
      if (my !== token || dead) { clearInterval(t); return; }
      if (drawn() || Date.now() > until) { clearInterval(t); say(''); }
    }, 250);
  }

  function close() {
    token++;
    cur = null;
    if (shown && frame?.contentWindow) frame.contentWindow.postMessage({ type: 'av:close' }, '*');
    shown = null;
    say('');
    state('idle');
  }

  function setInteractive(on) {
    const was = interactive;
    interactive = !!on;
    el.classList.toggle('df-passive', !interactive);
    shield.hidden = interactive;
    applyFrameStyle();
    if (!interactive && shown) fitPassive();
    else if (interactive && !was) {
      clearFit();
      // 작은 창에서 화면 맞춤으로 바꿔 뒀으면 크게 볼 때는 폭 맞춤으로 되돌린다(창이 커진 뒤 — 움직임 150ms 뒤)
      if (forced && shown && !userZoomed) {
        forced = false;
        fitTimers = [260].map(ms => setTimeout(() => { if (interactive && !dead) press('폭 맞춤') || press('화면 맞춤'); }, ms));
      }
    }
  }
  shield.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    for (const fn of taps) { try { fn(); } catch (err) { console.error(err); } }
  });

  return {
    el,
    open,
    close,
    setInteractive,
    onTap(fn) { taps.add(fn); return () => taps.delete(fn); },
    currentId: () => cur,
    destroy() {
      dead = true;
      token++;
      clearFit();
      clearTimeout(sizeT);
      sizeRo?.disconnect();
      window.removeEventListener('message', onMsg);
      frame?.removeEventListener('load', onLoad);
      taps.clear();
      el.remove();
      frame = null;
    },
  };
}
