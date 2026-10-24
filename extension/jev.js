// Jev (TypeSafe System One) client. Shared by the side panel and the scripts/ benches.
// Adapted from Picky's extension/jev.js.

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
export const JEV_MODEL = 'jev-latest';

// Jev bills input tokens only ($0.042 per million); output tokens are free.
export const USD_PER_INPUT_TOKEN = 0.042 / 1_000_000;
export const costOf = (inputTokens) => inputTokens * USD_PER_INPUT_TOKEN;

// Default limit is 32k tokens per question (state + one question). Above this estimate, ask for long context.
const LONG_CONTEXT_FROM_CHARS = 26_000 * 4;

// Amounts are tiny: totals show 4 decimals (or <$0.0001); per-unit costs show 2 significant digits.
export function formatUsd(usd, { perUnit = false } = {}) {
  if (!usd) return '$0';
  if (perUnit) return `$${usd.toFixed(Math.max(2, 1 - Math.floor(Math.log10(usd))))}`;
  if (usd < 0.0001) return '<$0.0001';
  return `$${usd.toFixed(usd < 1 ? 4 : 2)}`;
}

export class JevError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// POST one System One request. Retries 429/529/network errors with exponential backoff.
export async function callJev(apiKey, { state, questions }, { retries = 3, timeoutMs = 20000 } = {}) {
  const body = JSON.stringify({ model: JEV_MODEL, state, questions });
  const headers = { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
  if (body.length > LONG_CONTEXT_FROM_CHARS) headers['TypeSafe-Danger-Zone-Long-Context'] = 'true';
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(JEV_URL, { method: 'POST', headers, body, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (attempt >= retries) throw new JevError(0, `Network error: ${err.message}`);
      await sleep(backoff(attempt));
      continue;
    }
    if (res.ok) return res.json();
    if ((res.status === 429 || res.status === 529) && attempt < retries) {
      const retryAfter = Number(res.headers.get('retry-after'));
      await sleep(retryAfter > 0 ? retryAfter * 1000 : backoff(attempt));
      continue;
    }
    const text = await res.text().catch(() => '');
    throw new JevError(res.status, `Jev ${res.status}: ${text.slice(0, 200)}`);
  }
}

function backoff(attempt) {
  return Math.min(4000, 300 * 2 ** attempt) * (0.75 + Math.random() * 0.5);
}
