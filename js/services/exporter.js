// 사진대지 내보내기 — 원본 export.js + core/ledger·xlsx 를 lite 에 맞게(SPEC §5.6).
// v0.1.7 기본 형식은 xlsx 파일 하나(폰 카톡에서 바로 열리고 ZIP 의 약 1/4 크기). 사진이 100장을 넘거나 「사진 파일도 넣기」(withPhotos)면
//   ZIP — xlsx 를 100장씩 나눠 담고(설계 비평 #11), withPhotos 면 사진/MMDD_<위치>_<n>.jpg·위치도/ 그림도. ZIP 은 흐름 쓰기(앱: CACHE 파일, 웹: Blob 조각).
// 그림: render.exportSet 이 작업본을 한 번 풀어 워터마크를 한 번 굽고(그리기만 메인), 사진대지 칸(긴 변 1000px)·대장 대표 사진(480px)으로
//   줄이기·인코딩은 워커 — 보이는 그대로 내보낸다(설계 비평 #7). 카톡 굽기가 만든 그림(같은 사진·같은 워터마크 글)이 캐시에 있으면 그것을 줄여 쓴다.
//   xlsx 묶기(XML·CRC·ZIP)는 모듈 워커 media/xlsxworker.js(안 되면 메인). 0.1.6 까지 메인 toDataURL(줄이기 50번)이 긴 작업의 83%였다.
// 순서: 날짜 → 그 날 사진대지 순서(record.order — core/ledger selectExport) → 묶음 안 사진 순서. 대장 순번 = 그 순서 1..N(나눈 파일도 이어서).
// 위치도(v0.1.4, docs/도면보관함-설계.md §5.9): 그 기간 묶음들의 도면 핀(record.pin + drawings.pinsOfRecord)을 날짜·도면·쪽마다 묶어
//   도면 미리보기 그림 + 번호 핀 + 이름 범례 JPEG(media/locmapimg — 워커) → 첫 xlsx 에 '위치도' 시트(withPhotos ZIP 이면 `위치도/<MMDD>_<도면>_<쪽>쪽.jpg` 도).
//   핀 번호 = 대장 순번(v0.1.7 — 사진대지·대장과 맞물림). 도면보관함이 없거나 미리보기 그림이 없는 도면(복원 뒤 원본 미등록)은 그 장만 건너뛴다(locmapSkipped).
// 서명 sig(core/ledger exportSig): 같은 묶음·순서·글·사진·현장명·워터마크면 같다 — plan 이 미리 알려 주고(「보낸 뒤 바뀜」), build 는 같은 서명이면 만들어 둔 파일을 다시 쓴다.
//   다시 쓰기 열쇠에는 위치도 핀(자리·이름·번호·도면 이름)도 넣는다 — 도면에서 핀을 옮긴 뒤 「사진대지만 다시 보내기」가 옛 그림을 다시 보내던 것(검토 major).
//   pinSigOf(record) 는 같은 핀 서명(동기 — 도면보관함을 한 번 연 뒤에만, 아니면 null): 한번에 보내기가 보낸 때 값을 적어 「보낸 뒤 바뀜」을 잡는다.
import * as store from '../data/store.js';
import * as render from '../media/render.js';
import * as N from '../platform/native.js';
import { MAX_EXPORT_PHOTOS } from '../config.js';
import { selectExport, splitParts, zipName, xlsxName, photoFileNames, sheetContent, sheetDate, ledgerRows, exportSig } from '../core/ledger.js';
import { ZipStream, parseZip } from '../core/zip.js';
import { locMapName, locMapTitle } from '../core/locmap.js';
import { circled } from '../core/model.js';
import { oneLine, wmOpts } from '../core/watermark.js';
import { downloadBlob, webShareFiles } from './share.js';

const SHEET_MAX = 1000, THUMB_MAX = 480, LEGEND_MAX = 60;
const INFLIGHT = 2;                                                          // 사진 두 장까지 겹쳐 굽기(메인이 다음 장을 그리는 동안 워커가 앞 장을 인코딩)
const REUSE_WEB_MAX = 32 * 1024 * 1024;                                      // 웹에서 다시 쓰려고 들고 있을 만든 파일 크기 상한(메모리)
const SHARE_CHUNK = 384 * 1024;                                              // 앱: xlsx·ZIP(수 MB)을 CACHE 에 쓰는 브리지 조각 — 한 번에 메인을 50ms 넘게 잡지 않게(흉내 1MB 당 60ms 기준)
const LAST_WEB_MS = 60 * 1000;                                               // 웹: 다시 쓰려고 들고 있는 만든 파일(Blob)은 이만큼 안 쓰면 놓는다(메모리)
const OLD_DIR_MS = 10 * 60 * 1000;                                           // 앱: 지난 내보내기 CACHE 폴더는 이보다 오래되면 다음 만들기 때 지운다(받는 앱이 다 읽은 뒤)

// ---- 위치도 묶기 ---- records(그 기간) → { dw, groups: [{ day, drawing, page, items: [{ pin, record }] }] }
// 도면보관함 모듈을 그때 연다(내보내기 화면 밖에서는 열지 않는다 — 한 번 열면 pinSigOf 가 동기로 쓴다). 없으면 groups 빈 것
let DW = null, dwP = null;
export function loadPins() {
  return (dwP ||= import('../data/drawings.js').then(async m => { await m.ready?.(); DW = m; return m; })
    .catch(e => { console.warn('도면보관함 없음 — 위치도 빼요', e); dwP = null; return null; }));
}
// 묶음에 걸린 핀(record.pin + 핀 쪽 recordId) — 지운 핀 빼고
function pinsOf(dw, r) {
  const pins = new Map();
  const lp = r?.pin?.pinId ? dw.pin?.(r.pin.pinId) : null;
  if (lp && !lp.deletedAt) pins.set(lp.id, lp);
  for (const p of dw.pinsOfRecord?.(r.id) ?? []) pins.set(p.id, p);
  return [...pins.values()];
}
// 위치도에 그려지는 것(핀 자리·이름·번호·도면·쪽·도면 이름)
const pinPart = (p, d) => `${p.id}:${p.drawingId}:${p.page}:${Math.round(Number(p.x) || 0)}:${Math.round(Number(p.y) || 0)}:${p.name || ''}:${p.no ?? ''}:${d?.name || ''}`;
const hash = s => { let h = 0x811c9dc5; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
// 묶음 하나의 위치도 핀 서명 → '' (핀 없음) | 해시 | null(도면보관함을 아직 안 열었다 — 모른다)
export function pinSigOf(r) {
  if (!DW || !r) return null;
  try {
    const parts = [];
    for (const p of pinsOf(DW, r)) { const d = DW.drawing?.(p.drawingId); if (d && !d.deletedAt) parts.push(pinPart(p, d)); }
    return parts.length ? hash(parts.sort().join('|')) : '';
  } catch { return null; }
}
export async function locMapGroups(records) {
  const dw = await loadPins();
  if (!dw) return { dw: null, groups: [] };
  const by = new Map();
  for (const r of records || []) {
    for (const p of pinsOf(dw, r)) {
      const d = dw.drawing?.(p.drawingId);
      if (!d || d.deletedAt) continue;
      const k = `${r.day}|${p.drawingId}|${p.page}`;
      let g = by.get(k);
      if (!g) by.set(k, g = { day: r.day, drawing: d, page: p.page, items: [] });
      g.items.push({ pin: p, record: r });
    }
  }
  const groups = [...by.values()].sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0) || String(a.drawing.name).localeCompare(String(b.drawing.name), 'ko') || a.page - b.page);
  return { dw, groups };
}
const clip = (t, max) => { const ch = Array.from(t); return ch.length > max ? `${ch.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…` : t; };
const clamp01 = v => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0));
// 한 묶음(날짜·도면·쪽) → { name, jpeg: Blob, w, h } | null(미리보기 그림 없음). 핀 번호 = seqOf(묶음)(대장 순번), 모르면 그림 안 차례
async function renderGroup(dw, g, { site, dupOf, seqOf = null }) {
  const pg = dw.pageOf?.(g.drawing.id, g.page);
  if (!pg?.w || !pg?.h) return null;
  const blob = await dw.previewBlob?.(g.drawing.id, g.page).catch(() => null);
  if (!blob || !blob.size) return null;
  const noOf = (record, i) => { const n = seqOf ? seqOf(record) : null; return Number.isFinite(n) && n > 0 ? n : i + 1; };
  const items = g.items.map((it, i) => ({ ...it, n: noOf(it.record, i) })).sort((a, b) => a.n - b.n);
  const pins = items.map(({ pin, n }) => ({ n, label: String(n), x: clamp01(pin.x / pg.w), y: clamp01(pin.y / pg.h), id: pin.id }));
  const legend = items.map(({ pin, record, n }) => {
    const c = oneLine(record?.content || '');
    return clip(`${circled(n)} ${oneLine(pin.name) || `핀 ${pin.no || n}`}${c ? ` · ${c}` : ''}`, LEGEND_MAX);
  });
  const { renderLocMap } = await import('../media/locmapimg.js');
  const out = await renderLocMap({
    snapBlob: blob, w: pg.preview?.w || pg.w, h: pg.preview?.h || pg.h, pins, legend,
    title: locMapTitle({ site, day: g.day, docName: g.drawing.name, page: g.page }), sub: `핀 ${pins.length}개`,
  });
  const base = locMapName(g.day, g.drawing.name, g.page);
  const dup = (dupOf.get(base) || 0) + 1;
  dupOf.set(base, dup);
  return { name: dup > 1 ? locMapName(g.day, g.drawing.name, g.page, dup) : base, jpeg: out, w: out.lm?.w || 0, h: out.lm?.h || 0 };
}

// ---- 틀 ---- 한 번 읽으면 메모리에(실패하면 다음에 다시)
let tplP = null;
function loadTemplate() {
  if (!tplP) {
    const get = async name => {
      const r = await fetch(new URL(`../../tpl/${name}`, import.meta.url));
      if (!r.ok) throw new Error(`엑셀 틀을 읽지 못했어요(${name} ${r.status})`);
      return r;
    };
    const p = tplP = (async () => {
      const [zip, meta] = await Promise.all([get('photo-sheet.xlsx').then(r => r.arrayBuffer()), get('photo-sheet.meta.json').then(r => r.json())]);
      return { tpl: new Map((await parseZip(zip)).map(e => [e.name, e.data])), meta };
    })();
    p.catch(() => { if (tplP === p) tplP = null; });
  }
  return tplP;
}

// ---- 고르기 ----
function select({ from, to, recordIds = null }) {
  const days = store.days().map(d => d.day).filter(d => d >= from && d <= to);
  const records = days.flatMap(d => store.recordsOfDay(d));
  const photos = new Map();
  for (const r of records) for (const p of store.photosOf(r.id)) photos.set(p.id, p);
  return selectExport({ records, photos, from, to, recordIds });
}
// 서명 — 고른 것 + 현장명 + 워터마크 설정(모드·일시)
function sigOf(s) {
  const st = store.settings(), o = wmOpts(st);
  return exportSig({ records: s.records, rows: s.rows, site: st.siteName || '', wm: o.mode === 'off' ? 'off' : [o.mode, o.when ?? null] });
}
// 만들 형식 — 'auto'·'xlsx' 는 사진이 한 파일(100장)에 들어가고 사진 파일을 넣지 않으면 xlsx, 아니면 ZIP
const formatOf = ({ format = 'auto', withPhotos = false, parts = 1 }) => (format === 'zip' || withPhotos || parts > 1 ? 'zip' : 'xlsx');

// → { days, records, photoCount, over, parts, notReady, noLocation, format, sig }
// over = 100장 초과(막지 않는다 — parts 개 xlsx 로 나눈다). notReady = 처리 중·실패라 빠지는 사진, noLocation = 위치 미입력 묶음
// format = build 가 만들 형식('xlsx'|'zip' — 같은 format·withPhotos 를 주면), sig = 서명(내용이 바뀌었는지)
export function plan({ from, to, recordIds = null, format = 'auto', withPhotos = false } = {}) {
  const s = select({ from, to, recordIds });
  const parts = Math.max(1, Math.ceil(s.photoCount / MAX_EXPORT_PHOTOS));
  return {
    days: s.days, records: s.records, photoCount: s.photoCount,
    over: s.photoCount > MAX_EXPORT_PHOTOS, parts,
    notReady: s.notReady, noLocation: s.noLocation,
    format: formatOf({ format, withPhotos, parts }), sig: sigOf(s),
  };
}

// ---- 만들기 ----
let queue = Promise.resolve();                                               // 한 번에 하나씩(두 번 눌러도 겹치지 않게)
export function build(opts, onProgress) {
  const p = queue.then(() => buildNow(opts, onProgress));
  queue = p.then(() => {}, () => {});
  return p;
}
let last = null, lastT = 0;                                                  // 마지막으로 만든 것 { key, res } — 같은 내용이면 다시 쓴다(사진대지만 다시 보내기)
export function forgetBuilt() { last = null; clearTimeout(lastT); }
// 웹은 Blob(메모리)이라 1분 안 쓰면 놓는다(다시 쓸 때마다 다시 센다). 앱은 CACHE 파일이라 그대로
function keepLast(v) {
  last = v; clearTimeout(lastT);
  if (v?.res?.blob) lastT = setTimeout(() => { if (last === v) last = null; }, LAST_WEB_MS);
}
// 앱: 지난 내보내기 CACHE 폴더 — 10분 넘은 것은 다음 만들기 때 지운다(지금 다시 쓸 수 있는 것은 남긴다). 부팅 때 정리(app.js cleanupCache)만으로는 앱이 며칠 살아 있으면 쌓였다
const builtDirs = [];
function sweepBuilt(now) {
  if (!N.isNative() || typeof N.fsRmdir !== 'function') return;
  const keep = last?.res?.path ? last.res.path.split('/').slice(0, -1).join('/') : '';
  for (let i = builtDirs.length - 1; i >= 0; i--) {
    const b = builtDirs[i];
    if (b.dir === keep || now - b.at < OLD_DIR_MS) continue;
    builtDirs.splice(i, 1);
    Promise.resolve(N.fsRmdir(N.DIR.CACHE, b.dir)).catch(() => {});
  }
}
async function stillThere(res) {
  if (!res) return false;
  if (res.blob) return true;
  if (!res.path || !N.isNative()) return false;
  const st = await N.fsStat(N.DIR.CACHE, res.path);
  return !!st && Number(st.size) === res.size;
}
const stopErr = () => Object.assign(new Error('그만뒀어요'), { code: 'ABORT', name: 'AbortError' });
const bytesOf = async v => (v instanceof Uint8Array ? v : new Uint8Array(await v.arrayBuffer()));

let seq = 0;
// opts: { from, to, recordIds, format: 'auto'|'xlsx'|'zip', withPhotos, signal(AbortSignal — 그만), reuse(같은 서명이면 만들어 둔 것, 기본 켬),
//         hold(사진마다 굽기 전에 기다릴 것 — 촬영 화면 등), now } · onProgress(done, total)
// → { name, size, blob?|uri?, path?, format, parts, photos, records, skipped, notReady, locmaps, locmapSkipped, sig, reused? }
async function buildNow({ from, to, recordIds = null, format = 'auto', withPhotos = false, signal = null, reuse = true, hold = null, now = Date.now() } = {}, onProgress) {
  if (signal?.aborted) throw stopErr();
  const s = select({ from, to, recordIds });
  if (!s.records.length) throw Object.assign(new Error('이 기간에는 기록이 없어요'), { code: 'EMPTY' });
  const site = store.settings().siteName || '';
  const fileSite = site || s.records.find(r => r.site)?.site || '';          // 파일 이름의 현장명(설정이 비었으면 묶음에 남은 현장명 — 카톡 글 머리와 같게)
  const parts = splitParts(s.rows, MAX_EXPORT_PHOTOS);
  const fmt = formatOf({ format, withPhotos, parts: parts.length });
  const sig = sigOf(s);
  const tell = (d, t) => { try { onProgress?.(d, t); } catch (e) { console.error(e); } };
  const holdOk = async () => { if (hold) { try { await hold(); } catch { /* 그냥 한다 */ } } };
  // 위치도(핀)는 다시 쓰기 판단 전에 — 핀을 옮기거나 이름을 고쳤으면 같은 서명이어도 다시 만든다
  const lm = await locMapGroups(s.records);
  const lmKey = lm.groups.map(g => [g.day, g.drawing.id, g.page, g.items.map(it => `${it.record.id}>${pinPart(it.pin, g.drawing)}`)]);
  const key = JSON.stringify([sig, fmt, !!withPhotos, from, to, lmKey]);
  if (reuse && last?.key === key && await stillThere(last.res)) { tell(1, 1); keepLast(last); return { ...last.res, reused: true }; }
  sweepBuilt(now);
  const { tpl, meta } = await loadTemplate();
  const rows = s.rows;
  const seqOf = new Map(s.records.map((r, i) => [r.id, i + 1]));             // 대장 순번 — 내보내기 전체에서 이어진다
  const firstOf = new Map();                                                 // 묶음 id → 첫 사진 id(대장 대표 사진)
  for (const r of rows) if (!firstOf.has(r.record.id)) firstOf.set(r.record.id, r.photo.id);
  const hasPhoto = new Set(rows.map(x => x.record.id));
  const total = rows.length + lm.groups.length + parts.length;
  let done = 0, skipped = 0, photos = 0, locmapSkipped = 0;
  const dir = `export/${now}-${++seq}`;
  if (N.isNative()) builtDirs.push({ dir, at: now });
  const zip = fmt === 'zip' ? (() => { const sink = N.zipSink(`${dir}/${zipName(from, to)}`, 'application/zip', { chunk: SHARE_CHUNK, hold: hold ? holdOk : null }); return { sink, z: new ZipStream(sink.write, { date: new Date(now) }) }; })() : null;
  try {
    // ① 사진 — 사진대지 칸·대장 대표 사진(+ withPhotos 면 사진 파일). 두 장까지 겹친다, 순서는 그대로
    const sheetImg = new Map(), thumbs = new Map();                          // 사진 id → 칸 그림, 묶음 id → 대표 사진(모두 Blob)
    const names = withPhotos ? photoFileNames(rows) : null;
    const want = r => ({ full: !!withPhotos, sheet: SHEET_MAX, thumb: firstOf.get(r.record.id) === r.photo.id ? THUMB_MAX : 0 });
    const q = [];
    let next = 0;
    const pump = () => {
      while (q.length < INFLIGHT && next < rows.length) {
        const r = rows[next++];
        q.push((async () => { if (hold) { try { await hold(); } catch { /* 그냥 굽는다 */ } } return render.exportSet(r.photo.id, want(r)); })().then(v => ({ v }), e => ({ e })));
      }
    };
    for (let i = 0; i < rows.length; i++) {
      pump();
      const { v, e } = await q.shift();
      if (signal?.aborted) throw stopErr();
      const r = rows[i];
      if (e || !v?.sheet) { console.warn('내보낼 사진을 만들지 못했어요', r.photo.id, e); skipped++; tell(++done, total); continue; }
      if (withPhotos) { await holdOk(); await zip.z.add(`사진/${names[i]}`, await bytesOf(v.full)); }   // 앱: 사진 파일 쓰기(브리지)도 쉴 때(다른 화면을 만지는 중이면)
      photos++;
      sheetImg.set(r.photo.id, v.sheet);
      if (v.thumb) thumbs.set(r.record.id, v.thumb);
      tell(++done, total);
    }
    // 첫 사진을 못 만든 묶음 — 다음으로 만든 사진으로 대표 사진(대개 캐시에서 줄이기만)
    for (const r of rows) {
      if (thumbs.has(r.record.id) || !sheetImg.has(r.photo.id)) continue;
      try { const t = await render.exportSet(r.photo.id, { full: false, thumb: THUMB_MAX }); if (t.thumb) thumbs.set(r.record.id, t.thumb); } catch { /* 대표 사진 없이 */ }
    }
    // ② 위치도 — 사진 다음에(실패해도 내보내기는 계속)
    const maps = [];
    const dupOf = new Map();
    for (const g of lm.groups) {
      if (signal?.aborted) throw stopErr();
      try {
        const m = await renderGroup(lm.dw, g, { site, dupOf, seqOf: rec => seqOf.get(rec.id) });
        if (m) { if (withPhotos) await zip.z.add(m.name, await bytesOf(m.jpeg)); maps.push(m); } else locmapSkipped++;
      } catch (e) { console.warn('위치도를 만들지 못했어요', g.drawing?.id, g.page, e); locmapSkipped++; }
      tell(++done, total);
    }
    // ③ xlsx — 나눈 파일마다(묶기는 워커)
    const X = await import('../media/xlsxworker.js');
    let single = null;
    for (const [k, part] of parts.entries()) {
      if (signal?.aborted) throw stopErr();
      const ok = part.filter(r => sheetImg.has(r.photo.id));
      const frames = ok.map(r => ({ date: sheetDate(r.record.day), content: sheetContent(r.record), photo: sheetImg.get(r.photo.id) }));
      // 대장: 나눈 파일마다 그 파일에 든 묶음만(사진 없는 글 묶음은 첫 파일에)
      const here = new Set(part.map(x => x.record.id));
      const recs = s.records.filter(rec => here.has(rec.id) || (k === 0 && !hasPhoto.has(rec.id)));
      const ledger = ledgerRows(recs, ok, { seqOf: rec => seqOf.get(rec.id) }).map(l => ({ cells: l.cells, thumb: l.firstPhotoId ? (thumbs.get(l.record.id) || null) : null }));
      const x = await X.buildXlsx({
        tpl, meta, site: frames.length ? (ok[0].record.site || site) : site, frames, ledger, now,
        maps: k === 0 ? maps.map(m => ({ name: m.name, jpeg: m.jpeg, w: m.w, h: m.h })) : [],   // 첫 파일에만 '위치도' 시트(나눠진 xlsx 에 같은 그림을 겹쳐 넣지 않게)
      });
      const name = xlsxName(from, to, k + 1, parts.length, fileSite);
      if (zip) await zip.z.add(name, await bytesOf(x.blob));
      else single = { name, blob: x.blob, size: x.size };
      tell(++done, total);
    }
    if (signal?.aborted) throw stopErr();
    // ④ 내놓기 — ZIP 은 흐름 쓰기를 마치고, xlsx 하나는 앱이면 CACHE 에(공유·저장), 웹이면 Blob
    let out;
    if (zip) {
      const { size } = await zip.z.finish();
      out = { name: zipName(from, to), size, ...(await zip.sink.finish(size)) };
    } else if (N.isNative()) {
      const path = `${dir}/${single.name}`;
      await holdOk();                                                        // xlsx 수 MB 를 384KB 조각으로 — 조각마다 쉴 때(hold), 다른 화면을 만지는 동안 브리지를 잡지 않게
      out = { name: single.name, size: single.size, uri: await N.writeShareFile(path, single.blob, { verify: true, chunk: SHARE_CHUNK, hold: hold ? holdOk : null }), path };
    } else out = { name: single.name, size: single.size, blob: single.blob };
    const res = { ...out, format: fmt, photos, records: s.records.length, parts: parts.length, skipped, notReady: s.notReady, locmaps: maps.length, locmapSkipped, sig };
    keepLast(!skipped && (!res.blob || res.size <= REUSE_WEB_MAX) ? { key, res } : null);   // 빠진 사진이 있으면 다시 쓰지 않는다(다음엔 될 수 있다)
    return res;
  } catch (e) {
    if (zip) await zip.sink.abort().catch(() => {});
    throw e;
  }
}

// ---- 저장·공유 ----
// how: 'share' | 'save'. 앱: share = 공유 시트, save = 문서/현장사진대지 lite/내보내기/. 웹: zip·xlsx 는 크롬 Web Share 가 받지 않아(설계 비평 기술 #4)
// 공유 가능할 때만 navigator.share, 아니면 내려받기 → { ok, where?, cancelled?, error? }
export async function deliver(result, how = 'share') {
  return deliverFile(result, how, '내보내기');
}

const typeOf = r => r?.blob?.type || (/\.xlsx$/i.test(r?.name || '') ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' : 'application/zip');
export async function deliverFile(result, how, folder) {
  if (!result) return { ok: false, error: '만든 파일이 없어요' };
  if (N.isNative() && (result.path || result.uri)) {
    if (how === 'share') {
      const r = await N.shareFiles([result.uri], { title: result.name });
      return r.ok ? { ok: true, where: 'share' } : r;
    }
    try {
      await N.copyToDocuments(result.path ? { path: result.path } : result.uri, `${folder}/${result.name}`);
      return { ok: true, where: `문서/${N.DOC_ROOT}/${folder}` };
    } catch (e) { return { ok: false, error: e?.message || String(e) }; }
  }
  if (!result.blob) return { ok: false, error: '만든 파일이 없어요' };
  if (how === 'share') {
    const file = new File([result.blob], result.name, { type: typeOf(result) });
    const r = await webShareFiles([file], { title: result.name });
    if (r.ok || r.cancelled) return r;
  }
  downloadBlob(result.blob, result.name);
  return { ok: true, where: 'download' };
}
