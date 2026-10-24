# Hedge

Hedge listens to whoever is speaking on any tab (an earnings call, a Fed press conference, a YouTube, X or Twitch live stream, a Zoom webinar) or through your microphone. On every new word it re-reads the whole transcript so far and moves a gauge from bearish to bullish for the stock or coin you pick, and it shows why.

Built for SBUHacks 2026 on TypeSafe's **Jev** (System One) with **Deepgram Nova-3** streaming speech-to-text. Chrome MV3, vanilla JS, no build step, no backend.

## Try it

1. `chrome://extensions` → Developer mode → **Load unpacked** → pick `extension/`. Pin Hedge from the puzzle-piece menu.
2. The settings page opens: paste a TypeSafe key and a Deepgram key (**Save and test** checks each). Keys stay in `chrome.storage.local` and go only to their own service.
3. On the tab with the speech, click the Hedge button once (or Alt+Shift+H, ⌥⇧H on a Mac). The side panel opens and starts listening to that tab in the same click. Type the asset (`NVDA`, `BTC`, …) if it's empty and press Enter.

Chrome lets an extension capture a tab only after you click its button there, so on another tab the panel shows one line: *Click [Hedge] on this tab to listen*. For a TV or a desktop app, choose **Microphone** → **Listen** and allow the mic once. If the lamp says *No sound*, open **Diagnostics** for the input level and device, and on a Mac check System Settings → Privacy & Security → Microphone.

## What you see

- **The gauge**: the signal from −1 (strongly bearish) to +1 (strongly bullish). The needle trembles as much as Jev is unsure.
- **Signal per word**: a chart-recorder trace of the eased signal, with Jev's raw per-word readings as faint dots, and numbered pins on the biggest moves. Each move is listed with its words, like *−0.56 “…focus right now is to bring inflation back down”*.
- **Drivers**: guidance (cut/raised), demand, margins, surprise vs expectations, hedging (evasive answers) and legal & policy risk.
- **Transcript**: each word is tinted by how much it moved Jev's reading. Grey italics are words Deepgram may still revise; struck-through words are ads.
- **Price**: a live price strip on the same clock as the signal, with the swings carried down as dashed lines, so you can see whether the price followed. Crypto streams trades from Binance (Coinbase where Binance is blocked, as in the US); stocks and ETFs poll Yahoo's chart endpoint (Nasdaq's quote API as a fallback) every 5 s and show *market closed* outside trading hours. No keys.
- **Paper trade** (off by default): a simulated position that goes long at +0.35 and flat under +0.15, short at −0.35 and flat over −0.15, $10,000 a position, filled at the live price, no fees. Fills are marked on the price strip; running P&L and the trades sit under it. Clearly labeled *Paper*; there are no orders and no exchange keys.
- **Meters**: Jev calls, tokens, spend (Jev + Deepgram), Jev latency p50, word → gauge latency p50, and audio time.
- **Diagnostics** (folded unless something is wrong): input level, device, sample rate, Deepgram socket state and last close reason, bytes sent, results and words received, last error.

## How it works

```
tab audio (chrome.tabCapture) ─┐                       ┌─ side panel
microphone ────────────────────┴─ offscreen document ──┤   Transcript → Judge → Jev
   plays the tab back, 16 kHz PCM, Deepgram WebSocket  └─ draws gauge, chart, drivers, words
```

- **Capture** (`extension/background.js`, `offscreen.js`): the toolbar click opens the panel and gets the tab's stream id in the same gesture; the offscreen document captures and keeps every result, so a panel that opens later (or is reopened mid-call) replays what it missed. The microphone runs with echo cancellation and noise suppression off: Hedge listens to media, and echo cancellation subtracts exactly the audio the computer is playing.
- **Speech-to-text** (`extension/stream.js`): Deepgram Nova-3 live, with interim results, smart format and 300 ms endpointing. After 2.5 s of silence it stops sending audio, so quiet isn't billed, and sends KeepAlive instead. If the socket drops, it reconnects with backoff and replays the last 30 s of audio after the last final word. Words already final are not passed on again, so none are lost or doubled.
- **Per-word judging** (`extension/judge.js`): each new word asks Jev about the transcript up to that word, with the words since the previous call marked `⟦…⟧`. At most 3 calls run at once. When words arrive faster, older ones are skipped so the newest is always next. Results apply in the order their calls were made, never out of order. When Deepgram revises a word, every reading after it is withdrawn and the corrected text is judged again. Results are cached by transcript prefix.
- **Questions** (`extension/questions.js`): one request per word holds a 5-level **Score** for the signal, six 3-level **Scores** for the drivers, and a **Noul** for "the last 20 words are an ad, a sponsor message or a station promo" (an ad holds the gauge and drops out of later calls; on a CNBC pre-roll this caught the ad that the newest-words-only version missed). A Score answer is the probability-weighted level, normalized here to −1…+1.
- **Swings**: the pins are the biggest moves of the gauge between turning points (wiggles under 0.04 don't end a move), plus any driver switching on by 0.35 or more, so news that lands while the gauge is already pinned still shows (NVIDIA's $11B outlook: guidance 0.17 → 0.87 while the gauge moved +0.2).
- **Hedging driver**: tuned on a labeled set (`scripts/hedging-eval.js`): confident talk, procedure, safe-harbor disclaimers and ads must not read as evasive. The first wording got 12/24 (7/10 held out); the shipped one gets 24/24 (10/10 held out).
- **Steadiness**: a half-said sentence can read either way, so single readings wobble. The gauge shows the median of the last three readings, eased by half each word. A real move lands within about 3 words.
- **Long streams**: after 2,000 words, Jev sees only the latest 2,000 plus a short `earlier` note: the reading at that point and the drivers that fired, with quotes. Calls stay ~3.5k tokens however long the stream runs. The page keeps the last 700 words, a 15-minute chart, and thinned-out old points.

## Numbers (measured 2026-10-25)

| | |
|---|---|
| Deepgram word latency (first sight, p50 / p95) | 0.49–0.55 s / 0.96–1.7 s |
| Deepgram interim results | every ~1.0 s |
| Jev latency p50 at 100 / 1k / 5k / 10k words | 170 / 173 / 194 / 232 ms |
| Jev tokens per call | ≈ 930 + 1.32 × words |
| Word spoken → gauge updated (in Chrome, p50 / p95) | 0.83 / 1.27 s (tab capture, Powell clip) |
| 10 minutes of Bloomberg live on YouTube | 0 reconnects, 0 errors, panel heap 3.9 → 4.6 MB |
| Cost per hour of speech | Deepgram $0.29 (promo price; $0.46 list) + Jev $0.85 measured over 10 live minutes, ≈ $1.2–1.5 once the 2,000-word window fills |

## Scripts

```
npm install          # Playwright, for the e2e only
npm test             # scheduler and transcript unit tests (no network)
npm run bench:stt    # Deepgram latency, interim rate, revision rate
npm run bench:jev    # Jev latency and tokens vs transcript length, 60-minute cost
npm run harness      # test clips → the real pipeline → .e2e/timeline-*.json
node scripts/e2e.js tab|mic|live|page …   # headless Chromium with the extension loaded
node scripts/e2e-real.js             # real Chromium on Xvfb: real key press, real mic prompt, PipeWire mics
node scripts/silence-check.js        # KeepAlive and unbilled silence, live
node scripts/hedging-eval.js         # the Hedging driver on a labeled set
node scripts/swings-check.js         # re-rank swings on saved timelines
```

Scripts read `TYPESAFE_API_KEY` and `DEEPGRAM_API_KEY` from `.env`. Test audio lives in `.e2e/audio/`, which is gitignored; `scripts/audio.js` lists the clips and how to fetch them.

## Renaming

The product name lives in one place: `extension/_locales/en/messages.json` (`appName`). The manifest, pages and scripts read it from there.
