// 카톡 보내기(내보내기 탭 — v0.1.5). 고른 묶음 여러 개의 사진을 한꺼번에 공유 창으로, 글은 먼저 클립보드에.
// 카톡은 사진 여러 장과 글을 같이 받지 못한다(글이 빠지거나 사진마다 붙는다 — 원본 앱 sendflow.js 교훈) →
//   ① 글을 먼저 복사(공유 창이 뜨면 이 앱은 포커스를 잃어 클립보드를 못 쓴다) ② 사진을 묶음 순서대로 render.exportJpeg(워터마크 설정 반영)로 굽고
//   ③ 한도마다 나눠 공유 — 앱: native.shareFiles 20장씩(MAX_SHARE_PHOTOS), 웹: navigator.share 10장·50MiB 씩, 공유 창이 없으면 내려받기.
//   나눠지면 [다음 사진 보내기 (2/3)] 시트(widgets/sharefollow.js 와 같은 모양·testid share-next/share-stop).
//   웹에서 굽는 사이 사용자 활성화가 끝나 NotAllowedError 면 [공유하기] 시트로 한 번 더 누르게 한다.
// 굽기는 한 장씩(render 의 기존 슬롯) + 장마다 양보 — 메인 스레드를 오래 잡지 않는다(JPEG 인코딩은 imgworker — render.exportJpeg). 앱은 구운 사진을 바로 CACHE share/ 에 써서 메모리에 쌓지 않는다.
// 묶음(공유 한 번 분량)마다 굽고 바로 보낸다 — 첫 묶음(앱 20 · 웹 10장)만 구워 공유 창을 열고, 사용자가 카톡에 가 있는 동안 다음 묶음을 굽는다(v0.1.5 검토: 40장이면 첫 창까지 약 10초였다).
// 화면 쪽 훅: onCopied(ok) — 글 복사 결과(진행 글에 「글 복사함」), first(run, info) — 첫 공유를 열지(내보내기 탭이 안 보이면 탭할 때까지 기다린다),
//   hold() — 장마다 굽기 전에 기다릴 것(촬영 화면이 열려 있으면 쉰다 — 셔터·글 입력 지연을 되살리지 않게).
// composeText 는 순수 함수(node 단위 시험 tests/unit/sendtext.test.mjs). 저장소·그림·플랫폼 모듈은 쓸 때 연다(node 에서 이 파일을 불러올 수 있게).
// 앱 0.1.7: 내보내기 탭의 「한번에 보내기」는 services/sendrun.js 가 맡는다(단계·보냄 기록·저절로 다음). 이 파일은 카톡 글(composeText — 묶음 글을 만드는 두 곳 중 하나,
//   프리셋 설계 §5.1②)과 예전 흐름 sendRecords(시험·다른 화면용)·사진 저장(⋮ 「사진 휴대폰에 저장」)을 둔다.
//   순서는 사진대지 순서(core/order.js compareByDay — 날짜 → 그 날 순서. 끌어 바꾼 순서가 글 ①②③ 에도 그대로).
import { mdw, dayStart } from '../core/date.js';
import { circled } from '../core/model.js';
import { oneLine } from '../core/watermark.js';
import { compareByDay } from '../core/order.js';

export const APP_PART = 20;                              // config.MAX_SHARE_PHOTOS 와 같게(아래에서 config 값을 쓴다)
export const WEB_PART = 10;                              // 크롬 Web Share 한도
export const WEB_PART_BYTES = 50 * 1024 * 1024;
const CONTENT_MAX = 40;                                  // 한 줄 내용 글자 수(카톡 한 줄에 들어오게)
const LOC_MAX = 40;

const clip = (s, max) => { const ch = Array.from(s); return ch.length > max ? `${ch.slice(0, max - 1).join('').trimEnd()}…` : s; };
const byDay = (a, b) => compareByDay(a, b);
const dayText = d => mdw(dayStart(d));

// ---- 글 ----
// 묶음 하나의 위치·내용 글 — 카톡 글(composeText, 한 줄로 줄임)과 묶음 상세 [공유](share.shareText, full — 여러 줄 그대로)가 함께 쓴다.
//   묶음 글을 만드는 곳은 여기(카톡)와 core/ledger.js sheetContent(사진대지 칸) 둘뿐 — 프리셋 결과 줄은 나중에 이 두 곳에만 붙인다(docs/프리셋-설계.md §5.1②)
export function recordText(record, { full = false } = {}) {
  if (full) return { loc: String(record?.location || '').trim() || '위치 미입력', content: String(record?.content || '').trim() };
  return { loc: clip(oneLine(record?.location), LOC_MAX) || '위치 미입력', content: clip(oneLine(record?.content), CONTENT_MAX) };
}
// records: 묶음 배열(어떤 순서든 — 사진대지 순서(날짜 → 그 날 순서)로 줄 세운다). 옵션:
//   siteName — 머리 [현장명](비면 뺀다) · day 또는 from,to — 머리 날짜(안 주면 묶음들의 날짜에서) ·
//   photoCount(record) → 그 묶음에서 보낼 사진 수(안 주면 record.photoCount, 그것도 없으면 photoIds 길이) ·
//   more — Map|객체 recordId → n: 보낸 뒤 더 생긴 사진만 보내는 묶음(줄 끝이 「(사진 n장 더)」, n = 보낼 사진 수) ·
//   seqOf(record, i) → 번호(안 주면 1부터 차례) — 한번에 보내기는 사진대지 순번(대장 「순번」과 같은 수)을 준다
// → '[현장명] 10/22(수) 현장 사진 4건 · 9장' + 묶음마다 '① 위치 — 내용 한 줄 (사진 n장)'. 여러 날이면 날짜마다 '■ 10/21(화)' 줄. 묶음이 없으면 ''
export function composeText(records, { siteName = '', day = null, from = null, to = null, photoCount = null, more = null, seqOf = null } = {}) {
  const list = [...(records || [])].filter(Boolean).sort(byDay);
  if (!list.length) return '';
  const count = r => {
    const n = typeof photoCount === 'function' ? photoCount(r) : (Number.isFinite(r.photoCount) ? r.photoCount : (r.photoIds?.length || 0));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const f = from || day || list[0].day, t = to || day || list.at(-1).day;
  const when = f === t ? dayText(f) : `${dayText(f)}~${dayText(t)}`;
  const total = list.reduce((n, r) => n + count(r), 0);
  const site = oneLine(siteName);
  const lines = [`${site ? `[${site}] ` : ''}${when} 현장 사진 ${list.length}건${total ? ` · ${total}장` : ''}`];
  const multi = new Set(list.map(r => r.day)).size > 1;
  const isMore = id => !!(more && (more instanceof Map ? more.has(id) : Object.prototype.hasOwnProperty.call(more, id)));
  let lastDay = null;
  for (const [i, r] of list.entries()) {
    if (multi && r.day !== lastDay) { lines.push(`■ ${dayText(r.day)}`); lastDay = r.day; }
    const { loc, content } = recordText(r);
    const n = count(r);
    const no = typeof seqOf === 'function' ? Number(seqOf(r, i)) : NaN;
    const tail = n ? `사진 ${n}장${isMore(r.id) ? ' 더' : ''}` : '사진 없음';
    lines.push(`${circled(Number.isFinite(no) && no > 0 ? no : i + 1)} ${loc}${content ? ` — ${content}` : ''} (${tail})`);
  }
  return lines.join('\n');
}

// 나눠 보낼 횟수(화면 안내용 어림 — 웹은 크기 한도도 있어 실제가 더 많을 수 있다)
export function partsFor(n, { native = false } = {}) { return n > 0 ? Math.ceil(n / (native ? APP_PART : WEB_PART)) : 0; }

// ---- 안쪽 도우미 ----
let mods = null;
async function load() {
  if (!mods) {
    const p = Promise.all([
      import('../data/store.js'), import('../media/render.js'), import('../platform/native.js'),
      import('./share.js'), import('../core/ledger.js'), import('../config.js'),
    ]).then(([store, render, N, share, ledger, config]) => ({ store, render, N, share, ledger, config }));
    mods = p;
    p.catch(() => { if (mods === p) mods = null; });
  }
  return mods;
}
const yieldNow = () => (globalThis.scheduler?.yield ? globalThis.scheduler.yield() : new Promise(r => setTimeout(r, 0)));
const isNativeOf = N => { try { return !!N.isNative?.(); } catch { return false; } };
const tell = (fn, ...a) => { try { fn?.(...a); } catch (e) { console.error(e); } };

// 고른 id → 살아 있는 묶음(사진대지 순서 — 날짜 → 그 날 순서) + 묶음마다 ready 사진
function gather(store, recordIds) {
  const seen = new Set();
  const records = [];
  for (const id of recordIds || []) {
    if (seen.has(id)) continue;
    seen.add(id);
    const r = store.record(id);
    if (r && !r.deletedAt) records.push(r);
  }
  records.sort(byDay);
  const photosBy = new Map(records.map(r => [r.id, store.photosOf(r.id).filter(p => p.state === 'ready')]));
  const rows = records.flatMap(r => photosBy.get(r.id).map(photo => ({ record: r, photo })));
  return { records, photosBy, rows, from: records[0]?.day || null, to: records.at(-1)?.day || null };
}

// 한도에 맞게 나누기 — 크기 한도는 웹만
function batch(items, maxFiles, maxBytes = Infinity) {
  const out = [];
  let cur = [], bytes = 0;
  for (const it of items) {
    if (cur.length && (cur.length >= maxFiles || bytes + it.size > maxBytes)) { out.push(cur); cur = []; bytes = 0; }
    cur.push(it); bytes += it.size;
  }
  if (cur.length) out.push(cur);
  return out;
}

// 사진 굽기 — 한 장씩, 장마다 양보. rows: [{ photo, name }]. put(name, bytes) 이 각 장을 받아 둔다(앱: CACHE 파일, 웹: File). 그만두면 cancelled
// tick() 은 장마다(진행 글), hold() 는 장마다 굽기 전에(촬영 화면 등 — 기다리는 동안 굽지 않는다)
async function bake(M, rows, { tick, signal, put, hold }) {
  const items = [];
  let skipped = 0;
  for (const r of rows) {
    if (signal?.aborted) return { items, skipped, cancelled: true };
    if (hold) { try { await hold(); } catch { /* 그냥 굽는다 */ } }
    if (signal?.aborted) return { items, skipped, cancelled: true };
    try {
      const bytes = await M.render.exportJpeg(r.photo.id, { keep: false });   // 한 번 쓰고 끝 — 구운 그림 캐시에 남기지 않는다(비울 때가 없다)
      items.push(await put(r.name, bytes));
    } catch (e) { console.warn('보낼 사진을 만들지 못했어요', r.photo.id, e); skipped++; }
    tell(tick);
    await yieldNow();
  }
  return { items, skipped, cancelled: !!signal?.aborted };
}
const named = (M, rows) => { const names = M.ledger.photoFileNames(rows); return rows.map((r, i) => ({ ...r, name: names[i] })); };
const chunk = (list, n) => { const out = []; for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n)); return out; };

// 다음 단계 시트(sharefollow.js 의 step 과 같은 모양) — 주 버튼 탭 안에서 run() 을 부른다(공유 창은 사용자 탭 안에서만 뜬다). [그만]·뒤로 = null
async function defaultAsk({ title, label, note }, run) {
  const { h, openSheet } = await import('../ui/dom.js');
  return new Promise(resolve => {
    let res = null;
    openSheet(close => h('div', { class: 'sheet-body' },
      h('h2', { class: 'sheet-title', text: title }),
      note ? h('p', { class: 'note', 'data-testid': 'share-note', text: note }) : null,
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'secondary', 'data-testid': 'share-stop', text: '그만', onclick: () => close() }),
        h('button', { type: 'button', class: 'primary', 'data-testid': 'share-next', text: label, onclick: () => { res = run(); close(); } }))),
    { label: title, onClose: () => resolve(res) });
  });
}

let running = false, seq = 0;
export const isBusy = () => running;

// 고른 묶음을 보낸다 → { ok, sent, total, parts, copied, cancelled, where?, skipped, text, textOnly?, error? }
//   sent = 실제로 공유 창(또는 내려받기)에 넘긴 사진 수, parts = 나눈 횟수, copied = 글을 클립보드에 넣었는지.
// 옵션: onProgress(done, total) — 굽는 동안 · signal(AbortSignal) — 굽기 그만 · ask — 다음 단계 시트(시험·화면이 바꿔 끼울 수 있다) ·
//   limit — 한 번에 보낼 장 수(시험용, 안 주면 앱 20 · 웹 10) · onCopied(ok) · first(run, { n, total }) → run() 결과 | null(그만) · hold()
export async function sendRecords(recordIds, { onProgress, signal, ask = defaultAsk, limit = null, onCopied = null, first = null, hold = null } = {}) {
  const none = { ok: false, sent: 0, total: 0, parts: 0, copied: false, cancelled: false, skipped: 0, text: '' };
  if (running) return { ...none, busy: true, error: '보내는 중이에요' };
  running = true;
  try {
    const M = await load();
    const { store, N, share, config } = M;
    await store.flush?.();                                                    // 막 고친 위치·내용까지 글에 담는다
    const g = gather(store, recordIds);
    if (!g.records.length) return { ...none, error: '고른 묶음이 없어요' };
    const siteName = store.settings().siteName || g.records.find(r => r.site)?.site || '';
    const text = composeText(g.records, { siteName, from: g.from, to: g.to, photoCount: r => g.photosBy.get(r.id)?.length || 0 });
    // ① 글 먼저(탭 직후 — 웹 클립보드는 사용자 활성화·포커스가 있을 때만 된다)
    const copied = await N.copyText(text);
    tell(onCopied, copied);
    if (!g.rows.length) return { ...none, ok: copied, copied, text, textOnly: true };

    // ② 사진 굽기 — 공유 한 번 분량(chunk)씩. 첫 묶음을 굽고 나면 나머지는 뒤에서(보내는 동안) 이어 굽는다
    const native = isNativeOf(N);
    const dir = `share/${Date.now()}-${++seq}`;
    const put = native
      ? async (name, bytes) => ({ name, size: bytes.length, uri: await N.writeCache(`${dir}/${name}`, bytes) })
      : async (name, bytes) => ({ name, size: bytes.length, file: new File([bytes], name, { type: 'image/jpeg' }) });
    const noShare = !native && (typeof navigator === 'undefined' || !navigator.share || !navigator.canShare);
    const per = limit || (native ? (config.MAX_SHARE_PHOTOS || APP_PART) : WEB_PART);
    const rows = named(M, g.rows);
    const chunks = noShare ? [rows] : chunk(rows, per);
    const inner = typeof AbortController === 'function' ? new AbortController() : null;   // [그만](시트)·밖의 그만 둘 다
    const sig = inner?.signal || signal;
    const onAbort = () => inner?.abort();
    signal?.addEventListener?.('abort', onAbort);
    if (signal?.aborted) inner?.abort();
    let done = 0, skipped = 0, bakeCancelled = false, bakeDone = false;
    const tick = () => { done++; tell(onProgress, done, rows.length); };
    tell(onProgress, 0, rows.length);
    const groups = [];                                                        // 구워진 공유 묶음(웹은 크기 한도로 더 잘게)
    let wake = null;
    const kick = () => { const w = wake; wake = null; w?.(); };
    const addGroup = items => { if (items.length) groups.push(...(noShare ? [items] : batch(items, per, native ? Infinity : WEB_PART_BYTES))); kick(); };
    const b0 = await bake(M, chunks[0], { tick, signal: sig, put, hold });
    skipped += b0.skipped;
    if (b0.cancelled) { signal?.removeEventListener?.('abort', onAbort); return { ...none, copied, text, cancelled: true, skipped }; }
    addGroup(b0.items);
    const producer = (async () => {
      for (let ci = 1; ci < chunks.length; ci++) {
        const b = await bake(M, chunks[ci], { tick, signal: sig, put, hold });
        skipped += b.skipped;
        addGroup(b.items);
        if (b.cancelled) { bakeCancelled = true; break; }
      }
    })().catch(e => { console.warn('보낼 사진 굽기 실패', e); }).finally(() => { bakeDone = true; kick(); });
    // k 번째 묶음이 구워질 때까지(다 구웠는데 없으면 null)
    const groupAt = async k => { while (!groups[k] && !bakeDone) await new Promise(r => { wake = r; }); return groups[k] || null; };
    const nOf = () => Math.max(groups.length, bakeDone ? groups.length : chunks.length);   // 어림(웹은 크기 한도로 늘 수 있다)
    if (!groups.length) {
      await producer;
      if (!groups.length) { signal?.removeEventListener?.('abort', onAbort); return { ...none, copied, text, skipped, error: '보낼 사진을 만들지 못했어요', ...(bakeCancelled ? { cancelled: true } : {}) }; }
    }
    const extra = copied ? {} : { text };                                    // 복사가 안 됐을 때만 공유에 글을 싣는다(카톡은 여러 장이면 글을 흘린다)
    const title = k => (nOf() > 1 ? `사진 보내기 (${k + 1}/${nOf()})` : '사진 보내기');
    async function sendOne(k) {
      const part = groups[k];
      if (native) {
        const r = await N.shareFiles(part.map(it => it.uri), { title: title(k), ...extra });
        return r.ok ? { ok: true, where: 'share', target: r.target } : r;
      }
      const files = part.map(it => it.file);
      if (!noShare) {
        const r = await share.webShareFiles(files, extra);
        if (r.ok || r.cancelled || r.needTap) return r;
      }
      for (const [i, f] of files.entries()) {                                 // 공유 창이 없거나 못 받는 브라우저 — 내려받기
        if (i) await new Promise(ok => setTimeout(ok, 150));                  // 한꺼번에 누르면 크롬이 내려받기를 버린다
        share.downloadBlob(f, f.name);
      }
      return { ok: true, where: 'download' };
    }

    // ④ 보내기 — 첫 묶음은 바로(화면이 first 를 주면 그 판단대로), 나머지는 구워지는 대로 시트 탭마다
    const note = copied ? '글은 복사했어요 — 카톡에서 사진 보낸 뒤 붙여 넣으세요' : null;
    const totalOf = () => rows.length - skipped;
    let k = 0, sent = 0, where = null, cancelled = false, error = null;
    let r = first ? await first(() => sendOne(0), { n: nOf(), total: totalOf() }) : await sendOne(0);
    if (first && !r) cancelled = true;
    // 밖의 [그만](signal) — 공유 창이 떠 있는 사이에 눌렀어도 돌아와서 다음 단계를 묻지 않는다(0.1.6 고장 2: 굽기만 멈추고 「다음 사진 보내기」 시트가 또 떴다)
    const stopped = () => !!signal?.aborted;
    while (!cancelled) {
      if (r?.needTap) {
        if (stopped()) { cancelled = true; break; }
        r = await ask({ title: '사진을 보낼 준비가 됐어요', label: nOf() > 1 ? `공유하기 (${k + 1}/${nOf()})` : '공유하기', note, k, n: nOf() }, () => sendOne(k));
        if (!r) { cancelled = true; break; }
        continue;
      }
      if (!r?.ok) { if (r?.cancelled) cancelled = true; else error = r?.error || '공유하지 못했어요'; break; }
      sent += groups[k].length; where = r.where || where;
      k++;
      if (stopped()) { cancelled = true; break; }
      const next = await groupAt(k);
      if (!next) { if (bakeCancelled) cancelled = true; break; }
      if (stopped()) { cancelled = true; break; }
      r = await ask({ title: `사진 ${totalOf()}장을 ${nOf()}번에 나눠 보내요`, label: `다음 사진 보내기 (${k + 1}/${nOf()})`, note, k, n: nOf() }, () => sendOne(k));
      if (!r) { cancelled = true; break; }
    }
    if (cancelled || error) inner?.abort();                                    // 덜 구운 묶음은 그만 굽는다
    await producer;
    signal?.removeEventListener?.('abort', onAbort);
    const total = totalOf();
    return { ok: sent === total && sent > 0 && !error && !cancelled, sent, total, parts: nOf(), copied, cancelled, where, skipped, text, ...(error ? { error } : {}) };
  } finally { running = false; }
}

// 글만 다시 복사(보낸 뒤 「글 다시 복사」) → { ok, text }
export async function copyRecordsText(recordIds) {
  const M = await load();
  const g = gather(M.store, recordIds);
  if (!g.records.length) return { ok: false, text: '' };
  const siteName = M.store.settings().siteName || g.records.find(r => r.site)?.site || '';
  const text = composeText(g.records, { siteName, from: g.from, to: g.to, photoCount: r => g.photosBy.get(r.id)?.length || 0 });
  return { ok: await M.N.copyText(text), text };
}

// 사진만 저장 → { ok, saved, total, where, skipped, cancelled? }
// 앱: 문서/현장사진대지 lite/사진/<MMDD 또는 MMDD-MMDD>/ 에(구운 사진을 CACHE 에 쓴 뒤 옮김), 웹: 한 장씩 내려받기(150ms 간격)
export async function savePhotos(recordIds, { onProgress, signal, hold = null } = {}) {
  if (running) return { ok: false, saved: 0, total: 0, busy: true, error: '보내는 중이에요' };
  running = true;
  try {
    const M = await load();
    const { store, N, share } = M;
    const g = gather(store, recordIds);
    if (!g.rows.length) return { ok: false, saved: 0, total: 0, skipped: 0, error: '저장할 사진이 없어요' };
    const native = isNativeOf(N);
    const mmdd = d => d.slice(5).replace('-', '');
    const folder = `사진/${g.from === g.to ? mmdd(g.from) : `${mmdd(g.from)}-${mmdd(g.to)}`}`;
    const dir = `share/save-${Date.now()}-${++seq}`;
    let saved = 0, last = 0;
    const put = native
      ? async (name, bytes) => { const path = `${dir}/${name}`; await N.writeCache(path, bytes); await N.copyToDocuments({ path }, `${folder}/${name}`); saved++; return { name }; }
      : async (name, bytes) => {
        const wait = 150 - (Date.now() - last);
        if (last && wait > 0) await new Promise(ok => setTimeout(ok, wait));
        share.downloadBlob(new Blob([bytes], { type: 'image/jpeg' }), name); last = Date.now(); saved++; return { name };
      };
    let done = 0;
    tell(onProgress, 0, g.rows.length);
    const b = await bake(M, named(M, g.rows), { tick: () => { done++; tell(onProgress, done, g.rows.length); }, signal, put, hold });
    const where = native ? `문서/${N.DOC_ROOT}/${folder}` : 'download';
    return { ok: saved > 0 && !b.cancelled, saved, total: g.rows.length, where, skipped: b.skipped, ...(b.cancelled ? { cancelled: true } : {}) };
  } finally { running = false; }
}
