// In-browser check: loads the extension in Playwright's Chromium (headless), opens a tab that plays
// speech, and has the extension listen to it end to end (tab capture → offscreen → Deepgram → Jev →
// panel). Saves the panel's timeline JSON, light/dark screenshots and resource samples to .e2e/.
//
//   node scripts/e2e.js tab  [--clip duUBLlLBcdg] [--seconds 180]   a local page playing a test clip
//   node scripts/e2e.js mic  [--clip K4ciiDyUvUo] [--seconds 60]    Chromium's fake microphone playing a clip
//   node scripts/e2e.js live --url <YouTube live URL> [--asset SPY] [--seconds 600]
//   node scripts/e2e.js page --url <any page with a video> [--asset SPY] [--seconds 60]   (one row of the capture matrix)
// Options: --auto (start through the toolbar-click hand-off), --paper, --expect-trade, --tag <name>.
//
// Headless Chromium can't click the toolbar button, so tab capture is allowed with
// --allowlisted-extension-id (the same permission a click grants). Keys come from .env and are never printed.
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright';
import { CLIPS, envKey, root } from './audio.js';

const { positionals, values: opt } = parseArgs({
  allowPositionals: true,
  options: {
    clip: { type: 'string' }, seconds: { type: 'string' }, url: { type: 'string' }, asset: { type: 'string' }, context: { type: 'string' }, tag: { type: 'string' },
    auto: { type: 'boolean' }, // start the way the toolbar click does (the hand-off to the panel), not with Listen
    paper: { type: 'boolean' }, // turn paper trading on
    'expect-trade': { type: 'boolean' }, // fail unless at least one paper trade opens
    'block-binance': { type: 'boolean' }, // answer like Binance does for US addresses (451), to exercise the Coinbase path
    'block-binance-stream': { type: 'boolean' }, // Binance's REST answers but its trade stream can't connect
    thresholds: { type: 'string' }, // paper trade thresholds "enter,exit", as set in Settings
    ext: { type: 'string' }, // another copy of the extension (e.g. an older version) instead of extension/
  },
});
const mode = positionals[0] || 'tab';
const extDir = opt.ext ? path.resolve(opt.ext) : path.join(root, 'extension');
const outDir = path.join(root, '.e2e');
const extId = [...crypto.createHash('sha256').update(extDir).digest('hex').slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join('');
const clip = CLIPS.find((c) => c.id === (opt.clip || (mode === 'mic' ? 'K4ciiDyUvUo' : 'duUBLlLBcdg')));
const web = mode === 'live' || mode === 'page'; // a real site rather than the local test page
const seconds = Number(opt.seconds || { tab: 180, mic: 60, live: 600, page: 60 }[mode]);
const asset = opt.asset || (web ? 'SPY' : clip.asset);
const context = opt.context ?? (web ? '' : clip.context);
const tag = opt.tag || (web ? mode : `${mode}-${clip.id}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// A local page that plays the clip, like a video tab would.
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/audio/')) {
    const file = path.join(outDir, 'audio', path.basename(req.url));
    const size = fs.statSync(file).size;
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': size, 'accept-ranges': 'bytes' });
    fs.createReadStream(file).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end(`<!doctype html><title>${clip.name}</title><body style="font:16px system-ui;padding:24px"><h1>${clip.name}</h1>
    <audio id="a" src="/audio/${clip.id}.wav" autoplay controls></audio>
    <script>const a = document.getElementById('a'); a.currentTime = ${clip.from};</script></body>`);
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

// YouTube stops headless playback after ~45 s ("Something went wrong") unless the browser looks ordinary.
const blockBinance = opt['block-binance'] || opt['block-binance-stream'] ? ['--host-resolver-rules=MAP stream.binance.com ~NOTFOUND'] : [];
const args = [...blockBinance, `--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, `--allowlisted-extension-id=${extId}`, '--autoplay-policy=no-user-gesture-required', '--disable-blink-features=AutomationControlled'];
let fakeWav;
if (mode === 'mic') {
  // Chromium's fake microphone plays a WAV file on a loop.
  fakeWav = path.join(outDir, 'audio', `${clip.id}.mic.wav`);
  if (!fs.existsSync(fakeWav)) execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', String(clip.from), '-t', String(seconds + 30), '-i', path.join(outDir, 'audio', `${clip.id}.wav`), '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', fakeWav]);
  args.push('--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${fakeWav}`);
}
const chromeMajor = execFileSync(chromium.executablePath(), ['--version']).toString().match(/(\d+)\./)[1];
const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hedge-e2e-'));
const context0 = await chromium.launchPersistentContext(userDataDir, {
  channel: 'chromium',
  headless: true,
  locale: 'en-US',
  viewport: { width: 1280, height: 900 },
  ignoreDefaultArgs: ['--mute-audio'],
  userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor}.0.0.0 Safari/537.36`,
  args,
});
const errors = [];
context0.on('weberror', (e) => /chrome-extension:/.test(e.error().stack || '') && errors.push(e.error().message));
// Chrome logs failed connections itself; with Binance blocked on purpose those are expected.
const expected = (text) => (opt['block-binance'] || opt['block-binance-stream']) && /binance\.com.*net::ERR_/.test(text);
context0.on('console', (m) => m.type() === 'error' && /chrome-extension:/.test(m.location()?.url || '') && !expected(m.text()) && errors.push(m.text()));

const sw = context0.serviceWorkers()[0] || (await context0.waitForEvent('serviceworker'));
if (new URL(sw.url()).host !== extId) throw new Error('unexpected extension id');
await sleep(1000); // the settings tab opens on install, sometimes in the first blank tab
for (const p of context0.pages()) if (p.url().includes(extId)) await p.close();
await sw.evaluate(async (keys) => chrome.storage.local.set(keys), { apiKey: envKey('TYPESAFE_API_KEY'), deepgramKey: envKey('DEEPGRAM_API_KEY'), asset, context });
if (opt.thresholds) {
  const [enter, exit] = opt.thresholds.split(',').map(Number);
  await sw.evaluate((t) => chrome.storage.local.set({ paperThresholds: t }), { enter, exit });
}
let binanceHits = 0;
if (opt['block-binance']) {
  await context0.route('https://api.binance.com/**', (route) => {
    binanceHits++;
    route.fulfill({ status: 451, contentType: 'application/json', body: '{"code":0,"msg":"Service unavailable from a restricted location."}' });
  });
}

// The page's main video, which may sit in an iframe (embedded players).
async function videoFrame() {
  for (const f of media?.frames() || []) if (await f.$('video').catch(() => null)) return f;
  return null;
}
// what: 'state' | 'play' | 'pause' | 'seek' (ahead by `arg` seconds).
async function onVideo(what, arg) {
  const f = await videoFrame();
  if (!f) return null;
  return f.evaluate(([what, arg]) => {
    const v = [...document.querySelectorAll('video')].sort((x, y) => y.clientWidth * y.clientHeight - x.clientWidth * x.clientHeight)[0];
    if (!v) return null;
    if (what === 'state') return { paused: v.paused, t: Math.round(v.currentTime), d: Number.isFinite(v.duration) ? Math.round(v.duration) : null, muted: v.muted };
    if (what === 'play') {
      v.muted = false;
      v.volume = 1;
      v.play().catch(() => {});
    }
    if (what === 'pause') v.pause();
    if (what === 'seek') {
      if (!Number.isFinite(v.duration)) return 'live: no seek';
      v.currentTime = Math.min(v.duration - 5, v.currentTime + arg);
    }
    return 'ok';
  }, [what, arg]).catch(() => null);
}

// The tab to listen to.
let tabId = null;
let media;
if (mode !== 'mic') {
  media = await context0.newPage();
  await media.goto(web ? opt.url : `http://localhost:${port}/`, { waitUntil: 'domcontentloaded' });
  if (web) {
    for (let i = 0; i < 60 && !(await videoFrame()); i++) {
      // Some players only create the <video> after Play is pressed.
      if (i === 10) for (const f of media.frames()) await f.click('button[aria-label*="Play" i], .vp-big-play-button, .play-icon, [data-play-button]', { timeout: 1000 }).catch(() => {});
      await sleep(500);
    }
    if (!(await videoFrame())) throw new Error('no video on the page');
    await sleep(4000);
    await onVideo('play');
  }
  for (let i = 0; i < 60 && tabId == null; i++) {
    tabId = await sw.evaluate(async () => (await chrome.tabs.query({ audible: true }))[0]?.id ?? null);
    if (tabId == null) await sleep(500);
  }
  if (tabId == null) throw new Error('the media tab never became audible');
  log(`media tab ${tabId} is playing`);
}

// The side panel, opened as a tab at side-panel width.
const panel = await context0.newPage();
await panel.setViewportSize({ width: 420, height: 1180 });
await panel.goto(`chrome-extension://${extId}/panel.html${tabId != null ? `?tab=${tabId}` : ''}`);
await panel.waitForFunction(() => globalThis.panel);
await panel.screenshot({ path: path.join(outDir, `panel-idle-light.png`) });
if (opt.paper) await panel.check('#paperOn');
if (mode === 'mic') {
  await panel.click('[data-source="mic"]');
  const micPage = context0.waitForEvent('page', { timeout: 5000 }).catch(() => null);
  await panel.click('#go');
  // With the fake-UI flag Chromium may already report the mic as granted; otherwise mic.html asks.
  const mic = await micPage;
  if (mic) {
    await mic.waitForLoadState();
    await mic.click('#allow');
    log('microphone allowed on mic.html');
  } else log('microphone already granted; listening started directly');
} else if (opt.auto) {
  // What a click on the toolbar button does (headless Chromium has no toolbar to click).
  await sw.evaluate((tabId) => chrome.tabs.get(tabId).then((tab) => globalThis.actionClick(tab)), tabId);
  await panel.waitForFunction(() => globalThis.panel.session()?.on, null, { timeout: 10000 });
  log('started the way the toolbar button does');
} else {
  await panel.click('#go');
}

// A hidden video tab can stop playing; keep it in front (the panel keeps working in the background)
// and bring the panel forward only for screenshots.
if (web) await media.bringToFront();
const mediaState = async () => {
  if (!web) return null;
  const ad = await media.evaluate(() => !!document.querySelector('#movie_player.ad-showing, .ytp-ad-player-overlay, .jw-flag-ads, [class*="ad-showing"]')).catch(() => false);
  const v = await onVideo('state');
  return { ...(v || { video: false }), ad };
};
const cdp = await context0.newCDPSession(panel);
await cdp.send('Performance.enable');
const heap = async () => (await cdp.send('Performance.getMetrics')).metrics.find((m) => m.name === 'JSHeapUsedSize').value;
// CPU and memory of the whole browser, from /proc.
function browserUsage() {
  const pids = execFileSync('pgrep', ['-f', userDataDir]).toString().trim().split('\n').map(Number);
  let rss = 0, cpu = 0;
  for (const pid of pids) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ');
      cpu += (Number(stat[11]) + Number(stat[12])) / 100; // utime + stime, in seconds (CLK_TCK = 100)
      rss += Number(stat[21]) * 4096;
    } catch {}
  }
  return { rss, cpu };
}

const samples = [];
const started = Date.now();
let prev = { ...browserUsage(), at: started };
let shotMid = false;
// The capture matrix (`page`): pause at 20 s for 6 s, then seek ahead a minute at 40 s.
const actions = mode === 'page' ? [
  { at: 20, name: 'pause', run: () => onVideo('pause') },
  { at: 26, name: 'resume', run: () => onVideo('play') },
  { at: 40, name: 'seek', run: () => onVideo('seek', 60) },
] : [];
const marks = {};
const wordsNow = () => panel.evaluate(() => globalThis.panel.session()?.transcript?.all().length ?? 0);
while (Date.now() - started < seconds * 1000) {
  await sleep(mode === 'page' ? 5000 : 15000);
  for (const a of actions) {
    if (a.done || Date.now() - started < a.at * 1000) continue;
    a.done = true;
    marks[a.name] = { words: await wordsNow(), result: await a.run() };
    log(`${a.name}: ${JSON.stringify(marks[a.name])}`);
  }
  const u = browserUsage();
  const t = await panel.evaluate(() => globalThis.panel.timeline());
  const s = {
    at: Math.round((Date.now() - started) / 1000),
    cpuPct: (100 * (u.cpu - prev.cpu)) / ((Date.now() - prev.at) / 1000),
    rssMB: u.rss / 2 ** 20,
    panelHeapMB: (await heap()) / 2 ** 20,
    words: t?.words.length ?? 0,
    points: t?.points.length ?? 0,
    lagP50: t?.stats.lagP50Ms,
    state: await panel.$eval('#lamp', (el) => el.dataset.state),
    media: await mediaState(),
  };
  prev = { ...u, at: Date.now() };
  samples.push(s);
  log(`${s.at}s ${s.state} words ${s.words} points ${s.points} lag p50 ${s.lagP50 ? Math.round(s.lagP50) : '-'} ms cpu ${s.cpuPct.toFixed(0)}% rss ${s.rssMB.toFixed(0)} MB heap ${s.panelHeapMB.toFixed(1)} MB${s.media ? ` media ${JSON.stringify(s.media)}` : ''}`);
  if (!shotMid && s.points > 20) {
    shotMid = true;
    await panel.bringToFront();
    await sleep(500);
    await panel.screenshot({ path: path.join(outDir, `panel-${tag}-mid-light.png`) });
    if (web) await media.bringToFront();
  }
}

const timeline = await panel.evaluate(() => globalThis.panel.timeline());
await panel.bringToFront();
await sleep(500);
for (const scheme of ['light', 'dark']) {
  await panel.emulateMedia({ colorScheme: scheme });
  await sleep(400);
  await panel.screenshot({ path: path.join(outDir, `panel-${tag}-${scheme}.png`) });
}
if (mode === 'tab') {
  const options = await context0.newPage();
  await options.setViewportSize({ width: 900, height: 1300 });
  await options.goto(`chrome-extension://${extId}/options.html`);
  await sleep(500);
  for (const scheme of ['light', 'dark']) {
    await options.emulateMedia({ colorScheme: scheme });
    await sleep(300);
    await options.screenshot({ path: path.join(outDir, `options-${scheme}.png`), fullPage: true });
  }
  await options.close();
}
// Blocked Binance: listening again must not ask Binance a second time (the failure is remembered).
let venueMemory = null;
if (opt['block-binance']) {
  const before = binanceHits;
  await panel.click('#go'); // stop
  await sleep(1000);
  await panel.click('#go'); // listen again
  await panel.waitForFunction(() => globalThis.panel.session()?.feed, null, { timeout: 15000 }).catch(() => {});
  await sleep(4000);
  venueMemory = { binanceRequestsFirst: before, binanceRequestsAgain: binanceHits - before, venueAgain: await panel.evaluate(() => globalThis.panel.session()?.feed?.venue), remembered: await panel.evaluate(() => chrome.storage.local.get('badVenues').then((x) => x.badVenues)) };
  log(`listening again: ${JSON.stringify(venueMemory)}`);
}
await panel.click('#go'); // stop
await sleep(800);
const lamp = await panel.$eval('#lamp', (el) => el.dataset.state);

const hours = timeline.stats.audioSeconds / 3600 || 1;
marks.end = { words: timeline.words.length };
const adSeen = samples.some((x) => x.media?.ad);
const matrix = mode === 'page' && {
  words: timeline.words.length,
  beforePause: marks.pause?.words,
  survivesPause: marks.seek?.words > marks.resume?.words,
  survivesSeek: marks.seek?.result === 'live: no seek' ? 'n/a (live)' : marks.end.words > marks.seek?.words,
  adSeen,
  wordsDuringAd: adSeen ? samples.filter((x) => x.media?.ad).map((x) => x.words) : null,
  states: [...new Set(samples.map((x) => x.state))],
  marks,
};
const ticks = timeline.price?.ticks || [];
const paperEvents = timeline.paper?.events || [];
const checks = {
  words: timeline.words.length > 0,
  extensionErrors: errors.length === 0,
  price: ticks.length >= (timeline.price?.kind === 'crypto' ? 20 : 1),
  ...(opt['block-binance-stream'] ? { coinbase: timeline.price?.venue === 'Coinbase' } : {}),
  ...(opt['block-binance'] ? {
    coinbase: timeline.price?.venue === 'Coinbase' && (await panel.$eval('#priceLabel', (el) => el.textContent)).includes('Coinbase'),
    rememberedVenue: venueMemory?.binanceRequestsAgain === 0 && venueMemory?.venueAgain === 'Coinbase',
  } : {}),
  ...(opt['expect-trade'] ? { paperTrade: paperEvents.some((e) => e.type === 'open') } : {}),
};
const report = {
  mode,
  checks,
  matrix,
  price: timeline.price && { venue: timeline.price.venue, symbol: timeline.price.symbol, kind: timeline.price.kind, ticks: ticks.length, first: ticks[0]?.price, last: ticks.at(-1)?.price, firstTickAt: ticks[0]?.t, label: await panel.$eval('#priceLabel', (el) => el.textContent) },
  venueMemory,
  paper: timeline.paper && { events: paperEvents, pnl: timeline.paper.pnl },
  source: web ? opt.url : clip.id,
  asset,
  seconds,
  words: timeline.words.length,
  points: timeline.points.length,
  finalSignal: timeline.points.at(-1)?.signal ?? null,
  lagMs: { p50: timeline.stats.lagP50Ms, p95: timeline.stats.lagP95Ms, n: timeline.stats.lagCount },
  jev: { calls: timeline.stats.jevCalls, tokens: timeline.stats.jevTokens, costUsd: timeline.stats.jevCostUsd, p50Ms: timeline.stats.jevP50Ms, perHourUsd: timeline.stats.jevCostUsd / (seconds / 3600) },
  deepgram: { audioSeconds: timeline.stats.audioSeconds, costUsd: timeline.stats.deepgramCostUsd, perHourUsd: timeline.stats.deepgramCostUsd / (seconds / 3600) },
  reconnects: timeline.stats.reconnects,
  rejudges: timeline.stats.rejudges,
  errors: timeline.stats.errors,
  lampAfterStop: lamp,
  resources: { first: samples[0], last: samples.at(-1), samples },
  extensionErrors: errors,
  hoursOfAudio: hours,
};
fs.writeFileSync(path.join(outDir, `timeline-e2e-${tag}.json`), JSON.stringify({ report, timeline }, null, 1));
log(JSON.stringify({ ...report, resources: { first: report.resources.first, last: report.resources.last } }, null, 1));
await context0.close();
server.close();
fs.rmSync(userDataDir, { recursive: true, force: true });
const failed = Object.entries(checks).filter(([, ok]) => !ok).map(([k]) => k);
log(failed.length ? `FAIL: ${failed.join(', ')}` : `PASS: ${Object.keys(checks).join(', ')}`);
if (failed.length) process.exitCode = 1;
