# HackQuest submission fields (ready to paste)

## Project name

MORE

## One-liner (≤ 100 characters)

Split a tokenized stock into a stock-backed dollar and 2x leverage that is never liquidated.

## Short description (~150 words)

MORE turns one tokenized stock into two tokens. sUSD is a dollar backed by the stock: each one is a claim on $1 of pool value. xSTOCK (xNVDA, xTSLA) owns the rest of the pool at about 2x leverage, and it is never liquidated because nobody borrows. Instead, the pool keeps leverage inside a band by itself: a sell zone and a buy zone swap stock and USDC on PancakeSwap. Atlas sets the price (the mainnet NVDAB feed, mirrored to BSC testnet). CoinMarketCap data sets the risk limits on-chain, and an AI risk agent with an ERC-8004 identity can only make them stricter. NYSE hours and price gaps are enforced on-chain. Every launch opens a new pool: a launch on Flap opened the NVDA pool and funds its insurance vault, and a meme graduating on our Four.meme (OpenFour) preset opens a TSLA pool. Everything is live on BSC testnet and verifiable on /proof.

## Long description

### Problem

Tokenized stocks (NVDAB, TSLAB) now trade on BNB Chain, but there is little to do with them. Leverage means borrowing, and borrowing means liquidation, which is worst for stocks: they close at night and gap at the open, so an oracle-triggered liquidation lands at the worst price. A holder who wants dollars has to sell into a thin DEX.

### Solution

A MORE pool holds one tokenized stock (C units at price P) plus some USDC (U). Pool value is V = C·P + U.

- **sUSD** supply S is a claim on exactly $1 of V each.
- **xSTOCK** holders own the equity E = V − S. Leverage L = C·P / E floats around 2x.
- When L rises above the sell trigger, the pool sells stock for USDC; when it falls below the buy trigger, it buys stock back. Nobody can be liquidated, because no position is a loan.
- Loss order in a crash: zones → StabilityPool (sUSD depositors buy stock at a 1% discount and earn the 4% funding paid by x holders) → the pool's insurance vault → a pro-rata haircut on sUSD only if V ≤ S.

### How it works

- **Price:** Atlas. A keeper mirrors every mainnet NVDAB round to an `AtlasMirror` on testnet; each `Mirrored` event cites the mainnet tx. An out-of-band move halts the feed. A signed Atlas pull payload is verified on-chain as a second check (`AtlasPullAdapter`).
- **Risk limits:** CoinMarketCap. The keeper posts hashed CMC snapshots (DEX price, 1h k-lines, quotes, RWA premium, DEX pools) to a `RiskOracle`. On-chain, σ sets the sell trigger, liquidity sets the max sell chunk, the RWA premium sets the open fee, and the CMC price drives a deviation breaker that stops mints.
- **AI risk steward:** reads CMC REST and CMC MCP (US equity event calendar, macro events, technical analysis, news, global metrics) and proposes limits. Tightening applies at once; loosening waits behind a 30-minute timelock with a Guardian veto. It is registered as ERC-8004 agent #2931.
- **Market hours:** a `MarketCalendar` enforces NYSE hours, half days and holidays; a closed-market fee and a gap guard apply when the market is shut.
- **Proof:** every CMC and MCP response is hashed into a hash-chained log whose hourly Merkle roots are stored in `LogAnchor`. The Transparency page (`/transparency`) re-verifies a snapshot in the browser.

### The three tokens

| Token | What it is | Who holds it |
|---|---|---|
| **sUSD** (sUSD-NVDA, sUSD-TSLA) | A dollar backed by the stock. Mint and redeem against the pool at the oracle price. Earns the funding rate when deposited in the StabilityPool. | Stock holders who want dollars without selling; StabilityPool depositors |
| **xSTOCK** (xNVDA, xTSLA) | The pool's equity at about 2x leverage, never liquidated. Pays 4% a year of funding. | Traders who want stock leverage without liquidation risk |
| **Backstop token** (launched on Flap) | A safety-module token. Its Flap raise seeded the NVDA pool's first-loss xNVDA, and 50% of its 3% trading tax funds the pool's insurance vault. It is not shown in the product app. | Launch participants; later, stakers who insure markets |

### Tracks and what qualifies

**Developer (RWA + on-chain AI agent)**
- RWA: a working stock-backed stable/leverage split on tokenized NVDA and TSLA (mocks on testnet), with zones, StabilityPool, insurance and NYSE hours on-chain.
- On-chain AI agent: the AI risk steward signs its own `RiskOracle` proposals, has an ERC-8004 identity (agent #2931), and is bounded on-chain (tighten-only, timelocked loosening, Guardian veto).

**CMC × Atlas**
- Atlas NVDAB SingleFeed (BSC mainnet) mirrored to testnet as the pool price; Atlas BNB/USD values the insurance vault; Atlas pull payloads verified on-chain.
- CMC REST endpoints (DEX price, k-line, quotes, RWA quotes, DEX pools, fear and greed, key info) plus CMC MCP tools, each with a stated on-chain effect, hashed and anchored. See [WRITEUP.md](./WRITEUP.md).

**Flap**
- Our own launcher factory and vault factory on Flap (`SplitLauncherFactory`, `BackstopVaultFactory`, an immutable `SplitStockConfig`), enabled by Flap on testnet.
- A full testnet launch: the raise filled, the token launched and graduated on Flap (LP 4.5 WBNB + 500k tokens), and the launch opened the NVDA pool, seeding its first-loss xNVDA.
- A custom launcher UI and vault UI running on Flap's site, built with Flap's templates.
- A Flap Mini App (built on Flap's Mini App template, submitted for Flap's review): get tNVDA, mint and redeem sUSD / xNVDA, and earn in the StabilityPool without leaving Flap. The vault UI links to it.

- Launching from the app: the "Open a market" form on `/launchpad` creates a launcher through our factory from the user's wallet (stock, requested leverage, raise). A second launch made this way, launcher [0x1217…fe58](https://testnet.bscscan.com/address/0x1217fb582330a155cee36af33855ab4cc515fe58), filled its 4.7 tBNB raise ([tx](https://testnet.bscscan.com/tx/0xc43d27c4d140bd35d1b0c21217c7f90366e477f6e1a86245b78a14362fa7e2ce)), launched token `0x48C4…7777` and opened a second NVDA market, pool [0x892A…9cE2](https://testnet.bscscan.com/address/0x892A4F3d88FA2aAA9647aD508320709eDA4A9cE2) ([tx](https://testnet.bscscan.com/tx/0x4300af0f59d231d208b55726b6a526b7047f8f042d9f5595f32f67db182520e6)).

**Four.meme (OpenFour)**
- A "SplitStock Pool Launch" preset (MORE's preset, id 1795700948232) on our OpenFour fork: a fair launch quoted in tTSLA whose graduation module opens a new TSLA pool, pairs the meme with sUSD, and sends preset fees to the pool's insurance treasury.
- Why a fork: the OpenFour Developer Guide (§17–18) has builders deploy their own Registry and Core on testnet with `fork-deploy`, register and test modules there, then submit the pack. Only Four.meme registers modules on the official Registry.

### Prior art

f(x) Protocol (AladdinDAO) splits ETH and BTC into a stable token and a leveraged token. MORE applies the idea to tokenized stocks: the trigger comes from outside data (CMC), it handles market hours and gaps, and it deleverages through a DEX with a launch-funded insurance vault.

### Honest limits

- Testnet assets (tNVDA, tTSLA, mUSDC) are mocks, labelled MOCK.
- The testnet price is relayed from mainnet Atlas by our keeper (a trusted pusher).
- sUSD redeems pro rata if V ≤ S after every layer of protection.
- No real-money mainnet pool exists yet.

## Tech stack

- **Contracts:** Solidity 0.8.26, Foundry, OpenZeppelin 5.1, Solady; OpenFour modules in Hardhat (solc 0.8.24); EIP-1167 clones; ERC-8004.
- **Oracles and data:** Atlas (SingleFeed, BNB/USD, pull API), CoinMarketCap REST and MCP.
- **Services:** TypeScript, viem, Fastify, Postgres, Docker; the AI steward uses Claude through the Anthropic API.
- **App:** Next.js 15, wagmi, RainbowKit, Tailwind.
- **Launchpads:** Flap Portal, launcher/vault UI templates and Mini App template; OpenFour (Four.meme); PancakeSwap v2.
- **Chain:** BNB Smart Chain testnet (97), with read-only anchors on mainnet (56).

## Links

- Repo: https://github.com/derek2403/bnb26
- Demo video: `<VIDEO LINK>`
- CMC × Atlas write-up: `<WRITE-UP LINK>` (source: [docs/WRITEUP.md](./WRITEUP.md))
- Live app: `<APP LINK>`
- Flap launcher page: https://test.utter.cash/launcher/0x56ceF14ae0171Fb3DFa04DD44EA0811E3D8517c4?chain=bnb-testnet&kind=launcher-detail
- Address book: [deployments/97.json](../deployments/97.json)
- Demo script: [docs/DEMO-FLOW.md](./DEMO-FLOW.md)

## Team

- `<NAME>`: `<ROLE>` · `<CONTACT>`
- `<NAME>`: `<ROLE>` · `<CONTACT>`
