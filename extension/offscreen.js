// Offscreen document: captures the tab (or the microphone), keeps the tab audible, and streams the
// audio to Deepgram. Results, status and diagnostics go to the side panel as runtime messages; the
// session's results are also kept so a panel that opens later can catch up.
import { checkDeepgramKey, deepgramProblem, SAMPLE_RATE } from './deepgram.js';
import { DeepgramStream } from './stream.js';

const LOG_LIMIT = 20000; // Results messages kept for a panel that attaches late
const SILENT_RMS = 0.0005; // a microphone this quiet is hearing nothing at all
const SILENT_AFTER_MS = 5000;

let capture = null;

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;
  if (msg.type === 'start') {
    start(msg).then(
      (startedAt) => sendResponse({ ok: true, startedAt }),
      (err) => {
        stop();
        sendResponse({ error: err.name === 'NotAllowedError' ? 'mic-blocked' : err.name === 'NotFoundError' || err.name === 'OverconstrainedError' ? 'mic-missing' : err.message });
      },
    );
    return true;
  }
  if (msg.type === 'stop') {
    stop();
    sendResponse({ ok: true });
  }
  if (msg.type === 'state') {
    sendResponse(capture ? { active: true, source: capture.source, tabId: capture.tabId, startedAt: capture.startedAt, log: capture.log, diag: diag() } : { active: false });
  }
  return false;
});

async function start({ source, tabId, streamId, deepgramKey, deviceId }) {
  stop();
  // A tab is captured as is. The microphone is listening to media, not to a call: echo cancellation
  // would subtract whatever this computer is playing (on a Mac, any app's sound) and noise suppression
  // eats speech under music, so both are off. Gain control stays on for a TV across the room.
  const audio = source === 'tab'
    ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
    : { deviceId: deviceId ? { exact: deviceId } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: true };
  const media = await navigator.mediaDevices.getUserMedia({ audio, video: false });
  const ctx = new AudioContext();
  await ctx.resume();
  if (ctx.state !== 'running') throw new Error('Chrome kept the audio engine paused.');
  const src = ctx.createMediaStreamSource(media);
  // Capturing a tab mutes it; play it back so the user still hears it. (Never the mic: it would echo.)
  if (source === 'tab') src.connect(ctx.destination);
  await ctx.audioWorklet.addModule('pcm-worklet.js');
  const node = new AudioWorkletNode(ctx, 'pcm16', { processorOptions: { rate: SAMPLE_RATE, chunkMs: 100 } });
  const sink = ctx.createGain();
  sink.gain.value = 0;
  src.connect(node).connect(sink).connect(ctx.destination);

  const startedAt = Date.now();
  const c = { source, tabId, startedAt, media, ctx, log: [], level: 0, quietSince: null, silent: false, lastError: null, device: media.getAudioTracks()[0]?.label || '' };
  const status = (state, detail) => {
    if (detail && state !== 'live') c.lastError = detail;
    send({ type: 'status', state, detail, startedAt });
  };
  c.stream = new DeepgramStream(deepgramKey, {
    onResult: (msg) => {
      c.log.push(msg);
      if (c.log.length > LOG_LIMIT) c.log.shift();
      send({ type: 'stt', msg, startedAt });
    },
    onStatus: async (state, detail) => {
      if (state === 'error' && detail === 'refused') {
        const { status: code } = await checkDeepgramKey(deepgramKey);
        status('error', deepgramProblem(code));
        if (capture === c) stop();
        return;
      }
      status(state, detail);
    },
  });
  node.port.onmessage = ({ data }) => {
    c.stream.push(data.pcm, data.rms);
    c.level = Math.max(c.level * 0.6, data.rms);
    // A microphone that hears nothing for 5 s while Deepgram is connected is a setup problem.
    if (source !== 'mic' || c.stream.socket !== 'open') return;
    if (data.rms >= SILENT_RMS) {
      c.quietSince = null;
      if (c.silent) {
        c.silent = false;
        status(c.stream.state);
      }
    } else if ((c.quietSince ??= Date.now()) && Date.now() - c.quietSince > SILENT_AFTER_MS && !c.silent) {
      c.silent = true;
      status('silent', 'The microphone hears nothing.');
    }
  };
  c.meter = setInterval(() => send({ type: 'level', ...diag(), startedAt }), 250);
  for (const track of media.getAudioTracks()) {
    track.onended = () => {
      status('ended', source === 'tab' ? 'The tab stopped sharing its audio.' : 'The microphone was disconnected.');
      stop();
    };
  }
  capture = c;
  c.stream.connect();
  return startedAt;
}

function diag() {
  const c = capture;
  if (!c) return {};
  const s = c.stream;
  return {
    source: c.source,
    level: c.level,
    state: c.silent ? 'silent' : s.state,
    device: c.device,
    sampleRate: c.ctx.sampleRate,
    socket: s.socket,
    closeInfo: s.closeInfo,
    bytesSent: s.bytesSent,
    results: s.results,
    words: s.finalWords,
    lastError: c.lastError,
    sentSeconds: s.sentSamples / SAMPLE_RATE,
    sessionSeconds: s.samples / SAMPLE_RATE,
    reconnects: s.reconnects,
  };
}

function stop() {
  if (!capture) return;
  const { media, ctx, stream, meter } = capture;
  capture = null;
  clearInterval(meter);
  stream.close();
  for (const t of media.getTracks()) t.stop();
  ctx.close().catch(() => {});
}
