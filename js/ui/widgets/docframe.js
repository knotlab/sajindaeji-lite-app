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
const EMBED_CSS = '#toolbar{overflow-x:auto;scrollbar-width:none}#toolbar::-webkit-scrollbar{display:none}'
  + '#toolbar .tb-btn{height:40px;min-width:40px}#btn-info,#btn-download{display:none!important}';
// 작은 창(만질 수 없음): 도구 막대를 숨겨 그 자리까지 도면에
const PASSIVE_CSS = '#toolbar{display:none!important}';

export function docFrame({ onState } = {}) {
  const note = h('div', { class: 'df-note', role: 'status', 'data-testid': 'docframe-note' });
  const shield = h('div', { class: 'df-shield', 'aria-hidden': 'true' });
  const hint = h('div', { class: 'df-hint', role: 'status' });              // 처음 한 번 안내 — 전역 토스트 대신 이 창 아래 띠(촬영 화면 내용 줄을 가리지 않게)
  note.hidden = true; shield.hidden = true; hint.hidden = true;
  const el = h('div', { class: 'docframe', 'data-testid': 'docframe' }, note, shield, hint);
  function hintOnce() {
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
  // 작은 창이면 쪽 전체가 보이게(뷰어의 [화면 맞춤] 버튼을 대신 누른다). 문서가 늦게 그려지므로 몇 번 나눠서
  let fitTimers = [];
  function fitPassive() {
    fitTimers.forEach(clearTimeout);
    fitTimers = [0, 400, 1200, 3000].map(ms => setTimeout(() => {
      if (interactive || dead) return;
      const b = [...(fdoc()?.querySelectorAll('#toolbar button') || [])].find(x => (x.title || '').startsWith('화면 맞춤'));
      try { b?.click(); } catch { /* 뷰어 안 오류 무시 */ }
    }, ms));
  }
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
    try {
      const [blob] = await Promise.all([D.docBlob(cur), ensureFrame()]);
      if (my !== token || dead) return;
      if (!blob) { say('파일이 없어요. 자료를 다시 올려 주세요'); state('error', { message: 'nofile' }); return; }
      const buf = await blob.arrayBuffer();
      if (my !== token || dead || !frame?.contentWindow) return;
      if (shown) frame.contentWindow.postMessage({ type: 'av:close' }, '*');
      frame.contentWindow.postMessage({ type: 'av:open', name: d.name, data: buf }, '*', [buf]);
      shown = cur;
      say('');
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

  function close() {
    token++;
    cur = null;
    if (shown && frame?.contentWindow) frame.contentWindow.postMessage({ type: 'av:close' }, '*');
    shown = null;
    say('');
    state('idle');
  }

  function setInteractive(on) {
    interactive = !!on;
    el.classList.toggle('df-passive', !interactive);
    shield.hidden = interactive;
    applyFrameStyle();
    if (!interactive && shown) fitPassive();
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
      fitTimers.forEach(clearTimeout);
      window.removeEventListener('message', onMsg);
      frame?.removeEventListener('load', onLoad);
      taps.clear();
      el.remove();
      frame = null;
    },
  };
}
