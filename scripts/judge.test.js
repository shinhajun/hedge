// Unit tests for the per-word scheduler and the transcript model (no network).
// Usage: npm test
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Judge } from '../extension/judge.js';
import { Transcript } from '../extension/transcript.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const words = (text) => text.split(' ').map((w, i) => ({ w, key: w.toLowerCase(), start: i * 0.4, end: i * 0.4 + 0.3 }));

// A fake Jev: the signal is the share of "good" words, answered after a random delay.
function fakeJev({ minMs = 5, maxMs = 60 } = {}) {
  const calls = [];
  let running = 0, maxRunning = 0;
  const ask = async (req) => {
    running++;
    maxRunning = Math.max(maxRunning, running);
    calls.push(req);
    await sleep(minMs + Math.random() * (maxMs - minMs));
    running--;
    const good = req.words.filter((w) => w.key === 'good').length;
    return { signal: good / req.words.length, confidence: 0.9, drivers: {}, ad: 0, tokens: 100 + req.words.length };
  };
  return { ask, calls, max: () => maxRunning };
}

async function settle(judge) {
  for (let i = 0; i < 200 && judge.queue.length; i++) await sleep(10);
}

test('applies results in order, never more than maxInFlight at once', async () => {
  const jev = fakeJev();
  const applied = [];
  const judge = new Judge({ ask: jev.ask, maxInFlight: 3, onChange: ({ point }) => point && applied.push(point.n) });
  const all = words('the good news is that demand was good and margins were good too so we raise');
  for (let n = 1; n <= all.length; n++) {
    judge.update(all.slice(0, n));
    await sleep(8);
  }
  await settle(judge);
  assert.ok(jev.max() <= 3, `ran ${jev.max()} at once`);
  for (let i = 1; i < judge.points.length; i++) assert.ok(judge.points[i].n > judge.points[i - 1].n, 'points out of order');
  assert.equal(judge.last.n, all.length, 'the newest word was judged');
  assert.ok(Math.abs(judge.points.reduce((s, p) => s + p.delta, 0) - (judge.last.signal - judge.points[0].signal)) < 1e-9, 'deltas add up to the move from the first reading');
});

test('coalesces a burst to the newest words', async () => {
  const jev = fakeJev({ minMs: 40, maxMs: 50 });
  const judge = new Judge({ ask: jev.ask, maxInFlight: 2 });
  const all = words('one two three four five six seven eight nine ten');
  judge.update(all); // ten words at once
  await settle(judge);
  assert.deepEqual(jev.calls.map((c) => c.words.length), [9, 10], 'only the two newest prefixes are asked');
  assert.equal(judge.last.n, 10);
  assert.equal(judge.points[0].from, 0, 'the first call carries the whole burst');
});

test('a revision withdraws later results and re-judges the corrected text', async () => {
  const jev = fakeJev();
  const judge = new Judge({ ask: jev.ask, maxInFlight: 3 });
  judge.update(words('margins were good'));
  await settle(judge);
  assert.equal(judge.last.n, 3);
  const before = judge.points.length;
  judge.update(words('margins were bad'));
  assert.ok(judge.points.every((p) => p.n <= 2), 'results past the revised word are gone');
  await settle(judge);
  assert.equal(judge.last.n, 3);
  assert.equal(judge.last.signal, 0, 'judged from the corrected transcript');
  assert.equal(judge.stats.rejudges, 1);
  assert.ok(judge.points.length <= before);
});

test('marks only the words added since the previous call', async () => {
  const jev = fakeJev({ minMs: 1, maxMs: 2 });
  const judge = new Judge({ ask: jev.ask, maxInFlight: 1 });
  judge.update(words('a b c'));
  await settle(judge);
  judge.update(words('a b c d e'));
  await settle(judge);
  const last = jev.calls.at(-1);
  assert.equal(last.words.length, 5);
  assert.equal(last.newFrom, 3);
});

test('past the window, a call sees the recent words and a summary of what came before', async () => {
  const jev = fakeJev({ minMs: 1, maxMs: 2 });
  const judge = new Judge({ ask: jev.ask, maxInFlight: 1, windowWords: 20 });
  const all = words(Array.from({ length: 60 }, (_, i) => (i % 3 ? 'word' : 'good')).join(' '));
  for (let n = 5; n <= 60; n += 5) {
    judge.update(all.slice(0, n));
    await settle(judge);
  }
  const last = jev.calls.at(-1);
  assert.equal(last.words.length, 20);
  assert.equal(last.earlier.words_before_transcript, 40);
  assert.match(last.earlier.signal_then, /\(/);
});

test('an ad holds the gauge and drops out of later calls', async () => {
  const calls = [];
  const judge = new Judge({
    maxInFlight: 1,
    ask: async (req) => {
      calls.push(req);
      const ad = req.words.slice(req.newFrom).some((w) => w.key === 'sponsored');
      return { signal: ad ? -0.9 : 0.4, confidence: 1, drivers: {}, ad: ad ? 0.95 : 0.01, tokens: 1 };
    },
  });
  judge.update(words('strong quarter'));
  await settle(judge);
  judge.update(words('strong quarter sponsored message'));
  await settle(judge);
  assert.equal(judge.last.signal, 0.4, 'the ad did not move the gauge');
  assert.ok(judge.last.ad);
  judge.update(words('strong quarter sponsored message back to demand'));
  await settle(judge);
  assert.ok(!calls.at(-1).words.some((w) => w.key === 'sponsored'), 'ad words are left out');
});

test('transcript: interim words are replaced, final words stay', () => {
  const t = new Transcript('interim');
  const res = (words, isFinal) => ({ type: 'Results', is_final: isFinal, channel: { alternatives: [{ words: words.map(([word, start]) => ({ word, punctuated_word: word, start, end: start + 0.3 })) }] } });
  t.apply(res([['we', 0], ['now', 0.4]], false));
  t.apply(res([['we', 0], ['now', 0.4], ['expect', 0.8]], false));
  assert.deepEqual(t.all().map((w) => w.key), ['we', 'now', 'expect']);
  t.apply(res([['we', 0], ['now', 0.4], ['expected', 0.8]], true));
  t.apply(res([['revenue', 1.2]], false));
  assert.deepEqual(t.all().map((w) => w.key), ['we', 'now', 'expected', 'revenue']);
  assert.deepEqual(t.final.map((w) => w.key), ['we', 'now', 'expected']);
  const settled = new Transcript('settled');
  settled.apply(res([['a', 0], ['b', 0.4]], false));
  assert.deepEqual(settled.judgeable().map((w) => w.key), ['a']);
});
