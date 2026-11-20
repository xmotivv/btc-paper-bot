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
npm run release:patch     # 0.1.0 -> 0.1.1, tags it and pushes it
```

The tag push triggers `.github/workflows/release.yml`. It runs the tests, builds the installer on a Windows runner, and publishes the release, which installed apps then pick up. (To do it by hand: bump `version` in `package.json`, commit, then `git tag v0.1.1 && git push --follow-tags`.)

> The repo must be **public** for auto-updates to work without putting a GitHub token inside the app. The code contains no secrets.

## How it works

Every 2 seconds the bot:

1. Gets the BTC/USD spot price from Coinbase.
2. Works out the current window's Polymarket market (`btc-updown-15m-<start>`) and loads the Up/Down order books.
3. Records the **price to beat**, which is BTC's price when the window opened.
4. Asks the active strategy what to do, then simulates fills by walking the real order book. Fees and slippage are configurable.
5. Settles finished windows using Polymarket's official result. If that hasn't come through after 10 minutes, it estimates the result from Coinbase candles and labels the trade "estimated".
6. Saves everything, and logs each market snapshot to `ticks/YYYY-MM-DD.jsonl` so you can analyse it later.

**Settings → Open data folder** shows `state.json` (the account and trades) and the tick logs.

### Realism caveats
- Polymarket settles with the **Chainlink** BTC/USD feed. Coinbase is close but not identical, so very close finishes can come out differently.
- Paper fills assume your order would have filled at the book prices shown, with no queue position and no other traders reacting to you.
- Set **Fee rate** in Settings to match Polymarket's current fees on these markets.

## The momentum strategy

Once a window has run for a while, if BTC has moved at least `minMoveBps` away from the price to beat **and** the last `lookbackSec` of price action is still pushing the same way, it buys that side. It only buys if the ask is still under `maxEntryPrice` and the spread is tight. Positions exit at take-profit or stop-loss, or are held to settlement. You can change every parameter under the **Strategy** tab while the bot runs.

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
    // ctx: now, market {slug,start,end}, btc {price, history[{t,p}]}, priceToBeat,
    //      quotes {Up:{bid,ask}, Down:{bid,ask}}, positions, balance, p (params), state
    return [ /* {type:'buy', outcome:'Up', usd: ctx.p.stakeUsd, reason:'...'} or {type:'sell', positionId, reason} */ ];
  },
};
```

Then register it in `src/core/strategies/index.js`. It shows up in the Strategy dropdown with a settings form built from `params`.

## Development

```bash
npm install
npm start        # run the app
npm test         # core logic tests (no network needed)
npm run dist     # build the installer locally into dist/
```
