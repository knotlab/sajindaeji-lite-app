// 네이티브 계층 — Capacitor 플러그인 호출은 전부 여기를 거친다(번들러 없이 window.Capacitor.Plugins.<이름>).
// 원본 현장사진대지 native.js(파일·공유·수명주기)를 옮기고, 공시체 native.js 의 SD 선호·백업 쓰기, SPEC §5.5 를 더했다.
// 웹(PWA)에서는 모두 안전하게: 조회는 빈 값, 쓰기는 { ok:false } 또는 code:'NO_PLUGIN' 오류(호출자가 isNative() 로 가른다).
const C = () => globalThis.Capacitor;
export const isNative = () => !!C()?.isNativePlatform?.();
export const DIR = Object.freeze({ DATA: 'DATA', CACHE: 'CACHE', DOCUMENTS: 'DOCUMENTS', EXTERNAL: 'EXTERNAL' });
export const DOC_ROOT = '현장사진대지 lite';                                  // 문서 폴더 안 우리 폴더(앱을 지워도 남는다)
const CHUNK = 512 * 1024;                                                    // 브리지 한 번에 넘기는 base64 조각의 원본 크기(원본 값 — 크면 웹뷰 메모리가 튄다)

export function plugin(name) {
  if (!isNative()) return null;
  return C()?.Plugins?.[name] ?? null;
}
const need = name => {
  const p = plugin(name);
  if (!p) throw Object.assign(new Error(`${name} 기능은 앱에서만 돼요`), { code: 'NO_PLUGIN' });
  return p;
};
async function call(fn) {
  try { return await fn(); }
  catch (e) {
    if (e?.code === 'NO_PLUGIN') throw e;
    throw Object.assign(new Error(e?.message || String(e)), { code: e?.code || e?.message || 'ERROR', cause: e });
  }
}

// ---- base64 (image.js 와 같은 방식, 순환 의존을 피하려고 여기 따로 둔다) ----
export function bytesToB64(u8) {
  let s = '';
  for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode.apply(null, u8.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64ToBytes(b64) {
  const s = atob(String(b64 || '').replace(/^data:[^,]*,/, ''));
  const u8 = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u8[i] = s.charCodeAt(i);
  return u8;
}
const toBytes = async d => (d instanceof Uint8Array ? d : d instanceof ArrayBuffer ? new Uint8Array(d) : new Uint8Array(await d.arrayBuffer()));
// Blob·bytes → base64(머리 없이). FileReader.readAsDataURL 은 브라우저 안(네이티브)에서 비동기로 만든다 —
// String.fromCharCode+btoa 는 수 MB 면 메인 스레드를 수백 ms 막는다(2026-10-21 현장 "다 느림"). FileReader 가 없으면 예전 방식
export async function toB64(data) {
  if (typeof FileReader !== 'function' || typeof Blob !== 'function') return bytesToB64(await toBytes(data));
  const blob = data instanceof Blob ? data : new Blob([data instanceof ArrayBuffer ? new Uint8Array(data) : data]);
  if (!blob.size) return '';
  const url = await new Promise((res, rej) => {
    const fr = new FileReader();
    fr.onload = () => res(String(fr.result || ''));
    fr.onerror = () => rej(fr.error || new Error('base64 변환 실패'));
    fr.readAsDataURL(blob);
  });
  const i = url.indexOf(',');
  const b = i >= 0 ? url.slice(i + 1) : '';
  if (!b) throw new Error('base64 변환 실패(빈 결과)');
  return b;
}

// ---- 한가할 때(브리지로 큰 것을 보내기 전) ----
// Capacitor 브리지는 넘길 것을 메인 스레드에서 JSON 으로 만들어 통째로 복사한다 — 수 MB(갤러리 원본 base64)면 그동안 글자·셔터가 밀린다
// (2026-10-22 폰 "찍은 직후 글이 늦게 쳐짐"). 갤러리 원본·미러·자동 백업처럼 급하지 않은 쓰기는 whenQuiet() 뒤로 미룬다.
//   바쁨 = 최근 quietMs 안에 셔터(markBusy)·글 입력·누름이 있었거나, 글 칸에 포커스가 있음(키보드가 떠 있음) 또는 setTypingProbe 가 참.
//   maxMs 를 넘기면 포커스는 보지 않고 「1초 동안 입력 없음」만 기다린다(시트를 켜 둔 채 오래 있어도 언젠가는 쓴다).
let lastBusy = 0, tracking = false, typingProbe = null;
export function markBusy(t = Date.now()) { if (t > lastBusy) lastBusy = t; }
// dom.isTyping 같은 판정을 넘긴다(없으면 포커스만 본다)
export function setTypingProbe(fn) { typingProbe = typeof fn === 'function' ? fn : null; }
function trackInput() {
  if (tracking || typeof document === 'undefined') return;
  tracking = true;
  const f = () => markBusy();
  for (const t of ['input', 'keydown', 'compositionupdate', 'pointerdown', 'touchstart']) document.addEventListener(t, f, { capture: true, passive: true });
}
function focusTyping() {
  const a = typeof document !== 'undefined' ? document.activeElement : null;
  if (!a) return false;
  if (a.isContentEditable || a.tagName === 'TEXTAREA') return true;
  return a.tagName === 'INPUT' && /^(text|search|email|tel|url|number|password|)$/i.test(a.type || '');
}
export function isQuiet(quietMs = 2000, { strict = true } = {}) {
  trackInput();
  if (Date.now() - lastBusy < quietMs) return false;
  if (!strict) return true;
  let t = false;
  try { t = typingProbe ? !!typingProbe() : false; } catch { t = false; }
  return !t && !focusTyping();
}
trackInput();                                                                // 부팅 때부터 입력을 센다(문서가 없으면 아무 일 없음)
export function whenQuiet({ quietMs = 2000, maxMs = 30000 } = {}) {
  trackInput();
  const t0 = Date.now();
  return new Promise(resolve => {
    const idle = () => (typeof requestIdleCallback === 'function' ? requestIdleCallback(() => resolve(), { timeout: 1000 }) : setTimeout(resolve, 50));
    const check = () => {
      const late = Date.now() - t0 > maxMs;
      if (late ? isQuiet(1000, { strict: false }) : isQuiet(quietMs)) idle();
      else setTimeout(check, Math.max(200, Math.min(1000, quietMs - (Date.now() - lastBusy))));
    };
    check();
  });
}

// ---- 파일(Filesystem) — 원본 native.js 이식 ----
const fs = () => need('Filesystem');
const parentOf = p => p.split('/').filter(Boolean).slice(0, -1).join('/');
export const fsWrite = (dir, path, data, { utf8 = false } = {}) => call(() => fs().writeFile({ directory: dir, path, data, recursive: true, ...(utf8 ? { encoding: 'utf8' } : {}) }));
export const fsAppend = (dir, path, base64) => call(() => fs().appendFile({ directory: dir, path, data: base64 }));
export const fsRead = async (dir, path, { utf8 = false } = {}) => (await call(() => fs().readFile({ directory: dir, path, ...(utf8 ? { encoding: 'utf8' } : {}) }))).data;
export const fsDelete = (dir, path) => call(() => fs().deleteFile({ directory: dir, path }));
export const fsRmdir = (dir, path) => call(() => fs().rmdir({ directory: dir, path, recursive: true }));
export async function fsList(dir, path) {
  try {
    const r = await fs().readdir({ directory: dir, path });
    return r.files.map(f => (typeof f === 'string' ? { name: f } : { name: f.name, size: f.size, mtime: f.mtime, type: f.type }));
  } catch { return []; }
}
export async function fsStat(dir, path) { try { return await fs().stat({ directory: dir, path }); } catch { return null; } }
export const fsUri = async (dir, path) => (await call(() => fs().getUri({ directory: dir, path }))).uri;

// 폴더가 이미 있으면 그대로 둔다 — 실제 플러그인은 있는 폴더를 recursive 여도 「already exists」(OS-PLUG-FILE-0010)로 거부한다
export async function fsMkdir(dir, path) {
  const isDir = st => !!st && st.type === 'directory';
  const st = await fsStat(dir, path);
  if (isDir(st)) return;
  if (st) throw Object.assign(new Error(`폴더 자리에 파일이 있어요: ${path}`), { code: 'NOT_DIR' });
  try { await call(() => fs().mkdir({ directory: dir, path, recursive: true })); }
  catch (e) { if (!isDir(await fsStat(dir, path))) throw e; }              // 그 사이 다른 쪽이 만들었으면 성공
}
// 실제 Filesystem 은 copy·rename 대상의 부모 폴더를 만들어 주지 않는다(OS-PLUG-FILE-0011) — 먼저 만든다
async function ensureParent(fromDir, from, toDir, to) {
  const parent = parentOf(to);
  if (parent && !(toDir === fromDir && parent === parentOf(from))) await fsMkdir(toDir, parent);
}
export async function fsCopy(fromDir, from, toDir, to) {
  await ensureParent(fromDir, from, toDir, to);
  return call(() => fs().copy({ directory: fromDir, from, toDirectory: toDir, to }));
}
export async function fsRename(dir, from, to) {
  await ensureParent(dir, from, dir, to);
  return call(() => fs().rename({ directory: dir, from, to, toDirectory: dir }));
}
// 같은 이름이 이미 있는데 덮어쓸 수 없으면(재설치 전 설치가 만든 파일 — Android 11+ 소유권) 시각을 붙인 이름으로 한 번 더 → 실제로 쓴 상대 경로
export async function copyKeepingName(fromDir, from, toDir, toRel, now = Date.now()) {
  try { await fsCopy(fromDir, from, toDir, toRel); return toRel; }
  catch (e) {
    const t = new Date(now), p2 = n => String(n).padStart(2, '0');
    const alt = toRel.replace(/(\.[^./]+)?$/, ext => `-${p2(t.getHours())}${p2(t.getMinutes())}${p2(t.getSeconds())}${ext}`);
    try { await fsCopy(fromDir, from, toDir, alt); return alt; } catch { throw e; }
  }
}
// 임시 이름에 쓰고 바꾼다. 바꾸기가 실패하면 「임시도 있고 대상도 있을 때만」 대상을 지우고 다시 바꾼다(공시체 atomicWrite 구멍)
async function renameOver(dir, tmp, path) {
  try { await fsRename(dir, tmp, path); }
  catch (e) {
    if ((await fsStat(dir, tmp)) && (await fsStat(dir, path))) { await fsDelete(dir, path); await fsRename(dir, tmp, path); }
    else throw e;
  }
}
export async function atomicWrite(dir, path, text) {
  const tmp = `${path}.tmp`;
  await fsWrite(dir, tmp, text, { utf8: true });
  await renameOver(dir, tmp, path);
}
export async function fileSrc(dir, path, v) { return C().convertFileSrc(await fsUri(dir, path)) + (v ? `?v=${v}` : ''); }
// 목록·격자에서 항목마다 getUri 브리지 왕복을 하지 않게, 부팅 때 폴더 뿌리 주소를 한 번 받아 둔다
const fileBase = new Map();
export async function initFileBase() {
  if (!isNative()) return;
  await Promise.all([DIR.DATA, DIR.CACHE].map(async d => { fileBase.set(d, (await fsUri(d, '')).replace(/\/+$/, '')); }));
}
export function fileSrcSync(dir, path, v) {
  const root = fileBase.get(dir);
  if (root == null) throw new Error(`initFileBase() 를 먼저 불러야 해요(${dir})`);
  const rel = path.split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return C().convertFileSrc(`${root}/${rel}`) + (v ? `?v=${v}` : '');
}
// file:// 와 content:// 모두 convertFileSrc 주소로 읽는다(큰 파일도 base64 브리지를 거치지 않음)
export async function readBytes(uri) {
  const r = await fetch(C().convertFileSrc(uri));
  if (!r.ok) throw Object.assign(new Error(`파일을 읽지 못했어요(${r.status})`), { code: 'READ_FAIL' });
  return new Uint8Array(await r.arrayBuffer());
}

// ---- CACHE 쓰기 (설계 비평 #5) ----
// <rel>.tmp 에 512KB base64 조각으로 덧붙이고, finish 에서 실제 크기가 기대 크기와 같은지 본 뒤 이름을 바꾼다 — 최종 이름이 보이면 늘 완성본이다
// chunk: 조각 크기(기본 512KB — v0.1.7 내보내기 ZIP 은 작게 줘서 브리지 한 번이 메인을 잡는 시간을 줄인다)
// hold: 조각마다 쓰기 전에 기다릴 것(한번에 보내기가 다른 화면을 만지는 동안 브리지를 잡지 않게 — 없으면 바로)
export function cacheWriter(rel, { chunk = CHUNK, hold = null } = {}) {
  const tmp = `${rel}.tmp`;
  const step = Math.max(64 * 1024, Math.round(Number(chunk) || CHUNK));
  let started = null, written = 0;
  const start = () => (started ??= fsWrite(DIR.CACHE, tmp, ''));
  return {
    async append(u8) {
      await start();
      for (let i = 0; i < u8.length; i += step) {
        if (hold) { try { await hold(); } catch { /* 그냥 쓴다 */ } }
        await fsAppend(DIR.CACHE, tmp, await toB64(u8.subarray(i, i + step)));
      }
      written += u8.length;
    },
    async finish(expectedSize = written) {
      await start();
      const st = await fsStat(DIR.CACHE, tmp);                               // 조각이 조용히 빠진 파일을 내놓지 않게
      if (!st || Number(st.size) !== expectedSize) throw new Error(`저장한 파일 크기가 맞지 않아요(기대 ${expectedSize}, 실제 ${st ? st.size : '없음'})`);
      await renameOver(DIR.CACHE, tmp, rel);
      return fsUri(DIR.CACHE, rel);
    },
    async abort() { await fsDelete(DIR.CACHE, tmp).catch(() => {}); },
  };
}
export async function writeCache(path, blobOrBytes, onProgress) {
  const w = cacheWriter(path);
  try {
    const u8 = await toBytes(blobOrBytes);
    for (let i = 0; i < u8.length; i += CHUNK) {
      await w.append(u8.subarray(i, i + CHUNK));
      try { onProgress?.(Math.min(u8.length, i + CHUNK), u8.length); } catch { /* 화면 오류는 쓰기를 막지 않음 */ }
    }
    if (!u8.length) await w.append(u8);
    return await w.finish(u8.length);
  } catch (e) { await w.abort(); throw e; }
}

// 공유·내보내기 파일 하나를 CACHE/<path> 에 바로 쓴다(v0.1.7) → file:// 주소.
//   브리지는 512KB 조각마다 한 번(작으면 한 번뿐), 주소는 initFileBase 뿌리로 만든다(getUri 왕복 없음).
//   writeCache(임시 이름 → 크기 확인 → 이름 바꾸기 → getUri: 조각 수 + 4번)보다 적다 — 받는 앱이 보는 것은 끝난 뒤 넘기는 주소뿐이라 임시 이름이 필요 없다.
//   verify: 다 쓴 뒤 크기를 한 번 확인(조각이 조용히 빠진 파일을 넘기지 않게 — 여러 조각인 큰 파일에 권함). 실패하면 쓰다 만 파일을 지우고 던진다.
//   chunk: 조각 크기(기본 512KB). 큰 파일(사진대지 xlsx 수 MB)은 작게 주면 브리지 한 번이 메인·UI 스레드를 잡는 시간이 짧아진다(합은 같다)
//   data: Blob | Uint8Array | ArrayBuffer (Blob 이면 조각만 읽는다 — 통째로 메모리에 올리지 않음)
//   hold: 둘째 조각부터 쓰기 전에 기다릴 것(첫 조각 전은 부르는 쪽이) — 한번에 보내기가 다른 화면을 만지는 동안 브리지를 잡지 않게
export async function writeShareFile(path, data, { verify = false, chunk = CHUNK, hold = null } = {}) {
  const rel = String(path || '').split('/').filter(Boolean).join('/');
  if (!rel) throw Object.assign(new Error('파일 이름이 없어요'), { code: 'NO_FILE' });
  const blob = data instanceof Blob ? data : new Blob([data instanceof ArrayBuffer ? new Uint8Array(data) : data]);
  const size = blob.size;
  const step = Math.max(64 * 1024, Math.round(Number(chunk) || CHUNK));       // 조각마다 따로 base64(플러그인도 조각마다 풀어 덧붙인다)
  try {
    if (size <= step) await fsWrite(DIR.CACHE, rel, size ? await toB64(blob) : '');
    else {
      for (let at = 0; at < size; at += step) {
        if (hold && at) { try { await hold(); } catch { /* 그냥 쓴다 */ } }
        const b64 = await toB64(blob.slice(at, Math.min(size, at + step)));
        if (at === 0) await fsWrite(DIR.CACHE, rel, b64);
        else await fsAppend(DIR.CACHE, rel, b64);
      }
    }
    if (verify) {
      const st = await fsStat(DIR.CACHE, rel);
      if (!st || Number(st.size) !== size) throw new Error(`저장한 파일 크기가 맞지 않아요(기대 ${size}, 실제 ${st ? st.size : '없음'})`);
    }
  } catch (e) { await fsDelete(DIR.CACHE, rel).catch(() => {}); throw e; }
  const root = fileBase.get(DIR.CACHE);
  return root != null ? `${root}/${rel.split('/').map(encodeURIComponent).join('/')}` : fsUri(DIR.CACHE, rel);
}

// ZIP 흐름 쓰기용 싱크 — 앱: CACHE/<rel> 파일, 웹: Blob 조각을 모았다가 마지막에 하나로.
// → { write(u8), finish(size) → { blob } | { uri, path }, abort() }. chunk·hold: 앱 CACHE 조각 크기·조각마다 기다릴 것(cacheWriter)
export function zipSink(rel, mime = 'application/zip', { chunk = CHUNK, hold = null } = {}) {
  if (isNative()) {
    const w = cacheWriter(rel, { chunk, hold });
    return { write: u8 => w.append(u8), finish: async size => ({ uri: await w.finish(size), path: rel }), abort: () => w.abort() };
  }
  let parts = [];
  return {
    write: async u8 => { parts.push(new Blob([u8])); },
    finish: async size => {
      const blob = new Blob(parts, { type: mime });
      parts = [];
      if (Number.isFinite(size) && blob.size !== size) throw new Error(`만든 파일 크기가 맞지 않아요(기대 ${size}, 실제 ${blob.size})`);
      return { blob };
    },
    abort: async () => { parts = []; },
  };
}

// CACHE 의 내보내기·공유·백업 사본 정리 — app.js 가 첫 화면을 그린 뒤 부른다(공유 직후에는 받는 앱이 읽는 중일 수 있어 지우지 않는다)
// CACHE 뿌리를 한 번 readdir 해서 있는 것만 지운다(폴더마다 stat 하던 3번 → 1번, 속도 감사 #16). orig = 갤러리 원본 보내기 임시, sendrun = 한번에 보내기 사진(v0.1.7)
// 인자: 폴더 목록(옛 모양) 또는 { dirs, keep } — keep: 남길 경로(하나 또는 여럿, 'sendrun/<id>' 처럼). 폴더 안 한 칸이면 그 폴더의 나머지만 지운다(이어서 보내기).
//   sendrun 은 keep 을 넘긴 부르기(null 이라도 — 진행 중인 보내기를 아는 쪽)에서만 지운다: 옛 부르기 cleanupCache() 가 이어서 보낼 사진을 지우지 않게
export const CACHE_DIRS = Object.freeze(['export', 'share', 'backup', 'orig', 'sendrun']);
export async function cleanupCache(opts = {}) {
  if (!isNative()) return;
  const o = Array.isArray(opts) ? { dirs: opts } : (opts || {});
  const dirs = Array.isArray(o.dirs) ? o.dirs : 'keep' in o ? CACHE_DIRS : CACHE_DIRS.filter(d => d !== 'sendrun');
  const keep = (Array.isArray(o.keep) ? o.keep : [o.keep]).map(k => String(k || '').split('/').filter(Boolean).join('/')).filter(Boolean);
  const have = new Set((await fsList(DIR.CACHE, '')).map(f => f.name));
  for (const d of dirs) {
    if (!have.has(d)) continue;
    const mine = keep.filter(k => k === d || k.startsWith(`${d}/`));
    try {
      if (!mine.length) { await fsRmdir(DIR.CACHE, d); continue; }
      if (mine.includes(d)) continue;
      for (const f of await fsList(DIR.CACHE, d)) {
        const p = `${d}/${f.name}`;
        if (mine.some(k => k === p || k.startsWith(`${p}/`))) continue;
        await (f.type === 'directory' ? fsRmdir(DIR.CACHE, p) : fsDelete(DIR.CACHE, p));
      }
    } catch (e) { console.warn('임시 폴더를 지우지 못했어요', d, e); }
  }
}

// CACHE 파일(주소 또는 {path}) → 문서/현장사진대지 lite/<relPath>. 같은 이름이 있는데 못 덮으면 시각을 붙인다 → 실제 주소
export async function copyToDocuments(src, relPath) {
  let path = typeof src === 'object' && src ? src.path : null;
  if (!path && typeof src === 'string') {
    const base = (await fsUri(DIR.CACHE, '')).replace(/\/+$/, '');
    path = decodeURIComponent(src.startsWith(base) ? src.slice(base.length + 1) : src);
  }
  if (!path) throw Object.assign(new Error('복사할 파일이 없어요'), { code: 'NO_FILE' });
  const rel = await copyKeepingName(DIR.CACHE, path, DIR.DOCUMENTS, `${DOC_ROOT}/${relPath}`);
  return fsUri(DIR.DOCUMENTS, rel);
}

// 자동 백업 JSON 을 앱 안(DATA/backup/)과 문서 폴더(앱 삭제에도 남음, 최선 노력) 두 곳에 원자적으로(공시체 backupWrite) → 쓴 곳 이름
export async function backupWrite(name, text) {
  const where = [];
  if (!isNative()) return where;
  try { await atomicWrite(DIR.DATA, `backup/${name}`, text); where.push('앱 안'); }
  catch (e) { console.warn('[백업 DATA]', e); }
  try { await atomicWrite(DIR.DOCUMENTS, `${DOC_ROOT}/백업/${name}`, text); where.push('문서 폴더'); }
  catch { /* 공용 저장소는 기기·권한 따라 막힐 수 있다 — 앱 안 사본이 있으니 조용히 */ }
  return where;
}

// ---- 공유·클립보드 ----
// → { ok:true, target } | { ok:false, cancelled:true } | { ok:false, error }
export async function shareFiles(uris, { title = '보내기', text } = {}) {
  try {
    const r = await need('Share').share({ files: uris, dialogTitle: title, ...(text ? { text } : {}) });
    return { ok: true, target: r?.activityType ?? '' };
  } catch (e) {
    const m = String(e?.message || e);
    return /cancel/i.test(m) ? { ok: false, cancelled: true } : { ok: false, error: m };
  }
}
export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; } catch { /* 폴백으로 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;top:0;left:0;opacity:0';
    document.body.appendChild(ta); ta.select(); ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return !!ok;
  } catch { return false; }
}

// ---- 촬영·원본(Shot 플러그인, 공시체 ShotPlugin 이식·확장 — native-src 는 I 담당) ----
const shotError = e => {
  const m = `${e?.code ?? ''} ${e?.message ?? ''}`;
  const code = /cancel/i.test(m) ? 'CANCEL' : /permission|denied/i.test(m) ? 'PERMISSION_DENIED' : (e?.code || 'ERROR');
  return Object.assign(new Error(e?.message || String(e)), { code, cause: e });
};
// 휴대폰 카메라 앱으로 찍기. 임시 파일 경로는 photoId 로 미리 정해 앱이 죽어도 listTemp 로 되살린다 → { path, savedTo, name }
export async function take({ photoId, prefer = 'sd' } = {}) {
  const S = need('Shot');
  let r;
  try { r = await S.take({ photoId, prefer }); } catch (e) { throw shotError(e); }
  if (!r || r.cancelled || !r.path) throw Object.assign(new Error('촬영을 취소했어요'), { code: 'CANCEL' });
  return { path: r.path, savedTo: r.savedTo ?? null, name: r.name ?? null, uri: r.uri ?? null, sdMissed: !!r.sdMissed };
}
// 갤러리 원본 보내기 임시 파일 — CACHE/orig/<이름>. 512KB 조각마다 브리지 한 번(수 MB 한 덩어리가 브리지 줄을 100~300ms 막던 것, 속도 감사 #7),
// 조각 사이에 입력(셔터·글)이 있으면 한가해질 때까지 쉰다. 끝에 크기를 확인한다(조각이 조용히 빠진 파일을 갤러리에 넣지 않게) → file:// 주소
const ORIG_DIR = 'orig';
async function writeOrigTemp(data, rel) {
  const blob = data instanceof Blob ? data : new Blob([data instanceof ArrayBuffer ? new Uint8Array(data) : data]);
  const size = blob.size;
  if (!size) throw new Error('빈 사진이에요');
  try {
    for (let at = 0; at < size; at += CHUNK) {
      if (at && !isQuiet(800)) await whenQuiet({ quietMs: 800, maxMs: 5000 });
      const b64 = await toB64(blob.slice(at, Math.min(size, at + CHUNK)));
      if (at === 0) await fsWrite(DIR.CACHE, rel, b64);
      else await fsAppend(DIR.CACHE, rel, b64);
    }
    const st = await fsStat(DIR.CACHE, rel);
    if (!st || (Number.isFinite(Number(st.size)) && Number(st.size) !== size)) throw new Error(`임시 원본 크기가 맞지 않아요(${st ? st.size : '없음'}/${size})`);
  } catch (e) { await fsDelete(DIR.CACHE, rel).catch(() => {}); throw e; }
  const root = fileBase.get(DIR.CACHE);
  return root != null ? `${root}/${rel}` : fsUri(DIR.CACHE, rel);
}
// 앱 안 카메라 원본을 갤러리(DCIM/현장사진대지 lite)에 — SD 선호. 던지지 않는다 → { ok, savedTo, uri } | { ok:false, error }
//   bytes(Blob|Uint8Array) → CACHE 임시 파일에 조각으로 쓰고 Shot.saveOriginal({ path }) — 네이티브가 파일을 복사한다(브리지에 큰 덩어리 없음).
//   임시 파일 쓰기가 안 되면 예전 방식(base64 한 번). path 를 주면 그 파일 그대로. tempId: 임시 파일 이름(사진 id — 영문·숫자)
export async function saveOriginal({ bytes, path, name, prefer = 'sd', tempId = null } = {}) {
  const S = plugin('Shot');
  if (!S) return { ok: false, error: '앱에서만 돼요', code: 'NO_PLUGIN' };
  let temp = null;
  try {
    const opts = { name, prefer };
    if (path) opts.path = path;
    else if (bytes) {
      const rel = `${ORIG_DIR}/${String(tempId || Date.now().toString(36)).replace(/[^A-Za-z0-9_-]/g, '_')}.jpg`;
      try { opts.path = await writeOrigTemp(bytes, rel); temp = rel; }
      catch (e) { console.warn('갤러리 원본 임시 파일 실패 — 한 번에 보내요', e); opts.data = await toB64(bytes); }
    } else return { ok: false, error: '저장할 사진이 없어요' };
    const r = await S.saveOriginal(opts);
    if (!r?.savedTo) return { ok: false, error: r?.error || '갤러리에 넣지 못했어요' };
    return { ok: true, savedTo: r.savedTo, uri: r.uri ?? null };
  } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  finally { if (temp) fsDelete(DIR.CACHE, temp).catch(() => {}); }
}
export async function findOriginals({ names = [] } = {}) {
  const S = plugin('Shot');
  if (!S || !names.length) return [];
  try { return (await S.findOriginals({ names })).items || []; } catch (e) { console.warn('[갤러리 원본 찾기]', e); return []; }
}
export async function deleteTemp(path) {
  const S = plugin('Shot');
  if (!S || !path) return;
  try { await S.deleteTemp({ path }); } catch (e) { console.warn('[임시 파일 지우기]', e); }
}
export async function listTemp() {
  const S = plugin('Shot');
  if (!S) return [];
  try { return (await S.listTemp()).items || []; } catch { return []; }
}
// 본체·SD 여유 [{ label:'휴대폰'|'SD카드', free, total, removable }]. 웹은 [] (화면이 navigator.storage.estimate 를 따로 쓴다)
export async function storage() {
  const P = plugin('StorageInfo');
  if (!P) return [];
  try { return (await P.get()).volumes || []; } catch { return []; }
}

// ---- 네트워크 — CapacitorHttp 를 직접 부른다(전역으로 켜지 않음, 원본 ai.js 방식). 플러그인은 연결·읽기 시간만 세므로 전체 시간은 따로 잰다 ----
export async function httpGet(url, params = {}, { timeoutMs = 8000 } = {}) {
  const http = plugin('CapacitorHttp');
  let timer;
  const late = new Promise((_, rej) => { timer = setTimeout(() => rej(Object.assign(new Error('응답이 너무 늦어요'), { code: 'TIMEOUT' })), timeoutMs); });
  try {
    if (http) {
      const q = Object.fromEntries(Object.entries(params).map(([k, v]) => [k, String(v)]));
      let r;
      try { r = await Promise.race([http.request({ url, method: 'GET', params: q, connectTimeout: timeoutMs, readTimeout: timeoutMs }), late]); }
      catch (e) {
        if (e?.code === 'TIMEOUT' || /timeout|timed out/i.test(`${e?.code ?? ''} ${e?.message ?? ''}`)) throw Object.assign(new Error('응답이 너무 늦어요'), { code: 'TIMEOUT' });
        throw Object.assign(new Error('연결하지 못했어요'), { code: 'NETWORK', cause: e });
      }
      let data = r.data;
      if (typeof data === 'string') { try { data = JSON.parse(data); } catch { /* 글 그대로 */ } }
      return { status: r.status, data };
    }
    const ctl = new AbortController();
    const u = `${url}${url.includes('?') ? '&' : '?'}${new URLSearchParams(params)}`;
    let r;
    try { r = await Promise.race([fetch(u, { signal: ctl.signal }), late]); }
    catch (e) { ctl.abort(); throw e?.code === 'TIMEOUT' ? e : Object.assign(new Error('연결하지 못했어요'), { code: 'NETWORK', cause: e }); }
    const text = await r.text();
    let data = text;
    try { data = JSON.parse(text); } catch { /* 글 그대로 */ }
    return { status: r.status, data };
  } finally { clearTimeout(timer); }
}

// ---- 위치(@capacitor/geolocation) ----
// interval 을 안 주면 timeout(20초) 간격으로만 위치가 온다(설계 비평 기술 #11) — 3초 간격, 최소 1초
const GEO_OPTS = { enableHighAccuracy: true, timeout: 20000, maximumAge: 5000, interval: 3000, minimumUpdateInterval: 1000 };
const geoState = e => {
  const m = `${e?.code ?? ''} ${e?.message ?? ''}`;
  if (/GLOC-0003|denied|permission/i.test(m)) return 'denied';
  if (/GLOC-0007|disabled|turned off|location services/i.test(m)) return 'off';
  if (/timeout|GLOC-0010/i.test(m)) return 'timeout';
  return 'error';
};
// cb({lat,lng,acc,at} | null, err) — err.state: 'denied' | 'off' | 'timeout' | 'error'. 플러그인이 없으면 null(호출자가 navigator.geolocation 사용)
export async function geoWatch(cb, opts = {}) {
  const G = plugin('Geolocation');
  if (!G) return null;
  return G.watchPosition({ ...GEO_OPTS, ...opts }, (pos, err) => {
    if (err || !pos) { cb(null, Object.assign(new Error(err?.message || '위치를 받지 못했어요'), { state: geoState(err), code: err?.code })); return; }
    cb({ lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy, at: pos.timestamp || Date.now() }, null);
  });
}
export async function geoClear(id) {
  const G = plugin('Geolocation');
  if (G && id != null) { try { await G.clearWatch({ id }); } catch { /* 이미 해제됨 */ } }
}
// 권한 다시 묻기(거부 뒤 gps-card 를 눌렀을 때) → 'granted' | 'denied' | 'prompt' | null(웹)
export async function geoRequest() {
  const G = plugin('Geolocation');
  if (!G) return null;
  try { const r = await G.requestPermissions({ permissions: ['location'] }); return r?.location ?? null; }
  catch (e) { return geoState(e) === 'off' ? 'off' : 'denied'; }
}

// ---- 수명주기 ----
// 한 번 전환에 신호가 여러 번 온다(visibilitychange·pagehide·App pause·appStateChange). 각 쪽 첫 신호만 알리고 300ms 안의 같은 쪽 신호는 삼킨다(원본 값)
const SETTLE_MS = 300;
const settled = cb => {
  let last = -Infinity;
  return k => {
    const now = Date.now();
    if (now >= last && now - last < SETTLE_MS) return;
    last = now;
    try { cb(k); } catch (e) { console.error(e); }
    last = Date.now();
  };
};
const App = () => plugin('App');
// App.addListener 는 Promise<handle> 을 돌려준다 — 끄기 함수로 감싼다
const listen = (name, fn) => {
  const A = App();
  if (!A) return () => {};
  const h = Promise.resolve(A.addListener(name, fn)).catch(() => null);
  return () => { h.then(x => x?.remove?.()); };
};
// 수명주기 허브(속도 감사 #5①): 네이티브 리스너는 pause·resume 하나씩만 처음 한 번 붙이고(appStateChange 는 붙이지 않음 — pause/resume 과 겹친다),
// 구독자는 JS Set 으로 나눠 준다. 예전에는 구독자마다 addListener 2개씩(부팅 8번, 촬영 화면 들어갈 때마다 4번 붙이고 4번 떼기)이었다
const life = { pause: new Set(), resume: new Set() };
let hubOn = false;
function hub() {
  if (hubOn || typeof document === 'undefined') return;
  hubOn = true;
  const all = (k, why) => { for (const f of [...life[k]]) f(why); };
  document.addEventListener('visibilitychange', () => all(document.visibilityState === 'hidden' ? 'pause' : 'resume', document.visibilityState));
  window.addEventListener('pagehide', () => all('pause', 'pagehide'));
  listen('pause', () => all('pause', 'pause'));
  listen('resume', () => all('resume', 'resume'));
}
export function onPause(cb) {
  hub();
  const fire = settled(cb);
  life.pause.add(fire);
  return () => { life.pause.delete(fire); };
}
export function onResume(cb) {
  hub();
  const fire = settled(cb);
  life.resume.add(fire);
  return () => { life.resume.delete(fire); };
}
export const onBack = cb => listen('backButton', cb);
export const onRestored = cb => listen('appRestoredResult', cb);           // 카메라 앱을 띄운 사이 앱이 죽었다 살아났을 때
export const minimizeApp = () => { try { App()?.minimizeApp?.(); } catch { /* 웹 */ } };
export async function appInfo() { try { const r = await App().getInfo(); return { version: r?.version ?? '', build: r?.build ?? '' }; } catch { return { version: '', build: '' }; } }
