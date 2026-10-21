// 사진대지 내보내기 대상 고르기·정렬·파일 이름·칸 글자 — 순수 함수(원본 core/ledger.js 를 lite 묶음 모델로).
// lite: 날짜는 record.day(관리 날짜), 동·층·공종·보냄 상태 없음. 대장 열은 번호/날짜/시각/위치/내용/사진 수/위도/경도/대표 사진(SPEC §5.6).
import { hm } from './date.js';
import { oneLine } from './watermark.js';

export const LEDGER = Object.freeze({
  head: ['번호', '날짜', '시각', '위치', '내용', '사진 수', '위도', '경도', '대표 사진'],
  widths: [12, 11, 7, 26, 46, 7, 11, 11, 22],
  left: [3, 4],                                                              // 위치·내용은 왼쪽 맞춤, 나머지는 가운데
  thumbCol: 8,
});

// records: Record[], photos: Photo[] | Map<id, Photo>. 기간(record.day) 안의 살아 있는 묶음, 그 안의 ready 사진(묶음 순서).
// 정렬: day 오름차순 → createdAt 오름차순 → 묶음 안 사진 순서(SPEC §5.6)
// → { days, records, rows: [{ record, photo, no }], photoCount, notReady, noLocation }
export function selectExport({ records = [], photos = [], from, to, recordIds = null }) {
  const byId = photos instanceof Map ? photos : new Map(photos.map(p => [p.id, p]));
  const pick = recordIds ? new Set(recordIds) : null;
  const recs = records
    .filter(r => r && !r.deletedAt && r.day >= from && r.day <= to && (!pick || pick.has(r.id)))
    .sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : (a.createdAt || 0) - (b.createdAt || 0)));
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
// '사진대지_MMDD.xlsx' / '사진대지_MMDD-MMDD.xlsx', 나누면 '_1', '_2'
export function xlsxName(from, to, part = 1, parts = 1) {
  const a = md(from), b = md(to);
  const base = from === to ? `사진대지_${a.mmdd}` : `사진대지_${a.mmdd}-${b.mmdd}`;
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
// 대장 한 줄(9칸). photos = 이 내보내기에 들어가는 이 묶음의 ready 사진(순서대로). 대표 사진 칸은 비우고 firstPhotoId 를 따로 준다
export function ledgerCells(record, photos = []) {
  const first = photos[0] || null;
  const withGps = photos.find(p => p.gps && Number.isFinite(p.gps.lat));
  const at = first?.takenAt || record.createdAt;
  return {
    cells: [
      record.no || '', sheetDate(record.day), at ? hm(at) : '', String(record.location || '').trim(),
      String(record.content || '').trim(), photos.length,
      withGps ? coord(withGps.gps.lat) : '', withGps ? coord(withGps.gps.lng) : '', '',
    ],
    firstPhotoId: first ? first.id : null,
  };
}

// 묶음별 대장 줄 — rows(이 xlsx 에 들어가는 사진) 기준, 사진 없는 묶음(글만)도 records 에 있으면 0장으로 한 줄
export function ledgerRows(records, rows) {
  const by = new Map(records.map(r => [r.id, []]));
  for (const x of rows) { if (!by.has(x.record.id)) by.set(x.record.id, []); by.get(x.record.id).push(x.photo); }
  const order = [...new Map([...records, ...rows.map(x => x.record)].map(r => [r.id, r])).values()];
  return order.map(r => ({ record: r, ...ledgerCells(r, by.get(r.id) || []) }));
}

