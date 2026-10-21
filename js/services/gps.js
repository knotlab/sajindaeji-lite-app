// 현위치 — 참조 계수 방식(SPEC §5.6). 화면이 보일 때 start(), 떠날 때 stop. 모두 stop 이면 watch 해제(배터리).
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

const emit = patch => {
  snap = Object.freeze({ ...snap, ...patch });
  for (const fn of [...subs]) { try { fn(snap); } catch (e) { console.error(e); } }
};
export function snapshot() { return snap; }
export function on(fn) { subs.add(fn); return () => subs.delete(fn); }

// 120초 안의 위치만 → { lat, lng, acc, at } | null
export function fixForPhoto(now = Date.now()) {
  const p = snap.pos;
  if (!p || !(now - p.at <= FIX_MAX_AGE)) return null;
  return { lat: p.lat, lng: p.lng, acc: p.acc, at: p.at };
}

export function start() {
  refs++;
  hookLifecycle();
  if (refs === 1) begin();
  let stopped = false;
  return function stop() {
    if (stopped) return;
    stopped = true;
    refs = Math.max(0, refs - 1);
    if (refs === 0) end('off');
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
  onPause(() => { if (running) { paused = true; end(null); } });
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

function onPos(pos) {
  if (!Number.isFinite(pos?.lat) || !Number.isFinite(pos?.lng)) return;
  emit({ state: 'ok', pos: Object.freeze({ lat: pos.lat, lng: pos.lng, acc: Number.isFinite(pos.acc) ? pos.acc : null, at: pos.at || Date.now() }) });
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
export function _reset() {
  end(null); refs = 0; paused = false; lastReq = null; inflight = false;
  snap = Object.freeze({ state: 'off', pos: null, addr: null, addrState: 'idle', addrError: null });
}
