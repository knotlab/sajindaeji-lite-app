// 기록 모델 — Record(묶음)·Photo(사진) 만들기와 번호 규칙(설계서 §4.2·§4.3·§5.2). 순수 함수만, DOM·저장소 없음
import { dayKey } from './date.js';

// id = 접두어 + '_' + base36 12자(crypto.getRandomValues). 설계 비평: hex 8자면 사진 2.5만 장에서 충돌 약 7%,
// 같은 id 로 put 하면 기존 사진을 조용히 덮어쓴다 → 36^12(약 4.7e18)로 늘린다. 저장소(B)는 put 전에 있으면 다시 뽑는다
const A36 = '0123456789abcdefghijklmnopqrstuvwxyz';
export function uid(prefix = '') {
  const b = new Uint8Array(12), c = globalThis.crypto;
  if (c?.getRandomValues) c.getRandomValues(b); else for (let i = 0; i < b.length; i++) b[i] = Math.floor(Math.random() * 256);
  let s = '';
  for (const x of b) s += A36[x % 36];                 // 256 % 36 치우침은 id 용도에 무시할 만하다
  return prefix ? `${prefix}_${s}` : s;
}

// 'YYMMDD-NN' — day 는 'YYYY-MM-DD'
export const recordNo = (day, seq) => `${String(day).replace(/-/g, '').slice(2, 8)}-${String(seq).padStart(2, '0')}`;

export function newRecord({ id = uid('r'), day, now = Date.now(), location = '', content = '', site = '', seq = 1 } = {}) {
  const d = day || dayKey(now);
  return {
    id, no: recordNo(d, seq), day: d, createdAt: now, updatedAt: now, rev: 1,
    location: String(location ?? ''), content: String(content ?? ''), site: String(site ?? ''),
    photoIds: [], deletedAt: null,
  };
}

// state 기본 'processing' — 원본이 incoming 에 저장된 순간 만든다(§4.5). 작업본을 다 만들면 저장소가 ready 로 바꾼다
export function newPhoto({
  id = uid('p'), recordId, now = Date.now(), takenAt = now, takenAtSource = 'camera', source = 'incam',
  w = 0, h = 0, bytes = 0, thumbBytes = 0, gps = null, state = 'processing', store = null, original = null,
} = {}) {
  return {
    id, recordId, createdAt: now, takenAt: takenAt ?? null, takenAtSource, source,
    w, h, bytes, thumbBytes, gps: gps ? { lat: gps.lat, lng: gps.lng, acc: gps.acc ?? null, at: gps.at ?? null } : null,
    state, store, original, deletedAt: null,
  };
}

// 고칠 때마다 — 새 객체(rev+1, updatedAt)
export const touch = (rec, now = Date.now()) => ({ ...rec, rev: (rec.rev || 0) + 1, updatedAt: now });

// ①…⑳(U+2460), ㉑…㉟(U+3251), ㊱…㊿(U+32B1), 그 뒤는 (51)
export function circled(n) {
  if (n >= 1 && n <= 20) return String.fromCodePoint(0x2460 + n - 1);
  if (n >= 21 && n <= 35) return String.fromCodePoint(0x3251 + n - 21);
  if (n >= 36 && n <= 50) return String.fromCodePoint(0x32b1 + n - 36);
  return `(${n})`;
}

// 사진 번호(1부터). photoIds 에는 소프트 삭제된 사진 id 도 남으므로(되살리면 제자리) 살아 있는 사진만 센다(설계 비평).
// photos: 사진 배열 | Map(id→photo) | { id: photo } — 생략하면 원본처럼 자리 순서. 삭제됐거나 없는 사진이면 0
export function photoNo(record, photoId, photos) {
  const ids = record?.photoIds || [];
  if (!photos) return ids.indexOf(photoId) + 1;
  const get = photos instanceof Map ? id => photos.get(id)
    : Array.isArray(photos) ? (m => id => m.get(id))(new Map(photos.map(p => [p.id, p])))
    : id => photos[id];
  const alive = id => { const p = get(id); return !!p && !p.deletedAt; };
  if (!alive(photoId)) return 0;
  let n = 0;
  for (const id of ids) { if (alive(id)) n++; if (id === photoId) return n; }
  return 0;
}
