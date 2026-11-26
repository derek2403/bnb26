# MORE

**Leverage on real stocks, no liquidations.** MORE splits a tokenized stock into sUSD (a stock-backed dollar) and xSTOCK (about 2x leverage that is never liquidated).

> BNB Hack Bangkok · Developer, CMC × Atlas, Flap and Four.meme tracks. **Status: deployed on BSC testnet; the Flap launch is complete and opened the NVDA pool; the Four.meme (OpenFour) preset is live** (see [Status](#status) and [docs/DEPLOYED.md](./docs/DEPLOYED.md)).

MORE splits a tokenized stock into two tokens:

- **sUSD-<SYM>**, a dollar backed by the stock;
- **x<SYM>**, leverage of about 2x that is never liquidated.

Nobody borrows, so nobody can be liquidated. Instead, a sell zone and a buy zone swap stock and USDC on PancakeSwap to keep leverage inside a band.

- **Price:** Atlas sets it (the mainnet NVDAB / TSLAB feeds, mirrored to BSC testnet).
- **Risk limits:** they come from CoinMarketCap data. A deterministic keeper posts hashed CMC snapshots on-chain. An AI Risk Steward with an ERC-8004 identity may *tighten* the limits immediately; any loosening waits behind a timelock and a Guardian veto.
- **Market hours:** NYSE hours and gaps are enforced on-chain by a `MarketCalendar`.

**One output, two launchpads.** Every launch opens a NEW MORE pool through the shared `PoolFactory.createPool`. The raise becomes protocol-owned first-loss xSTOCK through `pool.seed(cIn, backstop)`, and the launch token's fees fund that pool's backstop.

| | Flap → NVDA pool | Four.meme (OpenFour) → TSLA pool |
|---|---|---|
| Raise | Crowdfund in tBNB (`SplitLauncher`, Flap Pool Launch, 7777 tax token) | Fair launch quoted in mock tTSLA (our "SplitStock Pool Launch" preset on our own OpenFour fork) |
| Pool opened by | `SplitLauncher.openPool()` | `SplitPoolMigrateModule.executeMigration` at graduation |
| First-loss x goes to | `BackstopVault` (Flap vault, funded by 50% of the token tax) | `BackstopTreasury` (preset author/partner fees) |
| Fallback | `releaseSeed()` to the vault after 14 days | meme/tTSLA PancakeSwap pair after the grace window |

Loss order when the price falls: zones (rebalance) → StabilityPool → backstop `cover(pool)` (`pool.donate`, capped at S − V) → pro-rata haircut on sUSD.

`V = C·P + U`, `E = V − S`, `xNAV = E / X`, `L = C·P / E`, `CR = V / S`.

Prior art: f(x) Protocol (AladdinDAO) splits ETH and BTC into a stable token and a leveraged token. MORE differs in four ways: it is backed by stock, its trigger comes from outside data, it handles market hours and gaps, and it deleverages through a DEX with a launch-funded backstop.

**Limits.** The testnet assets are mocks labelled MOCK. The testnet price arrives through a relayed mirror. No real-money mainnet pool exists. The mainnet (56) contracts are read-only anchors.

## CoinMarketCap × Atlas challenge: what the brief asks for and where it is

| Requirement | How MORE meets it |
|---|---|
| A data source in a core product feature | Both are core. **Atlas** is the pool price: every mint, redeem, sell zone and buy zone reads it. **CoinMarketCap** sets the risk limits on-chain: the mint breaker, the sell-zone trigger, the fees and the size of each sell. |
| CoinMarketCap: a live Pro API call | The keeper calls the Pro API every few minutes: `/v1/dex/token/price`, `/v1/k-line/candles`, `/v3/cryptocurrency/quotes/latest` (NVDAB id 40215), `/v5/real-world-assets/quotes/latest` (NVDA rwa_id 2), `/v1/dex/token/pools`, `/v3/fear-and-greed/latest` and `/v1/key/info`. The AI risk agent also reads CMC through its MCP server. The app's candle chart is CMC k-lines (`/api/candles` returns `"source":"cmc"`). |
| Atlas: read an on-chain feed | The Atlas NVDAB feed on BSC mainnet, [`0xf25af129…ccda`](https://bscscan.com/address/0xf25af12920d408baf6211e9e90eda89df3d8ccda), is read each round and mirrored to BSC testnet, where the pools read it. Atlas BNB/USD on testnet values the insurance vault. Atlas pull payloads are verified on-chain as a second price. |
| Deployed on BNB Chain | BSC testnet (chain 97). Addresses: [deployments/97.json](./deployments/97.json) and [docs/DEPLOYED.md](./docs/DEPLOYED.md). NVDA market pool: [`0x0CD8…D208`](https://testnet.bscscan.com/address/0x0CD861cd0dD919434019f18F71630D2F678CD208). RiskOracle: [`0x0411…1190`](https://testnet.bscscan.com/address/0x0411D501839553cc53cbbcE45eD87501DF531190). |
| Working data calls, verifiable | Each CMC snapshot is posted on-chain as `CmcSnapshot` with `responseHash`, the keccak of the raw CMC response bodies. Every CMC and MCP call is also written to a hash-chained log, and its Merkle root is stored in `LogAnchor` [`0x96b3…3ca0`](https://testnet.bscscan.com/address/0x96b3F4BE973A314E73c9ACA81c206c7Fec5d3ca0). First anchor: 1,050 log entries, root `0x8417b2de…13ac`, tx [`0x8d4ab202…df9a`](https://testnet.bscscan.com/tx/0x8d4ab202858cb22fa80198192fcd2db6e1eea5756d86a7e09da4127511cddf9a). The keeper anchors hourly from then on. The app's Transparency page re-hashes a raw CMC response in the browser and checks it against the on-chain hash. |
| Code access | This repository is public. |
| Setup instructions | [Setup](#setup) and [Run order](#run-order-bsc-testnet-97) below. |
| Demo, up to 3 minutes | Script: [docs/DEMO-FLOW.md](./docs/DEMO-FLOW.md). Video link: in the HackQuest submission. |
| One-page write-up | [docs/WRITEUP.md](./docs/WRITEUP.md): the problem and audience, each feed and endpoint with its on-chain effect, the contract addresses, and what comes next. |
| Team and contact | Derek Liew, GitHub [@derek2403](https://github.com/derek2403). |
| API keys kept out of the front end and the repo | Keys live only in gitignored `.env` files and are read server-side. The build fails if any `NEXT_PUBLIC_*KEY*` variable exists. |

## Docs

- [docs/DEMO-FLOW.md](docs/DEMO-FLOW.md): the current demo script (launch a market, trade in the sandbox, the mechanism, Atlas).

- [docs/DEMO.md](./docs/DEMO.md): the 3-minute demo script (7 scenes).
- [docs/WRITEUP.md](./docs/WRITEUP.md): the one-page CMC × Atlas write-up (feeds, endpoints, on-chain effects, contract addresses).
- [docs/HACKQUEST.md](./docs/HACKQUEST.md): ready-to-paste HackQuest submission fields.
- [docs/REHEARSAL.md](./docs/REHEARSAL.md): the testnet rehearsal run.
- [docs/DEPLOYED.md](./docs/DEPLOYED.md): deployed state, transactions and the keeper.

## SPLIT: the backstop token

SPLIT is the token we launched on Flap. It is a backstage safety-module token, similar in role to the Aave Safety Module: the product app never shows it, and users only see sUSD, xSTOCK and the pool's insurance vault.

- **What it did:** its Flap raise seeded the NVDA pool's first-loss xNVDA through `SplitLauncher.openPool()` → `pool.seed`. That xNVDA is protocol-owned and held by the `BackstopVault`.
- **What it does:** SPLIT has a 3% buy/sell tax for 30 days. 50% of the tax goes to the `BackstopVault` (20% LP, 30% burn). The keeper dispatches it (`FLAP_DISPATCH=true`). The vault is the pool's insurance: while CR < 1 it swaps BNB for USDC and donates it to the pool, capped at the deficit and at 50% of its buffer per day.
- **What it does not do (yet):** SPLIT gives no claim on the pool, no fee share and no governance today. The roadmap items below would add that, and each needs new contracts.

## Roadmap

- **Stake SPLIT into a market's insurance.** Stakers back a pool's insurance vault and take a share of its fees, with a slashing-style first loss when the vault covers a deficit.
- **Stake SPLIT to open a new stock market.** A market opens when enough SPLIT is staked behind it, as a pump.fun-style creation flow with insurance attached from day one.
- **Mainnet NVDAB.** A pool on the real NVDAB token reading the Atlas feed directly (no relayed mirror), with Atlas pull pricing in the pool's mint and redeem paths.
- **More stocks.** TSLA live from the Four.meme graduation, then more tokenized stocks with Atlas feeds and CMC data.
- **sUSD liquidity.** sUSD/USDT pairs and a peg-keep (buy below $0.99, redeem at $1).

## Architecture

```
            CMC REST + MCP ──► services/ keeper ──► RiskOracle (97) ◄── AI Risk Steward (Claude, bounded, ERC-8004)
 Atlas NVDAB/TSLAB (56) ──► keeper mirror push ──► AtlasMirror (97) ──► LeveragePool price
                                     │                                   ▲
                                     └─► AtlasCmcAnchor / LogAnchor (56) │ (hash-chained log, Merkle roots)
 Flap Portal ─► SplitLauncherFactory ─► SplitLauncher ──┐                │
                                                        ├─► PoolFactory.createPool ─► LeveragePool + sUSD + x + StabilityPool
 OpenFour Core ─► SplitPoolMigrateModule (graduation) ──┘     ▲
                                          CreatorRegistrar ───┘ (REGISTRAR_ROLE: grants CREATOR_ROLE per launch)
 BackstopVault (Flap tax) / BackstopTreasury (OpenFour fees) ──► pool.donate when CR < 1
 app/ (Next.js) ──► chain reads/writes + /api/* proxies to services/ (keys stay server-side)
```

- **Core** (`contracts/src/core`, `src/oracle`, `src/mocks`): LeveragePool (with the PoolLogic library), SplitToken, StabilityPool, PoolFactory, SandboxFactory, RiskOracle, MarketCalendar, AtlasMirror, ScenarioFeed, LogAnchor. The specification is `contracts/SPEC.md`.
- **Oracles** (`src/oracle`):
  - `AtlasPullAdapter`: a standalone pull verifier, not yet wired into pool pricing (SPEC §16).
  - `AtlasCmcAnchor` and `NvdabLens`: mainnet.
- **Flap** (`src/launch`, `src/flap`):
  - SplitStockConfig (immutable: the pool target is fixed per factory pair), SplitLauncherFactory / SplitLauncher, BackstopVaultFactory / BackstopVault.
  - `src/flap` is Flap's upstream example, unmodified.
- **OpenFour** (`openfour/startup`, Hardhat): SplitPoolMigrateModule, SplitPoolCustomDataModule, SplitPoolPresetValidator and the `splitstock-pool` preset.
- **Periphery** (`src/periphery/CreatorRegistrar.sol`) and **backstop** (`src/backstop/BackstopTreasury.sol`).
- **services/** (TypeScript, a single Docker image):
  - keeper jobs (mirror, cmc, risk, rebalance, accrue, backstop, openfour, indexer, anchor, mainnet, health);
  - the AI Risk Steward;
  - a Fastify API;
  - Postgres.
- **app/** (Next.js 15), four pages: **Markets** (`/`), **Trade** (`/trade/[id]`: order panel, chart, pool and insurance vault, Risk & AI tab, Stress test sandbox), **Launchpad** (`/launchpad`, Four.meme memes) and **Transparency** (`/transparency`: addresses, events, CMC logs). The older routes (`/pools`, `/scenario`, `/risk`, `/agent`, `/memes`, `/proof`, `/backstop`, `/launch`) redirect to these. The app never shows the backstop token.
- **flap-ui/**: the Flap launcher UI package and the vault UI package, built inside Flap's templates.

## Repo layout

```
contracts/     Foundry (solc 0.8.26): src/, script/ (deploy + launch scripts), test/ (to be written), SPEC.md
deployments/   <chainId>.json address books + SCHEMA.md (the ONLY address source)
openfour/      fork-deploy/ (our OpenFour proxy set on 97), startup/ (Hardhat: modules, validator, preset, scripts)
services/      keeper, agent, API (src/jobs, src/agent, src/api), db/schema.sql, Dockerfile
app/           Next.js app (src/app routes, src/abi generated, src/config/deployments.ts)
flap-ui/       launcher/ and vault/ Flap UI packages, scripts/ (sync addresses, template build)
docs/          supporting material
Makefile       build / deploy entry points
docker-compose.yml   keeper, agent, api, postgres, caddy
BUILD_NOTES.md per-component build notes, cross-component contracts, TODOs
```

## Setup

Requirements: Foundry (`export PATH="$HOME/.foundry/bin:$PATH"`), Node 20+ with npm, and Docker for the services stack.

```bash
cp .env.example .env            # fill in the keys you need (never commit .env)
make deps                       # pinned forge-std / OpenZeppelin 5.1 / OZ-upgradeable 4.9.6 / solady
(cd openfour/startup && npm install) && (cd openfour/fork-deploy && npm install)
(cd services && npm install) && (cd app && npm install)
(cd flap-ui && npm run setup)   # clones Flap's two template branches into flap-ui/.template
make build-all                  # forge build, hardhat compile, services tsc, app build, flap-ui checks
make abi                        # regenerate services/app ABIs after any contract change
```

## Run order (BSC testnet 97)

Each step reads and writes `deployments/97.json`. `DRY=1` simulates a forge step without broadcasting.

1. `make deploy-core`: mocks, core, oracles, PCS v2 pairs, `CreatorRegistrar`, Timelock. The admin handoff is deferred.
2. Start the keeper so the mirrors are fresh: `cd services && npx tsx src/cli.ts keeper once --jobs mirror`, or `docker compose up -d`.
3. `make open-dev-pools`: `nvda-dev`, `nvda-scenario` and `tsla-scenario`. Run it again to seed `nvda-dev` once the mirror is fresh.
4. Flap (after steps 1–3: the config is built from the deployed core and `pools[nvda-scenario]`):
   1. `make deploy-flap`: immutable `SplitStockConfig`, then `BackstopVaultFactory`, then `SplitLauncherFactory` (consecutive nonces of one broadcaster). There is no `set-flap-config` step any more; a core redeploy means a new pair (run `deploy-flap` again and ask Flap to enable it).
   2. Flap enables the factories (they call `setLauncherFactoryMultiplier` / `setVaultFactoryMultiplier`).
5. OpenFour:
   1. `make deploy-backstop-treasury`.
   2. `make openfour-fork`.
   3. `make openfour-register`.
6. `make configure-registrar`: allowlists `flap.launcherFactory` and the OpenFour core/preset on the CreatorRegistrar.
7. Launch:
   - Flap: `make flap S_SIG='newLauncher()'`, then `fill()`, then `openPool()` (the keeper also calls `openPool()`), giving pool `nvda-flap`.
   - OpenFour: `make openfour-lifecycle` (create → buy → sell → sell-out → graduation), giving pool `tsla-four`.
8. `make handoff`: moves `DEFAULT_ADMIN_ROLE` to the Timelock (24 h) and the deployer renounces it. This is irreversible. Afterwards, new launches still get CREATOR_ROLE through the registrar.
9. `make deploy-mainnet` (56, read-only anchors), then `make verify` and `make verify-mainnet`.
10. Services: `docker compose up -d --build` from the repo root. App: `cd app && npm run build && npm start`, or deploy it to a host.
11. Flap UI: `cd flap-ui && npm run sync && npm run build:launcher && npm run check:vault`, then hand both zips to Flap.

## Environment variables

Every name is listed in [`.env.example`](./.env.example), grouped by component:

- deploy scripts and role addresses;
- Flap, BackstopTreasury and registrar script knobs;
- services: RPCs, role keys, CMC, Anthropic, API, Postgres, alerts;
- app server routes and public browser values;
- OpenFour Hardhat. Put these in `openfour/.env`, because Hardhat does not load the root file.

Rules:

- **Secrets stay server-side.** Private keys, CMC/Atlas/Anthropic keys, `KEEPER_TOKEN`, `OF_UI_SIGNER_PRIVATE_KEY` and `DRIP_PRIVATE_KEY` are only ever read by forge scripts, services or Next.js server routes.
- **No secret gets a `NEXT_PUBLIC_` prefix.** The app build fails on any `NEXT_PUBLIC_*KEY*` variable.
- **The Makefile sources `.env` inside each recipe** and drops empty values, so the script defaults apply. No key is ever put on a command line.

## Address book

`deployments/<chainId>.json` is the only place addresses live (format: [`deployments/SCHEMA.md`](./deployments/SCHEMA.md)).

- **Writers:** deploy scripts (through `contracts/script/lib/DeploymentsIO.sol`) and the OpenFour Hardhat scripts.
- **Readers:** services, app (`npm run sync:deployments` copies it into `app/src/generated/`), flap-ui (`npm run sync`) and the OpenFour scripts.
- Never hardcode an address anywhere else.
- Demo-only pools (AAPL, MSFT, …) are simulated in `app/src/config/demoPools.ts`, are labelled "Simulated", and are not in the address book.

## Flap review notes

**Pool config is fixed per factory pair.** `SplitStockConfig` takes the whole pool target (PoolFactory, stock token, price feed, pool and swap routers, Atlas BNB/USD, ScenarioPool, boost token, pool symbol) in its constructor, validates it there (every address has code, `poolFactory.usdc()` is a contract, the ScenarioPool belongs to that PoolFactory, non-empty asset id, 1–10 byte symbol) and stores it as immutables. It has no admin, no setter, no queue and no Guardian function, and it holds no funds. `SplitLauncherFactory` stores its address as an immutable. Nobody, including the team, the Timelock and the Flap Guardian, can redirect a Launcher's seed at `openPool` or a vault's buffer at `cover`. The only upgrade path left is the one Flap's model already gives the Guardian: each factory's beacon. A new MORE core deployment means a new config + factory pair and a new Flap enable request.

**Core implementations are pinned too.** `PoolFactory.setImplementations` is a core-admin function (deployer, then the Timelock), and `openPool` hands the seed to a freshly cloned pool. So `SplitStockConfig` also records the PoolFactory's `poolImpl`, `tokenImpl` and `stabilityPoolImpl` at deployment (`implementations()`), and `SplitLauncher.openPool` reverts `CoreImplementationChanged` if the PoolFactory reports anything else. A swapped implementation can therefore never receive a seed: `openPool` stays blocked and, after 14 days, `releaseSeed` sends the seed to the BackstopVault (fork test `test_08`). `openPool` also cannot run on a halted feed, because `pool.seed` reverts `FeedHalted` in the same transaction.

**Residual risks (documented, not blocking).**

1. **Cover during a halt needs a fresh price.** While the NVDA feed is halted and the pool is under water, `redeemStable` reverts `RedeemHeld` for up to 6 hours (`MAX_REDEEM_HOLD`, counted from `feed.haltedAtSrc()`). `BackstopVault.cover` can still land during that window at the halted price, but only if that price is no older than the pool's `maxPriceAge` (120 s). The keeper therefore has to keep pushing prices while the feed is halted. After 6 hours the hold lifts and the redemption race returns (see 2). Redemptions themselves accept a price up to `maxRedeemPriceAge` (24 h) old, so if pushes stop, holders can redeem after the hold but cover cannot land.
2. **A drop inside the halt band triggers no hold.** The AtlasMirror halts only on an out-of-band move: 5% per push, widening by 1% per hour of source gap to at most 20%. A drop that stays inside the band (≤ 20%) does not halt the feed, so no hold applies, and redemptions and cover race each other. Under water, `redeemStable` pays pro rata `V / S` (a haircut). A holder who redeems before the cover takes that haircut, and a holder who waits is made whole by the cover.

3. **Core roles that remain (outside the Flap contracts).** These do not change where a launch's seed or a vault's buffer goes, but they do touch the pool the seed ends up in:
   - the AtlasMirror `PUSHER_ROLE` (the team keeper) is a trusted price relay. It sets the NVDA price that bounds `openPool`'s seed-swap minimum and decides when a pool is under water (cover). An out-of-band push halts the feed, and the pool then refuses `seed`;
   - the PoolFactory admin (Timelock after `make handoff`) can call `LeveragePool.setRouter` / `setParams` on an opened pool. Rebalance swaps keep their own minimum-output and balance-delta checks, and `setParams` only accepts values inside `PoolMath.paramsValid`;
   - the ScenarioPool's price is set by the team. The vault may draw at most 20% of its buffer per day and 10% of all revenue ever for it, as `description()` says.

Mitigations:

- The keeper's `mirror` job ticks every 15 s and pushes every new mainnet Atlas round, including while halted. It alerts on `mirror-halted-<SYM>`.
- `cover(pool)` is permissionless, so anyone can land it as soon as the price is fresh. The keeper's `backstop` job calls it for every pool with CR < 1 (checked with `canCover` first).
- `redeemStable(s, minC, minU)` takes minimum outputs, and `previewRedeemStable` shows the haircut, so a holder can refuse a haircut instead of racing.
- Not mitigated on chain: in case 2 the keeper's `backstop` job runs every 10 minutes, so the race window is up to one tick unless someone else calls `cover` first. Covering a large deficit can also take several calls, because cover spends at most 50% of the buffer per day on the live pool and halves its swap on a thin WBNB/mUSDC pair.

## Users & yield

**EN**

- **Plain sUSD holders earn nothing, by design.** sUSD lets a stock-token holder go to dollars without selling the stock on a thin DEX. Minting costs about 0.3% (the NVDA open fee), against DEX slippage, and redeeming back to stock costs 0.2%. Typical use: hedge into dollars before the market closes or ahead of a gap, then redeem.
- **StabilityPool (SP) yield.**
  - Funding is 4% a year on the sUSD supply, minted to SP depositors. APR ≈ 4% × sUSD supply ÷ SP deposits. For example, with half of all sUSD in the SP, the APR is about 8%.
  - When the SP absorbs a sell-zone rebalance, depositors also buy stock at about a 1% discount (`spDiscountBps` = 100). From then on the depositor carries that stock's price risk.
- **Who pays the funding.**
  - Funding is paid by x holders. At launch, all x is the vault's protocol-owned first-loss x, so the launch seed funds the SP yield at first. This is an intentional SP bootstrap. Meanwhile the vault keeps receiving 50% of the token's trading tax.
  - As users mint x, the cost is shared pro rata across all x.
- **x demand.** x is for traders who want about 2x stock leverage with no liquidation. Its costs:
  - 4% a year in funding;
  - rebalance drag in choppy markets;
  - the redeem fee.
- **sUSD liquidity.**
  - DEX: an sUSD/mUSDC PancakeSwap pair is seeded for each live pool (planned for the NVDA pool after it opens).
  - Pool: sUSD is always minted and redeemed against the pool itself at the oracle price (`mintStable` / `redeemStable`, pro rata `V / S` when under water), and it can be parked in the SP.
  - Planned: sUSD/USDT next, and a peg-keep that buys sUSD below $0.99 and redeems it at $1. The BackstopVault does not have a peg-keep today; adding one to the vault needs a new vault implementation, which only the Flap Guardian can install.

**中文**

- **普通 sUSD 持有者没有收益，这是有意设计。** sUSD 让股票代币持有者不必在流动性薄的 DEX 上卖出股票，就能换成美元。铸造费约 0.3%（NVDA 开仓费），对比的是 DEX 滑点；赎回成股票收 0.2%。典型用法：收盘前或跳空前换成美元对冲，之后再赎回。
- **稳定池（SP）收益。**
  - 资金费为 sUSD 供应量的年 4%，以 sUSD 铸给 SP 存款人。APR ≈ 4% × sUSD 供应量 ÷ SP 存款。例如一半 sUSD 存在 SP 中时，APR 约 8%。
  - SP 承接卖出区再平衡时，存款人还能以约 1% 的折扣（`spDiscountBps` = 100）买入股票。此后存款人承担该股票的价格风险。
- **谁支付资金费。**
  - 资金费由 x 持有者支付。初期所有 x 都是金库持有的协议首亏 x，所以 SP 的早期收益来自发射种子资金。这是有意的 SP 冷启动。同时金库持续获得代币交易税的 50%。
  - 用户铸造 x 后，成本按持有比例由所有 x 分摊。
- **x 的需求。** x 面向想要约 2 倍股票杠杆且不会被清算的交易者。成本：
  - 年 4% 资金费；
  - 震荡行情中的再平衡损耗；
  - 赎回费。
- **sUSD 流动性。**
  - DEX：每个 live 池都会建立并注入流动性的 PancakeSwap sUSD/mUSDC 交易对（NVDA 池开放后建立，目前为计划）。
  - 池子：sUSD 始终可以直接通过池子按预言机价格铸造和赎回（`mintStable` / `redeemStable`，资不抵债时按 `V / S` 比例），也可以存入 SP。
  - 计划：接下来是 sUSD/USDT，以及锚定维护：低于 $0.99 时买入 sUSD，按 $1 赎回。BackstopVault 目前没有锚定维护功能；要加到金库里需要新的金库实现，而只有 Flap Guardian 能安装。

## Status

- **Code:** written for every component.
- **Builds:**
  - `forge build` (default `contracts/out`) passes.
  - `npx hardhat compile` passes in `openfour/startup`.
  - `npx tsc --noEmit` passes in `services`.
  - `npm run build` passes in `app`.
  - flap-ui `build:launcher` (check-source, typecheck, zip) and `check:vault` pass.
- **Tests that exist and pass:** `test/LeveragePool.t.sol` (88 tests), `test/Zones.t.sol`, `test/OracleRisk.t.sol`, the invariant suite, `test/launch/CoreAbiPin.t.sol`, and `test/fork/FlapLaunchFork.t.sol`. The Flap fork test runs against the live BSC testnet Portal v1.2.0: `newLauncher`, then contributions, then `launchTaxTokenV2`, then trade, dispatch, `openPool`, claim and refund. Still pending: the OpenFour Hardhat module tests, the services unit tests and the vault e2e.
- **Deployed (BSC testnet 97):** the core, oracles, Flap factories and OpenFour fork. The Flap launch filled, launched and graduated, and opened the `nvda-flap` pool. `deployments/97.json` is the address book; [docs/DEPLOYED.md](./docs/DEPLOYED.md) has the details. The mainnet (56) read-only anchors are not deployed yet.
- **Sponsor gates:** Flap enabled the factories. Four.meme must confirm that a prototype on our own fork is accepted.
- **Open items:** the `[UNVERIFIED]` items and TODOs per component are in [`BUILD_NOTES.md`](./BUILD_NOTES.md). They include:
  - Atlas pull feed ids;
  - the CMC response shapes for RWA, DEX pools and k-line;
  - the name of `Core.migrate`;
  - the Flap `launchQuoteConfig` shape;
  - the ERC-8004 signature formats;
  - the TSLAB token address.
