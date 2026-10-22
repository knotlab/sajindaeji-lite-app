// 부팅 복구 계획 — 순수 함수(DOM·저장소 없음, node 시험: tests/unit/recover.test.mjs). 실제 일은 media/pipeline.js recover 가 한다.
// §4.5 안전 순서(공시체 BUGREPORT): 원본 bytes 는 incoming 에 먼저 → 메타(processing) → 작업본·썸네일 → ready.
// v0.1.4(속도 감사 #7): APK 앱 안 카메라 + 갤러리 저장이면 incoming 을 「갤러리에 넣을 때까지」 남긴다(original 사본 단계를 없앰).
//   ready 인데 메타에 incoming 이 남아 있으면 = 갤러리 원본이 아직이다 → 원본 줄로. 갤러리가 필요 없으면(웹·설정 끔·이미 넣음) incoming 만 치운다.
// 죽는 지점별로 어디서 이어지는지(시험이 같은 순서로 확인한다):
//   ① incoming 파일만 있고 메타 없음(메타 저장 전에 죽음)        → orphans(「복구된 사진」으로 입양)
//   ② 메타 processing(작업본 만들기 전·중에 죽음)                → resume
//   ③ ready + 메타 incoming, 갤러리 원본 아직                      → toGallery
//   ④ ready + 메타 incoming, 이미 갤러리에 넣음(기록까지 됨)       → release(incoming 만 지움 — 두 번 넣지 않게)
//   ⑤ ready, 메타에는 incoming 이 없는데 파일이 남음(지우기 직전 죽음) → strayIncoming(파일만 지움)
//   ⑤-2 ⑤ 와 같지만 갤러리 원본이 아직이고 한 번도 넣어 보지 않음(original.at 없음 — 부팅 복구로 메타를 되살리면 incoming 표지가 빠질 수 있다)
//        → toGallery(파일이 유일한 풀 해상도 원본 — 지우지 않고 갤러리에 넣은 뒤 치운다, v0.1.4 검토)
//   ⑥ 일시적 실패(failed + incoming, 다시 될 수 있음)              → retry
//   ⑦ 옛 판(v0.1.3)의 original 사본: 사진이 ready 이고 갤러리가 필요하면 → legacyOriginal, 아니면 → dropOriginal
// busy: 지금 들어오는 중(파일은 썼고 메타는 아직)인 id — 입양·삭제하지 않는다

export const NO_RETRY = Object.freeze(['BROKEN', 'NO_SOURCE']);               // 다시 해도 안 되는 실패
export const canRetry = p => !!p && p.state === 'failed' && !p.deletedAt && !NO_RETRY.includes(p.errorCode) && !!p.incoming;
// 갤러리 원본이 필요한 사진(APK 앱 안 카메라 + 갤러리 저장 켬 + 아직 안 넣음)
export const wantsGallery = (p, { native = false, gallery = true } = {}) => !!p && native && gallery !== false && p.source === 'incam' && !p.original?.savedTo;

export function planRecover({ photos = [], incoming = [], original = [], native = false, gallery = true, busy = [] } = {}) {
  const by = new Map(photos.filter(p => p && typeof p.id === 'string').map(p => [p.id, p]));
  const busyS = new Set(busy), incS = new Set(incoming);
  const out = { resume: [], retry: [], toGallery: [], release: [], strayIncoming: [], orphans: [], legacyOriginal: [], dropOriginal: [] };
  const opt = { native, gallery };
  for (const p of by.values()) {
    if (busyS.has(p.id)) continue;
    if (p.state === 'processing') out.resume.push(p.id);
    else if (canRetry(p)) out.retry.push(p.id);
    else if (p.state === 'ready' && p.incoming) (wantsGallery(p, opt) ? out.toGallery : out.release).push(p.id);
  }
  for (const id of incS) {
    if (busyS.has(id)) continue;
    const p = by.get(id);
    if (!p) out.orphans.push(id);
    else if (p.state === 'ready' && !p.incoming) (wantsGallery(p, opt) && !p.original?.at && !p.deletedAt ? out.toGallery : out.strayIncoming).push(id);
  }
  for (const id of new Set(original)) {
    if (busyS.has(id)) continue;
    const p = by.get(id);
    if (!p) { out.dropOriginal.push(id); continue; }
    if (p.state !== 'ready') continue;                                         // 아직 처리 중 — 끝난 뒤 다시 본다
    if (p.incoming) { out.dropOriginal.push(id); continue; }                   // 새 길(incoming)로 넣는다 — 사본은 필요 없음
    (wantsGallery(p, opt) ? out.legacyOriginal : out.dropOriginal).push(id);
  }
  return out;
}
