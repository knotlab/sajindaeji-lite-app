// 현위치 — 참조 계수 방식(SPEC §5.6). 화면이 보일 때 start(), 떠날 때 stop. 모두 stop 이면 20초 뒤 watch 해제(배터리 — 화면 전환 사이엔 이어 감).
// APK 는 native.geoWatch(@capacitor/geolocation, interval 3초)만 쓰고, 웹은 navigator.geolocation.watchPosition.
// 주소(VWorld)는 geo.shouldRegeocode 가 참일 때만 묻고 메모리에만 둔다(약관: 저장 금지).
import { isNative, plugin, geoWatch, geoClear, geoRequest, onPause, onResume } from '../platform/native.js';
import { shouldRegeocode } from '../core/geo.js';
import * as vworld from './vworld.js';

const WEB_OPTS = { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 };
const FIX_MAX_AGE = 120000;                                                  // 사진에 붙일 위치는 120초 이내만

let snap = Object.freeze({ state: 'off', pos: null, addr: null, addrState: 'idle', addrError: null });
const subs = new Set();
let refs = 0, running = false, paused = false;
let webId = null, nativeId = null, gen = 0;
let lastReq = null, inflight = false;
let geoSource = null;                                                        // 시험용 가짜 geolocation({ watchPosition, clearWatch })
let lifeHooked = false;

// 붙잡기(hold): 글 입력 중에는 구독자(화면의 위치 줄·근처 도면)를 깨우지 않고 주소(VWorld)도 묻지 않는다 — 키보드·한글 조합과 다투지 않게.
// 값(snap)은 늘 최신이라 사진에 붙는 위치(fixForPhoto)는 그대로. 풀면 밀린 알림 한 번·주소 확인 한 번
let held = false, heldDirty = false, heldGeo = false;
const notify = () => { for (const fn of [...subs]) { try { fn(snap); } catch (e) { console.error(e); } } };
const emit = patch => {
  snap = Object.freeze({ ...snap, ...patch });
  if (held) { heldDirty = true; return; }
  notify();
};
export function hold(on) {
  on = !!on;
  if (on === held) return;
  held = on;
  if (on) return;
  if (heldDirty) { heldDirty = false; notify(); }
  if (heldGeo) { heldGeo = false; if (snap.pos && running) maybeGeocode(snap.pos); }
}
export const isHeld = () => held;
export function snapshot() { return snap; }
export function on(fn) { subs.add(fn); return () => subs.delete(fn); }

// 120초 안의 위치만 → { lat, lng, acc, at } | null
export function fixForPhoto(now = Date.now()) {
  const p = snap.pos;
  if (!p || !(now - p.at <= FIX_MAX_AGE)) return null;
  return { lat: p.lat, lng: p.lng, acc: p.acc, at: p.at };
}

// 모두 stop 해도 바로 끄지 않고 LINGER_MS 뒤에 끈다(속도 감사 #5② — 화면을 오갈 때마다 watch 를 껐다 켜며 「찾는 중」이 다시 뜨고
// Fused 위치가 처음부터 다시 잡히던 것). 그 사이 start 가 오면 그대로 이어 간다. 앱이 숨으면(pause) 지금처럼 바로 끈다
let LINGER_MS = 20000, lingerTimer = null;
function cancelLinger() { if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = null; } }
export function start() {
  refs++;
  hookLifecycle();
  cancelLinger();
  if (refs === 1) begin();
  let stopped = false;
  return function stop() {
    if (stopped) return;
    stopped = true;
    refs = Math.max(0, refs - 1);
    if (refs !== 0) return;
    if (LINGER_MS <= 0) { end('off'); return; }
    cancelLinger();
    lingerTimer = setTimeout(() => { lingerTimer = null; if (refs === 0) end('off'); }, LINGER_MS);
  };
}

// 권한 거부·꺼짐 뒤 gps-card 를 눌렀을 때 — 다시 묻고 다시 본다
export async function retry() {
  if (isNative()) await geoRequest();
  if (refs > 0) { end(null); begin(); }
}

// 키를 바꾼 뒤(설정) 지금 위치로 주소를 바로 다시
export function refreshAddress() { lastReq = null; if (snap.pos) maybeGeocode(snap.pos, true); }

function hookLifecycle() {
  if (lifeHooked || typeof document === 'undefined') return;
  lifeHooked = true;
  onPause(() => {
    if (refs === 0 && (running || lingerTimer)) { cancelLinger(); end('off'); return; }   // 끄기를 기다리던 중 — 바로 끈다
    if (running) { paused = true; end(null); }
  });
  onResume(() => { if (paused) { paused = false; if (refs > 0) begin(); } });
}

function begin() {
  if (running) return;
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') { paused = true; return; }
  running = true;
  const my = ++gen;
  emit({ state: snap.pos ? 'searching' : 'asking', addrState: vworld.key() ? (snap.addr ? snap.addrState : 'idle') : 'nokey' });
  const geo = geoSource || (typeof navigator !== 'undefined' ? navigator.geolocation : null);
  if (isNative() && plugin('Geolocation') && !geoSource) {
    geoWatch((pos, err) => { if (my === gen) (pos ? onPos(pos) : onErr(err)); })
      .then(id => { if (my === gen) nativeId = id; else geoClear(id); })
      .catch(e => { if (my === gen) onErr(Object.assign(e, { state: 'error' })); });
    return;
  }
  if (!geo?.watchPosition) { emit({ state: 'unsupported' }); running = false; return; }
  // 권한 상태를 알 수 있으면 '묻는 중'과 '찾는 중'을 가른다
  navigator.permissions?.query?.({ name: 'geolocation' }).then(p => {
    if (my === gen && !snap.pos && p.state === 'granted') emit({ state: 'searching' });
    if (my === gen && p.state === 'denied') emit({ state: 'denied' });
  }).catch(() => {});
  webId = geo.watchPosition(
    p => { if (my === gen) onPos({ lat: p.coords.latitude, lng: p.coords.longitude, acc: p.coords.accuracy, at: p.timestamp || Date.now() }); },
    e => { if (my === gen) onErr(Object.assign(new Error(e?.message || ''), { state: e?.code === 1 ? 'denied' : e?.code === 3 ? 'timeout' : 'error' })); },
    WEB_OPTS);
}

function end(state) {
  gen++;
  const geo = geoSource || (typeof navigator !== 'undefined' ? navigator.geolocation : null);
  if (webId != null) { try { geo?.clearWatch(webId); } catch { /* 무시 */ } webId = null; }
  if (nativeId != null) { geoClear(nativeId); nativeId = null; }
  running = false;
  if (state) emit({ state });
}

// 화면에 보이는 값(좌표 5자리·±m)이 같으면 구독자를 깨우지 않고 시각만 새로(사진에 붙일 위치는 늘 최신) — 단 10초마다 한 번은 알린다(새 위치를 기다리는 쪽)
const r5 = v => Math.round(v * 1e5);
const sameShown = (a, b) => !!a && !!b && r5(a.lat) === r5(b.lat) && r5(a.lng) === r5(b.lng) && Math.round(a.acc ?? -1) === Math.round(b.acc ?? -1);
let lastPosEmit = 0;
function onPos(pos) {
  if (!Number.isFinite(pos?.lat) || !Number.isFinite(pos?.lng)) return;
  const next = Object.freeze({ lat: pos.lat, lng: pos.lng, acc: Number.isFinite(pos.acc) ? pos.acc : null, at: pos.at || Date.now() });
  const now = Date.now();
  if (snap.state === 'ok' && sameShown(snap.pos, next) && now - lastPosEmit < 10000) snap = Object.freeze({ ...snap, pos: next });
  else { lastPosEmit = now; emit({ state: 'ok', pos: next }); }
  maybeGeocode(snap.pos);
}

function onErr(err) {
  const st = err?.state || 'error';
  if (st === 'timeout') { if (!snap.pos) emit({ state: 'searching' }); return; }   // 시간 초과는 계속 기다린다
  if (st === 'denied') return emit({ state: 'denied' });
  if (st === 'off') return emit({ state: 'off' });
  if (!snap.pos) emit({ state: 'error' });
}

async function maybeGeocode(pos, force = false) {
  if (held) { heldGeo = true; return; }                                        // 입력이 끝나면 hold(false) 가 다시 부른다
  if (!vworld.key()) { if (snap.addrState !== 'nokey') emit({ addrState: 'nokey', addr: null, addrError: null }); return; }
  if (inflight) return;
  const now = Date.now();
  if (!force && !shouldRegeocode(lastReq, pos, now)) return;
  lastReq = { lat: pos.lat, lng: pos.lng, at: now };
  inflight = true;
  if (!snap.addr) emit({ addrState: 'loading', addrError: null });
  try {
    const addr = await vworld.getAddress(pos.lat, pos.lng);
    emit({ addr: Object.freeze({ road: addr.road, parcel: addr.parcel, text: addr.text }), addrState: 'ok', addrError: null });
  } catch (e) {
    if (e.code === 'NOKEY') emit({ addrState: 'nokey', addr: null, addrError: null });
    else emit({ addrState: 'error', addrError: e.message || '주소를 받지 못했어요' });   // 직전 주소는 남겨 둔다(잠깐 끊긴 것일 수 있음)
  } finally { inflight = false; }
}

// ---- 시험용 ----
export function _setSource(geo) { geoSource = geo || null; }
export function _setLinger(ms) { LINGER_MS = Number(ms) || 0; }               // 시험용(0 = 마지막 stop 에 바로 끔)
export function _reset() {
  cancelLinger(); end(null); refs = 0; paused = false; lastReq = null; inflight = false; lastPosEmit = 0; held = false; heldDirty = false; heldGeo = false;
  snap = Object.freeze({ state: 'off', pos: null, addr: null, addrState: 'idle', addrError: null });
}
