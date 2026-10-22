// 타일 계산(순수, DOM 없음) — EPSG:3857(웹 메르카토르) 위경도 ↔ 정규 좌표 ↔ 타일·화면 픽셀, 보이는 타일 목록.
// 지도 엔진 ui/widgets/livemap.js 가 쓴다. node 단위 시험: tests/unit/tilemath.test.mjs
//
// 좌표 약속
// - 정규 좌표 m = { x, y } : 0..1. x 는 서경 180°(0) → 동경 180°(1), y 는 북쪽 끝(0) → 남쪽 끝(1).
// - 세계 픽셀(확대 z): m × 256 × 2^z. z 는 소수도 된다(두 손가락 확대 중).
// - 화면: 보이는 칸의 왼쪽 위가 (0,0). 지도 가운데가 칸 가운데.
// - bearing(도): 화면 위쪽이 가리키는 방위. 0 = 북쪽 위, 90 = 동쪽이 위(지도는 시계 반대로 90° 돈다).
//   「진행 방향 위」 모드는 bearing = 보는 방향(heading).
// VWorld WMTS 타일 주소(reference/vworld-brief.md §4): .../wmts/1.0.0/{key}/{layer}/{z}/{y}/{x}.{ext} — y 가 x 보다 먼저다.

export const TILE = 256;
export const MIN_Z = 6;
export const MAX_Z = 19;
export const MAX_LAT = 85.05112878;
const R_EARTH = 6378137;                                   // EPSG:3857 구 반지름(m)
const D2R = Math.PI / 180;

// 레이어 → 받을 타일 원본(아래부터 겹침). Hybrid 는 위성 위에 지명·도로 타일을 겹친다
export const LAYERS = Object.freeze({
  Base: Object.freeze([{ name: 'Base', ext: 'png' }]),
  Satellite: Object.freeze([{ name: 'Satellite', ext: 'jpeg' }]),
  Hybrid: Object.freeze([{ name: 'Satellite', ext: 'jpeg' }, { name: 'Hybrid', ext: 'png' }]),
});
export const layerSources = layer => LAYERS[layer] || LAYERS.Base;

export function tileUrl(key, src, z, x, y) {
  return `https://api.vworld.kr/req/wmts/1.0.0/${encodeURIComponent(key)}/${src.name}/${z}/${y}/${x}.${src.ext}`;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
export const clampZoom = (z, lo = MIN_Z, hi = MAX_Z) => clamp(Number.isFinite(z) ? z : lo, lo, hi);
export const worldSize = z => TILE * 2 ** z;

// ---- 위경도 ↔ 정규 좌표 ----
export function toMerc(lat, lng) {
  const la = clamp(lat, -MAX_LAT, MAX_LAT) * D2R;
  return { x: (lng + 180) / 360, y: (1 - Math.log(Math.tan(la) + 1 / Math.cos(la)) / Math.PI) / 2 };
}
export function fromMerc(x, y) {
  const n = Math.PI * (1 - 2 * y);
  return { lat: Math.atan(Math.sinh(n)) / D2R, lng: x * 360 - 180 };
}
// 위경도 → 세계 픽셀(확대 z)
export function toWorld(lat, lng, z) {
  const m = toMerc(lat, lng), s = worldSize(z);
  return { x: m.x * s, y: m.y * s };
}
// 위경도 → 타일 번호(정수 z)
export function tileOf(lat, lng, z) {
  const w = toWorld(lat, lng, z), n = 2 ** z;
  return { z, x: clamp(Math.floor(w.x / TILE), 0, n - 1), y: clamp(Math.floor(w.y / TILE), 0, n - 1) };
}

// 화면 1px 이 땅 위 몇 m 인지(위도 lat, 확대 z)
export function metersPerPixel(lat, z) {
  return (2 * Math.PI * R_EARTH * Math.cos(clamp(lat, -MAX_LAT, MAX_LAT) * D2R)) / worldSize(z);
}

// ---- 각도 ----
export const normDeg = d => ((d % 360) + 360) % 360;
// a → b 로 가는 가장 짧은 회전(-180..180]
export function deltaDeg(a, b) {
  let d = normDeg(b - a);
  if (d > 180) d -= 360;
  return d;
}
// 벡터를 deg(시계 방향, 화면 좌표: y 아래) 만큼 돌린다
export function rotate(x, y, deg) {
  if (!deg) return { x, y };
  const r = deg * D2R, c = Math.cos(r), s = Math.sin(r);
  return { x: x * c - y * s, y: x * s + y * c };
}

// ---- 화면 ↔ 정규 좌표 ----
// view = { cx, cy (가운데 정규 좌표), z (소수 확대), bearing, w, h }
// 지도는 화면에서 -bearing 만큼(시계 방향 기준) 돌아 보인다
export function mercToScreen(view, mx, my) {
  const s = worldSize(view.z);
  const p = rotate((mx - view.cx) * s, (my - view.cy) * s, -(view.bearing || 0));
  return { x: view.w / 2 + p.x, y: view.h / 2 + p.y };
}
export function screenToMerc(view, sx, sy) {
  const s = worldSize(view.z);
  const p = rotate(sx - view.w / 2, sy - view.h / 2, view.bearing || 0);
  return { x: view.cx + p.x / s, y: view.cy + p.y / s };
}
export function latLngToScreen(view, lat, lng) {
  const m = toMerc(lat, lng);
  return mercToScreen(view, m.x, m.y);
}
export function screenToLatLng(view, sx, sy) {
  const m = screenToMerc(view, sx, sy);
  return fromMerc(m.x, m.y);
}

// 화면에서 (dx,dy) 만큼 손가락이 끌렸을 때 가운데 정규 좌표가 움직이는 양(끈 방향의 반대). 지도가 돌아 있어도 손가락을 따라간다
export function dragDelta(view, dx, dy) {
  const s = worldSize(view.z);
  const p = rotate(dx, dy, view.bearing || 0);
  return { x: -p.x / s, y: -p.y / s };
}

// 화면 점(ax,ay) 아래 땅을 그대로 두고 z 만 바꿀 때 새 가운데. 두 손가락·두 번 탭 확대
export function zoomAround(view, z2, ax, ay) {
  const m = screenToMerc(view, ax, ay);
  const s2 = worldSize(z2);
  const p = rotate(ax - view.w / 2, ay - view.h / 2, view.bearing || 0);
  return { cx: m.x - p.x / s2, cy: m.y - p.y / s2, z: z2 };
}

// ---- 보이는 범위·타일 ----
// 정수 확대 zi 의 세계 픽셀로 본 보이는 범위. 돌아 있으면 칸 대각선 반지름만큼(어느 각도든 덮게) 넓힌다
export function visibleBounds(view, zi, pad = 0) {
  const scale = 2 ** (view.z - zi);                         // zi 타일 한 픽셀이 화면 몇 px 인지
  const rotated = Math.abs(normDeg(view.bearing || 0)) > 1e-6 && Math.abs(normDeg(view.bearing || 0) - 360) > 1e-6;
  let hx, hy;
  if (rotated) { hx = hy = Math.hypot(view.w, view.h) / 2; } else { hx = view.w / 2; hy = view.h / 2; }
  hx = (hx + pad) / scale; hy = (hy + pad) / scale;
  const s = worldSize(zi);
  const cx = view.cx * s, cy = view.cy * s;
  return { minX: cx - hx, minY: cy - hy, maxX: cx + hx, maxY: cy + hy };
}
// 보이는 타일 범위(포함) — 같은 범위면 타일을 다시 고를 필요가 없다
export function tileRange(view, zi, pad = 0) {
  const b = visibleBounds(view, zi, pad), n = 2 ** zi;
  return {
    z: zi,
    x0: clamp(Math.floor(b.minX / TILE), 0, n - 1), x1: clamp(Math.floor(b.maxX / TILE), 0, n - 1),
    y0: clamp(Math.floor(b.minY / TILE), 0, n - 1), y1: clamp(Math.floor(b.maxY / TILE), 0, n - 1),
  };
}
export const sameRange = (a, b) => !!a && !!b && a.z === b.z && a.x0 === b.x0 && a.x1 === b.x1 && a.y0 === b.y0 && a.y1 === b.y1;
// 범위 안 타일 목록 — 가운데에 가까운 것부터(먼저 받게)
export function tilesIn(range, view) {
  const out = [];
  const s = view ? worldSize(range.z) : 0;
  const ccx = view ? view.cx * s / TILE - 0.5 : 0, ccy = view ? view.cy * s / TILE - 0.5 : 0;
  for (let y = range.y0; y <= range.y1; y++) {
    for (let x = range.x0; x <= range.x1; x++) out.push({ z: range.z, x, y, key: `${range.z}/${x}/${y}`, d: (x - ccx) ** 2 + (y - ccy) ** 2 });
  }
  if (view) out.sort((a, b) => a.d - b.d);
  return out;
}
export function visibleTiles(view, zi = Math.round(view.z), pad = 0) {
  return tilesIn(tileRange(view, zi, pad), view);
}

// 소수 확대 z 에서 쓸 타일 확대 단계 — 지금 단계 cur 가 있으면 0.7 넘게 벗어날 때만 바꾼다(경계에서 오락가락하며 다시 받지 않게)
export function levelFor(z, cur = null, hyst = 0.7) {
  const r = clampZoom(Math.round(z));
  if (cur == null || !Number.isFinite(cur)) return r;
  return Math.abs(z - cur) > hyst || !Number.isInteger(cur) ? r : cur;
}

// 미터 → 화면 px(위도 lat, 확대 z)
export const metersToPx = (m, lat, z) => m / metersPerPixel(lat, z);
