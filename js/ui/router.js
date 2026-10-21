// 화면 전환(SPEC §5.7) — 스택, 뒤로 가기 순서(시트 → 화면 onBack → 스택 pop → 홈이면 앱 최소화/웹은 그대로), 웹 history 이어 주기.
// screen = { mount(root, params, nav) → cleanup | void | Promise<cleanup|void>, onBack?(params) → boolean, onResume?(params), dark?, keepOnResume? }
// 규칙(설계 비평 반영):
// - params 는 go() 때 한 번 복사한 객체를 스택이 그대로 쥔다. 화면이 params 에 적어 둔 값(capture 의 params.current 등)은
//   뷰어에 다녀와 다시 mount 돼도 남는다(한 묶음이 둘로 갈리지 않게).
// - 앱 복귀(resume) 때는 화면을 다시 mount 하지 않는다. 화면에 onResume 이 있으면 그것만 부른다.
// - 웹 popstate 로 시트를 닫거나 onBack 이 가로챈 경우에도 보초 한 칸을 다시 넣는다(몇 번 뒤로 가다 PWA 가 그냥 닫히지 않게).
import { h, icon, isSheetOpen, closeTopSheet, liftSnack } from './dom.js';

const screens = new Map();
let stack = [];                                    // [{ name, params }]
let cleanup = null, token = 0, unlift = () => {};
let minimize = null, historyOn = false;
const intercepting = new WeakSet();
const listeners = new Set();
const $ = sel => document.querySelector(sel);

export const nav = { go, replace, back, home, refresh };

export function register(name, screen) { screens.set(name, screen); }
export const has = name => screens.has(name);
export function currentName() { return stack.at(-1)?.name ?? null; }
export function currentParams() { return stack.at(-1)?.params ?? null; }
export function stackNames() { return stack.map(s => s.name); }
// 화면이 바뀔 때마다 fn({ name, params }) — 시험·디버그용
export function onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); }

// 없는 화면(파일이 아직 없거나 오류)은 「준비 중」으로
function placeholder(name) {
  return {
    mount(root, _p, n) {
      root.append(
        h('header', { class: 'bar' },
          h('button', { type: 'button', class: 'icbtn', 'aria-label': '뒤로', onclick: () => n.back() }, icon('back')),
          h('h1', { text: '준비 중' })),
        h('div', { class: 'empty' },
          h('p', { text: '이 화면은 준비 중이에요.' }),
          h('p', { class: 'note', text: `(${name})` }),
          h('button', { type: 'button', class: 'secondary', text: '홈으로', onclick: () => n.home() })));
    },
  };
}

function unmount() {
  token++;                                          // 아직 안 끝난 비동기 mount 의 정리 함수는 늦게 오면 바로 부른다
  unlift(); unlift = () => {};
  const fn = cleanup;
  cleanup = null;
  if (fn) { try { fn(); } catch (e) { console.error('화면 정리 실패', e); } }
}

function failScreen(root, name, e) {
  console.error(`화면을 그리지 못했어요: ${name}`, e);
  root.replaceChildren(
    h('header', { class: 'bar' },
      h('button', { type: 'button', class: 'icbtn', 'aria-label': '뒤로', onclick: () => back() }, icon('back')),
      h('h1', { text: '문제가 생겼어요' })),
    h('div', { class: 'empty' },
      h('p', { text: '화면을 열지 못했어요.' }),
      h('button', { type: 'button', class: 'secondary', text: '홈으로', onclick: () => home() })));
}

function render() {
  unmount();
  const view = $('#view');
  if (!view) return;
  const focused = document.activeElement;           // 입력칸이 든 화면을 치워도 키보드가 남는다 — 시트 안 입력칸은 건드리지 않는다
  if (focused instanceof HTMLElement && view.contains(focused)) focused.blur();
  const top = stack.at(-1);
  const screen = screens.get(top.name) ?? placeholder(top.name);
  const mine = token;
  const root = h('section', { class: ['screen', screen.dark && 'dark'], 'data-screen': top.name });
  view.replaceChildren(root);
  $('#app')?.classList.toggle('dark', !!screen.dark);
  document.documentElement.dataset.screen = top.name;
  const lift = () => { if (mine !== token) return; const d = root.querySelector('.dock'); if (d) { unlift(); unlift = liftSnack(d); } };
  let res;
  try { res = screen.mount(root, top.params, nav); } catch (e) { failScreen(root, top.name, e); return emit(top); }
  if (typeof res === 'function') cleanup = res;
  else if (typeof res?.then === 'function') {
    res.then(fn => {
      if (mine !== token) { if (typeof fn === 'function') try { fn(); } catch { /* 이미 떠난 화면 */ } return; }
      if (typeof fn === 'function') cleanup = fn;
      lift();
    }, e => { if (mine === token) failScreen(root, top.name, e); });
  }
  lift();
  emit(top);
}

function emit(top) {
  for (const fn of listeners) { try { fn({ name: top.name, params: top.params }); } catch (e) { console.error(e); } }
}

export function go(name, params = {}) {
  stack.push({ name, params: { ...params } });
  render();
}

export function replace(name, params = {}) {
  if (stack.length) stack.pop();
  stack.push({ name, params: { ...params } });
  render();
}

export function home() {
  stack = [{ name: 'home', params: {} }];
  render();
}

export function refresh() { if (stack.length) render(); }

// 뒤로: 시트 → 화면 onBack(true 면 끝) → 스택 pop → 홈이면 앱 최소화(APK) / 아무것도 안 함(웹).
// onBack 안에서 동기로 back() 을 다시 불러도 되돌이로 빠지지 않는다. 확인을 띄운 뒤 나가는 화면은 back({ force: true })
export function back(opts) {
  if (opts?.force !== true && isSheetOpen()) { closeTopSheet(); return true; }
  const top = stack.at(-1);
  if (!top) return false;
  const screen = screens.get(top.name);
  if (screen?.onBack && opts?.force !== true && !intercepting.has(top)) {
    intercepting.add(top);
    let handled = false;
    try { handled = screen.onBack(top.params); } catch (e) { console.error('onBack 실패', e); } finally { intercepting.delete(top); }
    if (handled === true || stack.at(-1) !== top) return true;
  }
  if (stack.length > 1) { stack.pop(); render(); return true; }
  if (top.name !== 'home') { home(); return true; }
  if (minimize) { try { Promise.resolve(minimize()).catch(() => {}); } catch { /* 웹 */ } }
  return false;
}

// 앱이 다시 보일 때(app.js 가 부름) — 다시 mount 하지 않고 onResume 만
export function notifyResume() {
  const top = stack.at(-1);
  if (!top) return;
  try { screens.get(top.name)?.onResume?.(top.params); } catch (e) { console.error('onResume 실패', e); }
}

// 시작 설정. useHistory: 웹이면 true(브라우저 뒤로 = back), APK 는 false(native.onBack 이 back 을 부른다). minimize: 홈에서 뒤로일 때(APK)
export function start({ useHistory = true, minimize: mini = null } = {}) {
  minimize = mini;
  if (useHistory && !historyOn && typeof history !== 'undefined') {
    historyOn = true;
    try {
      history.replaceState({ lite: 'base' }, '');
      history.pushState({ lite: 'top' }, '');
    } catch { historyOn = false; return; }
    window.addEventListener('popstate', e => {
      if (e.state?.lite === 'top') return;          // 앞으로 가기로 보초에 돌아온 것
      back();
      try { history.pushState({ lite: 'top' }, ''); } catch { /* 무시 */ }
    });
  }
}

// 시험용: 스택 비우기
export function _reset() { unmount(); stack = []; }
