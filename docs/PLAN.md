# SplitStock: Build Plan (BNB Bangkok)

**Deadline:** HackQuest closes 27 Nov 09:00 (UTC+7). **Internal target:** submitted by 07:00.
**Tracks:** Developer Track (RWA), CMC × Atlas, Flap, Four.meme / OpenFour.

## 1. What SplitStock is

SplitStock is a pool that holds tokenized NVIDIA stock. It splits the pool's value into two tokens:

- **sUSD**, the stable side. Each sUSD is a claim on $1.00 of pool value.
- **xNVDA**, the leveraged side. All xNVDA together claim the rest of the pool. Their leverage floats.

Nobody borrows, so nobody gets liquidated. When leverage gets too high, a **sell zone** swaps some of the stock into USDC to bring leverage back down.

The rest of the system is built around the pool:

- **Price:** Atlas sets the price. CoinMarketCap (CMC) data runs a safety check and adjusts the sell-zone trigger to volatility.
- **SPLIT token:** a protocol token launched through our own Flap Launcher. Its trading tax funds a backstop for sUSD.
- **Four.meme graduation module:** a new OpenFour module. When a meme token that raised in tNVDA graduates, the raise turns into sUSD, so its price floor is in dollars and does not move with the stock.

| Symbol | What | Where |
|---|---|---|
| tNVDA | Mock tokenized NVIDIA, 18 decimals, with a faucet | BSC testnet (97) |
| mUSDC | Mock USDC, 18 decimals, with a faucet | BSC testnet |
| sUSD / xNVDA | The pool's two tokens. Only the pool can mint or burn them | BSC testnet |
| SPLIT | Flap tax token. The address ends in `7777` | BSC testnet |
| NVDAB | The real Binance bStocks NVIDIA, `0x02fca66c…7436`. Used only for **price data** | BSC mainnet (56) |

> Do not use the name "bNVDA". That ticker belongs to Backed Finance. On testnet we use tNVDA, and every page labels it as a mock.

---

## 2. Architecture

```mermaid
flowchart LR
  subgraph Mainnet[BSC mainnet · read only]
    ATLAS[Atlas SingleFeed NVDAB/USD<br/>0xf25af129…]
  end
  CMC[(CoinMarketCap Pro API)]

  subgraph Keeper[keeper/ · Node + viem · server only]
    K1[price mirror]
    K2[risk snapshot]
    K3[rebalancer]
  end

  subgraph Testnet[BSC testnet 97]
    MIRROR[AtlasMirror]
    RISK[RiskOracle]
    LIVE[LivePool]
    SCEN[ScenarioPool]
    SFEED[ScenarioFeed]
    PCS[PancakeSwap v2<br/>tNVDA/mUSDC pair]
    FLAP[Flap Portal]
    LAUNCH[SplitLauncher]
    SPLIT[SPLIT tax token]
    BACK[BackstopFund]
    OF[Our OpenFour fork<br/>+ SplitFloorMigrateModule]
  end

  subgraph App[app/ · Next.js on Vercel]
    UI[Pages + wagmi]
    API[/api routes · CMC key here/]
  end

  ATLAS --> K1 --> MIRROR --> LIVE
  CMC --> K2 --> RISK --> LIVE & SCEN
  SFEED --> SCEN
  K3 -->|rebalance()| LIVE & SCEN
  LIVE & SCEN -->|sell zone swap| PCS
  LAUNCH -->|launchTaxTokenV2| FLAP --> SPLIT
  SPLIT -->|tax| BACK -->|donate| LIVE
  OF -->|mintStable on graduation| LIVE
  UI --> LIVE & SCEN & LAUNCH & RISK
  UI --> API --> CMC
```

### Repo layout (monorepo)

```
bnb26/
├─ contracts/     Foundry, solc 0.8.26: pool, tokens, oracle, risk, Flap launcher, backstop
│  └─ src/flap/   copied unchanged from flap-sh/FlapPoolLaunchVaultExample
├─ openfour/      Hardhat, solc 0.8.24, viaIR (OpenFour requires this)
│  ├─ fork-deploy/  official toolkit: deploys our own OpenFour copy on testnet
│  └─ startup/      official starter kit + our SplitFloorMigrateModule
├─ keeper/        Node + TypeScript + viem: price mirror, CMC snapshots, rebalancer
├─ app/           Next.js 15 (App Router) + wagmi v2 + viem + RainbowKit + Tailwind
├─ flap-ui/       React TSX component ZIP that Flap hosts (launcher page)
├─ deployments/   97.json, 56.json: one address book read by keeper/ and app/
└─ docs/          PLAN.md, WRITEUP.md, diagrams
```

The addresses and ABIs are the shared contract between the folders. Each deploy script writes `deployments/97.json`, and `keeper/` and `app/` import it. No address is hardcoded anywhere else.

---

## 3. Smart contracts (contracts/, Foundry)

### 3.1 LeveragePool (deployed twice: LivePool and ScenarioPool)

**State:**

| Name | Meaning |
|---|---|
| `C` | tNVDA held by the pool |
| `U` | mUSDC held by the pool |
| `S` | sUSD supply |
| `X` | xNVDA supply |
| `P` | Price from the feed (AggregatorV3, 18 decimals) |

**Values derived from the state:**

| Formula | Meaning |
|---|---|
| `V = C·P + U` | Pool value in USD |
| `E = V − S` | Equity: the part that belongs to xNVDA |
| `xNAV = E / X` | xNVDA price. Starts at $1 |
| `L = C·P / E` | Leverage |
| `CR = V / S` | Collateral ratio |

| Function | What it does | Checks |
|---|---|---|
| `mintStable(amtIn, minOut)` | tNVDA in → `amtIn·P·(1−fee)` sUSD | `X > 0` (seeded); leverage after the mint ≤ trigger; breaker off; price fresh |
| `mintLever(amtIn, minOut)` | tNVDA in → `amtIn·P·(1−fee)/xNAV` xNVDA | `V > S`; breaker off; price fresh |
| `redeemStable(s, minOut)` | Burns sUSD and pays value `s·min(1, V/S)` | Paid as the same share of both C and U |
| `redeemLever(x, minOut)` | Burns xNVDA and pays value `x·xNAV` | Leverage after the redeem ≤ trigger |
| `rebalance()` | **Sell zone.** Anyone can call it when `L > trigger` | Sells `D = C·P − T·E` worth of tNVDA through the PancakeSwap v2 router. `amountOutMin = D·0.99`. Emits `SellZone(Lbefore, Lafter, sold, out)` |
| `donate(usdc)` | The backstop pays USDC in here | None |
| `state()` | Returns V, S, E, xNAV, L, CR, P and the price age in one call | View only. The app needs a single read |

**Safety rules:**

- **Price checks:** the price must be above 0 and at most 600 s old.
- **Seed first:** the deployer seeds xNVDA before anyone can mint sUSD.
- **Breaker:** if the Atlas price and the CMC price differ by more than `maxDev`, minting stops. Redeems and `rebalance()` still work, because they reduce risk.
- **Closed-market mode:** the mint fee rises from 0.3% to 1%. Minting is not blocked: NASDAQ is closed for the whole hackathon, so blocking it would kill the demo.
- **Same block:** one address cannot mint and redeem in the same block.
- **Below zero:** if `V ≤ S`, xNVDA minting stops and sUSD redeems at `V/S` per token.

**Defaults:** trigger 2.67x, target 2.0x, maxDev 100 bps.

### 3.2 Price and risk

**AtlasMirror** (testnet)
- An AggregatorV3 contract. Only the keeper can call `push(answer, srcStartedAt, srcUpdatedAt, srcBlock)`.
- Requires `srcUpdatedAt` to keep increasing.
- Emits `Mirrored(56, atlasFeed, answer, srcUpdatedAt, srcBlock)`. Judges can check each value against the Atlas feed on mainnet.
- Carries **live Atlas data only**. It has no function for scenario prices.

**ScenarioFeed** (testnet)
- An AggregatorV3 contract with a public `setPrice()`. It is the sandbox the "price shock" buttons use.
- The UI shows a "SCENARIO" banner whenever this feed is in use.

**RiskOracle** (testnet)
- The keeper posts `{refPrice (CMC), deviationBps, volBps, triggerLev, marketOpen, cmcTs, responseHash}`. The contract emits `CmcSnapshot`.
- The contract clamps every value: trigger to [2.2x, 3.0x], target to [1.6x, 2.2x], maxDev to [50, 300] bps.
- If the last snapshot is more than 15 minutes old, the pool falls back to safe defaults.

**AtlasCmcAnchor** (mainnet, optional)
- The keeper calls `anchor(cmcPrice, cmcTs, respHash)`. The contract reads Atlas in the same transaction and emits `Anchor(atlasPrice, cmcPrice, devBps)`.
- This is for the mainnet bonus. It needs a **separate wallet with real BNB**. Never use the testnet key on mainnet.

### 3.3 Mocks and liquidity
- **Tokens:** `tNVDA` and `mUSDC` with a capped `faucet()`, so judges can try the app.
- **Swap pair:** a PancakeSwap v2 testnet `tNVDA/mUSDC` pair seeded at about $150. Router `0xD99D1c33F9fC3444f8101754aBC46c52416550D1`, factory `0x6725F303b657a9451d8BA641348b6761A6CC7a17`.

### 3.4 Flap: SPLIT launch
Flap Portal on testnet: `0x000042108465206185A077Edc3F3fd2b49060000`. Flap has offered a hackathon fast-track for enabling our factory.

| Contract | Role |
|---|---|
| `SplitLauncherFactory` | Inherits `LauncherFactoryBase`. Deploys one launcher per salt and forwards `SALT_LOCK_FEE` (0.005 tBNB). Every setting lives in the launcher's init data, so changing a setting does not need a new Flap audit. |
| `SplitLauncher` | Crowdfund. `contribute()` is payable. Wallets that hold at least $100 of sUSD or xNVDA get **1.2x weight**. At the target (1.5 tBNB) it calls `launchTaxTokenV2` (see the launch settings below). Users then call `claim()`, or `refund()` if the deadline passes. The launcher calls `lockSalt` itself. The salt is mined so the token address ends in `7777`. The emergency functions also accept the Flap Guardian. |
| `BackstopFund` | Receives SPLIT's MARKETING tax share. `bufferUsd()` reads the Atlas **testnet** BNB/USD feed `0x3957d289…788d`, so it is a real Atlas read on testnet. |

**Launch settings passed to `launchTaxTokenV2`:**
- 1,000,000 SPLIT.
- 50% of the supply goes into the pool, and the LP tokens are burned (50/50, like Flap's CrowdLauncher).
- The other 50% goes to contributors through `Distribution.EXPLICIT`.
- 3% tax on both buys and sells.
- The tax splits three ways: 50% MARKETING to `BackstopFund`, 20% LP, 30% burned.

The fork test runs the whole flow (create → contribute → launch → claim → trade → dispatch) against the **live testnet Portal** before we deploy.

### 3.5 Four.meme / OpenFour: `SplitFloorMigrateModule` (openfour/, Hardhat)
- **Fork:** run `npm run fork` in `openfour/fork-deploy`. This deploys **our own** OpenFour Registry and Core on testnet, and we become their owner and signer. No permission from Four.meme is needed. The dry run already passed.
- **New preset:** "SplitStock Floor Launch". Every slot reuses the official FairLaunch modules except the **Migrate** slot, which is our new module, `module.migrate.splitstock_floor`.
- **What happens at graduation:**
  1. The module pulls the raised tNVDA from the vault.
  2. It calls `LivePool.mintStable` inside try/catch.
  3. It seeds a meme/sUSD PancakeSwap pair and burns the LP tokens.
  4. If any step fails, it falls back to a normal meme/tNVDA pair and emits `FloorFallback(reason)`.
- **The pitch:** Four.meme already runs "4STOCK" memes priced in a tokenized stock. Their price floor moves with the stock and gaps when the market is closed. Ours graduates into a **dollar** floor.

---

## 4. Keeper (keeper/, Node + viem, server only)

The keeper is a single process, run with `pm2` on a laptop or a small VM. It must **keep running after we submit**, because judges test later.

| Every | Job | CMC credits |
|---|---|---|
| 60 s | Read Atlas NVDAB `latestRoundData()` on mainnet. Push it to AtlasMirror if the price moved more than 0.25% or the last push is over 5 minutes old | 0 |
| 5 min | CMC `/v1/dex/token/price?platform=bsc&address=<NVDAB>` gives the reference price and the deviation | 1 |
| 5 min | CMC `/v1/k-line/candles?platform=bsc&address=<NVDAB>&interval=1h` gives σ, which sets the trigger: `clamp(2.67 − k(σ−σ0))` | 1 |
| 5 min | Post a snapshot to RiskOracle with `responseHash = keccak(raw bodies)` | 0 |
| 60 s | Read `state()` on both pools. Call `rebalance()` if L > trigger | 0 |

- **Market hours:** a hardcoded NYSE calendar sets the `marketOpen` flag. 26 Nov is closed (Thanksgiving). 27 Nov is a half day.
- **Logging:** every CMC call is appended to `keeper/logs.jsonl` with the endpoint, status, credits used, response hash and transaction hash. Together with the on-chain `CmcSnapshot` events, this is our proof of usage for CMC.
- **Budget:** about 600 credits a day, against the free plan's 15,000 a month.

---

## 5. Frontend (app/, Next.js)

**Stack:**
- Next.js 15 App Router with TypeScript.
- wagmi v2, viem and RainbowKit (BSC testnet only).
- TanStack Query (comes with wagmi).
- Tailwind for styling.
- Deployed on Vercel.

**Configuration:**
- Addresses come from `deployments/97.json`. ABIs come from the Foundry `out/` folder, exported to `app/abi/`.
- The CMC key exists **only** in Vercel server env and `keeper/.env`. Nothing with `NEXT_PUBLIC_` ever holds a key.

| Route | Content |
|---|---|
| `/` | Pitch, the live pool numbers (V, S, xNAV, L, CR), how it works in 3 steps, and links to every track's proof |
| `/pool` | **LivePool:** faucet → approve → mint or redeem sUSD or xNVDA. A bar showing the sUSD and xNVDA parts, gauges for leverage and CR, and a "price age" badge |
| `/scenario` | **ScenarioPool.** Buttons: −22% (fires the sell zone), a 5% offset from CMC (mint is blocked by the breaker), and a −30% gap (shows the de-peg and the backstop). Every action is a wallet transaction. A large SCENARIO banner is always shown |
| `/risk` | Atlas vs CMC price chart, deviation, σ, the current trigger, and the history of `CmcSnapshot` and `SellZone` events. Also the keeper log table and a CMC `/v1/key/info` usage card |
| `/launch` | SPLIT crowdfund status (raised and target, your weight, claim), BackstopFund `bufferUsd`, and a link to the Flap-hosted page |
| `/memes` (stretch) | Tokens on our OpenFour fork: buy and sell in tNVDA, and the result of each graduation (sUSD floor or fallback) |
| `/api/risk` | Server route. Fetches CMC on the server (cached for 60 s) and returns only the processed numbers |
| `/api/keyinfo` | Server route. A CMC `/v1/key/info` snapshot, which costs 0 credits |

**Reading data:**
- The app reads on-chain state through `multicall` on `state()`, refreshed every 10 seconds.
- Event history uses viem `getLogs` with a block range.
- There is **no database**. The chain and `logs.jsonl` are the only sources of data.

**`flap-ui/`** is separate. It is a `Launcher` React component built from Flap's `green-presale-launcher` template:
- `manifest.json` (schemaVersion 2), plus `i18n.json` in English, Chinese and Korean.
- Inline styles only.
- Checked with `yarn launcher:check-source`, zipped, and sent to Flap.

---

## 6. Who builds what

| Owner | Work |
|---|---|
| **Claude** | All contracts and tests (pool, oracle, risk, mocks, Flap launcher and backstop, OpenFour module). Deploy scripts and `deployments/97.json`. The keeper. The Next.js scaffold with every page wired to the contracts. The flap-ui component. Drafts of the README and write-up |
| **Derek / team** | Run the deploys with the testnet wallet. Talk to Flap and Four.meme (the factory enable, and whether a fork-only prototype is OK). Check UI and UX polish in the browser. Record the video. Submit on HackQuest. Host the keeper |

## 7. Schedule (UTC+7, Wed 26 → Thu 27 Nov)

| Time | Work | Done when |
|---|---|---|
| 16:45–18:30 | Pool, mocks, AtlasMirror, RiskOracle, ScenarioFeed, with unit tests | `forge test` green, including the math, de-peg, seed, breaker and sell zone |
| 18:30–19:15 | Deploy to testnet. Seed the PancakeSwap pair and xNVDA. Start the keeper | `Mirrored` and `CmcSnapshot` events on BscScan |
| 19:15–21:00 | Flap launcher, factory and backstop. Fork test against the live Portal. Deploy the factory and **send it to Flap** | Factory verified, enable requested |
| 19:15–22:30 | Next.js app: `/pool`, `/scenario`, `/risk`, `/launch` (in parallel with the Flap work) | Mint and redeem work from the browser |
| 21:00–22:30 | Flap UI ZIP, sent to Flap | Preview link requested |
| 22:30–01:00 | OpenFour fork, then SplitFloorMigrateModule, its tests and preset registration | A `MigrateExecuted` event on our fork |
| 01:00–02:00 | Flap live launch (if enabled) or a recorded fork test. Run the OpenFour create → graduate flow | Transaction hashes collected |
| 02:00–03:00 | Full rehearsal on testnet. Fix bugs. **Code freeze at 03:00** | The demo script runs cleanly twice |
| 03:00–05:00 | README, WRITEUP.md (CMC × Atlas one-pager), address table, diagrams | Docs done |
| 05:00–06:30 | Record the videos: a 3-minute main video, with shorter cuts for the CMC (≤3 min) and Four.meme (2–3 min) tracks | Uploaded |
| 06:30–07:00 | Submit on HackQuest, all 4 tracks | Confirmation received |

**Cut list (cut from the top when behind):**
1. `/memes` page.
2. The holder gate on the Four.meme module.
3. Mainnet AtlasCmcAnchor.
4. The volatility-based trigger (keep a fixed 2.67x, but still post σ).
5. UI polish (fall back to BscScan).
6. Flap's `LauncherConfig` create view.

**Never cut:**
- Mint, redeem and rebalance on testnet.
- AtlasMirror carrying live Atlas data.
- `CmcSnapshot` posted on-chain.
- Keys kept on the server.
- The Flap factory deployed, with the enable request sent.
- The OpenFour migrate module running on our fork.
- README, write-up and video.

## 8. Proof each track gets

| Track | Evidence |
|---|---|
| **CMC × Atlas** | AtlasMirror `Mirrored` events (each matches the Atlas mainnet feed). `CmcSnapshot` events with response hashes. `keeper/logs.jsonl` and `/v1/key/info` before and after. BackstopFund reading the Atlas testnet BNB/USD feed. A one-page write-up: problem, the endpoints and why we use them, the address table, next steps |
| **Developer (RWA)** | Verified contracts. A primitive for tokenized stocks that handles market hours and gaps and deleverages through a DEX. An autonomous keeper. f(x) Protocol credited as prior art. Honest limits: sUSD de-pegs pro rata if the xNVDA side is wiped out |
| **Flap** | The factory address, `FlapNewLauncherCreated`, the contribute, launch, claim and dispatch transactions, the BackstopFund balance, and the preview link of our UI |
| **Four.meme** | The fork deployment, the `upsertModule` and `upsertPreset` transactions, `TokenCreated`, buy and sell trades, and a sell-out transaction containing `MigrateExecuted`, the pool mint and the meme/sUSD pair reserves. Plus one `FloorFallback` example |

## 9. 3-minute demo script
1. **(0:00) The problem.** Tokenized stocks on BNB have no leverage without liquidations, and there is no stable dollar backed by stock.
2. **(0:20) `/pool`.** Get tNVDA from the faucet, mint xNVDA, mint sUSD. Show the bar and leverage go to 2x. Show the price is live Atlas (age badge plus BscScan `Mirrored`).
3. **(0:50) `/scenario`.**
   - −22%: the keeper calls `rebalance()`, `SellZone` fires and leverage goes back to 2x.
   - 5% offset: mint reverts because of the breaker.
   - −30% gap: show the de-peg maths and the backstop.
4. **(1:40) `/risk`.** Atlas vs CMC, σ moving the trigger, and the on-chain snapshots.
5. **(2:10) `/launch`.** The SPLIT crowdfund, the 7777 token, and the tax flowing into the backstop.
6. **(2:35) Four.meme.** A meme graduates into a meme/sUSD pair.
7. **(2:50) What's next:** mainnet NVDAB, a buy zone, a holding fee.

## 10. Open checks
- [ ] Flap: how long the fast-track enable takes, and whether the floor multiplier changes the 1.5 tBNB raise.
- [ ] Four.meme: is a fork-only prototype acceptable, and does "Hub" mean the module/preset path?
- [ ] A separate mainnet wallet with about 0.01 BNB, if we keep AtlasCmcAnchor.
- [ ] Where the keeper runs after submission (a laptop must stay on, or use a small VM).
