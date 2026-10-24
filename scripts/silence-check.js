// Live check of the quiet path: 10 s of speech, 20 s of silence, 10 s of speech, at real-time pace.
// Expect: the stream pauses (KeepAlive instead of audio, so silence isn't billed), Deepgram keeps the
// socket open (it closes after ~10 s without data otherwise), and speech after the gap is transcribed.
// Usage: node scripts/silence-check.js
import fs from 'node:fs';
import { SAMPLE_RATE } from '../extension/deepgram.js';
import { DeepgramStream } from '../extension/stream.js';
import { CLIPS, envKey, pcmPath } from './audio.js';

const clip = CLIPS[0];
const pcm = new Int16Array(fs.readFileSync(pcmPath(clip.id)).buffer.slice(0));
const speech = (from, secs) => pcm.slice(from * SAMPLE_RATE, (from + secs) * SAMPLE_RATE);
const audio = [speech(20, 10), new Int16Array(20 * SAMPLE_RATE), speech(40, 10)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const states = [];
const finals = [];
const stream = new DeepgramStream(envKey('DEEPGRAM_API_KEY'), {
  onStatus: (s) => states.at(-1)?.s !== s && states.push({ s, at: Math.round(stream.samples / SAMPLE_RATE) }),
  onResult: (m) => m.is_final && finals.push(...m.channel.alternatives[0].words),
});
stream.connect();
while (stream.ws.readyState !== 1) await sleep(20);
const t0 = performance.now();
let i = 0;
for (const part of audio) {
  for (let off = 0; off < part.length; off += SAMPLE_RATE / 10, i++) {
    const wait = t0 + i * 100 - performance.now();
    if (wait > 0) await sleep(wait);
    const chunk = part.slice(off, off + SAMPLE_RATE / 10);
    let e = 0;
    for (const s of chunk) e += (s / 0x7fff) ** 2;
    stream.push(chunk, Math.sqrt(e / chunk.length));
  }
}
await sleep(3000);
stream.close();
const after = finals.filter((w) => w.start >= 30);
console.log('states:', states.map((x) => `${x.s}@${x.at}s`).join(' → '));
console.log(`audio captured ${stream.samples / SAMPLE_RATE}s, sent (billed) ${(stream.sentSamples / SAMPLE_RATE).toFixed(1)}s, reconnects ${stream.reconnects}`);
console.log(`final words before the gap ${finals.length - after.length}, after it ${after.length} (first: "${after.slice(0, 6).map((w) => w.word).join(' ')}" at ${after[0]?.start.toFixed(1)}s)`);
const ok = stream.reconnects === 0 && after.length > 10 && stream.sentSamples / SAMPLE_RATE < 25 && states.some((x) => x.s === 'paused');
console.log(ok ? 'PASS' : 'FAIL');
process.exitCode = ok ? 0 : 1;
