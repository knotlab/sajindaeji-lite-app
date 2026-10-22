// 아래 탭 막대(v0.1.5 — 사용자 요구 「하단 메뉴를 홈과 내보내기로 이원화」).
// tabBar({ tabs: [{ name, label, icon }], current, onPick(name) }) → { el, set(name), setBadge(name, n), hide(on), destroy() }
// - #app 의 마지막 자식(#view 다음)으로 붙인다 — #app 이 세로 flex 라 화면 맨 아래에 붙고, 화면(.screen)의 .dock 은 그 위에 온다(겹치지 않음).
// - 높이 56px + 아래 안전 영역. 아이콘 + 짧은 글자. 고른 탭은 검정 글자·굵게 + 위쪽 2px 검정 막대(색만으로 나타내지 않는다 — 굵기·막대·aria-current).
//   노랑은 쓰지 않는다(노랑은 화면의 주 행동 하나 — 홈의 [기록 시작]).
// - 누름 표시는 손가락이 닿는 순간(pointerdown 에 .down — :active 는 기기에 따라 늦게 붙는다). 전환은 click(키보드·접근성 같은 길).
// - 겹쳐 뜨는 화면(촬영·묶음 상세·설정 등)에서는 hide(true) — router 의 탭 훅이 부른다.
// - 보이는 동안 <html data-tabbar="on"> 와 --tabbar-h 를 둔다(css/tabbar.css 가 스낵바를 탭 막대 위로 올리고, 화면 .dock 의 아래 안전 영역을 뺀다).
// - 아이콘: 스프라이트(#i-<이름>)가 있으면 그것, 없으면 이 파일의 내장 그림(home) — index.html 에 i-home 이 아직 없어도 뜬다.
import { h, icon as spriteIcon } from '../dom.js';

const SVGNS = 'http://www.w3.org/2000/svg';
// 스프라이트에 없을 때 쓰는 그림(24×24, 선 2px — app.css .ic 와 같은 모양). index.html 에 같은 모양 i-home 을 넣는 것을 권한다
const BUILTIN = {
  home: ['M3.5 11 12 4l8.5 7', 'M5.5 9.5V20h5v-5.5h3V20h5V9.5'],
  share: ['M12 3v12', 'M7 8l5-5 5 5', 'M5 14v6h14v-6'],
};

function tabIcon(name) {
  if (typeof document !== 'undefined' && document.getElementById(`i-${name}`)) return spriteIcon(name, 24);
  const d = BUILTIN[name];
  if (!d) return spriteIcon(name, 24);
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('width', '24'); svg.setAttribute('height', '24');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true'); svg.setAttribute('focusable', 'false');
  for (const p of d) { const e = document.createElementNS(SVGNS, 'path'); e.setAttribute('d', p); svg.append(e); }
  return svg;
}

const badgeText = n => (n > 99 ? '99+' : String(n));

export function tabBar({ tabs = [], current = null, onPick = null } = {}) {
  const btns = new Map();                         // name → { btn, badge, label }
  let cur = null, hidden = false, dead = false;

  const el = h('nav', { class: 'tabbar', 'data-testid': 'tabbar', 'aria-label': '메뉴' });
  for (const t of tabs) {
    const badge = h('span', { class: 'tabbar-badge', 'data-testid': `tab-badge-${t.name}`, hidden: true });
    const btn = h('button', {
      type: 'button', class: 'tabbar-btn', 'data-testid': `tab-${t.name}`, 'data-tab': t.name,
    }, h('span', { class: 'tabbar-ic' }, tabIcon(t.icon || t.name), badge), h('span', { class: 'tabbar-t', text: t.label }));
    btns.set(t.name, { btn, badge, label: t.label });
    el.append(btn);
  }

  // 누름 표시 — 닿는 순간. 떼거나 끌어 나가면 걷는다
  let downBtn = null;
  const clearDown = () => { downBtn?.classList.remove('down'); downBtn = null; };
  const onDown = e => {
    const b = e.target.closest?.('.tabbar-btn');
    if (!b || !el.contains(b)) return;
    clearDown();
    downBtn = b;
    b.classList.add('down');
  };
  const onClick = e => {
    const b = e.target.closest?.('.tabbar-btn');
    clearDown();
    if (!b || !el.contains(b)) return;
    const name = b.dataset.tab;
    set(name);                                    // 고른 표시를 먼저(화면 전환이 조금 걸려도 누른 것이 바로 보이게)
    try { onPick?.(name); } catch (err) { console.error('탭 전환 실패', err); }
  };
  el.addEventListener('pointerdown', onDown, { passive: true });
  el.addEventListener('pointerup', clearDown, { passive: true });
  el.addEventListener('pointercancel', clearDown, { passive: true });
  el.addEventListener('pointerleave', clearDown, { passive: true });
  el.addEventListener('click', onClick);

  function set(name) {
    if (name === cur) return;
    cur = btns.has(name) ? name : null;
    for (const [n, { btn }] of btns) {
      if (n === cur) btn.setAttribute('aria-current', 'page'); else btn.removeAttribute('aria-current');
    }
  }

  function setBadge(name, n) {
    const t = btns.get(name);
    if (!t) return;
    const v = Number(n) || 0;
    t.badge.hidden = v <= 0;
    t.badge.textContent = v > 0 ? badgeText(v) : '';
    // 읽어 주는 이름에 개수를 넣는다(배지 글자는 그림 취급)
    t.badge.setAttribute('aria-hidden', 'true');
    if (v > 0) t.btn.setAttribute('aria-label', `${t.label} ${v}개`); else t.btn.removeAttribute('aria-label');
  }

  function mark() {
    if (typeof document === 'undefined' || dead) return;
    const root = document.documentElement;
    if (hidden) root.dataset.tabbar = 'off'; else root.dataset.tabbar = 'on';
  }

  function hide(on = true) {
    on = !!on;
    if (on === hidden && el.hidden === on) return;
    hidden = on;
    el.hidden = on;
    if (on) clearDown();
    mark();
  }

  function destroy() {
    dead = true;
    el.removeEventListener('pointerdown', onDown);
    el.removeEventListener('pointerup', clearDown);
    el.removeEventListener('pointercancel', clearDown);
    el.removeEventListener('pointerleave', clearDown);
    el.removeEventListener('click', onClick);
    el.remove();
    if (typeof document !== 'undefined') delete document.documentElement.dataset.tabbar;
  }

  set(current);
  mark();
  return { el, set, setBadge, hide, destroy, current: () => cur };
}
