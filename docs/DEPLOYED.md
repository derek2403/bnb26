# SplitStock on BSC testnet (chain 97): deployed state

Snapshot: 2026-11-26 ~14:25 UTC. The address book is `deployments/97.json`. This page explains it and adds the tx hashes, the keeper status and the demo prep. If they disagree, `deployments/97.json` is correct.

Team wallet (deployer, PoolFactory admin, guardian, keeper key): `0x31777694F7b90b635B1F3B786f5D24be7651BE7B`. Balance: **8.834 tBNB**. That leaves ≥ 5 tBNB for the Flap crowdfund (4.7 tBNB).

Link formats: BscScan `https://testnet.bscscan.com/address/<addr>`, Sourcify `https://repo.sourcify.dev/97/<addr>`. Sourcify status values: **exact** = exact match; **match** = partial (metadata) match, i.e. bytecode verified but comments changed after the deploy; **clone** = EIP-1167 clone of a verified implementation; **n/a** = external contract.

## 1. Core

| Contract | Address | Sourcify |
|---|---|---|
| PoolFactory | [0xF4Ef260a4605A2bfE7B0fF3113065D3FCD6EDBb9](https://testnet.bscscan.com/address/0xF4Ef260a4605A2bfE7B0fF3113065D3FCD6EDBb9) | [match](https://repo.sourcify.dev/97/0xF4Ef260a4605A2bfE7B0fF3113065D3FCD6EDBb9) |
| LeveragePool impl (**new**, RedeemHeld halt hold) | [0xE95aE2995aA3a7B9Bda0E36B78C1e62F13849138](https://testnet.bscscan.com/address/0xE95aE2995aA3a7B9Bda0E36B78C1e62F13849138) | [match](https://repo.sourcify.dev/97/0xE95aE2995aA3a7B9Bda0E36B78C1e62F13849138) |
| PoolLogic (**new**, linked library) | [0xB06B203d2080984e30C7B1844a6EEd9d5C576212](https://testnet.bscscan.com/address/0xB06B203d2080984e30C7B1844a6EEd9d5C576212) | [exact](https://repo.sourcify.dev/97/0xB06B203d2080984e30C7B1844a6EEd9d5C576212) |
| LeveragePool impl (legacy: dev and scenario pools) | [0xcf70F6864DBB05D829E62A637018F7ec84C747d4](https://testnet.bscscan.com/address/0xcf70F6864DBB05D829E62A637018F7ec84C747d4) | not verified (its source has changed since) |
| PoolLogic (legacy) | [0x44BCE3FCAE26CabeE16D639240D1dA89376DcA18](https://testnet.bscscan.com/address/0x44BCE3FCAE26CabeE16D639240D1dA89376DcA18) | not verified (its source has changed since) |
| SplitToken impl | [0xdd37B8B530F489Da7A0A3De9D33D7EDEBBE3AC28](https://testnet.bscscan.com/address/0xdd37B8B530F489Da7A0A3De9D33D7EDEBBE3AC28) | [verified](https://repo.sourcify.dev/97/0xdd37B8B530F489Da7A0A3De9D33D7EDEBBE3AC28) |
| StabilityPool impl | [0x5eCC5Cb2dDa45c89FCFE318cD56b259E7C123aC3](https://testnet.bscscan.com/address/0x5eCC5Cb2dDa45c89FCFE318cD56b259E7C123aC3) | [verified](https://repo.sourcify.dev/97/0x5eCC5Cb2dDa45c89FCFE318cD56b259E7C123aC3) |
| ScenarioFeed impl | [0x964F456566F97daCCC16bB58a2b4258414AB8D5b](https://testnet.bscscan.com/address/0x964F456566F97daCCC16bB58a2b4258414AB8D5b) | [verified](https://repo.sourcify.dev/97/0x964F456566F97daCCC16bB58a2b4258414AB8D5b) |
| RiskOracle | [0x0411D501839553cc53cbbcE45eD87501DF531190](https://testnet.bscscan.com/address/0x0411D501839553cc53cbbcE45eD87501DF531190) | [match](https://repo.sourcify.dev/97/0x0411D501839553cc53cbbcE45eD87501DF531190) |
| MarketCalendar | [0x74B302D696D13344fC4b46743d214c6Eca2fC3c2](https://testnet.bscscan.com/address/0x74B302D696D13344fC4b46743d214c6Eca2fC3c2) | [verified](https://repo.sourcify.dev/97/0x74B302D696D13344fC4b46743d214c6Eca2fC3c2) |
| LogAnchor | [0x96b3F4BE973A314E73c9ACA81c206c7Fec5d3ca0](https://testnet.bscscan.com/address/0x96b3F4BE973A314E73c9ACA81c206c7Fec5d3ca0) | [verified](https://repo.sourcify.dev/97/0x96b3F4BE973A314E73c9ACA81c206c7Fec5d3ca0) |
| SandboxFactory | [0xb2A169217733a77B895694642bC9576f73FEf2ab](https://testnet.bscscan.com/address/0xb2A169217733a77B895694642bC9576f73FEf2ab) | [verified](https://repo.sourcify.dev/97/0xb2A169217733a77B895694642bC9576f73FEf2ab) |
| CreatorRegistrar | [0xdE919bD132f6458790f149fAc5F424F1A748919F](https://testnet.bscscan.com/address/0xdE919bD132f6458790f149fAc5F424F1A748919F) | [exact](https://repo.sourcify.dev/97/0xdE919bD132f6458790f149fAc5F424F1A748919F) |
| TimelockController | [0x30c0d846372dcdd13296031748d4d8dB863619C0](https://testnet.bscscan.com/address/0x30c0d846372dcdd13296031748d4d8dB863619C0) | [verified](https://repo.sourcify.dev/97/0x30c0d846372dcdd13296031748d4d8dB863619C0) |
| MockRouter | [0x53f1E6a4507285c0267D0B1C3539F4515c2FECE8](https://testnet.bscscan.com/address/0x53f1E6a4507285c0267D0B1C3539F4515c2FECE8) | [verified](https://repo.sourcify.dev/97/0x53f1E6a4507285c0267D0B1C3539F4515c2FECE8) |

The handoff has **not** been run. The deployer still holds DEFAULT_ADMIN_ROLE everywhere.

## 2. Tokens and oracles

| Contract | Address | Sourcify |
|---|---|---|
| tNVDA (mock) | [0x5Df0DC395E7686bcDc41f75891f1Ab982476fddd](https://testnet.bscscan.com/address/0x5Df0DC395E7686bcDc41f75891f1Ab982476fddd) | [verified](https://repo.sourcify.dev/97/0x5Df0DC395E7686bcDc41f75891f1Ab982476fddd) |
| tTSLA (mock) | [0x9A75c8fFf0ce5Ed6B9F0fc28ad57D0DAC34B05F6](https://testnet.bscscan.com/address/0x9A75c8fFf0ce5Ed6B9F0fc28ad57D0DAC34B05F6) | [verified](https://repo.sourcify.dev/97/0x9A75c8fFf0ce5Ed6B9F0fc28ad57D0DAC34B05F6) |
| mUSDC (mock) | [0x49c67aEf9Ad0bDAF3e96103059E0f931e5a9677D](https://testnet.bscscan.com/address/0x49c67aEf9Ad0bDAF3e96103059E0f931e5a9677D) | [verified](https://repo.sourcify.dev/97/0x49c67aEf9Ad0bDAF3e96103059E0f931e5a9677D) |
| WBNB (PCS testnet) | [0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd](https://testnet.bscscan.com/address/0xae13d989daC2f0dEbFf460aC112a837C89BAa7cd) | n/a |
| NVDA AtlasMirror | [0x5a055A63188315401F8fc22fA451E309a7C6F828](https://testnet.bscscan.com/address/0x5a055A63188315401F8fc22fA451E309a7C6F828) | [verified](https://repo.sourcify.dev/97/0x5a055A63188315401F8fc22fA451E309a7C6F828) |
| TSLA AtlasMirror | [0xD836c54Cb9cB6379A9c40C0B163B8d7f39B30214](https://testnet.bscscan.com/address/0xD836c54Cb9cB6379A9c40C0B163B8d7f39B30214) | [verified](https://repo.sourcify.dev/97/0xD836c54Cb9cB6379A9c40C0B163B8d7f39B30214) |
| NVDA AtlasPullAdapter | [0x599e6f8EB27c71f664AF6c271bF5e7a2fd3FDce3](https://testnet.bscscan.com/address/0x599e6f8EB27c71f664AF6c271bF5e7a2fd3FDce3) | [verified](https://repo.sourcify.dev/97/0x599e6f8EB27c71f664AF6c271bF5e7a2fd3FDce3) |
| TSLA AtlasPullAdapter | [0xa5029d627F21ae84D6208fbbBb03ea04FA4213FD](https://testnet.bscscan.com/address/0xa5029d627F21ae84D6208fbbBb03ea04FA4213FD) | [verified](https://repo.sourcify.dev/97/0xa5029d627F21ae84D6208fbbBb03ea04FA4213FD) |
| NVDA ScenarioFeed (clone) | [0xb92f8082876f0d0372479c451C6E1D0068Be2cC1](https://testnet.bscscan.com/address/0xb92f8082876f0d0372479c451C6E1D0068Be2cC1) | clone |
| TSLA ScenarioFeed (clone) | [0xdBd919A2b27289504b1cB8A853319fa2b0E21aDb](https://testnet.bscscan.com/address/0xdBd919A2b27289504b1cB8A853319fa2b0E21aDb) | clone |
| Atlas BNB/USD (external) | [0x3957d289ee9C38272377786787ea34F9dd29788D](https://testnet.bscscan.com/address/0x3957d289ee9C38272377786787ea34F9dd29788D) | n/a |

## 3. Pools (EIP-1167 clones; BscScan shows them as proxies of the implementations)

| id | pool | sUSD | xToken | StabilityPool | logic |
|---|---|---|---|---|---|
| nvda-dev | [0xA78c…a176](https://testnet.bscscan.com/address/0xA78c6626e452c378FBef98c309774dDc382Ea176) | 0xf07ae54590CF46fA6aCF320a29B0CaAC82c4a621 | 0x7A45345C932c1C557e0EbCa96019C833877a8C8E | 0xE34f3bd0fE64f8A18220ec815063683B5ae9F371 | legacy |
| nvda-scenario | [0xDedA…c833](https://testnet.bscscan.com/address/0xDedAb55A89DB4D6A2b901ed89E34fd589231c833) | 0xEfb04C8C85945c293eaD242Fe884fa6A08E92389 | 0x4e1150F6C8eE03f4303171b61868a0Ff3B4953EE | 0xA4A0Bc80e5e2Dac63020Bc9225bC8BC839b058a4 | legacy |
| tsla-scenario | [0x21d2…705E](https://testnet.bscscan.com/address/0x21d252fA1b95A2F27AE6F1647905CE0bf792705E) | 0xf3Dbd1134AF52632ec0764c8316E46db47Fe74bE | 0x7F9EB86815863FC7D311E4aFDA76798c61bf24e5 | 0x03ad4Af1451e8e634486D28D4b495713De65208e | legacy |
| nvda-flap | not opened yet (Flap launch is blocked) | | | | new |
| tsla-four | not opened yet (opens on the live GOBLIN sell-out) | | | | new |

## 4. DEX (PancakeSwap v2 testnet)

Router `0xD99D1c33F9fC3444f8101754aBC46c52416550D1`, factory `0x6725F303b657a9451d8BA641348b6761A6CC7a17`.

| Pair | Address | State |
|---|---|---|
| tNVDA/mUSDC | [0xb0B258A5811ba61Df778d59bD7A1F314dB2206a9](https://testnet.bscscan.com/address/0xb0B258A5811ba61Df778d59bD7A1F314dB2206a9) | from DeployCore |
| tTSLA/mUSDC | [0x20c8A90668E7AEdac3Ca7e7BE88d41ef7387Cf52](https://testnet.bscscan.com/address/0x20c8A90668E7AEdac3Ca7e7BE88d41ef7387Cf52) | from DeployCore |
| WBNB/mUSDC | [0x315C083D8718799a731F61F28221844bDc724567](https://testnet.bscscan.com/address/0x315C083D8718799a731F61F28221844bDc724567) | from DeployCore (thin: BackstopVault covers halve on it) |
| WBNB/tNVDA | [0xFE5CD6AEdC093e89c871A5297b825956b7f3f906](https://testnet.bscscan.com/address/0xFE5CD6AEdC093e89c871A5297b825956b7f3f906) | **deepened**: 1.1 WBNB / 5.2331 tNVDA |

**Why the WBNB/tNVDA pair is skewed.** `openPool` swaps the 0.2 tBNB seed and requires `minOut = seed × BNB/USD ÷ NVDA × 97%`. With PCS's 0.25% fee, a pair priced at Atlas only passes when it holds X ≥ 7.04 WBNB (0.9975·X/(X+0.1995) ≥ 0.97). That is more than the 1.2 tBNB budget allows. So I added 1.0 tBNB at the existing ratio (`addLiquidityETH`). Then I donated 1.2092 tNVDA, a mintable mock, to the pair and called `sync()`. The pair now prices tNVDA 30% cheaper than Atlas (4.757 tNVDA/WBNB vs Atlas 3.6595).

Quote check: 0.2 WBNB → **0.8037 tNVDA**, against a minOut of **0.7099**. That is 13% of headroom against NVDA/BNB price drift. Only `openPool` uses this pair; covers route WBNB→mUSDC. Before `openPool`, compare `router.getAmountsOut(0.2e18,[WBNB,tNVDA])` with `launcher.seedMinOut(0.2e18)`. `FlapLaunch.openPool()` runs the same preflight.

## 5. Flap side

| Contract | Address | Sourcify |
|---|---|---|
| SplitStockConfig | [0x860fCFF96a6bD842539E6Ee17206bfd49041190E](https://testnet.bscscan.com/address/0x860fCFF96a6bD842539E6Ee17206bfd49041190E) | [exact](https://repo.sourcify.dev/97/0x860fCFF96a6bD842539E6Ee17206bfd49041190E) |
| SplitLauncherFactory | [0xae8f0987a2f831A72d13c8B3Da3731ba7FD09c16](https://testnet.bscscan.com/address/0xae8f0987a2f831A72d13c8B3Da3731ba7FD09c16) | [exact](https://repo.sourcify.dev/97/0xae8f0987a2f831A72d13c8B3Da3731ba7FD09c16) |
| BackstopVaultFactory | [0xF5390582C299791276cb25F379ca22637cB80C57](https://testnet.bscscan.com/address/0xF5390582C299791276cb25F379ca22637cB80C57) | [exact](https://repo.sourcify.dev/97/0xF5390582C299791276cb25F379ca22637cB80C57) |
| Flap Portal (external) | 0x000042108465206185A077Edc3F3fd2b49060000 | n/a |
| Flap Guardian (external) | 0x00004d58290854c5E9880F4b5B1993c6Ad8b0000 | n/a |

- **SplitStockConfig v1 is live** (the first config applies at once): PoolFactory, tNVDA, NVDA mirror, PCS router (swap and pool), Atlas BNB/USD, ScenarioPool `nvda-scenario`, boost token = nvda-scenario sUSD, symbol NVDA. Any later change is queued for 24 h.
- The CreatorRegistrar allowlists the new SplitLauncherFactory, so `registerFlapLauncher(factory, salt)` works.
- Abandoned factories `0x79127b50…` / `0x3449083b…`: never use them. The old `0x79127b50…` is still `flapFactoryAllowed` on the registrar. Flap never enabled it, so this is harmless. `setFlapFactory(0x79127b50B607d360Ec0F6Ed0425617Ce657081B0, false)` removes it.
- **Blocked:** `Portal.launcherFactoryMultiplier(0xae8f…)` = `(enabled=false, multiplierBps=10000)`. Flap has not enabled the new factory yet, so no SPLIT launcher was created. The factory reports `creationFloor()` = 2.142857 tBNB (known) and `minPoolQuote()` = 2.357143 tBNB. Defaults: FLAP_TARGET 4.7 / FLAP_SEED 0.2, giving a pool quote of 4.5. Once Flap enables it: `make flap S_SIG='newLauncher()'`, a partial contribution for the demo, then the live fill → `openPool()`.

## 6. OpenFour (our fork on 97)

| Contract | Address | Sourcify |
|---|---|---|
| Registry | [0xC7603FD7E6bE13c727063a515651981c69a0befa](https://testnet.bscscan.com/address/0xC7603FD7E6bE13c727063a515651981c69a0befa) | fork proxy (not verified here) |
| Core | [0xB969FcaE60ff652Dd59A014a89B16053D619e4ba](https://testnet.bscscan.com/address/0xB969FcaE60ff652Dd59A014a89B16053D619e4ba) | fork proxy (not verified here) |
| Tools | [0x0d0FEB46fdE7540ef95175bc975893B58124B91A](https://testnet.bscscan.com/address/0x0d0FEB46fdE7540ef95175bc975893B58124B91A) | fork proxy (not verified here) |
| FeeRouter | [0x7EEd3cb2cf85D187BBD04996004932C570FB1f8A](https://testnet.bscscan.com/address/0x7EEd3cb2cf85D187BBD04996004932C570FB1f8A) | fork proxy (not verified here) |
| SplitPoolMigrateModule impl | [0x43DAa1613165Cc774ABbe7A956BE9ae97056693a](https://testnet.bscscan.com/address/0x43DAa1613165Cc774ABbe7A956BE9ae97056693a) | [exact](https://repo.sourcify.dev/97/0x43DAa1613165Cc774ABbe7A956BE9ae97056693a) |
| SplitPoolCustomDataModule impl | [0xB61b75A7F1F2384E2C05b745DCd84DD98FfD3B10](https://testnet.bscscan.com/address/0xB61b75A7F1F2384E2C05b745DCd84DD98FfD3B10) | [exact](https://repo.sourcify.dev/97/0xB61b75A7F1F2384E2C05b745DCd84DD98FfD3B10) |
| SplitPoolPresetValidator | [0x3B35e600AEcc3A4386B1d7596A6a6eD85d23A42f](https://testnet.bscscan.com/address/0x3B35e600AEcc3A4386B1d7596A6a6eD85d23A42f) | [exact](https://repo.sourcify.dev/97/0x3B35e600AEcc3A4386B1d7596A6a6eD85d23A42f) |
| FairLaunchCurveModule | [0x438E9F02F6Bece875a5d0F3aC6b73908117004f4](https://testnet.bscscan.com/address/0x438E9F02F6Bece875a5d0F3aC6b73908117004f4) | [exact](https://repo.sourcify.dev/97/0x438E9F02F6Bece875a5d0F3aC6b73908117004f4) |
| FairLaunchTradeModule | [0x87960Ff3FF8B233122C90C547c29E6199b1181a3](https://testnet.bscscan.com/address/0x87960Ff3FF8B233122C90C547c29E6199b1181a3) | [exact](https://repo.sourcify.dev/97/0x87960Ff3FF8B233122C90C547c29E6199b1181a3) |
| FairLaunchMigrateModule | [0xafb4de4b807CA5Ce53c1E7198FA8255935Be5470](https://testnet.bscscan.com/address/0xafb4de4b807CA5Ce53c1E7198FA8255935Be5470) | [exact](https://repo.sourcify.dev/97/0xafb4de4b807CA5Ce53c1E7198FA8255935Be5470) |
| FairLaunchCustomDataModule | [0xeCFa911Cb9eE6B9ef4fE6151ED63EdAc71EA5865](https://testnet.bscscan.com/address/0xeCFa911Cb9eE6B9ef4fE6151ED63EdAc71EA5865) | [exact](https://repo.sourcify.dev/97/0xeCFa911Cb9eE6B9ef4fE6151ED63EdAc71EA5865) |
| FairLaunchPresetValidator | [0x6d746Ca5B87D160f665239410Ea8b04574A8F4cE](https://testnet.bscscan.com/address/0x6d746Ca5B87D160f665239410Ea8b04574A8F4cE) | [exact](https://repo.sourcify.dev/97/0x6d746Ca5B87D160f665239410Ea8b04574A8F4cE) |
| BackstopTreasury (preset author, partner, fee recipient) | [0xFBCddbaF29dEee2549C97a2bfB6d15A64ac4fb65](https://testnet.bscscan.com/address/0xFBCddbaF29dEee2549C97a2bfB6d15A64ac4fb65) | [match](https://repo.sourcify.dev/97/0xFBCddbaF29dEee2549C97a2bfB6d15A64ac4fb65) |

- Preset ids: SplitStock Pool Launch **1795700948232**; FairLaunch baseline 1795700944983.
- The CreatorRegistrar allowlists (Core 0xB969…, preset 1795700948232).
- The fork json was copied to `openfour/workbench/data/fork.json`.
- The fork's StandardToken/StandardVault modules and token impls are the fork's own copies from `openfour/fork-deploy`. They were not re-verified here.

## 7. Demo state

**Four.meme / OpenFour meme: "GPU Goblin" (GOBLIN), quoted in tTSLA**
- token [0x3E27ac92AA02C94b78a6b88fD14429C8CfB7bf31](https://testnet.bscscan.com/address/0x3E27ac92AA02C94b78a6b88fD14429C8CfB7bf31), vault 0x34C6B2558F82E21629d3e305eb6c022fb7dE06d4, migrate clone 0xF59d76dac50eE351663cEa60604Fb9459aE91597, customData 0x9A4C99dCe87c17E92Ccc486124aA84e1Aa13F528.
- **Sold 720,000 / 800,000 (90%)**, raised 3.6 / 4.0 tTSLA. The final buy of 80,000 GOBLIN costs about 0.4 tTSLA plus a 0.5% fee, and it graduates into a NEW TSLA pool (`tsla-four`, new pool logic). Send ≥ 12M gas with that buy; the scripts use 15M.
- CREATOR_ROLE was granted to the clone through the registrar (`registerOpenFourToken`), tx `0x408ea199f82c075247cfba776a6c74dd45bdbc85f884b2bfc5b95ced561eea56`.
- `previewGraduation` with the keeper running: healthy=true, hasCreatorRole=true, feedFresh=true, breakerOk=true, conditionsMet=false.
- **Deadline:** endTime = 2026-12-10 14:08 UTC. After that, the expiry counts as "conditions met", and the keeper's openfour-poker graduates the meme on its own. Record the demo before then, or create a new meme.

**Flap SPLIT crowdfund:** not created (blocked on Flap enabling the factory). Keep ≥ 5 tBNB for it.

## 8. Key transactions

| What | Tx |
|---|---|
| New PoolLogic deploy | 0xd5d2098bc177acdf9f5e4a8c72810476a6944d49804e3da4bb32c7a207cf25f8 |
| New LeveragePool impl deploy | 0x0002e19cbfe02f89d4ed0ab4754d1de5f788c6c1ce52cf3bd177eaa060816b87 |
| `PoolFactory.setImplementations(new pool impl, token, SP)` | 0x075ecea77958bbade49846973f0f438b10534daca78c190a28afb892c2675f24 |
| `SplitStockConfig.setPoolConfig` (v1, live) | 0xb674d6dadffa1dec411e6c6c852720906055443874137ba4416ab5fddc81e01f |
| `CreatorRegistrar.setFlapFactory(0xae8f…, true)` | 0x558a33ce00569339e86c37a89bd2ddc3888d75d36cbba33bbf66cd1c24c2b80c |
| `CreatorRegistrar.setOpenFourPreset(core, 1795700948232, true)` | 0x8842dc7e1654d68632a4e86015f93c13c10777e8c942c4b64b97e8f32b3a2972 |
| SplitStockConfig / BackstopVaultFactory / SplitLauncherFactory deploys | 0x572652806ac2593473c25b6280e20f8b75033e9ad81bfbbe9b300811a510d86b / 0x8b3171e38a2f4c37fd9e12ba926a21f45039830cf7b002ba17274bc5bcdbf5b1 / 0x6e7edcb0d701893543d85c77e4e483aba8877331b828bcf6edefa4f9f7405c3e |
| BackstopTreasury deploy / setRegistry | 0xd42879aee0fe915aa8f59a742e9c80b3c90aa6f45a56a205c1c6cfa6216b07a9 / 0x01bfed52a348b3bb1e5693f058cd4e65160e1b5d020b277a621ee43c28946f1a |
| OpenFour FairLaunch baseline preset / SplitStock preset | 0x01fe1f4dd0a8a50fd1bb98aa385e76a1942a09a1738be5f7b3a52648b99f8b85 / 0xba268be7cb237c0c39ea2da13f4703a2bf9f8bd373a5c5fe07cf9fc381bb98e8 |
| WBNB/tNVDA: mint 5 tNVDA / approve / addLiquidityETH 1.0 tBNB | 0x741bb04c04b56d836fafb780a01f040f5aae5245d5534a87e015ab64efe88182 / 0x54db7814708b1706c132aa3a2ca989be34092d68712ed41bcd5e08aec200a3bf / 0x81216c47a829e16274cef366215b4e4f6c3eea403ae792d4fb62fd8e07adab9a |
| WBNB/tNVDA: donate 1.2092 tNVDA / sync | 0x2d15397dd395bc89fb2120f9f74b57bcb94959fd7ad665bbe50d2a25015ed8fa / 0x76214a420e865bccfd66f5e92fa1a9a7b6f9e52ddc8e6eef595ceb14f7d6205b |
| GOBLIN createToken / 720k buy | 0x4b55ac3ccfce5034903f375d31e647fb7a42753121e1a12f10528c46f31d463e / 0xbe7fdf5725661954426eb35dfbc234bd86b65dc2deac63703d0b8c201b141b23 |
| First keeper `Mirrored` (NVDA / TSLA) | 0x31ba44802681b3c3359a9ff4c2078043c7e3aff71bc0a6c972a51017c82721af / 0x5b1b83894b6e6159a57459e97d84226b0497da03858d0a401005a3cd293c5249 |
| First keeper `CmcSnapshot` (NVDA / TSLA) | 0x3082f7088a81993614a53a8d423f5aa60a23aa04de00decd2c10868beb487d0d / 0xd45884aa4948c1b3756ba6e60b596133373c470ad9bd6237810976f1640b05b5 |
| PoolFactory / RiskOracle / CreatorRegistrar deploys (DeployCore) | 0xa53a2968678f8a030ac26eac904004d962a352bb498b5aecedcea23d8a4cce2a / 0xb166480f5ce0f846cde1c0bb2fe08c3e2fe1ab7bb3d77f0c473954d7af4d758b / 0x476cd85609c277749e2ec01e2be2e3d2ae71ed6664d749029e2d24e583f1f157 |

The full forge broadcast logs are in `contracts/broadcast/<Script>/97/run-latest.json`. The OpenFour logs are in `openfour/startup/out/*.json`, including `splitstock-pool-lifecycle-3e27ac92.json`.

## 9. Keeper

It runs on this machine. Jobs: `mirror` (Atlas mirror, 15 s), `cmc` (CMC collector, 30 s), `risk` (risk engine, posts CmcSnapshot, 5 min), `rebalance` (30 s), `accrue`, `backstop` (backstop-ops, 10 min) and `openfour` (openfour-poker, 1 min). Mainnet writes are off (`MAINNET_ENABLED=false`). Every testnet role is signed by KEEPER_PRIVATE_KEY (`KEY_FALLBACK=keeper`). The agent, API and indexer are not started.

Postgres runs in Docker container `splitstock-pg` (postgres:16-alpine, `127.0.0.1:5432`, volume `splitstock-pgdata`, restart unless-stopped). I started Docker Desktop for it.

```bash
# start / stop / status (logs: services/logs/keeper-97.log)
bash services/scripts/keeper-97.sh start
bash services/scripts/keeper-97.sh stop
bash services/scripts/keeper-97.sh status
# Postgres
docker start splitstock-pg            # after a reboot, once Docker Desktop is up
docker stop splitstock-pg
# first-time creation (already done):
# docker run -d --name splitstock-pg -p 127.0.0.1:5432:5432 -e POSTGRES_USER=splitstock -e POSTGRES_PASSWORD=splitstock \
#   -e POSTGRES_DB=splitstock -v splitstock-pgdata:/var/lib/postgresql/data --restart unless-stopped postgres:16-alpine
```

On-chain check: within the first 6 minutes it sent 14 `Mirrored` pushes, 2 `CmcSnapshot` posts (NVDA and TSLA) and 1 `BackstopTreasury.sweep`, all successful. The keeper broadcasts from the team wallet, so **stop it before any other manual broadcast** from that wallet. Otherwise the nonces collide.

Known noise: a CMC `/v2/cryptocurrency/info` call returns 400 "slug null" once at startup. It is harmless (metadata only).

## 10. Repo changes in this pass

- `contracts/script/UpgradePoolImpl.s.sol` (new) + `make upgrade-pool-impl`. Writes `core.poolImpl` / `core.poolLogic`. `core.poolImplLegacy` / `core.poolLogicLegacy` were added to 97.json (additive keys).
- The Makefile `TESTNET` already had `--legacy --with-gas-price $(GAS_PRICE)` (default 0.1 gwei).
- `contracts/script/verify.sh`: `VERIFIER=sourcify bash contracts/script/verify.sh 97` (no API key).
- `openfour/startup/scripts/verify-sourcify.mjs` (new): Sourcify API v2 verification from the Hardhat build-info. The bundled hardhat-verify still calls the removed Sourcify v1 API. Usage: `node scripts/verify-sourcify.mjs artifacts/build-info/<id>.json 97 <addr>=<path:Name> …`.
- `services/scripts/keeper-97.sh` (new).
- `make abi` was regenerated. `cd app && npm run build` and `cd services && npx tsc --noEmit` pass.
