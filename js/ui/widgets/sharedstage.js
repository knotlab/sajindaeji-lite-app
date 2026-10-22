// 같은 자리(도면·카메라 한 상자) — 촬영 화면 「도면·카메라 배치: 같은 자리(문 열고 찍기)」 옵션(settings().captureStage === 'shared').
// 사용자 지시(2026-10-22): "카메라 화면이랑 도면창이 같은 위치를 공유… 도면 보고 있다가 카메라 버튼 누르면 카메라 문이 열려서 빠르게 찍고".
//
// 층(뷰파인더 상자 크기 하나):
//   .ss-draw (아래, 늘 살아 있음) — drawingEl 을 처음에 한 번만 넣고 옮기지 않는다(iframe·타일 다시 그리기 없음, 확대·이동 그대로)
//   .ss-cam  (위) — cameraEl(기본 videoEl) + 카메라 문(camDoor) + [도면] 칩 + 자동 돌아가기 막대
// 상태(mode):  drawing ─showCamera→ opening ─첫 프레임→ camera ─showDrawing/자동 돌아가기→ closing ─(약 260ms)→ drawing
//   - 식은 카메라: 카메라 층이 120ms 에 떠오르며 문이 반쯤(camDoor opening) + openCamera() → 첫 프레임(requestVideoFrameCallback·playing)에 문 활짝 → camera
//   - 따뜻한 카메라(닫은 뒤 warmMs 안): 문이 곧바로 활짝(첫 프레임 기다리지 않음 — 쉬던 video 에 마지막 그림이 남아 있다). 다음 새 프레임에 camera
//   - 닫기: 카메라 층이 곧바로 손을 놓고(도면을 바로 만질 수 있다) 문 닫기 200ms, 120ms 부터 층이 140ms 에 걸쳐 흐려진다 → drawing → closeCamera({ keepWarm: true })
//     warmMs 가 지나면 closeCamera({ keepWarm: false }) — 손으로 도면을 보는 동안 카메라는 쉬거나(따뜻한 시간) 꺼져 있다
// 체감 속도: 움직임은 transform·opacity(+visibility)만, 글자를 바꾸지 않는다(레이아웃 0). 시간 막대는 Web Animations 로 transform 만.
// prefers-reduced-motion 이면 움직임 없이 즉시(camDoor 도 같은 규칙).
import { h, icon } from '../dom.js';
import { camDoor } from './camdoor.js';

const FADE_IN_MS = 120;          // 카메라 층 떠오르기(sharedstage.css --ss-in 과 같게)
const CLOSE_MS = 260;            // 문 닫기 200ms + 층 흐려지기(120ms 부터 140ms) — sharedstage.css --ss-out·--ss-out-delay 와 같게
const LIVE_MAX_MS = 400;         // 따뜻한 카메라: 새 프레임이 이만큼 안 와도 camera 로(멈춘 video 가 playing 을 안 주는 기기)
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
  autoReturnMs = 4000,
  warmMs = 60000,
  onModeChange,
  errorText = defaultErrorText,  // (err) → 문 위 실패 한 줄
  failAlt = null,                // { label, onClick } — 실패 때 흰 보조 버튼(예: 카메라 앱으로 찍기)
  retryable = err => err?.code !== 'insecure' && err?.code !== 'nocamera',
  drawButton = true,             // 카메라 층 아래 가운데 [도면] 칩
  handleVisibility = true,       // 백그라운드로 가면 곧바로 도면 + 카메라 끔(돌아와도 저절로 켜지 않는다)
  empty = null,                  // { text, label, onClick } — 띄운 도면이 없을 때 도면 층 가운데 한 줄 + 버튼(setEmpty(true) 로 보임)
  timeScale = 1,                 // 시험용(느린 화면 찍기) — 내부 시간에 곱한다. CSS 쪽은 .ss-slowmo 가 맞춘다
} = {}) {
  let md = 'drawing', dead = false, seq = 0;
  let warm = false, warmT = 0, closeT = 0, liveT = 0, autoT = 0, inT = 0;
  let autoMs = Math.max(0, Number(autoReturnMs) || 0);
  let shotSince = false, holds = 0, barAnim = null, rvfcId = 0;
  let liveWaiters = [], awaitingLive = false;
  const slots = new Set();

  // 문: 여기서 만들면 [다시 열기]도 begin() 으로. 받은 문이면 문 주인(촬영 화면)이 열기·첫 프레임 ready()·실패를 맡고, 여기선 문 상태를 지켜본다(아래 MutationObserver)
  const ownDoor = !extDoor;
  const door = extDoor || camDoor({ onOpen: () => begin() });
  const fill = h('i', { class: 'ss-bar-fill' });
  const bar = h('div', { class: 'ss-bar', 'aria-hidden': 'true' }, fill);
  const drawBtn = drawButton
    ? h('button', { type: 'button', class: 'ss-drawbtn', 'data-testid': 'stage-drawing', 'aria-label': '도면 보기', onclick: () => showDrawing() },
      icon('drawing', 22), h('span', {}, '도면'))
    : null;
  const camLayer = h('div', { class: 'ss-cam', 'data-testid': 'stage-cam' }, cameraEl || videoEl, ownDoor ? door.el : null, drawBtn, bar);
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
    camLayer.setAttribute('aria-hidden', camShown ? 'false' : 'true');
    drawLayer.setAttribute('aria-hidden', camShown ? 'true' : 'false');
    try { onModeChange?.(m); } catch (e) { console.error(e); }
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
    const wasWarm = warm;
    setFail(false);
    if (door.state() === 'closed' || door.state() === 'closing') door.opening();
    if (wasWarm) door.ready();                                             // 따뜻하면 첫 프레임을 기다리지 않고 활짝
    awaitingLive = wasWarm;                                                // 따뜻함: 문은 이미 open — 새 프레임(rVFC)을 기다려 camera
    setMode('opening');
    watchLive(wasWarm ? ms(LIVE_MAX_MS) : 0);
    let p;
    try { p = openCamera?.(); } catch (err) { p = Promise.reject(err); }
    Promise.resolve(p).then(() => {
      if (!door.el.dataset.fail) warm = true;                              // 열렸다(늦게 와도) — 이제 닫으면 쉬게 둔다(받은 문은 실패해도 resolve 할 수 있다)
      if (dead || my !== seq || md !== 'opening') return;
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
  // 문 상태를 data-door 로 옮겨 CSS 가 [도면] 칩을 보이게 하고, 문 주인이 바꾼 상태(첫 프레임·실패·다시 열기·백그라운드 닫힘)를 mode 로 따라간다
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

  // 셔터 자리(촬영 화면 .cap-ctrl 가운데 칸) — 셔터·[카메라]·[도면](카메라 실패 때)을 한 칸에 겹쳐 두고 하나만 보인다(72px 같음 → 줄 레이아웃이 안 바뀐다)
  function shutterSlot(shutterEl) {
    const camBtn = h('button', { type: 'button', class: 'ss-cambtn', 'data-testid': 'stage-camera', 'aria-label': '카메라 열기', onclick: () => showCamera() },
      icon('camera', 26), h('span', {}, '카메라'));
    const backBtn = h('button', { type: 'button', class: 'ss-backbtn', 'data-testid': 'stage-drawing-slot', 'aria-label': '도면 보기', onclick: () => showDrawing() },
      icon('drawing', 26), h('span', {}, '도면'));
    const slot = h('div', { class: 'ss-slot', 'data-mode': md }, shutterEl, camBtn, backBtn);
    if (door.el.dataset.fail) slot.dataset.fail = '1';
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
    if (handleVisibility) document.removeEventListener('visibilitychange', onVis);
    mo?.disconnect();
    if (ownDoor) door.destroy();
    slots.clear();
    el.remove();
  }

  return {
    el,
    door,
    mode: () => md,
    isWarm: () => warm,
    showCamera,
    showDrawing,
    noteShot,
    setAutoReturn,
    hold,
    live,
    suspend,
    setEmpty(on) { if (emptyEl) emptyEl.hidden = !on; },               // 띄운 도면이 없으면 true — 도면 층에 안내 한 줄 + [도면 고르기]
    markCold() { warm = false; clearTimeout(warmT); warmT = 0; },     // 카메라가 밖에서 닫혔을 때(camera.onState 'closed'·'error')
    shutterSlot,
    destroy,
  };
}
