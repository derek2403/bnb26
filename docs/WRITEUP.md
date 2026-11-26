# MORE · CMC × Atlas write-up

**Problem & audience.** Holders of tokenized stocks on BNB Chain (NVDAB, TSLAB) cannot get leverage without liquidation risk, and cannot move into dollars without selling into a thin DEX. Stocks also close at night and gap at the open, which breaks oracle-triggered lending.

**Solution.** A MORE pool holds one tokenized stock and splits it into **sUSD** (a claim on $1 of pool value) and **xSTOCK** (the remaining equity, about 2x, never liquidated). Nobody borrows: a sell zone and a buy zone swap stock and USDC on PancakeSwap to keep leverage in a band. **Atlas sets the price; CoinMarketCap data sets the risk limits.**

## Feeds and endpoints, and their on-chain effect

| Source | Why | On-chain effect |
|---|---|---|
| Atlas NVDAB SingleFeed `0xf25Af129…` (BSC mainnet), mirrored to testnet every round | The live price feed for the real NVDAB token | `AtlasMirror.Mirrored` (cites the mainnet tx) → pool price; out-of-band move halts the feed |
| Atlas BNB/USD (testnet) `0x3957…788D` | Value the insurance vault's BNB | `bufferUsd()`, seed and cover minimum outputs |
| Atlas pull API → `AtlasPullAdapter` | Signed second price | `PullVerified` with deviation vs the mirror |
| CMC `/v1/dex/token/price` | Reference price + liquidity | Deviation breaker on mints; max sell chunk |
| CMC `/v1/k-line/candles` (1h) | Realised σ | Sell-zone trigger |
| CMC `/v3/cryptocurrency/quotes/latest` id 40215 | Second reference (median) | Breaker reference |
| CMC `/v5/real-world-assets/quotes/latest` rwa_id 2 | Tokenized vs underlying premium | Open fee |
| CMC `/v1/dex/token/pools` | Liquidity cross-check | Chunk fallback |
| CMC `/v3/fear-and-greed/latest` + **CMC MCP** (equity event calendar, macro events, TA, news, global metrics) | AI agent context | `AgentProposal`: tighten now; loosen only after a 30 min timelock, Guardian can veto |
| CMC `/v1/key/info` | Usage proof | Hourly, logged next to our own credit count |

Each keeper snapshot posts `CmcSnapshot(refPrice, volBps, liqUsd, premiumBps, responseHash)` to the RiskOracle, and the pool derives its rule parameters on-chain from it. `responseHash` is the keccak of the raw CMC response bodies.

## BNB Chain contracts (BSC testnet 97)

| Contract | Address |
|---|---|
| NVDA pool (opened by the Flap launch) | [0x0CD8…D208](https://testnet.bscscan.com/address/0x0CD861cd0dD919434019f18F71630D2F678CD208) |
| StabilityPool (NVDA) | [0x36Fe…4d07](https://testnet.bscscan.com/address/0x36Fe40CE6925fd1711ae3aC9e89c3348E1354d07) |
| PoolFactory | [0xF4Ef…DBb9](https://testnet.bscscan.com/address/0xF4Ef260a4605A2bfE7B0fF3113065D3FCD6EDBb9) |
| RiskOracle | [0x0411…1190](https://testnet.bscscan.com/address/0x0411D501839553cc53cbbcE45eD87501DF531190) |
| AtlasMirror NVDA / TSLA | [0x5a05…F828](https://testnet.bscscan.com/address/0x5a055A63188315401F8fc22fA451E309a7C6F828) / [0xD836…0214](https://testnet.bscscan.com/address/0xD836c54Cb9cB6379A9c40C0B163B8d7f39B30214) |
| AtlasPullAdapter NVDA | [0x599e…DCe3](https://testnet.bscscan.com/address/0x599e6f8EB27c71f664AF6c271bF5e7a2fd3FDce3) |
| LogAnchor | [0x96b3…3ca0](https://testnet.bscscan.com/address/0x96b3F4BE973A314E73c9ACA81c206c7Fec5d3ca0) |
| Flap launcher / insurance vault | [0x56ce…17c4](https://testnet.bscscan.com/address/0x56ceF14ae0171Fb3DFa04DD44EA0811E3D8517c4) / [0x02e1…0D24](https://testnet.bscscan.com/address/0x02e1945d2b5705d47747b6735bb25BEcc0C60D24) |
| OpenFour Core (preset 1795700948232) / migrate module | [0xB969…e4ba](https://testnet.bscscan.com/address/0xB969FcaE60ff652Dd59A014a89B16053D619e4ba) / [0x43DA…693a](https://testnet.bscscan.com/address/0x43DAa1613165Cc774ABbe7A956BE9ae97056693a) |

## How usage is verifiable

- **Events:** `Mirrored` on each AtlasMirror, `CmcSnapshot` and `AgentProposal` on the RiskOracle.
- **Hash-chained log:** every CMC and MCP call is logged with the keccak of its raw body; each entry hashes the previous one, and `LogAnchor` stores hourly Merkle roots (first anchor: 1,050 entries, tx [`0x8d4ab202…df9a`](https://testnet.bscscan.com/tx/0x8d4ab202858cb22fa80198192fcd2db6e1eea5756d86a7e09da4127511cddf9a)). The Transparency page (`/transparency`) re-hashes a raw body in the browser and checks it against the on-chain `responseHash`.
- **Credits:** `/v1/key/info` is logged hourly beside our own sum of `credit_count`.

## Safety

The AI agent (ERC-8004 id 2931) can only tighten limits. NYSE hours and gaps are enforced on-chain (`MarketCalendar`, closed-market fee, gap guard). Redemptions take minimum outputs. Losses go zones → StabilityPool → insurance vault → pro-rata sUSD. API keys stay server-side.

**Limits:** testnet assets are mocks, the testnet price is relayed by our keeper, and sUSD redeems pro rata if V ≤ S.

## Next

- Mainnet pool on the real NVDAB token, reading Atlas directly, with pull pricing in the pool.
- More stocks (TSLA live, then AAPL, MSFT…).
- Staking the backstop token launched on Flap into a market's insurance for a fee share, and staking it to open new stock markets.

**Team and contact.** Derek Liew, GitHub [@derek2403](https://github.com/derek2403).
