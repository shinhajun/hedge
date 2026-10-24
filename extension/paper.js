// Paper trading: a simulated position that follows the signal. No orders, no exchange, no keys.
// Long when the signal reaches +ENTER, flat again when it falls back under +EXIT; short and flat the
// same way below zero. The gap between ENTER and EXIT (hysteresis) keeps a wobbling signal from
// trading on every word. Fills are at the live price when the signal crosses; no fees.

export const ENTER = 0.35;
export const EXIT = 0.15;
export const NOTIONAL = 10_000; // dollars per position

export class PaperBook {
  constructor({ enter = ENTER, exit = EXIT, notional = NOTIONAL } = {}) {
    Object.assign(this, { enter, exit, notional });
    this.position = null; // { side: 'long' | 'short', entry, t }
    this.trades = []; // closed, oldest first: { side, entry, exit, inT, outT, pnl }
  }

  // signal: −1…1 (the eased gauge). price: a live price, or null when there isn't one (no trading then).
  // t: session seconds. Returns what happened: [{ type: 'open' | 'close', side, price, t }].
  update(signal, price, t) {
    if (price == null) return [];
    const events = [];
    const pos = this.position;
    if (pos && ((pos.side === 'long' && signal < this.exit) || (pos.side === 'short' && signal > -this.exit))) {
      const pnl = this.pnlOf(pos, price);
      this.trades.push({ side: pos.side, entry: pos.entry, exit: price, inT: pos.t, outT: t, pnl });
      this.position = null;
      events.push({ type: 'close', side: pos.side, price, t, pnl });
    }
    if (!this.position) {
      const side = signal >= this.enter ? 'long' : signal <= -this.enter ? 'short' : null;
      if (side) {
        this.position = { side, entry: price, t };
        events.push({ type: 'open', side, price, t });
      }
    }
    return events;
  }

  pnlOf(pos, price) {
    return this.notional * (price / pos.entry - 1) * (pos.side === 'long' ? 1 : -1);
  }

  // Realized, open and total P&L in dollars at `price`.
  pnl(price) {
    const realized = this.trades.reduce((s, x) => s + x.pnl, 0);
    const open = this.position && price != null ? this.pnlOf(this.position, price) : 0;
    return { realized, open, total: realized + open };
  }
}
