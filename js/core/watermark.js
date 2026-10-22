// 워터마크 — 넣을 글 고르기·배치 계산·그리기(설계서 §5.2). DOM 없음: 그리기는 받은 ctx 만 쓴다
import { dotDate, hm } from './date.js';

export const WM_MODES = ['off', 'loc', 'loc+content'];
// 띠 상한 — 설계 비평 반영: 32%·5행이면 '위치+내용'에서 사진 아래 18~29% 를 덮는다 → 22%·4행
export const WM_MAX_ROWS = 4;
export const WM_MAX_BAND = 0.22;
export const WM_BAND_COLOR = 'rgba(0,0,0,0.62)';
export const WM_BAR_COLOR = '#FFC400';
export const wmFont = (font, bold) => `${bold ? 800 : 600} ${font}px system-ui, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`;

// 촬영 일시 넣기(사용자 지시 2026-10-22 「시간 박는 것도 옵션으로」): 날짜+시간 / 날짜만 / 안 넣기.
// 옛 설정 wmDate(참·거짓)만 있으면 참 → 'datetime', 거짓 → 'off' 로 읽는다.
export const WM_WHEN = ['datetime', 'date', 'off'];
export function wmWhenOf(settings = {}) {
  if (WM_WHEN.includes(settings?.wmWhen)) return settings.wmWhen;
  return settings?.wmDate === false ? 'off' : 'datetime';
}

export function wmOpts(settings = {}) {
  const mode = WM_MODES.includes(settings?.wmMode) ? settings.wmMode : 'loc+content';
  const when = wmWhenOf(settings);
  return { mode, when, date: when !== 'off', onScreen: settings?.wmOnScreen !== false };
}

// 내용은 여러 줄 — 사진에 박히는 글은 줄바꿈(둘레 공백 포함)을 공백 하나로(원본 compose.js)
export const oneLine = s => String(s ?? '').trim().replace(/\s*[\r\n]\s*/g, ' ');

// 촬영 일시 — 수동 입력은 날짜만, 파일 시각이거나 없으면 '촬영일 미상'(원본 규칙). when: 'datetime'|'date'|'off'
export function whenText(photo, when = 'datetime') {
  if (when === 'off') return '';
  const src = photo?.takenAtSource;
  if (!photo?.takenAt || src === 'file') return '촬영일 미상';
  if (src === 'manual' || when === 'date') return dotDate(photo.takenAt);
  return `${dotDate(photo.takenAt)} ${hm(photo.takenAt)}`;
}

// opts 는 wmOpts() 결과를 그대로 넘겨도 되고, 옛 호출처럼 { mode, date } 만 줘도 된다
export function watermarkLines(record, photo, { mode = 'loc+content', date = true, when } = {}) {
  if (mode === 'off') return [];
  const lines = [oneLine(record?.location) || '위치 미입력'];
  if (mode === 'loc+content') { const c = oneLine(record?.content); if (c) lines.push(c); }
  const w = WM_WHEN.includes(when) ? when : (date ? 'datetime' : 'off');
  if (w !== 'off') lines.push(whenText(photo, w));
  return lines;
}

// FNV-1a 32bit — 캐시 키(줄 구분은 \n)
export function wmKey(lines) {
  let h = 0x811c9dc5;
  const s = (lines || []).join('\n');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

// 한 줄을 maxW 폭으로 단어 단위로 감싼다(한 줄보다 긴 단어는 글자 단위) — 원본 image.js wrapLines
function wrap(text, maxW, font, bold, measure) {
  const fit = s => measure(s, font, bold) <= maxW;
  const rows = [];
  let cur = '';
  for (let w of String(text).trim().split(/\s+/).filter(Boolean)) {
    const cand = cur ? `${cur} ${w}` : w;
    if (fit(cand)) { cur = cand; continue; }
    if (cur) { rows.push(cur); cur = ''; }
    while (!fit(w)) {
      const ch = Array.from(w);
      let k = 1;
      while (k < ch.length && fit(ch.slice(0, k + 1).join(''))) k++;
      if (k >= ch.length) break;
      rows.push(ch.slice(0, k).join('')); w = ch.slice(k).join('');
    }
    cur = w;
  }
  if (cur) rows.push(cur);
  return rows;
}

// 비례 배치(해상도 무관): 같은 줄이면 480px 썸네일과 1600px 작업본이 축소본처럼 똑같다(measure 가 글자 크기에 비례할 때).
// 화면용은 work 크기로 계산한 layout 을 ctx.scale 로 줄여 그리면 줄바꿈이 어긋나지 않는다(설계 비평, render(C) 쪽)
export function watermarkLayout(W, H, lines, measure) {
  const S = Math.min(W, H), pad = S * 0.022, bar = S * 0.012;
  const maxW = Math.max(1, W - 2 * pad - bar * 2), maxBand = H * WM_MAX_BAND;
  const src = (lines || []).map(oneLine).filter(Boolean);
  const out = (font, rows) => {
    const lineH = font * 1.22;
    return { bandH: rows.length ? rows.length * lineH + 2 * pad : 0, pad, bar, rows, font, lineH, textX: pad + bar * 2 };
  };
  if (!src.length) return out(S * 0.040, []);
  const build = font => src.flatMap((ln, i) => wrap(ln, maxW, font, i === 0, measure).map(text => ({ text, bold: i === 0 })));
  const minF = S * 0.026;
  for (let font = S * 0.040; font >= minF - 1e-9; font *= 0.96) {
    const rows = build(font);
    if (rows.length <= WM_MAX_ROWS && rows.length * font * 1.22 + 2 * pad <= maxBand) return out(font, rows);
  }
  // 최소 글자로도 넘치면 들어가는 만큼만, 마지막 행 끝을 '…'
  const font = minF, lineH = font * 1.22;
  const cap = Math.max(1, Math.min(WM_MAX_ROWS, Math.floor((maxBand - 2 * pad) / lineH)));
  const all = build(font), rows = all.slice(0, cap);
  if (all.length > cap) {
    const last = rows[cap - 1];
    let t = last.text;
    while (t && measure(`${t}…`, font, last.bold) > maxW) t = Array.from(t).slice(0, -1).join('').trimEnd();
    rows[cap - 1] = { ...last, text: `${t}…` };
  }
  return out(font, rows);
}

// 하단 전체 폭 반투명 띠 + 왼쪽 하이비스 막대 + 흰 글자
export function drawWatermark(ctx, W, H, layout) {
  if (!layout?.rows?.length) return;
  const { bandH, pad, bar, rows, font, lineH } = layout, top = H - bandH;
  ctx.save();
  ctx.fillStyle = WM_BAND_COLOR; ctx.fillRect(0, top, W, bandH);
  ctx.fillStyle = WM_BAR_COLOR; ctx.fillRect(pad, top + pad, bar, bandH - 2 * pad);
  ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.textAlign = 'left';
  const x = layout.textX ?? pad + bar * 2;
  rows.forEach((r, i) => { ctx.font = wmFont(font, r.bold); ctx.fillText(r.text, x, top + pad + lineH * (i + 0.5)); });
  ctx.restore();
}
