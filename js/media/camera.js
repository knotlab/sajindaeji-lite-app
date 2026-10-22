// 앱 안 카메라(getUserMedia) — 세로 화면에서 가로 사진, 방향 보정, 셔터 직렬화, 백그라운드 전환(설계서 §5.4, 설계 비평 6·7·8)
//
// 좌표·각도 약속
//  - 기기 방향 o ∈ {0,90,180,270}: screen.orientation.angle 과 같은 뜻(90 = 폰 위쪽이 왼쪽으로 가게 반시계로 눕힘).
//  - 중력: devicemotion accelerationIncludingGravity 의 (x, y) = 화면 기준 '위' 벡터(똑바로 세우면 y=+g). o = atan2(x, y).
//    그 이벤트가 없을 때만 β/γ 로 같은 벡터를 계산한다(β/γ 에 임계값을 직접 걸면 γ 가 ±90° 에서 접히고 β 가 180° 뛰어 판정이 튄다).
//  - √(x²+y²) < 0.35g(바닥·천장을 내려/올려 찍기)이면 직전 방향을 그대로 둔다. 45°±10° 히스테리시스.
//  - 사진 보정 각(상대 방향) = (o − screen.orientation.angle) mod 360 — 세로 고정이 안 먹어 화면이 돌았으면 프레임이 이미 돌아 나오므로 그만큼 뺀다.
//  - 결과 회전은 시계 방향 quarterTurns(image.transformCanvas 규칙): turns = (4 − rel/90) mod 4.
//
// 세로 화면에서 가로 사진(사용자 지시): 세계 기준 목표 비 r(4:3→4/3, 16:9→16/9, 3:4→3/4)
//  - screenAspect(ratio, rel) = rel 이 90/270 이면 1/r, 아니면 r — 뷰파인더 상자 = 화면 좌표에서 잘라 낼 상자.
//  - 프레임 가운데 가장 큰 screenAspect 상자를 잘라 돌리면 세계 기준 r 사진. 뷰파인더도 그 상자 + object-fit:cover 라 보이는 그대로 찍힌다.
//
// 찍기(2026-10-22 폰 "사진을 찍거나 글을 쓸 때 딜레이" — 기본을 「즉시 프레임 잡기」로 바꿈):
//  - 기본: 미리보기 스트림(4:3 약 1920×1440 ≈ 280만 화소, 안 되면 카메라가 주는 가까운 크기)에서 지금 보이는 프레임을 바로 잡는다
//    (VideoFrame(video) — 안 되면 createImageBitmap(video) → 워커가 돌리고 잘라 인코딩, image.frameJpegs). 셔터 지연 0·미리보기 멈춤 없음·보이는 그대로(WYSIWYG).
//    안드로이드 takePhoto 는 정지 사진 모드 전환·초점 때문에 장당 1~3초 걸리고 그동안 미리보기가 멈추며 다음 셔터도 막혔다.
//  - shoot({ hiRes: true })(설정 captureHiRes)일 때만 takePhoto(긴 변 약 3264px, 느림). takePhoto 가 도는 중에 또 누르면 그 장은 프레임 잡기로(버리지 않는다).
//  - 셔터 연타: 프레임을 잡는 순간(몇 ms)만 막는다 — 같은 순간의 두 번째 탭만 null. 인코딩은 워커 줄에서 이어진다.
//    onGrab() 은 프레임을 잡은 즉시, onPreview(blob) 는 약 320px 미리보기가 나오는 즉시(워커) 불린다.
//  - 결과 blob 은 이미 돌리고 자른 최종 사진(turns=0, aspect=null) = incoming·갤러리 원본. 작업본·썸네일도 같은 워커 호출에서 이어 만들어
//    shotInfo(blob).prepared 로 넘긴다(pipeline 이 다시 디코드하지 않는다).
//  - takePhoto 결과는 다시 인코딩하지 않고 {blob 그대로, turns, aspect} 를 넘겨 회전·자르기는 pipeline 이 작업본을 만들 때 한다(설계 비평 7).
//  - pause(true): 글 입력 시트가 떠 있는 동안 미리보기(트랙 끔 + video 멈춤 — 마지막 그림이 남는다)와 방향 감지를 쉰다(키보드와 GPU·메인 스레드를 다투지 않게).
//  - 찍힌 사진의 크기는 JPEG 머리로 읽는다(통째로 디코드하지 않는다).
//
// 잠깐 붙잡기(속도 감사 #5 ④): 촬영 화면에서 크게 보기·지도로 잠깐 갔다 올 때 release({ keepMs }) — 트랙을 끄고(enabled=false, 프레임 안 받음)
//   video 에서 떼지만 기기는 놓지 않는다. keepMs(기본 30초) 안에 open(새 video) 하면 같은 stream 을 그 video 에 붙여 곧바로(getUserMedia 다시 열기 0).
//   그 사이 백그라운드로 가거나(pause)·트랙이 끝나면 바로 닫는다(배터리·다른 앱 카메라). warm(): [기록 시작]을 누르는 순간 — 사진 워커를 미리 띄우고 붙잡은 카메라 시간을 늘린다.
import { transformCanvas, canvasToBlob, cropRect, dims, jpegInfoOf, snapshot, frameJpegs, frameWorkerReady, makeWorkAndThumbFast } from './image.js';
import * as native from '../platform/native.js';

// ---------- 순수 계산 ----------
export const RATIOS = { '4:3': 4 / 3, '16:9': 16 / 9, '3:4': 3 / 4 };
export const targetRatio = ratio => RATIOS[ratio] || RATIOS['4:3'];
const norm = a => ((Math.round(a) % 360) + 360) % 360;

export function screenAspect(ratio, orientation) {
  const r = targetRatio(ratio), o = norm(orientation || 0);
  return o === 90 || o === 270 ? 1 / r : r;
}
// 화면 좌표 프레임(fw×fh)에서 잘라 낼 상자(가운데 기준)
export const frameCrop = (fw, fh, ratio, orientation) => cropRect(fw, fh, screenAspect(ratio, orientation));
// 상대 방향(도) → 시계 방향 quarter turns
export const turnsFor = rel => (4 - norm(rel) / 90) % 4;
// 기기 방향 − 화면 각
export const relOrientation = (device, screenAngle = 0) => norm((device || 0) - (screenAngle || 0));

// β/γ(도) → 화면 기준 위 벡터(단위 g). R = Rz(α)Rx(β)Ry(γ) 의 Rᵀ·(0,0,1)
export function gravityFromEuler(beta, gamma) {
  const b = (beta || 0) * Math.PI / 180, g = (gamma || 0) * Math.PI / 180;
  return { x: -Math.cos(b) * Math.sin(g), y: Math.sin(b), z: Math.cos(b) * Math.cos(g) };
}
// 직전 방향 prev 와 위 벡터(x,y; 단위는 g 기준 G) → 새 방향. 약하면(내려 찍기) prev 유지, 45°±10° 히스테리시스
export function nextOrientation(prev, x, y, { G = 9.81, minMag = 0.35, hyst = 10 } = {}) {
  prev = norm(prev || 0);
  if (!Number.isFinite(x) || !Number.isFinite(y) || Math.hypot(x, y) < minMag * G) return prev;
  const a = norm((Math.atan2(x, y) * 180) / Math.PI);
  let d = Math.abs(a - prev); if (d > 180) d = 360 - d;
  if (d <= 45 + hyst) return prev;
  return norm(Math.round(a / 90) * 90);
}

// ---------- 방향 추적 ----------
let devO = 0, haveMotion = false, sm = null, listening = false, resting = false;
const orientFns = new Set();
const screenAngle = () => (globalThis.screen?.orientation?.angle ?? (typeof globalThis.orientation === 'number' ? globalThis.orientation : 0)) || 0;
function setDev(o) {
  if (o === devO) return;
  devO = o;
  const rel = orientation();
  for (const fn of orientFns) { try { fn(rel); } catch (e) { console.error(e); } }
}
function onMotion(e) {
  const a = e.accelerationIncludingGravity;
  if (!a || a.x == null || a.y == null) return;
  haveMotion = true;
  sm = sm ? { x: sm.x * 0.7 + a.x * 0.3, y: sm.y * 0.7 + a.y * 0.3 } : { x: a.x, y: a.y };   // 손떨림 거르기(저역 통과)
  setDev(nextOrientation(devO, sm.x, sm.y));
}
function onEuler(e) {
  if (haveMotion || e.beta == null || e.gamma == null) return;
  const v = gravityFromEuler(e.beta, e.gamma);
  setDev(nextOrientation(devO, v.x, v.y, { G: 1 }));
}
function onScreen() { const rel = orientation(); for (const fn of orientFns) { try { fn(rel); } catch (e) { console.error(e); } } }
function listen(on) {
  if (on && resting) return;                                               // 쉬는 동안(글 입력 중)은 켜지 않는다 — pause(false) 가 다시 켠다
  if (on === listening || typeof window === 'undefined') return;
  listening = on;
  const f = on ? 'addEventListener' : 'removeEventListener';
  window[f]('devicemotion', onMotion);
  window[f]('deviceorientation', onEuler);
  globalThis.screen?.orientation?.[f]?.('change', onScreen);
}
// 사진 보정에 쓰는 상대 방향(기기 방향 − 화면 각). 세로 고정이면 기기 방향 그대로. 이벤트가 하나도 없으면 0
export function orientation() { listen(true); return relOrientation(devO, screenAngle()); }
export function deviceOrientation() { listen(true); return devO; }
// 방향이 바뀌면 fn(rel) — 뷰파인더 상자 모양 전환용
export function onOrientation(fn) { listen(true); orientFns.add(fn); return () => orientFns.delete(fn); }
// 시험용: 중력 벡터를 직접 넣는다
export function _feedGravity(x, y) { haveMotion = true; sm = null; setDev(nextOrientation(devO, x, y)); }
export function _resetOrientation(o = 0) { devO = norm(o); sm = null; haveMotion = false; }

// ---------- 카메라 열기·닫기 ----------
// 열기 차례(turn): open()·attach()·close() 마다 +1 — 앞선 열기의 늦게 끝난 getUserMedia 가 그 뒤의 닫기·새 열기를 덮지 않게.
//   그만둔 열기는 code 'cancelled' 로 끝나고 'error' 를 알리지 않는다(실패가 아니다). v0.1.6 검토: 식은 카메라(폰 0.6~0.8초)를 여는 중
//   닫았다 다시 열면 앞선 스트림이 붙었다가 닫히고, 새 열기는 「닫혔다」며 실패해 가짜 「카메라를 열지 못했어요」가 떴다
let stream = null, video = null, wanted = false, reopenTried = false, opening = null, turn = 0;
let ic = null, photoOpts = null, photoOptsP = null, photoOptsBroken = false;   // ImageCapture 는 트랙마다 하나, photoSettings 는 열 때 한 번 구한다
let lastCaps = { zoom: null, torch: false };
const stateFns = new Set();
let offPause = null, offResume = null;
let lingering = false, lingerT = 0;                       // release 뒤 붙잡아 두는 중(video 없음, 트랙 끔)
export const LINGER_MS = 30000;
function emit(state, err) { for (const fn of stateFns) { try { fn(state, err); } catch (e) { console.error(e); } } }
// 상태: 'open' | 'paused'(백그라운드) | 'closed' | 'error'(err.code) — capture 화면이 cam-fallback 을 띄우는 데 쓴다
export function onState(fn) { stateFns.add(fn); return () => stateFns.delete(fn); }
export const isOpen = () => !!stream;

function codeOf(e) {
  const n = e?.name || '';
  if (n === 'NotAllowedError' || n === 'SecurityError' || n === 'PermissionDeniedError') return 'denied';
  if (n === 'NotFoundError' || n === 'OverconstrainedError' || n === 'DevicesNotFoundError') return 'nocamera';
  if (n === 'NotReadableError' || n === 'AbortError' || n === 'TrackStartError') return 'busy';
  return 'unknown';
}
const fail = (code, cause) => Object.assign(new Error({ denied: '카메라 권한이 없어요', nocamera: '카메라를 찾지 못했어요', insecure: '보안 연결(https)에서만 카메라를 쓸 수 있어요', busy: '다른 앱이 카메라를 쓰고 있어요', unknown: '카메라를 열지 못했어요', cancelled: '카메라 열기를 그만뒀어요' }[code]), { code, cause });
// 닫았거나 새로 열어 그만둔 열기 — 부른 쪽은 실패로 보지 않는다
export const isCancelled = e => e?.code === 'cancelled';

// 4:3 우선(설계 비평 8: 트랙을 16:9 로 열면 takePhoto 4:3 과 보이는 범위가 달라진다) → zoom 없이 → 1280×960 → 아무거나.
// 트랙 = 사진: 기본 촬영이 이 프레임을 그대로 쓰므로 4:3 약 1920×1440(280만 화소 — 대지 작업본 1600px 에 넉넉).
// 12MP 트랙(4032×3024)은 미리보기만으로 폰을 무겁게 했다(v0.5) — 그 사이 크기다. ideal 이라 카메라가 못 주면 가까운 크기로 열린다
const PREVIEW = { width: { ideal: 1920 }, height: { ideal: 1440 } };
const PREVIEW_SMALL = { width: { ideal: 1280 }, height: { ideal: 960 } };
const ATTEMPTS = [
  { facingMode: { ideal: 'environment' }, aspectRatio: { ideal: 4 / 3 }, ...PREVIEW, zoom: true },
  { facingMode: { ideal: 'environment' }, aspectRatio: { ideal: 4 / 3 }, ...PREVIEW },
  { facingMode: { ideal: 'environment' }, aspectRatio: { ideal: 4 / 3 }, ...PREVIEW_SMALL },
  { facingMode: { ideal: 'environment' } },
];
export const STREAM_LONG = 1920;
// takePhoto 해상도 — 긴 변 약 3264px(4:3 이면 3264×2448 ≈ 8MP). 12MP 보다 찍기·처리·갤러리 저장이 빠르고 대지(A4)에는 넘친다
export const PHOTO_LONG = 3264;
// getPhotoCapabilities 의 imageWidth/imageHeight 범위 → photoSettings | null(범위를 모르거나 이미 작으면 기본값 = 최대)
export function photoSettingsFor(caps, long = PHOTO_LONG) {
  const iw = caps?.imageWidth, ih = caps?.imageHeight;
  if (!iw || !ih || !(iw.max > 0) || !(ih.max > 0)) return null;
  const wide = iw.max >= ih.max;                                           // 센서 방향 — 보통 가로가 긴 변
  const L = wide ? iw : ih, S = wide ? ih : iw;
  if (L.max <= long * 1.05) return null;
  const fit = (r, v) => { const st = r.step > 0 ? r.step : 1, mn = r.min > 0 ? r.min : 1; const x = Math.round((v - mn) / st) * st + mn; return Math.max(mn, Math.min(r.max, x)); };
  const l = fit(L, long), sh = fit(S, Math.round(l * Math.min(1, S.max / L.max)));
  return wide ? { imageWidth: l, imageHeight: sh } : { imageWidth: sh, imageHeight: l };
}
async function getStream() {
  if (!globalThis.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw fail('insecure');
  let last = null;
  for (const v of ATTEMPTS) {
    try { return await navigator.mediaDevices.getUserMedia({ video: v, audio: false }); }
    catch (e) { last = e; if (codeOf(e) === 'denied') break; }
  }
  throw fail(codeOf(last), last);
}
function capsOf(track) {
  const c = track?.getCapabilities?.() || {};
  return { zoom: c.zoom && Number.isFinite(c.zoom.max) && c.zoom.max > c.zoom.min ? { min: c.zoom.min, max: c.zoom.max, step: c.zoom.step || 0.1 } : null, torch: !!c.torch };
}
// my = 이 열기의 차례. getUserMedia 가 끝났을 때 차례가 지났으면(그사이 닫힘·새 열기) 스트림을 버리고 'cancelled' — 새 열기는 제 것을 연다
async function start(my = turn) {
  const s = await getStream();
  if (my !== turn || !wanted) { s.getTracks().forEach(t => t.stop()); throw fail('cancelled'); }
  stream = s;
  const track = s.getVideoTracks()[0];
  track?.addEventListener('ended', onEnded);
  const v = video;
  if (v) {
    v.muted = true; v.playsInline = true; v.autoplay = true;
    v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
    v.srcObject = s;
    try { await v.play(); } catch { /* 자동 재생 막힘 — 화면을 누르면 다시 재생된다 */ }
    if (stream !== s) throw fail('cancelled');                              // 붙이는 사이 닫힘(close 가 트랙을 멈췄다)·새 열기
    if (!v.videoWidth) await new Promise(r => { const t = setTimeout(r, 3000); v.addEventListener('loadedmetadata', () => { clearTimeout(t); r(); }, { once: true }); });
    if (stream !== s) throw fail('cancelled');
  }
  lastCaps = capsOf(track);
  prepCapture(track);
  if (resting) applyRest();                                                // 시트가 떠 있는 동안 다시 열렸으면(화면 복귀) 계속 쉰다
  emit('open');
  return lastCaps;
}
// ImageCapture·photoSettings 준비(기다리지 않는다 — 열기를 늦추지 않게. 첫 셔터 때 아직이면 0.3초까지만 기다린다)
function prepCapture(track) {
  ic = null; photoOpts = null; photoOptsP = null;
  if (typeof globalThis.ImageCapture !== 'function' || !track) return;
  try { ic = new ImageCapture(track); } catch { ic = null; return; }
  if (photoOptsBroken || typeof ic.getPhotoCapabilities !== 'function') return;
  const mine = ic;
  photoOptsP = ic.getPhotoCapabilities().then(c => { if (ic === mine) photoOpts = photoSettingsFor(c); }, () => {});
}
export const photoSettings = () => photoOpts;
function stopTracks() {
  ic = null; photoOpts = null; photoOptsP = null;
  if (!stream) return;
  for (const t of stream.getTracks()) { t.removeEventListener('ended', onEnded); t.stop(); }
  stream = null;
  if (video) video.srcObject = null;
}
// 트랙이 끝났으면(다른 앱이 가져감·백그라운드에서 끊김) 한 번 다시 열어 보고, 안 되면 error
async function onEnded() {
  if (lingering) { close(); return; }                                     // 붙잡아 둔 사이 끊김 — 다시 열지 않는다
  if (!wanted || document.hidden) return;
  stopTracks();
  if (reopenTried) { emit('error', fail('busy')); return; }
  reopenTried = true;
  const my = turn;
  try { await start(my); } catch (e) { if (!isCancelled(e) && my === turn) emit('error', e.code ? e : fail('unknown', e)); }
}
// 백그라운드로 가면 닫고(초록 점·배터리·안드로이드가 끊음) 돌아오면 다시 연다(설계 비평 8)
function onHide() {
  if (lingering) { close(); return; }                                     // 붙잡아 둔 카메라는 백그라운드에서 바로 놓는다
  if (wanted && stream) { stopTracks(); emit('paused'); }
}
async function onShow() {
  if (!wanted || stream || opening) return;
  reopenTried = false;
  const my = turn, p = start(my);
  opening = p;
  try { await p; } catch (e) { if (!isCancelled(e) && my === turn) emit('error', e.code ? e : fail('unknown', e)); } finally { if (opening === p) opening = null; }
}
function onVis() { if (document.hidden) onHide(); else onShow(); }
function lifecycle(on) {
  if (on) {
    document.addEventListener('visibilitychange', onVis);
    try { offPause = native.onPause?.(onHide) || null; offResume = native.onResume?.(onShow) || null; } catch { /* 웹 */ }
  } else {
    document.removeEventListener('visibilitychange', onVis);
    try { offPause?.(); offResume?.(); } catch { /* 무시 */ }
    offPause = offResume = null;
  }
}

export async function open(videoEl) {
  if (lingering && stream && wanted) return attach(videoEl);                // 붙잡아 둔 stream 을 새 video 에 — 곧바로
  endLinger();
  if (wanted && video === videoEl && stream) return lastCaps;
  if (wanted && video === videoEl && opening) return opening;                // 같은 video 를 여는 중 — 그것을 기다린다(카메라를 두 번 열지 않게)
  if (stream) stopTracks();
  if (!wanted) lifecycle(true);
  wanted = true; video = videoEl || null; reopenTried = false;
  listen(true);
  const my = ++turn, p = start(my);
  opening = p;
  try { return await p; }
  catch (e) {
    const err = e?.code ? e : fail(codeOf(e), e);
    if (!isCancelled(err) && my === turn) emit('error', err);               // 그만둔 열기·지난 열기의 실패는 알리지 않는다(새 열기가 제 결과를 알린다)
    throw err;
  } finally { if (opening === p) opening = null; }
}
// ---------- 쉬기(글 입력 시트가 떠 있는 동안) ----------
// 트랙을 끄고(enabled=false — 카메라 프레임이 웹뷰로 오지 않는다) video 를 멈춘다(마지막 그림이 남아 검게 깜빡이지 않는다). 방향 감지(devicemotion 60Hz)도 끈다.
// 다시 켜면 곧바로(트랙 다시 켬 → 다음 프레임). 기기를 놓지 않으므로 다시 여는 지연이 없다
export function pause(on) {
  on = !!on;
  if (on === resting) return;
  resting = on;
  applyRest();
}
export const isPaused = () => resting;
function applyRest() {
  const t = stream?.getVideoTracks()[0];
  if (t) t.enabled = !resting;
  if (video && stream) {
    if (resting) { try { video.pause(); } catch { /* 없음 */ } }
    else video.play()?.catch?.(() => {});
  }
  if (resting) listen(false); else if (wanted) listen(true);
}

function endLinger() { clearTimeout(lingerT); lingerT = 0; lingering = false; }
// 붙잡아 둔 stream 을 videoEl 에 다시 붙인다(트랙 다시 켬) → caps
async function attach(videoEl) {
  endLinger();
  const my = ++turn, s = stream;
  video = videoEl || null; reopenTried = false;
  listen(true);
  const t = s.getVideoTracks()[0];
  if (t) t.enabled = !resting;
  const v = video;
  if (v) {
    v.muted = true; v.playsInline = true; v.autoplay = true;
    v.setAttribute('playsinline', ''); v.setAttribute('muted', '');
    if (v.srcObject !== s) v.srcObject = s;
    try { await v.play(); } catch { /* 자동 재생 막힘 */ }
    if (!v.videoWidth && stream === s) await new Promise(r => { const tm = setTimeout(r, 3000); v.addEventListener('loadedmetadata', () => { clearTimeout(tm); r(); }, { once: true }); });
  }
  if (my !== turn || stream !== s || !wanted) throw fail('cancelled');     // 붙이는 사이 닫힘(백그라운드)·새 열기
  emit('open');
  return lastCaps;
}
// 화면을 잠깐 떠날 때(크게 보기·지도) — 닫지 않고 keepMs 동안 붙잡는다. 그 안에 open(새 video) 하면 이어 쓴다. 0 이하·열린 게 없으면 close()
export function release({ keepMs = LINGER_MS } = {}) {
  if (!stream || !wanted || !(keepMs > 0) || document.hidden) { close(); return false; }
  clearTimeout(lingerT);
  resting = false;                                                         // 쉬기는 화면 몫 — 붙잡는 동안엔 트랙을 꺼 둔다
  const t = stream.getVideoTracks()[0];
  if (t) t.enabled = false;
  if (video) { try { video.pause(); } catch { /* 없음 */ } try { video.srcObject = null; } catch { /* 없음 */ } }
  video = null;
  listen(false);
  orientFns.clear();
  lingering = true;
  lingerT = setTimeout(() => { lingerT = 0; if (lingering) close(); }, keepMs);
  return true;
}
export const isLingering = () => lingering;
// [기록 시작]을 누르는 순간(홈 pointerdown) — 카메라는 켜지 않는다(사용자 지시: [카메라 열기]를 눌러야 켠다).
// 사진 워커를 미리 띄우고(첫 장 워커 생성 비용을 셔터에서 빼기), 붙잡아 둔 카메라가 있으면 시간을 다시 센다
let warmedAt = 0;
export function warm() {
  if (lingering && lingerT) { clearTimeout(lingerT); lingerT = setTimeout(() => { lingerT = 0; if (lingering) close(); }, LINGER_MS); }
  const now = Date.now();
  if (now - warmedAt < 20000 || !frameWorkerReady() || typeof OffscreenCanvas !== 'function') return;
  warmedAt = now;
  try {
    const c = new OffscreenCanvas(16, 12);
    const g = c.getContext('2d'); g.fillStyle = '#888'; g.fillRect(0, 0, 16, 12);
    c.convertToBlob({ type: 'image/jpeg', quality: 0.5 }).then(b => makeWorkAndThumbFast(b)).catch(() => {});
  } catch { /* 워커 미리 띄우기 실패 — 첫 셔터 때 띄운다 */ }
}

export function close() {
  turn++;                                                                  // 여는 중이던 열기는 그만둔다(늦게 끝나도 붙이지 않는다)
  endLinger();
  wanted = false;
  resting = false;
  stopTracks();
  lifecycle(false);
  listen(false);
  orientFns.clear();
  video = null;
  emit('closed');
}

export async function setZoom(z) {
  const t = stream?.getVideoTracks()[0];
  if (!t || !lastCaps.zoom) return false;
  const v = Math.min(lastCaps.zoom.max, Math.max(lastCaps.zoom.min, z));
  try { await t.applyConstraints({ advanced: [{ zoom: v }] }); return true; } catch { return false; }
}
export async function setTorch(on) {
  const t = stream?.getVideoTracks()[0];
  if (!t || !lastCaps.torch) return false;
  try { await t.applyConstraints({ advanced: [{ torch: !!on }] }); return true; } catch { return false; }
}

// ---------- 찍기 ----------
const shotInfos = new WeakMap();                      // blob → { turns, aspect, preview, prepared } — pipeline.ingest 가 옵션을 안 받아도 찾아 쓴다
export const shotInfo = blob => (blob && shotInfos.get(blob)) || null;
let grabbing = false, photoBusy = false;
export const isShooting = () => grabbing || photoBusy;

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('시간 초과')), ms))]);
const callSafe = (fn, ...a) => { if (fn) { try { fn(...a); } catch (e) { console.error(e); } } };

// 지금 보이는 프레임 → VideoFrame 또는 ImageBitmap(트랙 해상도).
//   VideoFrame(video): 프레임을 복사하지 않고 감싸기만 한다(메인 스레드 약 0ms) — 워커로 넘겨 거기서 그린다.
//   createImageBitmap(video) 는 프레임을 메인 스레드에서 복사·변환해 셔터 순간 한 번 멈췄다(4배 늦춤 PC 30~130ms, 폰은 GPU 읽어 오기라 더 클 수 있음).
//   VideoFrame 은 워커가 있을 때만, 보이는 크기·방향이 video 와 같을 때만(회전·뒤집기 정보가 붙은 프레임은 비트맵으로 — 방향이 어긋나지 않게).
// 안 되면 ImageCapture.grabFrame, 그것도 안 되면 null(호출자가 video 를 바로 그린다)
function wrapFrame() {
  if (typeof globalThis.VideoFrame !== 'function' || !video?.videoWidth || (video.readyState ?? 0) < 2 || !frameWorkerReady()) return null;
  let f = null;
  try {
    f = new VideoFrame(video);
    if (f.displayWidth === video.videoWidth && f.displayHeight === video.videoHeight && !f.rotation && !f.flip) return f;
  } catch { /* 이 웹뷰는 안 됨 — 비트맵으로 */ }
  try { f?.close(); } catch { /* 이미 닫힘 */ }
  return null;
}
async function grabBitmap(track) {
  const vf = wrapFrame();
  if (vf) return vf;
  if (typeof createImageBitmap === 'function' && video?.videoWidth) {
    try { return await createImageBitmap(video); } catch (e) { console.warn('프레임 잡기(createImageBitmap) 실패', e); }
  }
  if (ic && typeof ic.grabFrame === 'function') {
    try { return await withTimeout(ic.grabFrame(), 1000); } catch (e) { console.warn('grabFrame 실패', e); }
  } else if (typeof globalThis.ImageCapture === 'function' && track) {
    try { return await withTimeout(new ImageCapture(track).grabFrame(), 1000); } catch { /* 없음 */ }
  }
  return null;
}

// 프레임 잡기 → { blob, w, h, turns:0, aspect:null, preview, prepared, via:'grab' }
// onGrabbed(): 프레임을 잡은 즉시(인코딩 전). 잡은 비트맵은 워커로 넘긴다. 비트맵 가로/세로가 화면 프레임(video)과 다르면(센서 방향 그대로) 먼저 90° 돌려 맞춘다
async function grabShot(rel, r, onPreview, onGrabbed) {
  const track = stream?.getVideoTracks()[0];
  const bmp = await grabBitmap(track);
  if (bmp) callSafe(onGrabbed);
  const { w: vw, h: vh } = dims(video);
  const bw = bmp ? (bmp.displayWidth || bmp.width) : 0, bh = bmp ? (bmp.displayHeight || bmp.height) : 0;
  const pre = bmp && vw && vh && (bw > bh) !== (vw > vh) ? 1 : 0;
  const turns = (pre + turnsFor(rel)) % 4;
  const job = bmp ? frameJpegs(bmp, { turns, aspect: r, q: 0.92 }) : null;
  if (!job && bmp && typeof bmp.displayWidth === 'number') { try { bmp.close(); } catch { /* 이미 닫힘 */ } return mainGrab(video, turnsFor(rel), r, onPreview); }   // VideoFrame 인데 워커가 그새 꺼짐
  if (job) {
    job.preview.then(pv => { if (pv) callSafe(onPreview, pv); });
    try {
      const f = await job.full;
      const preview = await job.preview;
      shotInfos.set(f.blob, { turns: 0, aspect: null, preview, prepared: job.prepared });
      return { blob: f.blob, w: f.w, h: f.h, turns: 0, aspect: null, preview, prepared: job.prepared, via: 'grab' };
    } catch (e) { console.warn('워커 프레임 인코딩 실패 — 화면에서 다시 잡아요', e); try { bmp.close?.(); } catch { /* 넘겨져 이미 닫힘 */ } }
  } else if (bmp) {
    // 워커 없음 — 잡은 비트맵을 메인 스레드에서(예전 경로: toDataURL)
    try { return mainGrab(bmp, turns, r, onPreview); } finally { bmp.close?.(); }
  }
  if (!stream || !video) throw fail('unknown');
  try { return mainGrab(video, turnsFor(rel), r, onPreview); } finally { callSafe(onGrabbed); }
}
function mainGrab(src, turns, r, onPreview) {
  let preview = null;
  try { preview = snapshot(src, { turns, aspect: r }); } catch (e) { console.warn('미리보기 실패', e); }
  if (preview) callSafe(onPreview, preview);
  const c = transformCanvas(src, { turns, aspect: r });
  const blob = canvasToBlob(c, 0.92);
  shotInfos.set(blob, { turns: 0, aspect: null, preview });
  return { blob, w: c.width, h: c.height, turns: 0, aspect: null, preview, via: 'grab' };
}

// takePhoto(고화질, 느림 — 설정 captureHiRes) → { blob(돌리지 않은 원본), w, h, turns, aspect, preview, via:'takePhoto' }
async function photoShot(rel, r, onPreview) {
  const track = stream.getVideoTracks()[0];
  let preview = null;
  try { preview = snapshot(video, { turns: turnsFor(rel), aspect: r }); } catch (e) { console.warn('미리보기 실패', e); }
  if (preview) callSafe(onPreview, preview);
  if (!ic) prepCapture(track);
  if (!ic) throw new Error('ImageCapture 없음');
  if (photoOptsP && !photoOpts) await withTimeout(photoOptsP, 300).catch(() => {});
  const opts = photoOptsBroken ? null : photoOpts;
  let blob;
  try { blob = await withTimeout(opts ? ic.takePhoto(opts) : ic.takePhoto(), 5000); }
  catch (e) {
    if (!opts) throw e;
    photoOptsBroken = true; photoOpts = null;                         // 해상도 지정을 못 받는 기기 — 다음부터 기본값
    console.warn('takePhoto(해상도 지정) 실패 — 기본값으로 다시', e);
    blob = await withTimeout(ic.takePhoto(), 5000);
  }
  let pw, ph;
  const head = await jpegInfoOf(blob);
  if (head) { pw = head.w; ph = head.h; }
  else { const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); pw = bmp.width; ph = bmp.height; bmp.close?.(); }
  const { w: vw, h: vh } = dims(video);
  // 사진의 가로/세로 방향이 미리보기와 다르면(센서 방향 그대로 나옴) 먼저 90° 돌려 맞춘다(후면 카메라 센서 90° 가 보통)
  const pre = vw && vh && (pw > ph) !== (vw > vh) ? 1 : 0;
  const turns = (pre + turnsFor(rel)) % 4;
  const RW = turns % 2 ? ph : pw, RH = turns % 2 ? pw : ph;
  const c = cropRect(RW, RH, r);
  shotInfos.set(blob, { turns, aspect: r, preview });
  return { blob, w: c.w, h: c.h, turns, aspect: r, preview, via: 'takePhoto' };
}

// shoot({ ratio, hiRes, mode, onGrab, onPreview }) → { blob, w, h, turns, aspect, via, preview, prepared? } | null(같은 순간 두 번째 탭)
//   기본은 프레임 잡기(즉시). hiRes(또는 mode:'photo')면 takePhoto — 실패하면 프레임 잡기(mode:'photo' 면 던짐). mode:'grab' 은 늘 프레임 잡기.
//   w,h 는 회전·자르기 뒤 최종 크기. turns/aspect 가 0/null 이 아니면 blob 은 아직 돌리지 않은 원본 — pipeline 이 작업본을 만들 때 적용한다.
//   onGrab(): 프레임(또는 takePhoto 요청)을 잡은 즉시 — 이때부터 다음 셔터를 받아도 된다.
//   onPreview(blob): 약 320px 미리보기(돌리고 자른 최종 모양)가 나오는 즉시. shotInfo(blob).preview 에도 남는다.
//   prepared: 작업본·썸네일 약속(프레임 잡기+워커) — shotInfo(blob).prepared 로 pipeline 이 찾아 쓴다
export async function shoot({ ratio = '4:3', mode = 'auto', hiRes = false, onPreview = null, onGrab = null } = {}) {
  if (grabbing) return null;                              // 같은 순간(프레임을 잡는 몇 ms 안)의 두 번째 탭
  if (!stream || !video) throw fail('unknown');
  grabbing = true;
  let released = false;
  const release = () => { if (released) return; released = true; grabbing = false; callSafe(onGrab); };
  try {
    await new Promise(res => setTimeout(res, 0));        // 한 틱 양보 — 같은 순간의 두 번째 탭은 진행 중으로 보고 버린다
    if (!stream || !video) throw fail('unknown');
    if (resting) { pause(false); await new Promise(res => setTimeout(res, 120)); }   // 쉬는 중이면(시트) 깨우고 새 프레임을 기다린다
    const rel = orientation(), r = targetRatio(ratio);
    const wantPhoto = mode === 'photo' || (mode !== 'grab' && hiRes);
    if (wantPhoto && !photoBusy && typeof globalThis.ImageCapture === 'function' && stream.getVideoTracks()[0]) {
      photoBusy = true;
      release();                                          // takePhoto 를 기다리는 동안 들어온 셔터는 프레임 잡기로(버리지 않는다)
      try { return await photoShot(rel, r, onPreview); }
      catch (e) {
        if (mode === 'photo') throw e;
        console.warn('takePhoto 실패 — 프레임을 잡아요', e);
      } finally { photoBusy = false; }
      if (!stream || !video) throw fail('unknown');
      return await grabShot(orientation(), r, onPreview, null);
    }
    if (mode === 'photo') throw new Error('ImageCapture 없음');
    return await grabShot(rel, r, onPreview, release);    // 비트맵을 잡는 즉시 release — 인코딩(워커)을 기다리지 않고 다음 셔터를 받는다
  } finally { release(); }
}
