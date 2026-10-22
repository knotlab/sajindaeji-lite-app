// 보는 방향(나침반) — 참조 계수 방식(gps.js 와 같은 모양). 실시간 위치 지도(화면 'map')가 보일 때만 start(), 떠날 때 stop.
// 값: snapshot() → { heading /* 0~360, 북=0, 시계 방향. 모르면 null */, source: 'compass'|'gps'|null, accuracy /* ±도, 모르면 null */,
//                   needsCalibration, state: 'off'|'waiting'|'ok'|'nocompass'|'permission', speed /* m/s, 모르면 null */ }
// 나침반:
//   - 안드로이드 크롬·웹뷰: 'deviceorientationabsolute'(alpha·beta·gamma, 지구 기준). alpha 만 쓰면 폰을 세웠을 때 엉뚱해지므로
//     「폰 윗변 + 뒷면(카메라) 방향」을 수평으로 내린 벡터로 계산한다 — 눕히면 윗변, 세우면 카메라가 보는 쪽(네이버 지도처럼).
//     화면이 세로 고정이라 screen.orientation.angle 은 보통 0 이지만, 가로로 돌아가 있으면 그만큼 더한다.
//   - iOS 사파리: webkitCompassHeading(이미 북=0 시계 방향) + webkitCompassAccuracy. 권한은 requestPermission() 을 버튼 탭에서.
//   - 'deviceorientation' 에 absolute:true 가 오는 브라우저도 받는다. 상대 alpha(absolute:false)는 북쪽을 모르므로 버린다.
// GPS: gps.js 의 위치가 바뀔 때 직전 위치와 비교해 가는 방향·속도를 낸다(pos.heading·pos.speed 가 오면 그것을 먼저).
//   속도 > 1m/s(걷는 정도 이상)이면 GPS 방향을 섞고(빠를수록 많이), 멈춰 있으면 나침반만.
// 떨림: 단위 벡터 저역 필터(각도 원형 평균 — 359°↔1° 에서 튀지 않음), 화면 알림은 초당 최대 10회, 1° 안 바뀌면 알리지 않음.
// 보정: iOS 정확도 > 25° 또는 음수, 'compassneedscalibration' 이벤트, 또는 걷는 중 GPS 방향과 계속 60° 넘게 어긋날 때 needsCalibration.
import * as gps from './gps.js';

const EMIT_MS = 100;                 // 초당 최대 10회
const TAU_COMPASS = 0.12;            // 나침반 저역 필터 시간 상수(초) — 작을수록 빠르고 떨린다
const TAU_OUT = 0.1;                 // 섞은 뒤 한 번 더(지도 엔진도 회전을 짧게 애니메이션하므로 여기선 가볍게)
const GPS_FRESH_MS = 4000;           // GPS 방향은 4초 안의 것만
const MOVE_SPEED = 1;                // m/s — 이보다 빠르면 「이동 중」
const MIN_STEP_M = 5;                // GPS 방향을 낼 최소 이동 거리
const HIST_MS = 10000;               // 가는 방향을 잴 때 볼 최근 위치 기간
const NOCOMPASS_MS = 2500;           // 시작하고 이 안에 나침반 값이 없으면 「나침반 없음」
const CAL_DIFF = 60, CAL_MS = 8000;  // 걷는 중 나침반이 GPS 와 60° 넘게 8초 이상 어긋나면 보정 안내
const CAL_HOLD_MS = 15000;           // 보정 안내는 한 번 뜨면 15초는 유지(깜빡이지 않게)

const R2D = 180 / Math.PI, D2R = Math.PI / 180;
const norm = d => ((d % 360) + 360) % 360;
export const angleDiff = (a, b) => { const d = norm(a - b); return d > 180 ? d - 360 : d; };   // a - b, -180~180

let snap = Object.freeze({ heading: null, source: null, accuracy: null, needsCalibration: false, state: 'off', speed: null });
const subs = new Set();
let refs = 0, running = false;
let offGps = null, noCompassT = 0, emitT = 0, lastEmitAt = 0, lastEmitted = null, startT = 0;
const nowFn = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

// 나침반 필터 상태
let cx = 0, cy = 0, cAt = 0, cHas = false, cAcc = null, cLastRaw = 0;
let calEventAt = -Infinity, calFlagAt = -Infinity, calBadSince = 0;
let gotAbsolute = false;             // deviceorientationabsolute 가 한 번이라도 왔으면 일반 deviceorientation 은 무시(두 번 세지 않게)
// GPS 방향
let hist = [];                       // 최근 위치 [{ lat, lng, at }] (HIST_MS 안)
let rawCourse = null, rawAt = 0;     // 바로 전에 잰 방향(아직 안 믿은 것)
let gCourse = null, gSpeed = null, gAt = 0;
// 내보낼 값 필터
let ox = 0, oy = 0, oAt = 0, oHas = false;
let iosPermission = 'unknown';       // 'unknown' | 'granted' | 'denied' | 'none'(필요 없음)

export function snapshot() { return snap; }
export function on(fn) { subs.add(fn); return () => subs.delete(fn); }

export function start() {
  refs++;
  if (refs === 1) begin();
  let stopped = false;
  return function stop() {
    if (stopped) return;
    stopped = true;
    refs = Math.max(0, refs - 1);
    if (refs === 0) end();
  };
}

// iOS 13+: 버튼 탭(사용자 동작) 안에서 불러야 한다. 안드로이드·데스크톱은 바로 'granted'
export async function requestPermission() {
  const DOE = typeof DeviceOrientationEvent !== 'undefined' ? DeviceOrientationEvent : null;
  if (!DOE || typeof DOE.requestPermission !== 'function') { iosPermission = 'none'; return 'granted'; }
  try {
    const r = await DOE.requestPermission();
    iosPermission = r === 'granted' ? 'granted' : 'denied';
  } catch { iosPermission = 'denied'; }
  if (running) { detach(); attach(); }
  recompute(true);
  return iosPermission === 'granted' ? 'granted' : 'denied';
}
// 권한을 따로 물어야 하는 기기인가(iOS) — 화면이 [방향 보기] 탭에서 requestPermission 을 부를지 정할 때.
// 요즘 크롬에도 requestPermission 이 있지만 묻지 않아도 값이 온다 — deviceorientationabsolute 가 있는 브라우저(크롬·웹뷰)는 묻지 않는다.
// 나침반 값이 한 번이라도 왔으면 역시 묻지 않는다
export const needsPermission = () => !cHas && iosPermission !== 'granted'
  && typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function'
  && !(typeof window !== 'undefined' && 'ondeviceorientationabsolute' in window);

// 8방위 이름 — 0 북, 45 북동 …
const NAMES = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
export function dirName(deg) { return Number.isFinite(deg) ? NAMES[Math.round(norm(deg) / 45) % 8] : ''; }
export function fmtHeading(deg) { return Number.isFinite(deg) ? `${dirName(deg)} ${Math.round(norm(deg)) % 360}°` : ''; }

// ---------- 시작·끝 ----------
function begin() {
  if (running) return;
  running = true;
  startT = nowFn();
  resetFilters();
  set({ state: 'waiting', heading: null, source: null, accuracy: null, needsCalibration: false, speed: null });
  attach();
  offGps = gps.on(onGps);
  const g = gps.snapshot?.();
  if (g?.pos) onGps(g);
  clearTimeout(noCompassT);
  noCompassT = setTimeout(() => { if (running && !cHas) recompute(true); }, NOCOMPASS_MS);
}

function end() {
  running = false;
  detach();
  offGps?.(); offGps = null;
  clearTimeout(noCompassT); noCompassT = 0;
  clearTimeout(emitT); emitT = 0;
  set({ state: 'off', heading: null, source: null, accuracy: null, needsCalibration: false, speed: null });
}

let attached = false;
function attach() {
  if (attached || typeof window === 'undefined') return;
  attached = true;
  window.addEventListener('deviceorientationabsolute', onAbs);
  window.addEventListener('deviceorientation', onRel);
  window.addEventListener('compassneedscalibration', onCalEvent);
}
function detach() {
  if (!attached) return;
  attached = false;
  window.removeEventListener('deviceorientationabsolute', onAbs);
  window.removeEventListener('deviceorientation', onRel);
  window.removeEventListener('compassneedscalibration', onCalEvent);
}

function resetFilters() {
  cx = cy = 0; cAt = 0; cHas = false; cAcc = null; cLastRaw = 0; gotAbsolute = false;
  calEventAt = -Infinity; calFlagAt = -Infinity; calBadSince = 0;
  hist = []; rawCourse = null; rawAt = 0; gCourse = null; gSpeed = null; gAt = 0;
  ox = oy = 0; oAt = 0; oHas = false; lastEmitted = null; lastEmitAt = 0;
}

// ---------- 나침반 ----------
// 폰 윗변(0,1,0)과 뒷면(0,0,-1)을 더한 (0,1,-1) 을 지구 좌표(동·북·위)로 돌려 수평 성분의 방위각.
// 회전은 W3C 정의 R = Rz(alpha)·Rx(beta)·Ry(gamma). 눕히면 윗변, 세우면 카메라 방향이 된다.
export function headingFromEuler(alpha, beta, gamma) {
  if (!Number.isFinite(alpha)) return null;
  const a = alpha * D2R, b = (beta || 0) * D2R, g = (gamma || 0) * D2R;
  const ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b), cg = Math.cos(g), sg = Math.sin(g);
  const y = cb + sb * cg;            // Rx·Ry 를 거친 y
  const E = -ca * sg - sa * y;
  const N = -sa * sg + ca * y;
  if (Math.hypot(E, N) < 0.15) return null;   // 거의 수직(뒤집어 든 경우) — 방향을 모른다
  return norm(Math.atan2(E, N) * R2D);
}

function screenAngle() {
  const a = typeof screen !== 'undefined' ? screen.orientation?.angle : undefined;
  if (Number.isFinite(a)) return a;
  return Number.isFinite(window.orientation) ? window.orientation : 0;
}

function onAbs(e) {
  gotAbsolute = true;
  const h = headingFromEuler(e.alpha, e.beta, e.gamma);
  if (h == null) return;
  feedCompass(norm(h + screenAngle()), null);
}
function onRel(e) {
  if (Number.isFinite(e.webkitCompassHeading)) {                         // iOS — 이미 기울기 보정된 북=0 시계 방향
    const acc = Number.isFinite(e.webkitCompassAccuracy) ? e.webkitCompassAccuracy : null;
    if (iosPermission === 'unknown') iosPermission = 'granted';
    feedCompass(norm(e.webkitCompassHeading + screenAngle()), acc);
    return;
  }
  if (gotAbsolute || e.absolute !== true) return;                         // 상대 alpha 는 북쪽을 모른다
  const h = headingFromEuler(e.alpha, e.beta, e.gamma);
  if (h != null) feedCompass(norm(h + screenAngle()), null);
}
function onCalEvent() { calEventAt = nowFn(); recompute(true); }

function feedCompass(deg, acc) {
  const t = nowFn();
  const ux = Math.sin(deg * D2R), uy = Math.cos(deg * D2R);
  if (!cHas) { cx = ux; cy = uy; cHas = true; }
  else {
    const dt = Math.min(1, Math.max(0, (t - cAt) / 1000));
    const k = 1 - Math.exp(-dt / TAU_COMPASS);
    cx += k * (ux - cx); cy += k * (uy - cy);
  }
  cAt = t; cLastRaw = t;
  cAcc = acc;
  recompute(false);
}
const compassHeading = () => (cHas && Math.hypot(cx, cy) > 1e-3 ? norm(Math.atan2(cx, cy) * R2D) : null);
const compassAlive = t => cHas && t - cLastRaw < 3000;

// ---------- GPS 가는 방향 ----------
function bearing(a, b) {
  const p1 = a.lat * D2R, p2 = b.lat * D2R, dl = (b.lng - a.lng) * D2R;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return norm(Math.atan2(y, x) * R2D);
}
function dist(a, b) {
  const R = 6371008.8, p1 = a.lat * D2R, p2 = b.lat * D2R, dp = p2 - p1, dl = (b.lng - a.lng) * D2R;
  const s = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

function onGps(s) {
  const p = s?.pos;
  if (!p || !Number.isFinite(p.lat)) return;
  const t = nowFn();
  const at = Number.isFinite(p.at) ? p.at : Date.now();
  // 기기가 직접 준 방향·속도(gps.js 가 넘겨 주면) — 정지 중 heading 은 NaN/null 이 온다
  if (Number.isFinite(p.speed)) {
    gSpeed = p.speed;
    if (Number.isFinite(p.heading) && p.speed > MOVE_SPEED) { gCourse = norm(p.heading); gAt = t; }
    else if (p.speed <= MOVE_SPEED) gAt = 0;
    recompute(false);
    return;
  }
  // 최근 위치들(10초 안) 중 「need m 넘게 떨어진 가장 최근 점」과 비교 — 멈췄다 다시 걸을 때 오래된 기준점 때문에 느리게 재지 않게
  hist.push({ lat: p.lat, lng: p.lng, at });
  while (hist.length > 1 && at - hist[0].at > HIST_MS) hist.shift();
  const need = Math.max(MIN_STEP_M, Math.min(20, (p.acc || 0) * 0.6));    // 정확도가 나쁘면 더 많이 움직여야 방향으로 친다
  let q = null;
  for (let i = hist.length - 2; i >= 0; i--) if (dist(hist[i], p) >= need) { q = hist[i]; break; }
  if (!q) {                                                               // 제자리 — 오래 머물면 멈춤으로
    const old = hist[0], dtS = (at - old.at) / 1000;
    if (hist.length > 1 && dtS > 6) { gSpeed = dist(old, p) / dtS; gAt = 0; recompute(false); }
    return;
  }
  const dtS = (at - q.at) / 1000;
  if (dtS <= 0) return;
  gSpeed = dist(q, p) / dtS;
  if (gSpeed > MOVE_SPEED) {
    // 서 있을 때 위치가 몇 m 씩 튀는 것을 걸음으로 착각하지 않게 — 잇따른 두 번의 방향이 45° 안으로 맞아야 믿는다
    const c = bearing(q, p);
    if (rawCourse != null && t - rawAt < 3500 && Math.abs(angleDiff(c, rawCourse)) <= 45) { gCourse = c; gAt = t; }
    rawCourse = c; rawAt = t;
  } else { gAt = 0; rawCourse = null; }
  recompute(false);
}

// ---------- 섞기·알리기 ----------
function gpsWeight(t) {
  if (!gAt || t - gAt > GPS_FRESH_MS || !(gSpeed > MOVE_SPEED) || gCourse == null) return 0;
  return Math.min(0.85, 0.3 + (gSpeed - MOVE_SPEED) * 0.25);              // 1m/s 0.3 → 3m/s 0.8
}

function recompute(force) {
  if (!running) return;
  const t = nowFn();
  const ch = compassAlive(t) ? compassHeading() : null;
  const w = gpsWeight(t);
  let target = null, source = null;
  if (ch != null && w > 0) {
    const tx = (1 - w) * Math.sin(ch * D2R) + w * Math.sin(gCourse * D2R);
    const ty = (1 - w) * Math.cos(ch * D2R) + w * Math.cos(gCourse * D2R);
    target = norm(Math.atan2(tx, ty) * R2D);
    source = w >= 0.5 ? 'gps' : 'compass';
  } else if (ch != null) { target = ch; source = 'compass'; }
  else if (w > 0) { target = gCourse; source = 'gps'; }

  // 보정 판단 — 걷는 중 GPS 방향과 오래 어긋남
  if (ch != null && w > 0 && Math.abs(angleDiff(ch, gCourse)) > CAL_DIFF) { if (!calBadSince) calBadSince = t; }
  else if (ch != null && w > 0) calBadSince = 0;
  const iosBad = cAcc != null && (cAcc < 0 || cAcc > 25);
  if (iosBad || t - calEventAt < 2000 || (calBadSince && t - calBadSince > CAL_MS)) calFlagAt = t;
  const needsCalibration = ch != null && t - calFlagAt < CAL_HOLD_MS;

  // 한 번 더 부드럽게(GPS 가 1초마다 바뀌어도 툭 꺾이지 않게)
  let out = null;
  if (target != null) {
    const ux = Math.sin(target * D2R), uy = Math.cos(target * D2R);
    if (!oHas || t - oAt > 2000) { ox = ux; oy = uy; oHas = true; }
    else {
      const k = 1 - Math.exp(-Math.min(1, (t - oAt) / 1000) / TAU_OUT);
      ox += k * (ux - ox); oy += k * (uy - oy);
    }
    oAt = t;
    out = norm(Math.atan2(ox, oy) * R2D);
  } else oHas = false;

  let state;
  if (out != null) state = 'ok';
  else if (needsPermission()) state = 'permission';
  else if (t - startedAt() >= NOCOMPASS_MS && !cHas) state = 'nocompass';
  else state = 'waiting';
  const accuracy = source === 'compass' && cAcc != null && cAcc >= 0 ? Math.round(cAcc) : null;
  queue({ heading: out, source, accuracy, needsCalibration, state, speed: Number.isFinite(gSpeed) ? Math.round(gSpeed * 10) / 10 : null }, force);
}
const startedAt = () => startT;

let pending = null;
function queue(next, force) {
  pending = next;
  const t = nowFn();
  const wait = EMIT_MS - (t - lastEmitAt);
  if (force || wait <= 0) { flush(); return; }
  if (!emitT) emitT = setTimeout(() => { emitT = 0; flush(); }, wait);
}
function flush() {
  const n = pending; pending = null;
  if (!n || !running) return;
  const p = lastEmitted;
  const same = p && p.state === n.state && p.source === n.source && p.needsCalibration === n.needsCalibration && p.accuracy === n.accuracy
    && p.speed === n.speed && ((p.heading == null && n.heading == null) || (p.heading != null && n.heading != null && Math.abs(angleDiff(p.heading, n.heading)) < 1));
  if (same) return;                                                       // 1° 안 바뀌면 화면을 깨우지 않는다
  lastEmitAt = nowFn();
  lastEmitted = n;
  set(n);
}
function set(patch) {
  snap = Object.freeze({ ...snap, ...patch });
  for (const fn of [...subs]) { try { fn(snap); } catch (e) { console.error(e); } }
}

// ---- 시험용 ----
export function _reset() { refs = 0; if (running) end(); iosPermission = 'unknown'; snap = Object.freeze({ ...snap, state: 'off' }); }
export const _refs = () => refs;
