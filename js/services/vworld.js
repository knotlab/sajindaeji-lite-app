// VWorld 주소 변환(getAddress) — SPEC §5.6, reference/vworld-brief.md.
// 웹: JSONP(callback) — VWorld 는 CORS 헤더가 없다. 앱: native.httpGet(CapacitorHttp, 웹뷰 밖이라 CORS 없음).
// 약관: 결과는 "실시간 사용만, 별도 저장 금지" — 이 모듈은 아무것도 저장하지 않는다(돌려주기만, 저장은 호출자도 금지).
import { VWORLD_KEY, VWORLD_DOMAIN } from '../config.js';
import * as store from '../data/store.js';
import { isNative, httpGet } from '../platform/native.js';
import { pickAddress, vworldError } from '../core/geo.js';

const API = 'https://api.vworld.kr/req/address';
const TIMEOUT_MS = 8000;
const TEST_POINT = { lat: 37.566642192, lng: 126.978275264 };              // 서울시청

const fail = (code, message, extra) => Object.assign(new Error(message), { code, ...extra });

export function key() {
  let k = '';
  try { k = String(store.settings()?.vworldKey || '').trim(); } catch { /* store 준비 전 */ }
  return k || VWORLD_KEY || '';
}

// ---- 전송 ----
// 시험용 주입 훅: fn(params) → Promise<VWorld 응답 객체({response:{…}} 또는 안쪽 response)>. null 이면 기본 전송
let transport = null;
export function setTransport(fn) { transport = typeof fn === 'function' ? fn : null; }

let seq = 0;
function jsonp(params, ms) {
  return new Promise((resolve, reject) => {
    const cb = `__vworldCb${Date.now().toString(36)}${++seq}`;              // 카운터 — 같은 ms 에 두 번 불러도 겹치지 않게
    const s = document.createElement('script');
    let done = false, timer = 0;
    const end = () => { done = true; clearTimeout(timer); s.remove(); };
    window[cb] = data => {
      if (done) return;
      end();
      try { delete window[cb]; } catch { window[cb] = undefined; }
      resolve(data);
    };
    s.onerror = () => {
      if (done) return;
      end();
      window[cb] = () => {};                                                // 늦게 실행돼도 ReferenceError 가 나지 않게(설계 비평 기술 #11)
      reject(fail('NETWORK', '주소 서버에 연결하지 못했어요'));
    };
    timer = setTimeout(() => {
      if (done) return;
      end();
      window[cb] = () => {};                                                // 지우지 않고 빈 함수로 — 늦게 온 응답이 오류를 내지 않게
      reject(fail('TIMEOUT', '주소 응답이 너무 늦어요'));
    }, ms);
    s.async = true;
    s.referrerPolicy = 'origin';
    s.src = `${API}?${new URLSearchParams({ ...params, callback: cb })}`;
    document.head.appendChild(s);
  });
}

async function send(params) {
  if (transport) return transport({ ...params });
  if (isNative()) {
    const r = await httpGet(API, params, { timeoutMs: TIMEOUT_MS });
    if (!(r.status >= 200 && r.status < 300)) throw fail('HTTP', `주소 서버 오류(${r.status})`);
    if (typeof r.data !== 'object' || !r.data) throw fail('ERROR', '주소 응답을 읽지 못했어요');
    return r.data;
  }
  return jsonp(params, TIMEOUT_MS);
}

// 웹 JSONP 는 Referer 가 늘 붙는다. Referer + domain 을 같이 보내 INCORRECT_KEY 가 났다는 보고(brief g4)가 있어,
// INCORRECT_KEY 면 domain 없이 한 번 더 묻고 성공한 방식을 세션 동안 기억한다. APK 는 domain 필수(Referer 가 https://localhost)
let webDomain = true;
export function _resetDomainMemo() { webDomain = true; }                     // 시험용

// → { road, parcel, text }  | throws { code: NOKEY|TIMEOUT|NETWORK|NOT_FOUND|INCORRECT_KEY|INVALID_KEY|EXPIRE_KEY|OVER_REQUEST_LIMIT|ERROR, message(한국어) }
export async function getAddress(lat, lng, { key: k = key() } = {}) {
  k = String(k || '').trim();
  if (!k) throw fail('NOKEY', 'VWorld 키가 없어요');
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) throw fail('ERROR', '좌표가 없어요');
  const base = {
    service: 'address', request: 'getAddress', version: '2.0', crs: 'EPSG:4326',
    point: `${lng},${lat}`, type: 'both', format: 'json', errorFormat: 'json', key: k,
  };
  const native = isNative() && !transport;
  const withDomain = native || webDomain;
  let res = await send(withDomain ? { ...base, domain: VWORLD_DOMAIN } : base);
  let err = vworldError(res);
  if (err?.code === 'INCORRECT_KEY' && withDomain && !native) {
    const res2 = await send(base);
    const err2 = vworldError(res2);
    if (!err2 || err2.code === 'NOT_FOUND') { webDomain = false; res = res2; err = err2; }
  }
  if (err) throw fail(err.code, err.message);
  const a = pickAddress(res);
  if (!a) throw fail('NOT_FOUND', '이 위치의 주소를 찾지 못했어요');
  return a;
}

// 설정 [시험] — 서울시청 좌표로 → { ok, message }
export async function testKey(k) {
  try {
    const a = await getAddress(TEST_POINT.lat, TEST_POINT.lng, { key: k });
    return { ok: true, message: `주소를 받았어요: ${a.text}` };
  } catch (e) {
    return { ok: false, code: e.code || 'ERROR', message: e.message || '시험에 실패했어요' };
  }
}
