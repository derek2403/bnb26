# MORE demo (under 3:00)

One story: **each launch opens a stock pool.** A launch on Flap opened the NVDA pool and funds its insurance vault; a meme graduating on Four.meme opens the TSLA pool. The same pool then shows leverage without liquidations, Atlas and CMC risk data, and the AI risk agent.

Users only ever see three things in the app: **sUSD** (a dollar backed by the stock), **xNVDA / xTSLA** (about 2x leverage, never liquidated) and the pool's **insurance vault** (a $ buffer). The launch token stays backstage: it is shown only on Flap's own site in scene 2, and the app never names it.

> **App redesign in progress (2026-11-27).** The app now has four pages and the old routes below redirect: `/pools` → `/` (Markets), `/pools/:id` → `/trade/:id`, `/scenario` → the **Stress test** button on `/trade/nvda-flap` (on-chain sandbox), `/risk` and `/agent` → the **Risk & AI** tab on `/trade/nvda-flap`, `/memes` → `/launchpad`, `/proof` and `/backstop` → `/transparency`. The "Demo step N of 6" bar was removed with `demoFlow.ts`. The scene table still uses the old route names until the redesign settles.

## Before recording (prep)
- **Demo wallet** holds tBNB, tNVDA and tTSLA (faucet button on the pool page).
- **Keeper** running from the team wallet for at least 15 minutes, with `FLAP_DISPATCH=true`: the Atlas price is fresh, CMC snapshots are on-chain, and the Flap fees reach the insurance vault on their own (`bash services/scripts/keeper-97.sh status`).
- **Flap tab** open on the launcher page (link in scene 2), scrolled so the raise, the "Opened pool" state and the vault panel are visible.
- **Four.meme:** the **TSLA Market (TSLAM)** launch (token `0xDf99BC0b04a166Dd3C21dDe4dA4a16e8Ad4981a3`, raised in tTSLA) sits at 90% sold: 720,000 / 800,000 TSLAM, 3.6 / 4.0 tTSLA raised. One buy of the remaining **80,000 TSLAM** for **0.406 tTSLA** (0.400 + 0.006 fee; set max pay 0.410) sells it out live and opens the TSLA market. Send that buy with a **gas limit of at least 12M** (15M recommended; the graduation uses about 6M). Do not buy it before recording. (GPU Goblin and Test Rocket are retired and hidden in `deployments/97.json`.)
- **Insurance vault buffer > $0** (check `/backstop`). It fills only from trading fees on the Flap token, which the keeper dispatches; at $0 the −55% click in scene 4 shows the loss order instead of a cover. The scenario tranche may draw at most 20% of the buffer per day.
- **Scenario pool** reset to the Atlas anchor (`services/scripts/scenario-prep-97.sh` after any −22% take).
- **App** open at `/pools` in light mode, browser zoom 110%, Demo mode on.

## Scenes

| # | Time | Page | What you do | What you say |
|---|---|---|---|---|
| 1 | 0:00–0:20 | `/pools` | Scroll the pool list. Point at the badges: NVDA "Opened by Flap", TSLA "Opened by Four.meme". | "Tokenized stocks on BNB Chain have no leverage without liquidations, and no dollar backed by stock. MORE splits a stock pool into sUSD, a dollar, and xSTOCK, leverage that is never liquidated. Every launch opens a new pool." |
| 2 | 0:20–0:40 | **Flap's site** ([launcher page](https://test.utter.cash/launcher/0x56ceF14ae0171Fb3DFa04DD44EA0811E3D8517c4?chain=bnb-testnet&kind=launcher-detail&artifactPath=%2Fvault-ui%2Fsplitstock-backstop-launcher%2F2adfd16039f7631c971363f1dc5b95c8b378c83f07db871caba130104bbcd2f6)) | Show the filled raise, the "pool opened" state, then scroll to the vault panel (buffer, first-loss xNVDA held). Switch back to the app. | "We launched through Flap. That launch opened this NVIDIA pool and funds its insurance vault: the raise became the pool's first-loss capital, and the launch's trading fees keep filling the vault." |
| 3 | 0:40–1:10 | `/pools/nvda-flap` | Mint xNVDA, then mint sUSD. Show the split bar, leverage ≈ 2x, the price chip ("Atlas · 40 s ago"), the market pill and the **Insurance vault** card ($ buffer). | "The price comes from Atlas, the oracle Venus uses for bStocks. Nobody borrows here, so nobody gets liquidated. The stable side is always $1 of pool value, and the insurance vault sits behind it." |
| 4 | 1:10–1:45 | `/scenario` | Click **CMC deviation**: the mint is blocked by the breaker. Click **−55%**: the insurance vault covers. Click **Reset**, then **−22%**: the sell zone brings leverage back to 2x. | "If Atlas and CMC disagree, minting stops. In a crash, the insurance vault steps in. And when leverage gets too high, the pool sells stock for USDC itself." |
| 5 | 1:45–2:10 | `/risk` → `/agent` | Show Atlas vs CMC, the volatility value and the current trigger. Open the latest AI proposal: tighter limits before the half day or weekend. | "CoinMarketCap data sets the risk limits on-chain. Our AI risk agent reads CMC's market and event data and can only make the limits stricter. Loosening waits 30 minutes, and the guardian can veto it." |
| 6 | 2:10–2:35 | `/memes/[token]` → `/pools` | Buy the last 80,000 TSLA Market (TSLAM) for 0.406 tTSLA (gas limit ≥ 12M). Graduation opens the TSLA pool. Back on `/pools`, TSLA now says "Opened by Four.meme". | "Same result on Four.meme. When the TSLA Market launch, raised in tokenized Tesla, sells out, graduation opens the TSLA pool, and the launch token trades against its dollar sUSD." |
| 7 | 2:35–2:55 | `/proof` | Show the address list, the BscScan links and one verified CMC log. | "Every price and every CMC call is provable on-chain. MORE: leverage on real-world stocks without liquidations." |

Total: about 2:55, leaving a few seconds of slack.

## Pages in demo order (app navigation)

`/pools` → *(scene 2 on Flap's site)* → `/pools/nvda-flap` → `/scenario` → `/risk` → `/agent` → `/memes` → `/proof`

Every app page in this list shows a small "Demo step N of 6" bar with a **Next** button that goes to the next page. Scene 2 is not an app page, so the bar's numbering skips it:

| Bar step | Scene | Page |
|---|---|---|
| 1 | 1 | `/pools` (after it, switch to the Flap tab for scene 2) |
| 2 | 3 | `/pools/nvda-flap` |
| 3 | 4 | `/scenario` |
| 4 | 5 | `/risk`, `/agent` |
| 5 | 6 | `/memes` |
| 6 | 7 | `/proof` |

The old `/launch` page still exists for direct links, but it is not in the nav or the demo bar and is not used in the recording. The insurance vault has no manual dispatch button: the keeper moves the Flap fees into it.

## If something goes wrong
- **Price chip says stale:** the keeper is not pushing. `keeper-97.sh status`, then restart it; wait one 15 s mirror tick.
- **−55% says the vault cannot cover yet:** its buffer is still empty. Narrate the loss order shown in the log (sUSD would redeem pro rata), then continue.
- **TSLAM buy reverts:** send it with a gas limit ≥ 12M (15M recommended; the meme page does this by default). The sell-out buy is 80,000 TSLAM for 0.406 tTSLA (max pay 0.410).
