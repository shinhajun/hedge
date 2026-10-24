// Labeled check for the Hedging driver: does it call real dodges "evasive" and leave confident talk,
// procedure, standard disclaimers and ads alone? Compares the first wording, the shipped one and alternatives.
// Usage: node scripts/hedging-eval.js      (TYPESAFE_API_KEY from .env; never printed)
import { callJev } from '../extension/jev.js';
import { DRIVERS } from '../extension/questions.js';
import { envKey } from './audio.js';

const apiKey = envKey('TYPESAFE_API_KEY');

// [category, asset, text, evasive?]
const SET = [
  ['confident', 'NVDA', 'We delivered record revenue this quarter and we are raising our full-year guidance.', false],
  ['confident', 'NVDA', 'Demand for our data center products is extraordinary, and we have secured the supply to meet it.', false],
  ['confident', 'AAPL', 'Gross margin expanded four hundred basis points, and we expect that to continue next quarter.', false],
  ['confident', 'SPY', 'Inflation is far too high, and we will keep raising rates until the job is done.', false],
  ['confident', 'BTC', 'Bitcoin is a legitimate financial instrument, and we will offer it to our clients.', false],
  ['procedural', 'NVDA', "Good afternoon, and welcome to the third quarter earnings call. All lines are in listen-only mode.", false],
  ['procedural', 'NVDA', "I'll now turn the call over to our chief financial officer.", false],
  ['procedural', 'NVDA', 'Our next question comes from the line of Vivek Arya with Bank of America.', false],
  ['procedural', 'MSFT', "Slides for today's presentation are available on our investor relations website.", false],
  ['caveat', 'NVDA', 'During this call we may make forward-looking statements that are subject to risks and uncertainties, and actual results may differ materially.', false],
  ['caveat', 'SPY', 'As always, our decisions will depend on the incoming data and the evolving outlook and balance of risks.', false],
  ['caveat', 'MSFT', 'We will discuss non-GAAP measures; reconciliations are in our press release.', false],
  ['caveat', 'SPY', 'Monetary policy affects the economy with long and variable lags.', false],
  ['caveat', 'AAPL', 'These statements are made as of today, and we assume no obligation to update them.', false],
  ['promo', 'SPY', 'Nobody covers jobs day like Bloomberg. Stay with us for expert analysis at terminal speed.', false],
  ['promo', 'SPY', 'This segment is brought to you by our sponsor. Trade smarter with zero commissions.', false],
  ['promo', 'BTC', "Don't forget to like and subscribe, and hit the bell for more crypto updates.", false],
  ['evasive', 'NVDA', "Well, I'm not going to get into the specifics of that, but what I would say is we feel good about the business overall.", true],
  ['evasive', 'TSLA', "Q: Will you cut guidance? A: You know, there are a lot of moving parts, and I don't want to speculate on numbers today.", true],
  ['evasive', 'META', "I think it's premature to say, and we'll have more to share at the appropriate time.", true],
  ['evasive', 'INTC', 'Q: Are customers delaying orders? A: Let me step back and talk about our long-term strategy, which remains unchanged.', true],
  ['evasive', 'SPY', "I wouldn't want to characterize it one way or another; it's really too early to tell.", true],
  ['evasive', 'BA', "We're not providing guidance for next quarter given the uncertainty.", true],
  ['evasive', 'T', 'Q: Is the dividend safe? A: We continually evaluate our capital allocation priorities.', true],
];
// Held out: written after the wording was chosen, never used to tune it.
const HELD = [
  ['held', 'NVDA', 'Thanks, operator, and good afternoon everyone.', false],
  ['held', 'SPY', 'We remain strongly committed to returning inflation to our two percent objective.', false],
  ['held', 'BTC', 'Past performance is not indicative of future results. This is not financial advice.', false],
  ['held', 'SPY', 'Coming up after the break: the latest on oil prices and what it means for your portfolio.', false],
  ['held', 'AMZN', 'Revenue was up twelve percent year over year, ahead of our guidance range.', false],
  ['held', 'AAPL', "That's a great question, and I'd rather not front-run what we'll say at our product event.", true],
  ['held', 'NVDA', "I don't think I'll comment on any specific customer.", true],
  ['held', 'TSLA', "We'll let the numbers speak for themselves when we report next quarter.", true],
  ['held', 'SPY', "Hard to say. We're watching it closely and we'll see how it plays out.", true],
  ['held', 'COIN', "Q: Will the SEC case hurt revenue? A: We're focused on building great products for our customers.", true],
];
SET.push(...HELD);

const BEFORE = {
  type: 'score',
  instructions: 'How does the speaker talk about the outlook for `asset`?',
  criteria: ['Directly and confidently', 'With some caveats and qualifiers', 'Evasively or heavily hedged: dodging questions, walking things back, piling on qualifiers'],
};
const hedging = DRIVERS.find((d) => d.id === 'hedging');
// `shipped` is the wording in extension/questions.js; the others are alternatives that were tried.
const CANDIDATES = {
  before: BEFORE,
  shipped: { type: 'score', instructions: hedging.instructions, criteria: hedging.criteria },
  scoreB: {
    type: 'score',
    instructions: 'Does the speaker avoid giving a straight answer about `asset`? Greetings, procedure, ads, safe-harbor disclaimers and routine phrases like "depending on the data" are not avoidance.',
    criteria: [
      'Gives a straight answer or view, or says nothing that calls for one',
      'Gives a view but hedges it heavily',
      'Avoids the question: deflects, changes the subject, declines to give numbers, or says it is too early to tell',
    ],
  },
  noulA: {
    type: 'noul',
    instructions: 'The speaker dodges a question or refuses to commit on the outlook for `asset`.',
    criteria: {
      true: 'Declines to answer, deflects to something else, refuses to give numbers it would normally give, or says it is too early to tell',
      false: 'Gives a direct answer or view, or is not discussing the outlook (greetings, procedure, ads, safe-harbor disclaimers, routine "depends on the data" language)',
    },
  },
};
// The panel calls the driver active at |value| >= 0.3: a score of 0.6 or more on the 0..2 scale (0.5 for a Noul).
const active = (q, a) => (q.type === 'noul' ? a.noul >= 0.5 : a.score >= 0.6);
const value = (q, a) => (q.type === 'noul' ? a.noul : a.score);

const res = await Promise.all(SET.map(async ([, asset, text]) => {
  const r = await callJev(apiKey, { state: { asset, transcript: text }, questions: CANDIDATES });
  return r.answers;
}));

for (const [name, q] of Object.entries(CANDIDATES)) {
  let right = 0;
  const byCat = {};
  SET.forEach(([cat, , , evasive], i) => {
    if (active(q, res[i][name]) === evasive) right++;
    (byCat[cat] ||= []).push(value(q, res[i][name]));
  });
  const cats = Object.entries(byCat).map(([c, xs]) => `${c} ${(xs.reduce((a, b) => a + b) / xs.length).toFixed(2)}`).join(', ');
  const held = SET.map((x, i) => [x, i]).filter(([x]) => x[0] === 'held');
  const heldRight = held.filter(([x, i]) => active(q, res[i][name]) === x[3]).length;
  console.log(`${name.padEnd(7)} tuning set ${right - heldRight}/${SET.length - held.length}, held out ${heldRight}/${held.length}  mean by category: ${cats}`);
}
const best = process.argv[2] || 'shipped';
console.log(`\nmisses (${best}):`);
SET.forEach(([cat, , text, evasive], i) => {
  if (active(CANDIDATES[best], res[i][best]) !== evasive) console.log(`  ${cat.padEnd(10)} ${value(CANDIDATES[best], res[i][best]).toFixed(2)}  ${text}`);
});
