'use strict';
// One Discord message ("card") per open position: what it is, its unrealised
// P&L kept up to date, and a Close button. When the position is closed or
// settles, the card is rewritten with the final result and the button removed.
//
// Cards are kept current by editing the message, at most once every few
// seconds per position (Discord limits how often a bot may post and edit).
// The countdown is a Discord timestamp, which Discord itself keeps ticking, so
// a card only needs editing when the price or the size actually changes.

const EDIT_MS = 5000; // minimum time between edits of one card
const NEW_PER_SYNC = 3; // don't flood the channel if many positions appear at once
const GREEN = 0x2ecc71;
const RED = 0xff5c5c;
const GREY = 0x8b98a8;

const money = (n) => `${n >= 0 ? '+' : '−'}$${Math.abs(n).toFixed(2)}`;
const px = (n) => (n == null ? '—' : Number(n).toFixed(3));

/** The card for an open position. */
function renderOpen(p) {
  const mark = p.mark ?? p.avgPrice;
  const pnl = p.shares * mark - p.cost;
  const pct = p.cost > 0 ? (pnl / p.cost) * 100 : 0;
  return {
    embeds: [{
      title: `${p.live ? '🔴 LIVE' : '📄 Paper'} · ${p.outcome} · ${p.strategyName || p.strategy || ''}`.trim(),
      description: p.title,
      color: pnl >= 0 ? GREEN : RED,
      fields: [
        { name: 'Unrealised P&L', value: `**${money(pnl)}** (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%)`, inline: true },
        { name: 'Entry → now', value: `${px(p.avgPrice)} → ${px(mark)}`, inline: true },
        { name: 'Size', value: `${p.shares.toFixed(2)} shares · $${p.cost.toFixed(2)}`, inline: true },
        { name: p.canClose ? 'Window ends' : 'Window ended', value: `<t:${Math.round(p.windowEnd)}:R>`, inline: true },
      ],
    }],
    components: [{
      type: 1,
      components: [{ type: 2, style: 4, label: p.canClose ? 'Close position' : 'Settling…', custom_id: `close:${p.id}`, disabled: !p.canClose }],
    }],
    allowed_mentions: { parse: [] },
  };
}

/** The final card, from the last known state of the position and the trades that closed it. */
function renderClosed(last, trades) {
  const head = `${last.live ? '🔴 LIVE' : '📄 Paper'} · ${last.outcome} · ${last.strategyName || last.strategy || ''}`.trim();
  if (!trades.length) {
    return { embeds: [{ title: `Closed · ${head}`, description: last.title, color: GREY, fields: [{ name: 'Result', value: 'No longer tracked by the bot', inline: true }] }], components: [], allowed_mentions: { parse: [] } };
  }
  let pnl = 0;
  let shares = 0;
  let exit = 0;
  for (const t of trades) { pnl += t.pnl; shares += t.shares; exit += t.shares * t.exitPrice; }
  const lastTrade = trades[trades.length - 1];
  const how = lastTrade.exitType === 'manual' ? 'Closed by you' : lastTrade.exitType.startsWith('settled') ? `Settled — ${lastTrade.exitReason}${lastTrade.exitType.includes('estimated') ? ' (estimated)' : ''}` : `Sold — ${lastTrade.exitReason}`;
  return {
    embeds: [{
      title: `${pnl >= 0 ? '✅' : '❌'} ${money(pnl)} · ${head}`,
      description: last.title,
      color: pnl >= 0 ? GREEN : RED,
      fields: [
        { name: 'Result', value: `**${money(pnl)}**`, inline: true },
        { name: 'Entry → exit', value: `${px(last.avgPrice)} → ${px(shares ? exit / shares : null)}`, inline: true },
        { name: 'How', value: how.slice(0, 200), inline: true },
      ],
    }],
    components: [],
    allowed_mentions: { parse: [] },
  };
}

class PositionCards {
  constructor({ bot, state = {}, now = () => Date.now() }) {
    this.bot = bot;
    this.now = now;
    this.cards = new Map(); // position id -> { messageId, hash, editedAt, last, tries }
    for (const [id, c] of Object.entries(state || {})) if (c && c.messageId) this.cards.set(id, { messageId: c.messageId, last: c.last || null, hash: null, editedAt: 0, tries: 0 });
    this._busy = false;
  }

  /** What to save so cards can still be finished off after a restart (message ids are not secret). */
  snapshot() {
    const out = {};
    for (const [id, c] of this.cards) out[id] = { messageId: c.messageId, last: c.last };
    return out;
  }

  /**
   * Bring Discord in line with the current positions. `positions` are the open
   * ones (with strategyName, live, canClose); `tradesFor(id)` returns the trades
   * that closed a position. Never throws; one sync runs at a time.
   */
  async sync(positions, tradesFor) {
    if (this._busy || !this.bot.ready) return;
    this._busy = true;
    try {
      const open = new Map(positions.map((p) => [p.id, p]));
      let created = 0;
      for (const p of positions) {
        if (this.cards.has(p.id) || created >= NEW_PER_SYNC) continue;
        created++;
        const payload = renderOpen(p);
        try {
          const messageId = await this.bot.send(payload);
          if (messageId) this.cards.set(p.id, { messageId, hash: JSON.stringify(payload), editedAt: this.now(), last: slim(p), tries: 0 });
        } catch (e) {
          this.bot.lastError = e.message;
          this.bot.rev++;
          break; // the channel isn't accepting messages right now; try again next time
        }
      }
      for (const [id, c] of [...this.cards]) {
        const p = open.get(id);
        if (p) {
          c.last = slim(p);
          const payload = renderOpen(p);
          const hash = JSON.stringify(payload);
          if (hash === c.hash || this.now() - c.editedAt < EDIT_MS) continue;
          c.editedAt = this.now();
          try {
            await this.bot.edit(c.messageId, payload);
            c.hash = hash;
          } catch (e) {
            if (e.status === 404) this.cards.delete(id); // the message was deleted in Discord: post a fresh card next time
          }
          continue;
        }
        // the position is gone: write the result onto the card
        if (!c.last) { this.cards.delete(id); continue; }
        try {
          await this.bot.edit(c.messageId, renderClosed(c.last, tradesFor(id)));
          this.cards.delete(id);
        } catch (e) {
          if (e.status === 404 || ++c.tries >= 3) this.cards.delete(id);
        }
      }
    } finally {
      this._busy = false;
    }
  }
}

/** The few fields of a position the final card needs. */
function slim(p) {
  return { live: !!p.live, outcome: p.outcome, strategy: p.strategy, strategyName: p.strategyName, title: p.title, avgPrice: p.avgPrice };
}

module.exports = { PositionCards, renderOpen, renderClosed, EDIT_MS };
