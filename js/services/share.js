// 묶음·사진 공유(SPEC §5.6). 글(위치·내용·날짜)을 먼저 클립보드에 복사하고, 사진(render.exportJpeg — 워터마크 설정 반영)을 공유 시트로.
// 한도: 앱 20장씩(MAX_SHARE_PHOTOS), 웹 10장·50MiB 씩(크롬 Web Share 한도 — 설계 비평 기술 #4). 넘으면 나눠 보낸다(원본 sendflow planParts 방식).
// 웹은 사진을 굽는 사이 사용자 활성화(약 5초)가 끝나 navigator.share 가 NotAllowedError 로 실패할 수 있다 →
// 결과에 needTap:true 와 prepared 를 돌려주고, 화면이 [공유하기] 버튼을 띄워 그 탭에서 prepared.send(i) 를 부른다.
import * as store from '../data/store.js';
import * as render from '../media/render.js';
import * as N from '../platform/native.js';
import { MAX_SHARE_PHOTOS } from '../config.js';
import { dayLabel } from '../core/date.js';
import { photoFileNames } from '../core/ledger.js';

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
  const lines = [`${site ? `[${site}] ` : ''}${dayLabel(record.day)}`, `■ ${String(record.location || '').trim() || '위치 미입력'}`];
  const content = String(record.content || '').trim();
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

let shareSeq = 0;
// 사진을 구워 공유할 준비 → { text, total, batches: number, send(i) → Promise<{ ok, cancelled?, needTap?, where?, error? }> }
async function prepare(record, photos) {
  const text = shareText(record, photos.length);
  const names = photoFileNames(photos.map(p => ({ record, photo: p })));
  const items = [];
  for (const [i, p] of photos.entries()) {
    try { const bytes = await render.exportJpeg(p.id); items.push({ name: names[i], bytes, size: bytes.length }); }
    catch (e) { console.warn('공유할 사진을 만들지 못했어요', p.id, e); }
  }
  if (N.isNative()) {
    const groups = batch(items, MAX_SHARE_PHOTOS);
    const dir = `share/${Date.now()}-${++shareSeq}`;
    const uris = [];
    return {
      text, total: items.length, batches: groups.length,
      async send(k = 0) {
        const g = groups[k];
        if (!g) return { ok: false, error: '보낼 사진이 없어요' };
        if (!uris[k]) uris[k] = await Promise.all(g.map(it => N.writeCache(`${dir}/${it.name}`, it.bytes)));
        const r = await N.shareFiles(uris[k], { title: groups.length > 1 ? `사진 보내기 (${k + 1}/${groups.length})` : '사진 보내기', text });
        return r.ok ? { ok: true, where: 'share' } : r;
      },
    };
  }
  const groups = batch(items, WEB_MAX_FILES, WEB_MAX_BYTES).map(g => g.map(it => new File([it.bytes], it.name, { type: 'image/jpeg' })));
  return {
    text, total: items.length, batches: groups.length,
    async send(k = 0) {
      const g = groups[k];
      if (!g) return { ok: false, error: '보낼 사진이 없어요' };
      const r = await webShareFiles(g, { text });
      if (r.ok || r.cancelled || r.needTap) return r;
      for (const f of g) downloadBlob(f, f.name);                           // 공유를 못 하는 브라우저 — 사진을 내려받는다
      return { ok: true, where: 'download' };
    },
  };
}

// 첫 묶음(batch 0)을 바로 보낸다. 나머지가 있으면 more 와 prepared 로 화면이 [다음 사진 보내기 (2/3)] 를 띄운다
async function run(record, photos) {
  if (!record) return { ok: false, error: '묶음을 찾지 못했어요' };
  const prepared = await prepare(record, photos);
  const copied = await N.copyText(prepared.text);
  if (!prepared.total) return { ok: copied, copied, textOnly: true, prepared };
  const r = await prepared.send(0);
  return { ...r, copied, prepared, more: Math.max(0, prepared.batches - 1) };
}

export async function shareRecord(recordId) {
  const record = store.record(recordId);
  return run(record, record ? store.photosOf(recordId).filter(p => p.state === 'ready') : []);
}

export async function sharePhoto(photoId) {
  const p = store.photo(photoId);
  const record = p ? store.record(p.recordId) : null;
  return run(record, p && p.state === 'ready' ? [p] : []);
}
