// DOM 도우미(SPEC §5.7) — h()·아이콘·시트/대화상자(한 번에 하나, 줄 세움)·스낵바·토스트·버튼 잠금·파일 고르기.
// 원본 현장사진대지 ui/dom.js 의 검증된 세부를 옮겼다: 시트 줄 세우기(앞 시트 리스너가 새던 공시체 결함), 줄 사이 간격(연타가 다음 질문에 답하지 않게),
// spellcheck 같은 열거형 속성은 문자열로, 한글 조합 중 Enter 무시, 자동완성 끄기.
// 사용자 글은 textContent 로만 넣는다 — innerHTML 금지(자유 입력 글이 많아 XSS 위험).
const SVGNS = 'http://www.w3.org/2000/svg';
const $ = sel => document.querySelector(sel);

// ---------- h() ----------
function append(el, list) {
  for (const c of list) {
    if (c == null || typeof c === 'boolean') continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

// spellcheck: 'false' 를 프로퍼티로 넣으면 문자열이 참으로 읽혀 켜진다 — 속성으로만 넣는다. aria-* 의 false 도 값이다(빠지면 상태가 안 읽힌다)
const ATTR_ONLY = new Set(['spellcheck', 'draggable', 'translate', 'autocapitalize', 'autocomplete', 'enterkeyhint', 'inputmode']);

// attrs: class(문자열|배열), text, style(객체, --변수 포함), on:{click,...} 또는 onclick(함수), data-*·aria-*, 그 밖은 속성/프로퍼티.
// null 은 건너뛰고 false 는(열거형·aria 말고는) 건너뛴다. html·innerHTML 은 금지(던진다)
export function h(tag, attrs, ...children) {
  const el = tag === 'svg' || tag === 'use' || tag === 'path' ? document.createElementNS(SVGNS, tag) : document.createElement(tag);
  const { value, on, ...rest } = attrs ?? {};
  for (const [k, v] of Object.entries(rest)) {
    if (k === 'html' || k === 'innerHTML' || k === 'outerHTML') throw new Error('h(): html 속성은 쓸 수 없어요(textContent 만)');
    if (v == null) continue;
    if (ATTR_ONLY.has(k) || k.startsWith('aria-')) { el.setAttribute(k, String(v)); continue; }
    if (v === false) continue;
    if (k === 'class') { const c = Array.isArray(v) ? v.filter(Boolean).join(' ') : v; if (c) el.setAttribute('class', c); }
    else if (k === 'text') el.textContent = v;
    else if (k === 'style' && typeof v === 'object') {
      for (const [p, x] of Object.entries(v)) {
        if (x == null || x === false) continue;
        if (p.startsWith('--') || p.includes('-')) el.style.setProperty(p, x); else el.style[p] = x;
      }
    } else if (/^on[a-z]/.test(k) && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k.startsWith('data-') || k.includes('-') || el instanceof SVGElement) el.setAttribute(k, v === true ? '' : v);
    else if (k in el) {
      try { el[k] = v; } catch { el.setAttribute(k, v === true ? '' : v); }      // list·form 처럼 읽기 전용인 프로퍼티
    } else el.setAttribute(k, v === true ? '' : v);
  }
  if (on) for (const [ev, fn] of Object.entries(on)) if (typeof fn === 'function') el.addEventListener(ev, fn);
  append(el, children);
  if (value != null) el.value = value;                                            // select 는 option 을 붙인 뒤에야 값이 먹는다
  return el;
}

// 목록을 통째로 다시 만들지 않고 바뀐 줄만(체감 속도) — items 순서대로 그리되, key 가 같고 sig(그 줄에 보이는 값)가 같으면 전의 노드를 그대로 쓴다.
// 노드는 Element 여야 한다. 순서가 같은 줄은 건드리지 않는다(새 줄 끼우기·없어진 줄 빼기만)
export function syncList(parent, items, { key, sig, make }) {
  const old = parent._sync || new Map();
  const next = new Map();
  const nodes = [];
  for (const it of items) {
    const k = key(it), s = sig(it);
    let e = old.get(k);
    if (!e || e.sig !== s) e = { sig: s, node: make(it) };
    next.set(k, e);
    nodes.push(e.node);
  }
  parent._sync = next;
  for (let i = 0; i < nodes.length; i++) { const at = parent.children[i]; if (at !== nodes[i]) parent.insertBefore(nodes[i], at || null); }
  while (parent.children.length > nodes.length) parent.lastElementChild.remove();
}

// <svg class="ic"><use href="#i-name"/></svg> — 스프라이트는 index.html 에 있다
export function icon(name, size = 24) {
  const svg = document.createElementNS(SVGNS, 'svg');
  svg.setAttribute('class', 'ic');
  svg.setAttribute('width', size);
  svg.setAttribute('height', size);
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  const use = document.createElementNS(SVGNS, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
}

// ---------- 진행 중 작업 세기(시험이 「손이 끝난 때」를 기다릴 수 있게) ----------
let inflight = 0;
export const busy = () => inflight;
export async function act(fn) {
  inflight++;
  try { return await fn(); } finally { inflight--; }
}

// 실행 중에는 같은 버튼을 다시 눌러도 무시하고, 끝나면(성공·실패 모두) 푼다
export function lockButton(btn, asyncFn) {
  let running = false;
  btn.addEventListener('click', e => {
    if (running) return;
    running = true;
    const was = btn.disabled;
    btn.disabled = true;
    btn.setAttribute('aria-busy', 'true');
    act(async () => {
      try { await asyncFn(e); } finally {
        running = false;
        btn.disabled = was;
        btn.removeAttribute('aria-busy');
      }
    }).catch(err => { console.error('버튼 작업 실패', err); toast('문제가 생겼어요. 다시 해 보세요'); });
  });
  return btn;
}

// ---------- 시트·대화상자 레이어(#layer 안, 한 번에 하나) ----------
// 열려 있는 동안 또 열면 줄을 세웠다가 앞의 것이 닫히고 QUEUE_GAP 뒤에 띄운다.
// def.end(reason) 은 한 번만 불린다: 'close'(확인·항목 선택) | 'cancel'(취소·배경·뒤로).
const QUEUE_GAP = 250;
// 확인창(modal)은 줄을 서지 않고 지금 시트 위에 겹쳐 뜬다(휴지통 시트의 [영구 삭제] 등). 아래 시트는 under 에 두었다가 확인창이 닫히면 다시 맨 위가 된다
const waiting = [];
const under = [];
let cur = null, gap = null;

// 시트·대화상자가 떠 있는 동안 뒤 화면(#view)의 높이를 그대로 묶어 둔다 — 키보드가 올라와 창이 줄어도 뒤 화면을 다시 배치하지 않게
// (촬영 화면은 뷰파인더·워터마크 미리보기를 크기마다 다시 그려, 키보드가 뜨는 동안 글 입력이 늦어졌다). 다 닫히면 푼다
let frozen = false;
function freezeView(on) {
  const v = $('#view');
  if (!v || on === frozen) return;
  frozen = on;
  if (on) {
    const hh = v.getBoundingClientRect().height;
    if (hh > 0) { v.style.height = `${Math.round(hh)}px`; v.style.flex = 'none'; }
    v.dataset.frozen = '1';
  } else { v.style.removeProperty('height'); v.style.removeProperty('flex'); delete v.dataset.frozen; }
}
export const viewFrozen = () => frozen;

function show(def) {
  if (cur && !gap && def.kind === 'modal') under.push(cur);
  else if (cur || gap) { waiting.push(def); return; }
  const host = $('#layer');
  if (!host) throw new Error('#layer 가 없어요');
  freezeView(true);
  const back = h('div', { class: ['layer-back', `${def.kind}-back`] });
  const box = h('div', { class: def.kind, 'data-testid': 'sheet', role: 'dialog', 'aria-modal': 'true' });
  if (def.label) box.setAttribute('aria-label', def.label);
  back.append(box);
  let done = false;
  function finish(reason) {
    if (done) return false;
    done = true;
    back.remove();
    if (cur === handle) cur = under.pop() || null;
    else { const i = under.indexOf(handle); if (i >= 0) under.splice(i, 1); }
    def.handle = null;
    pump();
    if (!cur && !gap) freezeView(false);
    try { def.end?.(reason); } catch (e) { console.error('시트 닫기 처리 실패', e); }
    return true;
  }
  const handle = { close: () => finish('close'), cancel: () => finish('cancel') };
  back.addEventListener('click', e => { if (e.target === back && !def.modal) handle.cancel(); });
  cur = handle;
  def.handle = handle;
  host.append(back);                                                             // 붙인 뒤에 채운다(포커스·크기 재기가 되게)
  try { def.build(box, handle); } catch (e) { finish('cancel'); throw e; }
}

function pump() {
  if (cur || gap) return;
  const def = waiting.shift();
  if (!def) return;
  gap = def;
  def.timer = setTimeout(() => { gap = null; def.timer = 0; show(def); }, QUEUE_GAP);
}

// 줄에 섰거나 간격을 기다리거나 떠 있는 레이어를 취소로 닫는다
function dismiss(def) {
  const i = waiting.indexOf(def);
  if (i >= 0) { waiting.splice(i, 1); def.end?.('cancel'); return true; }
  if (gap === def) { clearTimeout(def.timer); def.timer = 0; gap = null; pump(); if (!cur && !gap) freezeView(false); def.end?.('cancel'); return true; }
  if (def.handle) return def.handle.cancel();
  return false;
}

export const isSheetOpen = () => !!(cur || gap);

// 맨 위 시트를 취소로 닫는다(뒤로 가기가 가장 먼저 부른다). 간격 중이면 다음 것을 취소한다(화면이 물러나지 않게)
export function closeTopSheet() {
  if (cur) return cur.cancel();
  if (gap) return dismiss(gap);
  return false;
}

// 사용자 정의 시트. build(close) → Node. close() 를 부르면 닫힌다. onClose(reason) 은 어떻게 닫혀도 한 번.
// modal:true 면 배경을 눌러도 안 닫힌다(뒤로 가기는 닫힘)
export function openSheet(build, { modal = false, onClose, label } = {}) {
  const def = {
    kind: 'sheet', modal, label, end: onClose,
    build(box, layer) {
      box.append(h('div', { class: 'grab', 'aria-hidden': 'true' }));
      const node = build(() => layer.close());
      if (node) box.append(node);
    },
  };
  show(def);
  return () => dismiss(def) || false;
}

// ---- 글 입력 시트 ----
// 한 줄: Enter = 확인(한글 조합 중이면 무시 — isComposing 과 compositionstart/end 둘 다 본다, 원본 session.js).
// 여러 줄: Enter = 줄바꿈. 열리자마자 포커스(탭 핸들러 안에서 동기로 — 지연 focus 는 안드로이드에서 키보드가 안 뜬다), 커서는 끝.
// 배경을 눌러도 안 닫힘, [취소]/[확인]만. 여러 줄 초안은 sessionStorage 에 남긴다(쓰다가 앱이 내려가도). 자동완성·자동고침 끔(기존 선택지처럼 보이지 않게)
const DRAFT = 'lite:draft:';
function draftGet(key) { try { return JSON.parse(sessionStorage.getItem(DRAFT + key) || 'null'); } catch { return null; } }
function draftSet(key, v) { try { if (v == null) sessionStorage.removeItem(DRAFT + key); else sessionStorage.setItem(DRAFT + key, JSON.stringify(v)); } catch { /* 저장 못 해도 그만 */ } }

export function textSheet({ title, value = '', placeholder = '', multiline = false, okLabel = '확인', hint = null, draftKey = null } = {}) {
  return new Promise(resolve => {
    let result = null;
    const key = multiline ? (draftKey || title || 'text') : null;
    openSheet(close => {
      let composing = false;
      let start = value ?? '';
      const d = key && draftGet(key);
      if (d && d.base === start && typeof d.text === 'string') start = d.text;   // 같은 글에서 쓰다 만 초안이면 이어 쓴다
      const common = {
        class: 'sheet-field', placeholder, 'data-testid': 'sheet-input', 'aria-label': title || '입력',
        autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false', value: start,
      };
      const field = multiline ? h('textarea', { ...common, rows: 4 }) : h('input', { ...common, type: 'text', enterkeyhint: 'done' });
      const ok = () => { result = field.value; close(); };
      field.addEventListener('compositionstart', () => { composing = true; });
      field.addEventListener('compositionend', () => { composing = false; });
      if (!multiline) field.addEventListener('keydown', e => { if (e.key === 'Enter' && !composing && !e.isComposing && e.keyCode !== 229) { e.preventDefault(); ok(); } });
      if (key) field.addEventListener('input', () => draftSet(key, { base: value ?? '', text: field.value }));
      // 한 줄 칸: 오른쪽 지우기(×) — 이어받은 위치를 통째로 바꿀 때 백스페이스를 여러 번 누르지 않게
      const clear = multiline ? null : h('button', { type: 'button', class: 'sheet-clear', 'aria-label': '지우기', 'data-testid': 'sheet-clear', onpointerdown: e => e.preventDefault(),   // 눌러도 칸이 포커스를 잃지 않게(키보드 유지)
        onclick: () => { field.value = ''; field.dispatchEvent(new Event('input', { bubbles: true })); field.focus({ preventScroll: true }); } }, icon('close', 20));
      const body = h('div', { class: 'sheet-body' },
        title ? h('h2', { class: 'sheet-title', text: title }) : null,
        clear ? h('div', { class: 'sheet-fieldwrap' }, field, clear) : field,
        hint ? (hint instanceof Node ? hint : h('p', { class: 'note', text: hint })) : null,
        h('div', { class: 'sheet-actions' },
          h('button', { type: 'button', class: 'secondary', 'data-testid': 'sheet-cancel', text: '취소', onclick: () => { result = null; closeTopSheet(); } }),
          h('button', { type: 'button', class: 'primary', 'data-testid': 'sheet-ok', text: okLabel, onclick: ok })));
      // 상자에 붙은 직후 포커스(같은 탭 작업 안 — 키보드가 뜬다)
      focusEnd(field);
      return body;
    }, {
      modal: true, label: title,
      onClose: reason => {
        if (key) draftSet(key, null);
        resolve(reason === 'close' ? result : null);
      },
    });
  });
}

// 노드가 문서에 붙은 뒤 바로(같은 작업 안에서) 포커스하고 커서를 끝에 둔다. 아직 안 붙었으면 다음 틱에 한 번 더
function focusEnd(field) {
  const go = () => {
    field.focus({ preventScroll: true });
    try { const n = field.value.length; field.setSelectionRange(n, n); } catch { /* 선택 범위 없는 칸 */ }
  };
  queueMicrotask(go);                                                            // build 가 돌려준 노드를 box 에 붙인 직후 — 같은 작업(사용자 탭) 안이다
}

// ---- 확인 대화상자 ----
export function confirmModal({ title, text, okLabel = '확인', cancelLabel = '취소', danger = false } = {}) {
  return new Promise(resolve => {
    let answer = false;
    show({
      kind: 'modal', modal: true, label: title,
      end: () => resolve(answer),
      build(box, layer) {
        if (title) box.append(h('h2', { class: 'modal-title', text: title }));
        if (text) box.append(text instanceof Node ? text : h('p', { class: 'modal-text', text }));
        box.append(h('div', { class: 'modal-btns' },
          h('button', { type: 'button', class: 'secondary', 'data-testid': 'sheet-cancel', text: cancelLabel, onclick: () => layer.cancel() }),
          h('button', { type: 'button', class: danger ? 'danger' : 'primary', 'data-testid': 'sheet-ok', text: okLabel, onclick: () => { answer = true; layer.close(); } })));
        box.tabIndex = -1;                                                       // 버튼에 포커스를 주면 첫 답이 미리 골라진 것처럼 보인다 — 상자에 준다
        box.focus({ preventScroll: true });
      },
    });
  });
}

// ---- 고르기 시트 ---- options: [{ value, label, sub }]. 고른 것은 검정 2px + 체크(색만으로 나타내지 않는다). 배경·뒤로 = null
export function choose({ title, options = [], value } = {}) {
  return new Promise(resolve => {
    let picked = null;
    openSheet(close => {
      const list = h('div', { class: 'choose-list', role: 'listbox' });
      for (const o of options) {
        const sel = o.value === value;
        list.append(h('button', {
          type: 'button', class: ['choose-item', sel && 'sel'], role: 'option', 'aria-selected': sel ? 'true' : 'false',
          'data-value': ['string', 'number'].includes(typeof o.value) ? String(o.value) : null,
          onclick: () => { picked = o.value; close(); },
        }, h('span', { class: 'choose-text' }, h('b', { text: o.label }), o.sub ? h('small', { text: o.sub }) : null), sel ? icon('check') : null));
      }
      return h('div', { class: 'sheet-body' },
        title ? h('h2', { class: 'sheet-title', text: title }) : null, list,
        h('button', { type: 'button', class: 'textbtn', 'data-testid': 'sheet-cancel', text: '취소', onclick: () => closeTopSheet() }));
    }, { label: title, onClose: reason => resolve(reason === 'close' ? picked : null) });
  });
}

// ---------- 스낵바·토스트(#snack, 각각 한 번에 하나 — 토스트가 「되돌리기」 기회를 지우지 않게 따로) ----------
let snackT = 0, toastT = 0;

export function snackbar(text, { actionLabel, onAction, ms = 5000 } = {}) {
  const host = $('#snack');
  if (!host) return () => {};
  clearTimeout(snackT);
  host.querySelector('.snackbar')?.remove();
  const bar = h('div', { class: 'snackbar', 'data-testid': 'snackbar', role: 'status' }, h('span', { class: 'snack-msg', text }));
  const gone = () => { clearTimeout(snackT); bar.remove(); };
  if (actionLabel) bar.append(h('button', {
    type: 'button', class: 'snack-btn', 'data-testid': 'snackbar-action', text: actionLabel,
    onclick: () => { gone(); if (onAction) act(async () => onAction()).catch(e => { console.error('스낵바 동작 실패', e); toast('하지 못했어요'); }); },
  }));
  host.append(bar);
  snackT = setTimeout(gone, ms);
  return gone;
}

export function toast(text, ms = 2200) {
  const host = $('#snack');
  if (!host) return;
  clearTimeout(toastT);
  host.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', 'data-testid': 'toast', role: 'status', text });
  host.append(t);
  toastT = setTimeout(() => t.remove(), ms);
}

// 화면 아래 붙박이(.dock)가 있으면 스낵바·토스트를 그 위로 올린다. 정리 함수를 돌려준다(router 가 자동으로 부른다)
export function liftSnack(bottomEl) {
  const snack = $('#snack');
  if (!snack || !bottomEl) return () => {};
  // 크기는 ResizeObserver 가 배치가 끝난 뒤 준다 — 화면을 붙이자마자 offsetHeight 를 읽으면 새 화면 전체를 한 번 더 강제로 배치한다(전환이 늦어짐)
  let last = '';
  const set = hh => { const v = `${Math.round(hh)}px`; if (v !== last) { last = v; snack.style.setProperty('--snack-lift', v); } };
  const ro = typeof ResizeObserver === 'function'
    ? new ResizeObserver(en => { const b = en[0]?.borderBoxSize?.[0]; set(b ? b.blockSize : bottomEl.offsetHeight); })
    : null;
  if (ro) ro.observe(bottomEl); else set(bottomEl.offsetHeight);
  return () => { ro?.disconnect(); snack.style.removeProperty('--snack-lift'); };
}

// ---------- 파일 고르기(입력칸은 body 에 하나 — 카메라 앱·갤러리를 다녀오는 사이 화면이 다시 그려져도 결과를 받게, 원본 settings.js 방식) ----------
// 반드시 탭 핸들러 안에서 부른다. 취소면 [](cancel 이벤트가 없는 브라우저는 다음 pickFiles 때 앞의 것을 [] 로 끝낸다)
let picker = null, pickDone = null;
export function pickFiles({ accept = 'image/*', capture = null, multiple = false } = {}) {
  pickDone?.([]);
  if (!picker) {
    picker = h('input', { type: 'file', id: 'lite-picker', 'aria-hidden': 'true', tabIndex: -1, style: { position: 'fixed', left: '-9999px', width: '1px', height: '1px', opacity: '0' } });
    picker.addEventListener('change', () => { const files = [...(picker.files || [])]; const f = pickDone; pickDone = null; f?.(files); });
    picker.addEventListener('cancel', () => { const f = pickDone; pickDone = null; f?.([]); });
    document.body.append(picker);
  }
  picker.value = '';
  picker.accept = accept || '';
  picker.multiple = !!multiple;
  if (capture) picker.setAttribute('capture', capture === true ? 'environment' : capture); else picker.removeAttribute('capture');
  return new Promise(resolve => {
    pickDone = files => resolve(files);
    picker.click();
  });
}

// ---------- 키보드 높이(visualViewport) — 시트가 키보드 위에 오게. interactive-widget=resizes-content 가 먹는 곳에서는 0 ----------
if (typeof window !== 'undefined' && window.visualViewport) {
  const vv = window.visualViewport;
  let lastKb = -1;
  const upd = () => {
    const kb = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
    if (kb === lastKb) return;                                                   // 루트 변수를 고치면 문서 전체 스타일을 다시 계산한다 — 바뀔 때만
    lastKb = kb;
    document.documentElement.style.setProperty('--kb', `${kb}px`);
  };
  vv.addEventListener('resize', upd);
  vv.addEventListener('scroll', upd);
}
