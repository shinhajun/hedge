// Unit tests for finding a price source (fetch is mocked; no network).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findSource } from '../extension/price.js';

function mockFetch(routes) {
  const seen = [];
  globalThis.fetch = async (url) => {
    seen.push(url);
    const host = new URL(url).host;
    const status = routes[host] ?? 404;
    if (status === 'hang') return new Promise(() => {});
    return { ok: status === 200, status, json: async () => ({}) };
  };
  return seen;
}

test('Binance blocked (451, as from the US): Coinbase at once, and Binance reported for memory', async () => {
  mockFetch({ 'api.binance.com': 451, 'api.exchange.coinbase.com': 200 });
  const t = performance.now();
  const { source, failed } = await findSource('BTC');
  assert.equal(source.venue, 'Coinbase');
  assert.equal(source.symbol, 'BTC-USD');
  assert.deepEqual(failed, ['Binance']);
  assert.ok(performance.now() - t < 200, 'no waiting on a refused venue');
});

test('a remembered failure skips Binance without asking it', async () => {
  const seen = mockFetch({ 'api.binance.com': 200, 'api.exchange.coinbase.com': 200 });
  const { source } = await findSource('BTC', { skip: ['Binance'] });
  assert.equal(source.venue, 'Coinbase');
  assert.ok(!seen.some((u) => u.includes('binance')));
});

test('a stock ticker is not a Binance failure', async () => {
  mockFetch({ 'api.binance.com': 400, 'api.exchange.coinbase.com': 404, 'query1.finance.yahoo.com': 500, 'query2.finance.yahoo.com': 500, 'api.nasdaq.com': 500 });
  const { source, failed } = await findSource('SPY');
  assert.equal(source, null);
  assert.ok(!failed.includes('Binance') && !failed.includes('Coinbase'));
});
