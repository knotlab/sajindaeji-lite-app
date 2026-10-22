// 앱 진입점(SPEC §5.7) — 부팅 순서, 화면 등록, 뒤로 가기·복귀, SW 등록.
// 부팅: store.init → (첫 화면) → safety.checkRestore(후보면 「기록을 되살릴까요?」) → pipeline.recover(되살린 사진 토스트) → safety.startSafety.
// 단계마다 감싸서 하나가 실패해도 앱은 뜬다. store.init 이 실패하면 빈 홈 대신 「저장소를 열지 못했어요 [다시 시도]」(설계 비평 UX-4 — 빈 홈은 데이터가 날아간 것처럼 보인다).
// 화면 파일은 각자 동적 import — 하나가 없거나 오류여도 나머지는 뜨고, 그 화면은 「준비 중」.
import * as router from './router.js';
import * as dom from './dom.js';
import { h, toast, snackbar, confirmModal } from './dom.js';
import { APP_VERSION } from '../config.js';

const SCREENS = ['home', 'day', 'record', 'capture', 'viewer', 'export', 'settings', 'docs', 'docview'];
const $ = sel => document.querySelector(sel);

const lite = { version: APP_VERSION, router, dom, store: null, safety: null, pipeline: null, native: null, ready: null, booted: false, failed: false };
window.__lite = lite;

async function imp(path) {
  try { return await import(path); } catch (e) { console.error(`모듈을 불러오지 못했어요: ${path}`, e); return null; }
}

// 화면 모듈의 모양: export default { mount, ... } 를 권장. screen·<이름> 내보내기나 모듈 자체(mount 내보내기)도 받는다
function pickScreen(mod, name) {
  if (!mod) return null;
  for (const c of [mod.default, mod.screen, mod[name]]) if (c && typeof c.mount === 'function') return c;
  return typeof mod.mount === 'function' ? mod : null;
}

function loadScreens() {
  return Promise.all(SCREENS.map(async name => {
    const s = pickScreen(await imp(`./screens/${name}.js`), name);
    if (s) router.register(name, s);
    else console.warn(`화면 준비 중: ${name}`);
  }));
}

async function step(label, fn) {
  try { return await fn(); } catch (e) { console.error(`부팅 단계 실패: ${label}`, e); return null; }
}

function showFatal(e) {
  lite.failed = true;
  const view = $('#view');
  if (!view) return;
  const msg = e?.name === 'VersionError'
    ? '앱이 데이터보다 오래됐어요. 최신으로 설치해 주세요.'
    : (e?.code === 'QUOTA' ? '저장 공간이 부족해요. 공간을 비운 뒤 다시 시도해 주세요.' : '잠시 뒤 다시 시도해 주세요. 기록은 지워지지 않았어요.');
  view.replaceChildren(h('section', { class: 'screen', 'data-screen': 'fatal' },
    h('div', { class: 'fatal' },
      h('h1', { text: '저장소를 열지 못했어요' }),
      h('p', { text: msg }),
      h('button', { type: 'button', class: 'primary', 'data-testid': 'fatal-retry', text: '다시 시도', onclick: () => location.reload() }))));
}

// 웹 SW — localhost·127.0.0.1 에서는 ?sw=1 일 때만(Playwright page.route 가 SW 에 가려지지 않게, 개발 서버 no-store 가 보이게 — 설계 비평 기술-2).
// 새 SW 가 기다리면 스낵바 [새로 고침] → postMessage('skip') → controllerchange 에서 다시 읽기(요청했을 때만)
function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  const q = new URLSearchParams(location.search);
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  if (q.get('sw') === '0' || (local && q.get('sw') !== '1')) return;
  let wantReload = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (wantReload) { wantReload = false; location.reload(); } });
  const offer = w => snackbar('새 버전이 있어요', { actionLabel: '새로 고침', ms: 10 * 60 * 1000, onAction: () => { wantReload = true; w.postMessage('skip'); } });
  navigator.serviceWorker.register('sw.js').then(reg => {
    // 홈 화면 PWA 는 백그라운드에 두었다 다시 켜는 일이 많다 — 다시 보일 때 30분마다 새 버전을 확인한다
    let checked = Date.now();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'visible' || Date.now() - checked < 30 * 60 * 1000) return;
      checked = Date.now();
      reg.update().catch(() => {});
    });
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      w?.addEventListener('statechange', () => { if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w); });
    });
  }).catch(e => console.warn('SW 등록 실패', e));
}

// APK: 지난 실행의 내보내기·공유·백업 임시 파일(CACHE) 정리 — 첫 화면 뒤에, 부팅 때만(공유 직후에는 받는 앱이 아직 읽는 중일 수 있다)
function cleanCache(native) {
  if (typeof native?.cleanupCache !== 'function') return;
  setTimeout(() => { native.cleanupCache().catch(e => console.warn('임시 폴더 정리 실패', e)); }, 3000);
}

function countOf(x) { return Array.isArray(x) ? x.length : (Number.isFinite(x) ? x : 0); }
const SOURCE_LABEL = { mirror: '앱 안 미러', file: '자동 백업 파일', local: '이 브라우저 자동 백업' };

async function offerRestore(safety, store) {
  const cand = await safety.checkRestore();
  if (!cand) return;
  const have = (() => { try { return store.days().reduce((n, d) => n + (d.records || 0), 0); } catch { return 0; } })();
  const when = cand.at ? new Date(cand.at).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
  const ok = await confirmModal({
    title: '기록을 되살릴까요?',
    text: `${SOURCE_LABEL[cand.source] || '백업'}${when ? `(${when})` : ''}에 묶음 ${countOf(cand.records)}개, 사진 ${countOf(cand.photos)}장이 있어요. 지금은 묶음 ${have}개예요.`,
    okLabel: '되살리기', cancelLabel: '나중에',
  });
  if (!ok) return;
  try {
    const r = await safety.restoreFrom(cand);
    toast(`묶음 ${(r?.added || 0) + (r?.updated || 0)}개를 되살렸어요`);
    router.refresh();
  } catch (e) {
    console.error('복원 실패', e);
    toast('되살리지 못했어요. 설정 > 백업에서 다시 해 보세요');
  }
}

async function boot() {
  window.addEventListener('unhandledrejection', e => {
    console.error('처리 안 된 비동기 거부', e.reason);
    toast('문제가 생겼어요. 다시 해 보세요');
  });

  // ① 플랫폼 — 카메라 중에 앱이 죽었다 살아난 결과(appRestoredResult)는 첫 리스너가 붙을 때 온다 → 가장 먼저 받아 둔다
  const native = await imp('../platform/native.js');
  lite.native = native;
  try { native?.setTypingProbe?.(dom.isTyping); } catch { /* 없음 */ }       // 한가함 판정(whenQuiet)이 시트·글 입력을 알게 — 촬영 화면 밖에서도
  const isNative = (() => { try { return !!native?.isNative?.(); } catch { return false; } })();
  const restoredQ = [];
  let onRestoredReady = null;
  try { native?.onRestored?.(ev => { if (onRestoredReady) onRestoredReady(ev); else restoredQ.push(ev); }); } catch (e) { console.warn('복귀 결과 구독 실패', e); }
  try {
    native?.onBack?.(() => {
      if (router.back()) return;
      if (lite.failed || !router.currentName()) { try { native.minimizeApp?.(); } catch { /* 무시 */ } }
    });
  } catch (e) { console.warn('뒤로 가기 연결 실패', e); }

  const screensP = loadScreens();
  // 글 입력 중에는 위치 알림·주소 조회를 붙잡는다(키보드·한글 조합과 다투지 않게) — 사진에 붙는 위치 값은 계속 최신
  imp('../services/gps.js').then(g => { if (typeof g?.hold === 'function' && typeof dom.onTyping === 'function') dom.onTyping(t => g.hold(t)); });

  // ② 저장소
  const store = await imp('../data/store.js');
  if (!store) { showFatal(new Error('store.js 없음')); return; }
  try { await store.init({ now: Date.now() }); } catch (e) { console.error('저장소 열기 실패', e); showFatal(e); return; }
  lite.store = store;

  // ③ 첫 화면 — 안내(복원 질문·되살린 사진)는 그 위에 띄운다
  router.start({ useHistory: !isNative, minimize: isNative ? () => native.minimizeApp?.() : null });
  await screensP;
  router.home();

  // ④ safety.checkRestore → pipeline.recover → safety.startSafety (각각 감쌈)
  const safety = await imp('../data/safety.js');
  lite.safety = safety;
  if (safety?.checkRestore) await step('checkRestore', () => offerRestore(safety, store));
  const pipeline = await imp('../media/pipeline.js');
  lite.pipeline = pipeline;
  // 카메라 앱 결과(appRestoredResult)를 recover 전에 먼저 넘긴다 — 첫 recover 가 힌트 없이 임시 파일을 입양해 갤러리 정보가 빠지지 않게
  if (pipeline?.queueRestored) for (const ev of restoredQ.splice(0)) pipeline.queueRestored(ev);
  if (pipeline?.recover) {
    const r = await step('recover', () => pipeline.recover());
    const n = (r?.resumed || 0) + (r?.adopted || 0);
    if (n > 0) toast(`찍던 사진 ${n}장을 되살렸어요`);
  }
  // 카메라 앱 중 죽었다 살아난 결과 — pipeline 이 handleRestored 를 내보내면 넘기고, 아니면 recover 를 한 번 더(임시 파일 입양)
  onRestoredReady = ev => step('restored', async () => {
    if (pipeline?.handleRestored) await pipeline.handleRestored(ev);
    else if (pipeline?.recover) { const r = await pipeline.recover(); const n = (r?.resumed || 0) + (r?.adopted || 0); if (n > 0) toast(`찍던 사진 ${n}장을 되살렸어요`); }
  });
  for (const ev of restoredQ.splice(0)) onRestoredReady(ev);
  if (safety?.startSafety) await step('startSafety', () => safety.startSafety());
  // 글 입력 중에는 미러·백업 파일 쓰기를 미룬다(safety.hold 가 있으면 — 폰에서 파일 쓰기는 브리지를 오가 키보드와 다툰다)
  if (typeof safety?.hold === 'function') dom.onTyping(t => { try { safety.hold(t); } catch (e) { console.warn('백업 붙잡기 실패', e); } });

  // ⑤ 나머지(기다리지 않음)
  step('persist', async () => { if (navigator.storage?.persist && !(await navigator.storage.persisted?.())) await navigator.storage.persist(); });
  if (!isNative) registerSW(); else cleanCache(native);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') router.notifyResume(); });

  lite.booted = true;
}

lite.ready = ($('#app') ? boot() : Promise.resolve()).catch(e => { console.error('부팅 실패', e); showFatal(e); });
