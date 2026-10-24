// Live price for the asset, keyless. Crypto streams trades over a WebSocket: Binance first, then
// Coinbase, since Binance refuses US addresses. Stocks and ETFs poll Yahoo's chart endpoint, then
// Nasdaq's quote API, every few seconds; those are as live as the market (closed nights and weekends).
// Ticks carry wall-clock time; the panel puts them on the session clock.

const STOCK_POLL_MS = 5000;
const TICK_MS = 250; // at most 4 crypto ticks a second

// "btc", "BTCUSDT", "BTC-USD", "btc/usd" → "BTC"; "brk.b" → "BRK-B".
export function baseSymbol(asset) {
  const a = asset.trim().toUpperCase().replace(/^\$/, '');
  const crypto = a.match(/^([A-Z0-9]{2,10}?)[-/]?(USDT|USDC|USD)$/);
  return crypto ? crypto[1] : a;
}

async function getJson(url, ms = 6000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms), credentials: 'omit' });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

const PROBE_MS = 2500; // a blocked venue (Binance from the US answers 451) must not hold up the fallback

// Finds a source for the asset: { kind: 'crypto' | 'stock', venue, symbol, open(onTick) → close }.
// `skip`: venues known not to work here. Returns { source, failed } (failed: venues that didn't answer).
export async function findSource(asset, { skip = [] } = {}) {
  const sym = baseSymbol(asset);
  const tries = [
    ['Binance', async () => {
      await getJson(`https://api.binance.com/api/v3/ticker/price?symbol=${sym}USDT`, PROBE_MS);
      return { kind: 'crypto', venue: 'Binance', symbol: `${sym}USDT`, open: (cb) => binance(`${sym}USDT`, cb) };
    }],
    ['Coinbase', async () => {
      await getJson(`https://api.exchange.coinbase.com/products/${sym}-USD/ticker`, PROBE_MS);
      return { kind: 'crypto', venue: 'Coinbase', symbol: `${sym}-USD`, open: (cb) => coinbase(`${sym}-USD`, cb) };
    }],
    ['Yahoo', async () => {
      const ticker = sym.replace('.', '-');
      const quote = await yahoo(ticker);
      return { kind: 'stock', venue: 'Yahoo', symbol: ticker, first: quote, open: (cb) => poll(() => yahoo(ticker), cb) };
    }],
    ['Nasdaq', async () => {
      const quote = await nasdaq(sym);
      return { kind: 'stock', venue: 'Nasdaq', symbol: sym, first: quote, open: (cb) => poll(() => nasdaq(sym), cb) };
    }],
  ];
  const failed = [];
  for (const [venue, t] of tries) {
    if (skip.includes(venue)) continue;
    try {
      return { source: await t(), failed };
    } catch (err) {
      // An unreachable crypto venue is remembered (Binance refuses US addresses with 451). A 400/404 only
      // means the symbol isn't listed there, and stock sources are just asked again next time.
      const refused = !/^4\d\d$/.test(err.message) || err.message === '451' || err.message === '403';
      if (refused && (venue === 'Binance' || venue === 'Coinbase')) failed.push(venue);
    }
  }
  return { source: null, failed };
}

function binance(symbol, cb) {
  return socket(`wss://stream.binance.com:9443/ws/${symbol.toLowerCase()}@aggTrade`, null, (m) => m.p && { price: Number(m.p), at: m.T }, cb);
}

function coinbase(product, cb) {
  const sub = JSON.stringify({ type: 'subscribe', product_ids: [product], channels: ['ticker'] });
  return socket('wss://ws-feed.exchange.coinbase.com', sub, (m) => m.type === 'ticker' && { price: Number(m.price), at: Date.parse(m.time) }, cb);
}

// A WebSocket that reconnects and passes on at most one tick per TICK_MS (the latest).
function socket(url, hello, parse, cb) {
  let ws, closed = false, retry, last = 0, pending = null, flush;
  const connect = () => {
    ws = new WebSocket(url);
    ws.onopen = () => hello && ws.send(hello);
    ws.onmessage = (e) => {
      const tick = parse(JSON.parse(e.data));
      if (!tick || !Number.isFinite(tick.price)) return;
      pending = { ...tick, live: true };
      const wait = last + TICK_MS - Date.now();
      if (wait <= 0) {
        last = Date.now();
        cb(pending);
        pending = null;
      } else flush ||= setTimeout(() => {
        flush = null;
        if (pending) {
          last = Date.now();
          cb(pending);
          pending = null;
        }
      }, wait);
    };
    ws.onclose = () => !closed && (retry = setTimeout(connect, 2000));
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(retry);
    clearTimeout(flush);
    ws.close();
  };
}

function poll(get, cb) {
  let stopped = false, timer;
  const run = async () => {
    try {
      cb(await get());
    } catch {}
    if (!stopped) timer = setTimeout(run, STOCK_POLL_MS);
  };
  run();
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}

// `live`: the quote is from a trading session that is open now.
async function yahoo(ticker) {
  const errs = [];
  for (const host of ['query1', 'query2']) {
    try {
      const j = await getJson(`https://${host}.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(ticker)}?interval=1m&range=1d&includePrePost=true`);
      const m = j.chart.result[0].meta;
      const now = Date.now() / 1000;
      const p = m.currentTradingPeriod || {};
      const open = ['pre', 'regular', 'post'].some((k) => p[k] && now >= p[k].start && now < p[k].end);
      return { price: m.regularMarketPrice, at: m.regularMarketTime * 1000, live: open && now - m.regularMarketTime < 300, currency: m.currency };
    } catch (err) {
      errs.push(err.message);
    }
  }
  throw new Error(`Yahoo: ${errs.join(', ')}`);
}

async function nasdaq(sym) {
  for (const assetclass of ['stocks', 'etf']) {
    const j = await getJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/info?assetclass=${assetclass}`).catch(() => null);
    const d = j?.data?.primaryData;
    if (!d?.lastSalePrice) continue;
    const price = Number(d.lastSalePrice.replace(/[$,]/g, ''));
    if (!Number.isFinite(price)) continue;
    return { price, at: Date.now(), live: j.data.marketStatus === 'Open' && d.isRealTime !== false, currency: 'USD' };
  }
  throw new Error('Nasdaq: no quote');
}
