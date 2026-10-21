// 위치 도우미 — 거리·좌표 표기·주소 재요청 판단·VWorld getAddress 응답 해석(설계서 §5.2, reference/vworld-brief.md).
// 주소는 저장 금지(VWorld 약관: 실시간 사용만) — 여기서는 계산만 하고 아무것도 보관하지 않는다
const R = 6371008.8;                                   // 지구 평균 반지름(m)
const rad = d => d * Math.PI / 180;

// 하버사인 거리(m)
export function distM(a, b) {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

export const fmtCoord = (lat, lng) => `${Number(lat).toFixed(5)}, ${Number(lng).toFixed(5)}`;
export const fmtAcc = acc => (Number.isFinite(acc) ? `±${Math.round(acc)}m` : '');

// 주소를 다시 물을까? prev = 직전에 주소를 요청한 { lat, lng, at } | null, next = 지금 { lat, lng }.
// 직전 요청 후 10초 안이면 안 묻고, 20m 이상 움직였거나 120초 지났으면 묻는다(Geocoder 하루 4만 건 한도)
export const REGEO = { minMove: 20, maxAge: 120000, minGap: 10000 };
export function shouldRegeocode(prev, next, now = Date.now()) {
  if (!next || !Number.isFinite(next.lat) || !Number.isFinite(next.lng)) return false;
  if (!prev || !Number.isFinite(prev.lat) || !Number.isFinite(prev.at)) return true;
  const age = now - prev.at;
  if (age < REGEO.minGap) return false;
  return age >= REGEO.maxAge || distM(prev, next) >= REGEO.minMove;
}

// JSONP 콜백 값은 { response }, fetch 는 { response: {...} } 전체 — 둘 다 받는다
const body = r => (r && r.response && typeof r.response === 'object' ? r.response : r) || null;

// getAddress 응답 → { road, parcel, text } | null. 배열 순서를 믿지 않고 type 으로 고른다
export function pickAddress(response) {
  const r = body(response);
  if (!r || String(r.status).toUpperCase() !== 'OK') return null;
  const list = Array.isArray(r.result) ? r.result : r.result ? [r.result] : [];
  const of = t => list.find(i => String(i?.type || '').toLowerCase() === t)?.text?.trim() || '';
  const road = of('road'), parcel = of('parcel');
  if (!road && !parcel) return null;
  return { road, parcel, text: road || parcel };
}

const VW_MSG = {
  INCORRECT_KEY: '인증키와 등록한 서비스 주소가 맞지 않아요',
  INVALID_KEY: '등록되지 않은 인증키예요',
  EXPIRE_KEY: '인증키 기간이 끝났어요. VWorld 에서 연장해 주세요',
  OVER_REQUEST_LIMIT: '오늘 주소 조회 한도를 넘었어요',
  NOT_FOUND: '이 자리의 주소를 찾지 못했어요',
  ERROR: '주소 서버 오류예요. 잠시 뒤 다시 해 주세요',
};
// 오류 응답 → { code, message }. 정상(OK)이면 null. 모르는 코드는 ERROR 문구에 코드를 붙인다
export function vworldError(response) {
  const r = body(response);
  if (!r) return { code: 'ERROR', message: VW_MSG.ERROR };
  const status = String(r.status || '').toUpperCase();
  if (status === 'OK') return null;
  if (status === 'NOT_FOUND') return { code: 'NOT_FOUND', message: VW_MSG.NOT_FOUND };
  const code = String(r.error?.code || status || 'ERROR').toUpperCase();
  return { code, message: VW_MSG[code] || `${VW_MSG.ERROR} (${code})` };
}
