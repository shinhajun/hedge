// Test clips for the benches and the harness. The audio itself lives in .e2e/audio (gitignored) and is
// fetched for local testing only:
//   yt-dlp -f bestaudio -x --audio-format wav -o '.e2e/audio/%(id)s.%(ext)s' <url>
//   ffmpeg -i .e2e/audio/<id>.wav -ac 1 -ar 16000 -f s16le .e2e/audio/<id>.pcm
import fs from 'node:fs';
import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..');

// `from`: seconds into the audio where speech worth judging starts. `known`: what the market did.
export const CLIPS = [
  {
    id: 'duUBLlLBcdg',
    name: 'Powell, Jackson Hole 2022',
    asset: 'SPY',
    context: 'Fed Chair Jerome Powell, Jackson Hole speech, Aug 26 2022',
    from: 0,
    known: 'bearish: S&P 500 fell 3.4% that afternoon',
  },
  {
    id: 'g8toIbd_Tf4',
    name: 'NVIDIA Q1 FY24 call',
    asset: 'NVDA',
    context: 'NVIDIA Q1 FY2024 earnings call, May 24 2023; CFO Colette Kress prepared remarks',
    from: 120,
    known: 'bullish: NVDA rose 24% the next day on the $11B Q2 outlook',
  },
  {
    id: 'K4ciiDyUvUo',
    name: 'Larry Fink on bitcoin',
    asset: 'BTC',
    context: 'BlackRock CEO Larry Fink on Fox Business, July 2023, after BlackRock filed for a spot bitcoin ETF',
    from: 0,
    known: 'bullish: the BlackRock ETF filing drove BTC up ~20% over the following weeks',
  },
];

export const pcmPath = (id) => path.join(root, '.e2e', 'audio', `${id}.pcm`);

export function envKey(name) {
  const env = fs.readFileSync(path.join(root, '.env'), 'utf8');
  const v = env.match(new RegExp(`^${name}=(.*)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '');
  if (!v) throw new Error(`${name} missing in .env`);
  return v;
}
