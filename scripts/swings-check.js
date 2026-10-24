// Re-ranks the swings of saved harness timelines with the current extension/judge.js, so a change to the
// ranking can be checked against real calls without re-running them.
// Usage: node scripts/swings-check.js [timeline.json …]   (defaults to the three clip timelines in .e2e/)
import fs from 'node:fs';
import path from 'node:path';
import { Judge } from '../extension/judge.js';
import { CLIPS, root } from './audio.js';

const files = process.argv.slice(2).length ? process.argv.slice(2) : CLIPS.map((c) => path.join(root, '.e2e', `timeline-${c.id}.json`));
const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
for (const f of files) {
  if (!fs.existsSync(f)) continue;
  const { points, words, summary } = JSON.parse(fs.readFileSync(f, 'utf8'));
  const judge = new Judge({ ask: async () => ({}) });
  judge.words = words.map((w) => ({ ...w, key: w.w.toLowerCase() }));
  judge.points = points;
  console.log(`\n${summary?.name || path.basename(f)}`);
  for (const m of judge.swings(5)) {
    const drv = m.driver ? `  [${m.driver.label} ${m.driver.word} ${m.driver.jump >= 0 ? '+' : '−'}${Math.abs(m.driver.jump).toFixed(2)}]` : '';
    console.log(`  ${m.delta >= 0 ? '+' : '−'}${Math.abs(m.delta).toFixed(2)} score ${m.score.toFixed(2)} at ${clock(m.t)}${drv}  “${m.quote}”`);
  }
}
