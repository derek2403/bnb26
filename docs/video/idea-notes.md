# MORE

**Margin On RWA Exposure, without liquidation.**

Plain version: you get about 2x on a tokenized stock, and nobody can force
you out.

Updated 2026-11-27. BNB Bangkok hackathon, 25 to 27 November 2026.
The contracts on testnet still use the earlier name, SplitStock, and the
launch token is SPLIT.

## Where we are (2026-11-27)

The sections below this one were written before the code. Where they
differ from this section, this section is correct.

### What is live on BSC testnet

Source: the team chat with the Flap reviewers on 26 Nov. Not read from the
code for this document.

| Part | Address |
|---|---|
| Launcher factory | `0x01013DCE27c3F00cac8Bf254E20d02fD3500FfD2` |
| Vault factory | `0xA441ECBfd7a28c3b949C0672cbD637355e97F2C4` |
| Fixed config | `0x9AeA8a4e1fcf44dDC32dd442D5d015bcd4083ddb` |
| Launcher (4.7 of 4.7 tBNB raised) | `0x56ceF14ae0171Fb3DFa04DD44EA0811E3D8517c4` |
| Launch token SPLIT | `0xFc500e99b8bEFC3c637503469153DFE928977777` |
| NVDA pool | `0x0CD861cd0dD919434019f18F71630D2F678CD208` |
| Backstop vault | `0x02e1945d2b5705d47747b6735bb25BEcc0C60D24` |

### How the built version works

- **Two tokens.** sUSD-NVDA is the stable token. xNVDA is the leveraged
  token, with a 2.0x target.
- **Rebalance.** Anyone can call it. The pool sells stock for USDC at 2.67x
  and buys back below 1.6x. Before the market opens, the target is 1.8x
  and the sell limit is 2.3x.
- **Fees.** xNVDA holders pay 4% each year. Only sUSD in the StabilityPool
  receives it. Plain sUSD earns nothing. Yield for the StabilityPool =
  4% × sUSD supply ÷ StabilityPool deposits. Mint costs about 0.3%, and
  sUSD redeem costs 0.2%.
- **Who takes a loss, in order.** Rebalance, then the StabilityPool, then
  the backstop vault, then all sUSD holders in proportion.
- **Pricing.** Atlas gives the NVDA price feed. CoinMarketCap data sets the
  risk limits from the volatility. An on-chain calendar holds the market
  hours. A large price jump halts mint, xNVDA redeem and rebalance.
- **Risk agent.** An AI risk steward with an ERC-8004 identity. A tighter
  limit applies at once. A looser limit waits 30 minutes and can be vetoed.
- **Launch (Flap).** A crowdfund launches a token. A part of the raise
  opens the pool as first-loss xNVDA, locked in the backstop vault. A 3%
  trading tax for 30 days sends 50% to the backstop vault.
- **Review status.** The Flap review bot passed the contracts with no
  blocking item. The launcher UI preview is published. The vault UI was
  blocked by an error on the reviewers' side.

### Next: each launch chooses its own RWA and parameters

The goal: a person who launches a pool chooses the RWA, the leverage cap
and the fees. This is the reason for the Flap and Four.meme integrations.
A launch becomes "create a market for one RWA".

Open points:

- The config on testnet is fixed for each factory pair, and it has one
  price feed. A choice per launch needs a contract change, and a contract
  change needs a new review from Flap.
- Each parameter needs a safe range. A launcher must not be able to set a
  10x cap or a fee of zero.
- The Four.meme / OpenFour integration is not described here yet.

## The idea in one line

Hylo gives leverage on SOL with no forced exit. We bring that design to BNB
Chain for tokenized stocks, and we handle the hours when the stock market is
closed.

## The problem

A tokenized stock is a token that follows the price of a real stock, for
example NVDA. BNB Chain holds about 1 billion USD of these tokens. The
largest group is bStocks, the tokenized stocks from Binance. bStocks are
our collateral on mainnet.

Users who want leverage on them have three options today. All three use
liquidation. Liquidation means the platform sells your position by force
when the price falls.

| Platform | What it does | Status |
|---|---|---|
| Lista Lending | Borrow against tokenized stocks | Live since June 2026 |
| Venus | Same | Borrowing was paused |
| Binance margin | Tokenized stocks as margin collateral | VIP 3 accounts only |

The stock market closes for about 65 hours each weekend. The liquidation
engine runs all the time. A price jump at the Monday open can liquidate a
user who could not react.

## The solution

One pool holds a tokenized stock. The pool issues two tokens:

- **Stable token**: always worth 1 USD. Backed by the stock in the pool.
- **Leveraged token**: worth everything in the pool minus the stable tokens.

Nobody borrows, so nobody is liquidated. The leveraged holder takes a price
fall as a lower token price, and can wait for a recovery.

### Example

| Step | Pool value | Stable side | Leveraged side |
|---|---|---|---|
| Start | 150 | 100 | 50 |
| Stock rises 10% | 165 | 100 | 65 |

The stock rose 10%. The leveraged side rose 30%. The leverage is 3x.

### Example with two users

1. Alice deposits 1,000 USD of bNVDA and mints the leveraged token.
2. Bob deposits 1,000 USD of bNVDA and mints 1,000 stable tokens.
3. The pool holds 2,000 USD of bNVDA and owes Bob 1,000 USD.
4. NVDA rises 10%. The pool is worth 2,200 USD. Bob has 1,000 USD. Alice
   has 1,200 USD. She gained 20% on a 10% move, so her leverage is 2x.
5. Each day, a small holding fee moves from Alice's side to Bob's side.

## Why the pool needs a price

The pool holds bStocks, but it owes the stable holders dollars. A contract
cannot see a price by itself. The agent reads the price from CoinMarketCap
and writes it to the contract. The contract uses the price for:

- the amount of tokens for each mint and each redeem,
- the value of one leveraged token,
- the collateral ratio (pool value divided by stable debt),
- the holding fee rate,
- the decision to sell or buy bStocks (sell zone and buy zone).

Three prices exist when the stock market is closed:

| Price | What it is | Problem |
|---|---|---|
| Last close | The real stock's price at the last close | Old. It ignores weekend news. |
| Token price | What traders pay for the bStock now. CoinMarketCap shows this. | Few traders, so one large order can move it. |
| After-hours price | Some venues trade real stocks outside normal hours | Not open the whole weekend. Not checked. |

The sell zone and the buy zone never run on a weekend price. They wait for
the open.

### How others price a closed market (checked 2026-11-26)

Weekend pricing is not a new problem, and others solved the price part in
October 2026. We must not claim that we are first with it.

| Who | Method |
|---|---|
| Binance, for bStocks collateral, since 24 Oct 2026 | Uses its own order book when the market is closed. It smooths the price with a moving average, limits how far the price can move, and blends back to the real price at the open. |
| Chainlink 24/7, since 29 Oct 2026, with Aave | Uses the normal stock price in market hours. Uses perpetual futures quotes when the market is closed. |
| xStocks and Ondo | Reference price feeds. Off-hours inputs are thinner. |

Binance reports that 62% of bStocks volume happens when the US market is
closed. So the weekend price is less thin than we assumed. One independent
study still found that the weekend price gives the direction of the Monday
open only 54% of the time.

What this means for us: a price exists at the weekend, so lending platforms
can now liquidate at the weekend, when the user cannot trade the real
stock. Our main claim is "no liquidation", and the weekend makes it
stronger. Our price rule copies the known method: smooth the price, limit
its movement, and use the queue when a guard fails.

## Who pays and who earns

Hylo pays its stable holders with the staking yield of SOL. Tokenized
stocks pay no staking yield. So the leveraged side pays a holding fee to
the stable side.

| Person | Wants | Gives | Gets |
|---|---|---|---|
| Leveraged holder | More gain from the stock | Holding fee, and slower recovery after a fall | About 2x the stock movement, no forced exit |
| Stable holder | Yield on dollars | Accepts the risk of a very large fall | The holding fee, as a stable token that grows in value |
| Protocol | Income | Runs the pool | A part of the mint and redeem fees |

Example at 5% each year, with no change in the stock price:

| | Stable side | Leveraged side |
|---|---|---|
| Start | 100.00 | 50.00 |
| After one year | 105.00 | 45.00 |

The rate changes with the pool. Few stable holders means a high rate. Many
stable holders means a low rate. Do not claim "no interest". The correct
claim is "leverage with a fee and no liquidation".

This is not a lending market. Nobody has a personal debt.

Hylo already does this for BTC, which also has no staking yield. Its
documents call the fee a "borrow rate, paid by xBTC holders through gradual
NAV reduction". So the holding fee is Hylo's own method, not our invention.
Facts from the Hylo documents (docs.hylo.so, read 2026-11-26):

- The BTC pool is separate from the SOL pool and holds cbBTC. Price: Pyth.
- The pool targets a 150% collateral ratio, which is about 3x leverage.
- The rate is 1x the base rate from 135% to 165%, and rises to 2x at 175%.
  The base rate is not published.
- Below 135%, the pool sells collateral for USDC. Above 165%, it buys back.
- Below 100%, the Earn Pool burns stable tokens to restore the ratio. So
  the yield earners take the first loss.
- The documents say nothing about stock prices or market hours.

## Similar protocols, checked in their documents on 2026-11-26

| Protocol | Chain | Assets | Long | Short | Liquidation |
|---|---|---|---|---|---|
| Hylo | Solana | SOL, BTC, HYPE. Equities are "Coming soon". | Yes | No | None for the leveraged token |
| Sigma.Money | BNB Chain | BNB and other crypto. No stocks found. | Yes, xBNB | Yes, sBNB | Rebalance first. Liquidation if the rebalance fails. |
| f(x) Protocol v2 | Ethereum | ETH, BTC | Yes | Yes | Rebalance first. Liquidation for shorts not checked. |

Two facts follow from this table:

- Sigma.Money does not say "no liquidation". Its documents say the rebalance
  "minimizes liquidation events". Each user has a position with a debt.
- Our design follows Hylo, not Sigma.Money. Hylo has one shared pool and no
  debt for each user. That is why Hylo has no liquidation and no short.

We build the long side only. A short needs a second pool. In Sigma.Money
the short holder deposits the stable token, and the protocol borrows BNB
from the long reserve and sells it.

## What we copy and what is new

| Part | Source |
|---|---|
| One pool and two tokens | Copied from Hylo |
| Fees that change with the pool health | Copied |
| Collateral is a tokenized stock | New |
| Closed-market price rule | Method copied from Binance and Chainlink. New inside a pool of this type. |
| Stock price from CoinMarketCap data | New |
| Agent that watches pool health and market hours | New |

### The closed-market rule

The pool has no liquidation, so a weekend price jump cannot force a user
out. The rule solves a different problem: a stale price. When the market is
closed, the contract knows only the last close price. A person who reads
weekend news knows more. That person can mint or redeem at the old price
and take value from the other holders.

1. When the stock market is closed, the contract accepts requests but does
   not execute them. It puts them in a queue.
2. At the open, the contract updates the price first.
3. The contract then executes every request in the queue at the new price.

Investment funds use the same method. Nobody can trade at a price that is
already old.

Later step, if time allows: tokenized stocks trade all weekend, and
CoinMarketCap shows that price. The pool can stay open with three guards:
the price must stay inside a band around the last close, the weekend
volume must be high enough, and each trade has a size limit and a higher
fee. A request that fails a guard goes into the queue.

The other rules (low leverage, fees, stability pool) protect the pool
health. They do not fix a stale price. Sigma.Money has no such rule,
because BNB trades all the time.

## The known cost: slower recovery

"No liquidation" does not mean "no loss". The leveraged token can fall to
almost zero. Also, when the pool gets weak, the protocol must protect the
stable token, and that lowers the leverage at the bottom. Hylo's current
documents do this by a sale of collateral for USDC. The table below shows
the same effect with a simpler step: stable tokens change into leveraged
tokens at the low price.

| Step | Pool | Stable | Leveraged | Leveraged tokens | Price per token |
|---|---|---|---|---|---|
| Start | 150 | 100 | 50 | 50 | 1.00 |
| Stock falls 20% | 120 | 100 | 20 | 50 | 0.40 |
| 40 stable changes into leveraged | 120 | 60 | 60 | 150 | 0.40 |
| Stock returns to the start price | 150 | 60 | 90 | 150 | 0.60 |

The stock is back at its old price, but the leveraged token is at 0.60.
We must show this to the judges. Do not hide it.

These numbers come from the pool formula. Check them against the Hylo and
Sigma.Money documents before they go on a slide.

How we keep this effect small:

1. Start with low leverage, near 2x. That is a 200% target collateral ratio.
2. Use fees first. When the pool is weak, the leveraged token is free to
   mint and the stable token is costly to mint.
3. Pay the stable holders for the risk with the holding fee.

The closed-market rule solves a different problem, the stale price.

## What we build in two days

1. Mock bNVDA token on BSC testnet. The price comes from CoinMarketCap data.
2. Pool contract: mint and redeem the stable token and the leveraged token.
3. Fee rules: a holding fee at a fixed rate, and mint and redeem fees that
   change when the pool gets weak.
4. Closed-market rule.
5. Agent: it reads the market calendar and the pool health, and it
   switches the mode.
6. Web page: mint, redeem, live leverage, market status.

Slide only, not built: the sell zone and the buy zone, a holding fee rate
that changes with the pool, the guarded weekend price, earnings and stock
split events.

## Check before we write code

- Does the CoinMarketCap API list bStocks, with price and volume? How often
  does the price update on the free plan? What does Atlas provide?
- Can a contract hold bStocks, or do they move only between approved
  wallets? Lista and Venus hold them, so it is possible.
- How do bStocks handle dividends and stock splits?

## Demo order

1. Mint the leveraged token while the market is open. Show the live leverage.
2. Move the price down. Show that nobody is liquidated. Show the fee change.
3. Switch to "market closed". Send a mint request. Show that the contract
   puts it in the queue.
4. Open the market with a price jump. Show that the pool updates the price
   first, and then executes the request at the new price.

Steps 3 and 4 are what Sigma.Money and Hylo do not show.

## Prize tracks

| Track | Prize pool | Our fit |
|---|---|---|
| Developer Track | 10,000 USD | Main target. RWA is a focus theme. |
| CoinMarketCap × Atlas | 10,000 USD | The stock price is a core feature. 20 of 100 points are for BNB Chain and RWA focus. |
| Cournot | 2,000 USD | Weak fit. Skip it unless we have time left. |
| Flap, Four.meme | 10,000 USD each | No fit. Both need a token launch. |

## Risks and open questions

- **Testnet has no real tokenized stocks**, as far as we found. The stock
  token and the price feed are mocks. Say this in the demo.
- **A very large fall breaks the stable token.** Hylo's pool could not
  fully back its stable token after a 69% fall without help.
- **Both sides are needed.** With no stable holders, no leverage exists.
- **The holding fee runs in a fall too.** A leveraged holder who waits a
  long time for a recovery pays the fee the whole time.
- **The agent writes the price to the contract.** Users must trust the
  agent's key. A real product needs an independent price source.
- **A judge can ask why Sigma.Money cannot add stocks.** The answer is
  the closed-market rule and the stock price source.
- **Hylo plans leveraged equities on Solana.** Its documents mark them
  "Coming soon". We are not the first with the idea. We are first on BNB
  Chain, as far as we found.
- **We offer no short.** Sigma.Money does. Say "long side first".
- **US users cannot buy tokenized stocks** from the main issuers. The
  product is for non-US users.
- **We did not find the full judging rules** for the Developer Track.

## Sources

- Sigma.Money documentation: https://docs.sigma.money/
- Hylo documentation, leveraged tokens: https://docs.hylo.so/product-guide/xassets.md
- DeFiLlama on the real costs of Hylo xSOL: https://defillama.com/research/spotlight/hylo-xsol-no-liquidation-no-funding-but-what-are-the-real-costs
- Hylo V2 and leveraged equities: https://cryptobriefing.com/hylo-v2-leveraged-equities-solana/
- f(x) Protocol leverage docs: https://fxprotocol.gitbook.io/fx-docs/more/f-x-protocol-1.0/leverage
- Lista borrowing against tokenized stocks: https://cryptobriefing.com/lista-borrowing-tokenized-equities-bstocks-growth/
- Venus tokenized stock collateral: https://cryptoslate.com/tokenized-stocks-defi-collateral-venus/
- Weekend gap analysis for tokenized stock margin: https://www.trendbullet.in/articles/bstocks-margin-collateral-weekend-gap.html
- BNB Chain on the next step for tokenized equities: https://www.bnbchain.org/en/blog/the-next-step-for-tokenized-equities-funding-paths-matter-after-assets-move-onchain
