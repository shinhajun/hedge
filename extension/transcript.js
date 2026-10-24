// Turns Deepgram live results into one running word list.
// Final words never change. Every interim result replaces the interim tail after them, so words in
// the tail can be revised until Deepgram marks them final.

// Which words are steady enough to judge:
//   'interim' every word as soon as it appears
//   'settled' every final word, plus interim words that are not the newest one (the newest is
//             the one Deepgram revises most)
//   'final'   final words only
export const POLICIES = ['interim', 'settled', 'final'];

const norm = (s) => s.toLowerCase().replace(/[^\p{L}\p{N}%$.']/gu, '').replace(/\.$/, '');

export class Transcript {
  constructor(policy = 'settled') {
    this.policy = policy;
    this.final = [];
    this.interim = [];
  }

  // Applies one Deepgram `Results` message. Returns the words that are steady enough to judge.
  apply(msg) {
    if (msg.type !== 'Results') return this.judgeable();
    const words = (msg.channel?.alternatives?.[0]?.words || []).map((w) => ({
      w: w.punctuated_word || w.word,
      key: norm(w.word),
      start: w.start,
      end: w.end,
      final: !!msg.is_final,
    }));
    if (msg.is_final) {
      this.final.push(...words);
      this.interim = [];
    } else {
      this.interim = words;
    }
    return this.judgeable();
  }

  // Every word, final or not, for display.
  all() {
    return this.final.concat(this.interim);
  }

  judgeable() {
    if (this.policy === 'final') return this.final.slice();
    if (this.policy === 'interim') return this.all();
    return this.final.concat(this.interim.slice(0, -1));
  }
}

// First index where two word lists differ (by normalized word), or the shorter length.
export function firstDifference(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i].key === b[i].key) i++;
  return i;
}
