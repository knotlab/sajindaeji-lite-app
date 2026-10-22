// 한번에 보내기 계획 — 순수 함수(DOM·저장소 없음 → node 단위 시험 tests/unit/sendplan.test.mjs). 앱 0.1.7
// 사용자 요구 「오늘 것 한번에 보내기」(reference/parts/v017.md ## export ①~③ · ## check §1.3):
//   카톡 사진·글 = 아직 안 보낸 것만(보낸 뒤 사진이 더 생긴 묶음은 새 사진만) · 사진대지 엑셀 = 그 날(기간) 전체.
//   순서: 글 복사 → 카톡 1/n … n/n → 사진대지 엑셀. 공유 한 번 = 단계 하나.
// 보냄 기록(meta sendLog — data/sendlog.js 가 저장, 백업에는 안 실린다):
//   { v:1, recs: { [recordId]: { k?: { at, ids, textSig }, x?: { at, sig } } } }
//   k = 카톡: 넘긴 사진 id 들 + 그때 위치·내용 서명. 자리 번호·rev 로 보지 않는다(끌어 순서를 바꾸면 rev 가 오르고 자리가 바뀐다 — check §1.3-2).
//       id 로 보는 까닭: 처리 중이라 빠졌던 사진이 나중에 준비돼도(만든 시각이 보낸 사진보다 앞이어도) 「새 사진」으로 잡힌다.
//   x = 사진대지 엑셀: 그때 묶음 서명(id·순서 값·위치·내용·현장명·준비된 사진 순서·워터마크 설정) — 하나라도 다르면 「보낸 뒤 바뀜」.
//       + set·rg(그 엑셀에 든 묶음 id 목록 서명·기간) — 같은 기간 화면에서 묶음이 빠지거나(휴지통·사진과 내용을 비움) 끼면 순번이 당겨지므로 「보낸 뒤 바뀜」(수정 담당 검토 반영)
//       + pin(위치도 핀 서명 — 핀을 옮기거나 이름을 고치면 위치도 그림이 바뀐다. 도면보관함이 열려 있을 때만 비교, env.pinSig)
// 묶음 글은 여기서 만들지 않는다(카톡 글 = services/sendflow.js composeText, 사진대지 칸 = core/ledger.js sheetContent — 프리셋 설계 §5.1②).
import { dayStart, addDays, mdw, hm, weekStart } from './date.js';
import { orderOf } from './order.js';

export const SEND_KINDS = Object.freeze(['kakao', 'excel']);
export const LOG_DAYS = 60;                                   // 이보다 오래된 보냄 기록은 쓸 때 정리

// ---- 기억(meta exportPrefs) ---- 설정 화면은 늘리지 않는다(탭·⋮ 안에서 기억)
export const PREFS_DEFAULT = Object.freeze({
  v: 1,
  kinds: Object.freeze({ day: Object.freeze({ kakao: true, excel: true }), period: Object.freeze({ kakao: false, excel: true }) }),
  excelFormat: 'xlsx',                                        // 'xlsx'(사진 100장 이하면 xlsx 하나) | 'zip'(사진 파일도 넣기)
  autoNext: true,                                             // 앱: 카톡에서 돌아오면 다음 단계를 2초 뒤 저절로
  sentOpen: false,                                            // 「보낸 묶음」 펼침
  lastTarget: Object.freeze({ kakao: '', excel: '' }),         // 공유 결과 activityType(3단계에 씀)
});
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
export function mergePrefs(saved) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const D = PREFS_DEFAULT;
  const kk = (mode) => ({ kakao: bool(s.kinds?.[mode]?.kakao, D.kinds[mode].kakao), excel: bool(s.kinds?.[mode]?.excel, D.kinds[mode].excel) });
  return {
    v: 1,
    kinds: { day: kk('day'), period: kk('period') },
    excelFormat: s.excelFormat === 'zip' ? 'zip' : 'xlsx',
    autoNext: bool(s.autoNext, D.autoNext),
    sentOpen: bool(s.sentOpen, D.sentOpen),
    lastTarget: { kakao: String(s.lastTarget?.kakao ?? ''), excel: String(s.lastTarget?.excel ?? '') },
  };
}
export const modeOf = (from, to) => (from === to ? 'day' : 'period');

// ---- 서명 ---- FNV-1a 32bit(hex). 보냄 기록에 짧게 남긴다
function fnv(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}
const str = v => String(v ?? '').trim();
const idOf = p => (typeof p === 'string' ? p : p?.id);
export const hasText = r => !!str(r?.content);
// 카톡 글에 들어간 위치·내용
export const textSig = r => fnv(`${str(r?.location)}\u0001${str(r?.content)}`);
// 사진대지 한 묶음(그 묶음 칸·대장 줄을 바꾸는 것 전부). env = { site, wm } — 설정의 현장명·워터마크(mode|when)
export const excelSig = (r, readyIds = [], env = {}) =>
  fnv(JSON.stringify([r?.id ?? '', orderOf(r), str(r?.location), str(r?.content), str(r?.site) || str(env.site), (readyIds || []).map(idOf), String(env.wm ?? '')]));
// 여러 묶음 한 벌(만들어 둔 엑셀을 다시 써도 되나)
export const excelSetSig = (records, readyIdsOf, env = {}, extra = '') =>
  fnv(`${extra}|${(records || []).map(r => excelSig(r, readyIdsOf(r), env)).join(',')}`);
// 사진대지에 든 묶음 목록(순서대로) — 빠지거나 끼거나 순서가 바뀌면 달라진다(대장 순번·카톡 ①②·위치도 번호가 자리로 매겨진다)
export const setSig = ids => `${fnv((ids || []).join(','))}${(ids || []).length.toString(36)}`;
// 보낸 때 위치도 핀 서명과 지금 것이 같나 — 기록이 없거나(옛 기록) 지금 값을 모르면(도면보관함이 안 열림) 같다고 본다
const pinSame = (x, r, env) => {
  if (typeof x?.pin !== 'string' || typeof env?.pinSig !== 'function') return true;
  let cur = null;
  try { cur = env.pinSig(r); } catch { cur = null; }
  return cur == null || cur === x.pin;
};

// ---- 묶음 하나의 카톡 상태 ----
// ready: 그 묶음의 준비된 사진(사진대지 순서) — Photo 또는 id. entry: 보냄 기록 k(없으면 null)
// → { state: 'new'|'more'|'sent'|'edited', newIds, at, sendable }
//   new = 안 보냄 · more = 보낸 뒤 사진이 더 생김(newIds = 그 사진만) · sent = 보냄 · edited = 보낸 뒤 위치·내용을 고침(다시 보내지는 않는다)
//   sendable = 지금 보낼 것이 있다(사진, 또는 처음이면 글만이라도)
export function kakaoState(record, ready = [], entry = null) {
  const ids = (ready || []).map(idOf).filter(Boolean);
  if (!entry) return { state: 'new', newIds: ids, at: 0, sendable: ids.length > 0 || hasText(record) };
  const sent = new Set(entry.ids || []);
  const newIds = ids.filter(id => !sent.has(id));
  const at = Number(entry.at) || 0;
  if (newIds.length) return { state: 'more', newIds, at, sendable: true };
  const edited = entry.textSig != null && entry.textSig !== textSig(record);
  return { state: edited ? 'edited' : 'sent', newIds: [], at, sendable: false };
}

// ---- 사진대지(엑셀) 상태 ---- records: 엑셀에 들어갈 묶음(사진대지 순서), rg = 이 화면 기간('from~to' — 같은 기간으로 보낸 기록끼리만 묶음 목록을 견준다)
// → { state: 'none'|'new'|'changed'|'sent', at, n } — new = 한 번도(또는 일부가) 안 보냄 · changed = 다 보냈지만 그 뒤 바뀜
//   (묶음 서명·위치도 핀이 다르거나, 같은 기간으로 한 번에 보낸 묶음 목록에서 묶음이 빠지거나 순서가 바뀜 — 그새 지운 묶음도 여기서 잡힌다)
export function excelState(records, readyIdsOf, log, env = {}, { rg = '' } = {}) {
  const list = records || [];
  if (!list.length) return { state: 'none', at: 0, n: 0 };
  let have = 0, same = 0, at = 0;
  const xs = [];
  for (const r of list) {
    const x = log?.recs?.[r.id]?.x;
    if (!x) continue;
    have++; xs.push(x);
    if ((Number(x.at) || 0) > at) at = Number(x.at) || 0;
    if (x.sig === excelSig(r, readyIdsOf(r), env) && pinSame(x, r, env)) same++;
  }
  if (have < list.length) return { state: 'new', at, n: list.length, partial: have > 0 };
  if (same !== list.length) return { state: 'changed', at, n: list.length };
  // 모두 같은 엑셀(같은 기간·같은 묶음 목록)로 보냈는데 지금 목록이 다르면(그 뒤 묶음이 빠짐) — 보낸 엑셀의 순번과 지금 순번이 어긋난다
  const one = xs[0]?.set;
  if (rg && one && xs.every(x => x.rg === rg && x.set === one) && one !== setSig(list.map(r => r.id))) return { state: 'changed', at, n: list.length, why: 'set' };
  return { state: 'sent', at, n: list.length };
}

// ---- 무엇을 보낼지 ----
// records: 그 기간 묶음(사진대지 순서 — 날짜 → 순서). readyOf(r) → 준비된 사진(순서대로), pendingOf(r) → 처리 중 수.
// kinds: { kakao, excel }. ids: 고른 묶음(고르기 모드 — 카톡도 엑셀도 고른 것 전체), 없으면 카톡 = 안 보낸 것만 · 엑셀 = 전체.
// → { kakao: null | { recordIds, rows: [{ recordId, photoId }], more: Map<recordId, n>, photoCount },
//     excel: null | { recordIds, photoCount, state, at, n }, states: Map<id, kakaoState+{ready,pending}>, todo, sent, empty, seq: Map<id, 순번>, sheet, lastKakaoAt }
//   todo = 「보낼 묶음」(new·more — 보낼 것이 있거나 처리 중 사진이 있는 것), sent = 「보낸 묶음」(sent·edited),
//   empty = 안 보냈지만 보낼 것이 없는 묶음(준비된 사진도 내용도 처리 중 사진도 없음 — 사진대지에서도 빠진다. 목록에 두면 「다 보냈어요」와 「보낼 묶음 1」이 함께 뜬다).
//   seq = 사진대지 순번(대장 「순번」·카톡 ①② 와 같은 수). rg = 이 화면 기간('from~to', excelState)
export const isEmptyState = st => !!st && st.state === 'new' && !st.sendable && !st.pending;
export function pickToSend({ records = [], readyOf = () => [], pendingOf = () => 0, log = null, kinds = { kakao: true, excel: true }, ids = null, env = {}, rg = '' } = {}) {
  const pick = ids ? new Set(ids) : null;
  const states = new Map();
  const todo = [], sent = [], sheet = [], empty = [];
  let lastKakaoAt = 0;
  const readyMap = new Map();
  for (const r of records || []) {
    if (!r || r.deletedAt) continue;
    const ready = readyOf(r) || [];
    readyMap.set(r.id, ready);
    const st = { ...kakaoState(r, ready, log?.recs?.[r.id]?.k || null), ready: ready.length, pending: Number(pendingOf(r)) || 0 };
    states.set(r.id, st);
    if (st.at > lastKakaoAt) lastKakaoAt = st.at;
    (isEmptyState(st) ? empty : st.state === 'new' || st.state === 'more' ? todo : sent).push(r);
    if ((!pick || pick.has(r.id)) && (ready.length || hasText(r))) sheet.push(r);   // 사진도 내용도 없는 묶음은 사진대지에서 빠진다(ledger.selectExport 와 같은 규칙)
  }
  const seq = new Map(sheet.map((r, i) => [r.id, i + 1]));
  let kakao = null;
  if (kinds?.kakao) {
    const recordIds = [], rows = [], more = new Map();
    for (const r of records || []) {
      if (!r || !states.has(r.id)) continue;
      const st = states.get(r.id), ready = readyMap.get(r.id) || [];
      if (pick) {
        if (!pick.has(r.id) || (!ready.length && !hasText(r))) continue;
        recordIds.push(r.id);
        for (const p of ready) rows.push({ recordId: r.id, photoId: idOf(p) });
        continue;
      }
      if (!st.sendable) continue;
      recordIds.push(r.id);
      for (const id of st.newIds) rows.push({ recordId: r.id, photoId: id });
      if (st.state === 'more') more.set(r.id, st.newIds.length);
    }
    kakao = { recordIds, rows, more, photoCount: rows.length };
  }
  let excel = null;
  if (kinds?.excel) {
    const readyIdsOf = r => (readyMap.get(r.id) || []).map(idOf);
    excel = { recordIds: sheet.map(r => r.id), photoCount: sheet.reduce((n, r) => n + (readyMap.get(r.id) || []).length, 0), ...excelState(sheet, readyIdsOf, log, env, { rg: pick ? '' : rg }) };
  }
  return { kakao, excel, states, todo, sent, empty, seq, sheet, lastKakaoAt };
}

// 공유 한 번 분량으로 나누기 — 나눔 횟수는 ceil(n/max) 그대로 두고, 그 안에서 되도록 묶음 경계에서 자른다(한 묶음 사진이 두 번에 갈라지지 않게)
export function splitShare(rows, max) {
  const list = Array.isArray(rows) ? rows : [];
  const n = list.length;
  if (!n) return [];
  if (!(max > 0) || n <= max) return [list.slice()];
  const k = Math.ceil(n / max);
  const out = [];
  let s = 0;
  for (let j = 1; j < k; j++) {
    const lo = Math.max(s + 1, n - (k - j) * max), hi = Math.min(n - 1, s + max);   // 이 조각의 끝(배타) — 남은 조각이 다 담을 수 있는 범위
    let e = hi;
    for (let x = hi; x >= lo; x--) if (list[x - 1]?.recordId !== list[x]?.recordId) { e = x; break; }
    out.push(list.slice(s, e));
    s = e;
  }
  out.push(list.slice(s));
  return out;
}

// 단계 — 카톡 1/n … n/n → 사진대지 엑셀(파일 하나: 100장 넘거나 사진 파일도 넣으면 ZIP 하나)
export function stepsOf({ kakaoParts = [], excel = null } = {}) {
  const parts = (kakaoParts || []).filter(p => p?.length);
  const out = parts.map((rows, i) => ({ key: `kakao:${i + 1}`, kind: 'kakao', part: i + 1, parts: parts.length, n: rows.length }));
  if (excel) out.push({ key: 'excel', kind: 'excel', part: 1, parts: 1, n: Number(excel.photoCount) || 0 });
  return out;
}

// ---- 보냄 기록 고치기(새 객체를 돌려준다 — 원본은 그대로) ----
// entries: 카톡 [{ recordId, ids, textSig }] · 엑셀 [{ recordId, sig, set?, rg?, pin? }](set·rg = 그 엑셀 묶음 목록 서명·기간, pin = 위치도 핀 서명 — 있을 때만 적는다).
// → { log, undo } — undo 는 고치기 전 값(undoLog 에 넘긴다)
const KEY = { kakao: 'k', excel: 'x' };
export function markLog(log, { kind, entries = [], at = Date.now() } = {}) {
  const key = KEY[kind];
  const recs = { ...(log?.recs || {}) };
  const undo = { prev: {} };
  if (!key) return { log: { v: 1, recs }, undo };
  for (const e of entries || []) {
    const id = e?.recordId;
    if (!id) continue;
    const cur = recs[id] || {};
    if (!undo.prev[id]) undo.prev[id] = {};
    if (!(key in undo.prev[id])) undo.prev[id][key] = cur[key] ? { ...cur[key] } : null;
    const v = key === 'k'
      ? { at, ids: [...new Set([...(cur.k?.ids || []), ...(e.ids || []).filter(Boolean)])], textSig: e.textSig ?? cur.k?.textSig ?? null }
      : { at, sig: e.sig ?? null, ...(e.set ? { set: String(e.set), rg: String(e.rg ?? '') } : {}), ...(typeof e.pin === 'string' ? { pin: e.pin } : {}) };
    recs[id] = { ...cur, [key]: v };
  }
  return { log: { v: 1, recs }, undo };
}
// 보냄 표시 지우기 — kind 가 없으면 둘 다
export function clearLog(log, recordIds = [], kind = null) {
  const keys = kind ? [KEY[kind]].filter(Boolean) : ['k', 'x'];
  const recs = { ...(log?.recs || {}) };
  const undo = { prev: {} };
  for (const id of recordIds || []) {
    const cur = recs[id];
    if (!cur) continue;
    const next = { ...cur };
    for (const k of keys) {
      if (!(k in cur)) continue;
      if (!undo.prev[id]) undo.prev[id] = {};
      undo.prev[id][k] = { ...cur[k] };
      delete next[k];
    }
    if (Object.keys(next).length) recs[id] = next; else delete recs[id];
  }
  return { log: { v: 1, recs }, undo };
}
// 되돌리기 — undo(하나 또는 배열, 배열이면 뒤에서부터)
export function undoLog(log, undo) {
  const list = Array.isArray(undo) ? [...undo].reverse() : [undo];
  const recs = { ...(log?.recs || {}) };
  for (const u of list) {
    for (const [id, keys] of Object.entries(u?.prev || {})) {
      const cur = { ...(recs[id] || {}) };
      for (const [k, v] of Object.entries(keys)) { if (v) cur[k] = { ...v }; else delete cur[k]; }
      if (Object.keys(cur).length) recs[id] = cur; else delete recs[id];
    }
  }
  return { v: 1, recs };
}
// 정리 — 없어진 묶음(alive 가 거짓)·days 일 넘은 기록을 뺀다
export function pruneLog(log, alive = () => true, now = Date.now(), days = LOG_DAYS) {
  const ok = typeof alive === 'function' ? alive : (id => alive.has(id));
  const limit = now - days * 864e5;
  const recs = {};
  for (const [id, e] of Object.entries(log?.recs || {})) {
    if (!ok(id)) continue;
    const at = Math.max(Number(e?.k?.at) || 0, Number(e?.x?.at) || 0);
    if (at && at < limit) continue;
    recs[id] = e;
  }
  return { v: 1, recs };
}

// ---- 문구 ----
const md = d => { const [, m, dd] = String(d).split('-').map(Number); return `${m}/${dd}`; };
// '오늘 것' | '어제 것' | '10/19(월) 것' | '10/16~10/22'
export function rangeName(from, to, today) {
  if (from === to) {
    if (from === today) return '오늘 것';
    if (from === addDays(today, -1)) return '어제 것';
    return `${mdw(dayStart(from))} 것`;
  }
  return `${md(from)}~${md(to)}`;
}
// 주 버튼 첫 줄
export function goLabel({ from, to, today, picked = 0, resume = false } = {}) {
  if (resume) return '이어서 보내기';
  if (picked > 0) return `고른 ${picked}묶음 한번에 보내기`;
  return `${rangeName(from, to, today)} 한번에 보내기`;
}
// 주 버튼 아래 줄 — kakao/excel 은 pickToSend 결과(꺼 두면 null), parts = 카톡 나눔 횟수
export function goSub({ kakao = null, excel = null, parts = 0 } = {}) {
  if (!kakao && !excel) return '위에서 보낼 것을 켜요';
  const xl = excel ? (parts > 1 ? '사진대지' : '사진대지 엑셀') : '';
  if (kakao) {
    if (!kakao.recordIds?.length) return excel ? '카톡은 다 보냈어요 · 사진대지 엑셀' : '카톡은 다 보냈어요';
    if (!kakao.photoCount) return excel ? '글 → 사진대지 엑셀' : '글만 복사해요';
    return `카톡 ${kakao.photoCount}장${parts > 1 ? `(${parts}번)` : ''}·글${xl ? ` → ${xl}` : ''}`;
  }
  return `사진대지 엑셀 · ${Number(excel.photoCount) || 0}장`;
}
// 「보낼 것」 카드 오른쪽 글. on = 켜짐, picked = 고른 묶음 수
export function kindText(kind, { on = true, kakao = null, excel = null, lastKakaoAt = 0, from, to, today, picked = 0 } = {}) {
  if (!on) return '꺼 둠';
  if (kind === 'kakao') {
    const n = kakao?.recordIds?.length || 0, p = kakao?.photoCount || 0;
    if (picked) return `고른 ${n}묶음 · ${p ? `${p}장` : '글만'}`;
    if (!n) return lastKakaoAt ? `다 보냈어요 · ${hm(lastKakaoAt)}` : '보낼 게 없어요';
    return `새 ${n}묶음 · ${p ? `${p}장` : '글만'}`;
  }
  const n = excel?.recordIds?.length || 0;
  if (!n) return '보낼 게 없어요';
  if (!picked && excel.state === 'sent') return `${hm(excel.at)}에 보냄`;
  if (!picked && excel.state === 'changed') return '보낸 뒤 바뀜';
  const where = picked ? '고른' : from === to ? (from === today ? '오늘' : from === addDays(today, -1) ? '어제' : md(from)) : '기간';
  return `${where} ${n}묶음 · ${excel.photoCount}장`;
}

// 기간 빠른 칩 — 이번 주(월요일부터) · 지난주 · 이번 달
export const QUICK = Object.freeze(['thisweek', 'lastweek', 'thismonth']);
export function quickRange(kind, today) {
  const ws = weekStart(today);
  if (kind === 'lastweek') return { from: addDays(ws, -7), to: addDays(ws, -1) };
  if (kind === 'thismonth') return { from: `${String(today).slice(0, 8)}01`, to: today };
  return { from: ws, to: today };
}
export const quickOf = (from, to, today) => QUICK.find(k => { const r = quickRange(k, today); return r.from === from && r.to === to; }) || null;
