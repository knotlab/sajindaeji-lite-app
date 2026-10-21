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
// shoot() 은 한 번에 하나만 돈다(진행 중에 누르면 null). takePhoto 결과는 다시 인코딩하지 않고 {blob 그대로, turns, aspect} 를 넘겨
// 회전·자르기는 pipeline 이 작업본을 만들 때 한다(셔터 때 12MP 재인코딩으로 미리보기가 멈추지 않게, 설계 비평 7).
// 프레임 잡기(takePhoto 가 없거나 실패)는 어차피 인코딩하므로 그 자리에서 자르고 돌려 turns=0 으로 돌려준다.
import { transformCanvas, canvasToBlob, cropRect, dims } from './image.js';
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
let devO = 0, haveMotion = false, sm = null, listening = false;
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
let stream = null, video = null, wanted = false, reopenTried = false, opening = null;
let lastCaps = { zoom: null, torch: false };
const stateFns = new Set();
let offPause = null, offResume = null;
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
const fail = (code, cause) => Object.assign(new Error({ denied: '카메라 권한이 없어요', nocamera: '카메라를 찾지 못했어요', insecure: '보안 연결(https)에서만 카메라를 쓸 수 있어요', busy: '다른 앱이 카메라를 쓰고 있어요', unknown: '카메라를 열지 못했어요' }[code]), { code, cause });

// 4:3 우선(설계 비평 8: 트랙을 16:9 로 열면 takePhoto 4:3 과 보이는 범위가 달라진다) → 낮은 해상도 → 아무거나
const ATTEMPTS = [
  { facingMode: { ideal: 'environment' }, aspectRatio: { ideal: 4 / 3 }, width: { ideal: 4032 }, height: { ideal: 3024 }, zoom: true },
  { facingMode: { ideal: 'environment' }, aspectRatio: { ideal: 4 / 3 }, width: { ideal: 1920 }, height: { ideal: 1440 } },
  { facingMode: { ideal: 'environment' } },
];
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
async function start() {
  const s = await getStream();
  if (!wanted) { s.getTracks().forEach(t => t.stop()); throw fail('unknown'); }
  stream = s;
  const track = s.getVideoTracks()[0];
  track?.addEventListener('ended', onEnded);
  if (video) {
    video.muted = true; video.playsInline = true; video.autoplay = true;
    video.setAttribute('playsinline', ''); video.setAttribute('muted', '');
    video.srcObject = s;
    try { await video.play(); } catch { /* 자동 재생 막힘 — 화면을 누르면 다시 재생된다 */ }
    if (!video.videoWidth) await new Promise(r => { const t = setTimeout(r, 3000); video.addEventListener('loadedmetadata', () => { clearTimeout(t); r(); }, { once: true }); });
  }
  lastCaps = capsOf(track);
  emit('open');
  return lastCaps;
}
function stopTracks() {
  if (!stream) return;
  for (const t of stream.getTracks()) { t.removeEventListener('ended', onEnded); t.stop(); }
  stream = null;
  if (video) video.srcObject = null;
}
// 트랙이 끝났으면(다른 앱이 가져감·백그라운드에서 끊김) 한 번 다시 열어 보고, 안 되면 error
async function onEnded() {
  if (!wanted || document.hidden) return;
  stopTracks();
  if (reopenTried) { emit('error', fail('busy')); return; }
  reopenTried = true;
  try { await start(); } catch (e) { emit('error', e.code ? e : fail('unknown', e)); }
}
// 백그라운드로 가면 닫고(초록 점·배터리·안드로이드가 끊음) 돌아오면 다시 연다(설계 비평 8)
function onHide() { if (wanted && stream) { stopTracks(); emit('paused'); } }
async function onShow() {
  if (!wanted || stream || opening) return;
  reopenTried = false;
  try { opening = start(); await opening; } catch (e) { emit('error', e.code ? e : fail('unknown', e)); } finally { opening = null; }
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
  if (wanted && video === videoEl && stream) return lastCaps;
  if (stream) stopTracks();
  if (!wanted) lifecycle(true);
  wanted = true; video = videoEl || null; reopenTried = false;
  listen(true);
  try { opening = start(); return await opening; }
  catch (e) { const err = e.code ? e : fail(codeOf(e), e); emit('error', err); throw err; }
  finally { opening = null; }
}
export function close() {
  wanted = false;
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
const shotInfos = new WeakMap();                      // blob → { turns, aspect } — pipeline.ingest 가 옵션을 안 받아도 찾아 쓴다
export const shotInfo = blob => (blob && shotInfos.get(blob)) || null;
let shooting = false;
export const isShooting = () => shooting;

const withTimeout = (p, ms) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error('시간 초과')), ms))]);

// → { blob, w, h, turns, aspect, via } | null(진행 중이라 무시). w,h 는 회전·자르기 뒤 최종 크기.
// turns/aspect 가 0/null 이 아니면 blob 은 아직 돌리지 않은 원본 — pipeline 이 작업본을 만들 때 적용한다
export async function shoot({ ratio = '4:3', mode = 'auto' } = {}) {
  if (shooting) return null;
  if (!stream || !video) throw fail('unknown');
  shooting = true;
  try {
    await new Promise(res => setTimeout(res, 0));        // 한 틱 양보 — 같은 순간의 두 번째 탭은 진행 중으로 보고 버린다(프레임 잡기는 동기라서)
    if (!stream || !video) throw fail('unknown');
    const rel = orientation(), r = targetRatio(ratio);
    const track = stream.getVideoTracks()[0];
    if (mode !== 'grab' && typeof globalThis.ImageCapture === 'function' && track) {
      try {
        const blob = await withTimeout(new ImageCapture(track).takePhoto(), 5000);
        const bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' });
        const pw = bmp.width, ph = bmp.height; bmp.close?.();
        const { w: vw, h: vh } = dims(video);
        // 사진의 가로/세로 방향이 미리보기와 다르면(센서 방향 그대로 나옴) 먼저 90° 돌려 맞춘다(후면 카메라 센서 90° 가 보통)
        const pre = vw && vh && (pw > ph) !== (vw > vh) ? 1 : 0;
        const turns = (pre + turnsFor(rel)) % 4;
        const RW = turns % 2 ? ph : pw, RH = turns % 2 ? pw : ph;
        const c = cropRect(RW, RH, r);
        const info = { turns, aspect: r };
        shotInfos.set(blob, info);
        return { blob, w: c.w, h: c.h, ...info, via: 'takePhoto' };
      } catch (e) {
        if (mode === 'photo') throw e;
        console.warn('takePhoto 실패 — 프레임을 잡아요', e);
      }
    }
    // 프레임 잡기: 화면 좌표 프레임 → 돌리고 가운데 자르기(= screenAspect 상자) → q0.92
    const c = transformCanvas(video, { turns: turnsFor(rel), aspect: r });
    const blob = canvasToBlob(c, 0.92);
    shotInfos.set(blob, { turns: 0, aspect: null });
    return { blob, w: c.width, h: c.height, turns: 0, aspect: null, via: 'grab' };
  } finally { shooting = false; }
}
