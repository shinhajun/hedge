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

// Why a live connection failed, when the WebSocket can't say: a 0.1 s prerecorded request with the
// same key returns the HTTP status. 401 bad key, 402 out of credit, 403 no access to the model.
export async function checkDeepgramKey(apiKey) {
  const pcm = new Uint8Array(3200); // 0.1 s of 16 kHz silence
  try {
    const res = await fetch('https://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&channels=1', {
      method: 'POST',
      headers: { Authorization: `Token ${apiKey}`, 'Content-Type': 'application/octet-stream' },
      body: pcm,
      signal: AbortSignal.timeout(8000),
    });
    return { ok: res.ok, status: res.status };
  } catch {
    return { ok: false, status: 0 };
  }
}

export function deepgramProblem(status) {
  return {
    401: 'Deepgram rejected the key (401). Check it in Settings.',
    402: 'The Deepgram account is out of credit (402).',
    403: 'This Deepgram key can’t use the Nova-3 model (403).',
    0: 'Couldn’t reach Deepgram. Check the network.',
  }[status] || `Deepgram refused the connection (${status}).`;
}
