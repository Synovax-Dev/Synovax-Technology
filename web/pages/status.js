// The status page: asks the server every 30 seconds while the page is open.
import { $, el, getJSON, when, hourSpan, since, countdown, num } from './util.js';

const head = $('[data-status-head]');
const rows = $('[data-status-rows]');
const counts = $('[data-status-counts]');
let last = null;

function row(name, text, state, label) {
  const cls = state === 'ok' ? 'is-ok' : state === 'warn' ? 'is-warn' : state === 'bad' ? 'is-bad' : '';
  return el('li', {}, el('b', { text: name }), el('p', { text }), el('span', { class: 'p-state' }, el('i', { class: `p-dot ${cls}` }), label));
}

function render(s, ms) {
  const t = Date.now();
  const seals = s.seals;
  const job = { ok: ['ok', 'Working'], starting: ['warn', 'Starting'], late: ['bad', 'Late'], behind: ['warn', 'Catching up'], failed: ['bad', 'Failed'] }[seals.job] ?? ['warn', seals.job];
  const lastSeal = seals.latest
    ? `Last seal #${seals.latest.seq}: ${hourSpan(seals.latest.periodStart, seals.latest.periodEnd)}, ${num(seals.latest.count)} read${seals.latest.count === 1 ? '' : 's'}.`
    : 'No seal yet: a seal is made only for a period that had reads.';
  const waiting = `${num(seals.open)} read${seals.open === 1 ? '' : 's'} waiting for this period to close, in ${countdown(seals.nextCloseAt - t)}.`;
  const imm = s.immune;
  const immRow = !imm.enabled ? row('Immune test', 'This server does not run the public hourly test (IMMUNE_TEST=off).', '', 'Switched off')
    : !imm.latest ? row('Immune test', 'The first round runs within a minute of the server starting.', 'warn', 'Starting')
      : row('Immune test', `Last round ${when(imm.latest.ranAt)}: ${imm.latest.held} of ${imm.latest.total} attacks held.`, imm.latest.held === imm.latest.total ? 'ok' : 'warn', imm.latest.held === imm.latest.total ? 'All held' : 'Some got through');
  const bk = s.backups;
  const bkRow = !bk.enabled ? row('Backups', 'Automatic database copies are off on this server.', '', 'Switched off')
    : row('Backups', bk.lastAt ? `A copy of the database every ${Math.round(bk.intervalMs / 3_600_000)} hours. Last one ${since(t - bk.lastAt)} ago.` : 'The first copy is made shortly after start.', bk.lastAt && t - bk.lastAt < bk.intervalMs * 2 ? 'ok' : 'warn', bk.lastAt ? 'Working' : 'Waiting');
  rows.replaceChildren(
    row('Site and API', `Answering requests. Running for ${since(s.uptimeMs)} since its last start.`, 'ok', 'Working'),
    row('Vault database', `Reading and writing (${s.database.ms} ms for the check). It holds ciphertext, ids, sizes and times, never readable memories.`, s.database.state === 'ok' ? 'ok' : 'bad', s.database.state === 'ok' ? 'Working' : 'Failed'),
    row('Seal job', `${lastSeal} ${waiting}${seals.overdue ? ` ${num(seals.overdue)} reads from a finished period are not sealed yet.` : ''}`, job[0], job[1]),
    row('Seal copies', seals.published ? 'Every new seal is also posted to a webhook outside this server (SEAL_PUBLISH_URL).' : 'Seals are kept by this server only. A copy elsewhere (SEAL_PUBLISH_URL) is not switched on.', seals.published ? 'ok' : '', seals.published ? 'On' : 'Off'),
    immRow,
    bkRow,
  );
  const allOk = s.ok && seals.job === 'ok';
  head.replaceChildren(
    el('i', { class: `p-dot ${allOk ? 'is-ok' : s.ok ? 'is-warn' : 'is-bad'}` }),
    el('div', {},
      el('h3', { text: allOk ? 'Everything is working' : s.ok ? 'Working, with a note below' : 'Something is wrong' }),
      el('p', { text: `Checked ${when(t)}. The server answered in ${ms} ms. This page asks again every 30 seconds while it is open.` })),
  );
  if (s.counts) {
    counts.replaceChildren(el('dl', { class: 'p-stats' },
      ...[['Vaults', s.counts.vaults], ['Memories held encrypted', s.counts.memories], ['Connected apps', s.counts.apps], ['Reads logged', s.counts.reads], ['Seals written', s.counts.seals]]
        .map(([k, v]) => el('div', {}, el('dt', { text: k }), el('dd', { text: num(v) })))));
  } else {
    counts.replaceChildren(el('p', { class: 'p-note', text: `The totals appear here once this server holds ${num(s.statsMinVaults)} vaults, the same rule as the home page. ${num(seals.total)} seals written so far.` }));
  }
}

async function tick() {
  try {
    const { data, ms } = await getJSON('/api/status');
    last = { data, ms };
    render(data, ms);
  } catch (e) {
    head.replaceChildren(el('i', { class: 'p-dot is-bad' }), el('div', {}, el('h3', { text: 'The server did not answer' }), el('p', { text: `${e.message} Checked ${when(Date.now())}.` })));
  }
}

tick();
setInterval(() => { if (!document.hidden) tick(); }, 30_000);
// keep the countdown moving between checks
setInterval(() => { if (last && !document.hidden) render(last.data, last.ms); }, 1000);
