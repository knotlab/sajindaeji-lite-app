// 묶음·사진 공유(SPEC §5.6). 글(위치·내용·날짜)을 먼저 클립보드에 복사하고, 사진(render.exportJpeg — 워터마크 설정 반영)을 공유 시트로.
// 한도: 앱 20장씩(MAX_SHARE_PHOTOS), 웹 10장·50MiB 씩(크롬 Web Share 한도 — 설계 비평 기술 #4). 넘으면 나눠 보낸다(원본 sendflow planParts 방식).
// 웹은 사진을 굽는 사이 사용자 활성화(약 5초)가 끝나 navigator.share 가 NotAllowedError 로 실패할 수 있다 →
// 결과에 needTap:true 와 prepared 를 돌려주고, 화면이 [공유하기] 버튼을 띄워 그 탭에서 prepared.send(i) 를 부른다.
// 앱 0.1.7: 묶음 상세 [공유](shareRecord)로 넘긴 사진도 「보냄」으로 적는다(data/sendlog.js — 내보내기 탭 「한번에 보내기」의 카톡은 안 보낸 것만).
//   조용히 적지 않는다 — 결과(prepared.marked())로 화면(widgets/sharefollow.js)이 「보낸 묶음으로 표시했어요 [되돌리기]」를 띄운다(감독관 1:1 방처럼 다른 곳에 보냈으면 되돌린다).
//   공유 창이 없어 내려받기만 했으면 적지 않는다(검토).
// 글은 services/sendflow.js recordText(카톡 글과 같은 곳)로 — 묶음 글을 만드는 곳을 늘리지 않는다(프리셋 설계 §5.1②).
import * as store from '../data/store.js';
import * as render from '../media/render.js';
import * as N from '../platform/native.js';
import { MAX_SHARE_PHOTOS } from '../config.js';
import { dayLabel } from '../core/date.js';
import { photoFileNames } from '../core/ledger.js';
import { recordText } from './sendflow.js';

const WEB_MAX_FILES = 10, WEB_MAX_BYTES = 50 * 1024 * 1024;

// ---- 웹 도우미(exporter·backupio 도 씀) ----
export function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.rel = 'noopener'; a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);                          // 내려받기가 시작될 시간을 준다
}

// navigator.share(files) — 못 하면 { ok:false, unsupported:true }, 활성화가 끝났으면 { ok:false, needTap:true }
export async function webShareFiles(files, { title, text } = {}) {
  const data = { files, ...(title ? { title } : {}), ...(text ? { text } : {}) };
  if (typeof navigator === 'undefined' || !navigator.share || !navigator.canShare?.({ files })) return { ok: false, unsupported: true };
  if (files.reduce((n, f) => n + f.size, 0) > WEB_MAX_BYTES || files.length > WEB_MAX_FILES) return { ok: false, unsupported: true };
  try { await navigator.share(data); return { ok: true, where: 'share' }; }
  catch (e) {
    if (e?.name === 'AbortError') return { ok: false, cancelled: true };
    if (e?.name === 'NotAllowedError') return { ok: false, needTap: true };
    return { ok: false, error: e?.message || String(e) };
  }
}

// ---- 글 ----
export function shareText(record, count) {
  const site = record.site || store.settings().siteName || '';
  const { loc, content } = recordText(record, { full: true });
  const lines = [`${site ? `[${site}] ` : ''}${dayLabel(record.day)}`, `■ ${loc}`];
  if (content) lines.push(content);
  lines.push(`— 사진 ${count}장`);
  return lines.join('\n');
}

// 묶음을 web/앱 한도에 맞게 나눈다 — 크기 한도는 웹만
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

// 묶음 상세에서 넘긴 사진 → 보냄 기록(카톡) → 되돌리기 표(실패하면 null — 공유는 끝난 것)
function markSent(record, ids) {
  return Promise.all([import('../data/sendlog.js'), import('../core/sendplan.js')])
    .then(([L, sp]) => L.mark({ kind: 'kakao', entries: [{ recordId: record.id, ids, textSig: sp.textSig(store.record(record.id) || record) }] }))
    .catch(e => { console.warn('보냄 표시를 남기지 못했어요', e); return null; });
}
// 되돌리기(스낵바) — markSent 표들을 거둔다
export async function unmarkSent(tokens) {
  const list = (tokens || []).filter(Boolean);
  if (!list.length) return;
  const L = await import('../data/sendlog.js');
  await L.undo(list);
}

let shareSeq = 0;
// 사진을 구워 공유할 준비 → { text, total, batches: number, send(i) → Promise<{ ok, cancelled?, needTap?, where?, error? }>, marked() → Promise<표[]> }
// mark: 넘긴 묶음(그 사진들)을 보냄 기록에 적는다(shareRecord — 내려받기만 한 것은 빼고). marked() 는 지금까지 적은 표(되돌리기용)
async function prepare(record, photos, { mark = false } = {}) {
  const text = shareText(record, photos.length);
  const names = photoFileNames(photos.map(p => ({ record, photo: p })));
  const items = [];
  for (const [i, p] of photos.entries()) {
    try { const bytes = await render.exportJpeg(p.id, { keep: false }); items.push({ name: names[i], bytes, size: bytes.length, photoId: p.id }); }   // 한 번 쓰고 끝 — 구운 그림 캐시에 남기지 않는다
    catch (e) { console.warn('공유할 사진을 만들지 못했어요', p.id, e); }
  }
  const marks = [];
  const marked = () => Promise.all(marks).then(ts => ts.filter(Boolean));
  const sentOf = (groupsOfItems, k, r) => { if (mark && r?.ok && r.where !== 'download') marks.push(markSent(record, groupsOfItems[k].map(it => it.photoId))); return r; };
  if (N.isNative()) {
    const groups = batch(items, MAX_SHARE_PHOTOS);
    const dir = `share/${Date.now()}-${++shareSeq}`;
    const uris = [];
    return {
      text, total: items.length, batches: groups.length, marks, marked,
      async send(k = 0) {
        const g = groups[k];
        if (!g) return { ok: false, error: '보낼 사진이 없어요' };
        if (!uris[k]) uris[k] = await Promise.all(g.map(it => N.writeCache(`${dir}/${it.name}`, it.bytes)));
        const r = await N.shareFiles(uris[k], { title: groups.length > 1 ? `사진 보내기 (${k + 1}/${groups.length})` : '사진 보내기', text });
        return sentOf(groups, k, r.ok ? { ok: true, where: 'share' } : r);
      },
    };
  }
  // 공유 창이 아예 없는 브라우저(데스크톱 등)는 한도가 없는 내려받기라 한 번에 모두 — 나눠 보내면 브라우저가 두 번째 내려받기부터 막는다
  const noShare = typeof navigator === 'undefined' || !navigator.share || !navigator.canShare;
  const itemGroups = noShare ? [items] : batch(items, WEB_MAX_FILES, WEB_MAX_BYTES);
  const groups = itemGroups.map(g => g.map(it => new File([it.bytes], it.name, { type: 'image/jpeg' })));
  return {
    text, total: items.length, batches: groups.length, marks, marked,
    async send(k = 0) {
      const g = groups[k];
      if (!g) return { ok: false, error: '보낼 사진이 없어요' };
      const r = await webShareFiles(g, { text });
      if (r.ok || r.cancelled || r.needTap) return sentOf(itemGroups, k, r);
      for (const [i, f] of g.entries()) {                                     // 공유를 못 하는 브라우저 — 사진을 내려받는다
        if (i) await new Promise(ok => setTimeout(ok, 150));                  // 한꺼번에 누르면 크롬이 10개 넘는 내려받기를 버린다
        downloadBlob(f, f.name);
      }
      return sentOf(itemGroups, k, { ok: true, where: 'download' });
    },
  };
}

// 첫 묶음(batch 0)을 바로 보낸다. 나머지가 있으면 more 와 prepared 로 화면이 [다음 사진 보내기 (2/3)] 를 띄운다
async function run(record, photos, opts = {}) {
  if (!record) return { ok: false, error: '묶음을 찾지 못했어요' };
  const prepared = await prepare(record, photos, opts);
  const copied = await N.copyText(prepared.text);
  if (!prepared.total) { if (copied && opts.mark && String(record.content || '').trim()) prepared.marks.push(markSent(record, [])); return { ok: copied, copied, textOnly: true, prepared }; }
  const r = await prepared.send(0);
  return { ...r, copied, prepared, more: Math.max(0, prepared.batches - 1) };
}

export async function shareRecord(recordId) {
  const record = store.record(recordId);
  return run(record, record ? store.photosOf(recordId).filter(p => p.state === 'ready') : [], { mark: true });
}

export async function sharePhoto(photoId) {
  const p = store.photo(photoId);
  const record = p ? store.record(p.recordId) : null;
  return run(record, p && p.state === 'ready' ? [p] : []);
}
