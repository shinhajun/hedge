import { applyBrand } from './brand.js';
import { DEEPGRAM_USD_PER_MIN, openDeepgram } from './deepgram.js';
import { callJev, costOf, formatUsd, USD_PER_INPUT_TOKEN } from './jev.js';
import { ENTER, EXIT } from './paper.js';
import { QUESTIONS } from './questions.js';

applyBrand();
const $ = (id) => document.getElementById(id);

function show(id, state, text) {
  $(id).dataset.state = state;
  $(id).textContent = text;
}

for (const b of document.querySelectorAll('[data-reveal]')) {
  b.onclick = () => {
    const input = $(b.dataset.reveal);
    const hidden = input.type === 'password';
    input.type = hidden ? 'text' : 'password';
    b.textContent = hidden ? 'Hide' : 'Show';
  };
}
for (const b of document.querySelectorAll('[data-clear]')) {
  b.onclick = async () => {
    await chrome.storage.local.remove(b.dataset.clear);
    $(b.dataset.clear).value = '';
    show(b.dataset.clear === 'apiKey' ? 'jevResult' : 'dgResult', '', 'Removed.');
  };
}

$('jevForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const apiKey = $('apiKey').value.trim();
  if (!apiKey) return show('jevResult', 'error', 'Paste a key first.');
  show('jevResult', '', 'Asking Jev…');
  const t = performance.now();
  try {
    const res = await callJev(apiKey, {
      state: { asset: 'NVDA', transcript: 'We now expect revenue to be about eleven billion dollars, well ahead of ⟦what we guided last quarter.⟧' },
      questions: { signal: QUESTIONS.signal },
    }, { retries: 1 });
    await chrome.storage.local.set({ apiKey });
    show('jevResult', 'ok', `Saved. Jev (${res.model}) answered in ${Math.round(performance.now() - t)} ms.`);
  } catch (err) {
    show('jevResult', 'error', err.status === 401 ? 'Jev rejected this key. Check that you copied all of it.' : `Couldn’t reach Jev (${err.status || 'network'}). The key was not saved.`);
  }
});

// A key is good if Deepgram accepts a live connection with it.
function testDeepgram(key) {
  return new Promise((resolve) => {
    const ws = openDeepgram(key);
    const done = (ok) => {
      clearTimeout(timer);
      ws.onopen = ws.onclose = ws.onerror = null;
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'CloseStream' }));
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), 8000);
    ws.onopen = () => done(true);
    ws.onclose = ws.onerror = () => done(false);
  });
}

$('dgForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const deepgramKey = $('deepgramKey').value.trim();
  if (!deepgramKey) return show('dgResult', 'error', 'Paste a key first.');
  show('dgResult', '', 'Connecting to Deepgram…');
  if (await testDeepgram(deepgramKey)) {
    await chrome.storage.local.set({ deepgramKey });
    show('dgResult', 'ok', 'Saved. Deepgram accepted the key.');
  } else {
    show('dgResult', 'error', 'Deepgram refused this key (or couldn’t be reached). The key was not saved.');
  }
});

// ---- paper trade thresholds ----
function showThresholds({ enter = ENTER, exit = EXIT } = {}) {
  $('enterAt').value = enter;
  $('exitAt').value = exit;
}
$('paperForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const enter = Number($('enterAt').value), exit = Number($('exitAt').value);
  if (!(enter > 0 && enter < 1 && exit >= 0 && exit < enter)) return show('paperResult', 'error', 'Entry must be between 0 and 1, and exit closer to zero than entry.');
  await chrome.storage.local.set({ paperThresholds: { enter, exit } });
  show('paperResult', 'ok', `Saved. Long at +${enter}, flat under +${exit}; short at −${enter}, flat over −${exit}.`);
});
$('paperReset').onclick = async () => {
  await chrome.storage.local.remove('paperThresholds');
  showThresholds();
  show('paperResult', 'ok', `Back to the defaults: ±${ENTER} to enter, ±${EXIT} to exit.`);
};

function showUsage(u = { jevCalls: 0, jevTokens: 0, audioSeconds: 0, since: Date.now() }) {
  $('uCost').textContent = formatUsd(costOf(u.jevTokens) + (u.audioSeconds / 60) * DEEPGRAM_USD_PER_MIN);
  $('uCalls').textContent = u.jevCalls.toLocaleString('en-US');
  $('uTokens').textContent = u.jevTokens.toLocaleString('en-US');
  $('uAudio').textContent = `${Math.round(u.audioSeconds / 60).toLocaleString('en-US')} min`;
  $('since').textContent = new Date(u.since).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
}
$('jevPrice').textContent = `$${+(USD_PER_INPUT_TOKEN * 1e6).toFixed(4)}`;
$('dgPrice').textContent = `$${+DEEPGRAM_USD_PER_MIN.toFixed(4)}`;
$('reset').onclick = async () => {
  const usageTotal = { jevCalls: 0, jevTokens: 0, audioSeconds: 0, since: Date.now() };
  await chrome.storage.local.set({ usageTotal });
  showUsage(usageTotal);
};
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.usageTotal) showUsage(changes.usageTotal.newValue);
});

const { apiKey, deepgramKey, usageTotal, paperThresholds } = await chrome.storage.local.get(['apiKey', 'deepgramKey', 'usageTotal', 'paperThresholds']);
showUsage(usageTotal);
showThresholds(paperThresholds);
if (apiKey) {
  $('apiKey').value = apiKey;
  show('jevResult', '', 'A key is saved.');
}
if (deepgramKey) {
  $('deepgramKey').value = deepgramKey;
  show('dgResult', '', 'A key is saved.');
}
