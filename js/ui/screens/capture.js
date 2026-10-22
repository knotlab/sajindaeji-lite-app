// 촬영 화면 `capture` (SPEC §6.4, §10.6 도면 띄우고 촬영) — 담당 G
// 세로 화면 + 가로 사진: 위에 화면 폭 전체의 가로 상자 뷰파인더, 그 아래 GPS 줄·내용 줄·사진 줄, 맨 아래 조작(엄지 영역).
// params: { recordId?(이어 찍기), day?, docId?, current?(이 화면이 만든 묶음 id — 다시 그려져도 같은 묶음), draftLoc?, draftContent?, createdHere? }
// 묶음은 첫 사진(또는 휴대폰 카메라 앱을 띄우기 직전)에 만든다. 위치·내용만 고치면 묶음을 만들지 않고 params 에 초안으로 둔다(review-notes).
import * as dom from '../dom.js';
import * as store from '../../data/store.js';
import * as camera from '../../media/camera.js';
import * as pipeline from '../../media/pipeline.js';
import * as render from '../../media/render.js';
import * as gps from '../../services/gps.js';
import * as native from '../../platform/native.js';
import * as thumbW from '../widgets/thumb.js';
import * as gpslineW from '../widgets/gpsline.js';
import * as config from '../../config.js';
import { watermarkLines, watermarkLayout, drawWatermark, wmOpts, wmFont } from '../../core/watermark.js';
import { dayKey } from '../../core/date.js';

const RATIOS = ['4:3', '16:9', '3:4'];
const RATIO_LABEL = { '4:3': '가로 4:3', '16:9': '가로 16:9', '3:4': '세로 3:4' };
const RATIO_NUM = { '4:3': 4 / 3, '16:9': 16 / 9, '3:4': 3 / 4 };
const STALE = config.STALE_MS || 10 * 60 * 1000;
const SAVE_WAIT_MS = 8000;                                                   // 뒤로·저장하고 다음 전에 incoming 저장을 기다리는 한도

let active = null;                                                           // 지금 붙어 있는 화면(onBack 용)

const imp = p => import(p).catch(err => { console.warn('선택 모듈을 못 불렀어요', p, err); return null; });
const fn = (mod, name) => (mod && typeof mod[name] === 'function' ? mod[name] : null);

function el(tag, attrs, ...kids) {                                           // dom.h + 이벤트는 addEventListener 로(h 의 on 처리 방식과 무관하게)
  const { onclick, hidden, ...rest } = attrs || {};
  const node = dom.h(tag, rest, ...kids);
  if (onclick) node.addEventListener('click', onclick);
  if (hidden) node.hidden = true;
  return node;
}
const ic = name => (typeof dom.icon === 'function' ? dom.icon(name) : document.createTextNode(''));

function aspectOf(ratio, o) {                                               // camera.screenAspect 가 없을 때의 같은 규칙(§5.4)
  const f = fn(camera, 'screenAspect');
  if (f) { const v = f(ratio, o); if (Number.isFinite(v) && v > 0) return v; }
  const r = RATIO_NUM[ratio] || 4 / 3;
  return o === 90 || o === 270 ? 1 / r : r;
}

function camErrorText(err) {
  const code = err?.code;
  if (code === 'denied') return native.isNative?.()
    ? '카메라 권한이 꺼져 있어요. 휴대폰 설정 → 앱 → 현장사진대지 lite → 권한에서 카메라를 켜 주세요.'
    : '카메라 권한이 막혀 있어요. 주소창의 자물쇠를 눌러 카메라를 허용해 주세요.';
  if (code === 'nocamera') return '카메라를 찾지 못했어요. 휴대폰 카메라 앱이나 갤러리로 넣어 주세요.';
  if (code === 'insecure') return 'https 주소에서만 카메라를 쓸 수 있어요.';
  if (code === 'busy') return '다른 앱이 카메라를 쓰고 있어요. 그 앱을 닫고 [다시 시도]를 눌러 주세요.';
  return '카메라를 열지 못했어요. [다시 시도]를 누르거나 카메라 앱으로 찍어 주세요.';
}
const saveErrText = err => (err?.code === 'QUOTA' ? '저장 공간이 모자라요. 사진을 정리해 주세요' : '사진을 저장하지 못했어요');

// 파일 고르기 — dom.pickFiles 가 있으면 그것(입력칸은 body 에 1개, review-notes 2), 없으면 같은 방식으로 직접
function pickFiles({ capture = null, multiple = false } = {}) {
  if (typeof dom.pickFiles === 'function') return dom.pickFiles({ capture, multiple, accept: 'image/*' });
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*'; input.multiple = !!multiple;
    if (capture) input.setAttribute('capture', capture);
    input.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;opacity:0';
    document.body.append(input);
    let done = false;
    const finish = files => { if (done) return; done = true; input.remove(); resolve(files); };
    input.addEventListener('change', () => finish([...(input.files || [])]));
    input.addEventListener('cancel', () => finish([]));
    input.click();
  });
}

function mount(root, params = {}, nav = {}) {
  const continuing = !!params.recordId;                                      // 버튼 종류는 처음 받은 recordId 로만 정한다
  const todayAtMount = dayKey(Date.now());
  const fixedDay = params.day && params.day !== todayAtMount ? params.day : null;   // 과거 날짜만 고정, 오늘이면 묶음을 만드는 순간의 오늘
  const live = id => { const r = id && store.record(id); return r && !r.deletedAt ? r : null; };

  let recId = live(params.recordId)?.id || live(params.current)?.id || null;
  if (!recId) { params.current = null; }
  let createdHere = !continuing && !!params.createdHere && !!recId;
  let loc = recId ? store.record(recId).location : (params.draftLoc ?? safe(() => store.lastLocation(), ''));
  let content = recId ? store.record(recId).content : (params.draftContent ?? '');
  let freshHint = !!params.freshHint;                                        // [저장하고 다음] 직후 "이어받은 위치 · 맞나요?"
  let dead = false, leaving = false, grabbing = false, inflight = 0, creating = null, lastPress = 0;
  let resting = false, restN = 0, typingOn = false;                          // 글 입력 시트가 떠 있는 동안 쉼(아래 「쉬기」)
  let camOpen = false, camFailed = false, camCaps = null, opening = null;
  let orient = 0, ratio = (safe(() => store.settings(), {}).photoRatio) || '4:3';
  let layoutMode = 'cam', frame = null, docId = null, docsMod = null, awake = null;
  const shots = new Map();                                                   // 누른 시각(takenAt) → { settled } — incoming 저장 확인용
  const cleanups = [];
  let hideSnack = null, docTopAt = 0;                                        // [저장하고 다음] 스낵바 닫기 · 도면 작은 창 목표 위치(스낵바 올리기)

  // ---------- DOM ----------
  const backBtn = el('button', { type: 'button', class: 'icbtn cap-back', 'aria-label': '뒤로', onclick: () => leave() }, ic('back'));
  const locText = el('span', { class: 'cap-loc-text' });
  const locSub = el('small', { class: 'cap-loc-sub' });
  const locChip = el('button', { type: 'button', class: 'cap-loc', 'data-testid': 'loc-chip', onclick: editLoc }, ic('map'), locText, locSub);
  const layoutBtn = el('button', { type: 'button', class: 'icbtn cap-layout-btn cap-rot', 'data-testid': 'cap-layout', 'aria-label': '도면·카메라 크게 바꾸기', hidden: true, onclick: () => toggleLayout() }, ic('swap'));
  const top = el('div', { class: 'cap-top' }, backBtn, locChip);              // 배치 바꾸기는 도면 줄 안에(위치 칩이 좁아져 글이 잘리지 않게)

  const docName = el('span', { class: 'cap-doc-name' });
  const docChip = el('div', { class: 'cap-doc-chip', 'data-testid': 'cap-doc-chip', hidden: true },
    ic('doc'), docName,
    el('button', { type: 'button', class: 'cap-doc-act', onclick: () => chooseDoc() }, '바꾸기'),
    layoutBtn,
    el('button', { type: 'button', class: 'cap-doc-x', 'aria-label': '도면 닫기', onclick: () => setDoc(null) }, ic('close')));
  const sugName = el('span', { class: 'cap-sug-name' });
  let sugId = null;
  const sugLab = el('span', { class: 'cap-sug-lab' }, '근처 도면');
  const sugAct = el('button', { type: 'button', class: 'cap-doc-act', onclick: () => (sugId ? setDoc(sugId) : chooseDoc()) }, '띄우기');
  const suggest = el('div', { class: 'cap-suggest', 'data-testid': 'cap-doc-suggest', hidden: true }, sugLab, sugName, sugAct);

  const video = el('video', { class: 'cap-video', autoplay: '', muted: '', playsinline: '' });
  video.muted = true; video.playsInline = true; video.autoplay = true;
  const wmCanvas = el('canvas', { class: 'cap-wm', 'aria-hidden': 'true' });
  const ratioBtn = el('button', { type: 'button', class: 'cap-ratio cap-rot', 'data-testid': 'cap-ratio', onclick: cycleRatio });
  const torchBtn = el('button', { type: 'button', class: 'icbtn cap-torch cap-rot', 'aria-label': '플래시', 'aria-pressed': 'false', hidden: true, onclick: toggleTorch }, ic('flash'));
  const fbText = el('p', { class: 'cap-fb-text' });
  const syscamBtn = el('button', { type: 'button', class: 'cap-fb-main', 'data-testid': 'syscam-btn', onclick: () => shootSystem() }, ic('camera'), '카메라 앱으로 찍기');
  const retryBtn = el('button', { type: 'button', class: 'cap-fb-sub', hidden: true, onclick: () => openCam(true) }, '다시 시도');
  const fbGallery = el('button', { type: 'button', class: 'cap-fb-sub', onclick: () => pickGallery() }, ic('image'), '갤러리에서 고르기');
  const fallback = el('div', { class: 'cap-fallback', 'data-testid': 'cam-fallback', hidden: true }, fbText, syscamBtn, el('div', { class: 'cap-fb-row' }, fbGallery, retryBtn));
  const vf = el('div', { class: 'cap-vf', 'data-testid': 'cap-cam-mini' }, video, wmCanvas, ratioBtn, torchBtn, fallback);
  vf.removeAttribute('data-testid');                                         // cam 배치에선 작은 창이 아니다 — doc 배치일 때만 붙인다
  const docWrap = el('div', { class: 'cap-docwrap', hidden: true });
  const box = el('div', { class: 'cap-box' }, vf);                         // docWrap 은 화면(.cap) 바로 아래 — 자리는 placeDoc 이 잡는다
  const stageWrap = el('div', { class: 'cap-stage' }, box);

  const gl = safe(() => gpslineW.gpsLine({ dark: true, compact: true }), null);
  const gpsRow = el('div', { class: 'cap-gps' }, gl?.el || '');

  const contentText = el('span', { class: 'cap-content-text' });
  const contentRow = el('button', { type: 'button', class: 'cap-content', 'data-testid': 'content-row', onclick: editContent },
    el('span', { class: 'cap-content-lab' }, '내용'), contentText, ic('edit'));

  const strip = el('div', { class: 'cap-strip', 'data-testid': 'strip' });
  const spacer = el('div', { class: 'cap-spacer' });

  const count = el('span', { class: 'cap-count', 'data-testid': 'photo-count' });
  const pend = el('span', { class: 'cap-pending' });
  const galleryBtn = el('button', { type: 'button', class: 'cap-gallery', 'data-testid': 'gallery-btn', onclick: () => pickGallery() }, el('span', { class: 'cap-rot' }, ic('image')), '갤러리');
  const shutter = el('button', { type: 'button', class: 'cap-shutter', 'data-testid': 'shutter', 'aria-label': '찍기', onclick: () => shoot() }, el('i'));
  const saveNext = el('button', { type: 'button', class: 'cap-next', 'data-testid': 'save-next', onclick: () => saveAndNext() }, continuing ? '다 찍었어요' : '저장하고 다음');
  const bot = el('div', { class: 'cap-bot dock' },                        // .dock: router 가 스낵바·토스트를 이 위로 올린다(셔터를 가리지 않게)
    el('div', { class: 'cap-countrow' }, count, pend),
    el('div', { class: 'cap-ctrl' }, galleryBtn, shutter, saveNext));

  const screen = el('div', { class: 'cap', 'data-layout': 'cam', 'data-o': '0' }, top, docChip, suggest, stageWrap, gpsRow, contentRow, strip, spacer, bot, docWrap);
  root.append(screen);

  // ---------- 상태 그리기 ----------
  function paintLoc() {
    const lastShot = Number(safe(() => store.meta('lastShotAt', 0), 0)) || 0;
    const stale = !continuing && lastShot > 0 && Date.now() - lastShot > STALE;
    const t = (loc || '').trim();
    locText.textContent = t || '위치를 적어 주세요';
    locText.classList.toggle('is-empty', !t);
    const warn = stale || freshHint || !t;
    locSub.textContent = stale ? '위치 확인' : freshHint ? '맞나요?' : t ? '바꾸기' : '적기';   // 보조글은 짧게 — 위치 글이 잘리지 않게
    locChip.setAttribute('aria-label', `위치 ${t || '없음'}${freshHint ? ' · 이어받은 위치, 맞나요?' : stale ? ' · 위치 확인' : ''}`);
    locChip.classList.toggle('warn', stale);
    locChip.classList.toggle('hint', !stale && warn);
    locChip.dataset.stale = stale ? '1' : '0';
  }
  function paintContent() {
    const t = (content || '').trim();
    contentText.textContent = t || '눌러서 내용 쓰기';
    contentText.classList.toggle('is-empty', !t);
  }

  const thumbCache = new Map();
  let shownThumbs = 0;
  // 셔터 즉시 칸 — 누르는 순간 사진 줄에 빈 칸(「…」)을 먼저 띄우고, camera.shoot 의 onPreview(약 320px 그림, 워커)가 오면 그림을 채운다.
  // 진짜 칸(같은 takenAt 사진)이 생기거나 저장이 끝나면(실패 포함) 걷는다. 진짜 칸도 pipeline.preview 로 같은 그림을 이어 보인다
  const pendTiles = new Map();                                              // pressAt → { node, url }
  function addPendTile(pressAt) {
    if (dead || pendTiles.has(pressAt)) return;
    const node = el('span', { class: 'cap-th cap-th-pend', 'data-testid': 'strip-pending', 'aria-label': '저장 중' }, el('span', { class: 'cap-th-no' }, '…'));
    pendTiles.set(pressAt, { node, url: null });
    paintStrip();
  }
  function fillPendTile(pressAt, blob) {
    const t = pendTiles.get(pressAt);
    if (dead || !t || t.url || !blob) return;
    try { t.url = URL.createObjectURL(blob); } catch { return; }
    t.node.prepend(el('img', { class: 'thumb cap-th-img', src: t.url, alt: '저장 중', draggable: 'false' }));
  }
  const revokeLater = u => { if (u) setTimeout(() => { try { URL.revokeObjectURL(u); } catch { /* 이미 해제 */ } }, 1000); };
  function dropPendTile(pressAt) {
    const t = pendTiles.get(pressAt);
    if (!t) return;
    pendTiles.delete(pressAt);
    t.node.remove();
    revokeLater(t.url);
    if (!dead) paintStrip();
  }
  cleanups.push(() => { for (const k of [...pendTiles.keys()]) dropPendTile(k); });
  function paintStrip() {
    const rec = live(recId);
    const ps = rec ? safe(() => store.photosOf(rec.id), []) : [];
    count.textContent = `사진 ${ps.length}장`;
    if (pendTiles.size) {
      const have = new Set(ps.map(p => p.takenAt));
      for (const k of [...pendTiles.keys()]) if (have.has(k)) { const t = pendTiles.get(k); pendTiles.delete(k); revokeLater(t.url); }
    }
    const keep = new Set();
    const nodes = ps.map((p, i) => {
      const key = p.id;                                                      // thumb 부품이 처리 완료·워터마크 변경을 스스로 다시 그린다
      keep.add(key);
      let node = thumbCache.get(key);
      if (!node) { node = makeThumb(p); thumbCache.set(key, node); }
      const no = node._no || (node._no = node.querySelector('.cap-th-no'));
      if (no.textContent !== String(i + 1)) no.textContent = String(i + 1);
      return node;
    });
    for (const k of thumbCache.keys()) if (!keep.has(k)) thumbCache.delete(k);
    for (const t of pendTiles.values()) nodes.push(t.node);
    const kids = strip.children;
    let same = kids.length === nodes.length && nodes.length > 0;             // 같은 사진·같은 순서면 줄을 건드리지 않는다(store 알림마다 다시 붙이지 않게)
    for (let i = 0; same && i < nodes.length; i++) if (kids[i] !== nodes[i]) same = false;
    if (same) return;
    const grew = nodes.length > shownThumbs;
    shownThumbs = nodes.length;
    strip.replaceChildren(...(nodes.length ? nodes : [el('span', { class: 'cap-strip-empty' }, '찍은 사진이 여기 보여요')]));
    if (grew) requestAnimationFrame(() => { if (!dead) strip.scrollLeft = strip.scrollWidth; });
  }
  function makeThumb(p) {
    const no = el('span', { class: 'cap-th-no' });
    const open = () => { if (recId) nav.go?.('viewer', { recordId: recId, photoId: p.id }); };
    const img = safe(() => thumbW.thumb(p.id, { className: 'cap-th-img', alt: '찍은 사진' }), null) || el('span', { class: 'cap-th-img' });
    return el('button', { type: 'button', class: 'cap-th', 'data-testid': 'strip-thumb', 'data-id': p.id, 'aria-label': '크게 보기', onclick: open }, img, no);
  }
  function paintPending(n) { pend.textContent = n > 0 ? `· 처리 중 ${n}` : ''; }

  function paintAll() { if (dead) return; paintLoc(); paintContent(); paintStrip(); }

  // ---------- 배치(세로 화면 + 가로 사진) ----------
  let lastBoxKey = '';
  function fit() {
    if (dead) return;
    const ar = aspectOf(ratio, orient);
    screen.style.setProperty('--ar', String(ar));
    const W = stageWrap.clientWidth;
    if (!W) return;
    if (layoutMode === 'cam') {
      const want = Math.round(W / ar);
      if (stageWrap.style.getPropertyValue('--want') !== `${want}px`) stageWrap.style.setProperty('--want', `${want}px`);
      const H = stageWrap.clientHeight || want;
      const bh = Math.min(want, H), bw = Math.min(W, Math.round(bh * ar));
      box.style.width = `${bw}px`; box.style.height = `${Math.round(bw / ar)}px`;
    } else {
      box.style.width = `${W}px`; box.style.height = `${stageWrap.clientHeight}px`;
    }
    const key = `${box.style.width}x${box.style.height}|${orient}|${ratio}|${layoutMode}`;
    if (key !== lastBoxKey) { lastBoxKey = key; requestAnimationFrame(drawWm); }
    placeDoc();
  }
  // 도면 자리 — doc 배치: 무대 전체. cam 배치: 사진 줄과 조작 버튼 사이 남는 자리(뷰파인더를 가리지 않게),
  // 남는 자리가 너무 낮으면(작은 폰) 뷰파인더 오른쪽 아래 작은 창(폭 44%). iframe 은 옮기지 않고 자리만 바꾼다
  const DOCK_MIN = 96;
  function placeDoc() {
    if (!docId || docWrap.hidden) return;
    const sr = screen.getBoundingClientRect();
    if (!sr.width) return;
    let l, t, w, hh, place;
    if (layoutMode === 'doc') {
      const b = stageWrap.getBoundingClientRect();
      l = b.left - sr.left; t = b.top - sr.top; w = b.width; hh = b.height; place = 'stage';
    } else {
      const sp = spacer.getBoundingClientRect();
      if (sp.height >= DOCK_MIN) { l = 16; t = sp.top - sr.top + 4; w = sr.width - 32; hh = sp.height - 8; place = 'dock'; }
      else {
        const b = box.getBoundingClientRect();
        w = Math.round(b.width * 0.44); hh = Math.round(w * 3 / 4);
        l = b.right - sr.left - 8 - w; t = b.bottom - sr.top - 8 - hh; place = 'corner';
      }
    }
    docWrap.dataset.place = place;
    docTopAt = sr.top + t;                                                   // 목표 자리(움직이는 중의 getBoundingClientRect 가 아니라)
    Object.assign(docWrap.style, { left: `${Math.round(l)}px`, top: `${Math.round(t)}px`, width: `${Math.round(w)}px`, height: `${Math.round(hh)}px` });
    liftSnackOverDoc();
  }
  // 스낵바·토스트: 도면 작은 창이 사진 줄 아래(dock)에 있으면 그 위로, 아니면 조작 줄 위로(router 기본) — [저장하고 다음] 때마다 도면을 가리지 않게
  cleanups.push(() => hideSnack?.());                                       // 화면을 떠나면 [되돌리기] 스낵바도 닫는다(떠난 뒤엔 되돌릴 수 없다)
  function liftSnackOverDoc() {
    const snack = document.getElementById('snack');
    if (!snack || dead) return;
    if (docId && !docWrap.hidden && docWrap.dataset.place === 'dock') {
      const top = docTopAt || docWrap.getBoundingClientRect().top;
      snack.style.setProperty('--snack-lift', `${Math.max(0, Math.round(window.innerHeight - top - 8))}px`);
    } else snack.style.setProperty('--snack-lift', `${bot.offsetHeight}px`);
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
  ro?.observe(stageWrap); ro?.observe(screen); ro?.observe(spacer);
  cleanups.push(() => ro?.disconnect());
  // 뷰파인더 크기가 움직임(150ms) 끝에 바뀌어도 워터마크 미리보기를 그 크기로 다시 그린다(늘어난 글자가 남지 않게 — 실제 사진과 같게)
  let wmRaf = 0;
  const wmRo = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { cancelAnimationFrame(wmRaf); wmRaf = requestAnimationFrame(() => { if (!dead) drawWm(); }); }) : null;
  wmRo?.observe(vf);
  cleanups.push(() => { wmRo?.disconnect(); cancelAnimationFrame(wmRaf); });

  function paintRatio() { ratioBtn.textContent = RATIO_LABEL[ratio] || ratio; ratioBtn.dataset.value = ratio; }

  async function cycleRatio() {
    const next = RATIOS[(RATIOS.indexOf(ratio) + 1) % RATIOS.length];
    ratio = next; paintRatio(); fit();
    try { await store.setSettings({ photoRatio: next }); } catch (err) { console.warn('비율 저장 실패', err); }
  }

  // 방향 — camera.onOrientation(바뀔 때만 알림)을 듣는다. 없으면 1초마다 살핀다(예전 300ms 폴링은 촬영 화면을 계속 깨웠다)
  function setOrient(o) {
    o = Number(o) || 0;
    if (o === orient || dead) return;
    orient = o; screen.dataset.o = String(o);
    screen.style.setProperty('--rot', `${o === 270 ? -90 : o}deg`);         // 아이콘·글자를 세계 기준으로 똑바로(camera: 화면 = 사진을 시계 방향 o 만큼 돌린 것)
    fit(); drawWm();
  }
  const readOrient = () => { const f = fn(camera, 'orientation'); return f ? safe(() => f(), 0) : 0; };
  if (fn(camera, 'onOrientation')) {
    const offO = safe(() => camera.onOrientation(setOrient), null);
    if (offO) cleanups.push(offO);
  } else {
    const oTimer = setInterval(() => setOrient(readOrient()), 1000);
    cleanups.push(() => clearInterval(oTimer));
  }

  // ---------- 워터마크 미리보기 띠(사진의 아래쪽에, 같은 layout 함수) ----------
  const mctx = document.createElement('canvas').getContext('2d');
  const measure = (t, px, bold) => { mctx.font = wmFont(px, bold); return mctx.measureText(t).width; };
  // 글·크기·방향이 같으면 다시 그리지 않는다(30초 시계·store 알림·크기 알림이 겹쳐도 한 번). canvas 크기는 바뀔 때만 다시 잡는다
  let wmKeyNow = '', wmStale = false;
  function drawWm() {
    if (dead) return;
    if (resting) { wmStale = true; return; }                                 // 글 입력 시트가 떠 있는 동안은 미루고 닫히면 한 번
    const s = safe(() => store.settings(), {});
    const on = fn(render, 'screenWatermark') ? safe(() => render.screenWatermark(), false) : (s.wmMode !== 'off' && s.wmOnScreen !== false);
    const cw = vf.clientWidth, ch = vf.clientHeight;
    wmCanvas.hidden = !on || !cw || !ch || camFailed;
    if (wmCanvas.hidden) { wmKeyNow = ''; return; }
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const lines = watermarkLines({ location: loc || '', content: content || '' }, { takenAt: Date.now(), takenAtSource: 'camera' }, wmOpts(s));
    const key = `${cw}x${ch}@${dpr}|${orient}|${lines.join('\n')}`;
    if (key === wmKeyNow) return;
    wmKeyNow = key;
    const pw = Math.round(cw * dpr), ph = Math.round(ch * dpr);
    if (wmCanvas.width !== pw) wmCanvas.width = pw;
    if (wmCanvas.height !== ph) wmCanvas.height = ph;
    const ctx = wmCanvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, wmCanvas.width, wmCanvas.height);
    const side = orient === 90 || orient === 270;
    const worldW = side ? ch : cw, worldH = side ? cw : ch;                 // 사진(세계 기준) 크기
    const k = 1600 / Math.max(worldW, worldH);                               // 작업본 크기로 배치를 계산해 축소(WYSIWYG)
    const Wk = worldW * k, Hk = worldH * k;
    if (!lines.length) return;
    const lay = watermarkLayout(Wk, Hk, lines, measure);
    const rot = orient * Math.PI / 180;                                      // 화면 = 사진을 시계 방향 o 만큼 돌린 것(camera.js 약속) → 띠가 사진의 아래쪽에
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate(rot);
    ctx.translate(-worldW / 2, -worldH / 2);
    ctx.scale(1 / k, 1 / k);
    drawWatermark(ctx, Wk, Hk, lay);
  }
  const wmTimer = setInterval(drawWm, 30000);                                // 촬영 시각(분) 갱신(쉬는 동안은 미룸)
  cleanups.push(() => clearInterval(wmTimer));

  // ---------- 쉬기: 글 입력 시트가 떠 있는 동안(2026-10-22 폰 "글이 늦게 쳐짐") ----------
  // 카메라 미리보기(트랙 끔 + 멈춤, 마지막 그림이 남음)·방향 감지·워터마크 미리보기·근처 도면 다시 찾기를 쉰다 — 키보드(IME)와 GPU·메인 스레드를 다투지 않게.
  // 시트가 닫히면 곧바로 다시(트랙을 놓지 않으므로 다시 여는 지연 없음). dom.onTyping 이 있으면 그것도 듣는다(다른 시트·글칸)
  function setRest() {
    const on = !dead && (restN > 0 || typingOn);
    if (on === resting) return;
    resting = on;
    safe(() => camera.pause?.(on));
    if (!on) { if (wmStale) { wmStale = false; drawWm(); } if (sugStale) { sugStale = false; paintSuggest(); } }
  }
  async function resting_(p) {                                               // 시트 약속 p 가 끝날 때까지 쉰다(시트를 연 다음에 불러 포커스·키보드를 늦추지 않는다)
    restN++; setRest();
    try { return await p; } finally { restN = Math.max(0, restN - 1); typingOn = false; setRest(); }   // dom 의 「입력 끝」 여유(0.5초)를 기다리지 않고 바로 깨운다
  }
  if (fn(dom, 'onTyping')) {
    const offT = safe(() => dom.onTyping(on => { typingOn = !!on; setRest(); }), null);
    if (typeof offT === 'function') cleanups.push(offT);
  }
  if (fn(dom, 'isTyping')) safe(() => native.setTypingProbe?.(dom.isTyping));
  cleanups.push(() => { restN = 0; typingOn = false; safe(() => camera.pause?.(false)); resting = false; });

  // ---------- 카메라 ----------
  function showFallback(text, { retry = false } = {}) {
    camFailed = true;
    fallback.hidden = false;
    fbText.textContent = text;
    retryBtn.hidden = !retry;
    video.hidden = true; torchBtn.hidden = true; ratioBtn.hidden = true; wmCanvas.hidden = true;
  }
  function hideFallback() {
    camFailed = false; fallback.hidden = true; video.hidden = false; ratioBtn.hidden = false;
    wmKeyNow = ''; drawWm();
  }

  async function openCam(userRetry = false) {
    if (dead || document.hidden) return;
    const s = safe(() => store.settings(), {});
    if (s.captureMode === 'syscam' && !userRetry) {
      showFallback('휴대폰 카메라 앱으로 찍도록 설정돼 있어요.');
      startGps();
      return;
    }
    if (camOpen || opening) return opening;
    opening = (async () => {
      try {
        camCaps = await camera.open(video);
        if (dead) { safe(() => camera.close()); return; }
        camOpen = true; hideFallback();
        torchBtn.hidden = !camCaps?.torch;
      } catch (err) {
        console.warn('카메라를 열지 못했어요', err);
        camOpen = false;
        if (!dead) showFallback(camErrorText(err), { retry: err?.code !== 'insecure' && err?.code !== 'nocamera' });
      } finally {
        opening = null;
        startGps();                                                          // 권한 요청이 겹치지 않게 카메라 다음에 위치
      }
    })();
    return opening;
  }
  // 백그라운드 전환·트랙 끊김은 camera.js 가 스스로 닫고 다시 연다(review-notes 8) — 여기선 상태만 받아 그린다
  const offCam = fn(camera, 'onState') ? camera.onState((st, err) => {
    if (dead) return;
    if (st === 'open') { camOpen = true; if (camFailed) hideFallback(); }
    else if (st === 'paused' || st === 'closed') camOpen = false;
    else if (st === 'error') { camOpen = false; showFallback(camErrorText(err), { retry: true }); }
  }) : null;
  if (offCam) cleanups.push(offCam);
  function closeCam() { safe(() => camera.close()); camOpen = false; }

  let gpsStop = null;
  function startGps() { if (!gpsStop && !dead) gpsStop = safe(() => gps.start(), null); }

  async function toggleTorch() {
    const on = torchBtn.getAttribute('aria-pressed') !== 'true';
    try { await camera.setTorch(on); torchBtn.setAttribute('aria-pressed', String(on)); torchBtn.classList.toggle('on', on); }
    catch { dom.toast?.('플래시를 켜지 못했어요'); }
  }

  // 두 손가락 확대(지원 시) — cam 배치에서만. doc 배치에선 작은 창 탭 = 배치 바꾸기
  (() => {
    const ptr = new Map(); let pinch = null, zoom = 1, raf = 0, tap = null;
    vf.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptr.size === 1) tap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      if (ptr.size === 2 && camCaps?.zoom) { const [a, b] = [...ptr.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: zoom }; tap = null; }
    });
    vf.addEventListener('pointermove', e => {
      if (!ptr.has(e.pointerId)) return;
      ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 10) tap = null;
      if (pinch && ptr.size >= 2 && layoutMode === 'cam') {
        const [a, b] = [...ptr.values()];
        const zc = camCaps.zoom;
        zoom = Math.min(zc.max, Math.max(zc.min, pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d)));
        if (!raf) raf = requestAnimationFrame(() => { raf = 0; camera.setZoom?.(zoom)?.catch?.(() => {}); });
      }
    });
    const up = e => {
      if (!ptr.has(e.pointerId)) return;
      ptr.delete(e.pointerId);
      if (ptr.size < 2) pinch = null;
      if (e.type === 'pointerup' && tap && e.timeStamp - tap.t < 400 && layoutMode === 'doc') toggleLayout();
      tap = null;
    };
    vf.addEventListener('pointerup', up); vf.addEventListener('pointercancel', up);
  })();

  // ---------- 묶음 ----------
  function ensureRecord() {
    const r = live(recId);
    if (r) return Promise.resolve(r);
    if (!creating) {
      creating = store.createRecord({ day: fixedDay || dayKey(Date.now()), location: (loc || '').trim(), content: (content || '').trim(), now: Date.now() })
        .then(rec => {
          recId = rec.id; params.current = rec.id;
          if (!continuing) { createdHere = true; params.createdHere = true; }
          params.draftLoc = undefined; params.draftContent = undefined;
          paintAll();
          return rec;
        })
        .finally(() => { creating = null; });
    }
    return creating;
  }

  // 누른 사진들이 incoming(디스크)에 들어갔는지 — takenAt 으로 알아본다
  function waitSaved() {
    const pending = () => {
      const ps = recId ? safe(() => store.photosOf(recId), []) : [];
      const have = new Set(ps.map(p => p.takenAt));
      for (const [t, st] of shots) if (st.settled || have.has(t)) shots.delete(t);
      return shots.size > 0 || inflight > 0 || !!creating;
    };
    if (!pending()) return Promise.resolve();
    return new Promise(resolve => {
      const t0 = Date.now();
      const tick = () => { if (!pending() || Date.now() - t0 > SAVE_WAIT_MS) resolve(); else setTimeout(tick, 60); };
      tick();
    });
  }

  // ---------- 동작 ----------
  function flash() {
    vf.classList.remove('flash'); void vf.offsetWidth; vf.classList.add('flash');
    setTimeout(() => vf.classList.remove('flash'), 300);
    try { navigator.vibrate?.(30); } catch { /* 진동 없음 */ }
  }

  // 셔터: 번쩍 + 사진 줄 빈 칸을 누르는 순간에. 카메라는 지금 보이는 프레임을 바로 잡고(인코딩은 워커) onGrab 으로 알린다 —
  // 그때부터 다음 셔터를 받는다(연타가 막히지 않음). 원본이 디스크에 들어가고 처리되는 것은 그 뒤에서(pipeline 줄)
  async function shoot() {
    if (leaving || dead) return;
    if (camFailed || !camOpen) { if (camFailed) return shootSystem(); dom.toast?.('카메라를 여는 중이에요'); return; }
    flash();
    safe(() => native.markBusy?.());                                          // 갤러리 원본·미러 쓰기를 2초 미룬다(브리지가 다음 셔터·글을 막지 않게)
    if (grabbing) return;                                                    // 같은 순간(프레임을 잡는 몇 ms)의 두 번째 탭 — 눌린 표시만
    grabbing = true; inflight++;
    const pressAt = Math.max(Date.now(), lastPress + 1);                     // 사진마다 다른 takenAt(즉시 칸·저장 확인의 열쇠)
    lastPress = pressAt;
    const fix = safe(() => gps.fixForPhoto(pressAt), null);
    const hiRes = !!safe(() => store.settings(), {}).captureHiRes;
    addPendTile(pressAt);
    try {
      const recP = ensureRecord();
      let shot;
      try { shot = await camera.shoot({ ratio, hiRes, onGrab: () => { grabbing = false; }, onPreview: blob => fillPendTile(pressAt, blob) }); }
      catch (e) { dropPendTile(pressAt); throw e; }
      finally { grabbing = false; }
      const rec = await recP;
      if (!shot) { dropPendTile(pressAt); return; }                         // 같은 순간의 두 번째 탭(camera 가 무시)
      const st = { settled: false };
      shots.set(pressAt, st);
      const opts = { source: 'incam', takenAt: pressAt, takenAtSource: 'camera', gps: fix };
      if (shot.turns != null) opts.turns = shot.turns;
      if (shot.aspect != null) opts.aspect = shot.aspect;
      if (shot.preview) opts.preview = shot.preview;                         // 처리하는 동안 썸네일이 셔터 순간 그림을 보인다
      if (shot.prepared) opts.prepared = shot.prepared;                       // 워커가 같이 만든 작업본·썸네일(다시 디코드하지 않음)
      fillPendTile(pressAt, shot.preview);
      pipeline.ingest(rec.id, shot.blob, opts)
        .catch(err => { console.error('사진 처리 실패', err); dom.toast?.(saveErrText(err)); })
        .finally(() => { st.settled = true; dropPendTile(pressAt); });
      freshHint = false; params.freshHint = false;
      store.setMeta('lastShotAt', pressAt)?.catch?.(() => {});
      paintLoc();
    } catch (err) {
      console.error('찍지 못했어요', err);
      dom.toast?.(err?.code === 'QUOTA' ? saveErrText(err) : '사진을 찍지 못했어요. 다시 눌러 주세요');
    } finally {
      inflight = Math.max(0, inflight - 1);
    }
  }

  let sysBusy = false;                                                       // 카메라 앱을 두 번 띄우지 않게(연타하면 첫 사진을 잃는다)
  async function shootSystem() {
    if (leaving || dead || sysBusy) return;
    sysBusy = true; syscamBtn.disabled = true;
    try { await shootSystemOnce(); } finally { sysBusy = false; syscamBtn.disabled = false; }
  }
  async function shootSystemOnce() {
    let rec;
    try { rec = await ensureRecord(); }                                      // 카메라 앱을 띄우기 전에 묶음부터 저장(§4.5)
    catch (err) { dom.toast?.(saveErrText(err)); return; }
    const pressAt = Date.now();
    const fix = safe(() => gps.fixForPhoto(pressAt), null);
    try {
      if (native.isNative?.()) {
        const p = await pipeline.shootSystem(rec.id, { gps: fix });
        if (p) { store.setMeta('lastShotAt', Date.now())?.catch?.(() => {}); freshHint = false; }
      } else {
        const files = await pickFiles({ capture: 'environment' });
        if (!files.length) return;
        const r = await pipeline.ingestFiles(rec.id, files, { source: 'syscam' });
        if (r?.failed) dom.toast?.(`${r.failed}장은 넣지 못했어요`);
        store.setMeta('lastShotAt', Date.now())?.catch?.(() => {});
        freshHint = false;
      }
    } catch (err) {
      if (err?.code === 'CANCEL' || err?.code === 'BUSY') return;
      console.error('카메라 앱 촬영 실패', err);
      dom.toast?.(err?.code === 'PERMISSION_DENIED' ? '카메라 권한을 허용해 주세요. 휴대폰 설정 → 앱 → 권한' : saveErrText(err));
    } finally { paintAll(); }
  }

  async function pickGallery() {
    if (leaving || dead) return;
    const files = await pickFiles({ multiple: true });
    if (!files.length || dead) return;
    try {
      const rec = await ensureRecord();
      dom.toast?.(`${files.length}장 넣는 중이에요`);
      const r = await pipeline.ingestFiles(rec.id, files, { source: 'gallery' });
      const ok = r?.ok ?? files.length, failed = r?.failed ?? 0;
      dom.toast?.(failed ? `${ok}장 넣고 ${failed}장은 못 넣었어요` : `${ok}장 넣었어요`);
    } catch (err) {
      console.error('갤러리 사진 넣기 실패', err);
      dom.toast?.(saveErrText(err));
    }
  }

  async function editLoc() {
    const v = await resting_(dom.textSheet({ title: '위치', value: loc || '', placeholder: '예: 101동 5층 복도', multiline: false, select: 'lastNumber' }));
    if (v == null || dead) return;
    const text = String(v).trim();
    loc = text; freshHint = false; params.freshHint = false;
    paintLoc(); drawWm();                                                    // 확인을 누르면 바로 보인다 — 저장(아래)은 뒤에서
    try {
      if (live(recId)) await store.updateRecord(recId, { location: text }, Date.now());
      else params.draftLoc = text;
      if (!continuing) await store.setLastLocation(text, Date.now());       // 이어 찍기(옛 묶음)에서는 이어받기 값을 바꾸지 않는다
      if (!continuing) await store.setMeta('lastShotAt', Date.now());       // 위치를 확인했으니 10분 강조를 끈다
    } catch (err) { console.error('위치 저장 실패', err); dom.toast?.('위치를 저장하지 못했어요'); }
    if (!dead) paintLoc();
  }

  async function editContent() {
    const v = await resting_(dom.textSheet({ title: '내용', value: content || '', placeholder: '예: 배관 보온 작업 완료', multiline: true }));
    if (v == null || dead) return;
    const text = String(v).trim();
    content = text;
    paintContent(); drawWm();                                                // 확인을 누르면 바로 보인다 — 저장은 뒤에서
    try {
      if (live(recId)) await store.updateRecord(recId, { content: text }, Date.now());
      else params.draftContent = text;
    } catch (err) { console.error('내용 저장 실패', err); dom.toast?.('내용을 저장하지 못했어요'); }
  }

  async function saveAndNext() {
    if (leaving || dead) return;
    await waitSaved();
    const rec = live(recId);
    const n = rec ? safe(() => store.photosOf(rec.id).length, 0) : 0;
    if (continuing) { leave(); return; }
    if (!rec || n === 0) { dom.toast?.('사진을 한 장 이상 찍어 주세요'); return; }
    const prev = rec.id;
    recId = null; createdHere = false;
    params.current = null; params.createdHere = false; params.draftLoc = undefined; params.draftContent = undefined;
    loc = safe(() => store.lastLocation(), '') || rec.location || '';
    content = '';
    freshHint = true; params.freshHint = true;
    thumbCache.clear();
    paintAll(); drawWm();
    const undo = () => {                                                     // 잘못 눌렀으면 직전 묶음으로 돌아가 이어 찍기
      if (dead || live(recId)) return;
      const r = live(prev);
      if (!r) return;
      recId = prev; params.current = prev; createdHere = true; params.createdHere = true;
      loc = r.location; content = r.content; freshHint = false; params.freshHint = false;
      paintAll(); drawWm();
    };
    liftSnackOverDoc();
    if (typeof dom.snackbar === 'function') hideSnack = dom.snackbar('저장했어요. 다음 묶음', { actionLabel: '되돌리기', onAction: undo });
    else dom.toast?.('저장했어요. 다음 묶음');
  }

  async function leave() {
    if (leaving || dead) return;
    leaving = true;
    try {
      await waitSaved();
      const rec = live(recId);
      // 정말 빈 묶음일 때만 지운다 — 저장이 늦어(느린 폰) 아직 사진 메타가 안 들어왔을 수 있으면 그대로 둔다(빈 묶음이 남는 편이 사진을 잃는 것보다 낫다)
      const settled = inflight === 0 && !creating && !sysBusy && shots.size === 0 && safe(() => pipeline.pending(), 0) === 0;
      const empty = rec && createdHere && settled && (rec.photoIds?.length || 0) === 0 && safe(() => store.photosOf(rec.id).length, 0) === 0;
      const draft = !rec && String(params.draftContent || '').trim();
      if ((empty && (rec.content || '').trim()) || draft) {
        const ok = await dom.confirmModal({ title: '사진 없는 묶음이에요', text: '나가면 쓴 내용이 지워져요.', okLabel: '지우고 나가기', cancelLabel: '계속 찍기', danger: true });
        if (!ok) { leaving = false; return; }
      }
      if (empty) await store.purgeRecord(rec.id).catch(err => console.warn('빈 묶음 정리 실패', err));
    } catch (err) { console.error(err); }
    if (dead) return;
    nav.back ? nav.back() : history.back();
  }

  // ---------- 도면 띄우고 촬영(§10.6) ----------
  function setLayout(mode) {
    layoutMode = docId ? mode : 'cam';
    screen.dataset.layout = layoutMode;
    if (layoutMode === 'doc') { vf.setAttribute('data-testid', 'cap-cam-mini'); docWrap.removeAttribute('data-testid'); }
    else { vf.removeAttribute('data-testid'); if (docId) docWrap.setAttribute('data-testid', 'cap-doc-mini'); else docWrap.removeAttribute('data-testid'); }
    frame?.setInteractive?.(layoutMode === 'doc');
    stageWrap.style.removeProperty('--want');
    lastBoxKey = '';
    fit();
    requestAnimationFrame(fit);
  }
  function toggleLayout() {
    if (!docId) return;
    const m = layoutMode === 'cam' ? 'doc' : 'cam';
    setLayout(m);
    store.setMeta('captureLayout', m)?.catch?.(() => {});
  }

  function docOf(id) { const d = id && safe(() => docsMod?.doc?.(id), null); return d && !d.deletedAt ? d : null; }

  async function setDoc(id) {
    if (dead) return;
    if (!id) {
      docId = null; frame?.close?.(); docWrap.hidden = true; docChip.hidden = true; layoutBtn.hidden = true;
      store.setMeta('captureDoc', null)?.catch?.(() => {});
      setLayout('cam'); paintSuggest();
      return;
    }
    const d = docOf(id);
    if (!d) { dom.toast?.('자료를 찾을 수 없어요'); return; }
    if (!frame) {
      const mod = await imp('../widgets/docframe.js');
      if (!fn(mod, 'docFrame') || dead) { dom.toast?.('도면을 띄우지 못했어요'); return; }
      frame = mod.docFrame({ onState: () => {}, hint: false });                 // 안내 띠는 자료함·자료 보기에서만(작은 창을 가리지 않게)
      docWrap.append(frame.el);                                              // iframe 은 여기 한 번만 붙이고 옮기지 않는다(배치는 CSS 로만)
      frame.onTap?.(() => { if (layoutMode === 'cam') toggleLayout(); });
    }
    docId = d.id;
    docWrap.hidden = false; docChip.hidden = false; layoutBtn.hidden = false; suggest.hidden = true;
    docName.textContent = d.name;
    store.setMeta('captureDoc', d.id)?.catch?.(() => {});
    setLayout(layoutMode);
    try { await frame.open(d.id); docsMod?.markOpened?.(d.id, Date.now())?.catch?.(() => {}); }
    catch (err) { console.warn('도면 열기 실패', err); dom.toast?.('도면을 열지 못했어요'); }
  }

  function chooseDoc() {
    if (!docsMod) return;
    const input = el('input', { type: 'text', enterkeyhint: 'search', class: 'input cap-docs-q', placeholder: '이름·태그로 찾기', autocomplete: 'off', spellcheck: 'false' });
    const list = el('div', { class: 'cap-docs-list' });
    let closeSheet = () => {};
    const paint = () => {
      const q = input.value.trim();
      let items;
      if (q) items = safe(() => docsMod.searchDocs(q), []).map(d => ({ d, sub: d.ext?.toUpperCase() || '' }));
      else {
        const seen = new Set(), out = [];
        const pos = safe(() => gps.snapshot().pos, null);
        const push = (d, sub) => { if (d && !d.deletedAt && !seen.has(d.id)) { seen.add(d.id); out.push({ d, sub }); } };
        if (pos) for (const x of safe(() => docsMod.nearby(pos, { radius: 200 }), [])) push(x.doc, `지금 위치 근처 · ${Math.round(x.dist)}m`);
        const all = safe(() => docsMod.docs(), []);
        for (const d of all) if (d.pinned) push(d, '고정');
        for (const d of all) push(d, d.ext?.toUpperCase() || '');
        items = out;
      }
      list.replaceChildren(...(items.length ? items.slice(0, 40).map(({ d, sub }) =>
        el('button', { type: 'button', class: `cap-docs-row${d.id === docId ? ' on' : ''}`, onclick: () => { closeSheet(); setDoc(d.id); } },
          ic('doc'), el('span', { class: 'cap-docs-name' }, d.name), el('small', {}, sub)))
        : [el('p', { class: 'note' }, q ? '찾는 자료가 없어요' : '자료함에 올린 자료가 없어요')]));
    };
    let qRaf = 0;
    input.addEventListener('input', () => { if (!qRaf) qRaf = requestAnimationFrame(() => { qRaf = 0; paint(); }); });   // 한 그림에 한 번
    paint();
    let restDone = false;
    const unrest = () => { if (restDone) return; restDone = true; restN = Math.max(0, restN - 1); typingOn = false; setRest(); };
    closeSheet = dom.openSheet(close => el('div', { class: 'cap-docs-sheet' },
      el('h2', { class: 'sheet-title' }, '띄울 자료'), input, list,
      el('button', { type: 'button', class: 'secondary', onclick: () => close() }, '닫기')), { onClose: unrest }) || closeSheet;
    restN++; setRest();
  }

  let sugT = 0, sugStale = false;
  function paintSuggest() {
    if (dead) return;
    if (resting) { sugStale = true; return; }
    if (docId || !docsMod) { suggest.hidden = true; return; }
    const pos = safe(() => gps.snapshot().pos, null);
    const near = pos ? safe(() => docsMod.nearby(pos, { radius: 200 }), []) : [];
    const first = near[0]?.doc;
    sugId = first?.id || null;
    // 근처 자료가 없어도 자료함에 자료가 있으면 「도면 띄우기 [고르기]」로(위치를 연결하지 않은 도면도 촬영 중에 띄울 수 있게)
    const any = !first && safe(() => docsMod.docs().some(d => !d.deletedAt), false);
    suggest.hidden = !first && !any;
    sugLab.textContent = first ? '근처 도면' : '도면 띄우기';
    sugName.textContent = first ? first.name : '';
    sugAct.textContent = first ? '띄우기' : '고르기';
    if (suggest.hidden !== lastSugHidden) { lastSugHidden = suggest.hidden; fit(); }
  }
  let lastSugHidden = true;

  async function initDocs() {
    const [dm, aw] = await Promise.all([imp('../../data/docs.js'), imp('../../platform/awake.js')]);
    if (dead) return;
    awake = aw;
    safe(() => awake?.keepAwake?.(true));
    if (!fn(dm, 'docs')) return;
    try { dm.docs(); } catch { try { await dm.initDocs?.({ now: Date.now() }); } catch (err) { console.warn('자료함을 못 열었어요', err); return; } }
    if (dead) return;
    docsMod = dm;
    const want = params.docId || safe(() => store.meta('captureDoc', null), null);
    const saved = safe(() => store.meta('captureLayout', 'cam'), 'cam');
    layoutMode = saved === 'doc' ? 'doc' : 'cam';
    if (want && docOf(want)) await setDoc(want);
    else { layoutMode = 'cam'; paintSuggest(); }
    const offD = fn(dm, 'onDocs') ? dm.onDocs(() => { if (docId && !docOf(docId)) setDoc(null); else paintSuggest(); }) : null;
    if (offD) cleanups.push(offD);
  }

  // ---------- 구독·수명 ----------
  // store 알림 — 이 묶음·설정·lastShotAt 이 바뀐 때만 그 부분만(사진 처리 중에는 알림이 잦다: 저장·처리 끝·갤러리 원본마다)
  const offStore = safe(() => store.on(ch => {
    if (dead) return;
    let strip = false, text = false;
    if (ch?.settings) {
      const s = safe(() => store.settings(), {});
      if (s.photoRatio && s.photoRatio !== ratio) { ratio = s.photoRatio; paintRatio(); fit(); }
      drawWm();
    }
    if (recId && ch?.records?.has?.(recId)) {
      const r = store.record(recId);
      if (!r || r.deletedAt) { recId = null; params.current = null; createdHere = false; }
      else { loc = r.location; content = r.content; }
      drawWm(); strip = true; text = true;
    }
    if (!strip && recId && ch?.photos?.size) { for (const pid of ch.photos) if (store.photo(pid)?.recordId === recId) { strip = true; break; } }
    if (ch?.meta?.has?.('lastShotAt')) text = true;
    if (text) { paintLoc(); paintContent(); }
    if (strip) paintStrip();
  }), null);
  if (offStore) cleanups.push(offStore);
  const offPend = fn(pipeline, 'onPending') ? safe(() => pipeline.onPending(paintPending), null) : null;
  if (offPend) cleanups.push(offPend);
  paintPending(safe(() => pipeline.pending?.() || 0, 0));
  const offGps = safe(() => gps.on(() => { clearTimeout(sugT); sugT = setTimeout(paintSuggest, 400); }), null);
  if (offGps) cleanups.push(offGps);

  // 시작할 때 화면이 가려져 있었으면(카메라를 못 엶) 보이게 될 때 한 번 연다
  const onVis = () => { if (!document.hidden && !camOpen && !camFailed && !dead) openCam(); };
  document.addEventListener('visibilitychange', onVis);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVis));

  paintRatio(); paintAll();
  setOrient(readOrient());                                                   // 지금 방향(아래 선언이 다 끝난 뒤에)
  requestAnimationFrame(fit);
  openCam();
  initDocs();

  const ctl = { get leaving() { return leaving; }, leave };
  active = ctl;

  return () => {
    dead = true;
    if (active === ctl) active = null;
    closeCam();
    gpsStop?.(); gpsStop = null;
    gl?.destroy?.();
    clearTimeout(sugT);
    frame?.destroy?.();
    safe(() => awake?.keepAwake?.(false));
    for (const f of cleanups) safe(f);
  };
}

function safe(f, fallback) { try { const v = f(); return v === undefined ? fallback : v; } catch (err) { console.warn(err); return fallback; } }

export default {
  dark: true,
  mount,
  onBack() {                                                                 // 뒤로 = [뒤로] 버튼과 같은 정리(저장 기다림·빈 묶음 정리)
    if (!active || active.leaving) return false;
    active.leave();
    return true;
  },
};
