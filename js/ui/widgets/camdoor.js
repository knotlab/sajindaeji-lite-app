// 카메라 문(덮개) — 촬영 화면 뷰파인더 위에 겹쳐 놓는다. 누르기 전엔 카메라를 켜지 않는다(사용자 지시: "카메라 열기 버튼 + 문 열리는 애니메이션").
// 문 두 짝(진회색 판, 맞닿는 안쪽 가장자리에 하이비스·검정 빗금 띠)이 가운데에서 맞닿아 있고, 가운데 [카메라 열기](노랑 주 버튼).
//   closed  ─누름→ opening(문 약 12% 열림 + "카메라 켜는 중…") ─ready()→ open(끝까지 열림, 덮개는 탭을 통과)
//   open ─close()→ closing(약 200ms) → closed       opening ─fail(이유)→ closed + 이유 한 줄 + [다시 열기]
// 체감 속도: 움직임은 transform·opacity·visibility 만(GPU 합성) — 레이아웃·무거운 일 없음. 글자는 모두 미리 만들어 두고 opacity 로만 바꾼다.
// 상태는 data-state 로 CSS 에 넘긴다(css/camdoor.css). prefers-reduced-motion 이면 움직임 없이 바로 바뀐다(app.css 전역 규칙 + 여기 타이머 0).
import { h, icon } from '../dom.js';

const CLOSE_MS = 200;      // 닫기 애니메이션(camdoor.css 의 --cd-close 와 같게)
const SLOW_MS = 1500;      // 반쯤 열린 채 이만큼 지나면 "조금만 기다려 주세요" 한 줄을 더 보인다
const reduced = () => { try { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

// onOpen: [카메라 열기]·[다시 열기]가 눌리면 한 번(문이 닫혀 있을 때만 — 연타·열리는 중엔 부르지 않는다). 호출자는 곧바로 camera.open 을 시작한다.
export function camDoor({ onOpen, label = '카메라 열기' } = {}) {
  let st = 'closed', dead = false, slowT = 0, endT = 0, instT = 0;

  const openBtn = h('button', { type: 'button', class: 'cd-btn cd-open', 'data-testid': 'cam-open', 'aria-label': label, onclick: () => press() },
    icon('camera', 24), h('span', { class: 'cd-lab' }, label));
  const wait = h('div', { class: 'cd-wait', role: 'status', 'aria-live': 'polite' },
    h('span', { class: 'cd-spin', 'aria-hidden': 'true' }),
    h('span', { class: 'cd-wait-t' }, '카메라 켜는 중…'),
    h('span', { class: 'cd-wait-slow' }, '조금만 기다려 주세요'));
  const failMsg = h('p', { class: 'cd-fail-msg', role: 'alert' });
  const retryBtn = h('button', { type: 'button', class: 'cd-btn cd-retry', 'data-testid': 'cam-retry', onclick: () => press() },
    icon('camera', 22), h('span', { class: 'cd-lab' }, '다시 열기'));
  const altLab = h('span', { class: 'cd-lab' });
  let altFn = null;
  const altBtn = h('button', { type: 'button', class: 'cd-btn cd-alt', 'data-testid': 'cam-door-alt', hidden: true, onclick: () => { try { altFn?.(); } catch (e) { console.error(e); } } }, altLab);
  const failBox = h('div', { class: 'cd-fail' }, failMsg, h('div', { class: 'cd-fail-row' }, retryBtn, altBtn));

  const el = h('div', { class: 'camdoor', 'data-testid': 'cam-door', 'data-state': 'closed' },
    h('div', { class: 'cd-leaf cd-l', 'aria-hidden': 'true' }),
    h('div', { class: 'cd-leaf cd-r', 'aria-hidden': 'true' }),
    h('div', { class: 'cd-mid' }, openBtn, wait, failBox));

  function set(s) { st = s; el.dataset.state = s; }
  function clearTimers() { clearTimeout(slowT); clearTimeout(endT); slowT = endT = 0; delete el.dataset.slow; }
  // 움직임 없이 바로 — 이번 프레임만 transition 을 끈다(강제 레이아웃 읽기 없이 rAF 두 번 뒤에 되돌림)
  function instant(fn) {
    el.classList.add('cd-instant');
    fn();
    cancelAnimationFrame(instT);
    instT = requestAnimationFrame(() => { instT = requestAnimationFrame(() => { instT = 0; el.classList.remove('cd-instant'); }); });
  }

  // 버튼(또는 호출자의 셔터)이 눌림 — 닫혀 있을 때만 열기 시작
  function press() {
    if (dead || st !== 'closed') return false;
    opening();
    try { onOpen?.(); } catch (e) { console.error('카메라 열기 실패', e); fail('카메라를 열지 못했어요'); }
    return true;
  }

  function opening() {
    if (dead || st === 'opening' || st === 'open') return;
    clearTimers();
    delete el.dataset.fail;
    set('opening');
    slowT = setTimeout(() => { slowT = 0; if (st === 'opening') el.dataset.slow = '1'; }, SLOW_MS);
  }

  // 첫 프레임이 나옴 → 끝까지 열림. 상태는 곧바로 'open'(덮개가 탭을 바로 통과 — 문이 다 열리기 전에도 셔터를 누를 수 있다).
  // opening 일 때만 듣는다 — 닫는 중·닫힌 뒤(화면을 떠남·백그라운드·실패)에 늦게 온 첫 프레임 신호로 문이 다시 열리지 않게.
  // 누르지 않고 바로 열려면 opening() 다음 ready()
  function ready() {
    if (dead || st !== 'opening') return;
    clearTimers();
    delete el.dataset.fail;
    if (reduced()) instant(() => set('open')); else set('open');
  }

  // 카메라 실패 — 문을 닫고 이유 한 줄 + [다시 열기]. opts(선택): { retry = true, alt: { label, onClick } } — 예: [카메라 앱으로 찍기]
  function fail(message, { retry = true, alt = null } = {}) {
    if (dead) return;
    clearTimers();
    failMsg.textContent = message || '카메라를 열지 못했어요';
    retryBtn.hidden = !retry;
    altFn = alt?.onClick || null;
    altLab.textContent = alt?.label || '';
    altBtn.hidden = !alt;
    el.dataset.fail = '1';
    const was = st;
    if (was === 'closed') return;
    if (reduced()) { instant(() => set('closed')); return; }
    set('closing');
    endT = setTimeout(() => { endT = 0; if (st === 'closing') set('closed'); }, CLOSE_MS + 20);
  }

  // 화면을 떠나거나 백그라운드로 갈 때 — 닫힘([카메라 열기]로 돌아간다)
  function close({ animate = true } = {}) {
    if (dead) return;
    clearTimers();
    delete el.dataset.fail;
    if (st === 'closed') return;
    if (!animate || reduced()) { instant(() => set('closed')); return; }
    set('closing');
    endT = setTimeout(() => { endT = 0; if (st === 'closing') set('closed'); }, CLOSE_MS + 20);
  }

  function destroy() {
    if (dead) return;
    dead = true;
    clearTimers();
    cancelAnimationFrame(instT);
    el.remove();
  }

  return { el, state: () => st, opening, ready, fail, close, press, destroy };
}
