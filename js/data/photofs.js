// 사진·자료 파일 저장소(설계서 §4.5·§5.3·§10.4) — IndexedDB 밖 파일에 둔다(IndexedDB 만 죽는 사고에서 사진이 살아남게).
//   APK : 사진(work·thumb·incoming·original)은 OPFS <폴더>/<id>.jpg(웹뷰가 앱 데이터 폴더에 직접 쓴다 — 브리지 0), 안 되면 IDB.
//         자료(doc)와 예전 사진(photo.store === 'file')은 Capacitor Filesystem DATA/<폴더>/<id> (화면 표시는 convertFileSrc 주소)
//   웹  : OPFS <폴더>/<id>.jpg (createWritable 이 되는 브라우저)
//   폴백: IndexedDB blobs `<id>:<kind>` 에 ArrayBuffer(공시체 방식 — iOS Safari 의 IDB Blob 문제 회피)
// 종류(kind): work(작업본) · thumb(썸네일) · incoming(처리 전 원본) · original(갤러리에 넣기 전 원본, APK) · doc(자료함 파일, 확장자 없음)
// 사진 메타의 photo.store 가 그 사진이 어디 있는지 적는다 — 읽을 때 그 값을 주면 바로 거기서, 없으면 차례로 찾는다.
// 잠깐 머무는 원본(incoming·original)은 APK 에서도 브리지 없이 OPFS(안 되면 IDB)에 쓴다 — 수 MB 를 base64 로 바꿔
//   브리지로 여러 번 보내던 것이 셔터 뒤 사진이 늦게 뜨던 큰 원인이었다(2026-10-21 현장 "다 느림"). 어디 썼는지는 put 이 돌려주는 store 로 남는다.
// 작업본·썸네일도 APK 에서 OPFS 로(2026-10-22 폰 "찍은 직후 글이 늦게 쳐짐"): 장당 약 0.5MB 를 base64 로 바꿔 512KB 조각마다 브리지로 넘기고
//   stat 으로 확인하던 쓰기(메인 스레드 직렬화)가 찍은 직후 글 입력을 밀었다. OPFS 도 IndexedDB 밖 파일이라 「IDB 만 죽는 사고」 대비는 같다.
//   앱 데이터를 지우거나 재설치하면 DATA 처럼 같이 지워진다 — 그때는 갤러리 원본으로 다시 연결한다(§4.5). 예전에 DATA 에 넣은 사진은 store 'file' 로 그대로 읽는다.
// APK 의 base64 는 FileReader(비동기, 네이티브)로 만든다 — 메인 스레드의 btoa 를 쓰지 않는다.
import * as N from '../platform/native.js';
import { tx } from './db.js';

const DIRS = { work: 'photos', thumb: 'thumbs', incoming: 'incoming', original: 'originals', doc: 'docs' };
const LOCAL = new Set(['incoming', 'original', 'work', 'thumb']);            // APK 에서도 웹 저장소(OPFS/IDB)에 두는 종류(브리지 0)
const DATA = 'DATA';                                                         // Capacitor Directory.Data
// 브리지 한 번에 넘기는 조각(원본 files.js 의 512KB). 3 의 배수로 맞춰 base64 조각 중간에 '=' 패딩이 끼지 않게 한다
const CHUNK = 512 * 1024 - ((512 * 1024) % 3);

let kindP = null;                                                            // 'file' | 'opfs' | 'idb' 를 정한 약속
let current = null;
let localP = null;                                                           // APK 의 incoming·original 저장소 'opfs' | 'idb'
let baseP = Promise.resolve(false);                                          // APK: 파일 주소 뿌리(initFileBase)를 받았는지 — fileSrcSync 전에 기다린다
const dirHandles = new Map();
// APK 의 DATA/<incoming|originals> 는 v0.1.1 까지만 썼다 — 한 번 비었음을 보면 다시 readdir 하지 않는다(부팅 브리지, 속도 감사 #16)
const K_NOLEGACY = 'sajindaeji-lite.fs.nolegacy.v1';
const noLegacy = kind => { try { return !!JSON.parse(globalThis.localStorage?.getItem(K_NOLEGACY) || '{}')[kind]; } catch { return false; } };
const setNoLegacy = kind => { try { const o = JSON.parse(globalThis.localStorage?.getItem(K_NOLEGACY) || '{}'); o[kind] = 1; globalThis.localStorage?.setItem(K_NOLEGACY, JSON.stringify(o)); } catch { /* 저장 못 함 — 다음에 다시 본다 */ } };
const LEGACY_ONLY = new Set(['incoming', 'original']);                       // 지금 판은 DATA 에 쓰지 않는 종류(work·thumb 는 예전 사진이 DATA 에 있다)

const fileName = (kind, id) => (kind === 'doc' ? String(id) : `${id}.jpg`);
const idOf = (kind, name) => (kind === 'doc' ? name : name.replace(/\.jpg$/i, ''));
const blobKey = (kind, id) => `${id}:${kind}`;
const mimeOf = kind => (kind === 'doc' ? 'application/octet-stream' : 'image/jpeg');
function checkKind(kind) { if (!DIRS[kind]) throw new Error(`알 수 없는 파일 종류: ${kind}`); }
function checkId(id) { if (typeof id !== 'string' || !id || /[\\/:]|\.\./.test(id)) throw new Error(`쓸 수 없는 파일 id: ${id}`); }   // 경로 밖으로 나가지 않게

function quota(e) {
  if (e?.code === 'QUOTA') return e;
  if (e?.name === 'QuotaExceededError' || /quota|no space|ENOSPC|full/i.test(String(e?.message || ''))) {
    return Object.assign(new Error('저장 공간이 모자라요'), { code: 'QUOTA', cause: e });
  }
  return e;
}

// ---- 어디에 둘지 정하기 ----
async function opfsWorks() {
  try {
    if (!navigator.storage?.getDirectory) return false;
    const root = await navigator.storage.getDirectory();
    const fh = await root.getFileHandle('.probe', { create: true });
    if (typeof fh.createWritable !== 'function') return false;               // 구형 사파리 — 메인 스레드에서 못 쓴다 → IDB
    const w = await fh.createWritable();
    await w.write(new Uint8Array([1]));
    await w.close();
    await root.removeEntry('.probe').catch(() => {});
    return true;
  } catch { return false; }
}

// force: 시험용('idb' | 'opfs' | 'file')
export async function initPhotoFs({ force } = {}) {
  if (force) { current = force; kindP = Promise.resolve(force); localP = null; return { kind: force }; }
  if (!kindP) {
    kindP = (async () => {
      if (N.isNative?.()) {
        baseP = Promise.resolve(N.initFileBase?.()).then(() => true, e => { console.warn('파일 주소 뿌리를 못 받았어요', e); return false; });   // 썸네일 주소를 브리지 왕복 없이(fileSrcSync)
        return 'file';
      }
      return (await opfsWorks()) ? 'opfs' : 'idb';
    })().then(k => { current = k; return k; }, e => { kindP = null; throw e; });
  }
  return { kind: await kindP };
}
// APK 의 사진(LOCAL)은 OPFS(안드로이드 웹뷰), 안 되면 IDB. 웹은 본 저장소 그대로
async function localBackend() {
  const k = await backend();
  if (k !== 'file') return k;
  if (!localP) localP = opfsWorks().then(ok => (ok ? 'opfs' : 'idb'), () => 'idb');
  return localP;
}
const backend = async () => current || (await initPhotoFs()).kind;
export const fsKind = () => current;

// ---- 바이트 다루기 ----
const isBlob = v => typeof Blob !== 'undefined' && v instanceof Blob;
function toU8(v) {
  if (v instanceof Uint8Array) return v;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  if (ArrayBuffer.isView(v)) return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
  throw new Error('사진 바이트 형식이 맞지 않아요');
}
const sizeOf = v => (isBlob(v) ? v.size : toU8(v).byteLength);
async function slice(v, from, to) { return isBlob(v) ? new Uint8Array(await v.slice(from, to).arrayBuffer()) : toU8(v).subarray(from, to); }
// 조각 → base64 (FileReader, 비동기)
const b64Of = (v, from, to) => N.toB64(isBlob(v) ? v.slice(from, to) : toU8(v).subarray(from, to));

// ---- APK(Filesystem) ----
const nPath = (kind, id) => `${DIRS[kind]}/${fileName(kind, id)}`;
async function filePut(kind, id, data) {
  const path = nPath(kind, id), size = sizeOf(data);
  try {
    await N.fsWrite(DATA, path, await b64Of(data, 0, Math.min(size, CHUNK)));
    for (let at = CHUNK; at < size; at += CHUNK) await N.fsAppend(DATA, path, await b64Of(data, at, Math.min(size, at + CHUNK)));
    const st = await N.fsStat(DATA, path);
    if (!st || (Number.isFinite(st.size) && st.size !== size)) throw new Error(`끝까지 쓰지 못했어요(${st ? st.size : '없음'}/${size})`);
  } catch (e) {
    await N.fsDelete(DATA, path).catch(() => {});                            // 쓰다 만 파일을 남기지 않는다
    throw quota(e);
  }
}
// 파일 주소(convertFileSrc) — 뿌리를 받아 두었으면 브리지 0, 아니면 getUri 한 번
async function fileUrl(kind, id) {
  await baseP;
  try { return N.fileSrcSync(DATA, nPath(kind, id)); } catch { return N.fileSrc(DATA, nPath(kind, id)); }
}
// stat·getUri 없이 주소로 바로 읽는다 — 없으면 404(없음으로). 속도 감사 #4·#14
async function fileGet(kind, id) {
  try {
    const r = await fetch(await fileUrl(kind, id));
    if (!r.ok) return null;
    const b = await r.blob();
    return b.type ? b : new Blob([b], { type: mimeOf(kind) });
  } catch { return null; }
}

// ---- 웹 OPFS ----
async function opfsDir(kind) {
  if (dirHandles.has(kind)) return dirHandles.get(kind);
  const root = await navigator.storage.getDirectory();
  const d = await root.getDirectoryHandle(DIRS[kind], { create: true });
  dirHandles.set(kind, d);
  return d;
}
async function opfsPut(kind, id, data) {
  const dir = await opfsDir(kind), name = fileName(kind, id), size = sizeOf(data);
  let w = null;
  try {
    const fh = await dir.getFileHandle(name, { create: true });
    w = await fh.createWritable();                                           // 임시 사본에 쓰고 close 때 한 번에 바꾼다(중간에 죽어도 반쪽 파일이 안 남음)
    for (let at = 0; at < size || at === 0; at += CHUNK) { await w.write(await slice(data, at, Math.min(size, at + CHUNK))); if (!size) break; }
    await w.close(); w = null;
    const f = await fh.getFile();
    if (f.size !== size) throw new Error(`끝까지 쓰지 못했어요(${f.size}/${size})`);
  } catch (e) {
    try { await w?.abort(); } catch { /* 이미 닫힘 */ }
    await dir.removeEntry(name).catch(() => {});
    throw quota(e);
  }
}
async function opfsGet(kind, id) {
  try {
    if (!navigator.storage?.getDirectory) return null;
    const f = await (await (await opfsDir(kind)).getFileHandle(fileName(kind, id))).getFile();
    return f.type === mimeOf(kind) ? f : new Blob([f], { type: mimeOf(kind) });
  } catch { return null; }
}

// ---- IDB 폴백(ArrayBuffer) ----
async function idbPut(kind, id, data) {
  const buf = isBlob(data) ? await data.arrayBuffer() : toU8(data).slice().buffer;   // 받은 배열이 나중에 바뀌어도 저장본은 그대로
  await tx(['blobs'], 'readwrite', t => { t.objectStore('blobs').put({ key: blobKey(kind, id), buf, size: buf.byteLength }); });
}
async function idbGet(kind, id) {
  try {
    const row = await tx(['blobs'], 'readonly', t => t.objectStore('blobs').get(blobKey(kind, id)));
    if (!row?.buf) return null;
    return new Blob([row.buf], { type: mimeOf(kind) });
  } catch { return null; }
}

const READERS = { file: fileGet, opfs: opfsGet, idb: idbGet };
const order = async (store, kind) => {
  const k = await backend();
  // APK 의 사진은 새것이 OPFS — 저장소를 모를 때 브리지(stat)부터 묻지 않게 OPFS·IDB 먼저
  const all = k === 'file' ? (LOCAL.has(kind) ? ['opfs', 'idb', 'file'] : ['file', 'opfs', 'idb']) : k === 'opfs' ? ['opfs', 'idb'] : ['idb', 'opfs'];
  return store && READERS[store] ? [store, ...all.filter(x => x !== store)] : all;
};

// ---- 계약 ----
// → { store } — 실제로 넣은 곳. OPFS 가 그 순간 실패하면(용량 말고) IDB 로 넘긴다
export async function put(kind, id, bytes) {
  checkKind(kind); checkId(id);
  const k = LOCAL.has(kind) ? await localBackend() : await backend();
  if (k === 'file') { await filePut(kind, id, bytes); return { store: 'file' }; }
  if (k === 'opfs') {
    try { await opfsPut(kind, id, bytes); return { store: 'opfs' }; }
    catch (e) { if (e?.code === 'QUOTA') throw e; console.warn('OPFS 쓰기 실패 — IDB 에 넣어요', e); }
  }
  try { await idbPut(kind, id, bytes); } catch (e) { throw quota(e); }
  return { store: 'idb' };
}

// store 를 주면 거기서 먼저, 없으면 다른 곳도 찾아본다(옛 기록·폴백으로 들어간 파일)
export async function get(kind, id, store) {
  checkKind(kind);
  for (const s of await order(store, kind)) {
    const b = await READERS[s](kind, id);
    if (b) return b;
  }
  return null;
}

// 있으면 그 저장소 이름, 없으면 null(복원 때 사진 본체가 살아 있는지 확인)
export async function has(kind, id, store) {
  checkKind(kind);
  for (const s of await order(store, kind)) {
    if (s === 'file') { if (await N.fsStat(DATA, nPath(kind, id)).catch(() => null)) return s; continue; }
    if (s === 'opfs') {
      try { await (await opfsDir(kind)).getFileHandle(fileName(kind, id)); return s; } catch { continue; }
    }
    if (await tx(['blobs'], 'readonly', t => t.objectStore('blobs').count(blobKey(kind, id))).catch(() => 0)) return s;
  }
  return null;
}

// 화면용 주소. APK 파일(store 'file' — 예전 사진·자료)은 convertFileSrc 주소를 stat 없이 바로(없는 파일은 <img> onerror 가 「!」로 — 속도 감사 #4),
// 웹·OPFS·IDB 는 새 objectURL(캐시·해제는 store.js 가 한다)
export async function url(kind, id, store) {
  checkKind(kind);
  const k = store || (LOCAL.has(kind) && (await backend()) === 'file' ? null : await backend());
  if (k === 'file') return fileUrl(kind, id);
  const b = await get(kind, id, store);
  return b ? URL.createObjectURL(b) : null;
}

// 모든 저장소에서 지운다(폴백으로 들어간 사본까지). 없으면 조용히
export async function remove(kind, id, store) {
  checkKind(kind); checkId(id);
  const k = await backend();
  const jobs = [tx(['blobs'], 'readwrite', t => { t.objectStore('blobs').delete(blobKey(kind, id)); }).catch(() => {})];
  // APK 사진(LOCAL)은 저장소를 알면(opfs·idb) 브리지 삭제를 부르지 않는다 — 예전 사진(store 'file')이나 모를 때만
  if (store === 'file' || (k === 'file' && !(LOCAL.has(kind) && store && store !== 'file'))) jobs.push(N.fsDelete(DATA, nPath(kind, id)).catch(() => {}));
  const opfsToo = k === 'opfs' || store === 'opfs' || (k === 'file' && LOCAL.has(kind) && !!globalThis.navigator?.storage?.getDirectory);
  if (opfsToo) jobs.push(opfsDir(kind).then(d => d.removeEntry(fileName(kind, id))).catch(() => {}));
  await Promise.all(jobs);
}

async function entries(kind, sizes = true) {
  const k = await backend(), out = new Map();                                // id → size
  if (k === 'file' && !(LEGACY_ONLY.has(kind) && noLegacy(kind))) {
    const files = await N.fsList(DATA, DIRS[kind]).catch(() => []);
    for (const f of files) out.set(idOf(kind, f.name), Number(f.size) || 0);
    if (!files.length && LEGACY_ONLY.has(kind)) setNoLegacy(kind);
  }
  if ((k !== 'file' || LOCAL.has(kind)) && globalThis.navigator?.storage?.getDirectory) {   // IDB 모드여도 예전에 OPFS 에 넣은 것까지(APK 는 incoming·original)
    try {
      for await (const [name, h] of (await opfsDir(kind)).entries()) {
        if (h.kind !== 'file' || name.endsWith('.crswap')) continue;         // 쓰는 중인 임시 사본은 빼고
        out.set(idOf(kind, name), sizes ? (await h.getFile().catch(() => null))?.size || 0 : 0);
      }
    } catch { /* 폴더 없음 */ }
  }
  const suffix = `:${kind}`;
  if (!sizes) {                                                              // 목록만 — 바이트를 메모리에 올리지 않는다
    const keys = await tx(['blobs'], 'readonly', t => t.objectStore('blobs').getAllKeys()).catch(() => []);
    for (const key of keys) if (key.endsWith(suffix)) out.set(key.slice(0, -suffix.length), 0);
    return out;
  }
  const rows = await tx(['blobs'], 'readonly', t => t.objectStore('blobs').getAll()).catch(() => []);
  for (const r of rows) if (r.key.endsWith(suffix)) out.set(r.key.slice(0, -suffix.length), r.size || r.buf?.byteLength || 0);
  return out;
}

// id 목록(부팅 복구·고아 확인) — 모든 저장소를 합친다
export async function list(kind) { checkKind(kind); return [...(await entries(kind, false)).keys()]; }

export async function usage() {
  let bytes = 0, count = 0;
  for (const kind of Object.keys(DIRS)) for (const size of (await entries(kind)).values()) { bytes += size; count++; }
  return { bytes, count };
}
