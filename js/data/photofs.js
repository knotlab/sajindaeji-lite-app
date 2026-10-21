// 사진·자료 파일 저장소(설계서 §4.5·§5.3·§10.4) — IndexedDB 밖 파일에 둔다(IndexedDB 만 죽는 사고에서 사진이 살아남게).
//   APK : Capacitor Filesystem DATA/<폴더>/<id>.jpg (화면 표시는 convertFileSrc 주소)
//   웹  : OPFS <폴더>/<id>.jpg (createWritable 이 되는 브라우저)
//   폴백: IndexedDB blobs `<id>:<kind>` 에 ArrayBuffer(공시체 방식 — iOS Safari 의 IDB Blob 문제 회피)
// 종류(kind): work(작업본) · thumb(썸네일) · incoming(처리 전 원본) · doc(자료함 파일, 확장자 없음)
// 사진 메타의 photo.store 가 그 사진이 어디 있는지 적는다 — 읽을 때 그 값을 주면 바로 거기서, 없으면 차례로 찾는다.
import * as N from '../platform/native.js';
import { tx } from './db.js';

const DIRS = { work: 'photos', thumb: 'thumbs', incoming: 'incoming', doc: 'docs' };
const DATA = 'DATA';                                                         // Capacitor Directory.Data
// 브리지 한 번에 넘기는 조각(원본 files.js 의 512KB). 3 의 배수로 맞춰 base64 조각 중간에 '=' 패딩이 끼지 않게 한다
const CHUNK = 512 * 1024 - ((512 * 1024) % 3);

let kindP = null;                                                            // 'file' | 'opfs' | 'idb' 를 정한 약속
let current = null;
const dirHandles = new Map();

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
  if (force) { current = force; kindP = Promise.resolve(force); return { kind: force }; }
  if (!kindP) {
    kindP = (async () => {
      if (N.isNative?.()) return 'file';
      return (await opfsWorks()) ? 'opfs' : 'idb';
    })().then(k => { current = k; return k; }, e => { kindP = null; throw e; });
  }
  return { kind: await kindP };
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
function b64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---- APK(Filesystem) ----
const nPath = (kind, id) => `${DIRS[kind]}/${fileName(kind, id)}`;
async function filePut(kind, id, data) {
  const path = nPath(kind, id), size = sizeOf(data);
  try {
    await N.fsWrite(DATA, path, b64(await slice(data, 0, Math.min(size, CHUNK))));
    for (let at = CHUNK; at < size; at += CHUNK) await N.fsAppend(DATA, path, b64(await slice(data, at, Math.min(size, at + CHUNK))));
    const st = await N.fsStat(DATA, path);
    if (!st || (Number.isFinite(st.size) && st.size !== size)) throw new Error(`끝까지 쓰지 못했어요(${st ? st.size : '없음'}/${size})`);
  } catch (e) {
    await N.fsDelete(DATA, path).catch(() => {});                            // 쓰다 만 파일을 남기지 않는다
    throw quota(e);
  }
}
async function fileGet(kind, id) {
  try {
    if (!(await N.fsStat(DATA, nPath(kind, id)))) return null;
    const r = await fetch(await N.fileSrc(DATA, nPath(kind, id)));
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
const order = async store => {
  const k = await backend();
  const all = k === 'file' ? ['file', 'idb'] : k === 'opfs' ? ['opfs', 'idb'] : ['idb', 'opfs'];
  return store && READERS[store] ? [store, ...all.filter(x => x !== store)] : all;
};

// ---- 계약 ----
// → { store } — 실제로 넣은 곳. OPFS 가 그 순간 실패하면(용량 말고) IDB 로 넘긴다
export async function put(kind, id, bytes) {
  checkKind(kind); checkId(id);
  const k = await backend();
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
  for (const s of await order(store)) {
    const b = await READERS[s](kind, id);
    if (b) return b;
  }
  return null;
}

// 있으면 그 저장소 이름, 없으면 null(복원 때 사진 본체가 살아 있는지 확인)
export async function has(kind, id, store) {
  checkKind(kind);
  for (const s of await order(store)) {
    if (s === 'file') { if (await N.fsStat(DATA, nPath(kind, id)).catch(() => null)) return s; continue; }
    if (s === 'opfs') {
      try { await (await opfsDir(kind)).getFileHandle(fileName(kind, id)); return s; } catch { continue; }
    }
    if (await tx(['blobs'], 'readonly', t => t.objectStore('blobs').count(blobKey(kind, id))).catch(() => 0)) return s;
  }
  return null;
}

// 화면용 주소. APK 는 convertFileSrc(빠름), 웹은 새 objectURL(캐시·해제는 store.js 가 한다)
export async function url(kind, id, store) {
  checkKind(kind);
  if ((store || (await backend())) === 'file' && (await N.fsStat(DATA, nPath(kind, id)).catch(() => null))) return N.fileSrc(DATA, nPath(kind, id));
  const b = await get(kind, id, store);
  return b ? URL.createObjectURL(b) : null;
}

// 모든 저장소에서 지운다(폴백으로 들어간 사본까지). 없으면 조용히
export async function remove(kind, id, store) {
  checkKind(kind); checkId(id);
  const k = await backend();
  const jobs = [tx(['blobs'], 'readwrite', t => { t.objectStore('blobs').delete(blobKey(kind, id)); }).catch(() => {})];
  if (k === 'file' || store === 'file') jobs.push(N.fsDelete(DATA, nPath(kind, id)).catch(() => {}));
  if (k === 'opfs' || store === 'opfs') jobs.push(opfsDir(kind).then(d => d.removeEntry(fileName(kind, id))).catch(() => {}));
  await Promise.all(jobs);
}

async function entries(kind, sizes = true) {
  const k = await backend(), out = new Map();                                // id → size
  if (k === 'file') for (const f of await N.fsList(DATA, DIRS[kind]).catch(() => [])) out.set(idOf(kind, f.name), Number(f.size) || 0);
  if (k !== 'file' && globalThis.navigator?.storage?.getDirectory) {       // IDB 모드여도 예전에 OPFS 에 넣은 것까지
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
