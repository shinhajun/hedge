// Offscreen document: captures the tab (or the microphone), keeps the tab audible, and streams the
// audio to Deepgram. Results and status go to the side panel as runtime messages.
import { SAMPLE_RATE } from './deepgram.js';
import { DeepgramStream } from './stream.js';

let capture = null;

const send = (msg) => chrome.runtime.sendMessage(msg).catch(() => {});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== 'offscreen') return false;
  if (msg.type === 'start') {
    start(msg).then(
      () => sendResponse({ ok: true }),
      (err) => {
        stop();
        sendResponse({ error: err.name === 'NotAllowedError' ? 'mic-blocked' : err.message });
      },
    );
    return true;
  }
  if (msg.type === 'stop') {
    stop();
    sendResponse({ ok: true });
  }
  return false;
});

async function start({ source, streamId, deepgramKey }) {
  stop();
  const audio = source === 'tab'
    ? { mandatory: { chromeMediaSource: 'tab', chromeMediaSourceId: streamId } }
    : { echoCancellation: true, noiseSuppression: true, autoGainControl: true };
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
  const stream = new DeepgramStream(deepgramKey, {
    onResult: (msg) => send({ type: 'stt', msg }),
    onStatus: (state, detail) => send({ type: 'status', state, detail, startedAt }),
  });
  let level = 0;
  node.port.onmessage = ({ data }) => {
    stream.push(data.pcm, data.rms);
    level = Math.max(level * 0.6, data.rms);
  };
  const meter = setInterval(() => {
    send({ type: 'level', level, state: stream.state, sentSeconds: stream.sentSamples / SAMPLE_RATE, sessionSeconds: stream.samples / SAMPLE_RATE, reconnects: stream.reconnects, startedAt });
  }, 250);
  for (const track of media.getAudioTracks()) {
    track.onended = () => {
      send({ type: 'status', state: 'ended', detail: source === 'tab' ? 'The tab stopped sharing its audio.' : 'The microphone was disconnected.', startedAt });
      stop();
    };
  }
  capture = { media, ctx, stream, meter };
  stream.connect();
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
