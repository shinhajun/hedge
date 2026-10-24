// Per-word judging. Every new word asks Jev about the transcript up to that word.
// - At most `maxInFlight` calls at once. When words arrive faster, older ones are skipped so the
//   newest word is always asked about next (its call marks every word since the previous call).
// - Results apply in the order their calls were made, never out of order.
// - When the speech-to-text revises a word, every result past it is withdrawn and the new
//   transcript is asked about again. Results are cached by transcript prefix, so a revision that
//   changes nothing in the end costs nothing.
// - Long sessions: past `windowWords`, Jev sees only the most recent words plus a short summary of
//   what came before (`earlier`), so a call never grows past a fixed size.
import { DRIVERS, signalWord } from './questions.js';
import { firstDifference } from './transcript.js';

export const ACTIVE_AT = 0.3; // |driver| from here on counts as active
const FIRED_AT = 0.5; // |driver| from here on is remembered (with its quote) for `earlier`
const AD_AT = 0.7;
const CACHE_LIMIT = 4000;
const COMPACT_FROM = 8000; // points
const SMOOTH = 0.5;
const MOVE_TURN = 0.04; // a move ends when the gauge turns back this far
const DRIVER_JUMP = 0.35; // a driver switching on by this much is a moment of its own
const DRIVER_WEIGHT = 0.6; // …ranked as if the gauge had moved this share of the jump (see DRIVERS' `weight`)

const SEED = 0x811c9dc5;
function step(h, s) {
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return Math.imul(h ^ 32, 0x01000193) >>> 0;
}

const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

export class Judge {
  // ask({ words, newFrom, earlier }) → { signal, confidence, drivers, ad, tokens }
  constructor({ ask, maxInFlight = 3, windowWords = 2000, onChange = () => {}, onError = () => {} }) {
    Object.assign(this, { ask, maxInFlight, windowWords, onChange, onError });
    this.words = [];
    this.hashes = [SEED];
    this.points = []; // applied results, oldest first
    this.queue = []; // calls in the order they were made
    this.nextN = 1; // smallest word count not yet asked about
    this.lastAsked = 0;
    this.cache = new Map();
    this.adSpans = []; // [from, to) word ranges Jev called an ad; left out of later calls
    this.fired = {}; // driver id -> { value, quote, n }
    this.stats = { calls: 0, tokens: 0, cached: 0, stale: 0, rejudges: 0, errors: 0, latencies: [] };
  }

  get last() {
    return this.points[this.points.length - 1];
  }

  get p50() {
    return median(this.stats.latencies);
  }

  // words: the transcript so far, [{ w, key, start, end }]. Call on every change.
  update(words) {
    const k = firstDifference(this.words, words);
    this.words = words;
    this.hashes.length = Math.min(this.hashes.length, k + 1);
    for (let i = this.hashes.length - 1; i < words.length; i++) this.hashes.push(step(this.hashes[i], words[i].key));
    if (this.last && this.last.n > k) {
      while (this.last && this.last.n > k) this.points.pop();
      this.adSpans = this.adSpans.filter((s) => s[1] <= k);
      for (const id in this.fired) if (this.fired[id].n > k) delete this.fired[id];
      this.stats.rejudges++;
      this.onChange({ revisedFrom: k });
    }
    this.nextN = Math.min(this.nextN, k + 1);
    this.lastAsked = Math.min(this.lastAsked, k);
    this.pump();
  }

  pump() {
    const n = this.words.length;
    let running = this.queue.filter((q) => !q.done).length;
    while (running < this.maxInFlight && this.nextN <= n) {
      // Not enough free calls for every new word: skip ahead so the newest one is included.
      this.nextN = Math.max(this.nextN, n - (this.maxInFlight - running) + 1, (this.last?.n ?? 0) + 1);
      if (this.nextN > n) break;
      if (this.dispatch(this.nextN++)) running++;
    }
    this.drain();
  }

  // Returns true when this made a Jev call (false when the answer was cached).
  dispatch(n) {
    const key = this.hashes[n];
    const entry = { n, key, done: false };
    this.queue.push(entry);
    const markFrom = this.lastAsked;
    this.lastAsked = n;
    const hit = this.cache.get(key);
    if (hit) {
      Object.assign(entry, { done: true, res: hit });
      this.stats.cached++;
      return false;
    }
    const t = performance.now();
    this.ask(this.request(n, markFrom))
      .then((res) => {
        const ms = performance.now() - t;
        this.stats.calls++;
        this.stats.tokens += res.tokens || 0;
        this.stats.latencies.push(ms);
        if (this.stats.latencies.length > 200) this.stats.latencies.shift();
        res.ms = ms;
        this.cache.set(key, res);
        if (this.cache.size > CACHE_LIMIT) this.cache.delete(this.cache.keys().next().value);
        Object.assign(entry, { done: true, res });
      })
      .catch((err) => {
        this.stats.errors++;
        Object.assign(entry, { done: true, err });
        this.onError(err);
      })
      .finally(() => this.pump());
    return true;
  }

  // Apply finished calls from the front of the queue, in the order they were made.
  drain() {
    while (this.queue.length && this.queue[0].done) {
      const { n, key, res } = this.queue.shift();
      if (!res) continue;
      if (this.hashes[n] !== key || n <= (this.last?.n ?? 0)) {
        this.stats.stale++;
        continue;
      }
      this.apply(n, res);
      this.onChange({ point: this.last });
    }
  }

  apply(n, res) {
    // The first reading is the baseline (mostly what the asset and context imply), not a move.
    const prev = this.last || { n: 0, raw: res.signal, signal: res.signal, drivers: res.drivers };
    const ad = res.ad >= AD_AT;
    if (ad) this.adSpans.push([prev.n, n]);
    // Single readings wobble from word to word (a sentence half-said can read either way). The gauge
    // shows the median of the last three readings, eased: a real move lands within ~3 words, a
    // one-word wobble barely shows. `raw` keeps Jev's own reading. An ad holds the previous reading.
    const recent = [res.signal, ...this.points.slice(-2).filter((p) => !p.ad).map((p) => p.raw)].sort((a, b) => a - b);
    const target = recent[Math.floor(recent.length / 2)];
    const signal = ad ? prev.signal : prev.signal + SMOOTH * (target - prev.signal);
    const drivers = {};
    for (const d of DRIVERS) {
      const was = prev.drivers[d.id] ?? 0;
      drivers[d.id] = ad ? was : was + SMOOTH * ((res.drivers[d.id] ?? was) - was);
    }
    const raw = ad ? prev.raw : res.signal;
    const point = {
      n,
      from: prev.n,
      t: this.words[n - 1].end,
      raw,
      rawDelta: raw - prev.raw,
      signal,
      delta: signal - prev.signal,
      confidence: res.confidence,
      drivers,
      ad,
      ms: res.ms ?? 0,
    };
    for (const d of DRIVERS) {
      const v = drivers[d.id];
      const before = this.fired[d.id];
      if (Math.abs(v) >= FIRED_AT && (!before || Math.sign(before.value) !== Math.sign(v))) {
        this.fired[d.id] = { value: v, quote: this.quote(prev.n, n), n };
      }
    }
    this.points.push(point);
    if (this.points.length > COMPACT_FROM) this.compact();
  }

  // Hours-long streams: thin out points far behind the window (keep every 8th and the big moves' peaks).
  compact() {
    const keepFrom = this.last.n - this.windowWords - 500;
    const peaks = new Set(this.swings(20).map((m) => m.peak));
    this.points = this.points.filter((p, i) => p.n >= keepFrom || peaks.has(p) || i % 8 === 0);
  }

  // The moments worth pinning, best first. Two kinds, merged:
  // - moves of the gauge between turning points (zigzag: wiggles under MOVE_TURN don't end a move), so a
  //   steady climb counts as one move however it wobbles;
  // - a driver switching on (or flipping sign) by at least DRIVER_JUMP, which catches news landing while
  //   the gauge is already pinned (NVIDIA's $11B outlook: guidance 0.17 → 0.87, gauge only +0.2).
  // A driver switch inside a move labels that move. Each moment is pinned and quoted at its steepest reading.
  swings(k = 5, min = 0.05) {
    const key = `${this.points.length}:${this.last?.n}`;
    if (this.moments?.key !== key) this.moments = { key, list: this.findMoments() };
    return this.moments.list.filter((m) => m.score >= min).slice(0, k);
  }

  findMoments() {
    const pts = this.points.filter((p) => !p.ad);
    const moves = [];
    let pivot = pts[0], ext = pts[0], dir = 0;
    const close = () => pivot !== ext && moves.push(this.moment(pivot, ext));
    for (const p of pts) {
      const up = p.signal - ext.signal;
      if (dir === 0) {
        if (Math.abs(p.signal - pivot.signal) >= MOVE_TURN) [dir, ext] = [Math.sign(p.signal - pivot.signal), p];
      } else if (Math.sign(up) === dir) ext = p;
      else if (Math.abs(up) >= MOVE_TURN) {
        close();
        [pivot, ext, dir] = [ext, p, -dir];
      }
    }
    if (dir) close();

    for (const d of DRIVERS) {
      let lastAt = -Infinity;
      for (let i = 1; i < pts.length; i++) {
        const v = pts[i].drivers[d.id] ?? 0, was = pts[i - 1].drivers[d.id] ?? 0;
        const on = Math.abs(v) >= ACTIVE_AT, wasOn = Math.abs(was) >= ACTIVE_AT;
        if (!on || (wasOn && Math.sign(v) === Math.sign(was)) || pts[i].n - lastAt < 60) continue;
        // How far the driver travelled: from its low before the switch to its high after (or the reverse).
        const s = Math.sign(v);
        const before = pts.slice(Math.max(0, i - 12), i).map((p) => p.drivers[d.id] ?? 0);
        const after = pts.slice(i, i + 40).map((p) => p.drivers[d.id] ?? 0);
        const jump = s > 0 ? Math.max(...after) - Math.min(...before) : Math.min(...after) - Math.max(...before);
        if (Math.abs(jump) < DRIVER_JUMP) continue;
        lastAt = pts[i].n;
        const steep = pts.slice(Math.max(1, i - 12), i + 30).reduce((a, p, j, arr) => {
          const prev = j ? arr[j - 1] : pts[Math.max(0, i - 13)];
          const dv = ((p.drivers[d.id] ?? 0) - (prev.drivers[d.id] ?? 0)) * s;
          return dv > a.dv ? { p, dv } : a;
        }, { p: pts[i], dv: -Infinity }).p;
        const flip = { id: d.id, label: d.label, word: d.words[s > 0 ? 1 : 0], jump, n: steep.n };
        const score = (d.weight ?? DRIVER_WEIGHT) * Math.abs(jump);
        // Bullish news labels a rising move (and bearish a falling one); otherwise it stands alone, measured
        // by how far the gauge followed it.
        const home = moves.find((m) => steep.n > m.from && steep.n <= m.n && Math.sign(m.delta) === s);
        if (home) {
          if (!home.driver || Math.abs(jump) > Math.abs(home.driver.jump)) home.driver = flip;
          home.score = Math.max(home.score, score);
        } else {
          const follow = pts.slice(i, i + 40).reduce((a, p) => (p.signal * s > a.signal * s ? p : a), pts[i]);
          moves.push({ ...this.moment(pts[i - 1], follow, steep), driver: flip, score });
        }
      }
    }
    return moves.sort((a, b) => b.score - a.score);
  }

  // A moment from point `a` to point `b`, pinned at its steepest reading (or at `at`).
  moment(a, b, at) {
    const dir = Math.sign(b.signal - a.signal) || 1;
    let peak = at;
    if (!peak) {
      peak = b;
      for (const p of this.points) if (p.n > a.n && p.n <= b.n && !p.ad && p.delta * dir > peak.delta * dir) peak = p;
    }
    const delta = b.signal - a.signal;
    return { from: a.n, n: b.n, delta, score: Math.abs(delta), t: peak.t, signal: peak.signal, peak, driver: null, quote: this.quote(peak.from - 1, peak.n, 8) };
  }

  // The words of a span with a little lead-in, for markers and `earlier`.
  quote(from, to, lead = 4) {
    const start = Math.max(0, Math.min(from, to - 1) - lead);
    const text = this.words.slice(start, to).slice(-14).map((w) => w.w).join(' ');
    return (start > 0 ? '…' : '') + text;
  }

  request(n, markFrom) {
    const start = Math.max(0, n - this.windowWords);
    const keep = (i) => !this.adSpans.some(([a, b]) => i >= a && i < b && i < markFrom);
    const words = [];
    let newFrom = 0;
    for (let i = start; i < n; i++) {
      if (!keep(i)) continue;
      if (i < markFrom) newFrom = words.length + 1;
      words.push(this.words[i]);
    }
    return { words, newFrom, earlier: start > 0 ? this.earlier(start) : null };
  }

  // What Jev should know about the speech before the window: the reading then and what fired, with quotes.
  earlier(start) {
    let p = null;
    for (let i = this.points.length - 1; i >= 0; i--) if (this.points[i].n <= start) { p = this.points[i]; break; }
    const fired = DRIVERS.filter((d) => this.fired[d.id]?.n <= start).map((d) => {
      const f = this.fired[d.id];
      return `${d.label}: ${d.words[f.value > 0 ? 1 : 0] || 'present'} ("${f.quote}")`;
    });
    return {
      words_before_transcript: start,
      signal_then: p ? `${signalWord(p.signal)} (${p.signal.toFixed(2)})` : 'unknown',
      drivers_seen: fired.length ? fired : 'none',
    };
  }
}
