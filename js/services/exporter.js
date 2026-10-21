// 사진대지 내보내기 — 원본 export.js + core/ledger·xlsx 를 lite 에 맞게(SPEC §5.6).
// ZIP 하나에 사진대지 xlsx + 사진/MMDD_<위치>_<n>.jpg. 사진은 render.exportJpeg(워터마크 설정 반영) 한 번만 굽고,
// 같은 그림을 줄여 xlsx 칸(긴 변 1000px)·대장 대표 사진(480px)에도 넣는다 — 보이는 그대로 내보낸다(설계 비평 #7).
// 100장 넘으면 막지 않고 xlsx 를 100장씩 나눠 한 ZIP 에(설계 비평 #11). ZIP 은 흐름 쓰기(앱: CACHE 파일, 웹: Blob 조각).
import * as store from '../data/store.js';
import * as render from '../media/render.js';
import * as N from '../platform/native.js';
import { MAX_EXPORT_PHOTOS } from '../config.js';
import { selectExport, splitParts, zipName, xlsxName, photoFileNames, sheetContent, sheetDate, ledgerRows } from '../core/ledger.js';
import { buildWorkbook } from '../core/xlsx.js';
import { makeZipBytes, ZipStream, parseZip } from '../core/zip.js';
import { downloadBlob, webShareFiles } from './share.js';

const SHEET_MAX = 1000, THUMB_MAX = 480;

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

// → { days, records, photoCount, over, parts, notReady, noLocation }
// over = 100장 초과(막지 않는다 — parts 개 xlsx 로 나눈다). notReady = 처리 중·실패라 빠지는 사진, noLocation = 위치 미입력 묶음
export function plan({ from, to, recordIds = null }) {
  const s = select({ from, to, recordIds });
  return {
    days: s.days, records: s.records, photoCount: s.photoCount,
    over: s.photoCount > MAX_EXPORT_PHOTOS, parts: Math.max(1, Math.ceil(s.photoCount / MAX_EXPORT_PHOTOS)),
    notReady: s.notReady, noLocation: s.noLocation,
  };
}

// ---- 그림 줄이기(브라우저) — toDataURL 이 toBlob 보다 빠르다(갤럭시 A55 실측, SPEC §4.3) ----
async function shrink(jpeg, max, q = 0.85) {
  let bmp;
  try { bmp = await createImageBitmap(new Blob([jpeg], { type: 'image/jpeg' })); }
  catch { return jpeg; }                                                     // 못 풀면 그대로(엑셀은 원본 크기로도 열린다)
  try {
    const s = Math.min(1, max / Math.max(bmp.width, bmp.height));
    if (s >= 1) return jpeg;
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(bmp.width * s)); c.height = Math.max(1, Math.round(bmp.height * s));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    const b64 = c.toDataURL('image/jpeg', q).split(',')[1];
    c.width = c.height = 0;
    return N.b64ToBytes(b64);
  } finally { bmp.close?.(); }
}

// ---- 만들기 ----
let queue = Promise.resolve();                                               // 한 번에 하나씩(두 번 눌러도 겹치지 않게)
export function build(opts, onProgress) {
  const p = queue.then(() => buildNow(opts, onProgress));
  queue = p.then(() => {}, () => {});
  return p;
}

let seq = 0;
async function buildNow({ from, to, recordIds = null, now = Date.now() }, onProgress) {
  const s = select({ from, to, recordIds });
  if (!s.records.length) throw Object.assign(new Error('이 기간에는 기록이 없어요'), { code: 'EMPTY' });
  const { tpl, meta } = await loadTemplate();
  const name = zipName(from, to);
  const sink = N.zipSink(`export/${now}-${++seq}/${name}`);
  const tell = (d, t) => { try { onProgress?.(d, t); } catch (e) { console.error(e); } };
  const names = photoFileNames(s.rows);
  const parts = splitParts(s.rows, MAX_EXPORT_PHOTOS);
  const withPhotos = new Set(s.rows.map(x => x.record.id));
  const total = s.rows.length + parts.length;
  let done = 0, skipped = 0, photos = 0;
  try {
    const zip = new ZipStream(sink.write, { date: new Date(now) });
    const sheetImg = new Map(), thumbs = new Map();                          // 사진 id → 줄인 그림, 묶음 id → 대표 사진
    for (const [i, r] of s.rows.entries()) {
      let jpeg;
      try { jpeg = await render.exportJpeg(r.photo.id); }
      catch (e) { console.warn('내보낼 사진을 만들지 못했어요', r.photo.id, e); skipped++; tell(++done, total); continue; }
      await zip.add(`사진/${names[i]}`, jpeg);
      photos++;
      sheetImg.set(r.photo.id, await shrink(jpeg, SHEET_MAX));
      if (!thumbs.has(r.record.id)) thumbs.set(r.record.id, await shrink(jpeg, THUMB_MAX, 0.8));
      jpeg = null;
      tell(++done, total);
    }
    const site = store.settings().siteName || '';
    for (const [k, rows] of parts.entries()) {
      const ok = rows.filter(r => sheetImg.has(r.photo.id));
      const frames = ok.map(r => ({ date: sheetDate(r.record.day), content: sheetContent(r.record), photo: sheetImg.get(r.photo.id) }));
      // 대장: 나눈 파일마다 그 파일에 든 묶음만(사진 없는 글 묶음은 첫 파일에)
      const here = new Set(rows.map(x => x.record.id));
      const recs = s.records.filter(rec => here.has(rec.id) || (k === 0 && !withPhotos.has(rec.id)));
      const ledger = ledgerRows(recs, ok).map(l => ({ cells: l.cells, thumb: l.firstPhotoId ? (thumbs.get(l.record.id) || null) : null }));
      const wb = buildWorkbook(tpl, meta, { site: frames.length ? (ok[0].record.site || site) : site, frames, ledger, now });
      await zip.add(xlsxName(from, to, k + 1, parts.length), makeZipBytes(wb.entries, { date: new Date(now) }));
      tell(++done, total);
    }
    const { size } = await zip.finish();
    const out = await sink.finish(size);
    return { name, size, ...out, photos, records: s.records.length, parts: parts.length, skipped, notReady: s.notReady };
  } catch (e) {
    await sink.abort().catch(() => {});
    throw e;
  }
}

// ---- 저장·공유 ----
// how: 'share' | 'save'. 앱: share = 공유 시트, save = 문서/현장사진대지 lite/내보내기/. 웹: zip·xlsx 는 크롬 Web Share 가 받지 않아(설계 비평 기술 #4)
// 공유 가능할 때만 navigator.share, 아니면 내려받기 → { ok, where?, cancelled?, error? }
export async function deliver(result, how = 'share') {
  return deliverFile(result, how, '내보내기');
}

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
    const file = new File([result.blob], result.name, { type: result.blob.type || 'application/zip' });
    const r = await webShareFiles([file], { title: result.name });
    if (r.ok || r.cancelled) return r;
  }
  downloadBlob(result.blob, result.name);
  return { ok: true, where: 'download' };
}
