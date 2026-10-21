// 화면 꺼짐 방지(SPEC §10.5) — 도면 보며 걷기·촬영 중에 화면이 꺼지지 않게.
// 웹: navigator.wakeLock('screen') — 화면이 숨으면 브라우저가 풀므로 다시 보이게 될 때 다시 요청한다.
// 앱: Capacitor.Plugins.KeepAwake.set({ on }) (native-src/KeepAwakePlugin.java, FLAG_KEEP_SCREEN_ON).
// 여러 화면이 켜고 끌 수 있어 횟수를 센다: true 한 번마다 false 한 번(0 아래로는 안 내려감).
let count = 0;
let lock = null;
let listening = false;

const cap = () => globalThis.Capacitor;
const nativePlugin = () => (cap()?.isNativePlatform?.() && cap()?.Plugins?.KeepAwake) || null;

async function webOn() {
  if (lock || !navigator.wakeLock || document.visibilityState !== 'visible') return;
  try {
    lock = await navigator.wakeLock.request('screen');
    lock.addEventListener?.('release', () => { lock = null; });
    if (count === 0) { const l = lock; lock = null; await l.release().catch(() => {}); }   // 기다리는 사이 꺼 달라고 했다
  } catch (err) { lock = null; console.warn('화면 꺼짐 방지를 못 켰어요', err?.message || err); }
}
async function webOff() { const l = lock; lock = null; if (l) await l.release().catch(() => {}); }

function onVisible() { if (count > 0 && document.visibilityState === 'visible') webOn(); }

export async function keepAwake(on) {
  count = on ? count + 1 : Math.max(0, count - 1);
  const want = count > 0;
  const p = nativePlugin();
  if (p) {
    try { await p.set({ on: want }); } catch (err) { console.warn('화면 꺼짐 방지(앱) 실패', err); }
    return;
  }
  if (!listening) { listening = true; document.addEventListener('visibilitychange', onVisible); }
  if (want) await webOn(); else await webOff();
}

export const awakeCount = () => count;     // 시험·디버그용
