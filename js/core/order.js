// 순서 계산(DOM 없음 — node 테스트 tests/unit/order.test.mjs). v0.1.6 사용자 요구 「목록 순서같은거 드래그앤드롭으로 이동시킬 수 있게」.
// 끌어 옮기기(widgets/reorder.js)·메뉴 [위로]·[아래로]·백업 합치기가 같은 규칙을 쓴다.
//
// 두 갈래
//  ① 배열 순서 — 한 레코드가 순서를 통째로 들고 있을 때(묶음 안 사진 record.photoIds — 순서 = 사진 번호, 지운 사진 id 도 남아 있다)
//       move(arr, from, to) · moveVisible(full, visible, from, to) · reorderTo(full, visibleOrder) · mergeIds(winner, loser)
//  ② 순서 값 — 항목마다 따로 저장될 때(그 날 묶음들, 자료함·도면보관함 줄)
//       orderOf · compareOrder · sortByOrder · between · planMove · renumber · normalize · withOrder
//
// 순서 값을 「정수 자리(0,1,2…)」가 아니라 「분수 위치(숫자), 없으면 만든 시각(ms)」으로 하는 까닭
//  - 옮긴 항목 하나만 쓴다. 정수 자리는 맨 아래를 맨 위로 올리면 그 사이 n개를 모두 다시 쓴다 → 묶음마다 rev+1,
//    APK 미러 파일(mirror/r-<id>.json — 브리지) n번, 백업 합치기에서 rev 다툼 n개(다른 기기에서 고친 글이 순서 때문에 질 수 있다).
//  - 옮기지 않은 항목은 순서 칸이 없어도 된다(기본값 = createdAt) → 0.1.5 기록은 고치지 않고(이주 없음) 지금 순서 그대로,
//    새로 만든 묶음은 저절로 맨 뒤(= 홈 「최신이 위」의 맨 위). 맨 뒤로 옮길 때는 now 를 써서 그 뒤에 만드는 것이 계속 뒤에 오게 한다.
//  - 거르기(찾기·칩)로 일부만 보일 때도, 보이는 이웃 둘 사이 값을 주면 전체 순서에서도 그 사이로 간다(숨은 것은 제자리).
//  - 숫자라 비교가 빠르고 JSON·백업에 그대로 실린다(옛 앱은 모르는 칸이라 무시 — 만든 시각 순으로 보인다).
//  한계: 같은 틈을 계속 반으로 나누면(1초 틈이면 약 20번) 자리가 모자란다 → planMove 가 그 목록을 다시 매긴다(renumber — 드묾, 양 끝 값은 그대로).
//  정수 자리를 쓰기로 하면 renumber(list, { start: 0, step: 1 }) 가 바뀐 것만 돌려준다.
//
// 바뀐 것은 늘 [{ id, order }] 로 돌려준다(저장소가 이것만 쓰면 된다). order 가 null 이면 「순서 칸을 지워 기본(만든 시각)으로」.

export const FIELD = 'order';
export const STEP = 60000;            // 맨 앞으로 옮길 때 첫 값보다 이만큼 앞(1분)
export const MIN_GAP = 0.001;         // 이보다 좁은 틈은 「자리 없음」(1µs — 숫자가 지저분해지기 전에 다시 매긴다)
export const RENUMBER_STEP = 1000;    // 다시 매길 때 최소 간격(1초 — 다시 20번쯤 반으로 나눌 수 있다)

const isNum = v => typeof v === 'number' && Number.isFinite(v);
const defId = x => x?.id;
const clampIdx = (i, n) => Math.max(0, Math.min(n - 1, Math.trunc(Number(i) || 0)));

// ------------------------------------------------------------------ ① 배열 순서

// 새 배열(원본은 그대로). to 는 옮긴 뒤의 자리. 범위를 넘으면 끝으로 붙인다
export function move(arr, from, to) {
  const a = Array.isArray(arr) ? [...arr] : [];
  const n = a.length;
  if (n < 2) return a;
  const f = clampIdx(from, n), t = clampIdx(to, n);
  if (f === t) return a;
  const [x] = a.splice(f, 1);
  a.splice(t, 0, x);
  return a;
}

// 보이는 것만 옮긴 결과를 전체 배열에 — full: 숨은 것(지운 사진 등) 포함 전체 id, visible: 보이는 id(화면 순서 = full 안의 순서).
// 숨은 것은 바로 앞의 보이는 것에 붙어 다닌다(reorderTo 규칙): 사진 1 다음에 지운 사진 2 가 있었으면 1 을 어디로 옮겨도 2 는 1 바로 뒤
// → 되살리면 「1 다음」 제자리. 맨 앞의 숨은 것(지운 첫 사진)은 계속 맨 앞
export function moveVisible(full, visible, from, to) {
  const src = Array.isArray(full) ? full : [];
  const vis = (Array.isArray(visible) ? visible : []).filter((id, i, a) => src.includes(id) && a.indexOf(id) === i);
  if (vis.length < 2) return [...src];
  const f = clampIdx(from, vis.length), t = clampIdx(to, vis.length);
  if (f === t) return [...src];
  return reorderTo(src, move(vis, f, t));
}

// 보이는 것의 새 순서(여러 개가 바뀌었을 때) → 전체 배열. 숨은 것은 원래 앞에 있던 보이는 것 뒤에 붙어 다닌다(맨 앞의 숨은 것은 맨 앞에).
// visibleOrder 에 없는 id 는 숨은 것으로 본다(버리지 않고 앞의 보이는 것 뒤에 붙음). 모르는 id·겹친 id 는 무시
export function reorderTo(full, visibleOrder) {
  const src = Array.isArray(full) ? full : [];
  const want = (Array.isArray(visibleOrder) ? visibleOrder : []).filter((id, i, a) => src.includes(id) && a.indexOf(id) === i);
  const wanted = new Set(want);
  const head = [];                                  // 첫 보이는 것 앞의 숨은 것
  const tail = new Map();                           // 보이는 id → 그 뒤에 붙은 숨은 것들
  let anchor = null;
  for (const id of src) {
    if (wanted.has(id)) { anchor = id; tail.set(id, []); continue; }
    if (anchor == null) head.push(id); else tail.get(anchor).push(id);
  }
  const out = [...head];
  for (const id of want) out.push(id, ...(tail.get(id) || []));
  return out;
}

// 두 순서 합치기(백업 복원 — 묶음 photoIds): 이긴 쪽(rev 큰 쪽) 순서를 따르고, 진 쪽에만 있는 id 는 진 쪽에서 바로 앞에 있던 id 뒤에
// (앞에 아무것도 없으면 맨 앞에) 넣는다. 아무것도 버리지 않는다. 겹친 id 는 한 번만
export function mergeIds(winner, loser) {
  const out = [];
  const seen = new Set();
  for (const id of Array.isArray(winner) ? winner : []) if (!seen.has(id)) { seen.add(id); out.push(id); }
  let anchor = null;
  for (const id of Array.isArray(loser) ? loser : []) {
    if (seen.has(id)) { anchor = id; continue; }
    const at = anchor == null ? 0 : out.indexOf(anchor) + 1;
    out.splice(at, 0, id);
    seen.add(id);
    anchor = id;
  }
  return out;
}

// ------------------------------------------------------------------ ② 순서 값

// 그 항목의 순서 값 — 저장된 값(field, 기본 'order')이 숫자면 그것, 아니면 기본(base: 칸 이름 또는 함수, 기본 'createdAt'), 그것도 없으면 0
export function orderOf(item, { field = FIELD, base = 'createdAt' } = {}) {
  if (!item) return 0;
  const v = item[field];
  if (isNum(v)) return v;
  const b = typeof base === 'function' ? base(item) : item[base];
  return isNum(b) ? b : 0;
}

// 오름차순 비교 — 순서 값 → 만든 시각 → 번호(no) → id. 같은 값이 섞여도 기기마다 같은 순서(합치기 뒤에도 흔들리지 않게)
export function compareOrder(a, b, opts = {}) {
  const d = orderOf(a, opts) - orderOf(b, opts);
  if (d) return d < 0 ? -1 : 1;
  const ca = isNum(a?.createdAt) ? a.createdAt : 0, cb = isNum(b?.createdAt) ? b.createdAt : 0;
  if (ca !== cb) return ca < cb ? -1 : 1;
  const na = String(a?.no ?? ''), nb = String(b?.no ?? '');
  if (na !== nb) return na < nb ? -1 : 1;
  const ia = String(a?.id ?? ''), ib = String(b?.id ?? '');
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}
export const sortByOrder = (list, opts = {}) => [...(Array.isArray(list) ? list : [])].sort((a, b) => compareOrder(a, b, opts));

// a < x < b 인 값. a 가 null 이면 맨 앞(b - step), b 가 null 이면 맨 뒤(now 를 주면 max(a + 1, now) — 그 뒤에 만드는 항목은 기본값이
// 만든 시각이라 계속 뒤에 온다. now 는 기본값이 만든 시각일 때만 준다). 자리가 없으면(같은 값·뒤집힘·부동소수 한계) null
export function between(a, b, { now = null, step = STEP } = {}) {
  const A = isNum(a), B = isNum(b);
  if (!A && !B) return isNum(now) ? now : 0;
  if (!A) return b - step;
  if (!B) return isNum(now) ? Math.max(a + 1, now) : a + step;
  if (!(b - a >= 2 * MIN_GAP)) return null;
  const m = a + (b - a) / 2;
  return m > a && m < b ? m : null;
}

// 한 항목 옮기기 → { id, order, changes, renumbered }
//   list: 지금 순서의 항목들(오름차순 — 작은 값이 앞). from → to(옮긴 뒤 자리). changes 를 저장하면 끝(보통 옮긴 것 하나).
//   desc: true 면 list·from·to 가 화면 순서이고 화면은 큰 값이 위(홈 「최신이 위」) — 안에서 뒤집어 계산한다.
//   거른 목록(찾기 결과 등)을 넘겨도 된다 — 보이는 이웃 사이 값이 되어 숨은 항목은 제자리.
//   자리가 없으면 옮긴 순서대로 list 를 다시 매긴다(renumbered: true, changes 여러 개).
export function planMove(list, from, to, { desc = false, now = null, step = STEP, idOf = defId, field = FIELD, base = 'createdAt', minStep = RENUMBER_STEP } = {}) {
  const src = Array.isArray(list) ? list : [];
  const n = src.length;
  const oo = { field, base };
  if (!n) return { id: null, order: null, changes: [], renumbered: false };
  let f = clampIdx(from, n), t = clampIdx(to, n);
  const asc = desc ? [...src].reverse() : src;
  if (desc) { f = n - 1 - f; t = n - 1 - t; }
  const item = asc[f], id = idOf(item);
  if (f === t) return { id, order: orderOf(item, oo), changes: [], renumbered: false };
  const rest = asc.filter((_, i) => i !== f);
  const prev = t > 0 ? rest[t - 1] : null, next = t < rest.length ? rest[t] : null;
  const v = between(prev ? orderOf(prev, oo) : null, next ? orderOf(next, oo) : null, { now, step });
  if (v != null) return { id, order: v, changes: [{ id, order: v }], renumbered: false };
  const arr = [...rest.slice(0, t), item, ...rest.slice(t)];
  const changes = renumber(arr, { idOf, field, base, minStep });
  const mine = changes.find(c => c.id === id);
  return { id, order: mine ? mine.order : orderOf(item, oo), changes, renumbered: true };
}

// 다시 매기기 — list 의 지금 배열 순서대로 같은 간격. 바뀐 것만 [{ id, order }].
//  기본: 가장 작은 값·가장 큰 값은 그대로 두고 그 사이를 고르게(새로 만드는 항목은 여전히 맨 뒤). 폭이 모자라면(< (n-1)·minStep)
//        가장 큰 값에 맞춰 앞쪽으로 minStep 간격. 값은 ms 정수로 반올림(간격이 1초 이상이라 겹치지 않는다).
//  start·step 을 주면 start + i·step 그대로(정수 자리 0,1,2… 를 쓰는 저장소용)
export function renumber(list, { start = null, step = null, minStep = RENUMBER_STEP, idOf = defId, field = FIELD, base = 'createdAt' } = {}) {
  const src = Array.isArray(list) ? list : [];
  const n = src.length;
  if (!n) return [];
  const oo = { field, base };
  const cur = src.map(x => orderOf(x, oo));
  let vals;
  if (isNum(start) && isNum(step)) vals = src.map((_, i) => start + i * step);
  else if (n === 1) vals = [cur[0]];
  else {
    let lo = Infinity, hi = -Infinity;
    for (const v of cur) { if (v < lo) lo = v; if (v > hi) hi = v; }
    if (hi - lo >= (n - 1) * minStep) vals = src.map((_, i) => (i === 0 ? lo : i === n - 1 ? hi : lo + Math.round((hi - lo) * i / (n - 1))));
    else vals = src.map((_, i) => hi - (n - 1 - i) * minStep);
  }
  const out = [];
  src.forEach((x, i) => { if (vals[i] !== cur[i]) out.push({ id: idOf(x), order: vals[i] }); });
  return out;
}

// 합치기·복원 뒤 정리 — 순서대로 늘어놓았을 때 값이 겹친 것만 다음 값 쪽으로 벌린다(겹친 무리의 첫 것과 나머지 항목은 그대로).
// 저장된 값이 숫자가 아니면(망가짐) { id, order: null }(칸을 지워 기본으로). 벌릴 틈이 없으면 전체를 다시 매긴다. → changes(없으면 [])
export function normalize(list, { idOf = defId, field = FIELD, base = 'createdAt', minStep = RENUMBER_STEP } = {}) {
  const src = Array.isArray(list) ? list : [];
  const oo = { field, base };
  const ch = new Map();
  for (const x of src) { const v = x?.[field]; if (v != null && !isNum(v)) ch.set(idOf(x), null); }
  const arr = sortByOrder(src, oo);
  let bad = false;
  for (let i = 0; i < arr.length && !bad;) {
    const v = orderOf(arr[i], oo);
    let j = i + 1;
    while (j < arr.length && orderOf(arr[j], oo) === v) j++;
    const m = j - i;
    if (m > 1) {
      const next = j < arr.length ? orderOf(arr[j], oo) : null;
      let prev = v;
      for (let k = 1; k < m; k++) {
        const val = next == null ? v + k : v + (next - v) * k / m;
        if (!(val > prev) || (next != null && !(val < next)) || (next != null && (next - v) / m < MIN_GAP)) { bad = true; break; }
        ch.set(idOf(arr[i + k]), val);
        prev = val;
      }
    }
    i = j;
  }
  if (bad) {
    for (const c of renumber(arr, { idOf, field, base, minStep })) ch.set(c.id, c.order);
  }
  return [...ch].map(([id, order]) => ({ id, order }));
}

// changes 를 반영한 새 목록(바뀐 항목만 새 객체 — 저장이 끝나기 전에 화면부터 새 순서로 그릴 때). order:null 은 칸을 지운다
export function withOrder(list, changes, { field = FIELD, idOf = defId } = {}) {
  const m = new Map((Array.isArray(changes) ? changes : []).map(c => [c.id, c.order]));
  return (Array.isArray(list) ? list : []).map(x => {
    const id = idOf(x);
    if (!m.has(id)) return x;
    const v = m.get(id);
    const y = { ...x };
    if (v == null) delete y[field]; else y[field] = v;
    return y;
  });
}
