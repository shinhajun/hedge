// Unit tests for paper trading and asset symbol parsing (no network).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PaperBook } from '../extension/paper.js';
import { baseSymbol } from '../extension/price.js';

test('opens and closes on threshold crossings, with hysteresis', () => {
  const book = new PaperBook({ enter: 0.35, exit: 0.15, notional: 10000 });
  assert.deepEqual(book.update(0.3, 100, 1), [], 'below +0.35: stay flat');
  assert.equal(book.update(0.4, 100, 2)[0].type, 'open');
  assert.equal(book.position.side, 'long');
  assert.deepEqual(book.update(0.2, 101, 3), [], 'between exit and entry: hold');
  const out = book.update(0.1, 102, 4);
  assert.equal(out[0].type, 'close');
  assert.equal(Math.round(out[0].pnl), 200, '+2% on $10,000');
  assert.equal(book.position, null);
});

test('flips straight from long to short when the signal crosses both thresholds at once', () => {
  const book = new PaperBook();
  book.update(0.5, 100, 1);
  const ev = book.update(-0.6, 90, 2);
  assert.deepEqual(ev.map((e) => `${e.type} ${e.side}`), ['close long', 'open short']);
  assert.equal(Math.round(book.trades[0].pnl), -1000);
  assert.equal(Math.round(book.pnl(81).open), 1000, 'short gains 10% when price falls 90 → 81');
  assert.equal(Math.round(book.pnl(81).total), 0);
});

test('never trades without a price', () => {
  const book = new PaperBook();
  assert.deepEqual(book.update(0.9, null, 1), []);
  assert.equal(book.position, null);
});

test('asset symbols', () => {
  assert.equal(baseSymbol('btc'), 'BTC');
  assert.equal(baseSymbol('BTCUSDT'), 'BTC');
  assert.equal(baseSymbol('eth-usd'), 'ETH');
  assert.equal(baseSymbol('$NVDA'), 'NVDA');
  assert.equal(baseSymbol('SPY'), 'SPY');
});
