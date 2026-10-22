// 설정 화면(SPEC §6.7) — 바꾸면 바로 저장(저장 버튼 없음).
// 1 현장 · 2 워터마크(+미리보기 그림) · 3 촬영(방식·비율·갤러리 저장·저장 위치) · 4 위치(VWorld 키) · 5 백업 · 6 휴지통 · 7 정보
// 입력칸은 한글 조합 중에는 저장을 미루고, store.on 으로 다시 그릴 때 포커스가 있는 칸은 건드리지 않는다(review-notes: 한 글자마다 키보드가 닫히는 문제).
// 백업 ZIP 만들기·복원의 진행 상태와 결과는 화면 밖(flow)에 둔다 — 파일 선택창·공유 앱에 다녀오는 사이 화면이 다시 그려져도 이어진다.
import * as dom from '../dom.js';
import * as store from '../../data/store.js';
import * as safety from '../../data/safety.js';
import * as backupio from '../../services/backupio.js';
import * as vworld from '../../services/vworld.js';
import * as native from '../../platform/native.js';
import * as pipeline from '../../media/pipeline.js';
import * as wm from '../../core/watermark.js';
import * as config from '../../config.js';
import { dayKey, addDays, mdw, hm } from '../../core/date.js';

const { h, icon, toast } = dom;
const DAY = 864e5;
const TRASH_DAYS = config.TRASH_DAYS ?? 30;

// ---- 작은 도우미 ----
function when(ts, now = Date.now()) {
  if (!Number.isFinite(ts)) return '';
  const k = dayKey(ts), today = dayKey(now);
  return `${k === today ? '오늘' : k === addDays(today, -1) ? '어제' : mdw(ts)} ${hm(ts)}`;
}
export const fmtBytes = n => (!Number.isFinite(n) ? '?' : n >= 1e9 ? `${(n / 1e9).toFixed(1)}GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)}MB` : `${Math.max(0, Math.round(n / 1e3))}KB`);
const errText = e => (e?.code === 'QUOTA' ? '저장 공간이 부족해요' : e?.message || String(e || '알 수 없는 오류'));
const isApp = () => { try { return !!native.isNative?.(); } catch { return false; } };

// 공유 버튼을 보일지 — 앱은 늘, 웹은 이 파일을 Web Share 로 보낼 수 있을 때만(크롬은 zip 을 못 보낸다 → 내려받기만)
export function canShareFile(r) {
  if (isApp()) return true;
  try {
    if (!r?.blob || !navigator.canShare) return false;
    return navigator.canShare({ files: [new File([r.blob], r.name, { type: r.blob.type || 'application/zip' })] });
  } catch { return false; }
}

function lock(btn, fn) {
  if (dom.lockButton) return dom.lockButton(btn, fn);
  btn.addEventListener('click', async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    try { await fn(); } finally { btn.disabled = false; }
  });
}

async function save(patch) {
  try { await store.setSettings(patch); }
  catch (e) { console.error('설정 저장 실패', patch, e); toast(`저장하지 못했어요 — ${errText(e)}`); }
}

// 파일 고르기 — dom.pickFiles 가 있으면 그것(입력칸은 body 에 1개), 없으면 여기서 body 에 하나 둔다
let ownInput = null;
function pickFile(accept) {
  if (dom.pickFiles) return dom.pickFiles({ accept, multiple: false });
  return new Promise(resolve => {
    if (!ownInput) {
      ownInput = h('input', { type: 'file', hidden: true, 'data-role': 'settings-file' });
      document.body.append(ownInput);
    }
    ownInput.accept = accept;
    ownInput.value = '';
    ownInput.onchange = () => { const f = Array.from(ownInput.files || []); ownInput.value = ''; resolve(f); };
    ownInput.click();
  });
}

// ---- 화면 밖 상태(다시 mount 돼도 이어짐) ----
const flow = { busy: null, note: '', zip: null, restore: null, vtest: null };
let live = null;                                    // 지금 떠 있는 화면의 paintFlow
const say = t => { flow.note = t; live?.(); };
async function run(kind, failText, fn) {
  if (flow.busy) return;
  flow.busy = kind; flow.note = '';
  live?.();
  try { await fn(); }
  catch (e) { console.warn(failText, e); toast(`${failText} — ${errText(e)}`, 5000); }
  finally { flow.busy = null; flow.note = ''; live?.(); }
}

// ---- 부품 ----
function section(title, ...kids) {
  return h('section', { class: 'st-sec' }, h('h2', { class: 'sec st-sec-title', text: title }), ...kids);
}

// 분할 선택 — 고른 것은 검정 2px + aria-pressed + 체크 표시(색만으로 알리지 않음)
function seg(testid, options, get, set) {
  const btns = options.map(o => h('button', {
    type: 'button', class: 'st-seg-btn', 'data-testid': testid, 'data-value': o.value,
    on: { click: () => { if (get() !== o.value) set(o.value); } },
  }, h('span', { class: 'st-seg-label', text: o.label }), o.sub ? h('span', { class: 'st-seg-sub', text: o.sub }) : null));
  const el = h('div', { class: ['st-seg', options.length > 2 && 'st-seg-3'].filter(Boolean), role: 'group' }, ...btns);
  const paint = () => { const v = get(); for (const b of btns) { const on = b.dataset.value === v; b.setAttribute('aria-pressed', String(on)); b.classList.toggle('on', on); } };
  paint();
  return { el, paint };
}

// 스위치 줄 — 글자 「켜짐/꺼짐」을 같이 보인다
function toggle(testid, label, sub, get, set) {
  const state = h('span', { class: 'st-tg-state' });
  const knob = h('span', { class: 'st-tg', 'aria-hidden': 'true' }, h('span', { class: 'st-tg-dot' }));
  const btn = h('button', { type: 'button', class: 'st-row st-switch', role: 'switch', 'data-testid': testid },
    h('span', { class: 'st-text' }, h('span', { class: 'st-label', text: label }), sub ? h('span', { class: 'st-sub', text: sub }) : null),
    state, knob);
  const paint = () => { const on = !!get(); btn.setAttribute('aria-checked', String(on)); state.textContent = on ? '켜짐' : '꺼짐'; };
  btn.addEventListener('click', async () => { await set(!get()); paint(); });
  paint();
  return { el: btn, paint };
}

// 바로 저장되는 글 입력칸 — 조합 중엔 미루고, 포커스가 있으면 바깥 값으로 덮지 않는다
function textField(testid, label, key, { placeholder = '', hint = null, type = 'text', mono = false } = {}) {
  let composing = false, focused = false, timer = 0, wanted = String(store.settings()[key] ?? '');
  const input = h('input', {
    type, class: ['input', 'st-input', mono && 'st-mono'].filter(Boolean), 'data-testid': testid, placeholder,
    autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', enterkeyhint: 'done', 'aria-label': label,
  });
  input.value = wanted;
  const commit = () => {
    clearTimeout(timer);
    const v = input.value.trim();
    if (v === wanted) return;
    wanted = v;
    save({ [key]: v });
  };
  const later = () => { clearTimeout(timer); timer = setTimeout(commit, 1500); };   // 쓰는 도중에는 저장(→ 화면 다시 그리기)하지 않는다 — 손을 멈추거나 칸을 떠나면(blur·Enter) 저장
  input.addEventListener('focus', () => { focused = true; });
  input.addEventListener('blur', () => { focused = false; commit(); });
  input.addEventListener('compositionstart', () => { composing = true; });
  input.addEventListener('compositionend', () => { composing = false; later(); });
  input.addEventListener('input', e => { if (!e.isComposing && !composing) later(); });
  input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.isComposing && !composing) input.blur(); });
  const paint = () => {
    if (focused || composing) return;
    const cur = String(store.settings()[key] ?? '');
    wanted = cur;
    if (input.value !== cur) input.value = cur;
  };
  const el = h('label', { class: 'st-field' }, h('span', { class: 'st-label', text: label }), input,
    hint ? h('span', { class: 'st-hint' }, hint) : null);
  return { el, input, paint, flush: commit };
}

// ---- 워터마크 미리보기(core/watermark 로 canvas 에 예시) ----
// 원본(작업본) 크기로 배치를 계산하고 축소해서 그린다 — 썸네일·크게 보기와 같은 방식(WYSIWYG)
const SAMPLE_REC = { location: '', content: '2층 슬래브 철근 배근 검측' };
function ratioWH(ratio) {
  if (ratio === '16:9') return [1600, 900];
  if (ratio === '3:4') return [1200, 1600];
  return [1600, 1200];
}
function drawPreview(canvas) {
  const s = store.settings();
  const [W, H] = ratioWH(s.photoRatio);
  const scale = s.photoRatio === '3:4' ? 0.25 : 0.4;
  canvas.width = Math.round(W * scale); canvas.height = Math.round(H * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  // 회색 예시 사진: 하늘·벽·바닥 느낌의 단순 도형
  const g = ctx.createLinearGradient(0, 0, 0, canvas.height);
  g.addColorStop(0, '#9AA1A6'); g.addColorStop(0.55, '#7D848A'); g.addColorStop(1, '#5E6469');
  ctx.fillStyle = g; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(255,255,255,0.10)';
  for (let i = 0; i < 6; i++) ctx.fillRect(canvas.width * (0.08 + i * 0.15), canvas.height * 0.18, canvas.width * 0.06, canvas.height * 0.5);
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.fillRect(0, canvas.height * 0.68, canvas.width, canvas.height * 0.32);
  const opts = wm.wmOpts ? wm.wmOpts(s) : { mode: s.wmMode, date: s.wmDate };
  if (opts.mode === 'off') return;
  const rec = { ...SAMPLE_REC, location: (store.lastLocation?.() || '').trim() || 'A동 3층 기둥 C-12' };
  const photo = { takenAt: Date.now(), takenAtSource: 'camera' };
  let lines;
  try { lines = wm.watermarkLines(rec, photo, { mode: opts.mode, date: opts.date }); } catch { return; }
  if (!lines?.length) return;
  ctx.save();
  ctx.scale(scale, scale);
  const measure = (text, px, bold) => { ctx.font = `${bold ? 800 : 600} ${px}px system-ui, "Apple SD Gothic Neo", "Malgun Gothic", sans-serif`; return ctx.measureText(text).width; };
  try {
    const layout = wm.watermarkLayout(W, H, lines, measure);
    wm.drawWatermark(ctx, W, H, layout);
  } catch (e) { console.warn('워터마크 미리보기 실패', e); }
  ctx.restore();
}

// ---- 휴지통 시트 ----
function openTrash() {
  const box = h('div', { class: 'st-trash', 'data-testid': 'trash-list' });
  const paint = () => {
    const t = store.trash?.() || { records: [], photos: [] };
    const now = Date.now();
    const left = at => Math.max(0, Math.ceil((at + TRASH_DAYS * DAY - now) / DAY));
    const rows = [];
    for (const r of t.records) {
      const n = (r.photoIds || []).length;
      rows.push(trashRow(`${r.location?.trim() || '위치 미입력'}`, `묶음 ${r.no || ''} · 사진 ${n}장 · ${left(r.deletedAt)}일 뒤 삭제`,
        () => store.restoreRecord(r.id, Date.now()), () => store.purgeRecord(r.id), '묶음'));
    }
    for (const p of t.photos) {
      const rec = store.record?.(p.recordId);
      rows.push(trashRow(`사진 · ${rec?.location?.trim() || '위치 미입력'}`, `${when(p.takenAt || p.createdAt, now)} · ${left(p.deletedAt)}일 뒤 삭제`,
        () => store.restorePhoto(p.id, Date.now()), () => store.purgePhoto(p.id), '사진', p.id));
    }
    box.replaceChildren(...(rows.length ? rows : [h('p', { class: 'st-empty', text: '휴지통이 비어 있어요' })]));
  };
  function trashRow(title, sub, restore, purge, what, photoId = null) {
    const back = h('button', { type: 'button', class: 'st-btn st-btn-sm', 'data-act': 'trash-restore' }, icon('undo'), '되살리기');
    const kill = h('button', { type: 'button', class: 'st-btn st-btn-sm st-danger', 'data-act': 'trash-purge', text: '영구 삭제' });
    lock(back, async () => { try { await restore(); toast(`${what}을 되살렸어요`); } catch (e) { toast(`되살리지 못했어요 — ${errText(e)}`); } paint(); });
    lock(kill, async () => {
      const ok = dom.confirmModal ? await dom.confirmModal({ title: `${what}을 영구 삭제할까요?`, text: '되살릴 수 없어요.', okLabel: '영구 삭제', danger: true }) : true;
      if (!ok) return;
      try { await purge(); toast('영구 삭제했어요'); } catch (e) { toast(`지우지 못했어요 — ${errText(e)}`); }
      paint();
    });
    return h('div', { class: 'st-trash-row', 'data-photo-id': photoId || null },
      h('div', { class: 'st-text' }, h('span', { class: 'st-label', text: title }), h('span', { class: 'st-sub', text: sub })),
      h('div', { class: 'st-trash-btns' }, back, kill));
  }
  paint();
  const off = store.on?.(() => paint());
  const build = close => h('div', { class: 'st-sheet' },
    h('div', { class: 'st-sheet-head' }, h('h2', { class: 'st-sheet-title', text: '휴지통' }),
      h('button', { type: 'button', class: 'icbtn', 'aria-label': '닫기', 'data-act': 'trash-close', on: { click: () => close() } }, icon('close'))),
    h('p', { class: 'note st-note', text: `지운 지 ${TRASH_DAYS}일이 지나면 저절로 지워져요.` }),
    box);
  dom.openSheet(build, { onClose: () => off?.() });
}

// ---- 화면 ----
export default {
  dark: false,
  mount(root, params, nav) {
    let dead = false;
    const isNat = isApp();
    const S = () => store.settings();

    // 1. 현장
    const site = textField('set-site', '현장명', 'siteName', { placeholder: '예: ○○아파트 신축공사', hint: '사진대지 현장명 칸에 들어가요' });
    const author = textField('set-author', '작성자', 'author', { placeholder: '이름' });

    // 2. 워터마크
    const preview = h('canvas', { class: 'st-preview', 'data-testid': 'wm-preview', 'aria-label': '워터마크 미리보기' });
    let previewKey = '';
    const repaintPreview = () => {                                          // 미리보기에 쓰는 값이 바뀐 때만 다시 그린다(현장명·키를 쓰는 동안은 그대로)
      if (dead) return;
      const s = S();
      const k = JSON.stringify([s.wmMode, s.wmDate, s.photoRatio, store.lastLocation?.() || '']);
      if (k === previewKey) return;
      previewKey = k;
      drawPreview(preview);
    };
    const wmSeg = seg('set-wm-mode', [
      { value: 'off', label: '끄기' }, { value: 'loc', label: '위치만' }, { value: 'loc+content', label: '위치+내용' },
    ], () => S().wmMode, v => save({ wmMode: v }));
    const wmScreen = toggle('set-wm-screen', '썸네일·크게 보기에도 표시', null, () => S().wmOnScreen, v => save({ wmOnScreen: v }));
    const wmDate = toggle('set-wm-date', '촬영 일시 함께 넣기', null, () => S().wmDate, v => save({ wmDate: v }));
    const wmNote = h('p', { class: 'st-hint st-preview-cap' });
    const paintWm = () => {
      const off = S().wmMode === 'off';
      wmScreen.el.disabled = off; wmDate.el.disabled = off;
      wmNote.textContent = off ? '사진에 아무것도 넣지 않아요' : '내보내는 사진에 이렇게 들어가요';
    };

    // 3. 촬영
    const capSeg = seg('set-capture-mode', [
      { value: 'incam', label: '앱 안 카메라' }, { value: 'syscam', label: '휴대폰 카메라 앱' },
    ], () => S().captureMode, v => save({ captureMode: v }));
    const ratioSeg = seg('set-photo-ratio', [
      { value: '4:3', label: '가로 4:3', sub: '기본' }, { value: '16:9', label: '가로 16:9', sub: '칸에 꽉 차요' }, { value: '3:4', label: '세로 3:4' },
    ], () => S().photoRatio, v => save({ photoRatio: v }));
    const galleryTg = toggle('set-gallery', '원본을 휴대폰 갤러리에도 저장', '앱을 지워도 갤러리에 남아요', () => S().saveToGallery, v => save({ saveToGallery: v }));
    // 고화질 원본: 켜면 앱 안 카메라가 정지 사진(takePhoto, 긴 변 약 3264px)으로 찍는다 — 안드로이드는 장당 1~3초 걸려 기본은 끔(미리보기 프레임으로 바로 찍기)
    const hiresTg = toggle('set-hires', '고화질 원본(느림)', '켜면 사진이 1~3초 늦게 찍혀요', () => S().captureHiRes === true, v => save({ captureHiRes: v }));
    const prefSeg = seg('set-gallery-pref', [{ value: 'sd', label: 'SD카드' }, { value: 'phone', label: '휴대폰' }], () => S().galleryPref, v => save({ galleryPref: v }));
    const sdNote = h('p', { class: 'st-hint', 'data-role': 'sd-note' });
    const failLine = h('div', { class: 'st-inline', 'data-role': 'gallery-failed', hidden: true });
    let hasSD = null;
    const paintGallery = () => {
      const on = !!S().saveToGallery;
      prefSeg.el.hidden = !on; sdNote.hidden = !on;
      sdNote.textContent = hasSD === false ? 'SD카드 없음 — 휴대폰에 저장돼요' : S().galleryPref === 'sd' ? 'SD카드가 없거나 못 넣으면 휴대폰에 저장돼요' : '';
      const photos = store.dump?.().photos || [];
      const failed = photos.filter(p => p.original?.error && !p.deletedAt);
      failLine.hidden = !failed.length;
      if (failed.length) {
        const retry = pipeline.retryOriginals || pipeline.resaveOriginals;
        const btn = retry ? h('button', { type: 'button', class: 'st-btn st-btn-sm', 'data-act': 'gallery-retry', text: '다시 저장' }) : null;
        if (btn) lock(btn, async () => {
          try { const r = await retry(failed.map(p => p.id)); toast(r?.failed ? `${r.saved || 0}장 넣음 · ${r.failed}장은 또 못 넣었어요` : `${r?.saved ?? 0}장을 갤러리에 넣었어요`, 3000); }
          catch (e) { toast(`다시 저장하지 못했어요 — ${errText(e)}`); }
          paintGallery();
        });
        failLine.replaceChildren(h('span', { class: 'st-warn', text: `갤러리에 못 넣은 사진 ${failed.length}장` }), btn);
      }
    };

    // 4. 위치(GPS) — VWorld 키
    const keyField = textField('set-vworld-key', 'VWorld 인증키', 'vworldKey', {
      placeholder: config.VWORLD_KEY ? '비우면 기본 키를 써요' : '인증키를 붙여 넣어요', mono: true,
      hint: `vworld.kr에서 무료 발급 · 서비스 URL은 ${config.VWORLD_DOMAIN || 'https://knotlab.github.io'}`,
    });
    const keyState = h('p', { class: 'st-hint', 'data-role': 'vworld-key-state' });
    const vResult = h('p', { class: 'st-result', 'data-testid': 'vworld-result', role: 'status' });
    const vTest = h('button', { type: 'button', class: 'st-btn st-btn-sm', 'data-testid': 'vworld-test', text: '시험' });
    lock(vTest, async () => {
      keyField.flush();
      const k = keyField.input.value.trim() || vworld.key?.() || '';
      if (!k) { flow.vtest = { ok: false, message: '키가 없어요 — 키를 넣으면 주소로 보여요' }; paintV(); return; }
      flow.vtest = { ok: null, message: '시험하는 중…' }; paintV();
      try { flow.vtest = await vworld.testKey(k); }
      catch (e) { flow.vtest = { ok: false, message: errText(e) }; }
      if (!dead) paintV();
    });
    const paintV = () => {
      const own = !!String(S().vworldKey || '').trim();
      keyState.textContent = own ? '직접 넣은 키를 써요' : config.VWORLD_KEY ? '기본 키를 쓰는 중이에요' : '키 없음 — 좌표만 보여요';
      const t = flow.vtest;
      vResult.hidden = !t;
      if (t) {
        vResult.textContent = t.ok === true ? `됐어요 · ${t.message || '주소를 받아왔어요'}` : t.ok === false ? `안 돼요 · ${t.message || ''}` : t.message;
        vResult.dataset.ok = t.ok === true ? '1' : t.ok === false ? '0' : '';
      }
    };

    // 5. 백업
    const autoLine = h('p', { class: 'st-line', 'data-role': 'auto-backup' });
    const manualLine = h('p', { class: 'st-line', 'data-role': 'manual-backup' });
    const nowBtn = h('button', { type: 'button', class: 'st-btn', 'data-testid': 'backup-now' }, icon('check'), '지금 백업');
    lock(nowBtn, async () => {
      try {
        const r = await safety.backupNow({ reason: 'manual' });
        const where = Array.isArray(r?.where) ? r.where.join(' + ') : r?.where;
        toast(r?.ok ? `백업했어요${where ? ` · ${where}` : ''}` : '백업하지 못했어요', 3000);
      } catch (e) { toast(`백업하지 못했어요 — ${errText(e)}`); }
      paintBackup();
    });
    const makeBtn = h('button', { type: 'button', class: 'st-btn', 'data-testid': 'backup-make' }, icon('zip'), '백업 파일 만들기(사진 포함 ZIP)');
    makeBtn.addEventListener('click', () => run('zip', '백업 파일을 만들지 못했어요', async () => {
      flow.zip = null;
      say('백업 파일을 만드는 중… 앱을 끄지 마세요');
      flow.zip = await backupio.makeBackup((done, total) => say(`백업 파일을 만드는 중… ${done}/${total}`));
      flow.zip.at = Date.now();
      toast('백업 파일을 만들었어요 — 저장하거나 공유해 두세요', 3500);
    }));
    const restoreBtn = h('button', { type: 'button', class: 'st-btn', 'data-testid': 'backup-restore' }, icon('undo'), '백업에서 복원');
    restoreBtn.addEventListener('click', async () => {
      if (flow.busy) return;
      const [file] = await pickFile('.zip,.json,application/zip,application/json');   // 탭 안에서 바로 연다(사용자 동작 안에서만 선택창이 뜸)
      if (!file) return;
      await run('restore', '복원하지 못했어요', async () => {
        flow.restore = null;
        say('백업을 읽는 중…');
        const r = await backupio.restoreBackup(file, (done, total) => say(`복원하는 중… ${done}/${total}`));
        flow.restore = r || { added: 0, updated: 0, skipped: 0, photos: 0 };
        toast(restoreText(flow.restore), 3500);
      });
    });
    const relink = backupio.relinkOriginals || backupio.rebuildFromGallery || pipeline.relinkOriginals;
    const relinkBtn = isNat && relink ? h('button', { type: 'button', class: 'st-btn', 'data-act': 'gallery-relink' }, icon('image'), '갤러리 원본으로 사진 되살리기') : null;
    if (relinkBtn) relinkBtn.addEventListener('click', () => run('relink', '사진을 되살리지 못했어요', async () => {
      say('갤러리에서 원본을 찾는 중…');
      const r = await relink((done, total) => say(`사진 되살리는 중… ${done}/${total}`));
      flow.restore = { ...(flow.restore || {}), gallery: r };
      toast(r ? `${r.found ?? 0}장 되살림 · ${r.missing ?? 0}장 못 찾음` : '끝났어요', 4000);
    }));
    const progress = h('p', { class: 'st-progress', role: 'status', 'data-role': 'backup-progress', hidden: true });
    const zipBox = h('div', { class: 'st-card', 'data-role': 'zip-result', hidden: true });
    const restoreBox = h('div', { class: 'st-card', 'data-role': 'restore-result', role: 'status', hidden: true });
    let zipSig = '';

    function restoreText(r) {
      const n = (r.added || 0) + (r.updated || 0);
      const head = n ? `묶음 ${n}개를 되살렸어요` : '새로 들어온 기록이 없어요(이미 다 있어요)';
      return [head, r.photos ? `사진 ${r.photos}장` : '', r.skipped ? `건너뜀 ${r.skipped}개` : ''].filter(Boolean).join(' · ');
    }
    function paintBackup() {
      const now = Date.now();
      const a = safety.lastAutoBackup?.();
      if (a?.at) {
        const where = Array.isArray(a.where) ? a.where.join(' + ') : a.where;
        autoLine.textContent = `자동 백업 ${when(a.at, now)}${where ? ` · ${where}` : ''}`;
        if (a.localFailed && !isNat) autoLine.textContent = '자동 백업이 꽉 찼어요 — 백업 파일을 만들어 주세요';
      } else autoLine.textContent = '자동 백업 아직 없어요';
      autoLine.classList.toggle('st-warn', !!a?.localFailed && !isNat);
      const m = store.meta?.('lastBackupAt', null);
      const old = !m || now - m > 7 * DAY;
      manualLine.textContent = m ? `백업 파일 ${when(m, now)}${old ? ' · 7일 넘었어요' : ''}` : '백업 파일 아직 안 만들었어요';
      manualLine.classList.toggle('st-warn', old);
    }
    function paintZip() {
      const z = flow.zip, sig = z ? `${z.name}|${z.size}|${z.at}` : '';
      if (sig === zipSig) return;
      zipSig = sig;
      zipBox.hidden = !z;
      if (!z) { zipBox.replaceChildren(); return; }
      const btns = [];
      if (canShareFile(z)) {
        const sh = h('button', { type: 'button', class: 'st-btn st-btn-sm', 'data-act': 'zip-share' }, icon('share'), '공유');
        lock(sh, () => deliver(z, 'share'));
        btns.push(sh);
      }
      const sv = h('button', { type: 'button', class: 'st-btn st-btn-sm', 'data-act': 'zip-save' }, icon('download'), isNat ? '저장' : '내려받기');
      lock(sv, () => deliver(z, 'save'));
      btns.push(sv);
      zipBox.replaceChildren(
        h('span', { class: 'st-file-name', 'data-role': 'zip-name', text: z.name }),
        h('span', { class: 'st-sub', text: [when(z.at), fmtBytes(z.size)].join(' · ') }),
        h('div', { class: 'st-btns' }, ...btns));
    }
    async function deliver(z, how) {
      try {
        const r = await backupio.deliverBackup(z, how);
        if (r && r.ok === false && !r.cancelled) toast(`${how === 'share' ? '공유' : '저장'}하지 못했어요${r.error ? ` — ${r.error}` : ''}`, 4000);
        else if (how === 'save') toast(r?.where && r.where !== 'download' && r.where !== 'share' ? `${r.where}에 저장했어요` : isNat ? '저장했어요' : '내려받았어요');
        paintBackup();
      } catch (e) { toast(`${how === 'share' ? '공유' : '저장'}하지 못했어요 — ${errText(e)}`, 4000); }
    }
    function paintRestore() {
      const r = flow.restore;
      restoreBox.hidden = !r;
      if (!r) return;
      const kids = [];
      if ('added' in r) kids.push(h('p', { class: 'st-line', text: restoreText(r) }));
      if (r.gallery) kids.push(h('p', { class: 'st-line', text: `갤러리 원본 ${r.gallery.found ?? 0}장 되살림 · ${r.gallery.missing ?? 0}장 못 찾음` }));
      if (isNat && relinkBtn && !r.gallery && 'added' in r) kids.push(h('p', { class: 'st-hint', text: '사진이 비어 보이면 [갤러리 원본으로 사진 되살리기]를 눌러요.' }));
      restoreBox.replaceChildren(...kids);
    }
    const paintFlow = () => {
      if (dead) return;
      const busy = !!flow.busy;
      for (const b of [makeBtn, restoreBtn, relinkBtn]) if (b) { b.disabled = busy; }
      makeBtn.setAttribute('aria-busy', String(flow.busy === 'zip'));
      restoreBtn.setAttribute('aria-busy', String(flow.busy === 'restore'));
      progress.hidden = !flow.note;
      progress.textContent = flow.note;
      paintZip(); paintRestore(); paintBackup();
    };

    // 6. 휴지통
    const trashCount = h('span', { class: 'st-sub', 'data-role': 'trash-count' });
    const trashBtn = h('button', { type: 'button', class: 'st-row st-link', 'data-testid': 'trash-open', on: { click: openTrash } },
      icon('trash'), h('span', { class: 'st-text' }, h('span', { class: 'st-label', text: '휴지통' }), trashCount), icon('chev'));
    const paintTrash = () => {
      const t = store.trash?.() || { records: [], photos: [] };
      const n = t.records.length + t.photos.length;
      trashCount.textContent = n ? `묶음 ${t.records.length} · 사진 ${t.photos.length} · ${TRASH_DAYS}일 뒤 자동 삭제` : '비어 있어요';
    };

    // 7. 정보
    const infoBox = h('div', { class: 'st-card st-info', 'data-role': 'storage' }, h('p', { class: 'st-line st-dim', text: '확인하는 중…' }));
    let infoSeq = 0;
    async function paintInfo() {
      const my = ++infoSeq;
      const lines = [];
      let ver = config.APP_VERSION;
      try { if (isNat) { const a = await native.appInfo?.(); if (a?.version) ver = `${a.version}${a.build ? ` (${a.build})` : ''}`; } } catch { /* 웹 */ }
      lines.push(['버전', ver]);
      try {
        const u = await store.usage?.();
        if (u) lines.push(['앱 안 사진', `${u.photos}장 · ${fmtBytes(u.bytes)}`]);
      } catch { /* 넘어감 */ }
      if (isNat) {
        try {
          const vols = await native.storage?.() || [];
          hasSD = vols.some(v => v.removable);
          for (const v of vols) {
            const low = Number.isFinite(v.free) && v.free < 1e9;
            lines.push([v.label || (v.removable ? 'SD카드' : '휴대폰'), `${fmtBytes(v.free)} 남음 / ${fmtBytes(v.total)}${low ? ' · 부족해요' : ''}`, low]);
          }
          if (!vols.some(v => v.removable)) lines.push(['SD카드', '없음']);
        } catch { lines.push(['저장 공간', '확인 못 했어요']); }
      } else {
        try {
          const est = await navigator.storage?.estimate?.();
          if (est) lines.push(['저장 공간', `${fmtBytes(est.usage)} 사용 / ${fmtBytes(est.quota)}`]);
          const kept = await navigator.storage?.persisted?.();
          if (kept != null) lines.push(['저장소 보호', kept ? '켜짐' : '꺼짐 — 백업을 자주 해 두세요', !kept]);
        } catch { /* 넘어감 */ }
      }
      if (dead || my !== infoSeq) return;
      infoBox.replaceChildren(...lines.map(([k, v, warn]) => h('p', { class: ['st-kv', warn && 'st-warn'].filter(Boolean) },
        h('span', { class: 'st-k', text: k }), h('span', { class: 'st-v', text: v }))),
      h('p', { class: 'st-hint', text: isNat ? '휴대폰 앱과 웹(PWA)의 기록은 서로 따로예요. 옮기려면 백업 → 복원.' : '웹(PWA)에는 원본 사진이 따로 남지 않아요. 앱과 웹의 기록은 서로 따로예요(옮기려면 백업 → 복원).' }));
      paintGallery();
    }

    // ---- 조립 ----
    const backBtn = h('button', { type: 'button', class: 'icbtn', 'aria-label': '뒤로', on: { click: () => nav.back() } }, icon('back'));
    const scroll = h('div', { class: 'st-wrap' },
      h('div', { class: 'bar' }, backBtn, h('h1', { text: '설정' })),
      section('현장', h('div', { class: 'st-list' }, site.el, author.el)),
      section('워터마크', wmSeg.el, h('div', { class: 'st-preview-box' }, preview, wmNote), h('div', { class: 'st-list' }, wmScreen.el, wmDate.el)),
      section('촬영',
        h('p', { class: 'st-label st-cap', text: '촬영 방식' }), capSeg.el,
        h('p', { class: 'st-label st-cap', text: '사진 비율' }), ratioSeg.el,
        h('div', { class: 'st-list st-gap' }, hiresTg.el),
        isNat ? h('div', { class: 'st-list st-gap' }, galleryTg.el,
          h('div', { class: 'st-sub-block' }, h('p', { class: 'st-label st-cap', text: '원본 저장 위치' }), prefSeg.el, sdNote), failLine) : null),
      section('위치(GPS)', h('div', { class: 'st-keyrow' }, keyField.el, vTest), keyState, vResult),
      section('백업',
        h('div', { class: 'st-card' }, autoLine, manualLine),
        h('div', { class: 'st-list st-gap' }, nowBtn, makeBtn, zipBox, restoreBtn, relinkBtn, progress, restoreBox),
        h('p', { class: 'st-hint', text: '자료함 파일은 백업에 들어가지 않아요(원본 파일로 다시 올리면 돼요).' })),
      section('휴지통', trashBtn),
      section('정보', infoBox));
    const wrap = h('div', { class: 'scr-settings', 'data-screen': 'settings' }, scroll);
    root.append(wrap);

    const paintAll = () => {
      if (dead) return;
      site.paint(); author.paint(); keyField.paint();
      wmSeg.paint(); wmScreen.paint(); wmDate.paint(); paintWm();
      capSeg.paint(); ratioSeg.paint(); hiresTg.paint(); galleryTg.paint(); prefSeg.paint();
      if (isNat) paintGallery();
      paintV(); paintTrash(); paintFlow();
      repaintPreview();
    };
    live = paintFlow;
    paintAll();
    paintInfo();
    if (params?.focus === 'backup') requestAnimationFrame(() => nowBtn.scrollIntoView({ block: 'center' }));

    // store 알림 → 다음 그림에 한 번. 글칸을 쓰는 중이면(입력 중) 칸을 떠난 뒤 한 번 — 쓰는 동안 화면·미리보기·저장 공간 계산을 돌리지 않는다
    let raf = 0, photosChanged = false;
    const repaint = () => { if (dead || raf) return; raf = requestAnimationFrame(() => { raf = 0; paintAll(); if (photosChanged) { photosChanged = false; paintInfo(); } }); };
    const later = typeof dom.deferWhileTyping === 'function' ? dom.deferWhileTyping(repaint) : repaint;
    const off = store.on?.(ch => {
      if (dead) return;
      if (ch?.photos?.size) photosChanged = true;
      later();
    });

    return () => {
      dead = true;
      site.flush(); author.flush(); keyField.flush();
      if (live === paintFlow) live = null;
      if (raf) cancelAnimationFrame(raf);
      later.cancel?.();
      off?.();
    };
  },
};
