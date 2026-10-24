// Side panel: starts and stops listening, judges every new word with Jev and draws the result.
import { applyBrand, PRODUCT_NAME } from './brand.js';
import { DEEPGRAM_USD_PER_MIN } from './deepgram.js';
import { callJev, costOf, formatUsd } from './jev.js';
import { ACTIVE_AT, Judge } from './judge.js';
import { buildState, DRIVERS, QUESTIONS, readAnswers, signalWord } from './questions.js';
import { Transcript } from './transcript.js';

// Judge interim words as soon as they arrive (bench: ~0.5 s sooner than waiting a beat, and Deepgram's
// revisions are re-judged anyway). Past WINDOW_WORDS a call sees only the recent words plus a summary.
const POLICY = 'interim';
const WINDOW_WORDS = 2000;
const MAX_IN_FLIGHT = 3;
const DOM_WORDS = 700; // older words leave the page (they stay in the transcript and the export)
const CHART_SECONDS = 15 * 60; // the chart shows the last 15 minutes
const SWINGS = 5;

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search); // tests open the panel as a tab: ?tab=<id>
applyBrand();

let source = 'tab';
let session = null;
let usageTotal = null;

// ---------- settings ----------
const saved = await chrome.storage.local.get(['asset', 'context', 'source', 'usageTotal']);
$('asset').value = saved.asset || '';
$('context').value = saved.context || '';
setSource(saved.source || 'tab');
usageTotal = saved.usageTotal || { jevCalls: 0, jevTokens: 0, audioSeconds: 0, since: Date.now() };
$('asset').addEventListener('input', () => chrome.storage.local.set({ asset: $('asset').value.trim().toUpperCase() }));
$('context').addEventListener('input', () => chrome.storage.local.set({ context: $('context').value.trim() }));
for (const b of document.querySelectorAll('.source button')) b.onclick = () => !session?.on && setSource(b.dataset.source);

function setSource(s) {
  source = s;
  for (const b of document.querySelectorAll('.source button')) b.setAttribute('aria-checked', String(b.dataset.source === s));
  chrome.storage.local.set({ source: s });
}

function notice(html) {
  $('notice').hidden = !html;
  $('notice').innerHTML = html || '';
}

// ---------- start / stop ----------
$('go').onclick = () => (session?.on ? stop() : listen());
$('asset').addEventListener('keydown', (e) => e.key === 'Enter' && !session?.on && listen());

async function listen() {
  const asset = $('asset').value.trim().toUpperCase();
  if (!asset) {
    $('asset').focus();
    return notice('Name the stock or coin to judge first, like <b>NVDA</b> or <b>BTC</b>.');
  }
  const { apiKey, deepgramKey } = await chrome.storage.local.get(['apiKey', 'deepgramKey']);
  if (!apiKey || !deepgramKey) {
    return notice(`${PRODUCT_NAME} needs a ${!apiKey ? 'TypeSafe' : 'Deepgram'} key. <a href="options.html" target="_blank">Add it in settings</a>.`);
  }
  if (source === 'mic') {
    const perm = await navigator.permissions.query({ name: 'microphone' }).catch(() => null);
    if (perm?.state !== 'granted') {
      session = { pendingMic: true };
      chrome.tabs.create({ url: 'mic.html' });
      return notice('Allow the microphone in the tab that just opened; listening starts right after.');
    }
  }
  const tabId = params.has('tab') ? Number(params.get('tab')) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  notice('');
  start({ asset, context: $('context').value.trim(), apiKey, tabId });
  const res = await chrome.runtime.sendMessage({ type: 'listen', source, tabId }).catch((err) => ({ error: err.message }));
  if (res?.error) {
    finish('error');
    notice({
      'not-invoked': `Chrome needs one click first: press the ${PRODUCT_NAME} button in the toolbar while this tab is open (or Alt+Shift+H), then Listen.`,
      'chrome-page': 'Chrome’s own pages can’t be captured. Open the video or stream in a normal tab.',
      'no-deepgram-key': 'Add a Deepgram key in <a href="options.html" target="_blank">settings</a>.',
      'mic-blocked': 'Chrome blocked the microphone. Allow it for this extension and try again.',
    }[res.error] || `Couldn’t start listening: ${res.error}`);
    return;
  }
  if (source === 'tab' && tabId != null) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (tab?.title) {
      $('target').hidden = false;
      $('target').textContent = `Listening to “${tab.title}”`;
    }
  }
}

function start({ asset, context, apiKey, tabId }) {
  const transcript = new Transcript(POLICY);
  const judge = new Judge({
    maxInFlight: MAX_IN_FLIGHT,
    windowWords: WINDOW_WORDS,
    ask: async ({ words, newFrom, earlier }) => {
      const res = await callJev(apiKey, { state: buildState({ words, newFrom, asset, context, earlier }), questions: QUESTIONS });
      return { ...readAnswers(res.answers), tokens: res.usage?.input_tokens || 0 };
    },
    onChange: ({ point, revisedFrom }) => {
      if (point) onPoint(point);
      if (revisedFrom !== undefined) session.revisions++;
      dirty();
    },
    onError: (err) => {
      if (err.status === 401) notice('Jev rejected the TypeSafe key. <a href="options.html" target="_blank">Check it in settings</a>.');
    },
  });
  session = { on: true, asset, context, source, tabId, transcript, judge, lags: [], revisions: 0, startedAt: null, state: 'connecting', audio: 0, reconnects: 0, breaks: [], lastPuff: 0, billed: { calls: 0, tokens: 0, audio: 0 } };
  document.body.classList.add('on');
  document.body.classList.remove('done');
  $('go').textContent = 'Stop';
  $('go').dataset.on = '';
  $('asset').readOnly = $('context').readOnly = true;
  $('export').disabled = false;
  $('empty').hidden = true;
  wordEls.forEach((el) => el.remove());
  wordEls.clear();
  $('words').querySelectorAll('.more, .break').forEach((el) => el.remove());
  setLamp('connecting');
  dirty();
}

async function stop() {
  await chrome.runtime.sendMessage({ type: 'stopListening' }).catch(() => {});
  finish('off');
}

function finish(state) {
  if (!session) return;
  session.on = false;
  document.body.classList.remove('on');
  document.body.classList.add('done');
  $('go').textContent = 'Listen';
  delete $('go').dataset.on;
  $('asset').readOnly = $('context').readOnly = false;
  setLamp(state);
  dirty();
}

// ---------- messages from the offscreen document ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'micGranted' && session?.pendingMic) {
    session = null;
    listen();
    return;
  }
  if (!session?.on) return;
  if (msg.type === 'stt') {
    session.judge.update(session.transcript.apply(msg.msg));
    dirty();
  } else if (msg.type === 'status') {
    session.startedAt ??= msg.startedAt;
    if (msg.state === 'error' || msg.state === 'ended') {
      notice(msg.detail);
      finish(msg.state);
    } else setLamp(msg.state);
  } else if (msg.type === 'level') {
    session.startedAt ??= msg.startedAt;
    session.audio = msg.sentSeconds; // billed: quiet stretches aren't sent
    session.clock = msg.sessionSeconds;
    session.reconnects = msg.reconnects;
    if (msg.state !== session.state) setLamp(msg.state);
    dirty('meters');
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (session?.on && session.source === 'tab' && tabId === session.tabId) stop().then(() => notice('The tab was closed.'));
});
// A new page in the captured tab is usually new speech: mark where it starts.
chrome.tabs.onUpdated.addListener((tabId, info) => {
  if (!session?.on || session.source !== 'tab' || tabId !== session.tabId || info.status !== 'loading') return;
  session.breaks.push(session.transcript.all().length);
  dirty();
});

const LAMP = { off: 'Off', connecting: 'Connecting', live: 'Live', paused: 'Quiet', reconnecting: 'Reconnecting', error: 'Stopped', ended: 'Ended' };
function setLamp(state) {
  if (session) session.state = state;
  $('lamp').dataset.state = state;
  $('lampText').textContent = LAMP[state] || state;
}

function onPoint(p) {
  // Word spoken → gauge moved: for each word, the first reading that includes it. Words that a
  // revision brings back don't count again.
  if (session.startedAt) {
    const words = session.judge.words;
    const now = Date.now();
    for (let i = Math.max(p.from, session.lagged ?? 0); i < p.n; i++) {
      session.lags.push(now - (session.startedAt + words[i].end * 1000));
      if (session.lags.length > 5000) session.lags.shift();
    }
    session.lagged = Math.max(session.lagged ?? 0, p.n);
  }
  if (Math.abs(p.delta) >= 0.12 && performance.now() - session.lastPuff > 1500) {
    session.lastPuff = performance.now();
    const puffs = $('puffs');
    puffs.classList.remove('go');
    void puffs.getBBox();
    puffs.classList.add('go');
  }
}

// ---------- drawing ----------
let pending = new Set();
let frame = 0;
function dirty(part = 'all') {
  pending.add(part);
  frame ||= requestAnimationFrame(() => {
    frame = 0;
    const all = pending.has('all');
    pending = new Set();
    if (all) {
      drawGauge();
      drawChart();
      drawDrivers();
      drawWords();
    }
    drawMeters();
  });
}

const CX = 160, CY = 168, SWEEP = 110;
const polar = (deg, r) => [CX + r * Math.sin((deg * Math.PI) / 180), CY - r * Math.cos((deg * Math.PI) / 180)];
const mix = (v) => `color-mix(in oklch, var(${v < 0 ? '--bear' : '--bull'}) ${Math.round(Math.min(1, Math.abs(v)) * 100)}%, var(--neutral))`;

(function buildGauge() {
  const band = [];
  const N = 44;
  for (let i = 0; i < N; i++) {
    const a = -SWEEP + (2 * SWEEP * i) / N, b = -SWEEP + (2 * SWEEP * (i + 1)) / N + 0.4;
    const [x1, y1] = polar(a, 128), [x2, y2] = polar(b, 128);
    band.push(`<path d="M${x1.toFixed(2)} ${y1.toFixed(2)} A128 128 0 0 1 ${x2.toFixed(2)} ${y2.toFixed(2)}" style="stroke:${mix((a + b) / 2 / SWEEP)};stroke-width:13;fill:none"/>`);
  }
  const [ox1, oy1] = polar(-SWEEP - 2, 137), [ox2, oy2] = polar(SWEEP + 2, 137);
  band.push(`<path d="M${ox1} ${oy1} A137 137 0 1 1 ${ox2} ${oy2}" style="stroke:var(--steel);stroke-width:1.5;fill:none;opacity:.6"/>`);
  $('band').innerHTML = band.join('');
  const ticks = [];
  for (let i = -10; i <= 10; i++) {
    const v = i / 10, major = i % 5 === 0;
    const [x1, y1] = polar(v * SWEEP, major ? 104 : 110), [x2, y2] = polar(v * SWEEP, 119);
    ticks.push(`<line class="${major ? 'major' : ''}" x1="${x1.toFixed(2)}" y1="${y1.toFixed(2)}" x2="${x2.toFixed(2)}" y2="${y2.toFixed(2)}"/>`);
    if (major) {
      const [tx, ty] = polar(v * SWEEP, 91);
      const label = v === 0 ? '0' : `${v > 0 ? '+' : '−'}${Math.abs(v) === 1 ? '1' : '.5'}`;
      ticks.push(`<text x="${tx.toFixed(1)}" y="${(ty + 4).toFixed(1)}" text-anchor="middle">${label}</text>`);
    }
  }
  $('ticks').innerHTML = ticks.join('');
  $('puffs').innerHTML = [[146, 40, 7], [162, 34, 9], [176, 42, 6]].map(([x, y, r]) => `<circle cx="${x}" cy="${y}" r="${r}"/>`).join('');
})();

const fmtSigned = (v, d = 2) => `${v >= 0.005 ? '+' : v <= -0.005 ? '−' : ''}${Math.abs(v).toFixed(d)}`;
const dir = (v, eps = 0.05) => (v <= -eps ? 'bear' : v >= eps ? 'bull' : '');
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function drawGauge() {
  const p = session?.judge?.last;
  const v = p?.signal ?? 0;
  $('needle').style.transform = `rotate(${(v * SWEEP).toFixed(2)}deg)`;
  // A steam gauge trembles; this one trembles as much as Jev is unsure.
  const amp = p ? Math.max(0, 1 - (p.confidence ?? 1)) * 2.4 : 0;
  document.querySelector('.tremble').style.setProperty('--amp', `${amp.toFixed(2)}deg`);
  $('value').textContent = p ? fmtSigned(v) : '0.00';
  $('value').dataset.dir = dir(v, 0.1);
  $('word').textContent = p ? signalWord(v) : session?.on ? 'Listening' : 'Waiting';
  $('conf').textContent = p?.confidence != null ? `confidence ${Math.round(p.confidence * 100)}%` : '';
  // The latest real move, in words.
  const moves = session?.judge ? session.judge.swings(Infinity, 0.1) : [];
  const h = moves.reduce((a, m) => (!a || m.n > a.n ? m : a), null);
  $('heard').hidden = !h;
  if (h) {
    $('heard').innerHTML = `<b data-dir="${dir(h.delta)}">${fmtSigned(h.delta)}</b>${PRODUCT_NAME} heard “${esc(h.quote)}”`;
    if (session.heardAt !== h.from) {
      session.heardAt = h.from;
      $('heard').classList.remove('fresh');
      void $('heard').offsetWidth;
      $('heard').classList.add('fresh');
    }
  }
}

let chartW = 0;
new ResizeObserver(([e]) => {
  chartW = e.contentRect.width;
  dirty();
}).observe($('chart'));

function drawChart() {
  const svg = $('chart');
  const W = Math.max(200, Math.round(svg.clientWidth || chartW)), H = 136, padL = 34, padR = 10, padT = 10, padB = 18;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const points = session?.judge?.points || [];
  const now = Math.max(session?.clock || 0, points.at(-1)?.t || 0);
  const t1 = Math.max(60, now), t0 = Math.max(0, t1 - CHART_SECONDS);
  const x = (t) => padL + ((t - t0) / (t1 - t0)) * (W - padL - padR);
  const y = (v) => padT + ((1 - v) / 2) * (H - padT - padB);
  const out = [];
  for (const v of [-1, -0.5, 0.5, 1]) out.push(`<line class="grid" x1="${padL}" x2="${W - padR}" y1="${y(v)}" y2="${y(v)}"/>`);
  const step = [15, 30, 60, 120, 300, 600].find((s) => (t1 - t0) / s <= 6) || 900;
  for (let t = Math.ceil(t0 / step) * step; t <= t1; t += step) {
    out.push(`<line class="grid" x1="${x(t)}" x2="${x(t)}" y1="${padT}" y2="${H - padB}"/>`);
    out.push(`<text class="axis" x="${x(t)}" y="${H - 5}" text-anchor="middle">${clock(t)}</text>`);
  }
  out.push(`<line class="zero" x1="${padL}" x2="${W - padR}" y1="${y(0)}" y2="${y(0)}"/>`);
  out.push(`<text class="axis" x="4" y="${y(0.75) + 3}">Bull</text><text class="axis" x="4" y="${y(-0.75) + 3}">Bear</text>`);

  // Step trace, downsampled to at most two points per pixel column (the min and max in it).
  const vis = points.filter((p) => p.t >= t0);
  const cols = new Map();
  for (const p of vis) {
    const c = Math.round(x(p.t));
    const b = cols.get(c);
    if (!b) cols.set(c, { min: p, max: p, last: p, raw: p.raw });
    else {
      if (p.signal < b.min.signal) b.min = p;
      if (p.signal > b.max.signal) b.max = p;
      b.last = p;
      b.raw = p.raw;
    }
  }
  // Jev's own per-word readings, faint, behind the eased trace.
  for (const [c, b] of cols) if (!b.last.ad) out.push(`<circle class="raw" cx="${c}" cy="${y(b.raw).toFixed(1)}" r="1.3"/>`);
  let d = `M${x(t0)} ${y(vis.length ? (points[points.indexOf(vis[0]) - 1]?.signal ?? 0) : points.at(-1)?.signal ?? 0)}`;
  for (const [c, b] of cols) {
    const ys = b.min === b.max ? [b.last.signal] : [b.min.signal, b.max.signal, b.last.signal];
    for (const v of ys) d += ` H${c} V${y(v).toFixed(1)}`;
  }
  if (session) d += ` H${x(Math.max(now, t0))}`;
  const area = `${d} V${y(0)} H${x(t0)} Z`;
  out.push(`<clipPath id="above"><rect x="0" y="0" width="${W}" height="${y(0)}"/></clipPath><clipPath id="below"><rect x="0" y="${y(0)}" width="${W}" height="${H}"/></clipPath>`);
  out.push(`<path class="fill-bull" clip-path="url(#above)" d="${area}"/><path class="fill-bear" clip-path="url(#below)" d="${area}"/>`);
  out.push(`<path class="trace" d="${d}"/>`);
  if (session?.on) out.push(`<circle class="now" cx="${x(Math.max(now, t0))}" cy="${y(points.at(-1)?.signal ?? 0)}" r="3.5"/>`);

  // Pins on the biggest swings.
  const swings = session?.judge ? session.judge.swings(SWINGS) : [];
  swings.forEach((m, i) => {
    if (m.t < t0) return;
    out.push(`<g class="pin ${dir(m.delta)}"><circle cx="${x(m.t)}" cy="${y(m.signal)}" r="8"/><text x="${x(m.t)}" y="${y(m.signal) + 3.5}" text-anchor="middle">${i + 1}</text></g>`);
  });
  svg.innerHTML = out.join('');
  $('span').textContent = session ? (t0 > 0 ? 'last 15 min' : clock(now)) : '';

  $('swings').innerHTML = swings.map((m, i) => `<li class="${dir(m.delta)}"><button type="button" data-n="${m.n}" data-from="${m.from}" title="Show these words in the transcript">
    <span class="n">${i + 1}</span><span class="d">${fmtSigned(m.delta)}</span><span class="q">“${esc(m.quote)}”</span><span class="t">${clock(m.t)}</span></button></li>`).join('');
}

$('swings').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const els = [];
  for (let i = Number(b.dataset.from); i < Number(b.dataset.n); i++) wordEls.get(i) && els.push(wordEls.get(i));
  if (!els.length) return;
  els.at(-1).scrollIntoView({ block: 'center', behavior: 'smooth' });
  els.forEach((el) => el.classList.add('flash'));
  setTimeout(() => els.forEach((el) => el.classList.remove('flash')), 1600);
});

(function buildDrivers() {
  $('drivers').innerHTML = DRIVERS.map((d) => `<li data-id="${d.id}"><span class="name">${d.label}</span><span class="say"></span><span class="bar"><i></i></span></li>`).join('');
})();

function drawDrivers() {
  const drivers = session?.judge?.last?.drivers || {};
  for (const d of DRIVERS) {
    const li = $('drivers').querySelector(`[data-id="${d.id}"]`);
    const v = drivers[d.id] ?? 0;
    const active = Math.abs(v) >= ACTIVE_AT;
    li.className = `${active ? 'active' : ''} ${v < 0 ? 'bear' : 'bull'}`;
    li.querySelector('i').style.transform = `scaleX(${Math.min(1, Math.abs(v)).toFixed(3)})`;
    li.querySelector('.say').textContent = active ? d.words[v > 0 ? 1 : 0] || '' : '';
  }
}

// Transcript: one span per word. Only the last DOM_WORDS are on the page.
const wordEls = new Map();
let follow = true;
$('words').addEventListener('scroll', () => {
  const el = $('words');
  follow = el.scrollTop + el.clientHeight >= el.scrollHeight - 30;
  $('toLive').hidden = follow || !session?.on;
});
$('toLive').onclick = () => {
  follow = true;
  $('words').scrollTop = $('words').scrollHeight;
  $('toLive').hidden = true;
};

function drawWords() {
  if (!session?.transcript) return;
  const box = $('words');
  const words = session.transcript.all();
  const judge = session.judge;
  const start = Math.max(0, words.length - DOM_WORDS);
  const lastN = judge.last?.n ?? 0;

  // How much each visible word moved the signal: a call's move is shared by the words it added.
  const tint = new Map();
  const ad = new Set();
  for (let k = judge.points.length - 1; k >= 0; k--) {
    const p = judge.points[k];
    if (p.n <= start) break;
    for (let i = Math.max(p.from, start); i < p.n; i++) {
      if (p.ad) ad.add(i);
      else tint.set(i, p.rawDelta / (p.n - p.from));
    }
  }
  const pins = new Map(judge.swings(SWINGS).map((m, i) => [m.peak.n - 1, { i: i + 1, d: dir(m.delta) }]));

  for (const [i, el] of wordEls) {
    if (i >= start && i < words.length) continue;
    if (el.nextSibling?.nodeType === Node.TEXT_NODE) el.nextSibling.remove();
    el.remove();
    wordEls.delete(i);
  }
  let more = box.querySelector('.more');
  if (start > 0) {
    if (!more) {
      more = document.createElement('span');
      more.className = 'more';
      box.prepend(more);
    }
    more.textContent = `${start.toLocaleString('en-US')} earlier words`;
  } else more?.remove();

  let prevEl = more;
  for (let i = start; i < words.length; i++) {
    const w = words[i];
    let el = wordEls.get(i);
    if (!el) {
      el = document.createElement('span');
      el.dataset.i = i;
      (prevEl ? prevEl.after(el) : box.append(el));
      el.after(document.createTextNode(' '));
      wordEls.set(i, el);
      if (session.breaks.includes(i)) {
        const br = document.createElement('span');
        br.className = 'break';
        br.textContent = 'New page';
        el.before(br);
      }
    }
    prevEl = el.nextSibling;
    const t = tint.get(i);
    const cls = `w${!w.final ? ' interim' : ''}${i >= lastN ? ' pending' : ''}${ad.has(i) ? ' ad' : ''}`;
    if (el.className !== cls) el.className = cls;
    const bg = t ? `color-mix(in oklch, var(${t < 0 ? '--bear-wash' : '--bull-wash'}) ${Math.round(Math.min(1, Math.abs(t) / 0.2) * 100)}%, transparent)` : '';
    if (el.style.backgroundColor !== bg) el.style.backgroundColor = bg;
    const pin = pins.get(i);
    const html = esc(w.w) + (pin ? `<sup class="${pin.d}">${pin.i}</sup>` : '');
    if (el.innerHTML !== html) el.innerHTML = html;
    el.title = t ? `${fmtSigned(t, 3)} · ${clock(w.start)}` : clock(w.start);
  }
  if (follow) box.scrollTop = box.scrollHeight;
}

function drawMeters() {
  const j = session?.judge;
  const s = j?.stats;
  $('mCalls').textContent = `${(s?.calls ?? 0).toLocaleString('en-US')} calls`;
  $('mTokens').textContent = (s?.tokens ?? 0) >= 1e6 ? `${(s.tokens / 1e6).toFixed(2)}M` : (s?.tokens ?? 0).toLocaleString('en-US');
  const audio = session?.audio || 0;
  $('mCost').textContent = formatUsd(costOf(s?.tokens || 0) + (audio / 60) * DEEPGRAM_USD_PER_MIN);
  $('mCost').title = `Jev ${formatUsd(costOf(s?.tokens || 0))} + Deepgram ${formatUsd((audio / 60) * DEEPGRAM_USD_PER_MIN)}`;
  $('mP50').textContent = j?.p50 ? `${Math.round(j.p50)} ms` : '–';
  const lags = session?.lags || [];
  if (lags.length) {
    const sorted = [...lags].sort((a, b) => a - b);
    $('mLag').textContent = `${(sorted[Math.floor(sorted.length / 2)] / 1000).toFixed(1)} s`;
    $('mLag').title = `From a word’s end to the first reading that includes it. p95 ${(sorted[Math.floor(sorted.length * 0.95)] / 1000).toFixed(1)} s over ${lags.length} words`;
  } else $('mLag').textContent = '–';
  $('mAudio').textContent = `${clock(session?.clock || 0)}${session?.reconnects ? ` · ${session.reconnects}↻` : ''}`;
  $('mAudio').title = `${clock(audio)} sent to Deepgram (quiet stretches aren’t sent)${session?.reconnects ? `, ${session.reconnects} reconnects` : ''}`;
  saveUsage();
}

// Lifetime usage for the settings page.
let usageTimer;
function saveUsage() {
  if (!session?.judge) return;
  const s = session.judge.stats, b = session.billed;
  usageTotal.jevCalls += s.calls - b.calls;
  usageTotal.jevTokens += s.tokens - b.tokens;
  usageTotal.audioSeconds += session.audio - b.audio;
  session.billed = { calls: s.calls, tokens: s.tokens, audio: session.audio };
  usageTimer ||= setTimeout(() => {
    usageTimer = 0;
    chrome.storage.local.set({ usageTotal });
  }, 1000);
}

// ---------- export ----------
function timeline() {
  if (!session?.judge) return null;
  const { judge, transcript } = session;
  const lags = [...session.lags].sort((a, b) => a - b);
  return {
    product: PRODUCT_NAME,
    asset: session.asset,
    context: session.context,
    source: session.source,
    startedAt: session.startedAt,
    policy: POLICY,
    windowWords: WINDOW_WORDS,
    words: transcript.all().map(({ w, start, end, final }) => ({ w, start, end, final })),
    points: judge.points.map(({ n, from, t, raw, signal, delta, confidence, drivers, ad, ms }) => ({ n, from, t, raw, signal, delta, confidence, drivers, ad, ms })),
    swings: judge.swings(SWINGS).map(({ from, n, t, delta, signal, quote }) => ({ from, n, t, delta, signal, quote })),
    stats: {
      jevCalls: judge.stats.calls,
      jevTokens: judge.stats.tokens,
      jevCostUsd: costOf(judge.stats.tokens),
      jevP50Ms: judge.p50,
      cached: judge.stats.cached,
      stale: judge.stats.stale,
      rejudges: judge.stats.rejudges,
      errors: judge.stats.errors,
      audioSeconds: session.audio,
      deepgramCostUsd: (session.audio / 60) * DEEPGRAM_USD_PER_MIN,
      reconnects: session.reconnects,
      lagP50Ms: lags[Math.floor(lags.length / 2)] ?? null,
      lagP95Ms: lags[Math.floor(lags.length * 0.95)] ?? null,
      lagCount: lags.length,
    },
  };
}

$('export').onclick = () => {
  const data = timeline();
  if (!data) return;
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  a.download = `${PRODUCT_NAME.toLowerCase()}-${data.asset}-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
};

// For tests and the export.
globalThis.panel = { timeline, session: () => session };
dirty();
