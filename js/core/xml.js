// XML 문자열 도우미 — 엑셀 OOXML 조립용(순수 함수)
export const enc = new TextEncoder();
export const dec = new TextDecoder();
// XML 1.0에 쓸 수 없는 제어문자(탭·줄바꿈·CR 제외)와 U+FFFE·U+FFFF를 지운다(설계서 §8.3)
export const stripCtl = s => String(s ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '');
export const esc = s => stripCtl(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
