// GPS 한 줄(SPEC §5.7) — gps.on 구독만 한다(gps.start/stop 은 화면 몫). 주소(도로명 우선, 지번 보조) 또는 좌표 + ±m + 상태.
// 상태는 글자로도 보인다(색만으로 나타내지 않음). 주소는 화면에만 — 어디에도 저장하지 않는다(VWorld 약관).
import { h, icon, toast } from '../dom.js';
import * as gps from '../../services/gps.js';
import { fmtCoord, fmtAcc } from '../../core/geo.js';

const STATE_TEXT = {
  off: '위치가 꺼져 있어요',
  asking: '위치 권한을 묻는 중이에요',
  denied: '위치 권한이 꺼져 있어요',
  searching: '위치 찾는 중…',
  error: '위치를 못 잡았어요',
  unsupported: '이 기기는 위치를 못 써요',
};

export function gpsLine({ dark = false, compact = false } = {}) {
  const main = h('span', { class: 'gps-main' });
  const sub = h('span', { class: 'gps-sub' });
  const el = h('div', { class: ['gpsline', dark && 'dark', compact && 'compact'], 'data-testid': 'gps-line', role: 'status', 'aria-live': 'polite' },
    icon('locate', compact ? 18 : 22), h('span', { class: 'gps-text' }, main, sub));

  function draw(s) {
    s = s || {};
    el.dataset.state = s.state || 'off';
    el.dataset.addr = s.addrState || 'idle';
    const pos = s.pos;
    const subParts = [];
    if (s.state === 'ok' && pos) {
      const coord = `${fmtCoord(pos.lat, pos.lng)} ${fmtAcc(pos.acc)}`.trim();
      const a = s.addrState === 'ok' ? s.addr : null;
      if (a && (a.road || a.text || a.parcel)) {
        main.textContent = a.road || a.text || a.parcel;
        if (a.road && a.parcel && !compact) subParts.push(a.parcel);
        subParts.push(fmtAcc(pos.acc));
      } else {
        main.textContent = coord;
        if (s.addrState === 'nokey') subParts.push('VWorld 키를 넣으면 주소로 보여요');
        else if (s.addrState === 'loading') subParts.push('주소 찾는 중…');
        else if (s.addrState === 'error') subParts.push(s.addrError || '주소를 못 받았어요');
      }
    } else if (pos && s.state === 'searching') {
      main.textContent = `${fmtCoord(pos.lat, pos.lng)} ${fmtAcc(pos.acc)}`.trim();
      subParts.push('위치 찾는 중…');
    } else {
      main.textContent = STATE_TEXT[s.state] || STATE_TEXT.off;
      if (s.state === 'denied') subParts.push(compact ? '눌러서 다시 켜기' : '설정에서 위치 권한을 켜 주세요');
      else if (s.state === 'error' || s.state === 'off') subParts.push(compact ? '눌러서 다시 찾기' : '');
    }
    sub.textContent = subParts.filter(Boolean).join(' · ');
    sub.hidden = !sub.textContent;
    const canRetry = ['denied', 'error', 'off'].includes(s.state);         // 못 잡았으면 줄을 눌러 다시 묻기·찾기
    if (canRetry) { el.setAttribute('role', 'button'); el.tabIndex = 0; } else { el.setAttribute('role', 'status'); el.removeAttribute('tabindex'); }
  }
  el.addEventListener('click', () => {
    if (!['denied', 'error', 'off'].includes(el.dataset.state)) return;
    Promise.resolve(gps.retry?.()).then(() => {
      if (gps.snapshot?.()?.state === 'denied') toast('휴대폰 설정 → 앱 → 권한에서 위치를 켜 주세요', 4000);
    }).catch(() => {});
  });

  try { draw(gps.snapshot?.()); } catch (e) { console.warn('GPS 상태를 못 읽었어요', e); draw(null); }
  let off = null;
  try { off = gps.on?.(draw) ?? null; } catch (e) { console.warn('GPS 구독 실패', e); }
  return { el, destroy() { try { off?.(); } catch { /* 이미 해제 */ } off = null; } };
}
