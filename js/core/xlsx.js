// 틀(photo-sheet.xlsx 의 파트) + 데이터 → 사진대지·대장 xlsx 파트 목록. 순수 함수(DOM·Capacitor 없음).
// 원본 현장사진대지 core/xlsx.js 이식(기하 계산은 공시체 record.js 에서 온 검증된 값 그대로).
// lite 에서 달라진 점: 대장 시트의 머리·열 너비를 코드에서 다시 쓴다(틀 파일은 그대로, 열은 core/ledger.js LEDGER).
import { esc, dec, enc } from './xml.js';
import { fitContent, LEDGER } from './ledger.js';   // 「내용」 칸 글자 맞춤 규칙은 ledger.js 한 곳에만 둔다

export const EMU_PX = 9525;
const MDW = 8;                    // 맑은 고딕 11pt 의 최대 숫자 폭(px) — 완성본 6126480 EMU 실측 역산. 7 이면 틀린다
const PHOTO_PAD = 3, THUMB_PAD = 2;

export function jpegSize(u8) {
  if (!u8 || u8.length < 4 || u8[0] !== 0xFF || u8[1] !== 0xD8) return null;
  let i = 2;
  while (i + 9 < u8.length) {
    if (u8[i] !== 0xFF) { i++; continue; }
    const m = u8[i + 1];
    if (m === 0xFF) { i++; continue; }
    if (m === 0xD8 || (m >= 0xD0 && m <= 0xD7) || m === 0x01) { i += 2; continue; }
    if (m === 0xD9 || m === 0xDA) return null;
    const len = (u8[i + 2] << 8) | u8[i + 3];
    if (len < 2) return null;
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      const h = (u8[i + 5] << 8) | u8[i + 6];
      const w = (u8[i + 7] << 8) | u8[i + 8];
      return (w > 0 && h > 0) ? { w, h } : null;
    }
    i += 2 + len;
  }
  return null;
}
export const colPx = (width) => Math.trunc(((256 * width + Math.trunc(128 / MDW)) / 256) * MDW);
export const ptPx = (pt) => pt * 96 / 72;
export function fitRect(boxW, boxH, imgW, imgH, pad) {
  const p = pad || 0;
  const aw = Math.max(1, boxW - 2 * p), ah = Math.max(1, boxH - 2 * p);
  const s = Math.min(aw / imgW, ah / imgH);
  const w = Math.max(1, Math.floor(imgW * s)), h = Math.max(1, Math.floor(imgH * s));
  return { x: Math.round((boxW - w) / 2), y: Math.round((boxH - h) / 2), w, h };
}
function walk(start, px, sizeAt) {
  let i = start, rem = px, guard = 0;
  while (guard++ < 10000) { const s = sizeAt(i); if (rem < s) break; rem -= s; i++; }
  return { idx: i, off: Math.max(0, Math.round(rem)) };
}
const markerXml = (tag, c, cOff, r, rOff) =>
  '<xdr:' + tag + '><xdr:col>' + c + '</xdr:col><xdr:colOff>' + cOff + '</xdr:colOff><xdr:row>' + r + '</xdr:row><xdr:rowOff>' + rOff + '</xdr:rowOff></xdr:' + tag + '>';
function picXml(id, name, rId, cx, cy) {
  return '<xdr:pic><xdr:nvPicPr><xdr:cNvPr id="' + id + '" name="' + esc(name) + '"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>' +
    '<xdr:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="' + rId + '"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>' +
    '<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="' + cx + '" cy="' + cy + '"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic>';
}
const WSDR_OPEN = '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">';
const XMLH = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export const ROWS_PER_PAGE = 8;

// 문서 속성 시각 — ISO 문자열·ms 숫자·Date 무엇이 와도 W3CDTF(초까지, Z)로. 잘못된 값이면 지금
const iso = v => { const d = new Date(v ?? Date.now()); return (Number.isNaN(d.getTime()) ? new Date() : d).toISOString().replace(/\.\d+Z$/, 'Z'); };
// 엑셀 칸 글자 한도(32,767) — 넘으면 자르고 '…'
const cellText = s => { s = String(s); if (s.length <= 32767) return s; let out = ''; for (const ch of s) { if (out.length + ch.length > 32766) break; out += ch; } return out + '…'; };

const shiftRows = (xml, off) => (off === 0 ? xml : xml
  .replace(/<row r="(\d+)"/g, (m, n) => '<row r="' + (+n + off) + '"')
  .replace(/<c r="([A-Z]+)(\d+)"/g, (m, c, n) => '<c r="' + c + (+n + off) + '"'));
const shiftRef = (ref, off) => ref.replace(/([A-Z]+)(\d+)/g, (m, c, n) => c + (+n + off));

/** 틀 시트 XML 의 1~8행 블록을 쪽 수만큼 복제하고 병합·dimension·rowBreaks·drawing 을 맞춘다. */
export function clonePages(tplSheetXml, meta, pages, withDrawing, fillPage) {
  const rows = tplSheetXml.match(/<row r="\d+"[^>]*>[\s\S]*?<\/row>/g);
  if (!rows || rows.length !== ROWS_PER_PAGE) throw new Error('틀의 1~8행을 못 읽었어요');
  const parts = [], merges = [];
  for (let p = 0; p < pages; p++) {
    const off = p * ROWS_PER_PAGE;
    const block = fillPage ? fillPage(rows.join(''), p) : rows.join('');
    parts.push(shiftRows(block, off));
    meta.page.merges.forEach((m) => merges.push(shiftRef(m, off)));
  }
  const last = pages * ROWS_PER_PAGE;
  const xml = tplSheetXml
    .replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:D' + last + '"/>')
    .replace(/<sheetData>[\s\S]*<\/sheetData>/, () => '<sheetData>' + parts.join('') + '</sheetData>')
    .replace(/<mergeCells[\s\S]*?<\/mergeCells>/, () => '<mergeCells count="' + merges.length + '">' + merges.map((m) => '<mergeCell ref="' + m + '"/>').join('') + '</mergeCells>');
  // CT_Worksheet 순서: … mergeCells → printOptions → pageMargins → pageSetup → headerFooter → rowBreaks → colBreaks → … → drawing  (어기면 엑셀 「복구」)
  let tail = '';
  if (pages > 1) {
    const brk = []; for (let p = 1; p < pages; p++) brk.push('<brk id="' + p * ROWS_PER_PAGE + '" max="16383" man="1"/>');
    tail += '<rowBreaks count="' + brk.length + '" manualBreakCount="' + brk.length + '">' + brk.join('') + '</rowBreaks>';
  }
  if (withDrawing) tail += '<drawing r:id="rId1"/>';
  return xml.replace('</worksheet>', () => tail + '</worksheet>');
}

/** 값 칸(스타일만 있는 빈 셀 <c r="B3" s="9"/>)에 글자를 넣는다. 스타일을 바꾸려면 sOverride */
export function setText(xml, ref, text, sOverride) {
  const re = new RegExp('<c r="' + ref + '" s="(\\d+)"/>');
  if (!re.test(xml)) throw new Error('빈 칸 ' + ref + ' 을 못 찾았어요');
  return xml.replace(re, (m, s) => '<c r="' + ref + '" s="' + (sOverride ?? s) + '" t="inlineStr"><is><t xml:space="preserve">' + esc(text) + '</t></is></c>');
}

/** 사진대지 사진 앵커 — 한 칸(A~D 병합, 644×364px)에 JPEG 비율을 지켜 가운데. frameRow = 0-based 행(= 8p + 4h + 1) */
function photoAnchor(geom, frameRow, img, id, rId) {
  const r = fitRect(geom.boxW, geom.boxH, img.w, img.h, PHOTO_PAD);
  const from = walk(0, r.x, geom.colAt), to = walk(0, r.x + r.w, geom.colAt);
  const y1 = r.y + r.h;
  const toRow = y1 >= geom.boxH ? { idx: frameRow + 1, off: 0 } : { idx: frameRow, off: y1 };
  return '<xdr:twoCellAnchor editAs="oneCell">' +
    markerXml('from', from.idx, from.off * EMU_PX, frameRow, Math.round(r.y * EMU_PX)) +
    markerXml('to', to.idx, to.off * EMU_PX, toRow.idx, Math.round(toRow.off * EMU_PX)) +
    picXml(id, '사진 ' + (id - 1), rId, r.w * EMU_PX, r.h * EMU_PX) + '<xdr:clientData/></xdr:twoCellAnchor>';
}
/** 대장 대표 사진 — oneCellAnchor. 한 칸(열 col, 행 row0 0-based)에 맞춤 */
function thumbAnchor(boxW, boxH, col, row0, img, id, rId) {
  const r = fitRect(boxW, boxH, img.w, img.h, THUMB_PAD);
  return '<xdr:oneCellAnchor>' + markerXml('from', col, Math.round(r.x * EMU_PX), row0, Math.round(r.y * EMU_PX)) +
    '<xdr:ext cx="' + r.w * EMU_PX + '" cy="' + r.h * EMU_PX + '"/>' + picXml(id, '대표 사진 ' + (id - 1), rId, r.w * EMU_PX, r.h * EMU_PX) + '<xdr:clientData/></xdr:oneCellAnchor>';
}

const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = (id, type, tgt) => '<Relationship Id="' + id + '" Type="' + NS_REL + '/' + type + '" Target="' + tgt + '"/>';
const RELS = (inner) => XMLH + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' + inner + '</Relationships>';
const CT_DR = 'application/vnd.openxmlformats-officedocument.drawing+xml';
const colName = (i) => String.fromCharCode(65 + i);
const inl = (ref, s, v) => '<c r="' + ref + '" s="' + s + '" t="inlineStr"><is><t xml:space="preserve">' + esc(cellText(v)) + '</t></is></c>';

// 대장 시트 머리·열 너비를 spec 으로 다시 쓴다 — 틀의 12열(원본 앱 것) 대신 lite 9열
function ledgerFrame(xml, spec, headStyle, headHeight, lastRow) {
  const cols = '<cols>' + spec.widths.map((w, i) => '<col min="' + (i + 1) + '" max="' + (i + 1) + '" width="' + w + '" customWidth="1"/>').join('') + '</cols>';
  const head = '<row r="1" ht="' + headHeight + '" customHeight="1">' + spec.head.map((t, i) => inl(colName(i) + '1', headStyle, t)).join('') + '</row>';
  return xml
    .replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:' + colName(spec.head.length - 1) + lastRow + '"/>')
    .replace(/<cols>[\s\S]*?<\/cols>/, () => cols)
    .replace(/<row r="1"[^>]*>[\s\S]*?<\/row>/, () => head);
}

/**
 * tpl: Map<name, Uint8Array> (photo-sheet.xlsx 의 파트), meta: photo-sheet.meta.json
 * data = {
 *   site: '현장명',
 *   frames: [{ date: 'YYYY.MM.DD', content: '위치 · 내용', photo: Uint8Array(JPEG) | null }, …],   // 위·아래 칸 순서대로
 *   ledger: [{ cells: [LEDGER.head 길이만큼], thumb: Uint8Array(JPEG) | null }, …],
 *   ledgerSpec?: LEDGER, now
 * }  → { entries [{name, data}] (makeZipBytes 에 그대로), pages, images }
 */
export function buildWorkbook(tpl, meta, data) {
  const t = (n) => { const d = tpl.get(n); if (!d) throw new Error('틀에 ' + n + ' 이 없어요'); return dec.decode(d); };
  const out = new Map();
  tpl.forEach((d, n) => out.set(n, d));
  const put = (n, d) => out.set(n, typeof d === 'string' ? enc.encode(d) : d);

  const frames = data.frames || [];
  const pages = Math.max(1, Math.ceil(frames.length / 2));          // 사진 0장이어도 빈 틀 1쪽 — 시트 0장 통합문서는 엑셀이 못 연다
  const photoFile = meta.sheets.photoFile, ledgerFile = meta.sheets.ledgerFile;
  const site = data.site || '';

  // ---- 사진대지 ----
  const hasPhoto = frames.some((f) => f.photo);
  const colPxs = meta.page.colWidths.map(colPx);
  const geom = { boxW: colPxs.reduce((a, b) => a + b, 0), boxH: ptPx(meta.page.rowHeights[1]), colAt: (c) => (c < colPxs.length ? colPxs[c] : colPx(9)) };
  let imgN = 0; const drawing1 = [], rels1 = [];
  const fillPage = (blk, p) => {                                  // 틀 좌표(1~8행)로 채운다 — 위 칸은 3·4행, 아래 칸은 7·8행
    [[0, 3], [1, 7]].forEach(([h, r]) => {
      const f = frames[p * 2 + h];
      if (!f) return;                                             // 홀수 장이면 마지막 아래 칸은 라벨만
      blk = setText(blk, 'B' + r, site);
      blk = setText(blk, 'D' + r, f.date || '');
      const fit = fitContent(f.content);
      blk = setText(blk, 'B' + (r + 1), fit.text, meta.styles.content[fit.size]);
      if (f.photo) {
        const n = ++imgN, rId = 'rId' + (rels1.length + 1);
        put('xl/media/image' + n + '.jpg', f.photo);
        rels1.push(REL(rId, 'image', '../media/image' + n + '.jpg'));
        drawing1.push(photoAnchor(geom, p * ROWS_PER_PAGE + h * 4 + 1, jpegSize(f.photo) || { w: 4, h: 3 }, drawing1.length + 2, rId));
      }
    });
    return blk;
  };
  put(photoFile, clonePages(t(photoFile), meta, pages, hasPhoto, fillPage));
  const ctOverrides = [];
  const photoSheetRels = photoFile.replace('worksheets/', 'worksheets/_rels/') + '.rels';
  if (hasPhoto) {
    put('xl/drawings/drawing1.xml', XMLH + WSDR_OPEN + drawing1.join('') + '</xdr:wsDr>');
    put('xl/drawings/_rels/drawing1.xml.rels', RELS(rels1.join('')));
    put(photoSheetRels, RELS(REL('rId1', 'drawing', '../drawings/drawing1.xml')));
    ctOverrides.push('<Override PartName="/xl/drawings/drawing1.xml" ContentType="' + CT_DR + '"/>');
  }

  // ---- 대장 ----
  const spec = data.ledgerSpec || LEDGER, S = meta.styles, L = meta.ledger;
  const left = new Set(spec.left || []);
  const thumbW = colPx(spec.widths[spec.thumbCol]), rowPx = ptPx(L.rowHeight);
  const rowsXml = [], drawing2 = [], rels2 = [];
  (data.ledger || []).forEach((row, i) => {
    const r = i + 2;
    const cells = spec.head.map((_, c) => {
      const v = row.cells[c];
      const ref = colName(c) + r;
      const style = left.has(c) ? S.ledgerLeft : S.ledgerCenter;
      // 숫자 칸에 NaN·Infinity 를 쓰면 엑셀이 파일을 못 연다 — 유한한 숫자만 값으로, 아니면 빈 칸
      if (v === '' || v == null || (typeof v === 'number' && !Number.isFinite(v))) return '<c r="' + ref + '" s="' + style + '"/>';
      if (typeof v === 'number') return '<c r="' + ref + '" s="' + style + '"><v>' + v + '</v></c>';
      return inl(ref, style, v);
    }).join('');
    rowsXml.push('<row r="' + r + '" ht="' + L.rowHeight + '" customHeight="1">' + cells + '</row>');
    if (row.thumb) {
      const n = ++imgN, rId = 'rId' + (rels2.length + 1);
      put('xl/media/image' + n + '.jpg', row.thumb);
      rels2.push(REL(rId, 'image', '../media/image' + n + '.jpg'));
      drawing2.push(thumbAnchor(thumbW, rowPx, spec.thumbCol, r - 1, jpegSize(row.thumb) || { w: 4, h: 3 }, drawing2.length + 2, rId));
    }
  });
  const lastRow = (data.ledger || []).length + 1;
  let lsheet = ledgerFrame(t(ledgerFile), spec, S.ledgerHead, L.headHeight, lastRow)
    .replace('</sheetData>', () => rowsXml.join('') + '</sheetData>');
  if (drawing2.length) lsheet = lsheet.replace('</worksheet>', () => '<drawing r:id="rId1"/></worksheet>');
  put(ledgerFile, lsheet);
  const ledgerRels = ledgerFile.replace('worksheets/', 'worksheets/_rels/') + '.rels';
  if (drawing2.length) {
    put('xl/drawings/drawing2.xml', XMLH + WSDR_OPEN + drawing2.join('') + '</xdr:wsDr>');
    put('xl/drawings/_rels/drawing2.xml.rels', RELS(rels2.join('')));
    put(ledgerRels, RELS(REL('rId1', 'drawing', '../drawings/drawing2.xml')));
    ctOverrides.push('<Override PartName="/xl/drawings/drawing2.xml" ContentType="' + CT_DR + '"/>');
  }

  // ---- workbook: 인쇄 영역을 마지막 쪽까지 ----
  put('xl/workbook.xml', t('xl/workbook.xml').replace(/\$A\$1:\$D\$\d+/, '$A$1:$D$' + pages * ROWS_PER_PAGE));
  // ---- Content_Types: 드로잉 Override 추가(jpg Default 는 틀에 있음) ----
  let ct = t('[Content_Types].xml');
  if (imgN && !/Extension="jpg"/i.test(ct)) ct = ct.replace(/<Types[^>]*>/, m => m + '<Default Extension="jpg" ContentType="image/jpeg"/>');
  put('[Content_Types].xml', ct.replace('</Types>', () => ctOverrides.join('') + '</Types>'));
  // ---- 문서 속성: 수정 시각 ----
  put('docProps/core.xml', t('docProps/core.xml').replace(/(<dcterms:modified[^>]*>)[^<]*/, (m, a) => a + iso(data.now)));

  const entries = [{ name: '[Content_Types].xml', data: out.get('[Content_Types].xml') }];
  out.forEach((d, n) => { if (n !== '[Content_Types].xml') entries.push({ name: n, data: d }); });
  return { entries, pages, images: imgN };
}
