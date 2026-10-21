// 자료 보기 `docview`(SPEC §10.6) — params { id }. 전체 화면 docFrame(인터랙티브) + 바(뒤로·이름·[고정]·[⋮])
// + 오른쪽 아래 떠 있는 주 버튼 [이 도면 띄우고 촬영] → capture { docId }(오늘 날짜 새 묶음).
// 보는 동안 화면 꺼짐 방지, 열 때 markOpened. 앱이 복귀해도 다시 그리지 않는다(keepOnResume — iframe 이 다시 뜨면 보던 쪽·확대가 사라짐).
import { h, toast } from '../dom.js';
import * as D from '../../data/docs.js';
import { docFrame } from '../widgets/docframe.js';
import { keepAwake } from '../../platform/awake.js';
import { dxIcon, docMenu } from './docs.js';

export default {
  keepOnResume: true,
  mount(root, params, nav) {
    const id = params?.id;
    const title = h('h1', { class: 'dv-title', text: '자료 보기' });
    const pin = h('button', { type: 'button', class: 'icbtn dv-pin', 'data-testid': 'docview-pin', 'aria-label': '맨 위에 고정', 'aria-pressed': 'false' }, dxIcon('pin'));
    const more = h('button', { type: 'button', class: 'icbtn', 'data-testid': 'docview-more', 'aria-label': '더 보기', onclick: () => docMenu(id, nav, { inViewer: true }) }, dxIcon('more'));
    const bar = h('div', { class: 'bar dv-bar' },
      h('button', { type: 'button', class: 'icbtn', 'aria-label': '뒤로', onclick: () => nav.back() }, dxIcon('back')),
      title, pin, more);
    const frame = docFrame({});
    const cap = h('button', { type: 'button', class: 'primary dv-capture', 'data-testid': 'docview-capture', onclick: () => nav.go('capture', { docId: id }) },
      dxIcon('camera'), h('span', { text: '이 도면 띄우고 촬영' }));
    const stage = h('div', { class: 'dv-stage' }, frame.el, cap);
    const page = h('div', { class: 'dv-page' }, bar, stage);
    root.append(page);

    pin.addEventListener('click', async () => {
      const d = D.doc(id);
      if (!d) return;
      try { await D.updateDoc(id, { pinned: !d.pinned }); toast(d.pinned ? '고정을 풀었어요' : '맨 위에 고정했어요'); }
      catch (err) { console.error(err); toast('하지 못했어요'); }
    });

    const paint = () => {
      const d = D.doc(id);
      if (!d) return;
      title.textContent = d.name;
      pin.classList.toggle('on', !!d.pinned);
      pin.setAttribute('aria-pressed', d.pinned ? 'true' : 'false');
      pin.setAttribute('aria-label', d.pinned ? '고정 풀기' : '맨 위에 고정');
      cap.textContent = '';
      cap.append(dxIcon('camera'), h('span', { text: d.kind === 'drawing' || d.kind === 'pdf' ? '이 도면 띄우고 촬영' : '이 자료 띄우고 촬영' }));
    };

    let dead = false, off = () => {};
    keepAwake(true);
    D.ready().then(() => {
      if (dead) return;
      const d = D.doc(id);
      if (!d || d.deletedAt) { title.textContent = '자료 보기'; pin.hidden = true; more.hidden = true; cap.hidden = true; frame.open(id); return; }
      paint();
      off = D.onDocs(() => { const x = D.doc(id); if (!x || x.deletedAt) return; paint(); });
      frame.open(id);
      D.markOpened(id).catch(err => console.warn('연 시각을 못 남겼어요', err));
    }, err => { console.error(err); toast('자료함을 열지 못했어요'); });

    return () => { dead = true; off(); frame.destroy(); keepAwake(false); };
  },
};
