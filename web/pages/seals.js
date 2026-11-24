// The latest seals, on the security page.
import { $, el, getJSON, hourSpan, num } from './util.js';

const list = $('[data-seals]');
try {
  const { data } = await getJSON('/api/seals?limit=8');
  list.replaceChildren(...(data.seals.length ? data.seals.map((s) => el('li', {},
    el('b', { text: `#${s.seq}` }),
    el('span', { text: hourSpan(s.periodStart, s.periodEnd) }),
    el('span', { class: 'n', text: `${num(s.count)} read${s.count === 1 ? '' : 's'}` }),
    el('code', { text: `root ${s.root}` }),
    el('code', { text: `chain ${s.chain}` }),
  )) : [el('li', {}, el('span', { class: 'empty', text: 'No seals yet. A seal is made at the end of a period that had reads.' }))]));
} catch (e) {
  list.replaceChildren(el('li', {}, el('span', { class: 'empty', text: `Could not load the seals: ${e.message}` })));
}
