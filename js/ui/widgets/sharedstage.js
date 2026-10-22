// 같은 창(도면·카메라 한 상자) — 촬영 화면 「도면·카메라 배치: 같은 창」(settings().captureStage === 'shared', v0.1.6 부터 기본).
// 사용자 지시(2026-10-22): "카메라 화면이랑 도면창이 같은 위치를 공유… 도면 보고 있다가 카메라 버튼 누르면 카메라 문이 열려서 빠르게 찍고",
//   "그냥 같은 창에서 카메라 도면 전환이 가능하게 버튼을 만들어라(준비한 애니메이션이 재생되게)".
//
// 층(뷰파인더 상자 크기 하나):
//   .ss-draw (아래, 늘 살아 있음) — drawingEl 을 처음에 한 번만 넣고 옮기지 않는다(iframe·타일 다시 그리기 없음, 확대·이동 그대로)
//   .ss-cam  (위) — cameraEl(기본 videoEl) + 카메라 문(camDoor) + 자동 돌아가기 막대
// 바꾸기 단추 toggleButton() — [카메라 | 도면] 두 칸, 두 상태에서 같은 자리(촬영 화면은 셔터 위 줄 오른쪽). 지금 보이는 쪽(mode 의 목표)이 눌린 칸.
//   안 고른 칸을 누르면 바꾸고 고른 칸은 아무 일 없음 — 한 번 누름 = 한 번 바꿈. 움직이는 중에 누르면 마지막 누름이 이긴다(되돌리기)
// 상태(mode):  drawing ─showCamera→ opening ─첫 프레임→ camera ─showDrawing/자동 돌아가기→ closing ─(약 260ms)→ drawing
//   - 식은 카메라: 카메라 층이 120ms 에 떠오르며 문이 반쯤(camDoor opening) + openCamera() → 첫 프레임(requestVideoFrameCallback·playing)에 문 활짝 → camera
//   - 따뜻한 카메라(닫은 뒤 warmMs 안): 문 상태는 곧바로 open(셔터가 바로 찍힌다 — 쉬던 video 에 마지막 그림이 남아 있다), 문짝은 층이 떠오른 뒤
//     열린다(data-door-in="warm" — 열리는 움직임이 눈에 보이게, v0.1.6). 다음 새 프레임에 camera
//   - 닫기: 카메라 층이 곧바로 손을 놓고(도면을 바로 만질 수 있다) 문 닫기 200ms, 120ms 부터 층이 140ms 에 걸쳐 흐려진다 → drawing → closeCamera({ keepWarm: true })
//     warmMs 가 지나면 closeCamera({ keepWarm: false }) — 손으로 도면을 보는 동안 카메라는 쉬거나(따뜻한 시간) 꺼져 있다
// 띄운 것이 없을 때(setEmpty(true), empty 부품 없음 — 촬영 화면): 카메라 층이 늘 보이고 닫힌 문 가운데 [카메라 열기](data-empty, v0.1.6 검토 — 도면은 선택)
// 누름 막기(v0.1.6 검토): 도면을 끄는(10px 넘게 움직인) 손가락이 있거나 막 끝낸 150ms 안의 단추 누름만 버린다(한 줄 알림 — 가만히 닿은 엄지는 막지 않음).
//   셔터 자리를 눌러 바뀐 뒤 0.25초 안의 손가락 톡(장갑 튐)은 새로 나타난 셔터로 넘기지 않는다(원치 않는 사진)
// 체감 속도: 움직임은 transform·opacity(+visibility)만, 글자를 바꾸지 않는다(레이아웃 0). 시간 막대는 Web Animations 로 transform 만.
// prefers-reduced-motion 이면 움직임 없이 즉시(camDoor 도 같은 규칙).
import * as dom from '../dom.js';
import { camDoor } from './camdoor.js';

const { h, icon } = dom;
const FADE_IN_MS = 120;          // 카메라 층 떠오르기(sharedstage.css --ss-in 과 같게)
const CLOSE_MS = 260;            // 문 닫기 200ms + 층 흐려지기(120ms 부터 140ms) — sharedstage.css --ss-out·--ss-out-delay 와 같게
const LIVE_MAX_MS = 400;         // 따뜻한 카메라: 새 프레임이 이만큼 안 와도 camera 로(멈춘 video 가 playing 을 안 주는 기기)
const GESTURE_STALE_MS = 5000;   // 도면 위 손가락이 이만큼 아무 소식이 없으면 놓친 pointerup 으로 보고 버린다
const GESTURE_MOVE_PX = 10;      // 이보다 많이 움직인 손가락 = 도면을 끄는(확대하는) 중
const GESTURE_TAIL_MS = 150;     // 끌기·확대를 막 끝낸 뒤(손을 떼며 단추에 닿음)도 누름으로 치지 않는다
const BOUNCE_MS = 250;           // 셔터 자리를 눌러 바뀐 직후 같은 자리 두 번째 톡(장갑 튐)은 새로 나타난 셔터·[카메라]·[도면]으로 넘기지 않는다
const reduced = () => { try { return !!globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches; } catch { return false; } };

// 기본 문구 — camera.js 의 오류는 이미 한국어 message 를 가진다
const defaultErrorText = err => err?.message || '카메라를 열지 못했어요';

export function sharedStage({
  drawingEl,
  videoEl,
  cameraEl = null,               // 카메라 층에 넣을 요소(촬영 화면의 .cap-vf — video·워터마크·비율·플래시가 든 상자). 없으면 videoEl
  door: extDoor = null,          // 이미 있는 카메라 문(촬영 화면이 cameraEl 안에 붙인 camDoor) — 주면 그 문을 지켜보며 쓴다(없으면 여기서 만든다)
  openCamera,
  closeCamera,
  autoReturnMs = 0,              // 마지막 셔터 뒤 도면으로 자동 돌아가기(ms) — 기본 끔(v0.1.6, 촬영 화면은 설정 stageAutoReturn 이 켜면 4000)
  warmMs = 60000,
  onModeChange,
  errorText = defaultErrorText,  // (err) → 문 위 실패 한 줄
  failAlt = null,                // { label, onClick } — 실패 때 흰 보조 버튼(카메라 앱으로 찍기 같은 것)
  retryable = err => err?.code !== 'insecure' && err?.code !== 'nocamera',
  handleVisibility = true,       // 백그라운드로 가면 곧바로 도면 + 카메라 끔(돌아와도 저절로 켜지 않는다)
  empty = null,                  // { text, label, onClick } — 띄운 도면이 없을 때 도면 층 가운데 한 줄 + 버튼(setEmpty(true) 로 보임).
                                 //   없으면(촬영 화면) 띄운 것이 없는 동안 닫힌 카메라 문과 문 가운데 [카메라 열기]를 보인다(data-empty — 도면은 선택, v0.1.6 검토)
  onBlocked = () => { try { dom.toast?.('도면에서 손을 떼고 눌러요'); } catch { /* 없음 */ } },   // 도면을 끄는 중이라 누름을 버렸을 때 한 줄
  drawLabel = '도면',            // 바꾸기 단추의 도면 쪽 칸 글·아이콘(자료를 띄우면 setDrawLabel('자료', 'doc'))
  drawIcon = 'drawing',
  timeScale = 1,                 // 시험용(느린 화면 찍기) — 내부 시간에 곱한다. CSS 쪽은 .ss-slowmo 가 맞춘다
} = {}) {
  let md = 'drawing', dead = false, seq = 0;
  let warm = false, warmT = 0, closeT = 0, liveT = 0, autoT = 0, inT = 0;
  let autoMs = Math.max(0, Number(autoReturnMs) || 0);
  let shotSince = false, holds = 0, barAnim = null, rvfcId = 0;
  let liveWaiters = [], awaitingLive = false;
  let camSide = false;                                                       // 바꾸기 단추가 보이는 쪽(카메라 = opening·camera)
  let isEmpty = false;                                                       // 띄운 도면·자료가 없음(setEmpty)
  let dLabel = drawLabel, dIcon = drawIcon;
  const slots = new Set();
  const toggles = new Set();

  // 문: 여기서 만들면 [다시 열기]도 begin() 으로. 받은 문이면 문 주인(촬영 화면)이 열기·첫 프레임 ready()·실패를 맡고, 여기선 문 상태를 지켜본다(아래 MutationObserver)
  const ownDoor = !extDoor;
  const door = extDoor || camDoor({ onOpen: () => begin() });
  const fill = h('i', { class: 'ss-bar-fill' });
  const bar = h('div', { class: 'ss-bar', 'aria-hidden': 'true' }, fill);
  const camLayer = h('div', { class: 'ss-cam', 'data-testid': 'stage-cam' }, cameraEl || videoEl, ownDoor ? door.el : null, bar);
  const emptyEl = empty
    ? h('div', { class: 'ss-empty', 'data-testid': 'stage-empty', hidden: true },
      h('p', {}, empty.text || '도면을 고르면 여기 보여요'),
      empty.label ? h('button', { type: 'button', class: 'ss-empty-btn', onclick: () => { try { empty.onClick?.(); } catch (e) { console.error(e); } } }, icon('drawing', 22), h('span', {}, empty.label)) : null)
    : null;
  const drawLayer = h('div', { class: 'ss-draw', 'data-testid': 'stage-draw' }, drawingEl, emptyEl);
  const el = h('div', { class: 'sstage', 'data-testid': 'shared-stage', 'data-mode': 'drawing', 'data-door': door.state() }, drawLayer, camLayer);
  camLayer.setAttribute('aria-hidden', 'true');

  const ms = v => Math.round(v * timeScale);
  function setFail(on) {
    for (const s of slots) { if (on) s.dataset.fail = '1'; else delete s.dataset.fail; }
  }
  function setMode(m) {
    if (md === m) return;
    md = m;
    el.dataset.mode = m;
    for (const s of slots) s.dataset.mode = m;
    const camShown = m === 'opening' || m === 'camera';
    if (camShown !== camSide) {                                               // 바꾸기 단추는 목표 쪽을 곧바로(누른 그 순간 — 움직임을 기다리지 않는다)
      camSide = camShown;
      paintAria();
      for (const t of toggles) paintToggle(t);
    }
    try { onModeChange?.(m); } catch (e) { console.error(e); }
  }
  // 띄운 것이 없으면(빈 안내 부품이 없을 때) 카메라 층이 늘 보인다(닫힌 문) — 읽기 프로그램에도 그 층을
  function paintAria() {
    const camVisible = camSide || (isEmpty && !emptyEl);
    camLayer.setAttribute('aria-hidden', camVisible ? 'false' : 'true');
    drawLayer.setAttribute('aria-hidden', camVisible ? 'true' : 'false');
  }
  // 움직임 없이 바로 — 이번 프레임만 transition 을 끈다(강제 레이아웃 읽기 없이 rAF 두 번 뒤에 되돌림)
  function instant(fn) {
    el.classList.add('ss-instant');
    fn();
    cancelAnimationFrame(inT);
    inT = requestAnimationFrame(() => { inT = requestAnimationFrame(() => { inT = 0; el.classList.remove('ss-instant'); }); });
  }

  // ---------- 첫(새) 프레임 ----------
  function stopLiveWatch() {
    clearTimeout(liveT); liveT = 0;
    if (rvfcId && videoEl?.cancelVideoFrameCallback) { try { videoEl.cancelVideoFrameCallback(rvfcId); } catch { /* 없음 */ } }
    rvfcId = 0;
    videoEl?.removeEventListener('playing', onFrame);
    videoEl?.removeEventListener('loadeddata', onFrame);
  }
  function watchLive(maxMs) {
    stopLiveWatch();
    if (!videoEl) return;
    // 새 프레임이 실제로 그려진 순간(rVFC) — 없는 브라우저·rVFC 가 늦는 경우를 위해 playing·loadeddata 도 같이(먼저 오는 쪽)
    if (typeof videoEl.requestVideoFrameCallback === 'function') rvfcId = videoEl.requestVideoFrameCallback(() => { rvfcId = 0; onFrame(); });
    videoEl.addEventListener('playing', onFrame);
    videoEl.addEventListener('loadeddata', onFrame);
    if (maxMs > 0) liveT = setTimeout(() => { liveT = 0; onFrame(); }, maxMs);
  }
  function onFrame() {
    if (dead || md !== 'opening') { stopLiveWatch(); return; }
    if (door.state() === 'opening') {
      if (!ownDoor) return;                                                 // 받은 문은 주인이 첫 프레임에 ready() — 문이 open 이 되면 지켜보기가 이어 받는다
      if (!(videoEl && videoEl.readyState >= 2 && videoEl.videoWidth > 0)) {        // 아직 그림이 없다(식은 카메라) — 다음 프레임을 다시 기다린다
        if (!rvfcId && typeof videoEl?.requestVideoFrameCallback === 'function') rvfcId = videoEl.requestVideoFrameCallback(() => { rvfcId = 0; onFrame(); });
        return;
      }
      door.ready();
    }
    goLive();
  }
  function goLive() {
    awaitingLive = false;
    stopLiveWatch();
    setMode('camera');
    resolveLive(true);
    armAuto();
  }
  function resolveLive(v) { const w = liveWaiters; liveWaiters = []; for (const f of w) f(v); }

  // ---------- 열기 ----------
  // camDoor 의 [카메라 열기]·[다시 열기]·press() 도 여기로 온다(문은 이미 opening)
  function begin() {
    if (dead) return;
    const my = ++seq;
    clearTimeout(warmT); warmT = 0;
    clearTimeout(closeT); closeT = 0;
    const wasWarm = warm, ds0 = door.state();
    setFail(false);
    // 따뜻한 카메라를 닫힌 문에서 열 때만 문짝을 층이 떠오른 뒤에 연다(sharedstage.css) — 닫히는 중에 되돌리면 지금 자리에서 바로 열린다.
    // 띄운 것이 없어 닫힌 문이 이미 보이면(data-empty) 기다리지 않는다
    if (wasWarm && ds0 === 'closed' && !(isEmpty && !emptyEl)) el.dataset.doorIn = 'warm'; else delete el.dataset.doorIn;
    if (ds0 === 'closed' || ds0 === 'closing') door.opening();
    if (wasWarm) door.ready();                                             // 따뜻하면 첫 프레임을 기다리지 않고 활짝(문 상태 — 셔터가 바로 찍힌다)
    awaitingLive = wasWarm;                                                // 따뜻함: 문은 이미 open — 새 프레임(rVFC)을 기다려 camera
    setMode('opening');
    watchLive(wasWarm ? ms(LIVE_MAX_MS) : 0);
    let p;
    try { p = openCamera?.(); } catch (err) { p = Promise.reject(err); }
    Promise.resolve(p).then(() => {
      // 그사이 다시 눌러 닫았으면(seq 가 바뀜) 늦게 열린 카메라는 주인이 이미 닫았다 — 따뜻하다고 보면 다음에 문만 활짝 열리고 영상이 없다(v0.1.6)
      if (dead || my !== seq) return;
      if (!door.el.dataset.fail) warm = true;                              // 열렸다 — 이제 닫으면 쉬게 둔다(받은 문은 실패해도 resolve 할 수 있다)
      if (md !== 'opening') return;
      if (videoEl && videoEl.readyState >= 2 && videoEl.videoWidth > 0 && door.state() === 'opening') onFrame();   // playing 이 먼저 지나갔으면
    }, err => {
      if (dead || my !== seq) return;
      warm = false;
      stopLiveWatch();
      console.warn('카메라를 열지 못했어요', err);
      door.fail(errorText(err), { retry: !!retryable(err), alt: failAlt });
      failMode();
    });
  }

  function showCamera() {
    if (dead) return false;
    if (md === 'opening' || md === 'camera') return false;
    shotSince = false;
    cancelAuto();
    if (reduced()) instant(() => begin()); else begin();
    return true;
  }

  // ---------- 닫기 ----------
  function showDrawing({ animate = true } = {}) {
    if (dead || md === 'drawing' || md === 'closing') return false;
    const my = ++seq;
    cancelAuto();
    stopLiveWatch();
    resolveLive(false);
    setFail(false);
    const quick = !animate || reduced();
    const finish = () => {
      closeT = 0;
      if (dead || my !== seq) return;
      setMode('drawing');
      if (door.state() !== 'closed') door.close({ animate: false });
      rest();
    };
    if (quick) { instant(() => { door.close({ animate: false }); setMode('closing'); finish(); }); return true; }
    door.close();
    setMode('closing');
    closeT = setTimeout(finish, ms(CLOSE_MS));
    return true;
  }
  // 도면이 보이면 카메라를 쉬게(따뜻한 시간) → 지나면 끈다
  function rest() {
    clearTimeout(warmT); warmT = 0;
    const keep = warm && warmMs > 0;
    try { closeCamera?.({ keepWarm: keep }); } catch (e) { console.error(e); }
    if (!keep) { warm = false; return; }
    warmT = setTimeout(() => {
      warmT = 0;
      if (dead || md !== 'drawing') return;
      warm = false;
      try { closeCamera?.({ keepWarm: false }); } catch (e) { console.error(e); }
    }, ms(warmMs));
  }

  // ---------- 자동 돌아가기 ----------
  function cancelAuto() {
    clearTimeout(autoT); autoT = 0;
    if (barAnim) { try { barAnim.cancel(); } catch { /* 없음 */ } barAnim = null; }
    delete el.dataset.auto;
  }
  function armAuto() {
    cancelAuto();
    if (dead || !(autoMs > 0) || !shotSince || holds > 0 || md !== 'camera' || door.state() !== 'open') return;
    const d = ms(autoMs);
    el.dataset.auto = '1';
    if (!reduced() && typeof fill.animate === 'function') {
      try { barAnim = fill.animate([{ transform: 'scaleX(1)' }, { transform: 'scaleX(0)' }], { duration: d, easing: 'linear', fill: 'forwards' }); } catch { barAnim = null; }
    }
    autoT = setTimeout(() => { autoT = 0; if (!dead && md === 'camera' && holds === 0) showDrawing(); }, d);
  }
  // 화면을 만지면 다시 센다(재는 중일 때만)
  const onTouch = () => { if (autoT) armAuto(); };
  document.addEventListener('pointerdown', onTouch, { capture: true, passive: true });

  function noteShot() {
    if (dead) return;
    shotSince = true;
    armAuto();
  }
  function setAutoReturn(v) {
    autoMs = Math.max(0, Number(v) || 0);
    if (autoMs > 0) { if (autoT || (shotSince && md === 'camera')) armAuto(); }
    else cancelAuto();
  }
  // 글 입력 시트·고르기 시트가 떠 있는 동안 자동 돌아가기를 멈춘다(겹쳐 불러도 됨 — 켠 만큼 끈다)
  function hold(on) {
    holds = Math.max(0, holds + (on ? 1 : -1));
    if (holds > 0) cancelAuto(); else armAuto();
  }

  // 지금 찍을 수 있는 새 프레임이 오면 true(닫힘·실패면 false). 따뜻한 카메라를 연 바로 그 순간 셔터를 눌렀을 때 한 프레임 기다리는 데
  function live() {
    if (md === 'camera') return Promise.resolve(door.state() === 'open');
    if (md !== 'opening') return Promise.resolve(false);
    return new Promise(r => liveWaiters.push(r));
  }

  // ---------- 문 지켜보기(받은 문·만든 문 모두) ----------
  // 문 상태를 data-door 로 옮기고(CSS·시험이 본다), 문 주인이 바꾼 상태(첫 프레임·실패·다시 열기·백그라운드 닫힘)를 mode 로 따라간다 — 바꾸기 단추도 setMode 로 함께
  function onDoor() {
    if (dead) return;
    const ds = door.state(), failed = !!door.el.dataset.fail;
    if (el.dataset.door !== ds) el.dataset.door = ds;
    if (md === 'opening') {
      if (failed && ds !== 'opening') failMode();
      else if (ds === 'open' && !awaitingLive) goLive();                   // 받은 문: 주인이 첫 프레임에 ready()
      else if ((ds === 'closed' || ds === 'closing') && !failed) dropToDrawing();
    } else if (md === 'camera') {
      if (ds === 'opening') { setFail(false); awaitingLive = false; setMode('opening'); watchLive(0); }   // [다시 열기]
      else if (failed) setFail(true);
      else if (ds === 'closed' || ds === 'closing') dropToDrawing();       // 주인이 닫음(백그라운드·카메라 끊김)
    }
  }
  function failMode() {
    warm = false; awaitingLive = false;
    stopLiveWatch(); cancelAuto();
    setFail(true);                                                          // 셔터 자리 = [도면](셔터는 [다시 열기]와 같은 일이라 뺀다)
    setMode('camera');                                                      // 카메라 층에 이유 + [다시 열기]
    resolveLive(false);
  }
  // 밖에서 문이 닫힘 — 움직임 없이 곧바로 도면(카메라는 주인이 이미 닫았다)
  function dropToDrawing() {
    seq++;
    cancelAuto(); stopLiveWatch(); resolveLive(false);
    clearTimeout(closeT); closeT = 0;
    clearTimeout(warmT); warmT = 0;
    warm = false; awaitingLive = false;
    setFail(false);
    instant(() => setMode('drawing'));
  }
  const mo = typeof MutationObserver === 'function' ? new MutationObserver(onDoor) : null;
  mo?.observe(door.el, { attributes: true, attributeFilter: ['data-state', 'data-fail'] });

  // 백그라운드 — 곧바로 도면, 카메라 끔. APK 는 native.onPause 에도 이 suspend 를 이어 준다
  function suspend() {
    if (dead) return;
    const was = md;
    seq++;
    cancelAuto(); stopLiveWatch(); resolveLive(false);
    clearTimeout(closeT); closeT = 0;
    clearTimeout(warmT); warmT = 0;
    setFail(false);
    if (was !== 'drawing') instant(() => { door.close({ animate: false }); setMode('drawing'); });
    if (warm || was !== 'drawing') { try { closeCamera?.({ keepWarm: false }); } catch (e) { console.error(e); } }
    warm = false; awaitingLive = false;
  }
  const onVis = () => { if (document.hidden) suspend(); };
  if (handleVisibility) document.addEventListener('visibilitychange', onVis);

  // ---------- 누름(바꾸기 단추·셔터 자리) ----------
  // 도면을 끌거나 확대하는 중(10px 넘게 움직인 손가락이 있음)이거나 막 끝낸 직후(150ms)의 누름은 바꾸기로 치지 않는다(손바닥·다른 손가락이 단추로 새지 않게).
  // 가만히 닿아만 있는 손가락(폰을 쥔 엄지가 도면 가장자리에)은 막지 않는다 — v0.1.6 검토: 그동안 누름이 알림 없이 버려졌다. 버릴 땐 한 줄(onBlocked)
  const gest = new Map();                                                    // pointerId → { x, y, t(마지막 소식), moved } — 도면 층에서 시작한 손가락
  let gestEndAt = -1e9;
  const now = () => performance.now();
  const onGestDown = e => { gest.set(e.pointerId, { x: e.clientX, y: e.clientY, t: now(), moved: false }); };
  const onGestMove = e => {
    const g = gest.get(e.pointerId);
    if (!g) return;
    g.t = now();
    if (!g.moved && Math.hypot(e.clientX - g.x, e.clientY - g.y) > GESTURE_MOVE_PX) g.moved = true;
  };
  const onGestUp = e => {
    const g = gest.get(e.pointerId);
    if (!g) return;
    gest.delete(e.pointerId);
    if (g.moved) gestEndAt = now();
  };
  drawLayer.addEventListener('pointerdown', onGestDown, { capture: true, passive: true });
  drawLayer.addEventListener('pointermove', onGestMove, { capture: true, passive: true });   // 도면 층에서 시작한 손가락만(터치는 그 요소에 잡혀 여기로 온다 — 문서 전체를 듣지 않는다)
  document.addEventListener('pointerup', onGestUp, { capture: true, passive: true });
  document.addEventListener('pointercancel', onGestUp, { capture: true, passive: true });
  function gestureBusy() {
    const t = now();
    for (const [id, g] of gest) {
      if (t - g.t > GESTURE_STALE_MS) gest.delete(id);
      else if (g.moved) return true;
    }
    return t - gestEndAt < GESTURE_TAIL_MS;
  }
  let blockedAt = -1e9;
  function blocked() {
    if (now() - blockedAt < 1500) return;                                    // 한 번 끄는 동안 여러 번 닿아도 한 줄만
    blockedAt = now();
    try { onBlocked?.(); } catch (e) { console.error(e); }
  }
  // 'camera' | 'drawing' 쪽을 보이게 — 이미 그쪽이면 아무 일 없음(한 번 누름 = 한 번 바꿈, 두 번 눌러도 되돌아가지 않는다). 움직이는 중이면 되돌린다(마지막 누름이 이김)
  function request(v) {
    if (dead) return false;
    if (v === 'camera') return camSide ? false : showCamera();
    return camSide ? showDrawing() : false;
  }
  // 단추 누름 → request. 보통은 click 만 듣는다(pointerdown·click 두 번 처리 없음). 누르기 시작할 때나 뗄 때 도면을 끄는 중이면 버린다(한 줄 알림).
  // 다른 손가락이 이미 화면에 닿아 있을 때의 톡(주 포인터가 아님)은 브라우저가 click 을 주지 않는다(Chrome 확인 — 폰을 쥔 엄지가 화면에 닿아 있으면
  //   단추가 먹통이었다) → 그 톡은 pointerup 에서 누름으로 친다. 그 뒤 혹시 오는 click 은 버린다(한 번 누름 = 한 번 바꿈)
  // onChanged: 실제로 바뀌었을 때(셔터 자리의 튐 막기가 쓴다)
  function pressable(btn, value, onChanged = null) {
    let downBusy = false, sec = null, secAt = -1e9;
    const fire = busy => {
      if (busy) { blocked(); return; }
      if (request(value)) { try { onChanged?.(); } catch (err) { console.error(err); } }
    };
    btn.addEventListener('pointerdown', e => {
      downBusy = gestureBusy();
      sec = e.pointerType !== 'mouse' && e.isPrimary === false ? { id: e.pointerId, x: e.clientX, y: e.clientY, t: now() } : null;
      if (!sec) secAt = -1e9;                                               // 주 포인터의 새 누름 — 그 click 은 받는다
    }, { passive: true });
    btn.addEventListener('pointerup', e => {
      const s = sec; sec = null;
      if (!s || s.id !== e.pointerId || now() - s.t > 700 || Math.hypot(e.clientX - s.x, e.clientY - s.y) > 12) return;   // 톡이 아니면(오래 누름·끌기) 그냥 둔다
      secAt = now();
      fire(downBusy || gestureBusy());
    }, { passive: true });
    btn.addEventListener('pointercancel', () => { sec = null; }, { passive: true });
    btn.addEventListener('click', e => {
      if (now() - secAt < 600) return;                                     // 방금 pointerup 으로 처리한 누름
      const busy = (e.detail !== 0 && downBusy) || gestureBusy();          // detail 0 = 키보드(Enter·Space)
      downBusy = false;
      fire(busy);
    });
    return btn;
  }

  // 바꾸기 단추 [카메라 | 도면] — 칸마다 아이콘 위 + 글자 아래(56×48). 고른 칸 = 흰 바탕·검정 글자 + 아이콘 자리에 ✓(색만으로 알리지 않음, 설정 분할 선택과 같은 표시)
  function paintToggle(t) {
    const v = camSide ? 'camera' : 'drawing';
    if (t.el.dataset.on === v) return;
    t.el.dataset.on = v;
    t.cam.setAttribute('aria-pressed', camSide ? 'true' : 'false');
    t.draw.setAttribute('aria-pressed', camSide ? 'false' : 'true');
  }
  function toggleButton() {
    const seg = (value, name, label) => {
      const use = icon(name, 22);
      const b = h('button', { type: 'button', class: 'ss-tg', 'data-value': value, 'aria-pressed': 'false' },
        h('span', { class: 'ss-tg-ic', 'aria-hidden': 'true' }, use, icon('check', 22)), h('span', { class: 'ss-tg-lab' }, label));
      return { b, use, lab: b.lastChild };
    };
    const c = seg('camera', 'camera', '카메라'), d = seg('drawing', dIcon, dLabel);
    const el2 = h('div', { class: 'ss-toggle', role: 'group', 'aria-label': '카메라·도면 바꾸기', 'data-testid': 'stage-toggle' }, pressable(c.b, 'camera'), pressable(d.b, 'drawing'));
    const t = { el: el2, cam: c.b, draw: d.b, dIc: d.use, dLab: d.lab };
    toggles.add(t);
    paintToggle(t);
    return el2;
  }
  // 도면 쪽 칸 글·아이콘 — 띄운 것이 자료(엑셀·문서)면 「자료」. 띄운 것이 바뀔 때만 부른다(바꾸는 중엔 글자를 바꾸지 않는다)
  function setDrawLabel(label = '도면', name = 'drawing') {
    if (label === dLabel && name === dIcon) return;
    dLabel = label; dIcon = name;
    for (const t of toggles) {
      t.dLab.textContent = label;
      t.dIc.firstChild?.setAttribute('href', `#i-${name}`);
    }
  }

  // 셔터 자리(촬영 화면 .cap-ctrl 가운데 칸) — 셔터·[카메라]·[도면](카메라 실패 때)을 한 칸에 겹쳐 두고 하나만 보인다(72px 같음 → 줄 레이아웃이 안 바뀐다)
  // 튐 막기(v0.1.6 검토): 이 자리를 눌러 바뀐 뒤 BOUNCE_MS(0.25초) 안의 손가락 톡은 버린다 — 장갑 튐 같은 두 번째 톡이 같은 자리에 나타난 셔터로 가
  //   원치 않는 사진이 찍혔다. 「[카메라] → 곧바로 셔터」는 0.25초 뒤면 그대로(따뜻한 카메라 문이 활짝 열리는 데 약 0.29초). 마우스·키보드는 튀지 않아 그대로
  function shutterSlot(shutterEl) {
    let changedAt = -1e9, downType = '';
    const changed = () => { changedAt = now(); };
    const camBtn = pressable(h('button', { type: 'button', class: 'ss-cambtn', 'data-testid': 'stage-camera', 'aria-label': '카메라 열기' },
      icon('camera', 26), h('span', {}, '카메라')), 'camera', changed);
    const backBtn = pressable(h('button', { type: 'button', class: 'ss-backbtn', 'data-testid': 'stage-drawing-slot', 'aria-label': '도면 보기' },
      icon('drawing', 26), h('span', {}, '도면')), 'drawing', changed);
    const slot = h('div', { class: 'ss-slot', 'data-mode': md }, shutterEl, camBtn, backBtn);
    slot.addEventListener('pointerdown', e => { downType = e.pointerType || ''; }, { capture: true, passive: true });
    slot.addEventListener('click', e => {
      if (e.detail === 0 || (downType !== 'touch' && downType !== 'pen')) return;
      if (now() - changedAt < ms(BOUNCE_MS)) { e.stopPropagation(); e.preventDefault(); }
    }, true);
    if (door.el.dataset.fail) slot.dataset.fail = '1';
    if (isEmpty && !emptyEl) slot.dataset.empty = '1';
    slots.add(slot);
    return slot;
  }

  function destroy() {
    if (dead) return;
    dead = true;
    seq++;
    cancelAuto(); stopLiveWatch(); resolveLive(false);
    clearTimeout(closeT); clearTimeout(warmT);
    cancelAnimationFrame(inT);
    document.removeEventListener('pointerdown', onTouch, { capture: true });
    document.removeEventListener('pointerup', onGestUp, { capture: true });
    document.removeEventListener('pointercancel', onGestUp, { capture: true });
    if (handleVisibility) document.removeEventListener('visibilitychange', onVis);
    mo?.disconnect();
    if (ownDoor) door.destroy();
    slots.clear();
    for (const t of toggles) t.el.remove();
    toggles.clear();
    gest.clear();
    el.remove();
  }

  return {
    el,
    door,
    mode: () => md,
    side: () => (camSide ? 'camera' : 'drawing'),                          // 바꾸기 단추가 고른 쪽(움직이는 중이면 가는 쪽)
    isWarm: () => warm,
    showCamera,
    showDrawing,
    request,
    noteShot,
    setAutoReturn,
    hold,
    live,
    suspend,
    // 띄운 도면이 없으면 true — 빈 안내 부품이 있으면 도면 층에 한 줄 + 버튼, 없으면(촬영 화면) 닫힌 카메라 문 + [카메라 열기](data-empty)
    setEmpty(on) {
      on = !!on;
      if (emptyEl) { emptyEl.hidden = !on; return; }
      if (on === isEmpty) return;
      isEmpty = on;
      if (on) el.dataset.empty = '1'; else delete el.dataset.empty;
      for (const s of slots) { if (on) s.dataset.empty = '1'; else delete s.dataset.empty; }
      paintAria();
    },
    isEmpty: () => isEmpty,
    markCold() { warm = false; clearTimeout(warmT); warmT = 0; },     // 카메라가 밖에서 닫혔을 때(camera.onState 'closed'·'error')
    shutterSlot,
    toggleButton,
    setDrawLabel,
    destroy,
  };
}
