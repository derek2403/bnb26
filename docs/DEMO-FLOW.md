# MORE demo flow

**MORE: leverage on real stocks, no liquidations.** This is the script for the recorded demo: launch a market, trade it, explain the mechanism, and show where Atlas fits. It replaces the older scene table in `DEMO.md`.

Target length: about 3 minutes. All of it runs on BSC testnet from `http://localhost:3000`.

## Before you record

| Check | How |
|---|---|
| App and keeper are running | `http://localhost:3000` loads; the NVDA trade page shows "Atlas · under 2 min ago" |
| MetaMask is on the demo wallet, BSC Testnet | It needs about 0.05 tBNB and at least 1 tNVDA (faucet button on the trade page) |
| Sandbox is at the live price | Sandbox page shows "0.0% vs live". If not, click **Live price** |
| Sandbox has no old position of yours | "Your portfolio" says "No 2x position yet". If not, click **Close** |
| Funding wallet can pay one raise | It needs 4.8 tBNB. It holds about 5.3 now, enough for one NVDA fund |
| Browser | Light mode, zoom 110%, one tab |

The price buttons, the sandbox setup and the Fund buttons are signed by a server-side testnet key, so they never open MetaMask. You only confirm your own launch and your own trades.

Two things can only be recorded once:

- **The −20% step.** The sell zone permanently swaps part of the sUSD owners' stake. After one take their card starts at about 834 sUSD + 5.4 tNVDA instead of 1,484 sUSD.
- **Fund and open the TSLA market.** There is one TSLA Market launch. Once it graduates it stays graduated.

## The flow

| # | Time | Page | What you do | What to say |
|---|---|---|---|---|
| 1 | 0:00–0:20 | Markets | Scroll the list. Point at NVDA, "Opened by Flap", and TSLA, "Launching · Opened by Four.meme". | "Tokenized stocks on BNB Chain have no leverage without liquidations. MORE splits each stock pool into two tokens: sUSD, a dollar backed by the stock, and xSTOCK, about 2x exposure that is never liquidated." |
| 2 | 0:20–0:50 | Launch a market | Pick **NVDA**, set the leverage slider, keep 4.7 tBNB, click **Send to Flap for pre-funding**. Confirm twice in MetaMask. | "Anyone can open a market. I pick the stock and the leverage I want, and the launch goes to Flap for pre-funding. The raise becomes the new market's first-loss capital." |
| 3 | 0:50–1:15 | Launch a market → Markets | Show the new card: "Pre-funding · 0 / 4.7 tBNB". Click **Fund and open the market** and wait about a minute. Open **Markets**: the launch is now a live market. Click **Trade**. | "While it is pre-funding it is listed as a launch. When the raise fills, the token launches on Flap and the market opens in the same flow. It is now a normal market anyone can trade." |
| 4 | 1:15–1:35 | Sandbox | Type 1 tNVDA, click **Long 2x**, confirm twice. Point at "Your portfolio" and the "Who owns the pool" bar. | "Now trading. I deposit one NVDA and get xNVDA. The pool's value is split: the sUSD owners have a fixed dollar claim, and xNVDA holders, including me, own the rest." |
| 5 | 1:35–2:00 | Sandbox | Click **+10%**, then **−10%**. Read the portfolio line each time. | "This sandbox is the same contracts with a price I can move. NVDA up 10%, my position is up about 18%. NVDA down 10%, I am down about 20%. That is the leverage, and nobody lent me anything." |
| 6 | 2:00–2:25 | Sandbox | Click **−20%**. Point at the log line and the "sUSD owners" card. | "At minus 20%, leverage leaves its band. There is no liquidation. The pool sells NVDA to the sUSD owners at a small discount, by itself, and leverage comes back to 1.8x. They still hold dollars plus the NVDA they bought cheap." |
| 7 | 2:25–2:45 | Trade NVDA → Risk & AI tab | Point at the price chip "Atlas · N s ago", then the Atlas-vs-CMC deviation and the breaker limit. | "Every price comes from Atlas, the oracle feed for tokenized stocks on BNB Chain. We compare it with CoinMarketCap on-chain. If they disagree by more than 2%, minting stops." |
| 8 | 2:45–3:00 | Sandbox | Click **Live price**, then **Close**. | "Back at the live price I close and get my NVDA back. MORE: leverage on real stocks, no liquidations." |

Optional, if there is time: on **Launch a market**, pick **TSLA** and click **Fund and open the TSLA market**. Say: "The same launch works on Four.meme's launch framework, OpenFour. The last buy sells the TSLA Market launch out, and graduation opens the TSLA market."

## Numbers to expect

From the fork run on 27 Nov, starting at NVDA $151.51. Yours will be close.

| Step | NVDA | Pool leverage | Your position | sUSD owners |
|---|---|---|---|---|
| Long 2x, 1 tNVDA | $151.51 | 1.88x | $149.73 (deposited $151.51, about 1.2% fee) | 1,484.30 sUSD |
| +10% | $166.66 | 1.74x | $177.92 | 1,484.30 sUSD |
| −10% | $136.36 | 2.09x | $121.54 | 1,484.30 sUSD |
| −20% | $121.21 | 2.42x → 1.80x after the sell zone | $92.77 | 833.63 sUSD + 5.42 tNVDA |
| Live price | about $151.5 | 1.55x | $134.46 | 833.63 sUSD + 5.42 tNVDA |

The position does not come all the way back at step "Live price" because the sell zone sold NVDA near the low. That is the cost of having no liquidation, and it is worth saying if asked.

## The mechanism, in plain words

Use this for narration or for judges' questions.

- **One pool, two tokens.** A pool holds tokenized NVDA. **sUSD** is a claim on $1 of pool value each. **xNVDA** is a claim on everything left over.
- **Why xNVDA is leveraged.** If the pool holds $200 of NVDA and has issued $100 of sUSD, xNVDA owns $100. NVDA up 10% makes the pool worth $220; sUSD still claims $100, so xNVDA is worth $120, up 20%. Leverage is pool value divided by xNVDA value.
- **Why nobody is liquidated.** No one borrows. An xNVDA holder owns a share of the pool, and that share just gets bigger or smaller.
- **How leverage stays in range.** The pool keeps leverage in a band, about 1.5x to 2.2x.
  - **Sell zone:** when a price drop pushes leverage above the band, the pool sells some NVDA. It sells first to the sUSD stakers in the insurance pool, at a small discount, and burns the sUSD they pay with. Leverage returns to its 1.8x target.
  - **Buy zone:** when a price rise pushes leverage below the band, the pool buys NVDA back.
- **What protects sUSD.** In order: the xNVDA holders' equity, then the first-loss xNVDA that the launch seeded, then the insurance vault funded by the launch's trading fees. sUSD stays worth $1 while backing is above 100%.
- **What sUSD stakers earn.** A funding fee of 4% a year on the sUSD supply, paid by xNVDA holders, plus discounted NVDA whenever the sell zone runs.
- **Launches open markets.** A launch on Flap or OpenFour raises funds first. When the raise fills, part of it becomes the new market's first-loss xSTOCK, and the launch's fees keep funding that market's insurance vault.

## Where Atlas fits

- **Price source.** Every live market reads the Atlas feed for its stock. For NVDA that is the Atlas NVDAB feed on BSC mainnet, `0xf25af12920d408baf6211e9e90eda89df3d8ccda`.
- **On testnet.** Atlas publishes on mainnet, so our keeper relays each Atlas update to a mirror contract on testnet, about every 60 seconds. The trade page shows the age of the last update: "Atlas · 24 s ago".
- **Freshness rules.** Minting and xNVDA redeems need a price under 2 minutes old; sUSD redeems accept a price up to 24 hours old. If the feed halts, minting and xNVDA redeems stop, and redeeming sUSD and xNVDA together keeps working because it needs no price.
- **Cross-check with CoinMarketCap.** The keeper posts CMC's price for the same stock on-chain. The pool compares the two inside the contract. If they are more than 2% apart, the breaker blocks new mints. Show this on the **Risk & AI** tab.
- **Launches use it too.** Opening a market swaps the seed into the stock at an Atlas-priced minimum, and a Four.meme graduation only runs while the Atlas price is fresh.
- **The sandbox.** It starts at the Atlas price and "Live price" resets it to Atlas. The moves in between are ours, which is why it is labelled a sandbox.
- **Proof.** The **Transparency** page lists the Atlas source feeds and the mirror contracts with explorer links.

## If something goes wrong

| Problem | What to do |
|---|---|
| **Long 2x** is disabled | The sandbox price is away from live. Click **Live price** first |
| A price button shows an error in the log | Click it again; the testnet RPC sometimes lags a block |
| **Fund and open the market** fails | Read the message on the card. If the funding wallet is short of tBNB, top it up and click again; it resumes where it stopped |
| The new market does not appear on Markets | Wait 10–15 seconds; the page re-reads the chain on a timer |
| Trade page says the price is stale | The keeper stopped. Run `bash services/scripts/keeper-97.sh start` |

## What to say honestly if asked

- Only NVDA can be launched through Flap today, because our Flap launcher is fixed to one stock. The other stocks in the picker need a test token and a price feed first.
- The leverage slider is recorded with the launch. Markets open at about 2x, the contract's cap for new sUSD.
- "Fund" in the demo is one wallet filling the whole raise. In real use the crowd funds it on Flap.
- The Four.meme launch runs on OpenFour, Four.meme's launch framework, deployed by us on testnet. It is not listed on the four.meme website.
- The ten other markets on the Markets page use live CoinMarketCap prices with simulated pool state.
