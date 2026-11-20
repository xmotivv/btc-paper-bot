# BTC Paper Bot

A Windows desktop app that trades Polymarket's Bitcoin "Up or Down" markets (15-minute or 5-minute windows) using live BTC prices and real order books.

**Out of the box every trade is simulated**: it paper-trades, places no real orders and needs no wallet or API keys. Use it to try out strategies, collect data, and see what would have worked before you risk real money.

If you have a **Polymarket US** account you can also connect it and let chosen strategies trade real money, inside limits you set. That is strictly opt-in; see [Trading a real Polymarket US account](#trading-a-real-polymarket-us-account).

## Install

1. Open this repo's **Releases** page and download `BTC-Paper-Bot-Setup-x.y.z.exe`.
2. Run it. Windows SmartScreen may say "Windows protected your PC" because the installer isn't code-signed. Click **More info → Run anyway**.
3. Open **BTC Paper Bot** from the Start menu or desktop.

## Auto-updates

The app checks this repo's GitHub Releases on launch and every 30 minutes after that. It downloads new versions in the background. When an update is ready, an orange badge appears at the top. Click it to restart into the new version, or the update installs on its own the next time you close the app.

**To ship an update:**

```bash
# make your code changes, commit them, then:
npm run release:patch     # 0.1.0 -> 0.1.1, commits and pushes
```

Any push to `main` that changes the `version` in `package.json` triggers `.github/workflows/release.yml`. It runs the tests, builds the installer on a Windows runner, and publishes release `v<version>`, which installed apps then pick up. Versions that were already released are skipped. You can also edit the version straight on GitHub, or re-run the build from the **Actions** tab.

> The repo must be **public** for auto-updates to work without putting a GitHub token inside the app. The code contains no secrets.

## How it works

The bot is event driven. It keeps three public WebSocket feeds open (no keys needed) and re-runs every enabled strategy the moment any of them changes, so it reacts in milliseconds instead of waiting for a polling interval:

| Feed | Source | Used for |
| - | - | - |
| BTC/USD ticker | Coinbase | The fast price signal |
| Order books for Up and Down | Polymarket | Quotes, and the depth that paper fills walk |
| Chainlink BTC/USD | Polymarket's real-time data service | The feed these markets settle on |

Each feed reconnects by itself. While one is down the bot polls REST for it instead, so it keeps working without WebSockets (turn streaming off in **Settings** to always poll). The header shows **⚡ Live stream** or **Polling**.

That describes polymarket.com, the default exchange. With **Settings → Exchange** set to Polymarket US the Coinbase stream is the same, but the order book and settlement index are read from Polymarket US's API on a timer; see [What is different on Polymarket US](#what-is-different-on-polymarket-us).

About once a second a housekeeping pass also:

1. Works out the current window's market (`btc-updown-15m-<start>`) and, 30 seconds before it ends, loads the next one so its books are already streaming when it opens.
2. Records the **price to beat** for the window (see below).
3. Settles finished windows using Polymarket's official result, which usually arrives two to three minutes after a window ends. If it hasn't come through after 10 minutes, the bot works the result out itself from the Chainlink readings it recorded (or Coinbase candles if it has none) and labels the trade "estimated".
4. Saves state, and logs a market snapshot to `ticks/YYYY-MM-DD.jsonl` so you can analyse it later.

**Settings → Open data folder** shows `state.json` (the account and trades) and the tick logs.

### Fees

By default fills pay Polymarket's real taker fee, `shares × rate × price × (1 − price)`, with `rate` read from each market as Polymarket publishes it. The fee is largest at 50¢ and shrinks toward 0¢ and $1, which matters a lot for which strategies can work. **Settings → Fees** switches to a flat percentage instead.

### Price to beat and settlement

Polymarket settles these markets on Chainlink's BTC/USD feed, averaged over 60 seconds (a TWAP), not on any exchange's spot price:

- A window resolves **Up** if the average Chainlink price over its **final 60 seconds** is at or above the price to beat.
- The **price to beat** is that same 60-second average as the window opens — in other words, the number the previous window settled on. It is *not* the spot price at the open, and during a fast move the two can differ by tens of dollars.

The bot reads the Chainlink feed directly and computes both numbers the same way; that price to beat is marked **(Chainlink)**. Polymarket doesn't publish the figure through its API, so this is a reconstruction — it matched every official result checked while building this, but the last few cents aren't guaranteed. If the feed's history for a window's opening isn't available (the app was started mid-window, or the feed is unreachable) the price to beat is estimated from Coinbase and marked **(estimate)**. Fair-value edge and Late-window favourite sit those windows out, because an estimate can be wrong by more than the edge they trade on. The fair-value model also knows about the averaging: in the last minute, part of the result is already locked in.

### Realism caveats
- Paper fills assume your order would have filled at the book prices shown, with no queue position, no delay and no other traders reacting to you. The faster a strategy has to be to catch a price, the more optimistic this is.
- A paper position does not use up the real book, so strategies cap their own entries per window.
- Very close finishes can settle differently from the bot's estimate; the official result always wins when it arrives.

## Strategies

Any number of strategies can run at once. Each has its own switch, settings, positions and results under the **Strategies** tab, and they all trade the same paper account, so you can compare them side by side. A strategy only ever sees and closes its own positions. Switching one off stops new entries; positions it already holds still settle.

| Strategy | Idea | Character |
| - | - | - |
| **Momentum** | Buy the side BTC is already moving toward once a short-term trend confirms it and the price is still below your max entry. | Directional; exits at take-profit / stop-loss or settlement. |
| **Fair-value edge** | Estimate the chance of Up from BTC's distance to the price to beat, recent volatility and time left. Buy whichever side Polymarket quotes well below that after fees; sell if the market later overpays. | Trades the lag between spot and Polymarket quotes. Only as good as the model. |
| **Late-window favourite** | In the final minute or so, buy the side that is all but certain to win if it is still on offer below its modelled value, and hold to settlement. | Many small wins, occasional full loss. Benefits from the low fee near $1. |
| **Pair arbitrage** | Buy Up and Down together whenever one share of each costs less than $1 after fees. One side always pays $1. | Locked-in profit, but opportunities are rare, small and brief. Shows as one winning and one losing leg per pair. |

These are the approaches most often described for these markets. None of them is a guaranteed profit — that is what the paper account is for. Leave them running, then compare **Realised P&L**, win rate and trade count per strategy before trusting any of them.

The top cards show what the models see: **Model: chance of Up** is the fair-value estimate, **Cost of Up + Down** drops below $1.00 when a pair arbitrage exists before fees, and **Taker fee at these prices** is what a fill would pay right now.

## Closing positions yourself

Every row under **Open positions** has a **Close** button that sells that position into the live bids immediately; **Close all positions** does the same for everything open. Manual exits are marked `manual` in the trade history. After you close a position by hand, the strategy that opened it stays out of that market for the rest of the window, so it won't jump straight back in.

A position can only be sold while its window is still running. Once the window ends it shows **Settling…** and is paid out automatically when the result arrives.

## Discord notifications

The bot can post its trade activity to a Discord channel: every buy, sell, manual close and settlement, plus live trading being switched on or off and any problem with a real order. Real-money activity is marked 🔴 **LIVE**, paper activity 📄 paper.

1. In Discord, open the channel's settings → **Integrations** → **Webhooks**, create a webhook and **Copy Webhook URL**.
2. In the bot, open **Settings**, paste it under **Discord notifications** and press **Save**, then **Send test message** to check it arrives.

Untick **Send paper trades to Discord too** if you only want real trades reported. Messages are batched (a few trades in the same couple of seconds arrive as one message) and sending never delays trading; if Discord can't be reached the backlog is dropped after a few tries rather than piling up.

Anyone who has a webhook address can post to that channel, so the bot treats it like a password: it is stored encrypted by Windows on this PC, never written to `state.json`, the logs or this repository, and only ever shown masked. **Remove** deletes it.

## Trading a real Polymarket US account

Polymarket US (the CFTC-regulated exchange, [polymarket.us](https://polymarket.us)) lists its own BTC Up/Down 5- and 15-minute markets and has an official trading API. The bot can watch those markets instead of polymarket.com's, and place real orders on them with your account. polymarket.com itself is not supported for real trading.

### Setting it up

1. In the Polymarket US app, finish identity verification. Then sign in at [polymarket.us/developer](https://polymarket.us/developer) the same way you sign in to the app and create an API key. You get a **Key ID** and a **Secret key**; the secret is shown once.
2. In the bot, open **Live account**, paste both and press **Connect**. The bot reads your balance to check the key, switches itself to Polymarket US markets, opens the exchange's real-time order book stream, and stores the key encrypted by Windows on this PC only (never in `state.json`, never in logs). Connecting does not switch on real-money trading: with a key connected and nothing armed, every strategy paper trades on live Polymarket US data. **Disconnect and forget key** deletes it; you can also revoke the key on the developer page at any time.
3. Set your **limits** (defaults: $5 per order, $25 in open positions, switch off after losing $20 in a day).
4. On **Strategies**, tick **Real money** on each strategy you want trading your account. Everything else keeps paper trading.
5. Back on **Live account**, press **Arm live trading** and confirm.

Nothing spends real money until all of steps 2, 4 and 5 are done, and live trading is **always off again after the app restarts**. A red **■ STOP LIVE TRADING** button sits at the top of the window whenever it is armed: it stops new orders at once and cancels anything resting on the exchange.

### How real orders are handled

- A strategy trades either the paper account or the real one at any moment, never both. Real positions and trades are tagged **LIVE** everywhere; the paper account's numbers stay separate.
- Every order is an immediate-or-cancel limit order. It fills at the limit price or better right away, or not at all, so a quote that has moved can cause a missed trade but never a worse price.
- Orders are sized so that even if every share filled at the limit price, the cost including fees stays inside your per-order limit, your open-exposure limit and your account's buying power. A strategy's own stake is cut down to fit.
- The bot never retries an order. If it cannot tell what happened to one, or three orders in a row fail, or the exchange rejects the key, or the daily loss limit is hit, it switches live trading off and says why in the Activity log.
- The exchange nets Up against Down within a market, so the bot will not hold both sides of one window with real money.
- Before selling, the bot checks what the exchange says you hold. If you closed a position in the Polymarket app, the bot drops it rather than selling again.
- **Close** on a LIVE row sells that real position (after a confirmation) and works even when live trading is switched off. Switching off never closes positions by itself; they stay open until you close them or the window settles.
- The exchange pays out settled markets itself. The **Real account** panel shows the balance and buying power reported by Polymarket US; the bot's own live P&L figures are its bookkeeping of the trades it made.

### What is different on Polymarket US

| | polymarket.com | Polymarket US |
| - | - | - |
| Settlement index | Chainlink BTC/USD, 60-second average | CF Benchmarks BRTI, 60-second average |
| Price to beat | Rebuilt from the Chainlink feed | Published by the exchange (**official**); until it appears, the index reading for the open (**index**), which is the same number |
| Order book | Separate Up and Down books, streamed | One book for Up; Down is its mirror image, so Up + Down always costs $1 plus the spread and Pair arbitrage never triggers |
| Book updates | Pushed over WebSocket, no key needed | Pushed over WebSocket **only to a connected API key**. The public order book is a cached copy up to 30 seconds old: it is shown (the header says **delayed**) but strategies never act on it |
| Taker fee | `rate × p × (1 − p)` per share, rate read from the market | Same formula; the coefficient depends on your volume tier (0.095 at the lowest) |
| Result | A few minutes after the window | Usually within a minute |

Choose the exchange under **Settings → Exchange**. Paper trading on polymarket.com needs no key. On Polymarket US even paper trading needs a connected key, because that is the only way to get a current order book; the key just has to be connected, not armed.

### Before you risk money

- **The strategies are not proven.** Paper results on polymarket.com do not carry over: Polymarket US has different prices, liquidity and fees (4.75% of the trade at 50¢ on the lowest tier). Run the strategies on paper on Polymarket US first and look at the per-strategy results.
- **Nothing that needs a key has been exercised against the real exchange by its author**: not the real-time order book stream, not balances, not orders. All of it follows Polymarket US's published API and official SDK and is covered by tests against a simulated exchange, but your first connection and your first real orders are its first. After connecting, check that the header shows **⚡ US feed · live** and that the balance matches the app before going further. Start with the smallest limits, watch the first few trades in the Polymarket app as well as here, and raise limits only once the two agree.
- The fair-value model is least reliable when one side is priced under about 10¢ or over 90¢: it treats large moves as rarer than they are, so apparent edges there deserve suspicion.
- Run one copy of the bot per internet connection. Polymarket US counts requests per IP address, and two copies will trip its limit.
- Positions you open yourself in the Polymarket app are not managed by the bot.

## Adding a strategy

Create `src/core/strategies/myStrategy.js`:

```js
module.exports = {
  id: 'my-strategy',
  name: 'My Strategy',
  description: 'What it does',
  params: [{ key: 'stakeUsd', label: 'Stake ($)', type: 'number', default: 10, min: 1, max: 500 }],
  initState: () => ({}),
  onTick(ctx) {
    // ctx.now            current time (ms)
    // ctx.market         { slug, start, end, feeRate, twapSec }
    // ctx.btc            { price, history: [{ t, p }] }  (Coinbase, oldest → newest)
    // ctx.priceToBeat    may be null for the first second or two of a window
    // ctx.quotes         { Up: { bid, ask }, Down: { bid, ask } }
    // ctx.books          { Up: { bids, asks }, Down: { bids, asks } }  full depth, best first
    // ctx.vol            realised volatility, fraction per √second (null until known)
    // ctx.settle         { basis, twapSec, realisedMean, realisedSec }  for model.fairUp(ctx)
    // ctx.fee(price)     taker fee in dollars for one share at that price
    // ctx.positions      this strategy's open positions only
    // ctx.balance        cash available
    // ctx.p              your params;  ctx.state  your saved state (persisted)
    return [
      // { type: 'buy', outcome: 'Up', usd: ctx.p.stakeUsd, reason: '...' }
      // { type: 'buy', outcome: 'Up', shares: 50, maxPrice: 0.62, reason: '...' }
      // { type: 'sell', positionId, reason: '...' }
    ];
  },
};
```

Then register it in `src/core/strategies/index.js`. It appears under **Strategies** with a switch and a settings form built from `params`.

`onTick` runs on every market update — potentially dozens of times a second — so keep it cheap, and make it count its own entries per window (see the built-in strategies) because a paper fill does not remove liquidity from the real book. `require('../model')` gives you `priceAt`, `realisedVol`, `probUp` and `fairUp`.

## Development

```bash
npm install
npm start        # run the app
npm test         # core logic tests (no network needed)
npm run dist     # build the installer locally into dist/
```
