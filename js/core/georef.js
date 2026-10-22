// 도면 ↔ 위경도 맞추기(지오레퍼런스) — 순수 계산, DOM 없음. node 단위 시험: tests/unit/georef.test.mjs
// 사용자 요구: "도면보관함을 따로 만들어서 길찾고 핀 가능하게". 도면 위에 내 위치·보는 방향을 띄우고, 핀까지 방향·거리를 알려 준다.
//
// 좌표 약속
// - 도면(그림) 좌표 { x, y }: 그 쪽 그림(타일 피라미드 바탕 그림, page.w × page.h) 픽셀. x 오른쪽, y 아래.
// - 땅 좌표: 기준점들 가운데(무게 중심)를 원점으로 한 국소 평면 ENU 미터 { e: 동쪽, n: 북쪽 }.
//   WGS84 타원체의 그 위도 곡률 반지름(자오선 M, 묘유선 N)으로 위경도 차를 미터로 바꾼다 — 현장 크기(수 km 안)에서 오차 cm 수준.
// - 각도(도): 방위는 북=0 시계 방향. 「도면 위 각도」는 도면 위쪽(-y)에서 시계 방향.
//
// 변환 모델
// - 닮음(similarity, 4개 값: 이동·회전·축척): 기준점 2개 이상이면 언제나 가능. CAD·PDF 도면은 가로세로 축척이 같고 찌그러지지 않으므로
//   이게 물리적으로 맞는 모델이다. 도면이 뒤집혀 있지 않다고 본다(y 아래 ↔ 북 위 를 맞춘 거울 모양).
// - 아핀(affine, 6개 값: 찌그러짐까지): 기준점 3개 이상. 스캔·사진으로 늘어진 도면에 쓸모가 있지만 GPS 잡음(±5~10m)을 찌그러짐으로
//   빨아들여 엉뚱해지기 쉽다. 그래서 model:'auto' 는 「하나씩 빼고 맞춰 그 점을 맞히는」 교차 검증(LOO) 오차가 닮음보다 확실히(20%) 작을 때만
//   아핀을 고른다(점 3개면 아핀 LOO 가 닮음과 같아 닮음). 'affine' 을 직접 주면 그대로 쓴다(3점 이상, 한 줄로 늘어서 있지 않을 때).
// - 가중치: 점마다 w(주면 그것) 아니면 1/acc²(acc 는 그 점의 예상 오차 m — 지도에서 고른 점 약 1.5m, GPS 평균 점 ±5~10m).
//
// 품질
// - rmsM·maxM: 맞춘 뒤 남은 차(잔차) — 점이 모델 수보다 많을 때만 뜻이 있다(2점 닮음은 늘 0).
// - looM: 하나씩 빼고 맞춘 변환이 뺀 점을 얼마나 틀리는지(교차 검증) — 3점부터. 실제 현장 오차에 가장 가깝다.
// - predM: 점들의 acc 로 예측한 오차(닮음 최소제곱 오차 전파): 거리 r 인 곳에서 √(1/Σw + r²/Σw·d²), d = 무게 중심에서 각 점까지(m).
//   점이 가까이 몰려 있으면 먼 곳에서 커진다(회전이 흔들림) — 「기준점은 멀리 떨어뜨려 찍으세요」의 근거.
// - estM = max(looM, 쪽 끝까지의 predM) — 화면에 보여 줄 「±m」. 틀린 점(suspect)은 4점부터 찾을 수 있다.
import { distM } from './geo.js';

export const GEO_V = 1;
const A_WGS = 6378137, E2 = 6.69437999014e-3;
const D2R = Math.PI / 180, R2D = 180 / Math.PI;
export const MAP_ACC_M = 1.5;          // 지도(위성)에서 고른 점의 기본 예상 오차(m) — 위성 사진 어긋남 + 손가락
export const GPS_ACC_M = 8;            // acc 를 모르는 GPS 점
export const LEVEL_M = { good: 3, fair: 10 };   // ±3m 안 = 정확, ±10m 안 = 쓸 만함, 그 위 = 오차 큼
const AFFINE_GAIN = 0.8;               // auto: 아핀 LOO 가 닮음 LOO 의 80% 밑이어야 아핀
const BAD_MIN_M = 5;                   // 틀린 점 판정 최소 차(m)

const fin = v => typeof v === 'number' && Number.isFinite(v);
const okPoint = p => !!p && fin(p.x) && fin(p.y) && fin(p.lat) && fin(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
export const normDeg = d => ((d % 360) + 360) % 360;
export const angleDiff = (a, b) => { const d = normDeg(a - b); return d > 180 ? d - 360 : d; };   // a - b, -180~180

// ---- 위경도 ↔ 국소 평면(ENU m) ----
function radii(lat0) {
  const s = Math.sin(lat0 * D2R), q = 1 - E2 * s * s;
  return { M: A_WGS * (1 - E2) / (q * Math.sqrt(q)), N: A_WGS / Math.sqrt(q) };
}
export function makeOrigin(lat, lng) {
  const { M, N } = radii(lat);
  return { lat, lng, kN: M * D2R, kE: N * Math.cos(lat * D2R) * D2R };        // 1도당 m
}
export const toENU = (o, lat, lng) => ({ e: (lng - o.lng) * o.kE, n: (lat - o.lat) * o.kN });
export const fromENU = (o, e, n) => ({ lat: o.lat + n / o.kN, lng: o.lng + e / o.kE });

// ---- 2×3 행렬 [a, b, c, d, e, f]:  E = a·x + b·y + c,  N = d·x + e·y + f ----
const apply = (m, x, y) => ({ e: m[0] * x + m[1] * y + m[2], n: m[3] * x + m[4] * y + m[5] });
function invert(m) {
  const det = m[0] * m[4] - m[1] * m[3];
  if (!fin(det) || Math.abs(det) < 1e-300) return null;
  const a = m[4] / det, b = -m[1] / det, d = -m[3] / det, e = m[0] / det;
  return [a, b, -(a * m[2] + b * m[5]), d, e, -(d * m[2] + e * m[5])];
}

function weightOf(p) {
  if (fin(p.w) && p.w > 0) return p.w;
  const acc = fin(p.acc) && p.acc > 0 ? p.acc : (p.how === 'map' ? MAP_ACC_M : GPS_ACC_M);
  return 1 / Math.max(0.5, acc) ** 2;
}
const accOf = p => (fin(p.w) && p.w > 0 ? 1 / Math.sqrt(p.w) : fin(p.acc) && p.acc > 0 ? Math.max(0.5, p.acc) : p.how === 'map' ? MAP_ACC_M : GPS_ACC_M);

// 점들(이미 e,n 이 붙은 것) → 무게 중심 기준 값
function centered(P) {
  let W = 0, x = 0, y = 0, e = 0, n = 0;
  for (const p of P) { W += p.wt; x += p.wt * p.x; y += p.wt * p.y; e += p.wt * p.e; n += p.wt * p.n; }
  return { W, x: x / W, y: y / W, e: e / W, n: n / W };
}

// 닮음: E = p·x + q·y + tx, N = q·x − p·y + ty (y 아래 ↔ N 위 거울). 무게 중심 기준 닫힌 꼴 최소제곱
function fitSim(P) {
  const c = centered(P);
  let S = 0, A = 0, B = 0;
  for (const p of P) {
    const x = p.x - c.x, y = p.y - c.y, e = p.e - c.e, n = p.n - c.n;
    S += p.wt * (x * x + y * y); A += p.wt * (x * e - y * n); B += p.wt * (y * e + x * n);
  }
  if (!(S > 1e-9)) return null;                                              // 도면에서 같은 자리
  const pp = A / S, qq = B / S;
  if (!(Math.hypot(pp, qq) > 1e-12)) return null;                            // 땅에서 같은 자리
  return [pp, qq, c.e - pp * c.x - qq * c.y, qq, -pp, c.n - qq * c.x + pp * c.y];
}

// 아핀: x·y 에 대한 두 개의 가중 선형 회귀(무게 중심 기준 2×2)
function fitAff(P) {
  if (P.length < 3) return null;
  const c = centered(P);
  let sxx = 0, sxy = 0, syy = 0, sxe = 0, sye = 0, sxn = 0, syn = 0;
  for (const p of P) {
    const x = p.x - c.x, y = p.y - c.y, e = p.e - c.e, n = p.n - c.n, w = p.wt;
    sxx += w * x * x; sxy += w * x * y; syy += w * y * y; sxe += w * x * e; sye += w * y * e; sxn += w * x * n; syn += w * y * n;
  }
  const det = sxx * syy - sxy * sxy;
  if (!(det > 1e-9 * (sxx * syy || 1))) return null;                         // 한 줄로 늘어섬
  const a = (sxe * syy - sye * sxy) / det, b = (sye * sxx - sxe * sxy) / det;
  const d = (sxn * syy - syn * sxy) / det, e = (syn * sxx - sxn * sxy) / det;
  const m = [a, b, c.e - a * c.x - b * c.y, d, e, c.n - d * c.x - e * c.y];
  return invert(m) ? m : null;
}

const resid = (m, p) => { const q = apply(m, p.x, p.y); return Math.hypot(q.e - p.e, q.n - p.n); };

// 하나씩 빼고 맞춰 그 점을 얼마나 틀리는지(m). 빼고 남은 점으로 그 모델을 못 맞추면(아핀인데 2점) 닮음으로
function looErrors(P, model) {
  if (P.length < 3) return null;
  return P.map((p, i) => {
    const rest = P.filter((_, j) => j !== i);
    const m = (model === 'affine' && fitAff(rest)) || fitSim(rest);
    return m ? resid(m, p) : Infinity;
  });
}
const wrms = (P, errs) => { let s = 0, W = 0; P.forEach((p, i) => { s += p.wt * errs[i] ** 2; W += p.wt; }); return Math.sqrt(s / W); };

// ---- 맞추기 ----
// points: [{ id?, x, y, lat, lng, acc?, w?, how?, page? }]. opts: { model: 'auto'|'similarity'|'affine', page }
// → T(평범한 객체 — JSON 으로 저장해도 됨) | null(점 2개 미만·겹침)
//   T = { v, model, n, page, origin:{lat,lng}, m:[6], inv:[6], mPerPx, northDeg, rmsM, maxM, looM, ids, pts:[{id,x,y,e,n,wt,acc,resM,looM}] }
export function fit(points, { model = 'auto', page = null } = {}) {
  let src = (Array.isArray(points) ? points : []).filter(okPoint);
  if (page != null) src = src.filter(p => p.page == null || Number(p.page) === Number(page));
  if (src.length < 2) return null;
  let lat0 = 0, lng0 = 0, W0 = 0;
  for (const p of src) { const w = weightOf(p); lat0 += w * p.lat; lng0 += w * p.lng; W0 += w; }
  const origin = makeOrigin(lat0 / W0, lng0 / W0);
  const P = src.map(p => ({ id: p.id ?? null, x: p.x, y: p.y, ...toENU(origin, p.lat, p.lng), wt: weightOf(p), acc: accOf(p) }));

  const sim = fitSim(P);
  if (!sim) return null;
  let use = 'similarity', m = sim;
  let loo = looErrors(P, 'similarity');
  if (model === 'affine' || (model === 'auto' && P.length >= 4)) {
    const aff = fitAff(P);
    if (aff) {
      const looA = looErrors(P, 'affine');
      if (model === 'affine' || wrms(P, looA) < AFFINE_GAIN * wrms(P, loo)) { use = 'affine'; m = aff; loo = looA; }
    }
  }
  const inv = invert(m);
  if (!inv) return null;
  const res = P.map(p => resid(m, p));
  const T = {
    v: GEO_V, model: use, n: P.length, page: page ?? (src[0].page ?? null),
    origin: { lat: origin.lat, lng: origin.lng }, m, inv,
    rmsM: wrms(P, res), maxM: Math.max(...res),
    looM: loo ? wrms(P, loo.map(v => (fin(v) ? v : 1e6))) : null,
    ids: P.map(p => p.id),
    pts: P.map((p, i) => ({ id: p.id, x: p.x, y: p.y, e: p.e, n: p.n, wt: p.wt, acc: p.acc, resM: res[i], looM: loo ? loo[i] : null })),
  };
  T.mPerPx = Math.sqrt(Math.abs(m[0] * m[4] - m[1] * m[3]));
  T.northDeg = drawingAngle(T, 0);
  return T;
}

// 저장했던 T(JSON, 얼린 객체일 수도)를 다시 쓸 수 있게 — 원점 계수는 따로 기억한다
const origins = new WeakMap();
function originOf(T) {
  let o = origins.get(T);
  if (!o) { o = makeOrigin(T.origin.lat, T.origin.lng); origins.set(T, o); }
  return o;
}
export const isTransform = T => !!T && T.v === GEO_V && Array.isArray(T.m) && T.m.length === 6 && Array.isArray(T.inv) && !!T.origin;

// ---- 쓰기 ----
export function toLatLng(T, x, y) {
  if (!isTransform(T) || !fin(x) || !fin(y)) return null;
  const q = apply(T.m, x, y);
  return fromENU(originOf(T), q.e, q.n);
}
export function toXY(T, lat, lng) {
  if (!isTransform(T) || !fin(lat) || !fin(lng)) return null;
  const q = toENU(originOf(T), lat, lng);
  const r = apply(T.inv, q.e, q.n);
  return { x: r.e, y: r.n };
}

// 땅 방위(북=0 시계) → 도면 위 각도(도면 위쪽에서 시계). 닮음이면 northDeg + bearing, 아핀이면 찌그러짐까지 반영
export function drawingAngle(T, bearingDeg) {
  if (!T?.inv || !fin(bearingDeg)) return null;
  const b = bearingDeg * D2R, de = Math.sin(b), dn = Math.cos(b);
  const dx = T.inv[0] * de + T.inv[1] * dn, dy = T.inv[3] * de + T.inv[4] * dn;
  return normDeg(Math.atan2(dx, -dy) * R2D);
}
// 도면 위 각도 → 땅 방위(도면에서 그은 방향이 실제로 어느 쪽인지)
export function bearingOfDrawing(T, angleDeg) {
  if (!T?.m || !fin(angleDeg)) return null;
  const a = angleDeg * D2R, dx = Math.sin(a), dy = -Math.cos(a);
  const de = T.m[0] * dx + T.m[1] * dy, dn = T.m[3] * dx + T.m[4] * dy;
  return normDeg(Math.atan2(de, dn) * R2D);
}
// 도면 위에서 북쪽이 가리키는 각도(도면 위쪽에서 시계) — 내 방향 부채꼴: 화면 각도 = northOnDrawing + heading(닮음) 또는 drawingAngle(T, heading)
export const northOnDrawing = T => (T ? (fin(T.northDeg) ? T.northDeg : drawingAngle(T, 0)) : null);
// 도면 1px = 땅 몇 m(정확도 원 반지름을 도면 픽셀로 바꿀 때: px = m / mPerPx)
export const metersPerPx = T => (T && fin(T.mPerPx) ? T.mPerPx : null);

// ---- 품질 ----
// predM(T, x, y): 그 도면 자리에서 점들의 acc 로 예측한 오차(m, 대략 68%)
export function predictedErrorM(T, x, y) {
  if (!T?.pts?.length) return null;
  let W = 0, ex = 0, ny = 0;
  for (const p of T.pts) { const w = 1 / p.acc ** 2; W += w; ex += w * p.e; ny += w * p.n; }
  ex /= W; ny /= W;
  let S = 0;
  for (const p of T.pts) S += (1 / p.acc ** 2) * ((p.e - ex) ** 2 + (p.n - ny) ** 2);
  const q = apply(T.m, x, y), r2 = (q.e - ex) ** 2 + (q.n - ny) ** 2;
  return Math.sqrt(1 / W + (S > 0 ? r2 / S : Infinity));
}

// 틀린 점 찾기(4점부터): 그 점을 빼면 나머지가 확 잘 맞고(잔차 rms 가 절반 밑) 그 점의 LOO 차가 크면 그 점
function findSuspect(T) {
  if (!T || T.n < 4) return null;
  const P = T.pts;
  const base = T.rmsM;
  let best = null;
  for (let i = 0; i < P.length; i++) {
    const rest = P.filter((_, j) => j !== i);
    const m = (T.model === 'affine' && fitAff(rest)) || fitSim(rest);
    if (!m) continue;
    const r = wrms(rest, rest.map(p => resid(m, p)));
    const miss = resid(m, P[i]);
    if (!best || r < best.rest) best = { i, rest: r, miss };
  }
  if (!best) return null;
  const tol = Math.max(BAD_MIN_M, 2.5 * Math.max(best.rest, P[best.i].acc));
  if (best.rest < 0.5 * base && best.miss > tol) return { id: P[best.i].id, index: best.i, missM: best.miss, restM: best.rest };
  return null;
}

// quality(T, { w, h }) → { n, model, rmsM, maxM, looM, predM, estM, ok, level: 'good'|'fair'|'poor'|'none', text, suspect, points:[{id,resM,looM,acc}] }
//   w·h(쪽 그림 크기)를 주면 predM 은 쪽 네 모서리 중 가장 나쁜 값, 아니면 기준점들 중 가장 먼 곳
export function quality(T, { w = 0, h = 0, okM = LEVEL_M.fair } = {}) {
  if (!isTransform(T)) return { n: 0, model: null, rmsM: null, maxM: null, looM: null, predM: null, estM: null, ok: false, level: 'none', text: '기준점을 2개 이상 찍어 주세요', suspect: null, points: [] };
  const spots = w > 0 && h > 0 ? [[0, 0], [w, 0], [0, h], [w, h], [w / 2, h / 2]] : T.pts.map(p => [p.x, p.y]);
  const predM = Math.max(...spots.map(([x, y]) => predictedErrorM(T, x, y)));
  const est = Math.max(fin(T.looM) ? T.looM : 0, fin(predM) ? predM : 0, T.n > 2 ? T.rmsM : 0);
  const suspect = findSuspect(T);
  const level = est <= LEVEL_M.good ? 'good' : est <= LEVEL_M.fair ? 'fair' : 'poor';
  const pm = `±${fmtM(est)}`;
  let text = level === 'good' ? `정확해요 ${pm}` : level === 'fair' ? `쓸 만해요 ${pm}` : `오차가 커요 ${pm}`;
  if (suspect) text = `${pointName(T, suspect.index)} 기준점이 ${fmtM(suspect.missM)} 어긋나요`;
  else if (level === 'poor') text += ' · 멀리 떨어진 기준점을 더 찍어 주세요';
  else if (T.n === 2) text += ' · 기준점 2개';
  return {
    n: T.n, model: T.model, rmsM: T.rmsM, maxM: T.maxM, looM: T.looM, predM, estM: est,
    ok: est <= okM && !suspect, level, text, suspect,
    points: T.pts.map(p => ({ id: p.id, resM: p.resM, looM: p.looM, acc: p.acc })),
  };
}
const pointName = (T, i) => `${i + 1}번`;

// ---- 거리·방위 ----
// 현장 거리(50km 안)는 두 점 가운데의 국소 평면(타원체 곡률)으로 — 도면 변환과 같은 잣대라 「도면에서 잰 거리 = 안내 거리」.
// 더 멀면 하버사인(core/geo.js, 구). 둘 차이는 위도 37°에서 0.2% 안
const SHORT_M = 50000;
function local(a, b) {
  const o = makeOrigin((a.lat + b.lat) / 2, (a.lng + b.lng) / 2);
  const p = toENU(o, a.lat, a.lng), q = toENU(o, b.lat, b.lng);
  return { de: q.e - p.e, dn: q.n - p.n };
}
const okLL = p => !!p && fin(p.lat) && fin(p.lng);
export function distanceM(a, b) {
  if (!okLL(a) || !okLL(b)) return null;
  const far = distM(a, b);
  if (far > SHORT_M) return far;
  const { de, dn } = local(a, b);
  return Math.hypot(de, dn);
}
// 방위(북=0 시계). 멀면 대권 처음 방위
export function bearing(a, b) {
  if (!okLL(a) || !okLL(b)) return null;
  if (distM(a, b) <= SHORT_M) {
    const { de, dn } = local(a, b);
    return Math.abs(de) < 1e-9 && Math.abs(dn) < 1e-9 ? 0 : normDeg(Math.atan2(de, dn) * R2D);
  }
  const f1 = a.lat * D2R, f2 = b.lat * D2R, dl = (b.lng - a.lng) * D2R;
  const y = Math.sin(dl) * Math.cos(f2), x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return normDeg(Math.atan2(y, x) * R2D);
}

const DIRS8 = ['북', '북동', '동', '남동', '남', '남서', '서', '북서'];
export const dirName = deg => (fin(deg) ? DIRS8[Math.round(normDeg(deg) / 45) % 8] : '');
// 1m 아래 → '1m', 1000m 아래 → 정수 m(100m 넘으면 5m 단위), 그 위 → '1.2km'
export function fmtM(m) {
  if (!fin(m)) return '?';
  if (m < 1) return '1m';
  if (m < 100) return `${Math.round(m)}m`;
  if (m < 1000) return `${Math.round(m / 5) * 5}m`;
  return `${(m / 1000).toFixed(m < 10000 ? 1 : 0)}km`;
}
// 상대 방향(보는 방향 기준, -180~180) → '앞'|'오른쪽'|'뒤'|'왼쪽' (앞·뒤 ±45°)
export function turnOf(rel) {
  if (!fin(rel)) return null;
  const a = Math.abs(rel);
  return a <= 45 ? '앞' : a >= 135 ? '뒤' : rel > 0 ? '오른쪽' : '왼쪽';
}

// 길찾기 안내(직선) — me: { lat, lng, acc?, heading? } (heading 이 있으면 상대 방향), pin: { x, y, name? } 도면 위 핀 또는 { lat, lng }
// opts: { heading } (me.heading 대신), T: 핀이 도면 좌표면 필요
// → { distanceM, bearingDeg, dir: '북동', turn, relDeg, arrived, errM, target:{lat,lng}, text: '북동쪽 23m', turnText: '오른쪽으로 23m' | null,
//      angleOnDrawing: 도면 위 화살표 각도 } | null
export function guide(me, pin, T, { heading = me?.heading, arriveM = 5 } = {}) {
  if (!me || !fin(me.lat) || !fin(me.lng) || !pin) return null;
  const target = fin(pin.lat) && fin(pin.lng) ? { lat: pin.lat, lng: pin.lng } : toLatLng(T, pin.x, pin.y);
  if (!target) return null;
  const d = distanceM(me, target), brg = bearing(me, target);
  const errM = Math.hypot(fin(me.acc) ? me.acc : 0, T && fin(pin.x) ? (predictedErrorM(T, pin.x, pin.y) ?? 0) : 0);
  const arrived = d <= Math.max(arriveM, Math.min(errM, 15));
  const rel = fin(heading) ? angleDiff(brg, heading) : null;
  const turn = arrived ? null : turnOf(rel);
  const dist = fmtM(d), dir = dirName(brg);
  const text = arrived ? '거의 다 왔어요' : `${dir}쪽 ${dist}`;
  const turnText = arrived || !turn ? null : turn === '앞' ? `앞으로 ${dist}` : turn === '뒤' ? `뒤로 ${dist}` : `${turn}으로 ${dist}`;
  return {
    distanceM: d, bearingDeg: brg, dir, turn, relDeg: rel, arrived, errM, target, text, turnText,
    angleOnDrawing: T ? drawingAngle(T, brg) : null,
  };
}

// ---- 현장에서 맞추기: GPS 몇 초 평균 ----
// fixes: [{ lat, lng, acc, at }] → { lat, lng, acc, n, spreadM } | null
//   acc 로 가중 평균, 가운데(중앙값)에서 너무 먼 것(3×acc 넘음, 최소 15m)은 뺀다.
//   GPS 오차는 몇 초 사이 서로 이어져 있어(같은 쪽으로 쏠림) 평균해도 √n 만큼 줄지 않는다 → acc = max(가장 좋은 acc 의 70%, 흩어짐 rms)
export function averageFixes(fixes, { maxAcc = 50 } = {}) {
  const ok = (fixes || []).filter(f => f && fin(f.lat) && fin(f.lng) && (!fin(f.acc) || f.acc <= maxAcc));
  if (!ok.length) return null;
  const med = arr => { const s = [...arr].sort((a, b) => a - b); return s[s.length >> 1]; };
  const c = { lat: med(ok.map(f => f.lat)), lng: med(ok.map(f => f.lng)) };
  const keep = ok.filter(f => distM(c, f) <= Math.max(15, 3 * (fin(f.acc) ? f.acc : GPS_ACC_M)));
  const use = keep.length ? keep : ok;
  let W = 0, la = 0, lo = 0;
  for (const f of use) { const w = 1 / Math.max(1, fin(f.acc) ? f.acc : GPS_ACC_M) ** 2; W += w; la += w * f.lat; lo += w * f.lng; }
  const p = { lat: la / W, lng: lo / W };
  const spread = Math.sqrt(use.reduce((s, f) => s + distM(p, f) ** 2, 0) / use.length);
  const best = Math.min(...use.map(f => (fin(f.acc) ? f.acc : GPS_ACC_M)));
  return { lat: p.lat, lng: p.lng, acc: Math.max(best * 0.7, spread, 1), n: use.length, spreadM: spread };
}

// ---- 쪽(도면 그림) 둘레 ----
// 쪽 네 모서리 위경도 [왼위, 오위, 오아래, 왼아래] — 지도 화면에 도면 범위·도면 핀을 그릴 때
export function pageCorners(T, w, h) {
  if (!isTransform(T)) return null;
  return [[0, 0], [w, 0], [w, h], [0, h]].map(([x, y]) => toLatLng(T, x, y));
}
// 위경도가 쪽 안이면 0, 밖이면 쪽 테두리까지 땅 거리(m). 「지금 이 도면 안에 있어요」·근처 도면 찾기
export function outsideM(T, w, h, lat, lng) {
  const q = toXY(T, lat, lng);
  if (!q) return null;
  const dx = q.x < 0 ? -q.x : q.x > w ? q.x - w : 0, dy = q.y < 0 ? -q.y : q.y > h ? q.y - h : 0;
  return Math.hypot(dx, dy) * (T.mPerPx || 0);
}
