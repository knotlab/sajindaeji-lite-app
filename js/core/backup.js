// 백업 JSON 형식과 합치기 규칙 — 순수 함수(설계서 §5.2·§4.5). 원본 core/backup.js 를 lite 형식으로.
// 같은 JSON 을 쓰는 곳: 수동 백업 ZIP 의 backup.json(backupio, D) · 자동 파일/localStorage 백업·미러(safety, B)
import { ymd, hm } from './date.js';

export const BACKUP_FORMAT = 'sajindaeji-lite-backup';
export const BACKUP_VERSION = 1;

// 백업 파일은 카톡·클라우드로 나간다 — VWorld 키는 싣지 않는다. 받은 settings 객체는 고치지 않고 복사본에서 뺀다
const OMIT_SETTINGS = ['vworldKey'];
const cleanSettings = s => {
  if (!s || typeof s !== 'object') return {};
  const o = { ...s };
  for (const k of OMIT_SETTINGS) delete o[k];
  return o;
};

// records·photos 에는 휴지통(deletedAt) 항목도 그대로 넣는다(설계 비평: 휴지통·설정·lastLocation 도 백업)
// → { format, version, at, appVersion, installId, counts: { records, photos, live }, records, photos, settings, lastLocation }
export function makeBackupJson({ records = [], photos = [], settings = {}, now = Date.now(), appVersion = '', installId = '', lastLocation = null } = {}) {
  return {
    format: BACKUP_FORMAT, version: BACKUP_VERSION, at: now, appVersion, installId,
    counts: { records: records.length, photos: photos.length, live: records.filter(r => !r.deletedAt).length },
    records, photos, settings: cleanSettings(settings), lastLocation: lastLocation ?? null,
  };
}

// 문자열·객체 모두 받는다. → { records, photos, settings, lastLocation, at, installId, appVersion, version } | throws(한국어)
export function parseBackupJson(input) {
  let o;
  try { o = typeof input === 'string' ? JSON.parse(input) : input; } catch { throw new Error('백업 파일을 읽지 못했어요(JSON 아님)'); }
  if (!o || typeof o !== 'object' || o.format !== BACKUP_FORMAT) throw new Error('이 앱의 백업 파일이 아니에요');
  if (!(o.version >= 1)) throw new Error('백업 파일이 손상됐어요');
  if (o.version > BACKUP_VERSION) throw new Error('더 새 버전 앱의 백업이에요. 앱을 업데이트해 주세요');
  const ok = list => Array.isArray(list) && list.every(x => x && typeof x === 'object' && typeof x.id === 'string' && x.id);
  if (!ok(o.records) || !ok(o.photos)) throw new Error('백업 파일이 손상됐어요');
  for (const r of o.records) if (!Array.isArray(r.photoIds)) throw new Error('백업 파일이 손상됐어요');
  return {
    records: o.records, photos: o.photos, settings: cleanSettings(o.settings), lastLocation: o.lastLocation ?? null,
    at: Number.isFinite(o.at) ? o.at : 0, installId: o.installId || '', appVersion: o.appVersion || '', version: o.version,
  };
}

const num = v => (Number.isFinite(v) ? v : 0);   // 없는 값·이상한 값은 0 — 비교가 한쪽으로 쏠리지 않게
// 이길 쪽을 돌려준다: rev 큰 쪽 → 같으면 updatedAt 늦은 쪽 → 그래도 같으면 지금 것(cur). 한쪽이 없으면 있는 쪽.
// 고치지 않고 받은 객체 그대로 돌려준다(저장소가 참조 비교로 바뀐 것만 쓴다)
export function mergeRecord(cur, inc) {
  if (!cur) return inc ?? null;
  if (!inc) return cur;
  if (num(inc.rev) !== num(cur.rev)) return num(inc.rev) > num(cur.rev) ? inc : cur;
  return num(inc.updatedAt) > num(cur.updatedAt) ? inc : cur;
}

// 사진 메타: 지금 것이 ready 가 아니고 들어온 것이 ready 면 들어온 것, 그 밖에는 지금 것(사진은 rev 가 없다)
export function mergePhoto(cur, inc) {
  if (!cur) return inc ?? null;
  if (!inc) return cur;
  return cur.state !== 'ready' && inc.state === 'ready' ? inc : cur;
}

// 설정·lastLocation 은 이 기기의 값이 비어 있을 때만 채운다(원본 restoreRecords 규칙)
export function mergeSettings(cur = {}, inc = {}) {
  const out = { ...(cur || {}) };
  for (const [k, v] of Object.entries(cleanSettings(inc))) {
    if (out[k] === undefined || out[k] === null || out[k] === '') out[k] = v;
  }
  return out;
}

// 목록 합치기 → { list, report: { added, updated, kept } }
export function mergeList(cur = [], inc = [], pick = mergeRecord) {
  const map = new Map(cur.map(x => [x.id, x]));
  const report = { added: 0, updated: 0, kept: 0 };
  for (const x of inc) {
    const a = map.get(x.id);
    if (!a) { map.set(x.id, x); report.added++; continue; }
    const w = pick(a, x);
    if (w !== a) { map.set(x.id, w); report.updated++; } else report.kept++;
  }
  return { list: [...map.values()], report };
}

// 줄어듦 방지(공시체 K_BAK2): 새 백업의 살아 있는 묶음 수가 직전 좋은 백업보다 적으면 true → 덮지 말고 이전 세대를 따로 남긴다
export const liveCount = b => (Number.isFinite(b?.counts?.live) ? b.counts.live : (b?.records || []).filter(r => !r.deletedAt).length);
export const isShrink = (next, prevGood) => !!prevGood && liveCount(next) < liveCount(prevGood);
// 여러 백업 중 가장 좋은 것: 살아 있는 묶음이 많은 쪽 → 같으면 나중 것
export const pickBest = list => (list || []).reduce((b, x) => (!b || liveCount(x) > liveCount(b) || (liveCount(x) === liveCount(b) && num(x.at) > num(b.at)) ? x : b), null);

// localStorage 두 칸(현재·직전) 돌리기 — 공시체 K_BAK2. 가장 좋은 세대가 늘 한 칸에 남게 한다.
//   현재는 늘 새 백업. 직전 칸은 「날이 바뀜」 또는 「새 것이 줄어듦」일 때 현재로 밀되, 직전이 현재보다 크면 그대로 둔다.
// → { cur, prev, pushed } (prev 는 남길 객체, pushed 는 현재를 직전으로 밀었는지)
export function rotateLocal({ cur = null, prev = null, next, today }) {
  const out = { ...next, day: today };
  if (!cur) return { cur: out, prev, pushed: false };
  const best = Math.max(liveCount(cur), prev ? liveCount(prev) : 0);
  const shrink = liveCount(next) < best;
  const prevBetter = !!prev && liveCount(prev) > liveCount(cur);
  if ((cur.day !== today || shrink) && !prevBetter) return { cur: out, prev: cur, pushed: true };
  return { cur: out, prev, pushed: false };
}

// '사진대지lite-백업-YYYYMMDD-HHmm.zip'
export const backupName = (now = Date.now()) => `사진대지lite-백업-${ymd(now)}-${hm(now).replace(':', '')}.zip`;
