// 촬영 화면 `capture` (SPEC §6.4, §10.6 도면 띄우고 촬영, 도면보관함 설계 §5.6) — 담당 G
// 세로 화면 + 가로 사진: 위에 화면 폭 전체의 가로 상자 뷰파인더, 그 아래 GPS 줄·내용 줄·사진 줄, 맨 아래 조작(엄지 영역).
// params: { recordId?(이어 찍기), day?, docId?(자료), drawingId?·page?(도면), current?(이 화면이 만든 묶음 id — 다시 그려져도 같은 묶음),
//           draftLoc?, draftContent?, createdHere?, camOn?(크게 보기·지도에서 돌아옴 — 문을 바로 연다) }
// 묶음은 첫 사진(또는 휴대폰 카메라 앱을 띄우기 직전·도면에 위치를 찍기 직전)에 만든다. 위치·내용만 고치면 묶음을 만들지 않고 params 에 초안으로 둔다(review-notes).
// 카메라 문(사용자 지시): 들어와도 카메라를 켜지 않는다 — [카메라 열기](또는 셔터) → 문 반쯤 + camera.open → 첫 프레임에 활짝. 백그라운드면 닫히고 돌아와도 자동으로 안 열린다.
// 띄우는 것 두 가지: [자료](자료함 — 엑셀·문서 등, 뷰어 iframe docFrame) / [도면](도면보관함 — 가벼운 타일 보기 drawingView + [📍 위치 찍기] 이름 핀)
import * as dom from '../dom.js';
import * as store from '../../data/store.js';
import * as camera from '../../media/camera.js';
import * as pipeline from '../../media/pipeline.js';
import * as render from '../../media/render.js';
import * as gps from '../../services/gps.js';
import * as native from '../../platform/native.js';
import * as thumbW from '../widgets/thumb.js';
import * as gpslineW from '../widgets/gpsline.js';
import { camDoor } from '../widgets/camdoor.js';
import { sharedStage } from '../widgets/sharedstage.js';
import * as config from '../../config.js';
import { watermarkLines, watermarkLayout, drawWatermark, wmOpts, wmFont } from '../../core/watermark.js';
import { dayKey } from '../../core/date.js';

const RATIOS = ['4:3', '16:9', '3:4'];
const RATIO_LABEL = { '4:3': '가로 4:3', '16:9': '가로 16:9', '3:4': '세로 3:4' };
const RATIO_NUM = { '4:3': 4 / 3, '16:9': 16 / 9, '3:4': 3 / 4 };
const STALE = config.STALE_MS || 10 * 60 * 1000;
const SAVE_WAIT_MS = 8000;                                                   // 뒤로·저장하고 다음 전에 incoming 저장을 기다리는 한도
const KEEP_CAM_MS = 30000;                                                   // 크게 보기·지도에 다녀오는 동안 카메라를 붙잡는 한도(속도 감사 #5 ④)
const LATER_MS = 1500;                                                       // 화면 꺼짐 방지·GPS 끄기를 미루는 시간(감사 #5 ②③ — 금방 돌아오면 브리지 호출 0)
const QUICK_PIN_ACC = 15;                                                    // 위치 맞춘 도면에 내 위치로 바로 핀(1탭) — GPS ±15m 안일 때만
const QUICK_PIN_AGE = 30000;
const STAGE_AUTO_MS = 4000;                                                  // 같은 자리: 마지막 셔터 뒤 도면으로 돌아가는 시간(설정 stageAutoReturn)

let active = null;                                                           // 지금 붙어 있는 화면(onBack 용)

const imp = p => import(p).catch(err => { console.warn('선택 모듈을 못 불렀어요', p, err); return null; });
const fn = (mod, name) => (mod && typeof mod[name] === 'function' ? mod[name] : null);

// 화면 꺼짐 방지 — 화면 밖(모듈)에서 센다. 나갈 때 끄기를 LATER_MS 미뤄 크게 보기·지도에서 돌아오면 취소(브리지 호출 0)
let awakeOn = false, awakeOffT = 0, awakeMod = null;
function holdAwake(mod) {
  if (mod) awakeMod = mod;
  clearTimeout(awakeOffT); awakeOffT = 0;
  if (awakeOn || !awakeMod) return;
  awakeOn = true;
  safe(() => awakeMod.keepAwake?.(true)?.catch?.(() => {}));
}
function dropAwakeLater() {
  clearTimeout(awakeOffT);
  awakeOffT = setTimeout(() => { awakeOffT = 0; if (!awakeOn) return; awakeOn = false; safe(() => awakeMod?.keepAwake?.(false)?.catch?.(() => {})); }, LATER_MS);
}

function el(tag, attrs, ...kids) {                                           // dom.h + 이벤트는 addEventListener 로(h 의 on 처리 방식과 무관하게)
  const { onclick, hidden, ...rest } = attrs || {};
  const node = dom.h(tag, rest, ...kids);
  if (onclick) node.addEventListener('click', onclick);
  if (hidden) node.hidden = true;
  return node;
}
const ic = name => (typeof dom.icon === 'function' ? dom.icon(name) : document.createTextNode(''));

function aspectOf(ratio, o) {                                               // camera.screenAspect 가 없을 때의 같은 규칙(§5.4)
  const f = fn(camera, 'screenAspect');
  if (f) { const v = f(ratio, o); if (Number.isFinite(v) && v > 0) return v; }
  const r = RATIO_NUM[ratio] || 4 / 3;
  return o === 90 || o === 270 ? 1 / r : r;
}

function camErrorText(err) {
  const code = err?.code;
  if (code === 'denied') return native.isNative?.()
    ? '카메라 권한이 꺼져 있어요. 휴대폰 설정 → 앱 → 현장사진대지 lite → 권한에서 카메라를 켜 주세요.'
    : '카메라 권한이 막혀 있어요. 주소창의 자물쇠를 눌러 카메라를 허용해 주세요.';
  if (code === 'nocamera') return '카메라를 찾지 못했어요. 휴대폰 카메라 앱이나 갤러리로 넣어 주세요.';
  if (code === 'insecure') return 'https 주소에서만 카메라를 쓸 수 있어요.';
  if (code === 'busy') return '다른 앱이 카메라를 쓰고 있어요. 그 앱을 닫고 [다시 열기]를 눌러 주세요.';
  return '카메라를 열지 못했어요. [다시 열기]를 누르거나 카메라 앱으로 찍어 주세요.';
}
const saveErrText = err => (err?.code === 'QUOTA' ? '저장 공간이 모자라요. 사진을 정리해 주세요' : '사진을 저장하지 못했어요');

// 파일 고르기 — dom.pickFiles 가 있으면 그것(입력칸은 body 에 1개, review-notes 2), 없으면 같은 방식으로 직접
function pickFiles({ capture = null, multiple = false } = {}) {
  if (typeof dom.pickFiles === 'function') return dom.pickFiles({ capture, multiple, accept: 'image/*' });
  return new Promise(resolve => {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = 'image/*'; input.multiple = !!multiple;
    if (capture) input.setAttribute('capture', capture);
    input.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;opacity:0';
    document.body.append(input);
    let done = false;
    const finish = files => { if (done) return; done = true; input.remove(); resolve(files); };
    input.addEventListener('change', () => finish([...(input.files || [])]));
    input.addEventListener('cancel', () => finish([]));
    input.click();
  });
}

function mount(root, params = {}, nav = {}) {
  const continuing = !!params.recordId;                                      // 버튼 종류는 처음 받은 recordId 로만 정한다
  const todayAtMount = dayKey(Date.now());
  const fixedDay = params.day && params.day !== todayAtMount ? params.day : null;   // 과거 날짜만 고정, 오늘이면 묶음을 만드는 순간의 오늘
  const live = id => { const r = id && store.record(id); return r && !r.deletedAt ? r : null; };
  const syscamMode = safe(() => store.settings(), {}).captureMode === 'syscam';
  const camOnAtMount = !!params.camOn;                                       // 크게 보기·지도에서 돌아옴 — 문을 바로 연다(붙잡아 둔 카메라를 이어 씀)
  params.camOn = false;

  let recId = live(params.recordId)?.id || live(params.current)?.id || null;
  if (!recId) { params.current = null; }
  let createdHere = !continuing && !!params.createdHere && !!recId;
  let loc = recId ? store.record(recId).location : (params.draftLoc ?? safe(() => store.lastLocation(), ''));
  let content = recId ? store.record(recId).content : (params.draftContent ?? '');
  let freshHint = !!params.freshHint;                                        // [저장하고 다음] 직후 "이어받은 위치 · 맞나요?"
  let dead = false, leaving = false, grabbing = false, inflight = 0, creating = null, lastPress = 0, subNav = false;
  let resting = false, restN = 0, typingOn = false;                          // 글 입력 시트가 떠 있는 동안 쉼(아래 「쉬기」)
  let camOpen = false, camFailed = false, camCaps = null, opening = null, camGen = 0;
  let orient = 0, ratio = (safe(() => store.settings(), {}).photoRatio) || '4:3';
  // 띄운 것: 자료(docId — docFrame) 또는 도면(dwgId·dwgPage — drawingView). 한 번에 하나
  let layoutMode = 'cam', frame = null, docId = null, docsMod = null;
  let dwgId = null, dwgPage = 1, dwgMod = null, dvMod = null, view = null, viewCompact = null, viewNew = false, georef = null;
  let placing = null;                                                        // 도면 위치 찍기 중: { pinId?, prevLayout }
  let restoreLayout = null;                                                   // 되살릴 배치(meta captureLayout) — 띄울 것이 실제로 뜰 때 적용(그 전엔 cam)
  const shots = new Map();                                                   // 누른 시각(takenAt) → { settled } — incoming 저장 확인용
  const cleanups = [];
  let hideSnack = null, docTopAt = 0;                                        // [저장하고 다음] 스낵바 닫기 · 도면 작은 창 목표 위치(스낵바 올리기)
  const shown = () => !!(docId || dwgId);

  // ---------- DOM ----------
  const backBtn = el('button', { type: 'button', class: 'icbtn cap-back', 'aria-label': '뒤로', onclick: () => leave() }, ic('back'));
  const locText = el('span', { class: 'cap-loc-text' });
  const locSub = el('small', { class: 'cap-loc-sub' });
  const locChip = el('button', { type: 'button', class: 'cap-loc', 'data-testid': 'loc-chip', onclick: editLoc }, ic('map'), locText, locSub);
  // [자료](자료함)·[도면](도면보관함) — 늘 보이는 위 줄, 언제나 고르기 시트(v0.1.6 — 카메라 중 위 [도면] = 돌아가기 겸용은 없앰. 바꾸기는 셔터 위 바꾸기 단추 하나로).
  // 아이콘 위 + 글자 아래(좁은 폭에서도 위치 칩이 넉넉하게)
  const docsBtn = el('button', { type: 'button', class: 'cap-top-btn cap-docs-btn', 'data-testid': 'cap-docs-btn', 'aria-label': '자료 열기', onclick: () => chooseDoc() }, ic('folder'), el('span', { class: 'cap-top-lab' }, '자료'));
  const dwgBtn = el('button', { type: 'button', class: 'cap-top-btn cap-drawing-btn', 'data-testid': 'cap-drawing-btn', 'aria-label': '도면 열기', onclick: () => chooseDrawing() }, ic('drawing'), el('span', { class: 'cap-top-lab' }, '도면'));
  const top = el('div', { class: 'cap-top' }, backBtn, locChip, docsBtn, dwgBtn);

  const layoutBtn = el('button', { type: 'button', class: 'icbtn cap-layout-btn cap-rot', 'data-testid': 'cap-layout', 'aria-label': '도면·카메라 크게 바꾸기', onclick: () => toggleLayout() }, ic('swap'));
  const fullBtn = el('button', { type: 'button', class: 'icbtn cap-doc-full', 'data-testid': 'cap-doc-full', 'aria-label': '전체 화면으로 보기', onclick: () => openFull() }, ic('zoom'));
  const docIcon = el('span', { class: 'cap-doc-ic' }, ic('doc'));
  const docName = el('span', { class: 'cap-doc-name' });
  const docNameBtn = el('button', { type: 'button', class: 'cap-doc-namebtn', 'aria-label': '다른 것 띄우기', onclick: () => (dwgId ? chooseDrawing() : chooseDoc()) }, docIcon, docName);
  const docChip = el('div', { class: 'cap-doc-chip', 'data-testid': 'cap-doc-chip', hidden: true },
    docNameBtn, layoutBtn, fullBtn,
    el('button', { type: 'button', class: 'cap-doc-x', 'aria-label': '닫기', onclick: () => closeShown() }, ic('close')));
  const sugName = el('span', { class: 'cap-sug-name' });
  let sug = null;                                                            // { kind:'dwg'|'doc', id, page? }
  const sugLab = el('span', { class: 'cap-sug-lab' }, '근처 도면');
  // 제안 = 셔터 위 줄의 단추 하나(누르면 띄우기). 늦게 떠도 뷰파인더·[카메라 열기]를 밀지 않는다
  const suggest = el('button', { type: 'button', class: 'cap-suggest', 'data-testid': 'cap-doc-suggest', hidden: true,
    onclick: async () => {
      if (!sug) return;
      if (sug.kind === 'dwg') await setDrawing(sug.id, sug.page); else await setDoc(sug.id);
      if (!dead && shown()) stage?.showDrawing();                            // 같은 자리: 띄운 것을 바로 보인다
    } },
    sugLab, sugName, el('span', { class: 'cap-doc-act' }, '띄우기'));

  const video = el('video', { class: 'cap-video', autoplay: '', muted: '', playsinline: '' });
  video.muted = true; video.playsInline = true; video.autoplay = true;
  const wmCanvas = el('canvas', { class: 'cap-wm', 'aria-hidden': 'true' });
  const ratioBtn = el('button', { type: 'button', class: 'cap-ratio cap-rot', 'data-testid': 'cap-ratio', onclick: cycleRatio });
  const torchBtn = el('button', { type: 'button', class: 'icbtn cap-torch cap-rot', 'aria-label': '플래시', 'aria-pressed': 'false', hidden: true, onclick: toggleTorch }, ic('flash'));
  // 휴대폰 카메라 앱 모드(설정 captureMode === 'syscam')에서만 — 앱 안 카메라 실패는 카메라 문이 알린다
  const fbText = el('p', { class: 'cap-fb-text' });
  const syscamBtn = el('button', { type: 'button', class: 'cap-fb-main', 'data-testid': 'syscam-btn', onclick: () => shootSystem() }, ic('camera'), '카메라 앱으로 찍기');
  const fbGallery = el('button', { type: 'button', class: 'cap-fb-sub', onclick: () => pickGallery() }, ic('image'), '갤러리에서 고르기');
  const fallback = el('div', { class: 'cap-fallback', 'data-testid': 'cam-fallback', hidden: true }, fbText, syscamBtn, el('div', { class: 'cap-fb-row' }, fbGallery));
  const vf = el('div', { class: 'cap-vf' }, video, wmCanvas, ratioBtn, torchBtn, fallback);
  // 카메라 문 — 누르면 문 반쯤 + camera.open, 첫 프레임에 활짝(camdoor 부품).
  // 같은 창에서 띄운 것이 없을 때 보이는 문 가운데 [카메라 열기]는 같은 창을 거쳐 연다(바꾸기 단추·셔터 자리 [카메라]와 같은 길 — 실패 뒤 [다시 열기]는 그대로 openCam)
  const door = camDoor({ onOpen: () => { if (stage && stage.mode() === 'drawing') stage.showCamera(); else openCam(); } });
  vf.append(door.el);
  const onFirstFrame = () => { if (!dead && camOpen && door.state() === 'opening') door.ready(); };
  video.addEventListener('playing', onFirstFrame);
  video.addEventListener('loadeddata', onFirstFrame);
  cleanups.push(() => { video.removeEventListener('playing', onFirstFrame); video.removeEventListener('loadeddata', onFirstFrame); door.destroy(); });

  const docWrap = el('div', { class: 'cap-docwrap', hidden: true });
  const dwgBox = el('div', { class: 'cap-dwg', hidden: true });              // drawingView 자리(docFrame 과 같은 docWrap 안 — 배치 규칙 그대로)
  const dwgTap = el('button', { type: 'button', class: 'cap-dwg-tap', 'aria-label': '도면 크게 보기', hidden: true, onclick: () => { if (layoutMode === 'cam') toggleLayout(); } });
  docWrap.append(dwgBox, dwgTap);
  const box = el('div', { class: 'cap-box' }, vf);                         // docWrap 은 화면(.cap) 바로 아래 — 자리는 placeDoc 이 잡는다
  const stageWrap = el('div', { class: 'cap-stage' }, box);

  // GPS 줄 — 누르면 실시간 위치 지도('map'). 카메라는 붙잡아 두고 돌아오면 이어 쓴다
  const gl = safe(() => gpslineW.gpsLine({ dark: true, compact: true }), null);
  const gpsRow = el('button', { type: 'button', class: 'cap-gps', 'data-testid': 'cap-gps', 'aria-label': '실시간 위치 지도 열기', onclick: () => goSub('map', {}) },
    gl?.el || '', el('span', { class: 'cap-gps-go', 'aria-hidden': 'true' }, ic('map')));

  const contentText = el('span', { class: 'cap-content-text' });
  const contentRow = el('button', { type: 'button', class: 'cap-content', 'data-testid': 'content-row', onclick: editContent },
    el('span', { class: 'cap-content-lab' }, '내용'), contentText, ic('edit'));

  const strip = el('div', { class: 'cap-strip', 'data-testid': 'strip' });
  const spacer = el('div', { class: 'cap-spacer' });

  const count = el('span', { class: 'cap-count', 'data-testid': 'photo-count' });
  const pend = el('span', { class: 'cap-pending' });
  const countText = el('span', { class: 'cap-count-t' }, count, pend);
  // [📍 위치 찍기] — 도면이 떠 있을 때만, 셔터 바로 위(엄지 자리). 찍는 중이면 [찍기 취소]
  const pinLab = el('span', { class: 'cap-pin-t' }, '위치 찍기');
  const pinBtn = el('button', { type: 'button', class: 'cap-pin', 'data-testid': 'cap-pin', hidden: true, onclick: () => onPinBtn() }, ic('pin'), pinLab);
  // 찍는 중 확정 [여기에 찍기] — 셔터 위 줄 오른쪽(엄지 자리). 도면 보기 부품의 아래 막대는 숨긴다(capture.css)
  const placeOk = el('button', { type: 'button', class: 'cap-place-ok', 'data-testid': 'cap-place-ok', hidden: true, onclick: () => safe(() => view?.placeNow?.()) }, '여기에 찍기');
  const galleryBtn = el('button', { type: 'button', class: 'cap-gallery', 'data-testid': 'gallery-btn', onclick: () => pickGallery() }, el('span', { class: 'cap-rot' }, ic('image')), '갤러리');
  const shutter = el('button', { type: 'button', class: 'cap-shutter', 'data-testid': 'shutter', 'aria-label': '찍기', onclick: () => shoot() }, el('i'));
  const saveNext = el('button', { type: 'button', class: 'cap-next', 'data-testid': 'save-next', onclick: () => saveAndNext() }, continuing ? '다 찍었어요' : '저장하고 다음');

  // 같은 창(설정 captureStage === 'shared' — v0.1.6 부터 기본, 사용자 지시 2026-10-22): 뷰파인더 상자 하나를 도면·카메라가 같이 쓴다 —
  // 셔터 위 줄 오른쪽 바꾸기 단추 [카메라 | 도면](두 상태에서 같은 자리)로 바꾼다: 카메라로 = 문 열림, 도면으로 = 문 닫힘(매번 움직임).
  // 도면이 보이면 셔터 자리도 [카메라](같은 일). 닫은 뒤 60초는 카메라를 쉬게(따뜻하게) 둬 다시 열기가 즉시. 자동 돌아가기는 설정(기본 끔).
  // 'split'(작은 창 — 나란히 보기)은 아래 stage 가 null 이라 예전 그대로
  let stage = null, stageRest = false, stageHold = false;
  const stageAuto = () => (safe(() => store.settings(), {}).stageAutoReturn !== true || !shown() ? 0 : STAGE_AUTO_MS);   // 띄운 것이 없으면 돌아갈 곳이 없다
  if (!syscamMode && safe(() => store.settings(), {}).captureStage === 'shared') {
    stage = sharedStage({
      drawingEl: docWrap, videoEl: video, cameraEl: vf, door,
      openCamera: async () => { stageRest = false; setRest(); if (!camOpen) await openCam(); },
      closeCamera: ({ keepWarm }) => { if (keepWarm) { stageRest = true; setRest(); } else { stageRest = false; closeCam(); setRest(); } },
      autoReturnMs: 0,                                                       // 띄운 것이 생기면 setLayout 이 설정대로 켠다
      onModeChange: m => {
        if (dead) return;
        frame?.setInteractive?.(!!docId && (m === 'drawing' || m === 'closing'));
        screen.dataset.stage = m;
        if (placing && (m === 'opening' || m === 'camera')) cancelPlace();   // 카메라로 바꾸면 위치 찍기는 그만(가려진 십자에 [여기에 찍기]가 남지 않게)
      },
      // empty 를 주지 않는다 — 띄운 것이 없으면 닫힌 카메라 문 + [카메라 열기](작은 창·v0.1.4 와 같은 첫 화면). 도면은 선택이라
      // 사진만 찍는 사람에게 「도면을 띄우면 여기 보여요」·[도면 고르기]를 먼저 내밀지 않는다(v0.1.6 검토). 도면은 위 줄 [도면]으로
    });
    box.replaceChildren(stage.el);                                           // vf → 카메라 층, docWrap → 도면 층(한 번만 — iframe·도면 보기를 붙이기 전)
    cleanups.push(() => stage?.destroy());
    // 되살릴 도면·자료가 없으면 처음부터 닫힌 문(첫 그림부터 — 어두운 빈 상자가 보였다 문으로 바뀌지 않게). 있으면 initDocs 가 띄운 뒤 정한다
    const willShow = !!(params.drawingId || params.docId || safe(() => store.meta('captureDrawing', null), null) || safe(() => store.meta('captureDoc', null), null));
    if (!willShow) stage.setEmpty(true);
  }

  const bot = el('div', { class: 'cap-bot dock' },                        // .dock: router 가 스낵바·토스트를 이 위로 올린다(셔터를 가리지 않게)
    el('div', { class: 'cap-countrow' }, pinBtn, suggest, countText, placeOk, ...(stage ? [stage.toggleButton()] : [])),
    el('div', { class: 'cap-ctrl' }, galleryBtn, stage ? stage.shutterSlot(shutter) : shutter, saveNext));

  const screen = el('div', { class: 'cap', 'data-layout': 'cam', 'data-o': '0', 'data-pin': '0', ...(stage ? { 'data-stage': 'drawing' } : {}) },
    top, docChip, stageWrap, gpsRow, contentRow, strip, spacer, bot, ...(stage ? [] : [docWrap]));
  root.append(screen);

  // ---------- 상태 그리기 ----------
  function paintLoc() {
    const lastShot = Number(safe(() => store.meta('lastShotAt', 0), 0)) || 0;
    const stale = !continuing && lastShot > 0 && Date.now() - lastShot > STALE;
    const t = (loc || '').trim();
    locText.textContent = t || '위치를 적어 주세요';
    locText.classList.toggle('is-empty', !t);
    const warn = stale || freshHint || !t;
    locSub.textContent = stale ? '위치 확인' : freshHint ? '맞나요?' : t ? '바꾸기' : '적기';   // 보조글은 짧게 — 위치 글이 잘리지 않게
    locChip.setAttribute('aria-label', `위치 ${t || '없음'}${freshHint ? ' · 이어받은 위치, 맞나요?' : stale ? ' · 위치 확인' : ''}`);
    locChip.classList.toggle('warn', stale);
    locChip.classList.toggle('hint', !stale && warn);
    locChip.dataset.stale = stale ? '1' : '0';
  }
  function paintContent() {
    const t = (content || '').trim();
    contentText.textContent = t || '눌러서 내용 쓰기';
    contentText.classList.toggle('is-empty', !t);
  }

  const thumbCache = new Map();
  let shownThumbs = 0;
  // 셔터 즉시 칸 — 누르는 순간 사진 줄에 빈 칸(「…」)을 먼저 띄우고, camera.shoot 의 onPreview(약 320px 그림, 워커)가 오면 그림을 채운다.
  // 진짜 칸(같은 takenAt 사진)이 생기거나 저장이 끝나면(실패 포함) 걷는다. 진짜 칸도 pipeline.preview 로 같은 그림을 이어 보인다
  const pendTiles = new Map();                                              // pressAt → { node, url }
  function addPendTile(pressAt) {
    if (dead || pendTiles.has(pressAt)) return;
    const node = el('span', { class: 'cap-th cap-th-pend', 'data-testid': 'strip-pending', 'aria-label': '저장 중' }, el('span', { class: 'cap-th-no' }, '…'));
    pendTiles.set(pressAt, { node, url: null });
    paintStrip();
  }
  function fillPendTile(pressAt, blob) {
    const t = pendTiles.get(pressAt);
    if (dead || !t || t.url || !blob) return;
    try { t.url = URL.createObjectURL(blob); } catch { return; }
    t.node.prepend(el('img', { class: 'thumb cap-th-img', src: t.url, alt: '저장 중', draggable: 'false' }));
  }
  const revokeLater = u => { if (u) setTimeout(() => { try { URL.revokeObjectURL(u); } catch { /* 이미 해제 */ } }, 1000); };
  function dropPendTile(pressAt) {
    const t = pendTiles.get(pressAt);
    if (!t) return;
    pendTiles.delete(pressAt);
    t.node.remove();
    revokeLater(t.url);
    if (!dead) paintStrip();
  }
  cleanups.push(() => { for (const k of [...pendTiles.keys()]) dropPendTile(k); });
  function paintStrip() {
    const rec = live(recId);
    const ps = rec ? safe(() => store.photosOf(rec.id), []) : [];
    count.textContent = `사진 ${ps.length}장`;
    if (pendTiles.size) {
      const have = new Set(ps.map(p => p.takenAt));
      for (const k of [...pendTiles.keys()]) if (have.has(k)) { const t = pendTiles.get(k); pendTiles.delete(k); revokeLater(t.url); }
    }
    const keep = new Set();
    const nodes = ps.map((p, i) => {
      const key = p.id;                                                      // thumb 부품이 처리 완료·워터마크 변경을 스스로 다시 그린다
      keep.add(key);
      let node = thumbCache.get(key);
      if (!node) { node = makeThumb(p); thumbCache.set(key, node); }
      const no = node._no || (node._no = node.querySelector('.cap-th-no'));
      if (no.textContent !== String(i + 1)) no.textContent = String(i + 1);
      return node;
    });
    for (const k of thumbCache.keys()) if (!keep.has(k)) thumbCache.delete(k);
    for (const t of pendTiles.values()) nodes.push(t.node);
    const kids = strip.children;
    let same = kids.length === nodes.length && nodes.length > 0;             // 같은 사진·같은 순서면 줄을 건드리지 않는다(store 알림마다 다시 붙이지 않게)
    for (let i = 0; same && i < nodes.length; i++) if (kids[i] !== nodes[i]) same = false;
    if (same) return;
    const grew = nodes.length > shownThumbs;
    shownThumbs = nodes.length;
    strip.replaceChildren(...(nodes.length ? nodes : [el('span', { class: 'cap-strip-empty' }, '찍은 사진이 여기 보여요')]));
    if (grew) requestAnimationFrame(() => { if (!dead) strip.scrollLeft = strip.scrollWidth; });
  }
  function makeThumb(p) {
    const no = el('span', { class: 'cap-th-no' });
    const open = () => { if (recId) goSub('viewer', { recordId: recId, photoId: p.id }); };
    const img = safe(() => thumbW.thumb(p.id, { className: 'cap-th-img', alt: '찍은 사진' }), null) || el('span', { class: 'cap-th-img' });
    return el('button', { type: 'button', class: 'cap-th', 'data-testid': 'strip-thumb', 'data-id': p.id, 'aria-label': '크게 보기', onclick: open }, img, no);
  }
  function paintPending(n) { pend.textContent = n > 0 ? `· 처리 중 ${n}` : ''; }

  function paintAll() { if (dead) return; paintLoc(); paintContent(); paintStrip(); paintPinBtn(); }

  // ---------- 배치(세로 화면 + 가로 사진) ----------
  let lastBoxKey = '';
  function fit() {
    if (dead) return;
    const ar = aspectOf(ratio, orient);
    screen.style.setProperty('--ar', String(ar));
    const W = stageWrap.clientWidth;
    if (!W) return;
    if (layoutMode === 'cam') {
      const want = Math.round(W / ar);
      if (stageWrap.style.getPropertyValue('--want') !== `${want}px`) stageWrap.style.setProperty('--want', `${want}px`);
      const H = stageWrap.clientHeight || want;
      const bh = Math.min(want, H), bw = Math.min(W, Math.round(bh * ar));
      box.style.width = `${bw}px`; box.style.height = `${Math.round(bw / ar)}px`;
    } else {
      box.style.width = `${W}px`; box.style.height = `${stageWrap.clientHeight}px`;
    }
    const key = `${box.style.width}x${box.style.height}|${orient}|${ratio}|${layoutMode}`;
    if (key !== lastBoxKey) { lastBoxKey = key; requestAnimationFrame(drawWm); }
    placeDoc();
  }
  // 띄운 것의 자리 — doc 배치: 무대 전체. cam 배치: 사진 줄과 조작 버튼 사이 남는 자리(뷰파인더를 가리지 않게),
  // 남는 자리가 너무 낮으면(작은 폰) 뷰파인더 위쪽 모서리 작은 창(폭 40%) — 워터마크 띠(사진 아래쪽)·플래시를 피해서.
  // 폰을 눕히면 띠가 옆으로 가니 반대쪽으로. iframe·도면 보기는 옮기지 않고 자리만 바꾼다
  const DOCK_MIN = 96;
  function placeDoc() {
    if (stage) return;                                                       // 같은 자리: 도면 층이 상자를 채운다(sharedstage.css)
    if (!shown() || docWrap.hidden) return;
    const sr = screen.getBoundingClientRect();
    if (!sr.width) return;
    let l, t, w, hh, place;
    if (layoutMode === 'doc') {
      const b = stageWrap.getBoundingClientRect();
      l = b.left - sr.left; t = b.top - sr.top; w = b.width; hh = b.height; place = 'stage';
    } else {
      const sp = spacer.getBoundingClientRect();
      if (sp.height >= DOCK_MIN) { l = 16; t = sp.top - sr.top + 4; w = sr.width - 32; hh = sp.height - 8; place = 'dock'; }
      else {
        // 뷰파인더 상자의 「목표」 크기(fit 이 정한 style)로 — 상자가 움직이는(150ms) 중의 getBoundingClientRect 로 잡으면 다 줄어든 뒤 어긋난다
        const sb = stageWrap.getBoundingClientRect();
        const bw = parseFloat(box.style.width) || sb.width, bh = parseFloat(box.style.height) || sb.height;
        const left = sb.left + (sb.width - bw) / 2, right = left + bw, topY = sb.top, bottom = sb.top + bh;   // 상자는 무대 가운데·위에 붙는다(.cap-stage)
        w = Math.round(bw * 0.40); hh = Math.round(w * 3 / 4);
        const GAP = 56;                                                      // 플래시·비율 단추(44px + 여백)를 비켜서
        if (orient === 270) { l = left - sr.left + 8; t = topY - sr.top + GAP; }                 // 띠가 오른쪽 → 왼쪽 위
        else if (orient === 180) { l = right - sr.left - 8 - w; t = bottom - sr.top - GAP - hh; }   // 띠가 위 → 오른쪽 아래
        else { l = right - sr.left - 8 - w; t = topY - sr.top + GAP; }                            // 띠가 아래(또는 왼쪽) → 오른쪽 위
        place = 'corner';
      }
    }
    if (docWrap.dataset.place !== place) docWrap.dataset.place = place;
    docTopAt = sr.top + t;                                                   // 목표 자리(움직이는 중의 getBoundingClientRect 가 아니라)
    Object.assign(docWrap.style, { left: `${Math.round(l)}px`, top: `${Math.round(t)}px`, width: `${Math.round(w)}px`, height: `${Math.round(hh)}px` });
    liftSnackOverDoc();
  }
  // 스낵바·토스트: 도면 작은 창이 사진 줄 아래(dock)에 있으면 그 위로, 아니면 조작 줄 위로(router 기본) — [저장하고 다음] 때마다 도면을 가리지 않게
  cleanups.push(() => { hideSnack?.(); hidePinSnack?.(); });                 // 화면을 떠나면 [되돌리기]·[옮기기] 스낵바도 닫는다(떠난 뒤엔 되돌릴 수 없다)
  function liftSnackOverDoc() {
    const snack = document.getElementById('snack');
    if (!snack || dead) return;
    if (shown() && !docWrap.hidden && docWrap.dataset.place === 'dock') {
      const top = docTopAt || docWrap.getBoundingClientRect().top;
      snack.style.setProperty('--snack-lift', `${Math.max(0, Math.round(window.innerHeight - top - 8))}px`);
    } else snack.style.setProperty('--snack-lift', `${bot.offsetHeight}px`);
  }
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => fit()) : null;
  ro?.observe(stageWrap); ro?.observe(screen); ro?.observe(spacer);
  cleanups.push(() => ro?.disconnect());
  // 뷰파인더 크기가 움직임(150ms) 끝에 바뀌어도 워터마크 미리보기를 그 크기로 다시 그린다(늘어난 글자가 남지 않게 — 실제 사진과 같게)
  let wmRaf = 0;
  const wmRo = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { cancelAnimationFrame(wmRaf); wmRaf = requestAnimationFrame(() => { if (!dead) drawWm(); }); }) : null;
  wmRo?.observe(vf);
  cleanups.push(() => { wmRo?.disconnect(); cancelAnimationFrame(wmRaf); });

  function paintRatio() { ratioBtn.textContent = RATIO_LABEL[ratio] || ratio; ratioBtn.dataset.value = ratio; }

  async function cycleRatio() {
    const next = RATIOS[(RATIOS.indexOf(ratio) + 1) % RATIOS.length];
    ratio = next; paintRatio(); fit();
    try { await store.setSettings({ photoRatio: next }); } catch (err) { console.warn('비율 저장 실패', err); }
  }

  // 방향 — camera.onOrientation(바뀔 때만 알림)을 듣는다. 없으면 1초마다 살핀다(예전 300ms 폴링은 촬영 화면을 계속 깨웠다)
  function setOrient(o) {
    o = Number(o) || 0;
    if (o === orient || dead) return;
    orient = o; screen.dataset.o = String(o);
    screen.style.setProperty('--rot', `${o === 270 ? -90 : o}deg`);         // 아이콘·글자를 세계 기준으로 똑바로(camera: 화면 = 사진을 시계 방향 o 만큼 돌린 것)
    fit(); drawWm();
  }
  const readOrient = () => { const f = fn(camera, 'orientation'); return f ? safe(() => f(), 0) : 0; };
  if (fn(camera, 'onOrientation')) {
    const offO = safe(() => camera.onOrientation(setOrient), null);
    if (offO) cleanups.push(offO);
  } else {
    const oTimer = setInterval(() => setOrient(readOrient()), 1000);
    cleanups.push(() => clearInterval(oTimer));
  }

  // ---------- 워터마크 미리보기 띠(사진의 아래쪽에, 같은 layout 함수) ----------
  const mctx = document.createElement('canvas').getContext('2d');
  const measure = (t, px, bold) => { mctx.font = wmFont(px, bold); return mctx.measureText(t).width; };
  // 글·크기·방향이 같으면 다시 그리지 않는다(30초 시계·store 알림·크기 알림이 겹쳐도 한 번). canvas 크기는 바뀔 때만 다시 잡는다
  let wmKeyNow = '', wmStale = false;
  function drawWm() {
    if (dead) return;
    if (resting) { wmStale = true; return; }                                 // 글 입력 시트가 떠 있는 동안은 미루고 닫히면 한 번
    const s = safe(() => store.settings(), {});
    const on = fn(render, 'screenWatermark') ? safe(() => render.screenWatermark(), false) : (s.wmMode !== 'off' && s.wmOnScreen !== false);
    const cw = vf.clientWidth, ch = vf.clientHeight;
    wmCanvas.hidden = !on || !cw || !ch || camFailed;
    if (wmCanvas.hidden) { wmKeyNow = ''; return; }
    const dpr = Math.min(3, window.devicePixelRatio || 1);
    const lines = watermarkLines({ location: loc || '', content: content || '' }, { takenAt: Date.now(), takenAtSource: 'camera' }, wmOpts(s));
    const key = `${cw}x${ch}@${dpr}|${orient}|${lines.join('\n')}`;
    if (key === wmKeyNow) return;
    wmKeyNow = key;
    const pw = Math.round(cw * dpr), ph = Math.round(ch * dpr);
    if (wmCanvas.width !== pw) wmCanvas.width = pw;
    if (wmCanvas.height !== ph) wmCanvas.height = ph;
    const ctx = wmCanvas.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, wmCanvas.width, wmCanvas.height);
    const side = orient === 90 || orient === 270;
    const worldW = side ? ch : cw, worldH = side ? cw : ch;                 // 사진(세계 기준) 크기
    const k = 1600 / Math.max(worldW, worldH);                               // 작업본 크기로 배치를 계산해 축소(WYSIWYG)
    const Wk = worldW * k, Hk = worldH * k;
    if (!lines.length) return;
    const lay = watermarkLayout(Wk, Hk, lines, measure);
    const rot = orient * Math.PI / 180;                                      // 화면 = 사진을 시계 방향 o 만큼 돌린 것(camera.js 약속) → 띠가 사진의 아래쪽에
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.translate(cw / 2, ch / 2);
    ctx.rotate(rot);
    ctx.translate(-worldW / 2, -worldH / 2);
    ctx.scale(1 / k, 1 / k);
    drawWatermark(ctx, Wk, Hk, lay);
  }
  const wmTimer = setInterval(drawWm, 30000);                                // 촬영 시각(분) 갱신(쉬는 동안은 미룸)
  cleanups.push(() => clearInterval(wmTimer));

  // ---------- 쉬기: 글 입력 시트가 떠 있는 동안(2026-10-22 폰 "글이 늦게 쳐짐") ----------
  // 카메라 미리보기(트랙 끔 + 멈춤, 마지막 그림이 남음)·방향 감지·워터마크 미리보기·근처 도면 다시 찾기를 쉰다 — 키보드(IME)와 GPU·메인 스레드를 다투지 않게.
  // 시트가 닫히면 곧바로 다시(트랙을 놓지 않으므로 다시 여는 지연 없음). dom.onTyping 이 있으면 그것도 듣는다(다른 시트·글칸)
  function setRest() {
    const sheet = restN > 0 || typingOn;
    if (stage && sheet !== stageHold) { stageHold = sheet; stage.hold(sheet); }   // 같은 자리: 시트·글 입력 중엔 자동 돌아가기 멈춤
    const on = !dead && (sheet || stageRest);                                 // stageRest: 같은 자리에서 도면이 보이는 동안 카메라 쉼(따뜻하게)
    if (on === resting) return;
    resting = on;
    safe(() => camera.pause?.(on));
    if (!on) { if (wmStale) { wmStale = false; drawWm(); } if (sugStale) { sugStale = false; paintSuggest(true); } }
  }
  async function resting_(p) {                                               // 시트 약속 p 가 끝날 때까지 쉰다(시트를 연 다음에 불러 포커스·키보드를 늦추지 않는다)
    restN++; setRest();
    try { return await p; } finally { restN = Math.max(0, restN - 1); typingOn = false; setRest(); }   // dom 의 「입력 끝」 여유(0.5초)를 기다리지 않고 바로 깨운다
  }
  if (fn(dom, 'onTyping')) {
    const offT = safe(() => dom.onTyping(on => { typingOn = !!on; setRest(); }), null);
    if (typeof offT === 'function') cleanups.push(offT);
  }
  if (fn(dom, 'isTyping')) safe(() => native.setTypingProbe?.(dom.isTyping));
  cleanups.push(() => { restN = 0; typingOn = false; safe(() => camera.pause?.(false)); resting = false; });

  // ---------- 카메라 ----------
  // 휴대폰 카메라 앱 모드에서만 쓰는 안내 판(앱 안 카메라 실패는 카메라 문 door.fail 이 알린다)
  function showFallback(text) {
    camFailed = true;
    fallback.hidden = false;
    fbText.textContent = text;
    video.hidden = true; torchBtn.hidden = true; ratioBtn.hidden = true; wmCanvas.hidden = true;
  }
  function hideFallback() {
    if (!camFailed && fallback.hidden) return;
    camFailed = false; fallback.hidden = true; video.hidden = false; ratioBtn.hidden = false;
    wmKeyNow = ''; drawWm();
  }
  const failDoor = err => door.fail(camErrorText(err), {
    retry: err?.code !== 'insecure' && err?.code !== 'nocamera',
    alt: { label: '카메라 앱으로 찍기', onClick: () => shootSystem() },
  });

  // 카메라 열기 — 문의 [카메라 열기]·셔터·크게 보기에서 돌아옴(camOn)일 때만. 들어오는 것만으로는 켜지 않는다
  async function openCam() {
    if (dead || document.hidden) return;
    if (syscamMode) { showFallback('휴대폰 카메라 앱으로 찍도록 설정돼 있어요.'); return; }
    if (camOpen || opening) return opening;
    if (door.state() === 'closed') door.opening();
    const gen = ++camGen;
    opening = (async () => {
      try {
        camCaps = await camera.open(video);
        // 그사이 이 화면이 카메라를 놓았으면(closeCam·화면 떠남 — 세대가 바뀜) camera 는 이미 닫혔거나 새 열기가 주인이다.
        // 여기서 camera.close() 를 부르면 새로 연 카메라까지 닫혀 가짜 「카메라를 열지 못했어요」가 떴다(v0.1.6 검토 — 닫았다 곧 다시 열기·크게 보기 다녀오기)
        if (dead || gen !== camGen) return;
        const ds = door.state();
        if (ds !== 'opening' && ds !== 'open') { closeCam(); return; }       // 여는 사이 문이 닫힘(이 세대 몫 — 닫는다)
        camOpen = true; hideFallback();
        torchBtn.hidden = !camCaps?.torch;
        if (video.readyState >= 2) door.ready();                             // playing 이 먼저 지나갔으면(붙잡아 둔 카메라를 이어 쓸 때)
      } catch (err) {
        if (gen !== camGen) return;                                          // 지난 세대 — 새 열기가 제 결과를 본다(camOpen 을 건드리지 않는다)
        camOpen = false;
        if (err?.code === 'cancelled') return;                               // 닫았거나 새로 열어 그만둔 열기(camera.js) — 실패가 아니다
        console.warn('카메라를 열지 못했어요', err);
        if (!dead && !document.hidden) failDoor(err);
      } finally {
        if (gen === camGen) opening = null;
      }
    })();
    return opening;
  }
  // 쓰는 중의 끊김·백그라운드는 camera.js 가 알려 준다 — 문을 닫고(돌아와도 자동으로 열지 않는다) 실패면 이유
  const offCam = fn(camera, 'onState') ? camera.onState((st, err) => {
    if (dead) return;
    if (st === 'paused' && stage?.mode() === 'drawing' && stage.isWarm()) { stage.suspend(); return; }   // 쉬던 카메라가 돌아와서 저절로 다시 열리지 않게
    if ((st === 'closed' || st === 'error') && stage) stage.markCold();
    if (st === 'open') { if (!syscamMode) camOpen = true; }
    else if (st === 'paused') { if (door.state() !== 'closed') { closeCam(); door.close({ animate: false }); } }
    else if (st === 'closed') camOpen = false;
    else if (st === 'error') { camOpen = false; if (door.state() !== 'closed' && !document.hidden) failDoor(err); }
  }) : null;
  if (offCam) cleanups.push(offCam);
  function closeCam() { camGen++; opening = null; safe(() => camera.close()); camOpen = false; }

  let gpsStop = null;
  function startGps() { if (!gpsStop && !dead) gpsStop = safe(() => gps.start(), null); }

  async function toggleTorch() {
    const on = torchBtn.getAttribute('aria-pressed') !== 'true';
    try { await camera.setTorch(on); torchBtn.setAttribute('aria-pressed', String(on)); torchBtn.classList.toggle('on', on); }
    catch { dom.toast?.('플래시를 켜지 못했어요'); }
  }

  // 두 손가락 확대(지원 시) — cam 배치에서만. doc 배치에선 작은 창 탭 = 배치 바꾸기
  (() => {
    const ptr = new Map(); let pinch = null, zoom = 1, raf = 0, tap = null;
    vf.addEventListener('pointerdown', e => {
      if (e.target.closest('button')) return;
      ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (ptr.size === 1) tap = { x: e.clientX, y: e.clientY, t: e.timeStamp };
      if (ptr.size === 2 && camCaps?.zoom) { const [a, b] = [...ptr.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, z: zoom }; tap = null; }
    });
    vf.addEventListener('pointermove', e => {
      if (!ptr.has(e.pointerId)) return;
      ptr.set(e.pointerId, { x: e.clientX, y: e.clientY });
      if (tap && Math.hypot(e.clientX - tap.x, e.clientY - tap.y) > 10) tap = null;
      if (pinch && ptr.size >= 2 && layoutMode === 'cam') {
        const [a, b] = [...ptr.values()];
        const zc = camCaps.zoom;
        zoom = Math.min(zc.max, Math.max(zc.min, pinch.z * (Math.hypot(a.x - b.x, a.y - b.y) / pinch.d)));
        if (!raf) raf = requestAnimationFrame(() => { raf = 0; camera.setZoom?.(zoom)?.catch?.(() => {}); });
      }
    });
    const up = e => {
      if (!ptr.has(e.pointerId)) return;
      ptr.delete(e.pointerId);
      if (ptr.size < 2) pinch = null;
      if (e.type === 'pointerup' && tap && e.timeStamp - tap.t < 400 && layoutMode === 'doc') toggleLayout();
      tap = null;
    };
    vf.addEventListener('pointerup', up); vf.addEventListener('pointercancel', up);
  })();

  // ---------- 묶음 ----------
  function ensureRecord() {
    const r = live(recId);
    if (r) return Promise.resolve(r);
    if (!creating) {
      creating = store.createRecord({ day: fixedDay || dayKey(Date.now()), location: (loc || '').trim(), content: (content || '').trim(), now: Date.now() })
        .then(rec => {
          recId = rec.id; params.current = rec.id;
          if (!continuing) { createdHere = true; params.createdHere = true; }
          params.draftLoc = undefined; params.draftContent = undefined;
          paintAll();
          return rec;
        })
        .finally(() => { creating = null; });
    }
    return creating;
  }

  // 누른 사진들이 incoming(디스크)에 들어갔는지 — takenAt 으로 알아본다
  function waitSaved() {
    const pending = () => {
      const ps = recId ? safe(() => store.photosOf(recId), []) : [];
      const have = new Set(ps.map(p => p.takenAt));
      for (const [t, st] of shots) if (st.settled || have.has(t)) shots.delete(t);
      return shots.size > 0 || inflight > 0 || !!creating;
    };
    if (!pending()) return Promise.resolve();
    return new Promise(resolve => {
      const t0 = Date.now();
      const tick = () => { if (!pending() || Date.now() - t0 > SAVE_WAIT_MS) resolve(); else setTimeout(tick, 60); };
      tick();
    });
  }

  // ---------- 동작 ----------
  function flash() {
    vf.classList.remove('flash'); void vf.offsetWidth; vf.classList.add('flash');
    setTimeout(() => vf.classList.remove('flash'), 300);
    try { navigator.vibrate?.(30); } catch { /* 진동 없음 */ }
  }

  // 셔터: 번쩍 + 사진 줄 빈 칸을 누르는 순간에. 카메라는 지금 보이는 프레임을 바로 잡고(인코딩은 워커) onGrab 으로 알린다 —
  // 그때부터 다음 셔터를 받는다(연타가 막히지 않음). 원본이 디스크에 들어가고 처리되는 것은 그 뒤에서(pipeline 줄)
  async function shoot() {
    if (leaving || dead) return;
    if (camFailed) return shootSystem();                                     // 휴대폰 카메라 앱 모드(cam-fallback)
    if (stage && stage.mode() !== 'camera' && stage.mode() !== 'opening') { stage.showCamera(); return; }   // 같은 자리: 도면이 보이는데 셔터 = [카메라]
    if (!camOpen || door.state() !== 'open') {                               // 문이 닫혀 있으면 셔터 = [카메라 열기](실패 뒤엔 [다시 열기])
      if (door.state() === 'closed') door.press(); else dom.toast?.('카메라 켜는 중이에요');
      return;
    }
    if (stage?.mode() === 'opening' && !(await stage.live())) return;       // 따뜻하게 연 바로 그 순간 — 새 프레임 하나(수 ms)
    stage?.noteShot();                                                       // 자동 돌아가기 다시 셈
    flash();
    safe(() => native.markBusy?.());                                          // 갤러리 원본·미러 쓰기를 2초 미룬다(브리지가 다음 셔터·글을 막지 않게)
    if (grabbing) return;                                                    // 같은 순간(프레임을 잡는 몇 ms)의 두 번째 탭 — 눌린 표시만
    grabbing = true; inflight++;
    const pressAt = Math.max(Date.now(), lastPress + 1);                     // 사진마다 다른 takenAt(즉시 칸·저장 확인의 열쇠)
    lastPress = pressAt;
    const fix = safe(() => gps.fixForPhoto(pressAt), null);
    const hiRes = !!safe(() => store.settings(), {}).captureHiRes;
    addPendTile(pressAt);
    try {
      const recP = ensureRecord();
      let shot;
      try { shot = await camera.shoot({ ratio, hiRes, onGrab: () => { grabbing = false; }, onPreview: blob => fillPendTile(pressAt, blob) }); }
      catch (e) { dropPendTile(pressAt); throw e; }
      finally { grabbing = false; }
      const rec = await recP;
      if (!shot) { dropPendTile(pressAt); return; }                         // 같은 순간의 두 번째 탭(camera 가 무시)
      const st = { settled: false };
      shots.set(pressAt, st);
      const opts = { source: 'incam', takenAt: pressAt, takenAtSource: 'camera', gps: fix };
      if (shot.turns != null) opts.turns = shot.turns;
      if (shot.aspect != null) opts.aspect = shot.aspect;
      if (shot.preview) opts.preview = shot.preview;                         // 처리하는 동안 썸네일이 셔터 순간 그림을 보인다
      if (shot.prepared) opts.prepared = shot.prepared;                       // 워커가 같이 만든 작업본·썸네일(다시 디코드하지 않음)
      fillPendTile(pressAt, shot.preview);
      pipeline.ingest(rec.id, shot.blob, opts)
        .catch(err => { console.error('사진 처리 실패', err); dom.toast?.(saveErrText(err)); })
        .finally(() => { st.settled = true; dropPendTile(pressAt); });
      freshHint = false; params.freshHint = false;
      store.setMeta('lastShotAt', pressAt)?.catch?.(() => {});
      paintLoc();
    } catch (err) {
      console.error('찍지 못했어요', err);
      dom.toast?.(err?.code === 'QUOTA' ? saveErrText(err) : '사진을 찍지 못했어요. 다시 눌러 주세요');
    } finally {
      inflight = Math.max(0, inflight - 1);
    }
  }

  let sysBusy = false;                                                       // 카메라 앱을 두 번 띄우지 않게(연타하면 첫 사진을 잃는다)
  async function shootSystem() {
    if (leaving || dead || sysBusy) return;
    sysBusy = true; syscamBtn.disabled = true;
    try { await shootSystemOnce(); } finally { sysBusy = false; syscamBtn.disabled = false; }
  }
  async function shootSystemOnce() {
    let rec;
    try { rec = await ensureRecord(); }                                      // 카메라 앱을 띄우기 전에 묶음부터 저장(§4.5)
    catch (err) { dom.toast?.(saveErrText(err)); return; }
    const pressAt = Date.now();
    const fix = safe(() => gps.fixForPhoto(pressAt), null);
    try {
      if (native.isNative?.()) {
        const p = await pipeline.shootSystem(rec.id, { gps: fix });
        if (p) { store.setMeta('lastShotAt', Date.now())?.catch?.(() => {}); freshHint = false; }
      } else {
        const files = await pickFiles({ capture: 'environment' });
        if (!files.length) return;
        const r = await pipeline.ingestFiles(rec.id, files, { source: 'syscam' });
        if (r?.failed) dom.toast?.(`${r.failed}장은 넣지 못했어요`);
        store.setMeta('lastShotAt', Date.now())?.catch?.(() => {});
        freshHint = false;
      }
    } catch (err) {
      if (err?.code === 'CANCEL' || err?.code === 'BUSY') return;
      console.error('카메라 앱 촬영 실패', err);
      dom.toast?.(err?.code === 'PERMISSION_DENIED' ? '카메라 권한을 허용해 주세요. 휴대폰 설정 → 앱 → 권한' : saveErrText(err));
    } finally { paintAll(); }
  }

  async function pickGallery() {
    if (leaving || dead) return;
    const files = await pickFiles({ multiple: true });
    if (!files.length || dead) return;
    try {
      const rec = await ensureRecord();
      dom.toast?.(`${files.length}장 넣는 중이에요`);
      const r = await pipeline.ingestFiles(rec.id, files, { source: 'gallery' });
      const ok = r?.ok ?? files.length, failed = r?.failed ?? 0;
      dom.toast?.(failed ? `${ok}장 넣고 ${failed}장은 못 넣었어요` : `${ok}장 넣었어요`);
    } catch (err) {
      console.error('갤러리 사진 넣기 실패', err);
      dom.toast?.(saveErrText(err));
    }
  }

  async function editLoc() {
    const v = await resting_(dom.textSheet({ title: '위치', value: loc || '', placeholder: '위치를 적어 주세요', multiline: false, select: 'lastNumber' }));
    if (v == null || dead) return;
    const text = String(v).trim();
    loc = text; freshHint = false; params.freshHint = false;
    paintLoc(); drawWm();                                                    // 확인을 누르면 바로 보인다 — 저장(아래)은 뒤에서
    try {
      if (live(recId)) { await store.updateRecord(recId, { location: text }, Date.now()); syncPinNames(recId, text); }
      else params.draftLoc = text;
      if (!continuing) await store.setLastLocation(text, Date.now());       // 이어 찍기(옛 묶음)에서는 이어받기 값을 바꾸지 않는다
      if (!continuing) await store.setMeta('lastShotAt', Date.now());       // 위치를 확인했으니 10분 강조를 끈다
    } catch (err) { console.error('위치 저장 실패', err); dom.toast?.('위치를 저장하지 못했어요'); }
    if (!dead) paintLoc();
  }

  async function editContent() {
    const v = await resting_(dom.textSheet({ title: '내용', value: content || '', placeholder: '내용을 적어요', multiline: true }));
    if (v == null || dead) return;
    const text = String(v).trim();
    content = text;
    paintContent(); drawWm();                                                // 확인을 누르면 바로 보인다 — 저장은 뒤에서
    try {
      if (live(recId)) await store.updateRecord(recId, { content: text }, Date.now());
      else params.draftContent = text;
    } catch (err) { console.error('내용 저장 실패', err); dom.toast?.('내용을 저장하지 못했어요'); }
  }

  async function saveAndNext() {
    if (leaving || dead) return;
    await waitSaved();
    const rec = live(recId);
    const n = rec ? safe(() => store.photosOf(rec.id).length, 0) : 0;
    if (continuing) { leave(); return; }
    if (!rec || n === 0) { dom.toast?.('사진을 한 장 이상 찍어 주세요'); return; }
    const prev = rec.id;
    cancelPlace();
    recId = null; createdHere = false;
    params.current = null; params.createdHere = false; params.draftLoc = undefined; params.draftContent = undefined;
    loc = safe(() => store.lastLocation(), '') || rec.location || '';
    content = '';
    freshHint = true; params.freshHint = true;
    thumbCache.clear();
    paintAll(); drawWm(); refreshView();                                     // 새 묶음은 핀 없음 — 도면은 그대로라 다음 자리도 1~2탭
    const undo = () => {                                                     // 잘못 눌렀으면 직전 묶음으로 돌아가 이어 찍기
      if (dead || live(recId)) return;
      const r = live(prev);
      if (!r) return;
      recId = prev; params.current = prev; createdHere = true; params.createdHere = true;
      loc = r.location; content = r.content; freshHint = false; params.freshHint = false;
      paintAll(); drawWm(); refreshView();
    };
    liftSnackOverDoc();
    if (typeof dom.snackbar === 'function') hideSnack = dom.snackbar('저장했어요. 다음 묶음', { actionLabel: '되돌리기', onAction: undo });
    else dom.toast?.('저장했어요. 다음 묶음');
  }

  async function leave() {
    if (leaving || dead) return;
    leaving = true;
    try {
      await waitSaved();
      const rec = live(recId);
      // 정말 빈 묶음일 때만 지운다 — 저장이 늦어(느린 폰) 아직 사진 메타가 안 들어왔을 수 있으면 그대로 둔다(빈 묶음이 남는 편이 사진을 잃는 것보다 낫다)
      const settled = inflight === 0 && !creating && !sysBusy && shots.size === 0 && safe(() => pipeline.pending(), 0) === 0;
      const empty = rec && createdHere && settled && (rec.photoIds?.length || 0) === 0 && safe(() => store.photosOf(rec.id).length, 0) === 0;
      const draft = !rec && String(params.draftContent || '').trim();
      if ((empty && (rec.content || '').trim()) || draft) {
        const ok = await dom.confirmModal({ title: '사진 없는 묶음이에요', text: '나가면 쓴 내용이 지워져요.', okLabel: '지우고 나가기', cancelLabel: '계속 찍기', danger: true });
        if (!ok) { leaving = false; return; }
      }
      if (empty) await store.purgeRecord(rec.id).catch(err => console.warn('빈 묶음 정리 실패', err));
    } catch (err) { console.error(err); }
    if (dead) return;
    nav.back ? nav.back() : history.back();
  }

  // 잠깐 다른 화면(크게 보기·지도·전체 화면) — 돌아오면 같은 params 로 다시 mount 된다. 카메라는 붙잡아 두고 문을 바로 연다
  function goSub(name, p = {}) {
    if (dead || leaving || typeof nav.go !== 'function') return;
    subNav = true;
    params.camOn = camOpen && !camFailed && (!stage || stage.mode() === 'camera' || stage.mode() === 'opening');   // 같은 자리에서 도면을 보던 중이면 돌아와도 도면
    try { nav.go(name, p); } catch (err) { subNav = false; params.camOn = false; console.warn('화면을 열지 못했어요', name, err); }
  }

  // ---------- 자료·도면 띄우고 촬영(§10.6, 도면보관함 §5.6) ----------
  function setLayout(mode) {
    if (stage) {                                                             // 같은 자리: 배치 바꾸기 없음 — 상자는 늘 뷰파인더 크기, 도면은 늘 크게(손짓)
      layoutMode = 'cam'; screen.dataset.layout = 'cam';
      layoutBtn.hidden = true; dwgTap.hidden = true;
      vf.removeAttribute('data-testid'); docWrap.removeAttribute('data-testid');
      frame?.setInteractive?.(!!docId && stage.mode() !== 'camera' && stage.mode() !== 'opening');
      if (dwgId) buildView('doc');
      stage.setEmpty(!shown());
      stage.setAutoReturn(stageAuto());
      fit();
      if (view && viewNew) setTimeout(() => {                                // 새로 만든 보기 — 크기가 정해진 뒤 한 번 맞춘다
        if (dead || !view) return;
        safe(() => view.refresh?.());
        if (!placing && !(myPin()?.drawingId === dwgId)) safe(() => view.engine?.()?.fit?.({ animate: false }));
      }, 180);
      viewNew = false;
      return;
    }
    layoutMode = shown() ? mode : 'cam';
    screen.dataset.layout = layoutMode;
    if (layoutMode === 'doc') { vf.setAttribute('data-testid', 'cap-cam-mini'); docWrap.removeAttribute('data-testid'); }
    else { vf.removeAttribute('data-testid'); if (shown()) docWrap.setAttribute('data-testid', 'cap-doc-mini'); else docWrap.removeAttribute('data-testid'); }
    frame?.setInteractive?.(layoutMode === 'doc' && !!docId);
    dwgTap.hidden = !dwgId || layoutMode === 'doc';                          // 작은 창은 탭 = 크게(도면 손짓 대신)
    if (dwgId) buildView();                                                  // 작은 창 = compact(손짓·나침반 없음), 크게 = 손짓·[여기에 찍기]
    stageWrap.style.removeProperty('--want');
    lastBoxKey = '';
    fit();
    requestAnimationFrame(fit);
    if (view) setTimeout(() => {                                             // 크기가 정해진 뒤 한 번 더 — 강조 핀·찍기가 없으면 새 크기에 맞춘다(작은 창에서 점처럼 보이지 않게)
      if (dead || !view) return;
      safe(() => view.refresh?.());
      if (!placing && !(myPin()?.drawingId === dwgId)) safe(() => view.engine?.()?.fit?.({ animate: false }));
    }, 180);
  }
  function toggleLayout() {
    if (stage || !shown()) return;
    const m = layoutMode === 'cam' ? 'doc' : 'cam';
    if (placing && m === 'cam') cancelPlace();
    setLayout(m);
    store.setMeta('captureLayout', m)?.catch?.(() => {});
  }
  function paintChip() {
    docChip.hidden = !shown();
    if (stage) { if (docId && !dwgId) stage.setDrawLabel('자료', 'doc'); else stage.setDrawLabel('도면', 'drawing'); }   // 바꾸기 단추의 도면 쪽 칸 글
    if (dwgId) {
      const d = safe(() => dwgMod?.drawing?.(dwgId), null);
      const pages = d?.pages?.length || 1;
      docName.textContent = `${baseName(d?.name) || '도면'}${pages > 1 ? ` · ${dwgPage}쪽` : ''}`;   // 도면보관함 목록과 같게 확장자 없이
      docIcon.replaceChildren(ic('drawing'));
      screen.dataset.shown = 'dwg';
    } else if (docId) {
      docName.textContent = docOf(docId)?.name || '자료';
      docIcon.replaceChildren(ic('doc'));
      screen.dataset.shown = 'doc';
    } else delete screen.dataset.shown;
  }

  function docOf(id) { const d = id && safe(() => docsMod?.doc?.(id), null); return d && !d.deletedAt ? d : null; }
  function dwgOf(id) { const d = id && safe(() => dwgMod?.drawing?.(id), null); return d && !d.deletedAt ? d : null; }

  function closeShown() {
    if (dwgId) setDrawing(null); else setDoc(null);
  }

  // 자료(자료함) — 뷰어 iframe(docFrame). 도면이 떠 있었으면 내린다
  async function setDoc(id, layout = null) {
    if (dead) return;
    if (!id) {
      docId = null; frame?.close?.(); if (frame) frame.el.hidden = true;
      store.setMeta('captureDoc', null)?.catch?.(() => {});
      if (!dwgId) { docWrap.hidden = true; setLayout('cam'); }
      paintChip(); paintSuggest(true);
      return;
    }
    const d = docOf(id);
    if (!d) { dom.toast?.('자료를 찾을 수 없어요'); return; }
    if (dwgId) dropDrawing();
    store.setMeta('captureDrawing', null)?.catch?.(() => {});
    if (!frame) {
      const mod = await imp('../widgets/docframe.js');
      if (!fn(mod, 'docFrame') || dead) { dom.toast?.('자료를 띄우지 못했어요'); return; }
      frame = mod.docFrame({ onState: () => {}, hint: false });                 // 안내 띠는 자료함·자료 보기에서만(작은 창을 가리지 않게)
      docWrap.prepend(frame.el);                                             // iframe 은 여기 한 번만 붙이고 옮기지 않는다(배치는 CSS 로만)
      frame.onTap?.(() => { if (layoutMode === 'cam') toggleLayout(); });
    }
    frame.el.hidden = false;
    docId = d.id;
    docWrap.hidden = false; setSugHidden(true);
    paintChip();
    store.setMeta('captureDoc', d.id)?.catch?.(() => {});
    setLayout(layout ?? restoreLayout ?? layoutMode); restoreLayout = null;
    try { await frame.open(d.id); docsMod?.markOpened?.(d.id, Date.now())?.catch?.(() => {}); }
    catch (err) { console.warn('자료 열기 실패', err); dom.toast?.('자료를 열지 못했어요'); }
  }

  // 도면(도면보관함) — 가벼운 타일 보기(drawingView). 자료가 떠 있었으면 내린다
  async function loadDrawings() {
    if (dwgMod) return dwgMod;
    const m = await imp('../../data/drawings.js');
    if (!fn(m, 'ready') || dead) return null;
    try { await m.ready(); } catch (err) { console.warn('도면보관함을 못 열었어요', err); return null; }
    if (dead) return null;
    dwgMod = m;
    const offW = fn(m, 'onDrawings') ? m.onDrawings(() => {
      if (dead) return;
      if (dwgId && !dwgOf(dwgId)) setDrawing(null);
      else { paintPinBtn(); paintChip(); }
      if (!dwgId) paintSuggest(true);
    }) : null;
    if (offW) cleanups.push(offW);
    return m;
  }
  function dropDrawing() {                                                   // 도면 보기만 내린다(meta·배치는 부르는 쪽)
    cancelPlace();
    hidePinSnack?.(); hidePinSnack = null;                                   // 「위치를 찍었어요 [옮기기]」 — 도면이 없으면 눌러도 할 일이 없다
    safe(() => view?.destroy?.());
    view = null; viewCompact = null; dwgId = null;
    dwgBox.replaceChildren(); dwgBox.hidden = true; dwgTap.hidden = true;
    paintPinBtn();
  }
  async function setDrawing(id, page) {
    if (dead) return;
    if (!id) {
      dropDrawing();
      store.setMeta('captureDrawing', null)?.catch?.(() => {});
      if (!docId) { docWrap.hidden = true; setLayout('cam'); }
      paintChip(); paintSuggest(true);
      return;
    }
    const m = await loadDrawings();
    if (!m || dead) { dom.toast?.('도면보관함을 열지 못했어요'); return; }
    const d = dwgOf(id);
    if (!d) { dom.toast?.('도면을 찾을 수 없어요'); return; }
    if (!dvMod) dvMod = await imp('../widgets/drawingview.js');
    if (dead) return;
    if (!fn(dvMod, 'drawingView')) { dom.toast?.('도면을 띄우지 못했어요'); return; }
    const pg = Number(page) || (d.pages?.some(p => p.page === dwgPage) && dwgId === id ? dwgPage : (d.pages?.[0]?.page || 1));
    if (docId) { docId = null; frame?.close?.(); if (frame) frame.el.hidden = true; store.setMeta('captureDoc', null)?.catch?.(() => {}); }
    if (view && dwgId === id && dwgPage === pg) { paintChip(); setLayout(restoreLayout ?? layoutMode); restoreLayout = null; return; }
    cancelPlace();
    safe(() => view?.destroy?.()); view = null;
    dwgId = d.id; dwgPage = pg;
    if (!buildView(stage ? 'doc' : (restoreLayout ?? layoutMode))) { dwgId = null; dom.toast?.('도면을 띄우지 못했어요'); return; }
    dwgBox.hidden = false;
    docWrap.hidden = false; setSugHidden(true);
    paintChip(); paintPinBtn();
    store.setMeta('captureDrawing', { id: d.id, page: pg })?.catch?.(() => {});
    setLayout(restoreLayout ?? layoutMode); restoreLayout = null;
    m.markOpened?.(d.id, Date.now())?.catch?.(() => {});
  }
  // 도면 보기 만들기 — 배치마다 compact 가 달라(작은 창: 손짓·나침반 없음 / 크게: 손짓·[여기에 찍기]) 바뀔 때만 다시 만든다(타일은 캐시라 가볍다).
  // 내 위치·보는 방향(gps·나침반 센서)은 위치 맞춘 도면을 「크게」 볼 때만 — 작은 창에서 센서가 셔터·글 입력과 다투지 않게
  function buildView(mode = stage ? 'doc' : layoutMode) {
    if (!dwgId || !fn(dvMod, 'drawingView')) return false;
    const compact = mode !== 'doc';
    if (view && viewCompact === compact) return true;
    safe(() => view?.destroy?.());
    const mine = myPin();
    try {
      view = dvMod.drawingView({
        drawingId: dwgId, page: dwgPage, mode: 'view',
        me: !compact && !!safe(() => dwgMod?.transformOf?.(dwgId), null),
        highlight: mine && mine.drawingId === dwgId ? mine.id : null,
        showPins: 'all', compact,
        onPlace: (x, y) => { if (placing) commitPin(x, y); },
        onTapPin: pinId => onTapPin(pinId),
      });
    } catch (err) { console.warn('도면 보기 실패', err); view = null; viewCompact = null; return false; }
    viewCompact = compact; viewNew = true;
    dwgBox.replaceChildren(view.el);
    return true;
  }
  // 이 묶음 핀을 진하게(묶음이 바뀌거나 핀을 찍은 뒤)
  function refreshView() {
    if (!view) return;
    const mine = myPin();
    const hl = mine && mine.drawingId === dwgId ? mine.id : null;
    if (fn(view, 'setHighlight')) safe(() => view.setHighlight(hl)); else safe(() => view.refresh?.());
  }

  // [자료] — 자료함 고르기 시트(docpicker). 고르면 '도면 크게' 자리에 — 보면서 바로 찍기
  let picking = false;
  async function chooseDoc() {
    if (picking || dead) return;
    picking = true;
    try {
      const [pm] = await Promise.all([imp('../widgets/docpicker.js'), docsReady]);
      if (dead) return;
      if (!fn(pm, 'pickDoc') || !docsMod) { dom.toast?.('자료함을 열지 못했어요'); return; }
      const id = await resting_(pm.pickDoc({ title: docId ? '다른 자료 열기' : '자료 열기', current: docId }));
      if (!id || dead) return;
      restoreLayout = null;
      store.setMeta('captureLayout', 'doc')?.catch?.(() => {});
      if (id !== docId) await setDoc(id, 'doc'); else setLayout('doc');
      if (!dead && docId) stage?.showDrawing();                              // 같은 자리: 고른 자료를 바로 보인다
    } finally { picking = false; }
  }
  // [도면] — 도면보관함 고르기 시트(drawpicker). 처음엔 작은 창(카메라 크게) — 지금 배치 그대로
  async function chooseDrawing() {
    if (picking || dead) return;
    picking = true;
    try {
      const [pm] = await Promise.all([imp('../widgets/drawpicker.js'), loadDrawings()]);
      if (dead) return;
      if (!fn(pm, 'pickDrawing')) { dom.toast?.('도면보관함을 열지 못했어요'); return; }
      const id = await resting_(pm.pickDrawing({ title: dwgId ? '다른 도면 열기' : '도면 열기', current: dwgId }));
      if (!id || dead) return;
      restoreLayout = null;
      await setDrawing(id);
      if (!dead && dwgId) stage?.showDrawing();                              // 같은 자리: 고른 도면을 바로 보인다
    } finally { picking = false; }
  }
  // 전체 화면 — 자료: docview, 도면: drawview(그 묶음 핀). 촬영 상태는 params·meta 가 들고 있어 돌아오면 그대로
  function openFull() {
    if (dwgId) { const p = myPin(); goSub('drawview', { id: dwgId, page: dwgPage, pinId: p && p.drawingId === dwgId ? p.id : null, from: 'capture' }); }
    else if (docId) goSub('docview', { id: docId, from: 'capture' });
  }

  // ---------- 도면에 위치 찍기(이름 핀) ----------
  // 이 묶음의 핀: record.pin({ drawingId, pinId }) → 없으면 drawings.pinsOfRecord(첫 핀)
  function myPin() {
    const r = live(recId);
    if (!r || !dwgMod) return null;
    const ref = r.pin && typeof r.pin === 'object' ? r.pin : null;
    const p = ref?.pinId ? safe(() => dwgMod.pin(ref.pinId), null) : null;
    if (p && !p.deletedAt && dwgOf(p.drawingId)) return p;
    return safe(() => dwgMod.pinsOfRecord?.(r.id), [])?.[0] || null;
  }
  function paintPinBtn() {
    const on = !!dwgId && !!view;
    pinBtn.hidden = !on;
    screen.dataset.pin = on ? '1' : '0';
    screen.dataset.placing = placing ? '1' : '0';                            // 찍는 중엔 카메라 작은 창을 위로(도면의 [취소]·[여기에 찍기]를 가리지 않게)
    placeOk.hidden = !placing;
    countText.hidden = !!placing;
    if (placing) placeOk.textContent = placing.pinId ? '여기로 옮기기' : '여기에 찍기';
    if (!on) return;
    if (placing) { pinLab.textContent = '찍기 취소'; pinBtn.classList.add('is-cancel'); pinBtn.setAttribute('aria-label', '위치 찍기 취소'); return; }
    pinBtn.classList.remove('is-cancel');
    const p = myPin();
    const here = p && p.drawingId === dwgId;
    pinLab.textContent = here ? `핀 ${p.no ?? ''} 옮기기` : '위치 찍기';
    pinBtn.setAttribute('aria-label', here ? `이 묶음 핀(${pinLabel(p)}) 옮기기` : '도면에 이 묶음 위치 찍기');
  }
  function onPinBtn() { if (placing) cancelPlace(true); else startPin(); }

  let pinBusy = false;
  // 위치 맞춘 도면 + GPS 가 괜찮으면 내 위치에 바로(1탭), 아니면 도면 크게 + 찍기 모드(탭/조준점) → onPlace
  async function startPin() {
    if (pinBusy || dead || !dwgId || !view) return;
    stage?.showDrawing({ animate: false });                                  // 같은 자리: 도면 위에 위치 찍기
    pinBusy = true;
    try {
      try { await ensureRecord(); }                                          // 묶음 먼저(§4.5 — 핀이 가리킬 묶음이 저장돼 있어야)
      catch (err) { console.error(err); dom.toast?.('묶음을 만들지 못했어요'); return; }
      if (dead || !dwgId) return;
      const p = myPin();
      if (p && p.drawingId === dwgId) { enterPlace(p.id); return; }          // 이미 이 도면에 있으면 옮기기
      const q = await quickXY();
      if (q) { await commitPin(q.x, q.y, { quick: true }); return; }
      enterPlace(null);
    } finally { pinBusy = false; }
  }
  async function quickXY() {
    if (!georef) georef = await imp('../../core/georef.js');
    const T = safe(() => dwgMod?.transformOf?.(dwgId), null);
    const d = dwgOf(dwgId);
    if (!T || !d || !fn(georef, 'toXY') || (d.geo && d.geo.page !== dwgPage)) return null;
    const pos = safe(() => gps.snapshot().pos, null);
    if (!pos || !(pos.acc <= QUICK_PIN_ACC) || !(Date.now() - (pos.at || 0) <= QUICK_PIN_AGE)) return null;
    const q = safe(() => georef.toXY(T, pos.lat, pos.lng), null);
    const pg = d.pages?.find(x => x.page === dwgPage);
    if (!q || !Number.isFinite(q.x) || !Number.isFinite(q.y) || !pg?.w) return null;
    if (q.x < 0 || q.y < 0 || q.x > pg.w || q.y > pg.h) return null;        // 도면 밖이면 직접 찍기로
    return q;
  }
  let hidePinSnack = null;                                                   // 「위치를 찍었어요 [옮기기]」 스낵바(찍기 모드에 들어가면 닫는다 — [되돌리기]는 그대로)
  function enterPlace(pinId) {
    hidePinSnack?.(); hidePinSnack = null;
    placing = { pinId, prevLayout: layoutMode };
    if (layoutMode !== 'doc') setLayout('doc');                              // 크게 + 손짓(다시 만든 보기)
    const p = pinId ? safe(() => dwgMod?.pin?.(pinId), null) : null;
    safe(() => view?.setMode?.('place', p ? { label: '여기로', at: { x: p.x, y: p.y } } : { label: '여기에 찍기' }));
    paintPinBtn();
  }
  function cancelPlace(restore = false) {
    if (!placing) return;
    const prev = placing.prevLayout;
    placing = null;
    safe(() => view?.setMode?.('view'));
    if (restore && prev && prev !== layoutMode && !dead) setLayout(prev);
    if (!dead) paintPinBtn();
  }
  // 핀 저장 — 같은 도면에 이미 있으면 옮기기(updatePin), 없으면 새 핀(이름 = 묶음 위치 글, 비우면 「핀 n」) + 묶음에 연결
  async function commitPin(x, y, { quick = false } = {}) {
    if (dead || !dwgId || !dwgMod) return;
    const wasPlacing = placing;
    if (placing) cancelPlace(true);
    let rec;
    try { rec = await ensureRecord(); } catch (err) { console.error(err); dom.toast?.('묶음을 만들지 못했어요'); return; }
    const drawingId = dwgId, page = dwgPage;
    try {
      const cur = myPin();
      let p;
      if (cur && cur.drawingId === drawingId) {
        p = await dwgMod.updatePin(cur.id, { x, y, page }, Date.now());
        if (!rec.pin || rec.pin.pinId !== cur.id) await linkPin(rec.id, drawingId, cur.id);
        dom.toast?.(`옮겼어요 · ${pinLabel(p || cur)}`);
      } else {
        if (cur) safe(() => dwgMod.deletePin?.(cur.id, Date.now())?.catch?.(() => {}));   // 다른 도면에 있던 이 묶음 핀은 휴지통으로(묶음 핀은 하나)
        p = await dwgMod.addPin({ drawingId, page, x, y, recordId: rec.id, recordLabel: (loc || '').trim(), now: Date.now() });
        await linkPin(rec.id, drawingId, p.id);
        const label = pinLabel(p);
        if (typeof dom.snackbar === 'function') {
          liftSnackOverDoc();
          hidePinSnack = dom.snackbar(`위치를 찍었어요 · ${label}`, { actionLabel: '옮기기', onAction: () => { if (!dead && dwgId === drawingId) enterPlace(p.id); } });
        } else dom.toast?.(`위치를 찍었어요 · ${label}`);
      }
      if (dead) return;
      refreshView();
      if (viewCompact === false) safe(() => view?.focusPin?.(p.id));
    } catch (err) {
      console.error('핀 저장 실패', err);
      dom.toast?.('위치를 저장하지 못했어요');
      if (wasPlacing && !quick && !dead) enterPlace(wasPlacing.pinId);
    } finally { if (!dead) paintPinBtn(); }
  }
  async function linkPin(recordId, drawingId, pinId) {
    try { await store.updateRecord(recordId, { pin: { drawingId, pinId } }, Date.now()); }
    catch (err) { console.warn('묶음에 핀 연결 실패(핀은 도면보관함에 저장됨)', err); }
  }
  function onTapPin(pinId) {
    if (placing || dead) return;
    const p = safe(() => dwgMod?.pin?.(pinId), null);
    if (!p) return;
    const mine = myPin();
    if (mine && mine.id === p.id) { enterPlace(p.id); return; }              // 이 묶음 핀을 누르면 옮기기
    dom.toast?.(pinLabel(p));
  }
  // 핀 표지 — 「3 101동 3층 욕실」, 기본 이름이면 「핀 3」만(번호가 두 번 나오지 않게)
  function pinLabel(p) {
    if (!p) return '핀';
    const name = String(p.name || '').trim();
    if (!name || name === `핀 ${p.no}`) return `핀 ${p.no ?? ''}`.trim();
    return p.no != null ? `${p.no} ${name}` : name;
  }
  // 위치 글이 바뀌면 기본 이름 핀이 따라간다(직접 고친 이름은 그대로)
  async function syncPinNames(recordId, text) {
    const r = live(recordId);
    if (!r) return;
    if (!dwgMod && !r.pin) return;                                           // 도면을 안 쓰는 묶음이면 도면 DB 를 열지 않는다
    const m = await loadDrawings();
    if (!fn(m, 'syncRecordPinNames')) return;
    try { const n = await m.syncRecordPinNames(recordId, text, Date.now()); if (n && !dead) { refreshView(); paintPinBtn(); } }
    catch (err) { console.warn('핀 이름 따라가기 실패', err); }
  }

  // ---------- 근처 도면·자료 제안 ----------
  // 지금 이 도면 안(위치 맞춘 도면, drawingsAt) → 근처 자료(자료함 anchor). 20m 넘게 움직였을 때만 다시 찾는다(감사 #14)
  let sugT = 0, sugStale = false, sugAt = null, lastSugHidden = true;
  function paintSuggest(force = false) {
    if (dead) return;
    if (resting) { sugStale = true; return; }
    if (shown()) { setSugHidden(true); return; }
    const pos = safe(() => gps.snapshot().pos, null);
    if (!force && pos && sugAt && approxM(pos, sugAt) < 20) return;
    sugAt = pos ? { lat: pos.lat, lng: pos.lng } : null;
    sug = null;
    if (pos && dwgMod) {
      const at = safe(() => dwgMod.drawingsAt(pos, { marginM: 30 }), [])[0];
      if (at?.drawing) sug = { kind: 'dwg', id: at.drawing.id, page: at.drawing.geo?.page, name: at.drawing.name, inside: at.outsideM === 0 };
    }
    if (!sug && pos && docsMod) {
      const near = safe(() => docsMod.nearby(pos, { radius: 200 }), [])[0]?.doc;
      if (near) sug = { kind: 'doc', id: near.id, name: near.name };
    }
    if (sug) {
      sugLab.textContent = sug.kind === 'dwg' ? (sug.inside ? '지금 이 도면 안' : '근처 도면') : '근처 자료';
      sugName.textContent = sug.kind === 'dwg' ? baseName(sug.name) : sug.name;   // 도면은 보관함 목록처럼 확장자 없이, 자료는 종류가 중요해 그대로
    }
    setSugHidden(!sug);
  }
  function setSugHidden(h) {                                                // 셔터 위 줄에 겹친다 — 뷰파인더 배치(fit)는 그대로
    suggest.hidden = h;
    if (h !== lastSugHidden) { lastSugHidden = h; screen.dataset.sug = h ? '0' : '1'; }
  }

  // 자료함·도면보관함은 화면이 뜬 뒤에 연다(첫 그림을 늦추지 않게). 띄워 두었던 것을 되살린다
  let docsReadyRes;
  const docsReady = new Promise(r => { docsReadyRes = r; });
  async function initDocs() {
    const [dm, aw] = await Promise.all([imp('../../data/docs.js'), imp('../../platform/awake.js')]);
    if (dead) { docsReadyRes(); return; }
    holdAwake(aw);
    if (fn(dm, 'docs')) {
      try { dm.docs(); docsMod = dm; } catch { try { await dm.initDocs?.({ now: Date.now() }); docsMod = dm; } catch (err) { console.warn('자료함을 못 열었어요', err); } }
    }
    docsReadyRes();
    if (dead) return;
    const saved = safe(() => store.meta('captureLayout', 'cam'), 'cam');
    restoreLayout = saved === 'doc' ? 'doc' : 'cam';
    // 되살릴 것: params(자료 보기·도면 보기에서 [띄우고 촬영]) → meta. 도면이 먼저(params 에 둘 다 있으면 도면)
    const wantDwg = params.drawingId ? { id: params.drawingId, page: params.page } : (params.docId ? null : safe(() => store.meta('captureDrawing', null), null));
    const wantDoc = params.docId || (wantDwg ? null : safe(() => store.meta('captureDoc', null), null));
    if (docsMod && wantDoc && docOf(wantDoc)) await setDoc(wantDoc);
    else if (!wantDwg) restoreLayout = null;
    if (dead) return;
    // 도면 DB 는 띄울 도면이 있거나 이 묶음에 핀이 있을 때 바로, 아니면 한가할 때(근처 도면 제안용)
    const needNow = !!wantDwg?.id || !!live(recId)?.pin;
    const openDwg = async () => {
      if (dead) return;
      const m = await loadDrawings();
      if (!m || dead) return;
      if (wantDwg?.id && !docId && dwgOf(wantDwg.id)) await setDrawing(wantDwg.id, wantDwg.page);
      else restoreLayout = null;
      paintPinBtn(); paintSuggest(true);
    };
    if (needNow) await openDwg();
    else { const t = setTimeout(openDwg, 1200); cleanups.push(() => clearTimeout(t)); paintSuggest(true); }
    if (!dead && stage) stage.setEmpty(!shown());                            // 같은 자리: 띄울 것이 없으면 한 줄 안내 + [도면 고르기]
    const offD = docsMod && fn(docsMod, 'onDocs') ? docsMod.onDocs(() => { if (docId && !docOf(docId)) setDoc(null); else paintSuggest(true); }) : null;
    if (offD) cleanups.push(offD);
  }

  // ---------- 구독·수명 ----------
  // store 알림 — 이 묶음·설정·lastShotAt 이 바뀐 때만 그 부분만(사진 처리 중에는 알림이 잦다: 저장·처리 끝·갤러리 원본마다)
  const offStore = safe(() => store.on(ch => {
    if (dead) return;
    let strip = false, text = false;
    if (ch?.settings) {
      const s = safe(() => store.settings(), {});
      if (s.photoRatio && s.photoRatio !== ratio) { ratio = s.photoRatio; paintRatio(); fit(); }
      stage?.setAutoReturn(stageAuto());                                     // captureStage 자체는 다음에 촬영 화면에 들어올 때부터
      drawWm();
    }
    if (recId && ch?.records?.has?.(recId)) {
      const r = store.record(recId);
      if (!r || r.deletedAt) { recId = null; params.current = null; createdHere = false; }
      else { loc = r.location; content = r.content; }
      drawWm(); strip = true; text = true;
      paintPinBtn();
    }
    if (!strip && recId && ch?.photos?.size) { for (const pid of ch.photos) if (store.photo(pid)?.recordId === recId) { strip = true; break; } }
    if (ch?.meta?.has?.('lastShotAt')) text = true;
    if (text) { paintLoc(); paintContent(); }
    if (strip) paintStrip();
  }), null);
  if (offStore) cleanups.push(offStore);
  const offPend = fn(pipeline, 'onPending') ? safe(() => pipeline.onPending(paintPending), null) : null;
  if (offPend) cleanups.push(offPend);
  paintPending(safe(() => pipeline.pending?.() || 0, 0));
  const offGps = safe(() => gps.on(() => { clearTimeout(sugT); sugT = setTimeout(() => paintSuggest(), 400); }), null);
  if (offGps) cleanups.push(offGps);

  // 백그라운드로 가면 카메라를 닫고 문도 닫는다 — 돌아와도 자동으로 열지 않는다([카메라 열기]를 다시). APK 는 camera.js 가 native.onPause 로 'paused' 를 알린다
  const onVis = () => {
    if (dead || !document.hidden || syscamMode) return;
    if (door.state() !== 'closed' || camOpen || opening) { closeCam(); door.close({ animate: false }); }
  };
  document.addEventListener('visibilitychange', onVis);
  cleanups.push(() => document.removeEventListener('visibilitychange', onVis));

  paintRatio(); paintAll();
  setOrient(readOrient());                                                   // 지금 방향(아래 선언이 다 끝난 뒤에)
  requestAnimationFrame(fit);
  if (syscamMode) { door.el.hidden = true; openCam(); }
  else if (camOnAtMount && !document.hidden) {                               // 크게 보기·지도에서 돌아옴 — 붙잡아 둔 카메라를 바로 이어 쓴다(문 움직임 없이)
    door.openNow();
    if (stage) stage.showCamera(); else openCam();                           // 같은 자리: 카메라 층으로(stage 가 openCamera → openCam)
  }
  startGps();
  initDocs();

  // 안드로이드 뒤로 — 찍는 중이면 찍기 취소, 도면을 크게 보는 중이면 작게, 그 밖에는 화면을 떠난다(drawview 와 같은 순서)
  const ctl = {
    get leaving() { return leaving; }, leave,
    back() {
      if (placing) { cancelPlace(true); return; }
      if (stage && shown() && stage.showDrawing()) return;                   // 같은 자리: 카메라가 보이면 도면으로(크게 → 작게와 같은 자리)
      if (shown() && layoutMode === 'doc') { toggleLayout(); return; }
      leave();
    },
  };
  active = ctl;

  return () => {
    dead = true;
    if (active === ctl) active = null;
    // 크게 보기·지도로 잠깐 가면 카메라를 30초 붙잡는다(돌아오면 getUserMedia 다시 열기 없이 이어 씀). 그 밖엔 바로 닫는다
    if (subNav && camOpen && !camFailed && fn(camera, 'release')) { camGen++; safe(() => camera.release({ keepMs: KEEP_CAM_MS })); camOpen = false; }
    else closeCam();
    const stopG = gpsStop; gpsStop = null;
    if (stopG) setTimeout(() => safe(stopG), LATER_MS);                      // 금방 돌아오거나 다음 화면도 위치를 쓰면 watch 를 다시 걸지 않게
    gl?.destroy?.();
    clearTimeout(sugT);
    safe(() => view?.destroy?.()); view = null;
    frame?.destroy?.();
    dropAwakeLater();
    for (const f of cleanups) safe(f);
  };
}

// 두 위치 사이 대략 거리(m) — 제안 다시 찾기 판단용(짧은 거리)
function approxM(a, b) {
  const k = 111320, dy = (a.lat - b.lat) * k, dx = (a.lng - b.lng) * k * Math.cos(a.lat * Math.PI / 180);
  return Math.hypot(dx, dy);
}

const baseName = n => String(n ?? '').replace(/\.[A-Za-z0-9]{2,5}$/, '');

function safe(f, fallback) { try { const v = f(); return v === undefined ? fallback : v; } catch (err) { console.warn(err); return fallback; } }

export default {
  dark: true,
  mount,
  onBack() {                                                                 // 뒤로 = [뒤로] 버튼과 같은 정리(저장 기다림·빈 묶음 정리)
    if (!active || active.leaving) return false;
    active.back();
    return true;
  },
};
