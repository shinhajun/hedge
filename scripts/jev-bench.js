// Jev latency and input tokens per call at transcript lengths of ~100, 1k, 2k, 5k and 10k words, using
// the real question set and real call speech, plus the estimated Jev cost of a 60-minute call.
// Usage: node scripts/jev-bench.js [calls per length, default 8]
// Needs TYPESAFE_API_KEY in .env (never printed) and .e2e/audio/g8toIbd_Tf4.prerecorded.json, a Deepgram
// prerecorded transcript of the NVIDIA call (see scripts/audio.js).
import fs from 'node:fs';
import path from 'node:path';
import { callJev, costOf } from '../extension/jev.js';
import { buildState, QUESTIONS, readAnswers } from '../extension/questions.js';
import { envKey, root } from './audio.js';

const perLength = Number(process.argv[2] || 8);
const apiKey = envKey('TYPESAFE_API_KEY');
const LENGTHS = [100, 1000, 2000, 5000, 10000];
const WORDS_PER_MIN = 150; // measured: 140-160 on the test clips
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1))];

const dg = JSON.parse(fs.readFileSync(path.join(root, '.e2e/audio/g8toIbd_Tf4.prerecorded.json'), 'utf8'));
const source = dg.results.channels[0].alternatives[0].words.map((x) => ({ w: x.punctuated_word }));
const speech = (n) => Array.from({ length: n }, (_, i) => source[i % source.length]);

const rows = [];
for (const n of LENGTHS) {
  const words = speech(n);
  const lat = [];
  let tokens = 0;
  let sample;
  // Three at a time, like the extension.
  for (let i = 0; i < perLength; i += 3) {
    await Promise.all(Array.from({ length: Math.min(3, perLength - i) }, async (_, j) => {
      const cut = n - (i + j); // a slightly different prefix each call, so nothing is cached server-side
      const state = buildState({ words: words.slice(0, cut), newFrom: cut - 3, asset: 'NVDA', context: 'NVIDIA Q1 FY2024 earnings call; CFO speaking' });
      const t = performance.now();
      const res = await callJev(apiKey, { state, questions: QUESTIONS });
      lat.push(performance.now() - t);
      tokens = res.usage.input_tokens;
      sample = readAnswers(res.answers);
    }));
  }
  const row = { words: n, p50: pct(lat, 50), p95: pct(lat, 95), tokens };
  rows.push(row);
  console.log(`${String(n).padStart(6)} words  p50 ${row.p50.toFixed(0).padStart(5)} ms  p95 ${row.p95.toFixed(0).padStart(5)} ms  ${String(tokens).padStart(6)} input tokens  ${costOf(tokens).toExponential(2)} $/call  signal ${sample.signal.toFixed(2)}`);
}

// tokens(n) ≈ a + b·n, fitted on the measured rows.
const xs = rows.map((r) => r.words), ys = rows.map((r) => r.tokens);
const mx = xs.reduce((a, b) => a + b) / xs.length, my = ys.reduce((a, b) => a + b) / ys.length;
const b = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0) / xs.reduce((s, x) => s + (x - mx) ** 2, 0);
const a = my - b * mx;
console.log(`\ntokens per call ≈ ${a.toFixed(0)} + ${b.toFixed(3)} × words`);

// One call per word for 60 minutes; with a window, a call never sees more than `win` words.
const total = WORDS_PER_MIN * 60;
for (const win of [Infinity, 5000, 2000, 1000]) {
  let tok = 0;
  for (let n = 1; n <= total; n++) tok += a + b * Math.min(n, win);
  console.log(`60-min call, ${total} words, window ${win === Infinity ? 'none' : win}: ${(tok / 1e6).toFixed(1)}M tokens = $${costOf(tok).toFixed(2)}`);
}
fs.writeFileSync(path.join(root, '.e2e', 'jev-bench.json'), JSON.stringify({ rows, fit: { a, b } }, null, 2));
