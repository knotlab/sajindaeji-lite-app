// 서비스워커 — 오프라인 앱 셸 + 문서 뷰어 엔진 런타임 캐시.  (I 담당, SPEC §7 · §10.3 · 비평 반영)
// - 미리 캐시: tools/gen-assets.mjs 가 아래 표시 사이를 다시 쓴다(www 전체, dev/·sw.js 제외).
//   캐시 이름 = 'lite-' + 목록 파일 내용 해시 10자 → 내용이 바뀐 배포만 새 캐시가 된다(공시체 build-pwa 방식).
// - install 은 new Request(u, { cache: 'reload' }) — Pages 의 max-age=600 HTTP 캐시에 있던 옛 파일을 담지 않게.
// - 같은 출처 GET: navigate 는 캐시의 ./index.html, version.json 은 네트워크 우선, 나머지는 캐시 우선·없으면 네트워크.
//   파일별 백그라운드 갱신은 하지 않는다(번들러 없는 ES 모듈이 옛/새 버전 섞여 뜨는 것 방지). 갱신은 새 SW 로만.
// - 다른 출처: 뷰어 엔진 호스트만 'av-engines-v1' 에 캐시(CORS 로 다시 받아 opaque 저장 안 함).
//   api.vworld.kr 등 그 밖의 외부 요청은 손대지 않는다(VWorld 약관: 주소 응답 저장 금지).
// - 새 SW 가 기다리면 앱이 [새로 고침] → postMessage('skip') → skipWaiting → 앱이 controllerchange 에서 reload.

// @gen:list-start
const CACHE = 'lite-42d8acc9ec';
const PRECACHE = [
  "./",
  "./css/app.css",
  "./css/camdoor.css",
  "./css/capture.css",
  "./css/day.css",
  "./css/daypager.css",
  "./css/docpicker.css",
  "./css/docs.css",
  "./css/drawings.css",
  "./css/export.css",
  "./css/exporthub.css",
  "./css/folders.css",
  "./css/home.css",
  "./css/livemap.css",
  "./css/map.css",
  "./css/pinmap.css",
  "./css/record.css",
  "./css/reorder.css",
  "./css/settings.css",
  "./css/sharedstage.css",
  "./css/tabbar.css",
  "./css/viewer.css",
  "./icons/apple-touch-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon.svg",
  "./icons/maskable-512.png",
  "./index.html",
  "./js/config.js",
  "./js/core/backup.js",
  "./js/core/date.js",
  "./js/core/geo.js",
  "./js/core/georef.js",
  "./js/core/ledger.js",
  "./js/core/locmap.js",
  "./js/core/model.js",
  "./js/core/order.js",
  "./js/core/recover.js",
  "./js/core/sendplan.js",
  "./js/core/tilemath.js",
  "./js/core/watermark.js",
  "./js/core/xlsx.js",
  "./js/core/xml.js",
  "./js/core/zip.js",
  "./js/data/db.js",
  "./js/data/docs.js",
  "./js/data/drawings.js",
  "./js/data/folders.js",
  "./js/data/photofs.js",
  "./js/data/safety.js",
  "./js/data/sendlog.js",
  "./js/data/snaps.js",
  "./js/data/store.js",
  "./js/media/camera.js",
  "./js/media/docsnap.js",
  "./js/media/drawtile-worker.js",
  "./js/media/drawtiles.js",
  "./js/media/image.js",
  "./js/media/imgworker.js",
  "./js/media/locmapimg.js",
  "./js/media/pipeline.js",
  "./js/media/render.js",
  "./js/media/xlsxworker.js",
  "./js/platform/awake.js",
  "./js/platform/native.js",
  "./js/services/backupio.js",
  "./js/services/exporter.js",
  "./js/services/gps.js",
  "./js/services/heading.js",
  "./js/services/sendflow.js",
  "./js/services/sendrun.js",
  "./js/services/share.js",
  "./js/services/vworld.js",
  "./js/ui/app.js",
  "./js/ui/dom.js",
  "./js/ui/router.js",
  "./js/ui/screens/capture.js",
  "./js/ui/screens/day.js",
  "./js/ui/screens/docs.js",
  "./js/ui/screens/docview.js",
  "./js/ui/screens/drawgeo.js",
  "./js/ui/screens/drawings.js",
  "./js/ui/screens/drawview.js",
  "./js/ui/screens/export.js",
  "./js/ui/screens/exporthub.js",
  "./js/ui/screens/home.js",
  "./js/ui/screens/map.js",
  "./js/ui/screens/record.js",
  "./js/ui/screens/settings.js",
  "./js/ui/screens/viewer.js",
  "./js/ui/widgets/camdoor.js",
  "./js/ui/widgets/daypager.js",
  "./js/ui/widgets/docframe.js",
  "./js/ui/widgets/docpicker.js",
  "./js/ui/widgets/drawingview.js",
  "./js/ui/widgets/drawpicker.js",
  "./js/ui/widgets/folderbar.js",
  "./js/ui/widgets/gpsline.js",
  "./js/ui/widgets/livemap.js",
  "./js/ui/widgets/pinmap.js",
  "./js/ui/widgets/recordrow.js",
  "./js/ui/widgets/reorder.js",
  "./js/ui/widgets/sharedstage.js",
  "./js/ui/widgets/sharefollow.js",
  "./js/ui/widgets/tabbar.js",
  "./js/ui/widgets/thumb.js",
  "./manifest.webmanifest",
  "./tpl/photo-sheet.meta.json",
  "./tpl/photo-sheet.xlsx",
  "./version.json",
  "./viewer/SOURCE.txt",
  "./viewer/engines.json",
  "./viewer/index.html",
];
// @gen:list-end

const ENGINE_CACHE = 'av-engines-v1';
const ENGINE_HOSTS = ['cdn.jsdelivr.net', 'cdn.sheetjs.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const c = await caches.open(CACHE);
    // 하나라도 실패하면 설치 실패 → 옛 SW 가 계속 일한다(반쪽 캐시로 오프라인 빈 화면이 되는 것보다 낫다)
    await Promise.all(PRECACHE.map(async (u) => {
      const res = await fetch(new Request(u, { cache: 'reload' }));
      if (!res.ok) throw new Error('미리 캐시 실패: ' + u + ' ' + res.status);
      await c.put(u, res);
    }));
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('lite-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'skip' || (e.data && e.data.type === 'skip')) self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  let url;
  try { url = new URL(req.url); } catch { return; }

  if (url.origin === self.location.origin) {
    e.respondWith(sameOrigin(req, url));
    return;
  }
  if (ENGINE_HOSTS.includes(url.hostname)) {
    e.respondWith(engine(req));
  }
  // 그 밖의 다른 출처(api.vworld.kr 등)는 respondWith 하지 않는다 → 브라우저가 그대로 처리, 캐시 안 됨
});

async function sameOrigin(req, url) {
  const c = await caches.open(CACHE);
  const scope = new URL(self.registration.scope);
  const rel = url.pathname.startsWith(scope.pathname) ? './' + url.pathname.slice(scope.pathname.length) : null;

  // version.json — 네트워크 우선(새 버전 확인용), 끊기면 캐시
  if (rel === './version.json') {
    try { return await fetch(req, { cache: 'no-store' }); }
    catch { return (await c.match('./version.json')) || Response.error(); }
  }

  // 화면 이동 — 앱 셸(index.html)
  if (req.mode === 'navigate') {
    const hit = (rel && rel !== './' && rel !== './index.html' && !rel.endsWith('/')) ? await c.match(rel) : null;
    if (hit) return hit;                                   // viewer/index.html 같은 다른 페이지
    const shell = (await c.match('./index.html')) || (await c.match('./'));
    if (shell) return shell;
    return fetch(req);
  }

  // 나머지 — 캐시 우선(검색어 무시: ?embed=1 등), 없으면 네트워크(런타임 저장은 하지 않음)
  const hit = rel ? await c.match(rel, { ignoreSearch: true }) : null;
  if (hit) return hit;
  return fetch(req);
}

// 뷰어 엔진(cdn.jsdelivr.net 등) — 주소에 버전이 박혀 있어 캐시 우선이 안전하다
async function engine(req) {
  const c = await caches.open(ENGINE_CACHE);
  const key = req.url;
  const hit = await c.match(key);
  if (hit) return hit;
  try {
    // no-cors 요청(<script> 등)이 와도 CORS 로 다시 받아 투명한 응답을 저장 — opaque 를 저장하면
    // 나중에 같은 주소의 CORS 요청(fetch·worker)에 돌려줄 수 없다.
    const res = await fetch(key, { mode: 'cors', credentials: 'omit', redirect: 'follow' });
    if (res.ok && res.type !== 'opaque') {
      try { await c.put(key, res.clone()); } catch { /* 용량 초과 등 — 저장 못 해도 이번 응답은 준다 */ }
    }
    return res;
  } catch (err) {
    // CORS 를 안 주는 주소면 원래 요청 그대로(저장 안 함). 오프라인이면 실패를 그대로 넘긴다.
    try { return await fetch(req); } catch { return Response.error(); }
  }
}
