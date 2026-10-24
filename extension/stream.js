// One live Deepgram session that survives silence and dropped sockets. Shared by the offscreen document
// and scripts/harness.js.
// - Silence: after QUIET_AFTER_MS of quiet audio, audio stops going out (and stops being billed);
//   KeepAlive messages hold the socket open until sound returns.
// - Drops: the socket reconnects with backoff and re-sends the audio after the last final word, which
//   it keeps for REPLAY_SECONDS. Words already final are not passed on again, so none are lost or doubled.
// Word times are rewritten to session time: seconds of audio captured since the session started.
import { CLOSE_STREAM, KEEPALIVE, openDeepgram, SAMPLE_RATE } from './deepgram.js';

const QUIET_RMS = 0.003;
const QUIET_AFTER_MS = 2500;
const KEEPALIVE_MS = 4000;
const REPLAY_SECONDS = 30;

export class DeepgramStream {
  // onResult(msg): a Deepgram Results message in session time. onStatus(state, detail):
  // state is 'connecting' | 'live' | 'paused' (silence) | 'reconnecting' | 'error'.
  constructor(apiKey, { onResult, onStatus, opts } = {}) {
    Object.assign(this, { apiKey, onResult, onStatus, opts });
    this.samples = 0; // captured
    this.sentSamples = 0; // sent to Deepgram (what it bills)
    this.buffer = []; // recent chunks, for replay
    this.lastFinalEnd = 0; // session seconds
    this.quietMs = 0;
    this.paused = false;
    this.attempt = 0;
    this.everOpened = false;
    this.reconnects = 0;
    this.closed = false;
  }

  get state() {
    if (this.ws?.readyState !== 1) return this.everOpened ? 'reconnecting' : 'connecting';
    return this.paused ? 'paused' : 'live';
  }

  connect() {
    this.onStatus?.(this.state);
    const ws = openDeepgram(this.apiKey, this.opts);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.socketSamples = 0;
    this.segments = []; // { socket, session, end } sample offsets: how socket time maps to session time
    ws.onopen = () => {
      if (this.everOpened) this.reconnects++;
      this.everOpened = true;
      this.attempt = 0;
      this.replay();
      this.onStatus?.(this.state);
      this.keepalive = setInterval(() => this.paused && ws.readyState === 1 && ws.send(KEEPALIVE), KEEPALIVE_MS);
    };
    ws.onmessage = (e) => this.receive(JSON.parse(e.data));
    ws.onclose = () => {
      clearInterval(this.keepalive);
      if (this.closed || ws !== this.ws) return;
      if (!this.everOpened && this.attempt >= 2) {
        this.onStatus?.('error', 'Deepgram refused the connection. Check the Deepgram key in settings.');
        return;
      }
      const wait = Math.min(8000, 400 * 2 ** this.attempt++);
      this.onStatus?.(this.state);
      this.retry = setTimeout(() => this.connect(), wait);
    };
  }

  close() {
    this.closed = true;
    clearTimeout(this.retry);
    clearInterval(this.keepalive);
    if (this.ws?.readyState === 1) this.ws.send(CLOSE_STREAM);
    else this.ws?.close();
  }

  // pcm: Int16Array at SAMPLE_RATE. rms: its loudness, 0..1.
  push(pcm, rms) {
    const at = this.samples;
    this.samples += pcm.length;
    this.buffer.push({ at, pcm });
    while (this.buffer.length && this.buffer[0].at < this.samples - REPLAY_SECONDS * SAMPLE_RATE) this.buffer.shift();
    this.quietMs = rms < QUIET_RMS ? this.quietMs + (pcm.length / SAMPLE_RATE) * 1000 : 0;
    const quiet = this.quietMs >= QUIET_AFTER_MS;
    if (quiet !== this.paused) {
      this.paused = quiet;
      this.onStatus?.(this.state);
    }
    if (!quiet) this.send(at, pcm);
  }

  send(at, pcm) {
    if (this.ws?.readyState !== 1) return; // kept in the buffer; replayed after reconnecting
    const seg = this.segments[this.segments.length - 1];
    if (seg && seg.end === at) seg.end += pcm.length;
    else this.segments.push({ socket: this.socketSamples, session: at, end: at + pcm.length });
    this.ws.send(pcm);
    this.socketSamples += pcm.length;
    this.sentSamples += pcm.length;
  }

  replay() {
    const from = Math.floor(this.lastFinalEnd * SAMPLE_RATE);
    for (const c of this.buffer) if (c.at + c.pcm.length > from) this.send(c.at, c.pcm);
  }

  // Socket seconds → session seconds.
  toSession(t) {
    const s = t * SAMPLE_RATE;
    let seg = this.segments[0];
    for (const x of this.segments) if (x.socket <= s) seg = x;
    return seg ? (seg.session + s - seg.socket) / SAMPLE_RATE : t;
  }

  receive(msg) {
    if (msg.type !== 'Results') return;
    const alt = msg.channel?.alternatives?.[0] || { words: [] };
    const words = alt.words
      .map((w) => ({ ...w, start: this.toSession(w.start), end: this.toSession(w.end) }))
      .filter((w) => w.start >= this.lastFinalEnd - 0.05);
    if (msg.is_final) this.lastFinalEnd = Math.max(this.lastFinalEnd, this.toSession(msg.start + msg.duration));
    this.onResult?.({
      type: 'Results',
      is_final: msg.is_final,
      speech_final: msg.speech_final,
      channel: { alternatives: [{ transcript: words.map((w) => w.punctuated_word || w.word).join(' '), words }] },
    });
  }
}
