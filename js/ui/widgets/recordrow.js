// 묶음 한 줄(SPEC §5.7) — 1행 위치(굵게, 없으면 「위치 미입력」 흐리게), 2행 내용(2줄 말줄임), 3행 썸네일 최대 5 + 「+n」, 오른쪽 「HH:mm · n장」.
import { h } from '../dom.js';
import * as store from '../../data/store.js';
import { hm } from '../../core/date.js';
import { thumb } from './thumb.js';

const MAX_THUMBS = 5;

export function recordRow(record, { onOpen } = {}) {
  const photos = (store.photosOf?.(record.id) ?? []);
  const loc = (record.location || '').trim();
  const content = (record.content || '').trim();
  const shown = photos.slice(0, MAX_THUMBS);
  const more = photos.length - shown.length;
  const row = h('button', {
    type: 'button', class: 'recrow', 'data-testid': 'record-row', 'data-id': record.id,
    onclick: () => onOpen?.(record),
  },
    h('div', { class: 'recrow-head' },
      h('span', { class: ['recrow-loc', !loc && 'muted'], text: loc || '위치 미입력' }),
      h('span', { class: 'recrow-meta', text: `${hm(record.createdAt)} · ${photos.length}장` })),
    content ? h('p', { class: 'recrow-content', text: content }) : null,
    shown.length ? h('div', { class: 'recrow-thumbs' },
      shown.map(p => thumb(p.id, { className: 'recrow-th' })),
      more > 0 ? h('span', { class: 'recrow-more', text: `+${more}` }) : null) : null);
  return row;
}
