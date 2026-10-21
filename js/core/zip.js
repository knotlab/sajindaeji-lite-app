// ZIP(무압축 STORE) 만들기·읽기 — 공시체 share.js(crc32·zipChunks·makeZipBytes·parseZip)를 옮겨 고친 것.
// 바이트 배치는 공시체와 같다(폰 엑셀에서 복구 없이 열린 실적). 고친 점: 날짜 지정, 흐름 쓰기, 압축 항목 읽기(조용히 버리지 않음)
import { enc, dec } from './xml.js';

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(u8) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < u8.length; i++) c = CRC_TABLE[(c ^ u8[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

const u16 = v => [v & 255, (v >>> 8) & 255];
const u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
const dos = d => ({
  time: ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xFFFF,
  date: (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xFFFF,
});
// u16·u32 필드가 조용히 잘리지 않게 한다(Zip64 미지원). 0xFFFF·0xFFFFFFFF 는 Zip64 표지라 못 쓴다
const limits = (nameLen, headLen, bodyLen, offset, count) => {
  if (nameLen > 0xFFFF || bodyLen >= 0xFFFFFFFF || offset + headLen + bodyLen >= 0xFFFFFFFF || count >= 0xFFFE)
    throw new Error('ZIP 한계(항목 65,534개·4GiB, Zip64 미지원)를 넘습니다');
};
const bytesOf = data => (typeof data === 'string' ? enc.encode(data) : data);
const localHeader = (name, crc, size, t) => Uint8Array.from([
  ...u32(0x04034B50), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(t.time), ...u16(t.date),
  ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...name]);
const centralHeader = (name, crc, size, offset, t) => Uint8Array.from([
  ...u32(0x02014B50), ...u16(20), ...u16(20), ...u16(0x0800), ...u16(0), ...u16(t.time), ...u16(t.date),
  ...u32(crc), ...u32(size), ...u32(size), ...u16(name.length), ...u16(0), ...u16(0), ...u16(0), ...u16(0),
  ...u32(0), ...u32(offset), ...name]);
const eocd = (count, cdSize, cdOffset) => Uint8Array.from([
  ...u32(0x06054B50), ...u16(0), ...u16(0), ...u16(count), ...u16(count), ...u32(cdSize), ...u32(cdOffset), ...u16(0)]);

export function makeZipBytes(entries, { date = new Date() } = {}) {
  const t = dos(date), parts = [], central = [];
  let offset = 0;
  for (const e of entries) {
    const name = enc.encode(e.name), body = bytesOf(e.data), crc = crc32(body);
    const head = localHeader(name, crc, body.length, t);
    limits(name.length, head.length, body.length, offset, central.length);
    parts.push(head, body);
    central.push(centralHeader(name, crc, body.length, offset, t));
    offset += head.length + body.length;
  }
  const cdSize = central.reduce((n, c) => n + c.length, 0);
  const all = [...parts, ...central, eocd(entries.length, cdSize, offset)];
  const out = new Uint8Array(all.reduce((n, a) => n + a.length, 0));
  let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}

// 흐름 쓰기 — 항목을 받는 대로 write()로 내보낸다. 사진 수백 장 ZIP도 한 장씩만 메모리에 둔다
export class ZipStream {
  constructor(write, { date = new Date() } = {}) { this.write = write; this.t = dos(date); this.offset = 0; this.central = []; }
  async add(name, data) {
    if (this.busy || this.done) throw new Error('ZipStream: add 는 이전 add 가 끝난 뒤, finish 전에만 부를 수 있습니다');
    this.busy = true;
    try {
    const n = enc.encode(name), body = bytesOf(data), crc = crc32(body);
    const head = localHeader(n, crc, body.length, this.t);
    limits(n.length, head.length, body.length, this.offset, this.central.length);
    await this.write(join([head, body]));                                    // 머리와 본문을 한 번에 — 쓰기(앱에서는 브리지 왕복) 수를 반으로
    this.central.push(centralHeader(n, crc, body.length, this.offset, this.t));
    this.offset += head.length + body.length;
    } finally { this.busy = false; }
  }
  async finish() {
    if (this.busy || this.done) throw new Error('ZipStream: finish 는 한 번만, add 가 끝난 뒤에 부를 수 있습니다');
    this.done = true;
    const cdSize = this.central.reduce((n, c) => n + c.length, 0);
    await this.write(join([...this.central, eocd(this.central.length, cdSize, this.offset)]));   // 중앙 디렉터리 + 끝 표지를 한 번에(사진 1,000장이면 쓰기 2,000번 → 1번)
    return { count: this.central.length, size: this.offset + cdSize + 22 };
  }
}

function join(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

async function inflateRaw(u8) {
  const stream = new Blob([u8]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export async function parseZip(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let end = -1;
  for (let i = u8.length - 22; i >= Math.max(0, u8.length - 22 - 65536); i--) {
    if (dv.getUint32(i, true) === 0x06054B50) { end = i; break; }
  }
  if (end < 0) throw new Error('ZIP 형식이 아닙니다');
  const count = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  if (count === 0xFFFF || p === 0xFFFFFFFF) throw new Error('Zip64 ZIP은 지원하지 않습니다');
  const out = [];
  for (let k = 0; k < count; k++) {
    if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014B50) throw new Error('ZIP 중앙 디렉터리가 깨졌습니다');
    const method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true), csize = dv.getUint32(p + 20, true), usize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true), extraLen = dv.getUint16(p + 30, true), cmtLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = dec.decode(u8.subarray(p + 46, p + 46 + nameLen));
    const start = localOff + 30 + dv.getUint16(localOff + 26, true) + dv.getUint16(localOff + 28, true);
    if (start + csize > u8.length) throw new Error(`ZIP이 잘렸습니다: ${name}`);
    const raw = u8.subarray(start, start + csize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = await inflateRaw(raw).catch(e => { throw new Error(`ZIP 항목을 풀지 못했습니다: ${name}`, { cause: e }); });
    else throw new Error(`지원하지 않는 ZIP 압축 방식(${method}): ${name}`);
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`ZIP 항목이 손상됐습니다: ${name}`);
    out.push({ name, data });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

// ---- 큰 ZIP 범위 읽기(설계 비평 #5) — File/Blob.slice 로 끝의 중앙 디렉터리만 먼저 읽고, 항목은 필요할 때 하나씩.
// 수백 MB 백업 ZIP 을 통째로 메모리에 올리지 않는다(원본 backupzip.js read()/readEntry() 이식). parseZip 은 작은 ZIP·테스트용
export const ZIP_MAX_ENTRY = 32 * 1024 * 1024;
const r16 = (b, o) => b[o] | (b[o + 1] << 8);
const r32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const sliceOf = async (file, a, b) => new Uint8Array(await file.slice(a, b).arrayBuffer());

// 항목 하나 — 머리 30바이트로 데이터 자리를 찾고 그만큼만 slice. 크기·CRC 가 맞아야 돌려준다
export async function readZipEntry(file, e, max = ZIP_MAX_ENTRY) {
  if (e.flags & 1) throw new Error(`암호가 걸린 ZIP 은 지원하지 않습니다: ${e.name}`);
  if (e.usize > max) throw new Error(`ZIP 항목이 너무 큽니다: ${e.name}`);
  const head = await sliceOf(file, e.off, e.off + 30);
  if (head.length < 30 || r32(head, 0) !== 0x04034B50) throw new Error(`ZIP 항목 머리가 깨졌습니다: ${e.name}`);
  const start = e.off + 30 + r16(head, 26) + r16(head, 28);
  if (start + e.csize > file.size) throw new Error(`ZIP이 잘렸습니다: ${e.name}`);
  const raw = await sliceOf(file, start, start + e.csize);
  let data;
  if (e.method === 0) data = raw;
  else if (e.method === 8) data = await inflateRaw(raw).catch(err => { throw new Error(`ZIP 항목을 풀지 못했습니다: ${e.name}`, { cause: err }); });
  else throw new Error(`지원하지 않는 ZIP 압축 방식(${e.method}): ${e.name}`);
  if (data.length !== e.usize || crc32(data) !== e.crc) throw new Error(`ZIP 항목이 손상됐습니다: ${e.name}`);
  return data;
}

// File/Blob → { entries: [{ name, flags, method, crc, csize, usize, off }], bytes(entry, max?) → Promise<Uint8Array> }
export async function openZip(file) {
  const size = file.size;
  if (!(size >= 22)) throw new Error('ZIP 형식이 아닙니다');
  const tailStart = Math.max(0, size - 22 - 65535);
  const tail = await sliceOf(file, tailStart, size);
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) if (r32(tail, i) === 0x06054B50) { end = i; break; }
  if (end < 0) throw new Error('ZIP 형식이 아닙니다');
  const count = r16(tail, end + 10), cdSize = r32(tail, end + 12), cdOff = r32(tail, end + 16);
  if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOff === 0xFFFFFFFF) throw new Error('Zip64 ZIP은 지원하지 않습니다');
  if (cdOff + cdSize > tailStart + end) throw new Error('ZIP 중앙 디렉터리가 깨졌습니다');
  const cd = await sliceOf(file, cdOff, cdOff + cdSize);
  const entries = [];
  let p = 0;
  for (let k = 0; k < count; k++) {
    if (p + 46 > cd.length || r32(cd, p) !== 0x02014B50) throw new Error('ZIP 중앙 디렉터리가 깨졌습니다');
    const nameLen = r16(cd, p + 28), extraLen = r16(cd, p + 30), cmtLen = r16(cd, p + 32);
    if (p + 46 + nameLen > cd.length) throw new Error('ZIP 중앙 디렉터리가 깨졌습니다');
    entries.push({
      name: dec.decode(cd.subarray(p + 46, p + 46 + nameLen)), flags: r16(cd, p + 8), method: r16(cd, p + 10),
      crc: r32(cd, p + 16), csize: r32(cd, p + 20), usize: r32(cd, p + 24), off: r32(cd, p + 42),
    });
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return { entries, bytes: (e, max = ZIP_MAX_ENTRY) => readZipEntry(file, e, max) };
}
