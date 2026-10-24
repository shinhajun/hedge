// Real-flow check in a real (headed) Chromium window on Xvfb, without the test shortcuts the headless
// e2e uses (no --allowlisted-extension-id, no fake microphone, no auto-accepted prompts):
//   1. keys go in through the Settings page, like a first run;
//   2. tab: one press of Alt+Shift+H (sent through X, so Chrome sees a real key press) on a tab playing
//      speech must open the side panel and bring words within a few seconds;
//   3. microphone: Microphone → Listen opens mic.html, the real Chrome prompt is accepted with a real
//      click, and words must arrive from a PipeWire virtual microphone that hears the tab playing;
//   4. a silent microphone must say so within ~5 s.
// Screenshots of the whole screen (side panel included) go to .e2e/real/.
// Needs Xvfb, xdotool, ffmpeg and PipeWire (pw-loopback). Usage: node scripts/e2e-real.js
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import { envKey, root } from './audio.js';

const DISPLAY = ':99';
const X = { ...process.env, DISPLAY };
const extDir = path.join(root, 'extension');
const out = path.join(root, '.e2e', 'real');
fs.mkdirSync(out, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const shot = (name) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'x11grab', '-video_size', '1600x1000', '-i', DISPLAY, '-frames:v', '1', path.join(out, name)]);
const xdo = (...args) => execFileSync('xdotool', args, { env: X }).toString().trim();
const results = {};
const check = (name, ok, detail) => {
  results[name] = { ok: !!ok, detail };
  log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`);
};

// ---- the display and two virtual microphones ----
const kids = [];
if (!fs.existsSync('/tmp/.X11-unix/X99')) {
  kids.push(spawn('Xvfb', [DISPLAY, '-screen', '0', '1600x1000x24', '-nolisten', 'tcp'], { stdio: 'ignore' }));
  await sleep(800);
}
const loop = (name, desc) => spawn('pw-loopback', [`--capture-props=media.class=Audio/Sink node.name=${name}_sink node.description=${desc}Sink`, `--playback-props=media.class=Audio/Source node.name=${name} node.description=${desc}`], { stdio: 'ignore' });
kids.push(loop('hedge_mic', 'HedgeTestMic'), loop('hedge_silent', 'HedgeSilentMic'));
await sleep(1500);
// Chrome plays into the test mic's sink, so the "microphone" hears whatever the tab plays, like a laptop
// mic hearing its own speakers.
execFileSync('wpctl', ['set-default', execFileSync('sh', ['-c', "wpctl status | grep -m1 'HedgeTestMicSink' | grep -o '[0-9]\\+' | head -1"]).toString().trim()]);
execFileSync('wpctl', ['set-default', execFileSync('sh', ['-c', "wpctl status | grep -m1 'HedgeTestMic ' | grep -o '[0-9]\\+' | head -1"]).toString().trim()]);

// ---- a page that plays a speech clip ----
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/audio/')) {
    const f = path.join(root, '.e2e', 'audio', path.basename(req.url));
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': fs.statSync(f).size });
    fs.createReadStream(f).pipe(res);
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<title>Powell clip</title><body style="font:20px sans-serif;padding:40px"><h1>Powell, Jackson Hole 2022</h1><audio src="/audio/duUBLlLBcdg.wav" autoplay loop controls></audio></body>');
});
await new Promise((r) => server.listen(0, r));
const port = server.address().port;

// ---- the browser ----
const cdpPort = 9300 + Math.floor(Math.random() * 500);
const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'hedge-real-')), {
  channel: 'chromium',
  headless: false,
  viewport: null,
  env: X,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, '--window-size=1600,1000', '--window-position=0,0', '--autoplay-policy=no-user-gesture-required', `--remote-debugging-port=${cdpPort}`],
});
const errors = [];
ctx.on('weberror', (e) => /chrome-extension:/.test(e.error().stack || '') && errors.push(e.error().message));

// The side panel isn't a Playwright page; reach it over the DevTools protocol.
async function sidePanel() {
  for (let i = 0; i < 40; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json();
    const t = targets.find((x) => x.url.endsWith('/panel.html'));
    if (t) {
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((r) => (ws.onopen = r));
      let id = 0;
      const pending = new Map();
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        pending.get(m.id)?.(m);
      };
      return {
        eval: (expression) => new Promise((resolve) => {
          const n = ++id;
          pending.set(n, (m) => resolve(m.result?.result?.value));
          ws.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
        }),
        close: () => ws.close(),
      };
    }
    await sleep(250);
  }
  throw new Error('the side panel never opened');
}
const offscreenState = (sw) => sw.evaluate(() => chrome.runtime.sendMessage({ target: 'offscreen', type: 'state' }).then((s) => (s?.active ? { source: s.source, diag: s.diag } : null)).catch(() => null));

try {
  // 1. First run: the Settings page opens by itself; paste both keys and test them.
  await sleep(1500);
  const settings = ctx.pages().find((p) => p.url().endsWith('/options.html'));
  check('settings page opens on install', settings);
  await settings.fill('#apiKey', envKey('TYPESAFE_API_KEY'));
  await settings.click('#jevForm button[type=submit]');
  await settings.waitForFunction(() => document.getElementById('jevResult').dataset.state === 'ok', null, { timeout: 15000 });
  await settings.fill('#deepgramKey', envKey('DEEPGRAM_API_KEY'));
  await settings.click('#dgForm button[type=submit]');
  await settings.waitForFunction(() => document.getElementById('dgResult').dataset.state === 'ok', null, { timeout: 15000 });
  check('both keys accepted in Settings', true);
  await settings.evaluate(() => chrome.storage.local.set({ asset: 'SPY', context: 'Fed Chair Jerome Powell, Jackson Hole speech, Aug 26 2022' }));
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent('serviceworker'));

  // 2. Tab, one gesture: Alt+Shift+H on the playing tab.
  const media = await ctx.newPage();
  await media.goto(`http://localhost:${port}/`);
  await sleep(1500);
  const win = xdo('search', '--onlyvisible', '--class', 'chromium').split('\n')[0];
  const t0 = Date.now();
  xdo('windowfocus', '--sync', win, 'key', '--clearmodifiers', 'alt+shift+h');
  let st = null;
  while (Date.now() - t0 < 15000) {
    st = await offscreenState(sw);
    if (st?.diag?.words > 0) break;
    await sleep(250);
  }
  check('tab: one key press → words', st?.source === 'tab' && st.diag.words > 0, st ? `${st.diag.words} words ${((Date.now() - t0) / 1000).toFixed(1)} s after the key press` : 'nothing captured');
  const panel = await sidePanel();
  await sleep(6000);
  const tabView = JSON.parse(await panel.eval(`JSON.stringify({ lamp: document.getElementById('lamp').dataset.state, hint: document.getElementById('target').textContent, points: globalThis.panel.session()?.judge?.points.length ?? 0, words: globalThis.panel.session()?.transcript.all().length })`));
  check('tab: the panel judges', tabView.lamp === 'live' && tabView.points > 0, JSON.stringify(tabView));
  await panel.eval(`document.getElementById('diag').open = true`);
  await sleep(600);
  shot('tab-oneclick.png');

  // Another tab, panel open: one line says what to do.
  const other = await ctx.newPage();
  await other.goto('about:blank');
  await sleep(800);
  const hint = await panel.eval(`document.getElementById('target').textContent`);
  check('other tab: one-line hint', /Click .*on this tab to listen/.test(hint), hint);
  shot('other-tab-hint.png');
  await other.close();
  await media.bringToFront();

  // 3. Microphone, through the real prompt.
  await panel.eval(`document.getElementById('go').click()`); // Stop
  await sleep(800);
  await panel.eval(`document.querySelector('[data-source=mic]').click()`);
  const micPage = ctx.waitForEvent('page', { timeout: 8000 });
  await panel.eval(`document.getElementById('go').click()`); // Listen
  const mic = await micPage;
  await mic.waitForLoadState();
  await mic.click('#allow');
  await sleep(1500);
  shot('mic-prompt.png');
  // "Allow while visiting the site" in Chrome's prompt, anchored under the address bar.
  xdo('mousemove', '285', '323', 'click', '1');
  const t1 = Date.now();
  st = null;
  while (Date.now() - t1 < 20000) {
    st = await offscreenState(sw);
    if (st?.source === 'mic' && st.diag.words > 0) break;
    await sleep(250);
  }
  check('mic: prompt accepted → words', st?.source === 'mic' && st.diag.words > 0, st ? `${st.diag.words} words from "${st.diag.device}" at ${st.diag.sampleRate} Hz, ${((Date.now() - t1) / 1000).toFixed(1)} s after Allow` : 'no capture');
  await sleep(5000);
  await media.bringToFront();
  await sleep(500);
  const micView = JSON.parse(await panel.eval(`JSON.stringify({ lamp: document.getElementById('lamp').dataset.state, device: document.getElementById('dDevice').textContent, sent: document.getElementById('dSent').textContent, points: globalThis.panel.session()?.judge?.points.length ?? 0 })`));
  check('mic: diagnostics show the device and traffic', micView.lamp === 'live' && micView.device && micView.device !== '–' && /[1-9]\d* words/.test(micView.sent), JSON.stringify(micView));
  await panel.eval(`document.getElementById('diag').open = true`);
  await sleep(400);
  shot('mic-live-diagnostics.png');

  // 4. A silent microphone says so.
  const silentId = await settings.evaluate(async () => (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === 'audioinput' && /Silent/.test(d.label))?.deviceId);
  await settings.evaluate((id) => chrome.storage.local.set({ micDevice: id }), silentId);
  await panel.eval(`(async () => { document.getElementById('go').click(); await new Promise((r) => setTimeout(r, 800)); document.getElementById('go').click(); })()`);
  const t2 = Date.now();
  let silent = null;
  while (Date.now() - t2 < 15000) {
    silent = JSON.parse(await panel.eval(`JSON.stringify({ lamp: document.getElementById('lamp').dataset.state, notice: document.getElementById('notice').textContent })`));
    if (silent.lamp === 'silent') break;
    await sleep(250);
  }
  check('silent mic is reported', silent?.lamp === 'silent' && /hears nothing/.test(silent.notice), `${JSON.stringify(silent)} after ${((Date.now() - t2) / 1000).toFixed(1)} s`);
  await sleep(500);
  shot('mic-silent-diagnostics.png');
  await settings.evaluate(() => chrome.storage.local.set({ micDevice: '' }));
  await panel.eval(`document.getElementById('go').click()`);
  panel.close();
  check('no extension errors', errors.length === 0, errors.join(' | '));
} catch (err) {
  check('run', false, err.message);
  shot('failure.png');
} finally {
  await ctx.close().catch(() => {});
  server.close();
  for (const k of kids) k.kill();
}
fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(results, null, 2));
const failed = Object.entries(results).filter(([, r]) => !r.ok);
log(failed.length ? `FAILED: ${failed.map(([k]) => k).join(', ')}` : 'ALL PASS');
process.exitCode = failed.length ? 1 : 0;
