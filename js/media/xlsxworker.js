// 사진대지 xlsx 묶기(v0.1.7) — 틀 파트 + 칸 글 + 줄인 사진 → xlsx 바이트를 모듈 워커(이 파일 자신)에서 만든다.
// 0.1.6 까지는 메인 스레드에서 XML 글 만들기·CRC32·ZIP 묶기를 한 덩어리로 해(38장 3MB 남짓) 엑셀 만들기 끝에 화면이 멈췄다.
// 메인은 사진 Blob(손잡이 — 복사 없음)을 넘기고 결과 Blob 을 받기만 한다. 워커·모듈 워커를 못 띄우면(옛 웹뷰) 메인에서 같은 함수로.
// 워커와 메인이 같은 core 함수(buildWorkbook·addLocMapSheet·makeZipBytes)를 쓴다 — 같은 입력이면 같은 바이트(www/dev/export-test 가 비교).
//
// 계약
//   buildXlsx({ tpl, meta, site, frames, ledger, maps, now }) → Promise<{ blob, size, pages, images, via: 'worker'|'main', ms }>
//     tpl    : Map<파트 이름, Uint8Array>(photo-sheet.xlsx 를 푼 것), meta: photo-sheet.meta.json
//     frames : [{ date, content, photo: Blob|Uint8Array|null }]   (core/xlsx.js buildWorkbook 과 같은 모양 — 사진만 Blob 이어도 된다)
//     ledger : [{ cells, thumb: Blob|Uint8Array|null }]
//     maps   : [{ jpeg: Blob|Uint8Array, w, h, name? }] — 위치도 시트(첫 파일에만, 없으면 [])
//   XLSX_MIME · _forcePath('main'|'worker'|null) · xlsxState() — 시험·측정용
import { buildWorkbook } from '../core/xlsx.js';
import { makeZipBytes } from '../core/zip.js';
import { addLocMapSheet } from '../core/locmap.js';

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const IN_WORKER = typeof WorkerGlobalScope !== 'undefined' && typeof self !== 'undefined' && self instanceof WorkerGlobalScope;   // eslint-disable-line no-undef

// ---------- 공통(워커·메인) ----------
const bytesOf = async v => (v == null ? null
  : v instanceof Uint8Array ? v
    : v instanceof ArrayBuffer ? new Uint8Array(v)
      : typeof Blob === 'function' && v instanceof Blob ? new Uint8Array(await v.arrayBuffer())
        : null);
async function assemble(m) {
  const t0 = performance.now();
  const frames = await Promise.all((m.frames || []).map(async f => ({ date: f.date, content: f.content, photo: await bytesOf(f.photo) })));
  const ledger = await Promise.all((m.ledger || []).map(async l => ({ cells: l.cells, thumb: await bytesOf(l.thumb) })));
  const wb = buildWorkbook(m.tpl, m.meta, { site: m.site, frames, ledger, now: m.now });
  let entries = wb.entries;
  if (m.maps?.length) {
    const maps = await Promise.all(m.maps.map(async x => ({ ...x, jpeg: await bytesOf(x.jpeg) })));
    try { entries = addLocMapSheet(entries, maps); } catch (e) { console.warn('위치도 시트를 넣지 못했어요', e); }   // 위치도가 없어도 사진대지는 낸다
  }
  const bytes = makeZipBytes(entries, { date: new Date(m.now ?? Date.now()) });
  return { bytes, pages: wb.pages, images: wb.images, ms: Math.round(performance.now() - t0) };
}

// ---------- 워커 쪽 ----------
if (IN_WORKER) {
  self.onmessage = async e => {
    const m = e.data || {};
    try {
      if (m.op === 'ping') { self.postMessage({ id: m.id, ok: true }); return; }
      if (m.op !== 'xlsx') throw new Error(`모르는 작업: ${m.op}`);
      const r = await assemble(m);
      const blob = new Blob([r.bytes], { type: XLSX_MIME });                  // Blob 으로 돌려준다 — 메인은 손잡이만 받는다(바이트 복사 없음)
      self.postMessage({ id: m.id, ok: true, blob, size: r.bytes.length, pages: r.pages, images: r.images, ms: r.ms });
    } catch (err) {
      self.postMessage({ id: m.id, ok: false, error: String(err?.message || err), code: err?.code || err?.name || '' });
    }
  };
}

// ---------- 메인 쪽 ----------
// 워커 하나를 띄워 두고 다시 쓴다. 20초 쉬면 닫는다(내보낼 때만 쓴다). 두 번 실패하면(모듈 워커를 못 띄우는 웹뷰) 더 띄우지 않는다
let wk = null, seq = 0, off = false, fails = 0, idle = null, forced = null;
const calls = new Map();
const usable = () => !IN_WORKER && !off && typeof Worker === 'function';
function kill(err) {
  clearTimeout(idle); idle = null;
  try { wk?.terminate(); } catch { /* 이미 닫힘 */ }
  wk = null;
  for (const c of calls.values()) { clearTimeout(c.t); c.rej(err); }
  calls.clear();
}
function get() {
  if (wk) return wk;
  wk = new Worker(new URL('./xlsxworker.js', import.meta.url), { type: 'module' });
  wk.onmessage = e => {
    const d = e.data || {}, c = calls.get(d.id);
    if (!c) return;
    calls.delete(d.id); clearTimeout(c.t);
    if (d.ok) { fails = 0; c.res(d); } else c.rej(Object.assign(new Error(d.error || 'xlsx 워커 실패'), { code: d.code || 'WORKER' }));
    if (!calls.size) { clearTimeout(idle); idle = setTimeout(() => { if (!calls.size) kill(new Error('닫힘')); }, 20000); }
  };
  wk.onerror = e => {
    e?.preventDefault?.();
    if (++fails >= 2) off = true;
    kill(Object.assign(new Error(`xlsx 워커 오류 ${e?.message || ''}`), { code: 'WORKER' }));
  };
  return wk;
}
function call(msg, ms = 120000) {
  return new Promise((res, rej) => {
    const w = get(), id = ++seq;
    clearTimeout(idle); idle = null;
    const t = setTimeout(() => { fails++; kill(Object.assign(new Error('xlsx 워커 시간 초과'), { code: 'WORKER_TIMEOUT' })); }, ms);
    calls.set(id, { res, rej, t });
    try { w.postMessage({ ...msg, id }); }
    catch (e) { calls.delete(id); clearTimeout(t); rej(Object.assign(e instanceof Error ? e : new Error(String(e)), { code: 'WORKER_POST' })); }
  });
}

export async function buildXlsx(job = {}) {
  if (IN_WORKER) throw new Error('워커 안에서는 부르지 않아요');
  const msg = { tpl: job.tpl, meta: job.meta, site: job.site || '', frames: job.frames || [], ledger: job.ledger || [], maps: job.maps || [], now: job.now ?? Date.now() };
  if (forced !== 'main' && usable()) {
    try {
      const r = await call({ op: 'xlsx', ...msg });
      return { blob: r.blob, size: r.size, pages: r.pages, images: r.images, via: 'worker', ms: r.ms };
    } catch (e) {
      if (forced === 'worker') throw e;
      console.warn('xlsx 워커 실패 — 메인 스레드로 해요', e);
    }
  }
  const r = await assemble(msg);
  return { blob: new Blob([r.bytes], { type: XLSX_MIME }), size: r.bytes.length, pages: r.pages, images: r.images, via: 'main', ms: r.ms };
}

export function _forcePath(p) { forced = p || null; }
export const xlsxState = () => ({ usable: usable(), off, running: !!wk, forced });
