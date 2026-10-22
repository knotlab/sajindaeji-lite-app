// 사진대지 내보내기 대상 고르기·정렬·파일 이름·칸 글자 — 순수 함수(원본 core/ledger.js 를 lite 묶음 모델로).
// lite: 날짜는 record.day(관리 날짜), 동·층·공종·보냄 상태 없음. 대장 열은 순번/관리번호/날짜/시각/위치/내용/사진 수/위도/경도/대표 사진(SPEC §5.6, v0.1.7).
// 순서(v0.1.7): 날짜 → 그 날 사진대지 순서(record.order, 없으면 만든 시각 — core/order.js 하나) → 묶음 안 사진 순서(photoIds).
//   사진대지·대장·카톡 글·위치도가 같은 순서를 쓴다. 순번은 그 순서의 1..N(내보내기 전체 — 나눈 파일도 이어서), 관리번호(record.no)는 그대로.
import { hm } from './date.js';
import { oneLine } from './watermark.js';
import { compareByDay, orderOf } from './order.js';

export const LEDGER = Object.freeze({
  head: ['순번', '관리번호', '날짜', '시각', '위치', '내용', '사진 수', '위도', '경도', '대표 사진'],
  widths: [6, 12, 11, 7, 26, 46, 7, 11, 11, 22],
  left: [4, 5],                                                              // 위치·내용은 왼쪽 맞춤, 나머지는 가운데
  thumbCol: 9,
});

// records: Record[], photos: Photo[] | Map<id, Photo>. 기간(record.day) 안의 살아 있는 묶음, 그 안의 ready 사진(묶음 순서).
// → { days, records, rows: [{ record, photo, no }], photoCount, notReady, noLocation }
export function selectExport({ records = [], photos = [], from, to, recordIds = null }) {
  const byId = photos instanceof Map ? photos : new Map(photos.map(p => [p.id, p]));
  const pick = recordIds ? new Set(recordIds) : null;
  const recs = records
    .filter(r => r && !r.deletedAt && r.day >= from && r.day <= to && (!pick || pick.has(r.id)))
    .sort((a, b) => compareByDay(a, b));
  const rows = [], keep = [];
  let notReady = 0, noLocation = 0;
  for (const r of recs) {
    const mine = [];
    (r.photoIds || []).forEach((pid, i) => {
      const p = byId.get(pid);
      if (!p || p.deletedAt) return;
      if (p.state !== 'ready') { notReady++; return; }
      mine.push({ record: r, photo: p, no: i + 1 });
    });
    if (!mine.length && !String(r.content || '').trim()) continue;   // 사진도 내용도 없는 묶음(위치만)은 뺀다
    keep.push(r);
    rows.push(...mine);
    if (mine.length && !String(r.location || '').trim()) noLocation++;
  }
  const days = [...new Set(keep.map(r => r.day))];
  return { days, records: keep, rows, photoCount: rows.length, notReady, noLocation };
}

// 사진이 max 장을 넘으면 xlsx 를 나눈다(설계 비평 #11 — 막지 않고 100장씩). 묶음 중간에서 끊길 수 있다(사진대지는 한 장에 2칸이라 문제없음)
export function splitParts(rows, max = 100) {
  if (rows.length <= max) return [rows];
  const out = [];
  for (let i = 0; i < rows.length; i += max) out.push(rows.slice(i, i + max));
  return out;
}

export const safeName = s => String(s ?? '').replace(/[\u0000-\u001f]/g, '').replace(/[\/\\:*?"<>|]/g, '.').replace(/\s+/g, ' ').trim();

const md = key => { const [, m, d] = String(key).split('-').map(Number); return { m, d, mmdd: `${String(m).padStart(2, '0')}${String(d).padStart(2, '0')}` }; };
// 'M월 D일 현장사진.zip' / 'M월 D일~M월 D일 현장사진.zip'
export function zipName(from, to) {
  const a = md(from), b = md(to);
  return from === to ? `${a.m}월 ${a.d}일 현장사진.zip` : `${a.m}월 ${a.d}일~${b.m}월 ${b.d}일 현장사진.zip`;
}
// 파일 이름에 넣는 현장명 — 12자, 파일에 못 쓰는 글자는 '.', 앞의 점은 뺀다(숨김 파일이 되지 않게). 없으면 ''
export const siteTag = site => Array.from(safeName(site).replace(/^\.+/, '')).slice(0, 12).join('').trim();
// '사진대지_<현장명 12자>_MMDD.xlsx' / '…_MMDD-MMDD.xlsx', 나누면 '_1', '_2'. 현장명이 없으면 '사진대지_MMDD.xlsx'
// (여러 현장 파일을 받는 감독관이 이름만 보고 가르게 — v0.1.7)
export function xlsxName(from, to, part = 1, parts = 1, site = '') {
  const a = md(from), b = md(to);
  const s = siteTag(site);
  const base = `사진대지_${s ? `${s}_` : ''}${from === to ? a.mmdd : `${a.mmdd}-${b.mmdd}`}`;
  return parts > 1 ? `${base}_${part}.xlsx` : `${base}.xlsx`;
}

// 'MMDD_<위치>_<n>.jpg' — 같은 날·같은 위치끼리 1부터. 위치는 30자로 자른다(경로가 너무 길면 압축 프로그램이 못 푼다)
export function photoFileNames(rows) {
  const used = new Map();
  return rows.map(r => {
    const loc = Array.from(safeName(r.record.location)).slice(0, 30).join('').trim() || '위치없음';
    const base = `${md(r.record.day).mmdd}_${loc}`;
    const n = (used.get(base) || 0) + 1;
    used.set(base, n);
    return `${base}_${n}.jpg`;
  });
}

export const sheetDate = day => String(day || '').replace(/-/g, '.');        // 'YYYY.MM.DD'
// 사진대지 「내용」 칸(B4) — 위치 · 내용을 한 줄로(원본 sheetContent 규칙)
export const sheetContent = record => oneLine([String(record.location || '').trim(), oneLine(record.content || '')].filter(Boolean).join(' · '));

// 칸 글자 수에 맞춰 글자 크기(원본 fitContent 그대로) — 80자 넘으면 79자 + '…'
export function fitContent(text) {
  const ch = Array.from(String(text ?? ''));
  const n = ch.length;
  if (n <= 40) return { text: ch.join(''), size: 11, truncated: false };
  if (n <= 60) return { text: ch.join(''), size: 10, truncated: false };
  if (n <= 80) return { text: ch.join(''), size: 9, truncated: false };
  return { text: ch.slice(0, 79).join('') + '…', size: 9, truncated: true };
}

const coord = v => (Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : '');
// 대장 한 줄(10칸). photos = 이 내보내기에 들어가는 이 묶음의 ready 사진(순서대로), seq = 순번(사진대지 순서 1..N — 모르면 빈 칸).
// 대표 사진 칸은 비우고 firstPhotoId 를 따로 준다. 「시각」은 가장 이른 촬영 시각(0.1.7 — 1번은 끌어서 정한 대표 사진이라 그 시각을 쓰면
//   대표를 바꿀 때 시각이 바뀌고 묶음 상세 「처음 HH:mm」과 어긋났다, 검토). 위도·경도는 순서대로 첫 GPS
export function ledgerCells(record, photos = [], seq = '') {
  const first = photos[0] || null;
  const withGps = photos.find(p => p.gps && Number.isFinite(p.gps.lat));
  const ts = photos.map(p => p.takenAt).filter(t => Number.isFinite(t) && t > 0);
  const at = ts.length ? Math.min(...ts) : record.createdAt;
  return {
    cells: [
      Number.isFinite(seq) ? seq : '', record.no || '', sheetDate(record.day), at ? hm(at) : '', String(record.location || '').trim(),
      String(record.content || '').trim(), photos.length,
      withGps ? coord(withGps.gps.lat) : '', withGps ? coord(withGps.gps.lng) : '', '',
    ],
    firstPhotoId: first ? first.id : null,
  };
}

// 묶음별 대장 줄 — rows(이 xlsx 에 들어가는 사진) 기준, 사진 없는 묶음(글만)도 records 에 있으면 0장으로 한 줄.
// seqOf(record) → 순번(나눈 파일도 내보내기 전체 순번을 이어 쓰게 — exporter 가 준다). 없으면 이 목록 안 1..n
export function ledgerRows(records, rows, { seqOf = null } = {}) {
  const by = new Map(records.map(r => [r.id, []]));
  for (const x of rows) { if (!by.has(x.record.id)) by.set(x.record.id, []); by.get(x.record.id).push(x.photo); }
  const list = [...new Map([...records, ...rows.map(x => x.record)].map(r => [r.id, r])).values()];
  return list.map((r, i) => {
    const s = typeof seqOf === 'function' ? seqOf(r) : i + 1;
    return { record: r, ...ledgerCells(r, by.get(r.id) || [], Number.isFinite(s) ? s : '') };
  });
}

// ---- 서명(v0.1.7 「보낸 뒤 바뀜」·만들어 둔 파일 다시 쓰기) ----
// 같은 서명 = 같은 사진대지(같은 묶음·순서·글·현장·핀, 같은 준비된 사진과 순서, 같은 현장명·워터마크 설정).
// records 는 내보내기 순서(selectExport 결과), rows = [{ record, photo }]. site = 설정 현장명, wm = 워터마크 설정(그대로 서명에 — [mode, when] 등)
const fnv = (s, h) => { for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16).padStart(8, '0'); };
const mix = (s, h) => { for (let i = 0; i < s.length; i++) { h = Math.imul(h ^ s.charCodeAt(i), 0x5bd1e995); h ^= h >>> 13; } return (h >>> 0).toString(16).padStart(8, '0'); };
export function exportSig({ records = [], rows = [], site = '', wm = null } = {}) {
  const ph = new Map();
  for (const x of rows || []) {
    const k = x?.record?.id;
    if (k == null || !x.photo) continue;
    if (!ph.has(k)) ph.set(k, []);
    ph.get(k).push(`${x.photo.id}:${x.photo.bytes || 0}`);
  }
  const body = JSON.stringify([1, String(site || ''), wm ?? null, (records || []).map(r => [
    r.id, r.day, orderOf(r), String(r.location || ''), String(r.content || ''), String(r.site || ''), r.pin?.pinId ?? null, ph.get(r.id) || [],
  ])]);
  return `${fnv(body, 0x811c9dc5)}${mix(body, 0x9747b28c)}${(body.length >>> 0).toString(36)}`;
}
