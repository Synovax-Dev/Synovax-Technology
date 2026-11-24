// The immune page: the latest public round and the hours before it.
import { $, el, icon, getJSON, when, day, clock, countdown } from './util.js';

const box = $('[data-immune]');
let next = 0;

function matrix(round, strains, disguises) {
  const held = new Map(round.results.map((r) => [`${r.strain}|${r.disguise}`, r.held]));
  return el('div', { class: 'p-matrix' }, el('table', {},
    el('caption', { class: 'sr', text: `Round of ${when(round.hourStart)}: each attack in each disguise` }),
    el('thead', {}, el('tr', {}, el('th', { scope: 'col', text: 'Attack' }), ...disguises.map((d) => el('th', { scope: 'col', text: d.name })))),
    el('tbody', {}, ...strains.map((s) => el('tr', {},
      el('th', { scope: 'row', title: s.text, text: s.name }),
      ...disguises.map((d) => {
        const h = held.get(`${s.id}|${d.id}`);
        return el('td', {}, el('span', { class: `p-cell ${h ? 'is-held' : 'is-through'}`, title: h ? 'held' : 'got through' }, icon(h ? 'check' : 'x'), el('span', { class: 'sr', text: h ? 'held' : 'got through' })));
      }))))));
}

async function load() {
  try {
    const { data } = await getJSON('/api/immune?limit=48');
    next = data.nextAt;
    if (!data.enabled) { box.replaceChildren(el('p', { class: 'p-note', text: 'This server does not run the public test (it was started with IMMUNE_TEST=off).' })); return; }
    if (!data.latest) { box.replaceChildren(el('p', { class: 'p-note', text: 'The first round runs within a minute of the server starting. Check back shortly.' })); return; }
    const r = data.latest;
    const recent = [...data.recent].reverse();
    box.replaceChildren(
      el('div', { class: 'p-live-head' },
        el('i', { class: `p-dot ${r.held === r.total ? 'is-ok' : 'is-warn'}` }),
        el('div', {},
          el('h3', { text: `${r.held} of ${r.total} held` }),
          el('p', { 'data-immune-when': true, text: `Round of ${day(r.hourStart)}, ${clock(r.hourStart)}, run ${when(r.ranAt)}. Next round in ${countdown(next - Date.now())}.` }))),
      el('div', {},
        matrix(r, data.strains, data.disguises),
        el('p', { class: 'p-note', text: `The last ${recent.length} rounds, oldest first. A full bar is a round where every attack was held.` }),
        el('div', { class: 'p-hours', role: 'img', 'aria-label': `${recent.filter((x) => x.held === x.total).length} of ${recent.length} rounds held every attack` },
          ...recent.map((x) => {
            const bar = el('i', { class: x.held === x.total ? '' : 'is-miss', title: `${when(x.hourStart)}: ${x.held} of ${x.total}` });
            bar.style.height = `${Math.max(8, Math.round((x.held / x.total) * 100))}%`; // CSSOM, allowed under the strict CSP
            return bar;
          })),
        el('p', { class: 'p-note p-mono', text: `This round's hash ${r.hash}, which commits to the one before it: ${r.prev}` })),
    );
  } catch (e) {
    box.replaceChildren(el('p', { class: 'p-note', text: `Could not load the record: ${e.message}` }));
  }
}

await load();
setInterval(() => {
  const w = $('[data-immune-when]');
  if (w && next) w.textContent = w.textContent.replace(/Next round in [\d:]+\./, `Next round in ${countdown(next - Date.now())}.`);
  if (next && Date.now() > next + 90_000) { next = 0; load(); }
}, 1000);
