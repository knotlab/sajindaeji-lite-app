// 보냄 기록·내보내기 탭 기억·진행 중 보내기 — store meta 감싸기(앱 0.1.7 「한번에 보내기」).
//   meta sendLog    = 보냄 기록(core/sendplan.js 머리 주석의 모양) — 카톡·엑셀을 무엇까지 보냈나
//   meta exportPrefs = 탭 기억(보낼 것 켬/끔(하루·기간 따로)·엑셀 형식·다음 단계 저절로·보낸 묶음 펼침·마지막 공유 대상)
//   meta sendRun    = 진행 중 보내기(카톡에 다녀오는 사이 앱이 다시 켜지면 「이어서 보내기」 — 끝나거나 그만두면 지움)
// 읽기는 동기(store 캐시), 쓰기는 이 모듈 안에서 줄 세운다(읽고-고치고-쓰기가 겹쳐 기록이 사라지지 않게).
// meta 는 백업 JSON·미러에 들어가지 않는다 — 다시 설치하거나 복원하면 모두 「안 보냄」으로 보인다(받아들임, SPEC 에 한 줄).
import * as store from './store.js';
import { markLog, clearLog, undoLog, pruneLog, mergePrefs } from '../core/sendplan.js';

const K_LOG = 'sendLog', K_PREFS = 'exportPrefs', K_RUN = 'sendRun';
let tail = Promise.resolve();
function queue(fn) {
  const p = tail.then(fn);
  tail = p.then(() => {}, () => {});
  return p;
}
const meta = (k, d) => { try { return store.meta(k, d); } catch { return d; } };
const alive = id => { try { return !!store.record(id); } catch { return true; } };

// ---- 보냄 기록 ----
export function log() {
  const v = meta(K_LOG, null);
  return v && v.v === 1 && v.recs && typeof v.recs === 'object' ? v : { v: 1, recs: {} };
}
// → 되돌리기 표(undo) — undo(표) 로 그 표시만 거둔다
export function mark({ kind, entries = [], at = Date.now() } = {}) {
  return queue(async () => {
    if (!entries.length) return null;
    const { log: next, undo } = markLog(log(), { kind, entries, at });
    await store.setMeta(K_LOG, pruneLog(next, alive, at));
    return undo;
  });
}
// 표 하나 또는 여러 개(배열 — 뒤에서부터 거둔다)
export function undo(token) {
  return queue(async () => {
    if (!token || (Array.isArray(token) && !token.length)) return;
    await store.setMeta(K_LOG, undoLog(log(), token));
  });
}
// 보냄 표시 지우기(⋮ 「이 날 보냄 표시 지우기」) — kind 가 없으면 카톡·엑셀 둘 다 → 되돌리기 표
export function clear(recordIds = [], kind = null) {
  return queue(async () => {
    const { log: next, undo } = clearLog(log(), recordIds, kind);
    if (!Object.keys(undo.prev).length) return null;
    await store.setMeta(K_LOG, next);
    return undo;
  });
}

// ---- 탭 기억 ----
export const prefs = () => mergePrefs(meta(K_PREFS, null));
export function setPrefs(patch = {}) {
  return queue(async () => {
    const cur = prefs();
    const next = mergePrefs({
      ...cur, ...patch,
      kinds: { day: { ...cur.kinds.day, ...patch.kinds?.day }, period: { ...cur.kinds.period, ...patch.kinds?.period } },
      lastTarget: { ...cur.lastTarget, ...patch.lastTarget },
    });
    await store.setMeta(K_PREFS, next);
    return next;
  });
}

// ---- 진행 중 보내기 ----
export function savedRun() {
  const v = meta(K_RUN, null);
  return v && v.v === 1 && v.id ? v : null;
}
export function saveRun(run) { return queue(() => store.setMeta(K_RUN, run ? { ...run, v: 1 } : null)); }
// 시험용 — 줄 선 쓰기가 끝날 때까지
export const idle = () => tail;
