// The Jev questions asked on every new word, and how their answers are read.
// One Score for the signal (5 levels, bearish → bullish), one Score per driver (3 levels), one Noul for ads.

const SIGNAL = {
  type: 'score',
  instructions: 'What does what the speaker has said so far mean for the price of `asset`? `transcript` is live speech; words inside ⟦ ⟧ were just spoken. `earlier`, when present, sums up what was said before `transcript` starts.',
  criteria: [
    'Clearly bad news for `asset`: a cut outlook, a miss, a hawkish turn, a new legal threat, or anything else that should send its price down',
    'More concerns, caveats or soft spots than good news for `asset`',
    'Nothing that should move `asset`: routine remarks, or good and bad news that cancel out',
    'More good news than concerns for `asset`',
    'Clearly good news for `asset`: a raised outlook, a beat, a dovish turn, a big deal, or anything else that should send its price up',
  ],
};

// `sided: 'bear'` drivers can only push the signal down (level 0 is neutral).
// `words`: what an active driver says, [when bearish, when bullish].
export const DRIVERS = [
  {
    id: 'guidance', label: 'Guidance',
    instructions: 'How does the speaker change the forward outlook for `asset`?',
    criteria: ['Outlook lowered, cut or withdrawn, or a policy path that is worse for `asset`', 'Outlook not discussed, or reaffirmed unchanged', 'Outlook raised, or a policy path that is better for `asset`'],
    words: ['cut', 'raised'],
  },
  {
    id: 'demand', label: 'Demand',
    instructions: 'What does the speaker say about demand, sales, adoption or economic activity that matters for `asset`?',
    criteria: ['Weakening or slowing', 'Not discussed, or steady', 'Strengthening or accelerating'],
    words: ['weak', 'strong'],
  },
  {
    id: 'margins', label: 'Margins',
    instructions: 'What does the speaker say about margins, costs or profitability that matter for `asset`?',
    criteria: ['Margins shrinking, or costs rising faster than revenue', 'Not discussed, or steady', 'Margins expanding, or costs falling'],
    words: ['squeezed', 'expanding'],
  },
  {
    id: 'surprise', label: 'Surprise',
    instructions: 'How does what the speaker said compare with what the market expected for `asset`?',
    criteria: ['Worse than expected', 'In line with expectations, or no comparison possible', 'Better than expected'],
    words: ['miss', 'beat'],
  },
  {
    id: 'hedging', label: 'Hedging', sided: 'bear',
    instructions: 'How does the speaker talk about the outlook for `asset`?',
    criteria: ['Directly and confidently', 'With some caveats and qualifiers', 'Evasively or heavily hedged: dodging questions, walking things back, piling on qualifiers'],
    words: ['evasive', ''],
  },
  {
    id: 'regulatory', label: 'Legal & policy', sided: 'bear',
    instructions: 'Does the speaker raise a regulatory, legal or government-policy risk for `asset`?',
    criteria: ['No such risk raised', 'Only routine or passing mentions', 'A material regulatory, legal or policy risk'],
    words: ['risk', ''],
  },
];

const AD = {
  type: 'noul',
  instructions: 'Are the words inside ⟦ ⟧ an advertisement, a station break, or talk by someone else that has nothing to do with `asset`?',
};

export const QUESTIONS = {
  signal: SIGNAL,
  ...Object.fromEntries(DRIVERS.map((d) => [d.id, { type: 'score', instructions: d.instructions, criteria: d.criteria }])),
  ad: AD,
};

// words: [{ w }]; the ones from `newFrom` on are marked as just spoken.
export function buildState({ words, newFrom, asset, context, earlier }) {
  const said = words.slice(0, newFrom).map((x) => x.w).join(' ');
  const fresh = words.slice(newFrom).map((x) => x.w).join(' ');
  const state = { asset };
  if (context) state.event = context;
  if (earlier) state.earlier = earlier;
  state.transcript = fresh ? `${said} ⟦${fresh}⟧`.trim() : said;
  return state;
}

// Signal and drivers on −1 (bearish) … +1 (bullish).
export function readAnswers(answers) {
  const s = answers.signal;
  const drivers = {};
  for (const d of DRIVERS) {
    const score = answers[d.id]?.score;
    if (typeof score !== 'number') continue;
    drivers[d.id] = d.sided === 'bear' ? -score / 2 : score - 1;
  }
  return {
    signal: s.score / 2 - 1,
    confidence: s.confidence,
    drivers,
    ad: answers.ad?.noul ?? 0,
  };
}

export const SIGNAL_WORDS = ['Strongly bearish', 'Bearish', 'Neutral', 'Bullish', 'Strongly bullish'];
export const signalWord = (v) => SIGNAL_WORDS[Math.max(0, Math.min(4, Math.round((v + 1) * 2)))];
