// 공유 뒤처리(services/share.js 의 결과). 사진을 굽는 사이 활성화가 끝났으면(needTap) [공유하기] 시트로 한 번 더 누르게 하고,
// 한도(웹 10장·앱 20장)를 넘어 나눠졌으면(more) [다음 사진 보내기 (2/3)] 시트를 차례로 띄운다. 끝나면 토스트로 알린다.
import { h, openSheet, toast } from '../dom.js';

// 시트 하나: 주 버튼을 누르면 그 탭 안에서 run() 을 부른다(공유창은 사용자 탭 안에서만 뜬다). [그만]·뒤로 = null
function step(title, label, run) {
  return new Promise(resolve => {
    let res = null;
    openSheet(close => h('div', { class: 'sheet-body' },
      h('h2', { class: 'sheet-title', text: title }),
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'secondary', 'data-testid': 'share-stop', text: '그만', onclick: () => close() }),
        h('button', { type: 'button', class: 'primary', 'data-testid': 'share-next', text: label, onclick: () => { res = run(); close(); } }))),
      { label: title, onClose: () => resolve(res) });
  });
}

function doneText(r, total, copied) {
  if (!total) return copied ? '글을 복사했어요' : '사진이 없어요';
  const what = r?.where === 'download' ? `사진 ${total}장 내려받음` : `사진 ${total}장`;
  if (copied) return `글을 복사했어요 · ${what}`;
  return r?.where === 'download' ? `사진 ${total}장을 내려받았어요` : `사진 ${total}장을 보냈어요`;
}

export async function afterShare(r) {
  if (!r) return;
  const p = r.prepared, n = p?.batches || 0, copied = !!r.copied;
  if (r.textOnly) { toast(doneText(r, 0, copied)); return; }
  let k = 0;
  for (;;) {
    if (r?.needTap && p) {
      r = await step('사진을 보낼 준비가 됐어요', n > 1 ? `공유하기 (${k + 1}/${n})` : '공유하기', () => p.send(k));
      if (!r) return;
      continue;
    }
    if (!r?.ok) {
      if (r && !r.cancelled) toast('공유하지 못했어요');
      return;
    }
    k++;
    if (k >= n) { toast(doneText(r, p?.total || 0, copied)); return; }
    r = await step(`사진 ${p.total}장을 ${n}번에 나눠 보내요`, `다음 사진 보내기 (${k + 1}/${n})`, () => p.send(k));
    if (!r) return;
  }
}
