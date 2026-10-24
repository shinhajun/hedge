// Deepgram live transcription (Nova-3). Shared by the offscreen document and the scripts/ benches.

export const SAMPLE_RATE = 16000;

// Nova-3 monolingual streaming, pay as you go: $0.0048/min (promotional; list price $0.0077/min), plus
// $0.0013/min for keyterm prompting.
export const DEEPGRAM_USD_PER_MIN = 0.0048 + 0.0013;

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

// Keyterm prompting: words Nova-3 should expect. A short finance vocabulary plus the asset's own names.
// (Deepgram allows up to 500 tokens of keyterms; this stays near 100.)
const FINANCE_TERMS = [
  'price stability', 'inflation', 'basis points', 'guidance', 'EPS', 'earnings per share', 'gross margin',
  'operating margin', 'FOMC', 'Federal Reserve', 'rate cut', 'rate hike', 'tariffs', 'year over year',
  'free cash flow', 'buyback', 'dividend', 'recession', 'unemployment', 'CPI', 'Treasury yields', 'ETF',
];
const NAMES = {
  BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', XRP: 'Ripple', DOGE: 'Dogecoin', NVDA: 'NVIDIA', AAPL: 'Apple',
  MSFT: 'Microsoft', AMZN: 'Amazon', GOOGL: 'Alphabet', GOOG: 'Alphabet', META: 'Meta', TSLA: 'Tesla', AMD: 'AMD',
  INTC: 'Intel', NFLX: 'Netflix', JPM: 'JPMorgan', COIN: 'Coinbase', MSTR: 'MicroStrategy', SPY: 'S&P 500', QQQ: 'Nasdaq',
};
export function keytermsFor(asset = '', context = '') {
  const sym = asset.trim().toUpperCase().replace(/^\$/, '').replace(/[-/]?(USDT|USDC|USD)$/, '');
  // Proper names from "what's playing" (people, companies): capitalized words, at most four.
  const names = (context.match(/\b[A-Z][A-Za-z&.]{2,}\b/g) || []).filter((w) => !/^(The|And|For|With|Call|Speaking)$/.test(w)).slice(0, 4);
  return [...new Set([sym, NAMES[sym], ...names, ...FINANCE_TERMS].filter(Boolean))];
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
