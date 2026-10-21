// 날짜 문자열 도우미 — 모두 기기 현지 시각 기준. DOM·저장소에 기대지 않는다
const p2 = n => String(n).padStart(2, '0');
const D = ts => new Date(ts);
export const WEEK = '일월화수목금토';
export const ymd = ts => { const t = D(ts); return `${t.getFullYear()}${p2(t.getMonth() + 1)}${p2(t.getDate())}`; };
export const yymmdd = ts => ymd(ts).slice(2);
export const dayKey = ts => { const t = D(ts); return `${t.getFullYear()}-${p2(t.getMonth() + 1)}-${p2(t.getDate())}`; };
export const mdw = ts => { const t = D(ts); return `${t.getMonth() + 1}/${t.getDate()}(${WEEK[t.getDay()]})`; };
export const dotDate = ts => { const t = D(ts); return `${t.getFullYear()}.${p2(t.getMonth() + 1)}.${p2(t.getDate())}`; };
export const hm = ts => { const t = D(ts); return `${p2(t.getHours())}:${p2(t.getMinutes())}`; };
export const mmdd = ts => { const t = D(ts); return `${p2(t.getMonth() + 1)}${p2(t.getDate())}`; };
export function dayStart(key) { const [y, m, d] = key.split('-').map(Number); return new Date(y, m - 1, d).getTime(); }
export function addDays(key, n) { const t = new Date(dayStart(key)); t.setDate(t.getDate() + n); return dayKey(t.getTime()); }
export function ago(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 1) return '방금';
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

// ---- lite 추가(설계서 §5.2) — 날짜 키('YYYY-MM-DD')를 받는 함수들 ----
// '10월 21일 (화)'
export function dayLabel(day) { const t = new Date(dayStart(day)); return `${t.getMonth() + 1}월 ${t.getDate()}일 (${WEEK[t.getDay()]})`; }
export const isToday = (day, now = Date.now()) => day === dayKey(now);
// 그 주의 월요일 날짜 키(일요일은 앞 주 월요일)
export function weekStart(day) { const w = new Date(dayStart(day)).getDay(); return addDays(day, -((w + 6) % 7)); }
