// Deepgram live transcription (Nova-3). Shared by the offscreen document and the scripts/ benches.

export const SAMPLE_RATE = 16000;

// Nova-3 monolingual streaming, pay as you go: $0.0048/min (promotional; list price $0.0077/min).
export const DEEPGRAM_USD_PER_MIN = 0.0048;

export function deepgramUrl({ language = 'en', keyterms = [] } = {}) {
  const p = new URLSearchParams({
    model: 'nova-3',
    language,
    encoding: 'linear16',
    sample_rate: String(SAMPLE_RATE),
    channels: '1',
    interim_results: 'true',
    smart_format: 'true',
    // A pause this long finalizes the words before it; 1 s of silence ends the utterance.
    endpointing: '300',
    utterance_end_ms: '1000',
    vad_events: 'true',
  });
  for (const k of keyterms) p.append('keyterm', k);
  return `wss://api.deepgram.com/v1/listen?${p}`;
}

// Browsers can't set headers on a WebSocket; Deepgram reads the key from the subprotocol instead.
export const openDeepgram = (apiKey, opts) => new WebSocket(deepgramUrl(opts), ['token', apiKey]);

export const KEEPALIVE = JSON.stringify({ type: 'KeepAlive' });
export const CLOSE_STREAM = JSON.stringify({ type: 'CloseStream' });
