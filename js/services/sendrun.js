// 한번에 보내기 진행 — 화면 밖 상태(탭을 오가도, 카톡에 다녀와도 이어진다). 앱 0.1.7
// 흐름(reference/parts/v017.md ## export ③ · ## check §1.3):
//   [한번에] → 처리 중 사진은 최대 4초 기다림(남으면 빼고 알림) → 글 복사 → meta sendRun 저장 → 첫 카톡 묶음이 구워지면 공유 창
//   (이 탭이 보일 때만 — 다른 화면이면 탭 배지, 돌아와 누를 때 연다) → 공유가 끝나면 넘긴 사진을 「보냄」으로(sendlog)
//   → 앱: 다시 보인 때부터 2초 막대 뒤 다음 단계를 저절로(만지면 멈춤, ⋮ 에서 끔) · 웹: 단계마다 1탭(공유 창은 사용자 탭 안에서만)
//   → 사진대지 엑셀(카톡 묶음을 다 구운 뒤 뒤에서 만든다 — 사용자가 카톡에 가 있는 동안) → 끝: 「보냄으로 표시했어요 [되돌리기]」
//   (앱이 뒤에 있을 때 끝나면 — 카톡을 고르는 순간 공유 약속이 풀리는 기기 — 그 스낵바는 앱이 다시 보일 때 띄우고 거기서 5초를 센다)
// 고장 고침(0.1.7 완료 기준): [그만] = 남은 굽기·엑셀·단계 모두 멈춤(공유 창이 떠 있을 때 눌러도 돌아와서 다음 단계 없음) ·
//   공유 취소 = 주의 모양 「취소했어요 · 다시 누르면 열려요」(저절로 이어서는 끔) · 두 일이 서로 막지 않는다(엑셀은 같은 줄 뒤에서).
// 굽기: 카톡 묶음은 차례로 굽고, 앱은 굽는 대로 CACHE sendrun/<id>/<단계>/ 에 쓴다(다음 장을 굽는 동안 앞 장을 쓴다).
//   파일 이름(MMDD_<위치>_<n>.jpg)은 보내기 전체에서 한 번 매기고(ZIP 사진 이름처럼 1..n 이어서) 단계마다 폴더를 나눈다 —
//   1/n 공유 창이 떠 있는 사이 뒤에서 2/n 을 같은 경로에 써 카톡이 엉뚱한 사진을 읽던 것(검토 blocker: 같은 위치 글 묶음이 두 공유에 걸치면 이름이 겹쳤다).
//   촬영 화면이 열려 있거나 글을 쓰는 중이면 쉰다(셔터·글자 지연을 되살리지 않게). 다른 화면(홈·묶음 상세)을 보는 중이면 장마다 한가할 때만
//   (사진 칸·목록이 손가락 스크롤을 메인 스레드에서 받는다), 내보내기 탭이 보이거나(사용자가 기다리는 중) 카톡에 가 있으면(앱이 뒤) 쉬지 않고 굽는다(A4).
//   웹은 공유 한 번 분량만 앞서 굽는다(File 이 구운 그림을 붙잡는다 — 기간 300장이면 메모리가 모자란다), 앱은 디스크라 다 굽는다.
//   끝난 보내기의 CACHE 폴더는 10분 뒤 지운다(받는 앱이 다 읽은 뒤 — 부팅 때 정리만으로는 앱이 며칠 살아 있으면 쌓였다).
// 미리 굽기(warm): 탭이 보이고 0.8초 뒤, 한가할 때 첫 카톡 묶음만 메모리에(만지면 쉰다). CACHE 쓰기(브리지)는 [한번에] 뒤에.
//   탭을 떠나 30초가 지나거나 앱이 뒤로 가면 비운다(보내는 중이 아니면 구운 그림 캐시도 — 묶음 상세 [공유]가 남긴 것까지).
// 이어서 보내기: 지난 실행이 남긴 meta sendRun 은 adoptSaved() 가 맡는다(동기 — 부팅 훅·내보내기 탭을 열 때·[한번에]·[이어서]·[그만두기] 맨 앞).
//   공유 창을 연(sharing) 단계는 넘긴 것으로 적는다(Capacitor 공유는 고르기만 해도 성공으로 돌아온다 — [되돌리기]·⋮ 로 거둔다).
//   남은 단계가 있고 2시간 안이면 「이어서 보내기」, 없으면 끝(넘긴 것이 있으면 「보냄으로 표시했어요 [되돌리기]」). 부팅 훅 타이밍에 기대지 않는다
//   (검토 major: 마지막 단계가 sharing 인 채 다시 켜지거나, 다시 켜진 직후 [한번에]·[그만두기]를 누르면 넘긴 사진·엑셀이 「보낼 것」으로 돌아와 또 갔다).
// 부팅 훅(메인 app.js): resume() — 위 adoptSaved + 탭 배지(meta 만 읽는다) + 지난 실행의 sendrun/ 정리.
import * as store from '../data/store.js';
import * as sendlog from '../data/sendlog.js';
import * as sp from '../core/sendplan.js';
import * as N from '../platform/native.js';
import * as render from '../media/render.js';
import * as exporter from './exporter.js';
import * as config from '../config.js';
import { composeText } from './sendflow.js';
import { downloadBlob, webShareFiles } from './share.js';
import { photoFileNames } from '../core/ledger.js';
import { dayKey } from '../core/date.js';
import { wmOpts } from '../core/watermark.js';

const C = (k, d) => (Number.isFinite(config[k]) ? config[k] : d);
export const MAX_SHARE = C('MAX_SHARE_PHOTOS', 20);             // 앱 공유 한 번(실기기 확인 뒤 30 — 3단계)
export const WEB_FILES = C('WEB_SHARE_FILES', 10);              // 크롬 Web Share 한도
export const WEB_BYTES = C('WEB_SHARE_BYTES', 50 * 1024 * 1024);
export const AUTO_NEXT_MS = C('AUTO_NEXT_MS', 2000);
export const PREBAKE_DELAY_MS = C('PREBAKE_DELAY_MS', 800);
export const BIG_MB = C('EXPORT_BIG_MB', 25);
const RUN_MAX_AGE = 2 * 3600e3;                                 // 이보다 오래된 「이어서 보내기」는 버린다(넘긴 단계는 그래도 적는다)
const WARM_DROP_MS = 30000;
const PENDING_WAIT_MS = 4000;
const WRITE_PAR = 3;                                            // 앱: 공유 파일 쓰기 동시에(브리지 왕복이 겹치게)
const CLEAN_AFTER_MS = 10 * 60e3;                               // 끝난 보내기의 CACHE 폴더를 지우기까지(받는 앱이 다 읽을 시간)
const SNACK_MAX_AGE = 10 * 60e3;                                // 앱이 뒤에 있을 때 끝난 보내기의 스낵바 — 이보다 늦게 돌아오면 띄우지 않는다
const REBUILD_MAX = 3;                                          // 엑셀을 만든 뒤 바뀌어 다시 만들기 — 한 단계에 이만큼까지(서명이 끝내 안 맞아도 멈추지 않게)
const WEB_AHEAD = 2;                                            // 웹: 구워 둔 채 아직 안 넘긴 카톡 사진 ≤ 공유 한 번 분량 × 이만큼

const T = {};                                                   // 시험(dev·e2e 전용): { native, share, copy, bake, put, autoMs, visible, per }
export function _test(f = {}) { Object.assign(T, f); return T; }
const sleep = ms => new Promise(r => setTimeout(r, ms));
const yieldNow = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise(r => setTimeout(r, 0)));
const lite = () => globalThis.__lite || {};
const isApp = () => { if (typeof T.native === 'boolean') return T.native; try { return !!N.isNative(); } catch { return false; } };
const docVisible = () => (typeof T.visible === 'function' ? T.visible() : (typeof document === 'undefined' || document.visibilityState !== 'hidden'));
const where = () => { try { return lite().router?.currentName?.() ?? 'exporthub'; } catch { return null; } };
export const hubVisible = () => where() === 'exporthub' && docVisible();
const typing = () => { try { return !!lite().dom?.isTyping?.(); } catch { return false; } };
const noShare = () => !isApp() && !T.share && (typeof navigator === 'undefined' || !navigator.share || !navigator.canShare);
const errText = e => (e?.code === 'QUOTA' || /quota|space|ENOSPC/i.test(String(e?.message || '')) ? '저장 공간이 부족해요' : e?.message || String(e || '알 수 없는 오류'));
const fmtMB = n => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.max(1, Math.round((n || 0) / 1e3))}KB`);
const tell = (fn, ...a) => { try { return fn?.(...a); } catch (e) { console.error(e); return undefined; } };

// 화면 알림(토스트·스낵바)은 dom 을 늦게 연다 — node 시험·부팅에서 화면 모듈을 끌어오지 않게
let domP = null;
const ui = async (name, ...a) => { try { domP ||= import('../ui/dom.js'); const d = await domP; return d[name]?.(...a); } catch (e) { console.warn(e); return undefined; } };

// ---- 고르기 재료 ----
const readyOf = r => (store.photosOf(r.id) || []).filter(p => p.state === 'ready');
const pendingOf = r => (store.photosOf(r.id) || []).filter(p => p.state !== 'ready' && p.state !== 'failed').length;
// 현장명·워터마크 설정(묶음 서명) + 위치도 핀 서명(exporter.pinSigOf — 도면보관함이 안 열렸으면 null 이라 견주지 않는다)
function envOf() {
  const s = store.settings();
  const o = wmOpts(s);
  return { site: s.siteName || '', wm: `${o.mode}|${o.when}`, pinSig: typeof exporter.pinSigOf === 'function' ? r => exporter.pinSigOf(r) : null };
}
// 그 기간 묶음 — 사진대지 순서(날짜 오름차순 → 그 날 순서). recordsOfDay 가 그 날 순서를 준다(core/order.js)
export function recordsIn(from, to) {
  if (!from || !to) return [];
  if (from === to) return [...(store.recordsOfDay(from) || [])];
  const days = (store.days?.() || []).map(d => d.day).filter(d => d >= from && d <= to).sort();
  return days.flatMap(d => store.recordsOfDay(d) || []);
}

// ---- 계획 ---- 화면이 그릴 때마다 부른다(동기, 캐시만 읽음)
// → { from, to, today, ids, kinds, records, env, native, per, kakao, excel, states, todo, sent, empty, seq, sheet, lastKakaoAt, kParts, steps, format }
export function plan({ from, to, ids = null, kinds = null, today = dayKey(Date.now()) } = {}) {
  const pr = sendlog.prefs();
  const k = { ...(kinds || pr.kinds[sp.modeOf(from, to)]) };
  const records = recordsIn(from, to);
  const env = envOf();
  const pick = sp.pickToSend({ records, readyOf, pendingOf, log: sendlog.log(), kinds: k, ids, env, rg: `${from}~${to}` });
  const native = isApp();
  const per = T.per > 0 ? T.per : native ? MAX_SHARE : WEB_FILES;
  const rows = pick.kakao?.rows || [];
  const kParts = !rows.length ? [] : noShare() ? [rows] : sp.splitShare(rows, per);
  const excel = pick.excel?.recordIds?.length ? pick.excel : null;
  return { from, to, today, ids: ids ? [...ids] : null, kinds: k, records, env, native, per, ...pick, kParts,
    steps: sp.stepsOf({ kakaoParts: kParts, excel }), format: pr.excelFormat };
}
const textOf = p => {
  const recs = (p.kakao?.recordIds || []).map(id => store.record(id)).filter(Boolean);
  if (!recs.length) return '';
  const n = new Map();
  for (const r of p.kakao.rows) n.set(r.recordId, (n.get(r.recordId) || 0) + 1);
  const siteName = store.settings().siteName || recs.find(r => r.site)?.site || '';
  return composeText(recs, { siteName, from: p.from, to: p.to, photoCount: r => n.get(r.id) || 0, more: p.kakao.more, seqOf: r => p.seq.get(r.id) });
};
export const textFor = p => textOf(p);

// ---- 진행 상태 ----
// Run = { id, at, plan, steps, copied, text, textOnly, names, phase: 'prep'|'running'|'done'|'stopped', noAuto, marks, dir, notice, pending, left, ... }
// step = { key, kind, part, parts, n, rows, state: 'wait'|'ready'|'sharing'|'done'|'fail'|'skip', done, total, bytes, items, file, scope, error, failAt, at, openAt }
let R = null, saved = null;
const subs = new Set();
export const current = () => R;
export const resumable = () => (R ? null : saved);
export function on(fn) { subs.add(fn); return () => { subs.delete(fn); }; }
let emitQ = false;
function emit(now = false) {
  badge();
  if (now) { emitQ = false; for (const fn of [...subs]) tell(fn, R); return; }
  if (emitQ) return;
  emitQ = true;
  queueMicrotask(() => { if (!emitQ) return; emitQ = false; for (const fn of [...subs]) tell(fn, R); });
}
const dead = run => !run || run !== R || run.phase !== 'running';
const curStep = run => run?.steps.find(s => s.state !== 'done' && s.state !== 'skip') || null;
export const step = () => curStep(R);
const allDone = run => run.steps.every(s => s.state === 'done' || s.state === 'skip');
export const activeDir = () => (R?.dir || saved?.dir || null);
// 생산자 깨우기(웹 앞서 굽기 기다림)
const wake = run => { const f = run?.wake; if (f) { run.wake = null; f(); } };

// 탭 배지 — 진행 중인 단계가 사용자 손을 기다리는데 내보내기 탭이 안 보일 때, 또는 「이어서 보내기」가 남았을 때 1
let badgeN = -1;
function badge() {
  let n = 0;
  if (saved && !R) n = 1;
  else if (R && R.phase === 'running' && !hubVisible()) { const s = curStep(R); if (s && (s.state === 'ready' || s.state === 'fail')) n = 1; }
  if (n === badgeN) return;                                      // 진행 알림마다 DOM 을 건드리지 않게
  badgeN = n;
  try { lite().tabs?.setBadge?.('exporthub', n); } catch { /* 탭 막대 없음 */ }
}

// meta sendRun — 앱이 카톡에 가 있는 사이 다시 켜져도 이어 가게(구운 파일은 다시 굽는다).
//   공유 창을 연 단계는 그때 시각(at)을, 엑셀 단계는 만든 엑셀의 묶음 범위(scope — 다시 켜진 뒤 그 엑셀을 「보냄」으로 적을 재료)를,
//   글만 묶음(textOnly — 첫 카톡 묶음과 함께 적는다)도 싣는다
const scopeOut = sc => ({ ids: sc.ids, sigs: sc.ids.map(id => sc.sigs.get(id) ?? null), set: sc.set || '', rg: sc.rg || '', ...(sc.pins ? { pins: sc.ids.map(id => sc.pins.get(id) ?? '') } : {}) });
const scopeIn = o => {
  const ids = Array.isArray(o?.ids) ? o.ids : [];
  return { ids, sigs: new Map(ids.map((id, i) => [id, o.sigs?.[i] ?? null])), set: o?.set || '', rg: o?.rg || '', pins: Array.isArray(o?.pins) ? new Map(ids.map((id, i) => [id, o.pins[i] ?? ''])) : null, key: '' };
};
function slim(run) {
  return {
    id: run.id, at: run.at, from: run.plan.from, to: run.plan.to, ids: run.plan.ids, kinds: run.plan.kinds, format: run.plan.format,
    steps: run.steps.map(s => ({
      key: s.key, kind: s.kind, part: s.part, parts: s.parts, rows: (s.rows || []).map(r => [r.recordId, r.photoId]), state: s.state, at: s.at || s.openAt || 0,
      ...(s.kind === 'excel' && s.scope?.ids ? { scope: scopeOut(s.scope) } : {}),
    })),
    textOnly: run.textOnly || [], dir: run.dir, copied: run.copied, text: run.text,
  };
}
const persist = run => { if (run && run === R) sendlog.saveRun(slim(run)).catch(e => console.warn('보내기 진행 저장 실패', e)); };

// 파일 이름 — 보내기 전체에서 한 번(같은 날·같은 위치끼리 1..n 이어서 — ZIP 사진 이름과 같은 규칙). → Map(photoId → 이름)
function runNames(rows, day) {
  const list = rows || [];
  const recOf = id => store.record(id) || { day, location: '' };
  const names = photoFileNames(list.map(x => ({ record: recOf(x.recordId), photo: { id: x.photoId } })));
  return new Map(list.map((x, i) => [x.photoId, names[i]]));
}

// ---- 굽기 ----
// render.exportSet(full) — 한 번 굽고 캐시(사진·워터마크 글이 같으면 다시 굽지 않는다, 최대 40장). 미리 굽기도 같은 캐시를 채우고,
//   엑셀(exporter.build)은 카톡 굽기가 남긴 full 을 줄여 쓴다(담당 3 — 같은 구운 사진). exportSet 이 없는 판이면 exportJpeg
let W = null, warmSeq = 0;
async function bakeBytes(photoId) {
  if (T.bake) return T.bake(photoId);
  if (typeof render.exportSet === 'function') { const s = await render.exportSet(photoId, { full: true }); if (s?.full) return s.full; }
  return render.exportJpeg(photoId);
}
const sizeOf = b => (Number.isFinite(b?.size) ? b.size : b?.byteLength ?? b?.length ?? 0);   // Blob(exportSet) | Uint8Array(exportJpeg)
// 촬영 화면·글 입력 중이면 쉰다(그동안 굽지 않는다). 다른 화면을 보는 중이면 만지는 동안 쉰다(한가할 때 한 장씩) —
//   0.1.7 에서 묶음 상세 사진 칸이 끌기 때문에 비수동 touchmove 자리가 되어, 그 메인 일이 곧 스크롤 시작 지연이 됐다(검토: 보내는 중 최대 67ms).
//   내보내기 탭이 보이면(기다리는 중) · 앱이 뒤면(카톡에 가 있음) 그대로 굽는다
async function hold(run) {
  while (!dead(run) && (where() === 'capture' || typing())) await sleep(400);
  if (!dead(run) && !appAway && docVisible() && !hubVisible() && typeof N.whenQuiet === 'function') {
    try { await N.whenQuiet({ quietMs: 600, maxMs: 15000 }); } catch { /* 그냥 굽는다 */ }
  }
}
// 한 장을 쓴다 — 앱: CACHE sendrun/<id>/<단계>/<이름>(단계마다 폴더 — 같은 경로를 두 번 쓰지 않는다), 웹: File
async function put(run, st, name, bytes, row) {
  const path = `${run.dir}/${st.part}/${name}`;
  if (T.put) return T.put({ run, name, bytes, row, path, step: st.key });
  const size = sizeOf(bytes);
  if (isApp()) {
    const uri = typeof N.writeShareFile === 'function' ? await N.writeShareFile(path, bytes) : await N.writeCache(path, bytes);   // 담당 3: 브리지 조각만(임시 이름·getUri 없음)
    return { name, size, uri, photoId: row.photoId, recordId: row.recordId };
  }
  return { name, size, file: new File([bytes], name, { type: 'image/jpeg' }), photoId: row.photoId, recordId: row.recordId };
}
async function bakeStep(run, st) {
  let fall = null;                                               // 이름표에 없는 사진(그럴 일은 없다 — 이 단계 안에서만 매긴다)
  const nameOf = (row, i) => run.names?.get(row.photoId)
    || (fall ||= photoFileNames(st.rows.map(x => ({ record: store.record(x.recordId) || { day: run.plan.from, location: '' }, photo: { id: x.photoId } }))))[i];
  st.done = 0; st.total = st.rows.length; st.state = 'wait'; st.error = null; st.writeErr = null; emit();
  // 굽기는 한 장씩(메인·워커), 쓰기(앱 브리지)는 굽는 동안 앞 장들을 — 최대 WRITE_PAR 장 동시에(브리지 왕복 지연을 겹친다. 첫 장은 혼자 — 폴더를 만든다)
  const items = new Array(st.rows.length).fill(null);
  const inflight = new Set();
  let skipped = 0;
  const write = (i, bytes, row) => {
    const p = put(run, st, nameOf(row, i), bytes, row).then(it => { items[i] = it; }, e => { console.warn('보낼 사진을 쓰지 못했어요', e); skipped++; st.writeErr = e; })
      .finally(() => inflight.delete(p));
    inflight.add(p);
    return p;
  };
  for (const [i, row] of st.rows.entries()) {
    await hold(run);
    if (dead(run)) return;
    let bytes = null;
    try { bytes = await bakeBytes(row.photoId); }
    catch (e) { console.warn('보낼 사진을 만들지 못했어요', row.photoId, e); skipped++; }
    if (dead(run)) return;
    if (bytes) {
      const first = write(i, bytes, row);
      if (i === 0) await first;
      while (inflight.size >= WRITE_PAR) await Promise.race(inflight);
    }
    st.done++; emit();
    await yieldNow();
  }
  await Promise.all(inflight);
  if (dead(run)) return;
  st.items = items.filter(Boolean); st.skipped = skipped; st.bytes = st.items.reduce((n, it) => n + it.size, 0);
  if (st.items.length) { st.state = 'ready'; st.n = st.items.length; }
  else { st.state = 'fail'; st.failAt = 'make'; st.error = st.writeErr ? errText(st.writeErr) : '사진을 만들지 못했어요'; }
  emit();
  if (st.state === 'ready') ready(run, st);
}
// 웹: 구워 두고 아직 안 넘긴(준비됨·공유 중) 카톡 사진이 공유 한 번 분량 × 2 를 넘으면 앞 묶음을 넘길 때까지 기다린다. 앱은 디스크라 기다리지 않는다
async function aheadGate(run, st) {
  if (isApp()) return;
  const cap = Math.max(1, Number(run.plan.per) || WEB_FILES) * WEB_AHEAD;
  for (;;) {
    if (dead(run) || st.state !== 'wait') return;
    const held = run.steps.reduce((n, x) => n + (x !== st && x.kind === 'kakao' && (x.state === 'ready' || x.state === 'sharing') ? (x.items?.length || 0) : 0), 0);
    if (!held || held + (st.rows?.length || 0) <= cap) return;
    await new Promise(r => { run.wake = r; setTimeout(r, 1000); });
  }
}
// 엑셀 — 담당 3: exporter.plan(…) → { records, format, sig } · exporter.build({ from, to, recordIds, format:'auto'|'zip', withPhotos, signal, hold }) → { name, size, blob|uri, path, format, sig, reused? }
//   같은 서명이면 build 가 만들어 둔 파일을 다시 쓴다(⋮ 「사진대지만 보내기」 다시 — 안 바뀌었으면 바로). 사진마다 hold(촬영 화면·글 입력이면 쉰다), signal(그만)
// 범위(scope): 그 엑셀에 드는 묶음 id(사진대지 순서) + 묶음마다 보냄 서명(sendLog x — 「보낸 뒤 바뀜」) + 한 벌 서명 key(만든 뒤 바뀌었나 — check §1.3-5)
//   + 묶음 목록 서명 set·기간 rg(그 뒤 묶음이 빠지면 「보낸 뒤 바뀜」) + 위치도 핀 서명 pins(도면보관함이 열려 있을 때)
function excelScope(run) {
  const p = run.plan;
  const zip = p.format === 'zip';
  let xp = null;
  try { xp = exporter.plan({ from: p.from, to: p.to, recordIds: p.ids, format: zip ? 'zip' : 'auto', withPhotos: zip }); } catch { xp = null; }
  const ids = xp?.records?.map(r => r.id) || (p.sheet || []).map(r => r.id);
  const env = envOf();
  const recs = ids.map(id => store.record(id)).filter(Boolean);
  const sigs = new Map(recs.map(r => [r.id, sp.excelSig(r, readyOf(r).map(x => x.id), env)]));
  const key = xp?.sig || `${p.from}|${p.to}|${p.ids ? p.ids.join(',') : '*'}|${p.format}|${ids.map(id => sigs.get(id)).join(',')}`;
  return { ids, sigs, key, set: sp.setSig(ids), rg: `${p.from}~${p.to}`, pins: pinMap(ids) };
}
// 묶음마다 위치도 핀 서명 — 도면보관함을 아직 안 열었으면 null(보낸 뒤 견주지 않는다)
function pinMap(ids) {
  if (typeof exporter.pinSigOf !== 'function') return null;
  const m = new Map();
  for (const id of ids) { const v = exporter.pinSigOf(store.record(id)); if (v == null) return null; m.set(id, v); }
  return m;
}
async function buildExcel(run, st) {
  await hold(run);
  if (dead(run)) return;
  const p = run.plan;
  const sc = excelScope(run);
  st.scope = sc; st.state = 'wait'; st.done = 0; st.total = 0; st.error = null; st.file = null; emit();
  const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
  run.excelCtrl = ctrl;
  try {
    const zip = p.format === 'zip';
    const res = await exporter.build({ from: p.from, to: p.to, recordIds: p.ids, format: zip ? 'zip' : 'auto', withPhotos: zip, signal: ctrl?.signal, hold: () => hold(run) },
      (d, t) => { if (run.excelCtrl !== ctrl) return; st.done = d; st.total = t; emit(); });
    if (dead(run) || ctrl?.signal.aborted) return;
    st.file = res; st.bytes = res.size || 0; st.state = 'ready';
    st.scope = { ...sc, ...(res.sig ? { key: res.sig } : {}), pins: pinMap(sc.ids) };   // 만든 그때의 서명(그새 바뀌었으면 보내기 직전에 다시 만든다)·위치도 핀(만들며 도면보관함이 열렸다)
  } catch (e) {
    if (dead(run) || ctrl?.signal.aborted) return;
    console.warn('사진대지 만들기 실패', e);
    st.state = 'fail'; st.failAt = 'make'; st.error = errText(e);
  } finally { if (run.excelCtrl === ctrl) run.excelCtrl = null; }
  emit();
  if (st.state === 'ready') ready(run, st);
}
// 생산자 하나 — 단계 순서대로(카톡 묶음 → 엑셀). 그만·끝나면 멈춘다.
//   도는 중에 다시 부르면(엑셀을 만든 뒤 바뀌어 다시 만들기·[다시]) 버리지 않고 한 바퀴 더 돈다 — 검토 major: 그 부름이 버려져 엑셀이 「만드는 중」에서 영영 멈췄다
async function produce(run) {
  if (run.producing) { run.again = true; return; }
  run.producing = true;
  try {
    do {
      run.again = false;
      for (const st of run.steps) {
        if (dead(run)) return;
        if (st.state !== 'wait') continue;
        if (st.kind === 'kakao') {
          await aheadGate(run, st);
          if (dead(run)) return;
          if (st.state !== 'wait') continue;
          await bakeStep(run, st);
        } else await buildExcel(run, st);
      }
    } while (run.again && !dead(run));
  } catch (e) { console.error('보내기 준비 실패', e); }
  finally { run.producing = false; }
}

// 단계가 준비됨 — 지금 차례이고, 방금 [한번에]·[이어서]를 눌렀으면(tapOpen) 이 탭이 보일 때 바로 연다. 아니면 저절로 규칙(앱) · 배지
function ready(run, st) {
  if (dead(run) || curStep(run) !== st) return;
  if (run.tapOpen) {
    if (hubVisible()) { run.tapOpen = false; open(run, st, 'first'); return; }
    run.tapOpen = false;
    if (where() !== 'capture') ui('toast', '보낼 것이 준비됐어요 — 내보내기 탭에서 보내요', 3000);   // 촬영 중에는 셔터 둘레를 가리지 않는다(배지만)
    emit();
    return;
  }
  tryAuto(run);
}

// ---- 공유 ----
async function copy(text) {
  if (!text) return false;
  try { return T.copy ? !!(await T.copy(text)) : !!(await N.copyText(text)); } catch { return false; }
}
async function shareKakao(run, st) {
  const title = st.parts > 1 ? `사진 보내기 (${st.part}/${st.parts})` : '사진 보내기';
  const extra = run.copied || !run.text ? {} : { text: run.text };   // 복사가 안 됐을 때만 공유에 글을 싣는다(카톡은 여러 장이면 글을 흘린다)
  if (T.share) return T.share({ kind: 'kakao', step: st.key, items: st.items, title, ...extra });
  if (isApp()) {
    const r = await N.shareFiles(st.items.map(it => it.uri), { title, ...extra });
    return r.ok ? { ok: true, where: 'share', target: r.target } : r;
  }
  const files = st.items.map(it => it.file);
  if (!noShare()) {
    const r = await webShareFiles(files, extra);
    if (r.ok || r.cancelled || r.needTap) return r;
    if (r.error) return r;
  }
  for (const [i, f] of files.entries()) {                        // 공유 창이 없거나 못 받는 브라우저 — 내려받기
    if (i) await sleep(150);                                     // 한꺼번에 누르면 크롬이 내려받기를 버린다
    downloadBlob(f, f.name);
  }
  return { ok: true, where: 'download' };
}
async function shareExcel(run, st) {
  if (T.share) return T.share({ kind: 'excel', step: st.key, file: st.file, title: st.file?.name });
  const r = await exporter.deliver(st.file, 'share');
  return r?.ok ? { ok: true, where: r.where, target: r.target } : (r || { ok: false, error: '보내지 못했어요' });
}
// 엑셀을 만든 뒤 그 기간의 순서·글·사진이 바뀌었나(check §1.3-5 — 바뀌었으면 다시 만든다)
function excelChanged(st) {
  if (!st.scope) return false;
  try {
    const now = excelScope({ plan: R.plan });
    return now.key !== st.scope.key;
  } catch { return false; }
}

async function open(run, st, why = 'tap') {
  if (dead(run) || !st || st.state !== 'ready' || run.opening) return null;
  cancelAuto(run);
  if (st.kind === 'excel' && (st.rebuilt || 0) < REBUILD_MAX && excelChanged(st)) {   // 만든 뒤 순서·글·사진이 바뀜 — 다시 만들고, 다 되면 같은 길로 연다
    st.rebuilt = (st.rebuilt || 0) + 1;
    if (why === 'auto') run.autoArmed = true; else run.tapOpen = true;
    st.state = 'wait'; st.file = null; emit();
    produce(run);
    return null;
  }
  run.opening = true; run.notice = null;
  st.state = 'sharing'; st.openAt = Date.now();
  persist(run); emit(true);
  let r;
  try {
    if (st.kind === 'kakao' && st.part === st.parts && st.parts > 1 && run.text) {
      const ok = await copy(run.text);                           // 마지막 카톡 묶음 — 클립보드가 덮였을 때 대비해 한 번 더
      if (ok) run.copied = true;
    }
    r = st.kind === 'kakao' ? await shareKakao(run, st) : await shareExcel(run, st);
  } catch (e) { r = { ok: false, error: errText(e) }; }
  finally { run.opening = false; }
  await settle(run, st, r || { ok: false, error: '보내지 못했어요' });
  return r;
}

// 공유 결과 — 성공이면 「보냄」 표시(그만 뒤에 끝난 공유도 넘긴 것은 표시만 하고 다음 단계는 없다 — A2)
async function settle(run, st, r) {
  if (r.ok) {
    st.state = 'done'; st.at = Date.now(); st.where = r.where || ''; st.target = r.target || '';
    const token = await markStep(run, st).catch(e => { console.warn('보냄 표시 실패', e); return null; });
    if (token) run.marks.push(token);
    if (r.target) sendlog.setPrefs({ lastTarget: { [st.kind]: r.target } }).catch(() => {});
    if (st.kind === 'kakao') { st.items = null; wake(run); }    // 웹: 보낸 묶음 파일은 바로 놓는다(다음 묶음 굽기가 기다리고 있으면 깨운다)
    if (st.kind === 'excel' && st.where === 'download') ui('toast', `${st.file?.name || '사진대지'}를 내려받았어요 · 카톡 파일 보내기에서 골라요`, 4000);
    if (dead(run)) { emit(); return; }
    persist(run);
    if (allDone(run)) { finish(run); return; }
    emit();
    armAuto(run);
    return;
  }
  if (dead(run)) { emit(); return; }
  if (r.needTap) { st.state = 'ready'; run.notice = { kind: 'tap' }; }
  else if (r.cancelled) { st.state = 'ready'; run.noAuto = true; run.notice = { kind: 'cancel' }; }
  else { st.state = 'fail'; st.failAt = 'share'; st.error = r.error || '보내지 못했어요'; wake(run); }
  persist(run); emit();
}
// 보냄 기록 재료 — 카톡: 넘긴 사진(묶음별) + 글만 묶음(첫 카톡 묶음과 함께) · 엑셀: 그 엑셀의 묶음 서명·목록·핀
function kakaoEntries(items, textOnly = []) {
  const by = new Map();
  for (const it of items || []) { if (!it?.recordId) continue; if (!by.has(it.recordId)) by.set(it.recordId, []); by.get(it.recordId).push(it.photoId); }
  for (const id of textOnly || []) if (id && !by.has(id)) by.set(id, []);
  return [...by].map(([recordId, ids]) => { const rec = store.record(recordId); return { recordId, ids, textSig: rec ? sp.textSig(rec) : null }; });
}
const excelEntries = sc => (sc?.ids || []).map(id => ({ recordId: id, sig: sc.sigs?.get(id) ?? null, set: sc.set || '', rg: sc.rg || '', ...(sc.pins ? { pin: sc.pins.get(id) ?? '' } : {}) }));
function markStep(run, st, at = Date.now()) {
  if (st.kind === 'kakao') return sendlog.mark({ kind: 'kakao', entries: kakaoEntries(st.doneItems || st.items || [], st.part === 1 ? run.textOnly : []), at });
  return sendlog.mark({ kind: 'excel', entries: excelEntries(st.scope || excelScope(run)), at });
}

// ---- 저절로 다음 단계(앱만) ---- 공유가 끝나면 무장 → 앱이 다시 보인 때부터 2초(약속이 풀린 때가 아니다 — 기기에 따라 대상을 고르는 순간 풀린다)
// 만지면(누름·키) 그 단계는 멈춘다(주 버튼으로). 가려지면 세던 것만 멈추고 다시 보이면 처음부터
const autoOn = run => isApp() && sendlog.prefs().autoNext && !run.noAuto;
const autoMs = () => (Number.isFinite(T.autoMs) ? T.autoMs : AUTO_NEXT_MS);
function armAuto(run) { if (autoOn(run)) { run.autoArmed = true; tryAuto(run); } }
function tryAuto(run) {
  if (dead(run) || !run.autoArmed || run.autoT) return;
  const st = curStep(run);
  if (!st || st.state !== 'ready' || appAway || !docVisible() || !hubVisible()) return;   // 카톡에 가 있는 동안(앱 pause ~ resume)은 세지 않는다
  const ms = autoMs();
  run.autoAt = Date.now() + ms;
  run.autoT = setTimeout(() => {
    run.autoT = 0; run.autoAt = 0;
    if (dead(run) || !run.autoArmed) return;
    run.autoArmed = false;
    open(run, curStep(run), 'auto');
  }, ms);
  emit();
}
function cancelAuto(run, disarm = true) {
  if (!run) return;
  const was = !!run.autoT;
  clearTimeout(run.autoT); run.autoT = 0; run.autoAt = 0;
  if (disarm) run.autoArmed = false;
  if (was) emit();
}
// 앱이 뒤에 있나(Capacitor pause·화면 가림 ~ resume) — 기기에 따라 공유 약속이 카톡에 가 있는 동안 풀리고, 웹뷰의 visibilityState 가 그대로일 수 있다
let hooked = false, appAway = false, pendingSnack = null;
function hookOnce() {
  if (hooked || typeof document === 'undefined') return;
  hooked = true;
  const touch = () => { if (R?.autoT) cancelAuto(R, true); };
  document.addEventListener('pointerdown', touch, { capture: true, passive: true });
  document.addEventListener('keydown', touch, { capture: true, passive: true });
  const back = () => { appAway = false; showPendingSnack(); if (R) { tryAuto(R); emit(); } else badge(); };
  const away = () => { appAway = true; if (R?.autoT) cancelAuto(R, false); dropWarm(); };                 // 앱이 뒤로 — 세던 것만 멈춘다(다시 보이면 처음부터), 미리 구운 것은 비운다
  try { N.onPause?.(away); N.onResume?.(back); } catch { /* 웹 */ }
  try { lite().router?.onChange?.(() => { badge(); showPendingSnack(); if (R) tryAuto(R); }); } catch { /* 라우터 없음 */ }
}
// 「보냄으로 표시했어요 [되돌리기]」 — 앱이 뒤에 있거나 촬영 화면이면 미뤘다가 다시 보일 때(그때부터 5초)
function markedSnack(marks) {
  if (!marks?.length) return;
  const show = () => ui('snackbar', '보냄으로 표시했어요', { actionLabel: '되돌리기', onAction: async () => { await sendlog.undo(marks); ui('toast', '보냄 표시를 거뒀어요'); } });
  if (appAway || !docVisible() || where() === 'capture') { pendingSnack = { show, at: Date.now() }; return; }
  pendingSnack = null;
  show();
}
function showPendingSnack() {
  const ps = pendingSnack;
  if (!ps || appAway || !docVisible() || where() === 'capture') return;
  pendingSnack = null;
  if (Date.now() - ps.at < SNACK_MAX_AGE) ps.show();
}

// ---- 시작·조작 ----
// args = { from, to, ids?, kinds? } — 화면이 그린 계획과 같은 재료로 다시 계획한다(그새 바뀐 것까지).
//   지난 실행의 「이어서 보내기」가 남아 있으면 넘긴 단계를 먼저 적고(adoptSaved) 버린 뒤 계획한다 — 이미 넘긴 사진을 다시 보내지 않게
let startP = null;
export function start(args = {}) {
  if (R) return Promise.resolve(R);
  return (startP ||= startNow(args).finally(() => { startP = null; }));
}
async function startNow(args) {
  hookOnce();
  adoptSaved();
  if (saved) discardSaved({ quiet: true });
  if (adoptP) await adoptP.catch(() => {});                      // 넘긴 단계의 보냄 표시가 끝난 뒤에 계획(그 사진은 빠진다)
  if (R) return R;
  let p = plan(args);
  const inScope = rs => rs.filter(r => (p.ids ? p.ids.includes(r.id) : true));
  const pend = inScope(p.records).reduce((n, r) => n + pendingOf(r), 0);
  const run = R = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, at: Date.now(), plan: p, steps: [], copied: null, text: '', textOnly: [], names: null,
    phase: 'prep', noAuto: false, marks: [], dir: '', notice: null, pending: pend, left: 0, tapOpen: true };
  run.dir = `sendrun/${run.id}`;
  emit(true);
  if (pend && typeof lite().pipeline?.idle === 'function') {
    await Promise.race([lite().pipeline.idle(), sleep(PENDING_WAIT_MS)]);
    if (run !== R) return R;
    p = plan(args);
  }
  run.left = inScope(p.records).reduce((n, r) => n + pendingOf(r), 0);
  run.plan = p;
  run.steps = p.steps.map(s => ({ ...s, rows: s.kind === 'kakao' ? p.kParts[s.part - 1] : null, state: 'wait', done: 0, total: s.kind === 'kakao' ? s.n : 0, bytes: 0, items: null, file: null, error: null, at: 0 }));
  run.textOnly = (p.kakao?.recordIds || []).filter(id => !(p.kakao.rows || []).some(x => x.recordId === id));   // 사진 없는 글 묶음 — 첫 카톡 묶음과 함께 적는다
  run.names = runNames(p.kParts.flat(), p.from);
  run.phase = 'running';
  if (run.left) ui('toast', `처리 중 ${run.left}장은 빼고 보내요`, 3500);
  if (p.kinds.kakao && p.kakao?.recordIds?.length) { run.text = textOf(p); run.copied = await copy(run.text); }
  if (run !== R) return R;
  // 카톡 사진이 없는 글(사진 없는 묶음뿐) — 복사가 곧 보냄
  if (run.copied && !p.kParts.length && p.kakao?.recordIds?.length) {
    const token = await markStep(run, { kind: 'kakao', part: 1, items: [] }).catch(() => null);
    if (token) run.marks.push(token);
    ui('toast', '글을 복사했어요 — 카톡에서 붙여 넣으세요', 3000);
  }
  if (run !== R) return R;
  persist(run);
  emit(true);
  if (!run.steps.length) {
    if (!run.copied) ui('toast', run.text ? '글을 복사하지 못했어요' : p.kinds.kakao || p.kinds.excel ? '보낼 것이 없어요' : '위에서 보낼 것을 켜요');
    finish(run, { quiet: !run.copied });
    return null;
  }
  produce(run);
  return run;
}
// 주 버튼 — 지금 단계를 연다(준비됨) · 다시(실패)
export async function next() {
  const run = R;
  if (!run || run.phase !== 'running') return null;
  const st = curStep(run);
  if (!st) return null;
  if (st.state === 'ready') return open(run, st, 'tap');
  if (st.state === 'fail') return retry(st.key);
  return null;
}
export async function retry(key) {
  const run = R;
  if (!run) return null;
  const st = run.steps.find(s => s.key === key);
  if (!st || st.state !== 'fail') return null;
  if (st.failAt === 'share' && (st.items?.length || st.file)) { st.state = 'ready'; st.error = null; emit(); return open(run, st, 'tap'); }
  st.state = 'wait'; st.error = null; run.tapOpen = true; emit();
  produce(run);                                                  // 엑셀을 만드는 중이면 그 바퀴가 끝난 뒤 한 바퀴 더(버리지 않는다)
  return null;
}
// [엑셀은 나중에] — 엑셀 단계만 건너뛴다(엑셀은 「안 보냄」으로 남아 다음에 다시)
export function later() {
  const run = R;
  if (!run) return;
  const st = run.steps.find(s => s.kind === 'excel' && s.state !== 'done');
  if (!st) return;
  run.excelCtrl?.abort(); run.excelCtrl = null;
  cancelAuto(run);
  st.state = 'skip';
  if (allDone(run)) finish(run); else { persist(run); emit(); }
}
// [그만] — 남은 굽기·엑셀·단계 모두 멈춤. 이미 넘긴 것만 「보냄」
export function stop() {
  const run = R;
  if (!run) return;
  cancelAuto(run);
  run.excelCtrl?.abort();
  run.phase = 'stopped';
  ended.add(run.id);
  R = null;
  wake(run);
  coolCache();
  laterClean(run.dir);
  sendlog.saveRun(null).catch(() => {});
  const any = run.steps.some(s => s.state === 'done');
  ui('toast', any ? '그만뒀어요 · 넘긴 것만 표시했어요' : '그만뒀어요');
  emit(true);
}
let lastTextV = '';
export const lastText = () => lastTextV;                         // 끝난 보내기의 글(⋮ 「보낼 글 보기」 — 보낼 것이 남지 않았을 때)
// 보내기가 끝나면 구운 그림 캐시는 30초 뒤 비운다(메모리 — 그새 다시 보내면 그대로 쓴다)
const coolCache = () => setTimeout(() => { if (!R && !W) tell(render.exportCacheClear); }, WARM_DROP_MS);
// 끝난 보내기의 CACHE 폴더(앱) — 10분 뒤 지운다(공유 직후에는 받는 앱이 읽는 중일 수 있다). 그새 그 폴더를 다시 쓰면(이어서 보내기) 그대로
function laterClean(dir) {
  if (!dir || !isApp() || T.put || typeof N.fsRmdir !== 'function') return;
  setTimeout(() => {
    if (R?.dir === dir || saved?.dir === dir) return;
    try { Promise.resolve(N.fsRmdir(N.DIR.CACHE, dir)).catch(() => {}); } catch { /* 없음 */ }
  }, CLEAN_AFTER_MS);
}
function finish(run, { quiet = false } = {}) {
  run.phase = 'done';
  ended.add(run.id);
  coolCache();
  laterClean(run.dir);
  if (run.text) lastTextV = run.text;
  if (R === run) R = null;
  sendlog.saveRun(null).catch(() => {});
  const marks = run.marks.filter(Boolean);
  emit(true);
  if (quiet || !marks.length) return;
  markedSnack(marks);
}
// 「이 날 보냄 표시 지우기」 등 — 화면이 부른다
export async function clearMarks(recordIds, kind = null) {
  const token = await sendlog.clear(recordIds, kind);
  emit();
  return token;
}

// ---- 이어서 보내기 ----
// 부팅 훅은 첫 화면 2초 + 한가할 때 돈다 — 그 사이 사용자가 이미 [한번에]를 눌렀으면 meta sendRun 은 「지금 보내는 것」이다(검증 때 발견:
// 다 보낸 뒤에도 「보내다 멈췄어요 · 이어서 보내기」 + 탭 배지가 남아, 누르면 같은 사진을 다시 보낼 뻔했다). 보내는 중이거나 이 실행에서 끝난 보내기는 잡지 않는다
const ended = new Set();
let adoptedId = null, adoptP = null;
// 지난 실행의 meta sendRun 을 맡는다(한 번, 동기) → 「이어서 보내기」(saved) | null.
//   공유 창을 연(sharing) 단계 = 넘긴 것: 그 자리에서 done 으로 바꾸고 보냄 표시는 뒤에서(adoptP — 표 배열). 남은 단계가 있고 2시간 안이면 saved,
//   아니면 meta 를 지우고 끝(넘긴 것이 있으면 「보냄으로 표시했어요 [되돌리기]」 — 2시간 넘은 것은 조용히)
export function adoptSaved() {
  hookOnce();
  let s = null;
  try { s = sendlog.savedRun(); } catch { s = null; }
  if (!s || s.id === adoptedId || ended.has(s.id) || (R && R.id === s.id)) return R ? null : saved;
  adoptedId = s.id;
  const now = Date.now();
  const steps = (s.steps || []).map(x => (x.state === 'sharing' ? { ...x, state: 'done', at: x.at || s.at || now, handed: true } : x));
  const handed = steps.filter(x => x.handed);
  const left = steps.some(x => x.state !== 'done' && x.state !== 'skip');
  const fresh = now - (s.at || 0) < RUN_MAX_AGE;
  const next = { ...s, steps };
  adoptP = handed.length ? markHanded(next, handed) : Promise.resolve([]);
  if (left && fresh && !R) {
    saved = next;
    if (handed.length) sendlog.saveRun(next).catch(e => console.warn('보내기 진행 저장 실패', e));   // 다시 켜져도 두 번 적지 않게
  } else {
    ended.add(s.id);
    if (!R) { saved = null; sendlog.saveRun(null).catch(() => {}); }
    laterClean(s.dir);
    if (handed.length && fresh) adoptP.then(tokens => markedSnack(tokens)).catch(() => {});
  }
  emit();
  return R ? null : saved;
}
async function markHanded(s, handed) {
  const tokens = [];
  for (const x of handed) {
    try {
      let t = null;
      if (x.kind === 'kakao') {
        t = await sendlog.mark({ kind: 'kakao', entries: kakaoEntries((x.rows || []).map(([recordId, photoId]) => ({ recordId, photoId })), x.part === 1 ? s.textOnly : []), at: x.at });
      } else {
        let sc = x.scope ? scopeIn(x.scope) : null;
        if (!sc?.ids?.length) { const p = plan({ from: s.from, to: s.to, ids: s.ids, kinds: s.kinds }); p.format = s.format === 'zip' ? 'zip' : 'xlsx'; sc = excelScope({ plan: p }); }   // 범위를 안 실은 옛 기록 — 지금 것으로
        t = await sendlog.mark({ kind: 'excel', entries: excelEntries(sc), at: x.at });
      }
      if (t) tokens.push(t);
    } catch (e) { console.warn('넘긴 단계를 보냄으로 적지 못했어요', x.key, e); }
  }
  return tokens;
}
export async function resume() {
  adoptSaved();
  cleanupLater();
  return R ? null : saved;
}
// [그만두기] — 넘긴 단계는 적은 채(adoptSaved), 남은 단계는 버린다(다음 [한번에]가 안 보낸 것으로 다시 고른다)
export function discardSaved({ quiet = false } = {}) {
  adoptSaved();
  const s = saved;
  if (!s || R) return;
  saved = null;
  ended.add(s.id);
  sendlog.saveRun(null).catch(() => {});
  laterClean(s.dir);
  emit(true);
  if (!quiet) (adoptP || Promise.resolve([])).then(t => ui('toast', t?.length ? '그만뒀어요 · 넘긴 것만 표시했어요' : '그만뒀어요')).catch(() => {});
}
// 남은 단계 이름(카드 글) — 「사진대지 엑셀이 남았어요」 · 「카톡 사진 2/2 · 사진대지 엑셀이 남았어요」
export function leftText(s = saved) {
  if (!s) return '';
  const left = (s.steps || []).filter(x => x.state !== 'done' && x.state !== 'skip' && x.state !== 'sharing');   // 공유 창을 연 단계는 넘긴 것(adoptSaved)
  const names = left.map(x => (x.kind === 'excel' ? '사진대지 엑셀' : x.parts > 1 ? `카톡 사진 ${x.part}/${x.parts}` : '카톡 사진'));
  return names.length ? `${names.join(' · ')}이 남았어요` : '';
}
export async function continueSaved() {
  adoptSaved();
  const s = saved;
  if (!s || R) return R;
  saved = null;
  hookOnce();
  const p = plan({ from: s.from, to: s.to, ids: s.ids, kinds: s.kinds });
  p.format = s.format === 'zip' ? 'zip' : 'xlsx';
  const run = R = { id: s.id, at: s.at, plan: p, steps: [], copied: s.copied, text: s.text || '', textOnly: s.textOnly || [], names: null,
    phase: 'running', noAuto: false, marks: [], dir: s.dir || `sendrun/${s.id}`, notice: null, pending: 0, left: 0, tapOpen: true };
  const pairs = x => (x.rows || []).map(([recordId, photoId]) => ({ recordId, photoId }));
  run.names = runNames((s.steps || []).filter(x => x.kind === 'kakao').flatMap(pairs), s.from);   // 앞 실행과 같은 이름(넘긴 것까지 세어 1..n)
  run.steps = (s.steps || []).map(x => {
    const rows = x.kind === 'kakao' ? pairs(x).filter(r => store.photo(r.photoId)?.state === 'ready') : null;
    const fin = x.state === 'done' || x.state === 'skip';
    return { key: x.key, kind: x.kind, part: x.part, parts: x.parts, n: (x.rows || []).length, rows,
      state: fin ? x.state : x.kind === 'kakao' && !rows.length ? 'skip' : 'wait', done: 0, total: 0, bytes: 0, items: null, file: null, error: null, at: x.at || 0 };
  });
  emit(true);
  // 넘긴 단계의 보냄 표시(adoptSaved) — 끝의 [되돌리기]가 그것까지 거두게 이 보내기의 표에 넣는다
  const tokens = await (adoptP || Promise.resolve([])).catch(() => []);
  if (run !== R) return R;
  run.marks.push(...(tokens || []));
  if (allDone(run)) { finish(run); return null; }
  // 카톡 묶음이 남았으면 글을 다시 복사(다시 켜지는 사이 클립보드가 덮였을 수 있다 — [이어서] 탭 안이라 복사가 된다)
  if (run.text && run.steps.some(x => x.kind === 'kakao' && x.state === 'wait')) { const ok = await copy(run.text); if (ok) run.copied = true; }
  if (run !== R) return R;
  persist(run); emit(true);
  produce(run);
  return run;
}

// 지난 실행의 sendrun/ 임시 폴더 정리(앱만) — 지금 진행 중인 것·이어서 보낼 것만 남긴다(담당 3 native.cleanupCache({ keep })). 부팅 뒤 한가할 때 한 번
//   (공유 직후에는 받는 앱이 읽는 중일 수 있다 — 이 실행에서 끝난 보내기는 laterClean 이 10분 뒤에). 메인 app.js 가 같은 일을 걸어도 두 번째는 지울 것이 없다
let cleaned = false;
function cleanupLater() {
  if (cleaned || !isApp() || typeof N.cleanupCache !== 'function') return;
  cleaned = true;
  (async () => {
    try {
      await sleep(4000);
      await N.whenQuiet?.({ quietMs: 1500, maxMs: 30000 });
      await N.cleanupCache({ dirs: ['sendrun'], keep: activeDir() });
    } catch (e) { console.warn('보내기 임시 폴더 정리 실패', e); }
  })();
}

// ---- 미리 굽기 ----
// 첫 카톡 묶음(앱 20 · 웹 10장)만, 메모리에(render.exportSet 캐시 — [한번에] 때 그대로 쓴다. CACHE 파일 쓰기는 누른 뒤).
// 0.8초 뒤, 한가할 때 한 장씩(whenQuiet — 만지면 쉰다), 탭이 안 보이면 그만. 탭을 떠나 30초·앱이 뒤로 가면 비운다(보내는 중이 아니면)
export function warm(p) {
  hookOnce();
  const rows = p?.kParts?.[0];
  if (R || saved || !rows?.length || T.bake) return;
  const key = `${rows.map(r => r.photoId).join(',')}|${p.env?.wm || ''}`;
  if (W?.key === key) { clearTimeout(W.dropT); W.dropT = 0; if (!W.busy && !W.done) warmLoop(W, rows); return; }
  if (W) clearTimeout(W.dropT);                                  // 첫 묶음이 바뀜(새 사진 등) — 캐시는 두고(같은 사진은 그대로 쓴다) 처음부터
  W = { key, n: 0, busy: false, done: false, dropT: 0, seq: ++warmSeq };
  warmLoop(W, rows);
}
async function warmLoop(w, rows) {
  w.busy = true;
  try {
    await sleep(PREBAKE_DELAY_MS);
    for (const row of rows.slice(w.n)) {
      if (W !== w || R) return;
      await (N.whenQuiet?.({ quietMs: 800, maxMs: 60000 }) ?? Promise.resolve());
      if (W !== w || R || !hubVisible()) return;
      try { await bakeBytes(row.photoId); } catch (e) { console.warn('미리 굽기 실패', row.photoId, e); }
      w.n++;
    }
    if (W === w) w.done = true;
  } finally { w.busy = false; }
}
// 탭을 떠날 때 — 30초 뒤 비운다
export function cool() { if (W && !W.dropT) W.dropT = setTimeout(dropWarm, WARM_DROP_MS); }
// 미리 구운 것 비우기 — 보내는 중이 아니면 구운 그림 캐시도 비운다(묶음 상세 [공유]·사진 저장이 남긴 것까지 — 검토: 앱이 뒤로 가도 남았다).
//   보내는 중이면 캐시는 그대로(엑셀이 카톡 그림을 줄여 쓴다)
export function dropWarm() {
  if (W) clearTimeout(W.dropT);
  W = null;
  if (!R) tell(render.exportCacheClear);
}
export const warmStats = () => (W ? { n: W.n, done: W.done, busy: W.busy } : null);

// 화면용 도우미 — 단계 이름·상태 글
export function stepLabel(st) {
  if (!st) return '';
  if (st.kind === 'excel') return '사진대지 엑셀';
  return st.parts > 1 ? `카톡 사진 ${st.part}/${st.parts}` : '카톡 사진';
}
export { fmtMB };
