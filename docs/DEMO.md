# SplitStock demo (3:00)

One story: **two launchpads, one result: each launch opens a stock pool.** Flap opens the NVDA pool, and Four.meme opens the TSLA pool. The same pool then shows leverage without liquidations, Atlas and CMC risk data, and the AI risk agent.

## Before recording (prep)
- Demo wallet holds tBNB, tNVDA and tTSLA (use the faucet on the pool page).
- **Flap:** a SPLIT crowdfund already exists and is partly filled, so one contribution fills it live.
- **Four.meme:** a meme raised in tTSLA is about 90% sold, so one buy sells it out live.
- **Keeper:** running for at least 15 minutes, so the Atlas price is fresh and CMC snapshots are on-chain.
- **App:** open at `/pools` in light mode, browser zoom 110%.

## Scenes

| # | Time | Page | What you do | What you say |
|---|---|---|---|---|
| 1 | 0:00–0:20 | `/pools` | Scroll the pool list. Point at NVDA (opened by Flap) and TSLA (opened by Four.meme). | "Tokenized stocks on BNB Chain have no leverage without liquidations, and no dollar backed by stock. SplitStock splits a stock pool into sUSD, a dollar, and xSTOCK, leverage that is never liquidated. Every launch opens a new pool." |
| 2 | 0:20–0:55 | `/launch` | Show the crowdfund (raised vs target). Contribute the remaining amount. The 7777 token launches and graduates on Flap. Click **Open pool**. | "This is our Flap launcher. When the crowdfund fills, it launches a tax token on Flap, and the raise becomes the first-loss capital of a new NVDA pool. Its trading tax funds a vault that protects the pool." |
| 3 | 0:55–1:25 | `/pools/nvda-flap` | Mint xNVDA, then mint sUSD. Show the split bar, leverage ≈ 2x, the price chip ("Atlas · 40 s ago") and the "Market closed · 1% fee" pill. | "The price comes from Atlas, the oracle Venus uses for bStocks. Nobody borrows here, so nobody gets liquidated. The stable side is always $1 of pool value." |
| 4 | 1:25–1:55 | `/scenario` | Click −22%: the sell zone brings leverage back to 2x. Click the CMC deviation shock: the mint is blocked by the breaker. Click −55%: the backstop vault covers. | "When leverage gets too high, the pool sells stock for USDC itself. If Atlas and CMC disagree, minting stops. In a crash, the Flap tax vault steps in." |
| 5 | 1:55–2:20 | `/risk` → `/agent` | Show Atlas vs CMC, the volatility value and the current trigger. Open the latest AI proposal: tighter limits before the half day or weekend. | "CoinMarketCap data sets the risk limits on-chain. Our AI risk agent reads CMC's market and event data and can only make the limits stricter. Loosening waits 30 minutes, and the guardian can veto it." |
| 6 | 2:20–2:45 | `/memes/[token]` → `/pools` | Buy the last part of the meme. Graduation opens the TSLA pool. Back on `/pools`, TSLA now says "Opened by Four.meme". | "Same result on Four.meme. When a meme raised in tokenized Tesla sells out, graduation opens a TSLA pool, and the meme trades against its dollar sUSD." |
| 7 | 2:45–3:00 | `/proof` | Show the address list, the BscScan links and one verified CMC log. | "Every price and every CMC call is provable on-chain. SplitStock: leverage on real-world stocks without liquidations." |

## Pages in demo order (app navigation)
`/pools` → `/launch` → `/pools/nvda-flap` → `/scenario` → `/risk` → `/agent` → `/memes` → `/proof`

Every page shows a small "Demo step N of 7" bar with a **Next** button that goes to the next page in this order.
