// Real-content check without a browser: streams test clips through the extension's own pipeline
// (DeepgramStream → Transcript → Judge → Jev) and writes a timeline per clip to .e2e/.
// Usage: node scripts/harness.js [--speed 1] [--only <clip id>] [--seconds N] [--drop-at S] [--tag name]
//   --speed    send audio this many times faster than real time. Keep 1: Deepgram live dropped about half
//              the words at 2.5x (223 vs 452 on the Fink clip).
//   --drop-at  closes the Deepgram socket once at S seconds of audio, to check the reconnect path
// Needs TYPESAFE_API_KEY and DEEPGRAM_API_KEY in .env (never printed) and clips in .e2e/audio.
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DEEPGRAM_USD_PER_MIN, SAMPLE_RATE } from '../extension/deepgram.js';
import { callJev, costOf } from '../extension/jev.js';
import { Judge } from '../extension/judge.js';
import { buildState, QUESTIONS, readAnswers } from '../extension/questions.js';
import { DeepgramStream } from '../extension/stream.js';
import { Transcript } from '../extension/transcript.js';
import { CLIPS, envKey, pcmPath, root } from './audio.js';

const { values: opt } = parseArgs({
  options: { speed: { type: 'string', default: '1' }, only: { type: 'string' }, seconds: { type: 'string' }, 'drop-at': { type: 'string' }, tag: { type: 'string', default: '' } },
});
const speed = Number(opt.speed);
const jevKey = envKey('TYPESAFE_API_KEY');
const dgKey = envKey('DEEPGRAM_API_KEY');
const CHUNK = SAMPLE_RATE / 10; // 100 ms
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function rms(pcm) {
  let e = 0;
  for (const s of pcm) e += (s / 0x7fff) ** 2;
  return Math.sqrt(e / pcm.length);
}

async function run(clip) {
  const pcm = new Int16Array(fs.readFileSync(pcmPath(clip.id)).buffer.slice(0));
  const from = Math.floor(clip.from * SAMPLE_RATE);
  const to = Math.min(pcm.length, opt.seconds ? from + Number(opt.seconds) * SAMPLE_RATE : pcm.length);
  const transcript = new Transcript('interim');
  const judge = new Judge({
    maxInFlight: 3,
    windowWords: 2000,
    ask: async ({ words, newFrom, earlier }) => {
      const res = await callJev(jevKey, { state: buildState({ words, newFrom, asset: clip.asset, context: clip.context, earlier }), questions: QUESTIONS });
      return { ...readAnswers(res.answers), tokens: res.usage.input_tokens };
    },
    onError: (err) => console.error(`[${clip.id}] Jev: ${err.message}`),
  });
  const states = [];
  const stream = new DeepgramStream(dgKey, {
    onResult: (msg) => judge.update(transcript.apply(msg)),
    onStatus: (state, detail) => {
      states.push(state);
      if (detail) console.error(`[${clip.id}] ${state}: ${detail}`);
    },
  });
  stream.connect();
  while (stream.ws.readyState !== 1) await sleep(20);

  const t0 = performance.now();
  const dropAt = opt['drop-at'] ? Number(opt['drop-at']) : null;
  let dropped = false;
  for (let off = from, i = 0; off < to; off += CHUNK, i++) {
    const wait = t0 + (i * 100) / speed - performance.now();
    if (wait > 0) await sleep(wait);
    const chunk = pcm.slice(off, Math.min(to, off + CHUNK));
    stream.push(chunk, rms(chunk));
    if (dropAt != null && !dropped && (off - from) / SAMPLE_RATE >= dropAt) {
      dropped = true;
      stream.ws.close(); // as if the network dropped
    }
  }
  // Let Deepgram finish, then flush the last interim words by closing the stream.
  await sleep(2500);
  stream.close();
  await sleep(1500);
  for (let i = 0; i < 300 && judge.queue.length; i++) await sleep(50);

  const words = transcript.all();
  let overlaps = 0;
  for (let i = 1; i < transcript.final.length; i++) if (transcript.final[i].start < transcript.final[i - 1].start - 0.01) overlaps++;
  const pts = judge.points;
  const tail = pts.slice(Math.floor(pts.length * 0.7));
  const audioSeconds = stream.sentSamples / SAMPLE_RATE;
  const summary = {
    clip: clip.id,
    name: clip.name,
    asset: clip.asset,
    known: clip.known,
    seconds: (to - from) / SAMPLE_RATE,
    words: words.length,
    finalSignal: pts.at(-1)?.signal ?? 0,
    lateMeanSignal: tail.reduce((s, p) => s + p.signal, 0) / (tail.length || 1),
    minSignal: Math.min(...pts.map((p) => p.signal)),
    maxSignal: Math.max(...pts.map((p) => p.signal)),
    jevCalls: judge.stats.calls,
    jevTokens: judge.stats.tokens,
    jevCostUsd: costOf(judge.stats.tokens),
    jevP50Ms: judge.p50,
    rejudges: judge.stats.rejudges,
    stale: judge.stats.stale,
    errors: judge.stats.errors,
    audioSeconds,
    deepgramCostUsd: (audioSeconds / 60) * DEEPGRAM_USD_PER_MIN,
    reconnects: stream.reconnects,
    outOfOrderFinalWords: overlaps,
    speed,
  };
  const out = {
    summary,
    swings: judge.swings(5).map(({ from, n, t, delta, signal, quote }) => ({ from, n, t, delta, signal, quote })),
    points: pts.map(({ n, from, t, raw, signal, delta, confidence, drivers, ad, ms }) => ({ n, from, t, raw, signal, delta, confidence, drivers, ad, ms })),
    words: words.map(({ w, start, end, final }) => ({ w, start, end, final })),
  };
  fs.writeFileSync(path.join(root, '.e2e', `timeline-${clip.id}${opt.tag ? `-${opt.tag}` : ''}.json`), JSON.stringify(out, null, 1));
  return out;
}

const clips = CLIPS.filter((c) => (!opt.only || c.id === opt.only) && fs.existsSync(pcmPath(c.id)));
const results = await Promise.all(clips.map(run));
for (const { summary: s, swings } of results) {
  const call = s.lateMeanSignal > 0.1 ? 'bullish' : s.lateMeanSignal < -0.1 ? 'bearish' : 'neutral';
  console.log(`\n${s.name} (${s.asset}), ${Math.round(s.seconds)} s of audio at ${s.speed}x, ${s.words} words`);
  console.log(`  ${process.env.npm_package_name || 'pipeline'} says ${call}: final ${s.finalSignal.toFixed(2)}, late mean ${s.lateMeanSignal.toFixed(2)}, range ${s.minSignal.toFixed(2)}..${s.maxSignal.toFixed(2)}`);
  console.log(`  market: ${s.known}`);
  console.log(`  Jev ${s.jevCalls} calls, ${s.jevTokens} tokens ($${s.jevCostUsd.toFixed(4)}), p50 ${Math.round(s.jevP50Ms)} ms, re-judges ${s.rejudges}, stale ${s.stale}, errors ${s.errors}`);
  console.log(`  Deepgram ${s.audioSeconds.toFixed(0)} s billed ($${s.deepgramCostUsd.toFixed(4)}), reconnects ${s.reconnects}, out-of-order final words ${s.outOfOrderFinalWords}`);
  for (const w of swings) console.log(`    ${w.delta >= 0 ? '+' : '−'}${Math.abs(w.delta).toFixed(2)} at ${Math.floor(w.t / 60)}:${String(Math.floor(w.t % 60)).padStart(2, '0')}  “${w.quote}”`);
}
