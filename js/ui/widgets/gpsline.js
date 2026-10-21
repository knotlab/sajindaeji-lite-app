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

  // 글자가 같으면 DOM 을 건드리지 않는다(위치 알림마다 글을 다시 넣으면 배치·읽어 주기가 매번 돈다)
  const setText = (node, t) => { if (node.textContent !== t) node.textContent = t; };
  const setData = (k, v) => { if (el.dataset[k] !== v) el.dataset[k] = v; };
  function draw(s) {
    s = s || {};
    setData('state', s.state || 'off');
    setData('addr', s.addrState || 'idle');
    const pos = s.pos;
    const subParts = [];
    let mainT = '';
    if (s.state === 'ok' && pos) {
      const coord = `${fmtCoord(pos.lat, pos.lng)} ${fmtAcc(pos.acc)}`.trim();
      const a = s.addrState === 'ok' ? s.addr : null;
      if (a && (a.road || a.text || a.parcel)) {
        mainT = a.road || a.text || a.parcel;
        if (a.road && a.parcel && !compact) subParts.push(a.parcel);
        subParts.push(fmtAcc(pos.acc));
      } else {
        mainT = coord;
        if (s.addrState === 'nokey') subParts.push('VWorld 키를 넣으면 주소로 보여요');
        else if (s.addrState === 'loading') subParts.push('주소 찾는 중…');
        else if (s.addrState === 'error') subParts.push(s.addrError || '주소를 못 받았어요');
      }
    } else if (pos && s.state === 'searching') {
      mainT = `${fmtCoord(pos.lat, pos.lng)} ${fmtAcc(pos.acc)}`.trim();
      subParts.push('위치 찾는 중…');
    } else {
      mainT = STATE_TEXT[s.state] || STATE_TEXT.off;
      if (s.state === 'denied') subParts.push(compact ? '눌러서 다시 켜기' : '설정에서 위치 권한을 켜 주세요');
      else if (s.state === 'error' || s.state === 'off') subParts.push(compact ? '눌러서 다시 찾기' : '');
    }
    setText(main, mainT);
    const subT = subParts.filter(Boolean).join(' · ');
    setText(sub, subT);
    if (sub.hidden !== !subT) sub.hidden = !subT;
    const canRetry = ['denied', 'error', 'off'].includes(s.state);         // 못 잡았으면 줄을 눌러 다시 묻기·찾기
    const role = canRetry ? 'button' : 'status';
    if (el.getAttribute('role') !== role) {
      if (canRetry) { el.setAttribute('role', 'button'); el.tabIndex = 0; } else { el.setAttribute('role', 'status'); el.removeAttribute('tabindex'); }
    }
  }
  // 화면 갱신은 1초에 한 번까지 — 상태(위치·주소)가 바뀐 알림은 바로, 좌표만 바뀐 알림은 1초 안의 것을 모아 마지막 것만
  let lastAt = 0, timer = 0, latest = null, lastKey = null;
  const keyOf = s => `${s?.state}|${s?.addrState}|${s?.addr?.road || s?.addr?.text || ''}`;
  const flush = () => { clearTimeout(timer); timer = 0; lastAt = Date.now(); lastKey = keyOf(latest); draw(latest); };
  const onSnap = s => {
    latest = s;
    if (keyOf(s) !== lastKey || Date.now() - lastAt >= 1000) { flush(); return; }
    if (!timer) timer = setTimeout(flush, Math.max(0, 1000 - (Date.now() - lastAt)));
  };
  el.addEventListener('click', () => {
    if (!['denied', 'error', 'off'].includes(el.dataset.state)) return;
    Promise.resolve(gps.retry?.()).then(() => {
      if (gps.snapshot?.()?.state === 'denied') toast('휴대폰 설정 → 앱 → 권한에서 위치를 켜 주세요', 4000);
    }).catch(() => {});
  });

  try { draw(gps.snapshot?.()); } catch (e) { console.warn('GPS 상태를 못 읽었어요', e); draw(null); }
  let off = null;
  try { off = gps.on?.(onSnap) ?? null; } catch (e) { console.warn('GPS 구독 실패', e); }
  return { el, destroy() { clearTimeout(timer); timer = 0; try { off?.(); } catch { /* 이미 해제 */ } off = null; } };
}
