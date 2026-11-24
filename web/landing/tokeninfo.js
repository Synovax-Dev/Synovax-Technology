// Fills the $SYNOVAX section with what the admin panel published: status,
// contract address (with copy and explorer link), the official X account,
// supply and launch date. Everything is set with textContent, never as HTML.

const $ = (s, r = document) => r.querySelector(s);

export async function tokenInfo() {
  const sec = $('[data-tok]');
  if (!sec) return;
  let t;
  try {
    const res = await fetch('/api/token', { cache: 'no-store' });
    if (!res.ok) return;
    t = await res.json();
  } catch { return; }

  const set = (k, v, fallback) => {
    const el = $(`[data-tok="${k}"]`, sec);
    el.textContent = v || fallback;
    el.classList.toggle('tok-dim', !v);
  };
  set('launchDate', t.launchDate, 'tba');
  set('supply', t.supply, 'tba');
  $('[data-tok-corner]', sec).textContent = `supply · ${t.supply || 'tba'}`;

  const live = t.status === 'live';
  const status = $('[data-tok-status]', sec);
  status.querySelector('span').textContent = live ? 'live on robinhood chain' : 'pre-launch · not live yet';
  status.classList.toggle('is-live', live);
  if (live) {
    setHeadingWord('live');
    const lead = $('[data-tok-lead]', sec);
    if (lead) lead.textContent = 'The SYNOVAX token is live on Robinhood Chain. The ticker, supply, contract address and official X account are all on this page.';
  }

  // contract address
  const ca = $('[data-tok="contract"]', sec), act = $('[data-tok-ca-act]', sec);
  if (/^0x[0-9a-fA-F]{40}$/.test(t.contract)) {
    ca.textContent = t.contract;
    ca.classList.remove('tok-dim'); ca.classList.add('is-set');
    act.hidden = false;
    const copy = $('[data-tok-copy]', sec);
    copy.addEventListener('click', async () => {
      try { await navigator.clipboard.writeText(t.contract); copy.textContent = 'copied'; }
      catch { copy.textContent = 'select it'; selectText(ca); }
      copy.classList.add('is-ok');
      setTimeout(() => { copy.textContent = 'copy'; copy.classList.remove('is-ok'); }, 1600);
    });
    const ex = $('[data-tok-explorer]', sec);
    if (/^https:\/\//.test(t.explorerUrl)) { ex.href = t.explorerUrl; ex.hidden = false; }
    const road = $('[data-road="ca"]', sec);
    road.classList.add('is-done'); road.querySelector('.tr-s').textContent = 'posted';
  }
  if (live) {
    const road = $('[data-road="launch"]', sec);
    road.classList.remove('is-next'); road.classList.add('is-done'); road.querySelector('.tr-s').textContent = 'live';
  } else if (t.launchDate) {
    $('[data-road="launch"] .tr-s', sec).textContent = t.launchDate;
  }

  // the official X account, here and in the footer
  const handle = /^[A-Za-z0-9_]{1,15}$/.test(t.twitter) ? t.twitter : '';
  if (handle) {
    const url = `https://x.com/${handle}`;
    const x = $('[data-tok-x]', sec);
    x.href = url; x.textContent = `@${handle} ↗`; x.hidden = false;
    $('[data-tok-x-none]', sec).hidden = true;
    const fx = $('[data-foot-x]');
    if (fx) { fx.hidden = false; const a = fx.querySelector('a'); a.href = url; a.textContent = `x @${handle}`; }
  }

  // the warning changes once there is a real address to point to
  if (t.contract) {
    const warn = $('[data-tok-warn]', sec);
    const b = document.createElement('b');
    b.textContent = 'The only official contract address is the one shown above.';
    warn.replaceChildren(b, ` Check it ${handle ? `matches what @${handle} posts ` : ''}before you do anything, and ignore addresses from DMs or replies. Nothing on this page is an offer to buy or financial advice, and SYNOVAX is not affiliated with Robinhood.`);
  }
}

// "$SYNOVAX is coming" → "is live", whether or not the heading was split into words yet
function setHeadingWord(word) {
  const line = document.querySelectorAll('#tok-h [data-line]')[1];
  if (!line) return;
  if (!line._split) { line.textContent = `is ${word}`; return; }
  const u = line._split.units.at(-1);
  if (u.firstChild?.nodeType === Node.TEXT_NODE) u.firstChild.nodeValue = word;
  const sr = line.querySelector('.sr');
  if (sr) sr.textContent = `is ${word}`;
}

function selectText(el) {
  const r = document.createRange(); r.selectNodeContents(el);
  const s = getSelection(); s.removeAllRanges(); s.addRange(r);
}
