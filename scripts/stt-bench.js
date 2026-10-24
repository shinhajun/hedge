// Deepgram Nova-3 live bench: streams real speech at real-time pace and measures
//   - speech→word latency: when a word's audio ends until it first arrives (and until it is final)
//   - how often interim results arrive
//   - revision rate per judging policy (see extension/transcript.js)
//   - cost per hour
// Usage: node scripts/stt-bench.js [seconds per clip, default 120] [--only <clip id>] [--keyterms]
//   --keyterms  turn on keyterm prompting (extension/deepgram.js keytermsFor) and count the key terms heard
// Needs DEEPGRAM_API_KEY in .env (never printed) and 16 kHz PCM clips in .e2e/audio (see scripts/audio.js).
import fs from 'node:fs';
import path from 'node:path';
import { CLOSE_STREAM, DEEPGRAM_USD_PER_MIN, keytermsFor, openDeepgram, SAMPLE_RATE } from '../extension/deepgram.js';
import { POLICIES, Transcript } from '../extension/transcript.js';
import { CLIPS, envKey, pcmPath, root } from './audio.js';

const args = process.argv.slice(2);
const seconds = Number(args.find((a) => /^\d+$/.test(a)) || 120);
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;
const useKeyterms = args.includes('--keyterms');
const apiKey = envKey('DEEPGRAM_API_KEY');
const CHUNK_MS = 100;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (xs, p) => {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
};

// Streams one clip; returns every message with its arrival time (seconds since the first audio byte).
async function stream(clip) {
  const pcm = fs.readFileSync(pcmPath(clip.id));
  const bytesPerChunk = (SAMPLE_RATE * 2 * CHUNK_MS) / 1000;
  const from = Math.floor(clip.from * SAMPLE_RATE) * 2;
  const to = Math.min(pcm.length, from + seconds * SAMPLE_RATE * 2);
  const ws = openDeepgram(apiKey, useKeyterms ? { keyterms: keytermsFor(clip.asset, clip.context) } : {});
  ws.binaryType = 'arraybuffer';
  const messages = [];
  let t0;
  const closed = new Promise((resolve, reject) => {
    ws.onclose = resolve;
    ws.onerror = (e) => reject(new Error(`Deepgram socket error: ${e.message || e.type}`));
  });
  ws.onmessage = (e) => messages.push({ at: (performance.now() - t0) / 1000, msg: JSON.parse(e.data) });
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = () => reject(new Error('Deepgram connection failed'));
  });
  t0 = performance.now();
  for (let off = from, i = 0; off < to; off += bytesPerChunk, i++) {
    const wait = t0 + i * CHUNK_MS - performance.now();
    if (wait > 0) await sleep(wait);
    ws.send(pcm.subarray(off, Math.min(to, off + bytesPerChunk)));
  }
  ws.send(CLOSE_STREAM);
  await closed;
  return messages;
}

function analyze(messages) {
  const results = messages.filter((m) => m.msg.type === 'Results');
  // Ground truth: the final words, timed by Deepgram's own word timestamps (audio time = wall time here).
  const finals = new Transcript('final');
  for (const { msg } of results) finals.apply(msg);
  const truth = finals.final;

  // When each true word first appeared under each policy, and how many shown words were later changed.
  const out = {};
  for (const policy of POLICIES) {
    const t = new Transcript(policy);
    const seenAt = new Array(truth.length).fill(null);
    const shown = new Map(); // index -> set of keys shown at that index
    let rejudges = 0;
    let prev = [];
    for (const { at, msg } of results) {
      const words = t.apply(msg);
      let k = 0;
      while (k < prev.length && k < words.length && prev[k].key === words[k].key) k++;
      if (k < prev.length) rejudges++; // a word already judged was revised or withdrawn
      words.forEach((w, i) => {
        (shown.get(i) || shown.set(i, new Set()).get(i)).add(w.key);
        if (i < truth.length && w.key === truth[i].key && Math.abs(w.start - truth[i].start) < 0.3 && seenAt[i] === null) seenAt[i] = at;
      });
      prev = words;
    }
    const lat = seenAt.map((at, i) => (at === null ? null : at - truth[i].end)).filter((x) => x !== null);
    let wrong = 0;
    for (const [i, keys] of shown) for (const key of keys) if (truth[i]?.key !== key) wrong++;
    out[policy] = { p50: pct(lat, 50), p95: pct(lat, 95), revised: wrong / truth.length, rejudgesPerMin: rejudges / (seconds / 60) };
  }
  const gaps = results.slice(1).map((m, i) => m.at - results[i].at);
  const text = truth.map((w) => w.w).join(' ');
  return { words: truth.length, results: results.length, perSec: results.length / seconds, gapP50: pct(gaps, 50), policies: out, text };
}

console.log(`Deepgram nova-3 live, ${seconds}s per clip at real-time pace, ${CHUNK_MS} ms chunks\n`);
const clips = CLIPS.filter((c) => fs.existsSync(pcmPath(c.id)) && (!only || c.id === only));
const runs = await Promise.all(clips.map(async (clip) => ({ clip, ...analyze(await stream(clip)) })));
const rows = [];
for (const r of runs) {
  console.log(`${r.clip.name}: ${r.words} words, ${r.results} results (${r.perSec.toFixed(1)}/s, gap p50 ${(r.gapP50 * 1000).toFixed(0)} ms)`);
  for (const p of POLICIES) {
    const m = r.policies[p];
    console.log(`  ${p.padEnd(8)} latency p50 ${(m.p50 * 1000).toFixed(0).padStart(5)} ms  p95 ${(m.p95 * 1000).toFixed(0).padStart(5)} ms  revised ${(m.revised * 100).toFixed(1).padStart(5)}%  re-judges ${m.rejudgesPerMin.toFixed(1)}/min`);
    rows.push({ clip: r.clip.id, policy: p, ...m });
  }
}
// How often each key term (and a known mishearing) shows up in the final transcript.
for (const r of runs) {
  const terms = [...keytermsFor(r.clip.asset, r.clip.context), 'Christ'];
  const counts = Object.fromEntries(terms.map((t) => [t, (r.text.match(new RegExp(`\\b${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi')) || []).length]).filter(([, n]) => n));
  console.log(`${r.clip.name} key terms heard${useKeyterms ? ' (keyterms on)' : ''}: ${JSON.stringify(counts)}`);
}
console.log(`\ncost: $${(DEEPGRAM_USD_PER_MIN * 60).toFixed(2)}/hour (nova-3 streaming pay-as-you-go, promo; list $0.46/hour)`);
fs.writeFileSync(path.join(root, '.e2e', `stt-bench${only ? `-${only}` : ''}${useKeyterms ? '-keyterms' : ''}.json`), JSON.stringify({ seconds, runs: runs.map(({ clip, ...r }) => ({ clip: clip.id, ...r })) }, null, 2));
