// 위치도 — 도면 스냅샷 위 번호 핀의 배치·범례·그림 구성·엑셀 시트(순수 함수, DOM 없음 — node 시험 가능).
// 설계: docs/위치도-설계.md. 그리기는 받은 ctx 만 쓴다(watermark.drawWatermark 와 같은 방식 — 워커 OffscreenCanvas·메인 canvas 둘 다).
//   record.pin = { snapId, docId, page, x, y, at }   x·y 는 스냅샷 그림 기준 0~1 비율(좌표 아님 — VWorld 와 무관)
//   핀 번호 = 그 날 묶음 순번(record.no 'YYMMDD-NN' 의 NN)
import { circled } from './model.js';
import { oneLine } from './watermark.js';
import { safeName } from './ledger.js';
import { esc } from './xml.js';

export const PIN_FILL = '#FFC400';          // 하이비스 노랑(컨셉 --hivis)
export const PIN_INK = '#000000';
export const PIN_HALO = '#FFFFFF';
export const LM_INK2 = '#474C52';           // 보조 글자(컨셉 --ink2, 햇빛·인쇄 가독성)
export const LM_RULE = '#C3C7C0';           // 연한 선(컨셉 --soft)
export const lmFont = (px, bold = true) => `${bold ? 800 : 600} ${px}px system-ui, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const clamp01 = v => clamp(Number(v), 0, 1);
const fin = v => typeof v === 'number' && Number.isFinite(v);

// ---------- 핀 데이터 ----------

// 'YYMMDD-NN' → NN(숫자). 100 넘는 순번도 그대로(뒤 두 자리로 자르지 않는다 — 001·101 이 겹치지 않게)
export function pinNo(record) {
  const m = /-(\d+)\s*$/.exec(String(record?.no ?? ''));
  return m ? Number(m[1]) : null;
}

// 저장할 핀 — 비율은 0~1 로 묶고 소수 5자리(2400px 그림에서 0.03px, 저장 크기는 작게)
export function makePin({ snapId, docId = null, page = 1, x, y, now = Date.now() } = {}) {
  if (!snapId) throw new Error('스냅샷이 없어요');
  if (!Number.isFinite(Number(x)) || !Number.isFinite(Number(y))) throw new Error('핀 자리가 이상해요');
  const r5 = v => Math.round(clamp01(v) * 1e5) / 1e5;
  return { snapId: String(snapId), docId: docId == null ? null : String(docId), page: Math.max(1, Math.round(Number(page) || 1)), x: r5(x), y: r5(y), at: now };
}

export const isPin = p => !!p && typeof p === 'object' && typeof p.snapId === 'string' && !!p.snapId
  && fin(p.x) && fin(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1;

// 그 날 그 스냅샷에 속한 핀 → [{ id, n, label, x, y, snapId, docId, page, record }] (번호 오름차순).
// snapId 를 안 주면 핀 있는 묶음 전부. 지운 묶음·깨진 핀은 뺀다
export function dayPins(records, { snapId = null } = {}) {
  const out = [];
  for (const r of records || []) {
    if (!r || r.deletedAt || !isPin(r.pin)) continue;
    if (snapId && r.pin.snapId !== snapId) continue;
    const n = pinNo(r);
    out.push({ id: r.id, n: n ?? 0, label: n != null ? String(n) : '?', x: r.pin.x, y: r.pin.y, snapId: r.pin.snapId, docId: r.pin.docId ?? null, page: r.pin.page || 1, record: r });
  }
  return out.sort((a, b) => a.n - b.n || (a.record.createdAt || 0) - (b.record.createdAt || 0));
}

// 하루의 핀을 스냅샷별로 → [{ snapId, docId, page, pins }] (첫 핀 번호 순) — 위치도 한 장 = 한 묶음
export function snapGroups(records) {
  const by = new Map();
  for (const p of dayPins(records)) {
    if (!by.has(p.snapId)) by.set(p.snapId, { snapId: p.snapId, docId: p.docId, page: p.page, pins: [] });
    by.get(p.snapId).pins.push(p);
  }
  return [...by.values()];
}

// 핀이 쓰는 스냅샷 id(휴지통 묶음 포함 — 되살리면 다시 쓰므로 지우지 않는다). 부팅 정리에서 이 밖의 그림만 지운다
export function snapsInUse(records) {
  const s = new Set();
  for (const r of records || []) if (isPin(r?.pin)) s.add(r.pin.snapId);
  return s;
}

// 스냅샷 목록(meta 'locSnaps' 의 값들)에서 같은 자료·같은 쪽의 가장 새 것 — 「같은 도면·같은 쪽이면 한 장을 같이」
export function latestSnap(snaps, docId, page = 1) {
  let best = null;
  for (const s of Array.isArray(snaps) ? snaps : Object.values(snaps || {})) {
    if (!s || s.docId !== docId || (s.page || 1) !== (page || 1) || s.retired) continue;
    if (!best || (s.at || 0) > (best.at || 0)) best = s;
  }
  return best;
}

// 범례 줄 — '① 101동 5층 503호 · 욕실 벽'. records 는 묶음 또는 dayPins 결과. 번호 순.
// content:false 면 위치만, max 글자 넘으면 '…'
export function legend(records, { content = true, max = 60 } = {}) {
  const rows = (records || []).map(x => (x && x.record ? x.record : x)).filter(r => r && !r.deletedAt)
    .map(r => ({ r, n: pinNo(r) ?? 0 }))
    .sort((a, b) => a.n - b.n || (a.r.createdAt || 0) - (b.r.createdAt || 0));
  return rows.map(({ r, n }) => {
    const loc = oneLine(r.location) || '위치 미입력';
    const c = content ? oneLine(r.content) : '';
    let t = `${circled(n)} ${c ? `${loc} · ${c}` : loc}`;
    const ch = Array.from(t);
    if (ch.length > max) t = `${ch.slice(0, Math.max(1, max - 1)).join('').trimEnd()}…`;
    return t;
  });
}

const md = day => { const [, m, d] = String(day || '').split('-'); return `${String(m || '').padStart(2, '0')}${String(d || '').padStart(2, '0')}`; };
const baseName = name => String(name || '').replace(/\.[A-Za-z0-9]{1,6}$/, '');

// ZIP 안 이름 — '위치도/1022_A-501 101동 5층 평면도_1쪽.jpg' (같은 이름 두 번째부터 _2)
export function locMapName(day, docName, page = 1, dup = 1) {
  const nm = Array.from(safeName(baseName(docName))).slice(0, 30).join('').trim() || '도면';
  return `위치도/${md(day)}_${nm}_${Math.max(1, page || 1)}쪽${dup > 1 ? `_${dup}` : ''}.jpg`;
}

// 제목 줄 — '○○현장 · 2026.10.22 · A-501 101동 5층 평면도 1쪽'
export function locMapTitle({ site = '', day = '', docName = '', page = 1 } = {}) {
  const d = String(day || '').replace(/-/g, '.');
  return [oneLine(site), d, `${oneLine(baseName(docName)) || '도면'} ${Math.max(1, page || 1)}쪽`].filter(Boolean).join(' · ');
}

// ---------- 핀 배치 ----------
// 핀 = 정확한 자리의 작은 점(검정 + 흰 테) + 번호 원(노랑, 검정 테, 검정 굵은 숫자) + 둘을 잇는 선.
// 크기는 그림 크기에 비례(√(W·H) — 가로로 긴 그림도 고르게) → 인쇄해도, 줄여 봐도 같은 비율로 읽힌다. 최소 반지름 13px(작은 미니 지도에서도 글자 ≥ 13px).
// 겹침: 번호 순으로 하나씩 놓는다. 기본 자리는 점 바로 위(1.9r — 핀 모양), 다른 번호 원·다른 점·그림 밖과 겹치면
//       8방향 × 3거리 후보 중 처음으로 안 겹치는 곳, 다 겹치면 겹침이 가장 적은 곳(clash 표시).
const DIRS = [-90, -45, -135, 0, 180, -22.5, -157.5, 45, 135, 90].map(a => (a * Math.PI) / 180);
const DISTS = [1.9, 3.1, 4.4];
export const PIN_K = 0.018;      // r = √(W·H) × PIN_K × size (2400×1700 → 반지름 약 36px, A4 가로 인쇄에서 지름 약 8mm)
export const PIN_MIN_R = 13;

export function pinRadius(W, H, size = 1) {
  const S = Math.sqrt(Math.max(1, W) * Math.max(1, H));
  return clamp(S * PIN_K * size, PIN_MIN_R, Math.max(PIN_MIN_R, Math.min(W, H) * 0.08));
}
// 번호 자릿수에 따라 글자 크기(원 안에 들어가게)
export const pinFont = (r, label) => { const d = String(label).length; return r * (d <= 1 ? 1.2 : d === 2 ? 1.02 : 0.8); };

export function pinLayout(W, H, pins, { size = 1 } = {}) {
  const r = pinRadius(W, H, size);
  const dot = Math.max(3, r * 0.26), stroke = Math.max(1.5, r * 0.13), line = Math.max(1.5, r * 0.11), gap = r * 0.18;
  const list = (pins || []).map((p, i) => ({ i, n: p.n, label: String(p.label ?? p.n ?? ''), ax: clamp01(p.x) * W, ay: clamp01(p.y) * H, id: p.id ?? null }))
    .sort((a, b) => (a.n ?? 0) - (b.n ?? 0) || a.i - b.i);
  const placed = [];
  const out = [];
  let clashes = 0;
  const cost = (cx, cy, self) => {
    let c = 0;
    // 그림 밖으로 나간 만큼
    c += Math.max(0, r - cx) + Math.max(0, cx + r - W) + Math.max(0, r - cy) + Math.max(0, cy + r - H);
    for (const q of placed) { const d = Math.hypot(cx - q.cx, cy - q.cy); if (d < 2 * r + gap) c += 2 * r + gap - d; }
    for (const q of list) {
      if (q === self) continue;
      const d = Math.hypot(cx - q.ax, cy - q.ay);
      if (d < r + dot + gap) c += (r + dot + gap - d) * 1.5;   // 남의 정확한 자리를 가리는 것이 더 나쁘다
    }
    return c;
  };
  for (const p of list) {
    let best = null;
    search:
    for (const k of DISTS) {
      for (const a of DIRS) {
        const cx = p.ax + Math.cos(a) * r * k, cy = p.ay + Math.sin(a) * r * k;
        const c = cost(cx, cy, p);
        if (!best || c < best.c - 1e-9) best = { cx, cy, c, a, k };
        if (c <= 1e-9) break search;
      }
    }
    const moved = !(best.k === DISTS[0] && Math.abs(best.a - DIRS[0]) < 1e-9);
    const clash = best.c > 1e-9;
    if (clash) clashes++;
    const q = { n: p.n, label: p.label, id: p.id, ax: p.ax, ay: p.ay, cx: best.cx, cy: best.cy, dir: Math.round((best.a * 180) / Math.PI * 10) / 10, dist: best.k, moved, clash, font: pinFont(r, p.label) };
    placed.push(q); out.push(q);
  }
  return { W, H, r, dot, stroke, line, pins: out, clashes };
}

// 핀 그리기 — ox,oy: 그림이 놓인 자리(ctx 좌표), k: layout 좌표 → ctx 배율
export function drawPins(ctx, L, { ox = 0, oy = 0, k = 1 } = {}) {
  if (!L?.pins?.length) return;
  const r = L.r * k, dot = L.dot * k, stroke = L.stroke * k, line = L.line * k;
  ctx.save();
  ctx.lineCap = 'round';
  // 1) 선(흰 테 → 검정) — 원 가장자리에서 점까지
  for (const p of L.pins) {
    const ax = ox + p.ax * k, ay = oy + p.ay * k, cx = ox + p.cx * k, cy = oy + p.cy * k;
    const d = Math.hypot(ax - cx, ay - cy);
    if (d <= r) continue;
    const ex = cx + ((ax - cx) / d) * r, ey = cy + ((ay - cy) / d) * r;
    ctx.strokeStyle = PIN_HALO; ctx.lineWidth = line + stroke * 1.4;
    ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ax, ay); ctx.stroke();
    ctx.strokeStyle = PIN_INK; ctx.lineWidth = line;
    ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ax, ay); ctx.stroke();
  }
  // 2) 정확한 자리 점
  for (const p of L.pins) {
    const ax = ox + p.ax * k, ay = oy + p.ay * k;
    ctx.fillStyle = PIN_HALO; ctx.beginPath(); ctx.arc(ax, ay, dot + stroke, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = PIN_INK; ctx.beginPath(); ctx.arc(ax, ay, dot, 0, Math.PI * 2); ctx.fill();
  }
  // 3) 번호 원(뒤 번호가 위)
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (const p of L.pins) {
    const cx = ox + p.cx * k, cy = oy + p.cy * k;
    ctx.fillStyle = PIN_HALO; ctx.beginPath(); ctx.arc(cx, cy, r + stroke * 0.9, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = PIN_FILL; ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = PIN_INK; ctx.lineWidth = stroke; ctx.beginPath(); ctx.arc(cx, cy, r - stroke / 2, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = PIN_INK; ctx.font = lmFont(p.font * k, true);
    ctx.fillText(p.label, cx, cy + p.font * k * 0.04);     // 굵은 숫자는 middle 이 살짝 위로 뜬다
  }
  ctx.restore();
}

// ---------- 위치도 한 장 구성(제목 띠 + 도면 + 범례 띠) ----------
// 긴 변을 1200~maxSide 로(작은 화면 스냅샷은 조금 키우고, 큰 것은 줄인다). 글자는 그림 폭에 비례 — 인쇄(A4 가로)에서 약 3~4mm.
// measure(text, px, bold) → 폭(px). 넘치는 글은 '…' 로 자른다(범례는 한 줄씩, 많으면 2~3열 — 위에서 아래로 읽는 순서)
export const LM_MIN_SIDE = 1200, LM_MAX_SIDE = 2400;

function ellipsize(text, maxW, px, bold, measure) {
  const s = String(text ?? '');
  if (measure(s, px, bold) <= maxW) return s;
  let ch = Array.from(s);
  let lo = 0, hi = ch.length;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (measure(`${ch.slice(0, m).join('').trimEnd()}…`, px, bold) <= maxW) lo = m; else hi = m - 1; }
  ch = ch.slice(0, lo);
  return `${ch.join('').trimEnd()}…`;
}

export function locMapLayout({ w, h, pins = [], legend: lines = null, title = '', sub = '', maxSide = LM_MAX_SIDE, minSide = LM_MIN_SIDE, size = 1 } = {}, measure) {
  if (!(w > 0 && h > 0)) throw new Error('도면 그림 크기를 몰라요');
  const long = Math.max(w, h);
  const s = clamp(long, Math.min(minSide, maxSide), maxSide) / long;
  const mapW = Math.max(1, Math.round(w * s)), mapH = Math.max(1, Math.round(h * s));
  const W = mapW;
  const font = clamp(W * 0.02, 16, 44);            // 제목
  const lf = clamp(W * 0.016, 14, 36);             // 범례
  const pad = Math.round(font * 0.7);
  const rule = Math.max(1, Math.round(W / 800));
  const maxTW = W - 2 * pad;

  // 제목 띠
  const titleRows = [];
  if (title) titleRows.push({ text: ellipsize(oneLine(title), maxTW, font, true, measure), px: font, bold: true, color: PIN_INK });
  if (sub) titleRows.push({ text: ellipsize(oneLine(sub), maxTW, lf, false, measure), px: lf, bold: false, color: LM_INK2 });
  const titleH = titleRows.length ? Math.round(pad * 2 + titleRows.reduce((a, t) => a + t.px * 1.3, 0)) : 0;
  let y = pad;
  const tRows = titleRows.map(t => { const row = { ...t, x: pad, y: y + t.px * 0.65 }; y += t.px * 1.3; return row; });

  // 도면
  const map = { x: 0, y: titleH + (titleH ? rule : 0), w: mapW, h: mapH };
  const P = pinLayout(mapW, mapH, pins, { size });

  // 범례 띠
  const L = (lines || []).map(oneLine).filter(Boolean);
  let legendH = 0, lRows = [], cols = 0;
  if (L.length) {
    const colGap = Math.round(lf * 1.5), lineH = lf * 1.45;
    const fitCols = Math.max(1, Math.min(3, Math.floor((W - 2 * pad + colGap) / (lf * 16 + colGap))));   // 한 열 폭 ≥ 글자 16자쯤
    cols = Math.min(fitCols, Math.max(1, Math.ceil(L.length / 12)), L.length);
    const colW = (W - 2 * pad - colGap * (cols - 1)) / cols;
    const per = Math.ceil(L.length / cols);
    const top = map.y + mapH + rule;
    lRows = L.map((t, i) => {
      const c = Math.floor(i / per), r = i % per;
      return { text: ellipsize(t, colW, lf, false, measure), px: lf, bold: false, color: PIN_INK, x: pad + c * (colW + colGap), y: top + pad + lineH * (r + 0.5) };
    });
    legendH = Math.round(pad * 2 + per * lineH);
  }
  const H = map.y + mapH + (legendH ? rule + legendH : 0);
  return { W, H, scale: s, pad, rule, titleH, legendH, cols, map, pins: P, title: tRows, legend: lRows };
}

// 그리기 — img: drawImage 에 넣을 수 있는 것(ImageBitmap·canvas·img). 흰 바탕(인쇄에 잉크 아끼게), 연한 구분선
export function drawLocMap(ctx, L, img) {
  ctx.save();
  ctx.fillStyle = '#FFFFFF'; ctx.fillRect(0, 0, L.W, L.H);
  ctx.imageSmoothingEnabled = true;
  try { ctx.imageSmoothingQuality = 'high'; } catch { /* 없는 환경 */ }
  if (img) ctx.drawImage(img, L.map.x, L.map.y, L.map.w, L.map.h);
  ctx.fillStyle = LM_RULE;
  if (L.titleH) ctx.fillRect(0, L.titleH, L.W, L.rule);
  if (L.legendH) ctx.fillRect(0, L.map.y + L.map.h, L.W, L.rule);
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
  for (const t of [...L.title, ...L.legend]) { ctx.fillStyle = t.color; ctx.font = lmFont(t.px, t.bold); ctx.fillText(t.text, t.x, t.y); }
  ctx.restore();
  drawPins(ctx, L.pins, { ox: L.map.x, oy: L.map.y, k: 1 });
}

// ---------- 사진대지 xlsx 에 '위치도' 시트 붙이기 ----------
// buildWorkbook(core/xlsx.js) 결과 entries 를 받아 새 entries 를 돌려준다(xlsx.js 는 고치지 않는다 — exporter 가 한 줄로 끼운다).
// maps = [{ jpeg: Uint8Array, w, h, name? }] — 한 장 = 인쇄 한 쪽(A4 가로, 폭 맞춤), 쪽마다 rowBreak.
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XMLH = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
const EMU = 9525;
export const LOC_SHEET_ROWS = 34;            // 한 쪽 = 34행(기본 15pt = 20px → 680px)
export const LOC_BOX = { w: 1000, h: 660 };  // 한 쪽 그림 상자(px, A4 가로 인쇄 영역 안)

export function addLocMapSheet(entries, maps, { sheetName = '위치도' } = {}) {
  const list = (maps || []).filter(m => m && m.jpeg && m.jpeg.length && m.w > 0 && m.h > 0);
  if (!list.length) return entries;
  const tdec = new TextDecoder(), tenc = new TextEncoder();
  const m = new Map(entries.map(e => [e.name, e.data]));
  const txt = n => { const d = m.get(n); if (!d) throw new Error(`엑셀에 ${n} 이 없어요`); return typeof d === 'string' ? d : tdec.decode(d); };
  const put = (n, s) => m.set(n, typeof s === 'string' ? tenc.encode(s) : s);
  const free = (fmt) => { let i = 1; while (m.has(fmt(i))) i++; return i; };

  const sn = free(i => `xl/worksheets/sheet${i}.xml`), dn = free(i => `xl/drawings/drawing${i}.xml`);
  const sheetPath = `xl/worksheets/sheet${sn}.xml`, drawPath = `xl/drawings/drawing${dn}.xml`;
  // 워크북: 시트 등록(sheetId·rId 는 쓰는 것 다음)
  let wb = txt('xl/workbook.xml'), wrels = txt('xl/_rels/workbook.xml.rels');
  const ids = [...wrels.matchAll(/Id="rId(\d+)"/g)].map(x => +x[1]);
  const rid = `rId${(ids.length ? Math.max(...ids) : 0) + 1}`;
  const sids = [...wb.matchAll(/sheetId="(\d+)"/g)].map(x => +x[1]);
  const sid = (sids.length ? Math.max(...sids) : 0) + 1;
  wb = wb.replace('</sheets>', () => `<sheet name="${esc(sheetName)}" sheetId="${sid}" r:id="${rid}"/></sheets>`);
  wrels = wrels.replace('</Relationships>', () => `<Relationship Id="${rid}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${sn}.xml"/></Relationships>`);
  put('xl/workbook.xml', wb); put('xl/_rels/workbook.xml.rels', wrels);
  // 그림
  const anchors = [], rels = [];
  list.forEach((mp, i) => {
    const imgN = free(k => `xl/media/locmap${k}.jpg`);
    put(`xl/media/locmap${imgN}.jpg`, mp.jpeg);
    const rId = `rId${i + 1}`;
    rels.push(`<Relationship Id="${rId}" Type="${NS_REL}/image" Target="../media/locmap${imgN}.jpg"/>`);
    const s = Math.min(LOC_BOX.w / mp.w, LOC_BOX.h / mp.h);
    const cw = Math.max(1, Math.floor(mp.w * s)), ch = Math.max(1, Math.floor(mp.h * s));
    const row = i * LOC_SHEET_ROWS;
    anchors.push(`<xdr:oneCellAnchor><xdr:from><xdr:col>0</xdr:col><xdr:colOff>0</xdr:colOff><xdr:row>${row}</xdr:row><xdr:rowOff>0</xdr:rowOff></xdr:from>`
      + `<xdr:ext cx="${cw * EMU}" cy="${ch * EMU}"/><xdr:pic><xdr:nvPicPr><xdr:cNvPr id="${i + 2}" name="${esc(mp.name || `위치도 ${i + 1}`)}"/><xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr></xdr:nvPicPr>`
      + `<xdr:blipFill><a:blip xmlns:r="${NS_REL}" r:embed="${rId}"/><a:stretch><a:fillRect/></a:stretch></xdr:blipFill>`
      + `<xdr:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cw * EMU}" cy="${ch * EMU}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></xdr:spPr></xdr:pic><xdr:clientData/></xdr:oneCellAnchor>`);
  });
  put(drawPath, `${XMLH}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">${anchors.join('')}</xdr:wsDr>`);
  put(`xl/drawings/_rels/drawing${dn}.xml.rels`, `${XMLH}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join('')}</Relationships>`);
  // 시트(CT_Worksheet 순서: sheetPr → dimension → sheetViews → sheetFormatPr → sheetData → pageMargins → pageSetup → rowBreaks → drawing)
  const last = list.length * LOC_SHEET_ROWS;
  const brk = list.length > 1 ? `<rowBreaks count="${list.length - 1}" manualBreakCount="${list.length - 1}">${list.slice(1).map((_, i) => `<brk id="${(i + 1) * LOC_SHEET_ROWS}" max="16383" man="1"/>`).join('')}</rowBreaks>` : '';
  put(sheetPath, `${XMLH}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="${NS_REL}">`
    + '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'
    + `<dimension ref="A1:P${last}"/><sheetViews><sheetView workbookViewId="0" zoomScale="80" zoomScaleNormal="80"/></sheetViews>`
    + '<sheetFormatPr defaultRowHeight="15"/><sheetData/>'
    + '<pageMargins left="0.4" right="0.4" top="0.5" bottom="0.5" header="0.3" footer="0.3"/>'
    + '<pageSetup paperSize="9" orientation="landscape" fitToWidth="1" fitToHeight="0"/>'
    + `${brk}<drawing r:id="rId1"/></worksheet>`);
  put(`xl/worksheets/_rels/sheet${sn}.xml.rels`, `${XMLH}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${NS_REL}/drawing" Target="../drawings/drawing${dn}.xml"/></Relationships>`);
  // 인쇄 영역(사진대지 시트 것과 별개 — 시트 번호는 0부터)
  const sheetIdx = (wb.match(/<sheet /g) || []).length - 1;
  wb = txt('xl/workbook.xml');
  const area = `<definedName name="_xlnm.Print_Area" localSheetId="${sheetIdx}">'${esc(sheetName).replace(/'/g, "''")}'!$A$1:$P$${last}</definedName>`;
  wb = /<definedNames>/.test(wb) ? wb.replace('</definedNames>', () => `${area}</definedNames>`) : wb.replace('</sheets>', () => `</sheets><definedNames>${area}</definedNames>`);
  put('xl/workbook.xml', wb);
  // Content_Types
  let ct = txt('[Content_Types].xml');
  if (!/Extension="jpg"/i.test(ct)) ct = ct.replace(/<Types[^>]*>/, x => `${x}<Default Extension="jpg" ContentType="image/jpeg"/>`);
  ct = ct.replace('</Types>', () => `<Override PartName="/${sheetPath}" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`
    + `<Override PartName="/${drawPath}" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/></Types>`);
  put('[Content_Types].xml', ct);

  const out = [{ name: '[Content_Types].xml', data: m.get('[Content_Types].xml') }];
  m.forEach((d, n) => { if (n !== '[Content_Types].xml') out.push({ name: n, data: d }); });
  return out;
}
