# BTC Paper Bot

A Windows desktop app that **paper-trades** Polymarket's Bitcoin "Up or Down" markets (15-minute or 5-minute windows). It uses live BTC prices and real Polymarket order books, but **every trade is simulated. It never places real orders and needs no wallet or API keys.**

Use it to try out strategies, collect data, and see what would have worked before you risk real money.

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
