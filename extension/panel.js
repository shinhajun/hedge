// Side panel: starts and stops listening, judges every new word with Jev and draws the result.
import { applyBrand, PRODUCT_NAME } from './brand.js';
import { DEEPGRAM_USD_PER_MIN, keytermsFor } from './deepgram.js';
import { callJev, costOf, formatUsd } from './jev.js';
import { ACTIVE_AT, Judge } from './judge.js';
import { ENTER, EXIT, PaperBook } from './paper.js';
import { findSource } from './price.js';
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
const FRESH_MS = { crypto: 15_000, stock: 120_000 }; // a tick older than this isn't a live price
const BAD_VENUE_MS = 24 * 3600_000; // how long a venue that failed here is skipped
const SILENT_FEED_MS = 6000; // a crypto stream with no trade by then is treated as blocked

const $ = (id) => document.getElementById(id);
const params = new URLSearchParams(location.search); // tests open the panel as a tab: ?tab=<id>
const isMac = /Mac/.test(navigator.userAgentData?.platform || navigator.platform);
const keycap = () => `<span class="keycap"><img src="icons/32.png" alt="">${PRODUCT_NAME}</span>`;
const shortcut = isMac ? '⌥⇧H' : 'Alt+Shift+H';
applyBrand();

let source = 'tab';
let session = null;
let usageTotal = null;

// ---------- settings ----------
const saved = await chrome.storage.local.get(['asset', 'context', 'source', 'usageTotal', 'paper', 'paperThresholds']);
let thresholds = { enter: ENTER, exit: EXIT, ...saved.paperThresholds };
function showThresholds() {
  for (const el of document.querySelectorAll('.pEnter')) el.textContent = thresholds.enter;
  for (const el of document.querySelectorAll('.pExit')) el.textContent = thresholds.exit;
}
showThresholds();
// Settings can change the thresholds mid-session; the open book follows from its next decision.
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local' || !ch.paperThresholds) return;
  thresholds = { enter: ENTER, exit: EXIT, ...ch.paperThresholds.newValue };
  if (session?.book) Object.assign(session.book, thresholds);
  showThresholds();
});
$('asset').value = saved.asset || '';
$('context').value = saved.context || '';
setSource(saved.source || 'tab');
usageTotal = saved.usageTotal || { jevCalls: 0, jevTokens: 0, audioSeconds: 0, since: Date.now() };
$('asset').addEventListener('input', () => chrome.storage.local.set({ asset: $('asset').value.trim().toUpperCase() }));
$('context').addEventListener('input', () => chrome.storage.local.set({ context: $('context').value.trim() }));
for (const b of document.querySelectorAll('.source button')) b.onclick = () => !session?.on && setSource(b.dataset.source);
$('paperOn').checked = !!saved.paper;
$('paperOn').onchange = () => {
  chrome.storage.local.set({ paper: $('paperOn').checked });
  // Turning it on starts a fresh book from now; turning it off drops it.
  if (session?.judge) session.book = $('paperOn').checked ? new PaperBook(thresholds) : null;
  dirty();
};

function setSource(s) {
  source = s;
  for (const b of document.querySelectorAll('.source button')) b.setAttribute('aria-checked', String(b.dataset.source === s));
  chrome.storage.local.set({ source: s });
  $('micRow').hidden = s !== 'mic';
  if (s === 'mic') listDevices();
  hint();
}

function notice(html) {
  $('notice').hidden = !html;
  $('notice').innerHTML = html || '';
}

// ---------- start / stop ----------
// The usual start is one click on the toolbar button: the service worker starts capturing that tab and
// the panel attaches to it. Listen here starts the microphone, or a tab the button was clicked on before.
let pendingMic = false;
let autoDiag = false; // the panel opened Diagnostics itself, because of a problem

$('go').onclick = () => (session?.on ? stop() : listen());
$('asset').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  if (session?.on) armJudge();
  else listen();
});

async function listen() {
  const { apiKey, deepgramKey } = await chrome.storage.local.get(['apiKey', 'deepgramKey']);
  if (!apiKey || !deepgramKey) return drawChecklist(true);
  let tabId;
  if (source === 'mic') {
    const perm = await navigator.permissions.query({ name: 'microphone' }).catch(() => null);
    if (perm?.state !== 'granted') {
      pendingMic = true;
      chrome.tabs.create({ url: 'mic.html' });
      return notice('Allow the microphone in the tab that just opened.');
    }
  } else {
    tabId = params.has('tab') ? Number(params.get('tab')) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  }
  notice('');
  setLamp('connecting');
  const res = await chrome.runtime.sendMessage({ type: 'listen', source, tabId }).catch((err) => ({ error: err.message }));
  if (res?.error === 'already') return syncCapture();
  if (res?.error) return showError(res.error);
  attach({ source, tabId, startedAt: res.startedAt });
}

// Show a capture that has started (here, from the toolbar button, or before this panel opened).
// `log` replays the results it already has.
function attach({ source: src, tabId, startedAt, log = [] }) {
  if (session?.on && session.startedAt === startedAt) return;
  const transcript = new Transcript(POLICY);
  for (const m of log) transcript.apply(m);
  session = { on: true, asset: '', context: '', source: src, tabId, transcript, judge: null, lags: [], revisions: 0, startedAt, state: 'connecting', audio: 0, reconnects: 0, breaks: [], lastPuff: 0, billed: { calls: 0, tokens: 0, audio: 0 }, prices: [], feed: null, book: null, diag: {} };
  setSource(src);
  document.body.classList.add('on');
  document.body.classList.remove('done');
  $('go').textContent = 'Stop';
  $('go').dataset.on = '';
  $('export').disabled = false;
  $('empty').hidden = true;
  wordEls.forEach((el) => el.remove());
  wordEls.clear();
  $('words').querySelectorAll('.more, .break').forEach((el) => el.remove());
  notice('');
  setLamp('connecting');
  armJudge();
  hint();
  dirty();
}

// Judging starts once there is an asset; until then the transcript runs on its own.
async function armJudge() {
  const s = session;
  if (!s?.on || s.judge) return;
  const asset = $('asset').value.trim().toUpperCase();
  if (!asset) {
    $('asset').focus();
    return notice('Type the stock or coin above and press Enter. Hedge is already listening.'.replace('Hedge', PRODUCT_NAME));
  }
  const { apiKey } = await chrome.storage.local.get('apiKey');
  if (s !== session || s.judge) return;
  if (!apiKey) return drawChecklist(true);
  s.asset = asset;
  s.context = $('context').value.trim();
  s.judge = new Judge({
    maxInFlight: MAX_IN_FLIGHT,
    windowWords: WINDOW_WORDS,
    ask: async ({ words, newFrom, earlier }) => {
      const res = await callJev(apiKey, { state: buildState({ words, newFrom, asset, context: s.context, earlier }), questions: QUESTIONS });
      return { ...readAnswers(res.answers), tokens: res.usage?.input_tokens || 0 };
    },
    onChange: ({ point, revisedFrom }) => {
      if (s !== session) return;
      if (point) onPoint(point);
      if (revisedFrom !== undefined) s.revisions++;
      dirty();
    },
    onError: (err) => {
      if (err.status === 401) notice('Jev rejected the TypeSafe key. <a href="options.html" target="_blank">Check it in Settings</a>.');
    },
  });
  s.book = $('paperOn').checked ? new PaperBook(thresholds) : null;
  $('asset').readOnly = $('context').readOnly = true;
  // The capture may have started before the asset was known: give Deepgram its names now.
  chrome.runtime.sendMessage({ target: 'offscreen', type: 'configure', keyterms: keytermsFor(asset, s.context) }).catch(() => {});
  notice('');
  startPrice(s);
  s.judge.update(s.transcript.judgeable());
  dirty();
}

async function stop() {
  await chrome.runtime.sendMessage({ type: 'stopListening' }).catch(() => {});
  finish('off');
}

function finish(state) {
  if (!session) return;
  session.on = false;
  session.closeFeed?.();
  document.body.classList.remove('on');
  document.body.classList.add('done');
  $('go').textContent = 'Listen';
  delete $('go').dataset.on;
  $('asset').readOnly = $('context').readOnly = false;
  setLamp(state);
  hint();
  dirty();
}

const ERRORS = {
  'not-invoked': () => `Click ${keycap()} on this tab to listen <span class="kbd">${shortcut}</span>`,
  'chrome-page': () => 'Chrome’s own pages can’t be captured. Open the video in a normal tab.',
  'mic-blocked': () => 'Chrome blocked the microphone. Allow it from the mic icon in the address bar, then Listen again.',
  'mic-missing': () => 'That microphone isn’t connected. Pick another Input above.',
};
function showError(code) {
  if (code === 'no-deepgram-key') return drawChecklist(true);
  setLamp(session?.on ? session.state : 'off');
  notice((ERRORS[code] || (() => `Couldn’t start listening: ${code}`))());
}

// Ask the offscreen document what it is capturing, and attach to it.
async function syncCapture() {
  const st = await chrome.runtime.sendMessage({ type: 'captureState' }).catch(() => null);
  if (st?.active) {
    attach(st);
    if (st.diag) Object.assign(session.diag, st.diag);
  }
}

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'micGranted' && pendingMic) {
    pendingMic = false;
    listen();
    return;
  }
  if (msg.type === 'captureStarted') return syncCapture();
  if (msg.type === 'captureError') return showError(msg.error);
  if (!session?.on || (msg.startedAt && msg.startedAt !== session.startedAt)) return;
  if (msg.type === 'stt') {
    const words = session.transcript.apply(msg.msg);
    session.judge?.update(words);
    dirty();
  } else if (msg.type === 'status') {
    // Diagnostics stay folded for the demo, and open by themselves when something is wrong.
    if (['error', 'silent', 'reconnecting'].includes(msg.state) && !$('diag').open) {
      $('diag').open = true;
      autoDiag = true;
    } else if (msg.state === 'live' && autoDiag) {
      $('diag').open = false;
      autoDiag = false;
    }
    if (msg.state === 'error' || msg.state === 'ended') {
      notice(esc(msg.detail || ''));
      finish(msg.state);
    } else {
      setLamp(msg.state);
      if (msg.state === 'silent') {
        notice(isMac
          ? 'The microphone hears nothing. Turn on Chrome in System Settings → Privacy & Security → Microphone, or pick another Input above.'
          : 'The microphone hears nothing. Check that it isn’t muted, or pick another Input above.');
      } else if (session.state !== 'silent' && /Microphone|hears nothing/.test($('notice').textContent)) notice('');
    }
  } else if (msg.type === 'level') {
    Object.assign(session.diag, msg);
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
chrome.tabs.onActivated.addListener(() => hint());

// One line under the controls: what is being heard, or the one thing to do to hear this tab.
async function hint() {
  const active = params.has('tab') ? Number(params.get('tab')) : (await chrome.tabs.query({ active: true, currentWindow: true }))[0]?.id;
  const el = $('target');
  if (session?.on && session.source === 'mic') {
    el.innerHTML = `Listening through ${esc(session.diag.device || 'the microphone')}`;
  } else if (session?.on && session.tabId === active) {
    el.innerHTML = 'Listening to this tab';
  } else if (source === 'tab') {
    el.innerHTML = `Click ${keycap()} on this tab to listen <span class="kbd">${shortcut}</span>`;
  } else el.innerHTML = '';
  el.hidden = !el.innerHTML;
}

// First run: the two keys, then the one thing to do.
async function drawChecklist(flash = false) {
  const { apiKey, deepgramKey } = await chrome.storage.local.get(['apiKey', 'deepgramKey']);
  const row = (ok, label) => `<li class="${ok ? 'ok' : 'no'}"><i aria-hidden="true">${ok ? '✓' : '✗'}</i>${label}${ok ? '' : ' <a href="options.html" target="_blank">Add in Settings</a>'}</li>`;
  $('checklist').innerHTML = row(!!apiKey, 'TypeSafe key') + row(!!deepgramKey, 'Deepgram key') +
    `<li class="go"><i aria-hidden="true">→</i>Click ${keycap()} on the tab you want to hear</li>`;
  $('checklist').classList.toggle('flash', flash && !(apiKey && deepgramKey));
  if (flash && !(apiKey && deepgramKey)) setLamp('off');
}
chrome.storage.onChanged.addListener((ch, area) => area === 'local' && (ch.apiKey || ch.deepgramKey) && drawChecklist());

// ---------- microphone input ----------
async function listDevices() {
  const devices = (await navigator.mediaDevices.enumerateDevices().catch(() => [])).filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default');
  const { micDevice } = await chrome.storage.local.get('micDevice');
  $('micDevice').innerHTML = `<option value="">Default input</option>` +
    devices.map((d, i) => `<option value="${esc(d.deviceId)}"${d.deviceId === micDevice ? ' selected' : ''}>${esc(d.label || `Microphone ${i + 1}`)}</option>`).join('');
}
$('micDevice').onchange = async () => {
  await chrome.storage.local.set({ micDevice: $('micDevice').value });
  if (session?.on && session.source === 'mic') listen();
};
navigator.mediaDevices.addEventListener?.('devicechange', listDevices);

// ---------- live price ----------
async function startPrice(s) {
  $('priceLabel').textContent = s.asset;
  $('priceNote').textContent = 'Looking for a live price…';
  // A venue that failed here (Binance refuses US addresses) is skipped for a day.
  const { badVenues = {} } = await chrome.storage.local.get('badVenues');
  const skip = Object.keys(badVenues).filter((v) => Date.now() - badVenues[v] < BAD_VENUE_MS);
  const { source: src, failed } = await findSource(s.asset, { skip });
  if (failed.length) {
    for (const v of failed) badVenues[v] = Date.now();
    chrome.storage.local.set({ badVenues });
  }
  if (s !== session || !s.on) return;
  s.feed = src;
  if (!src) {
    $('priceNote').textContent = `No keyless live price for ${s.asset}. Crypto streams from Binance or Coinbase; stocks need Yahoo or Nasdaq, which didn’t answer.`;
    return dirty();
  }
  $('priceNote').textContent = '';
  const onTick = (tick) => {
    tick.seenAt = Date.now(); // plotted at the moment it arrived, on the same clock as the words
    s.lastTick = tick;
    const last = s.prices[s.prices.length - 1];
    // Keep at most two ticks a second (the latest in each half second); hours of ticks stay small.
    if (last && tick.seenAt - last.slot < 500) s.prices[s.prices.length - 1] = { ...tick, slot: last.slot };
    else s.prices.push({ ...tick, slot: tick.seenAt });
    dirty('price');
  };
  if (src.first) onTick(src.first);
  s.closeFeed = src.open(onTick);
  // A stream that opens but never ticks (Binance's WebSocket from the US) counts as blocked too.
  if (src.kind === 'crypto') {
    setTimeout(async () => {
      if (s !== session || !s.on || s.feed !== src || s.lastTick?.seenAt) return;
      s.closeFeed();
      const { badVenues: bad = {} } = await chrome.storage.local.get('badVenues');
      await chrome.storage.local.set({ badVenues: { ...bad, [src.venue]: Date.now() } });
      startPrice(s);
    }, SILENT_FEED_MS);
  }
}

// The live price, or null when the last tick is stale or the market is closed.
function livePrice(s = session) {
  const t = s?.lastTick;
  return t?.live && s.feed && Date.now() - t.seenAt <= FRESH_MS[s.feed.kind] ? t.price : null;
}

const LAMP = { off: 'Off', connecting: 'Connecting', live: 'Live', paused: 'Quiet', silent: 'No sound', reconnecting: 'Reconnecting', error: 'Stopped', ended: 'Ended' };
function setLamp(state) {
  if (session) session.state = state;
  $('lamp').dataset.state = state;
  $('lampText').textContent = LAMP[state] || state;
}

function onPoint(p) {
  if (session.book && !p.ad) {
    for (const e of session.book.update(p.signal, livePrice(), p.t)) (session.paperEvents ||= []).push(e);
  }
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
    const parts = pending;
    pending = new Set();
    if (all) {
      drawGauge();
      drawChart();
      drawDrivers();
      drawWords();
    }
    if (all || parts.has('price')) drawPrice();
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
let axis = null; // the signal chart's time axis; the price strip shares it
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
  axis = { t0, t1, x, W, padL, padR };
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

  $('swings').innerHTML = swings.map((m, i) => `<li class="${m.driver ? (m.driver.jump > 0 ? 'bull' : 'bear') : dir(m.delta)}"><button type="button" data-n="${m.n}" data-from="${m.from}" title="Show these words in the transcript">
    <span class="n">${i + 1}</span><span class="d">${fmtSigned(m.delta)}</span><span class="q">${m.driver ? `<i class="drv">${esc(m.driver.label)} ${esc(m.driver.word)}</i>` : ''}“${esc(m.quote)}”</span><span class="t">${clock(m.t)}</span></button></li>`).join('');
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

const money = (v, cur = 'USD') => {
  const a = Math.abs(v);
  const digits = a >= 1000 ? 2 : a >= 1 ? 2 : 6;
  return (cur === 'USD' ? '$' : '') + a.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits });
};
const signedMoney = (v) => `${v >= 0.005 ? '+' : v <= -0.005 ? '−' : ''}$${Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

function drawPrice() {
  const svg = $('priceChart');
  const s = session;
  const ticks = s?.prices || [];
  const W = Math.max(200, Math.round(svg.clientWidth || chartW)), H = 74, padT = 8, padB = 8;
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  const last = s?.lastTick;
  const live = livePrice(s);
  if (last) {
    const first = ticks[0]?.price ?? last.price;
    const ch = (last.price / first - 1) * 100;
    const closed = s.feed?.kind === 'stock' && !last.live;
    $('priceNow').innerHTML = `${money(last.price, last.currency)}<em data-dir="${dir(ch, 0.005)}">${closed ? 'market closed' : `${ch >= 0 ? '+' : '−'}${Math.abs(ch).toFixed(2)}%`}</em>`;
    $('priceLabel').textContent = `${s.asset} · ${s.feed?.venue ?? ''}`;
  } else $('priceNow').textContent = '';
  const out = [];
  if (axis && s?.startedAt && ticks.length) {
    const { x, t0, t1 } = axis;
    const ts = (tick) => (tick.seenAt - s.startedAt) / 1000;
    const vis = ticks.filter((k) => ts(k) >= t0 - 5);
    const prices = vis.map((k) => k.price);
    let lo = Math.min(...prices), hi = Math.max(...prices);
    if (hi - lo < lo * 0.0005) [lo, hi] = [lo * 0.99975, hi * 1.00025]; // a flat market still gets a band
    const y = (p) => padT + ((hi - p) / (hi - lo)) * (H - padT - padB);
    out.push(`<line class="grid" x1="${axis.padL}" x2="${W - axis.padR}" y1="${y(hi)}" y2="${y(hi)}"/><line class="grid" x1="${axis.padL}" x2="${W - axis.padR}" y1="${y(lo)}" y2="${y(lo)}"/>`);
    out.push(`<text class="axis" x="2" y="${y(hi) + 3}">${compact(hi)}</text><text class="axis" x="2" y="${y(lo) + 3}">${compact(lo)}</text>`);
    // The swings, carried down from the signal chart: did the price follow?
    for (const m of s.judge?.swings(SWINGS) || []) if (m.t >= t0) out.push(`<line class="guide" x1="${x(m.t)}" x2="${x(m.t)}" y1="${padT}" y2="${H - padB}"/>`);
    // Paper position spans.
    for (const tr of [...(s.book?.trades || []), ...(s.book?.position ? [{ ...s.book.position, inT: s.book.position.t, outT: Math.min(t1, s.clock ?? t1) }] : [])]) {
      if (tr.outT < t0) continue;
      out.push(`<rect class="held" x="${x(Math.max(t0, tr.inT))}" y="${padT}" width="${Math.max(1, x(tr.outT) - x(Math.max(t0, tr.inT)))}" height="${H - padT - padB}"/>`);
    }
    let d = '';
    for (const k of vis) d += `${d ? 'L' : 'M'}${x(Math.max(t0, ts(k))).toFixed(1)} ${y(k.price).toFixed(1)} `;
    if (s.on && vis.length) d += `L${x(Math.min(t1, Math.max(t0, s.clock ?? ts(vis.at(-1))))).toFixed(1)} ${y(vis.at(-1).price).toFixed(1)}`;
    out.push(`<path class="line" d="${d}"/>`);
    // Paper fills: ▲ long, ▼ short, ○ exit.
    for (const e of s.paperEvents || []) {
      if (e.t < t0) continue;
      const cx = x(e.t), cy = y(Math.min(hi, Math.max(lo, e.price)));
      if (e.type === 'open') {
        const up = e.side === 'long';
        out.push(`<path class="fill ${e.side}" d="M${cx} ${cy + (up ? -6 : 6)} l5 ${up ? 9 : -9} h-10 Z"/>`);
      } else out.push(`<circle class="exit" cx="${cx}" cy="${cy}" r="3.5"/>`);
    }
  }
  svg.innerHTML = out.join('');
  if (s?.feed && !live && s.on && s.lastTick) {
    $('priceNote').textContent = s.feed.kind === 'stock' ? `${s.asset}’s market is closed, so this is the last trade; paper trading waits for a live price.` : 'Waiting for the price feed…';
  } else if (s?.feed && s.lastTick) $('priceNote').textContent = '';
  drawPaper(live);
}

const compact = (p) => (p >= 1000 ? p.toLocaleString('en-US', { maximumFractionDigits: 0 }) : p >= 1 ? p.toFixed(2) : p.toPrecision(3));

function drawPaper(live) {
  const book = session?.book;
  $('paper').hidden = !book;
  if (!book) return;
  const mark = live ?? session.lastTick?.price ?? null;
  const pnl = book.pnl(mark);
  const pos = book.position;
  $('paperPos').textContent = pos ? `${pos.side} since ${clock(pos.t)} @ ${compact(pos.entry)}` : live == null ? 'waiting for a live price' : 'flat';
  $('paperPnl').textContent = signedMoney(pnl.total);
  $('paperPnl').dataset.dir = dir(pnl.total, 0.005);
  const rows = book.trades.slice(-4).map((t) => ({ ...t, open: false }));
  if (pos) rows.push({ side: pos.side, inT: pos.t, entry: pos.entry, pnl: pnl.open, open: true });
  $('trades').innerHTML = rows.map((t) => `<li><span class="side ${t.side}">${t.side}</span><span>${clock(t.inT)} @ ${compact(t.entry)} → ${t.open ? 'open' : `${clock(t.outT)} @ ${compact(t.exit)}`}</span><span class="pl">${signedMoney(t.pnl)}</span></li>`).join('');
}

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
  const lastN = judge?.last?.n ?? 0;
  const points = judge?.points || [];

  // How much each visible word moved the signal: a call's move is shared by the words it added.
  const tint = new Map();
  const ad = new Set();
  for (let k = points.length - 1; k >= 0; k--) {
    const p = points[k];
    if (p.n <= start) break;
    for (let i = Math.max(p.from, start); i < p.n; i++) {
      if (p.ad) ad.add(i);
      else tint.set(i, p.rawDelta / (p.n - p.from));
    }
  }
  const pins = new Map((judge ? judge.swings(SWINGS) : []).map((m, i) => [m.peak.n - 1, { i: i + 1, d: dir(m.delta) }]));

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

function drawDiag() {
  const d = session?.diag || {};
  const db = d.level > 0 ? Math.max(-60, 20 * Math.log10(d.level)) : -60;
  $('dLevel').style.transform = `scaleX(${((db + 60) / 60).toFixed(3)})`;
  $('dLevelText').textContent = d.level != null && session?.on ? `${Math.round(db)} dB` : '–';
  $('dDevice').textContent = d.source === 'tab' ? 'This tab' : d.device || '–';
  $('dRate').textContent = d.sampleRate ? `${d.sampleRate.toLocaleString('en-US')} Hz → 16,000 Hz` : '–';
  $('dSocket').textContent = d.socket ? `${d.socket}${d.closeInfo ? ` (last close ${d.closeInfo.code}${d.closeInfo.reason ? `: ${d.closeInfo.reason}` : ''})` : ''}` : '–';
  $('dSent').textContent = d.bytesSent != null ? `${(d.bytesSent / 1e6).toFixed(2)} MB · ${d.results} results · ${d.words} words` : '–';
  $('dError').textContent = d.lastError || '–';
}

function drawMeters() {
  drawDiag();
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
    swings: judge.swings(SWINGS).map(({ from, n, t, delta, signal, quote, driver, score }) => ({ from, n, t, delta, signal, quote, driver, score })),
    price: session.feed && {
      venue: session.feed.venue,
      symbol: session.feed.symbol,
      kind: session.feed.kind,
      ticks: session.prices.map((k) => ({ t: session.startedAt ? (k.seenAt - session.startedAt) / 1000 : null, price: k.price, live: k.live })),
    },
    paper: session.book && {
      trades: session.book.trades,
      position: session.book.position,
      events: session.paperEvents || [],
      pnl: session.book.pnl(session.lastTick?.price ?? null),
    },
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

// ---------- on open ----------
drawChecklist();
hint();
{
  const { announce } = await chrome.storage.session.get('announce');
  if (announce?.type === 'captureError' && Date.now() - announce.at < 15_000) showError(announce.error);
  await chrome.storage.session.remove('announce');
}
syncCapture();

// For tests and the export.
globalThis.panel = { timeline, session: () => session };
dirty();
