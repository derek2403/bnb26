# Recording rehearsal (BSC testnet 97)

Run: 2026-11-26, 18:38–18:56 UTC. NYSE was closed (Thanksgiving). Addresses are in `deployments/97.json`, and every tx hash is also listed in `docs/DEPLOYED.md` §11.

Wallets used: the **team wallet** 0x3177…BE7B (feed operator, admin, keeper key; the keeper was stopped during its broadcasts and restarted afterwards) and the **rehearsal wallet** 0x478d…5cBa (user-like actions: cover, rebalance, ScenarioPool sUSD). The user's demo wallet 0x1c9b…75F3 was not touched. GPU Goblin was not bought; it is now retired (hidden in `deployments/97.json`) and scene 6 uses the **TSLA Market (TSLAM)** launch instead, created afterwards (2026-11-26 19:02 UTC) from the team wallet with the same preset and economics.

## Results per step

| Step | Result | Evidence |
|---|---|---|
| Fill the insurance vault | **PASS** | The vault went from $0 to **$22.43** (0.040566 tBNB at Atlas BNB/USD 552.6, fresh). See below. |
| Scene 1 `/pools` | **BLOCKED (app)** | At 18:55 UTC every page on :3000 returns 500. The app is mid-redesign in the working tree: `globals.css` uses the new `accent` colour that `tailwind.config.ts` now defines, but the running `next dev` has not reloaded the config. Restart the dev server (checklist step 0). |
| Scene 2 Flap site | **PASS (on chain)** | Launched, graduated, `PoolOpened` tx 0x374278dd…44dc. Not clicked here (it is a view-only scene). |
| Scene 3 mint xNVDA then sUSD | **PASS (fork simulation from the demo wallet)** | 1 tNVDA → 145.1 xNVDA (L 1.90 → 1.66), then 1.2 tNVDA → 178.5 sUSD (L → **1.97**, CR 203%). Nothing was broadcast from the demo wallet. |
| Scene 4 CMC breaker | **PASS** | setPrice at 5% under the CMC ref (tx 0xdfcaacfa…4daf3): `previewMintStable` and `mintStable` revert `BreakerTripped(500, 250)`. |
| Scene 4 −55% + cover | **PASS** | setPrice to 45% of the anchor (0xbe927746…a4e1): CR 0.9114, STABILITY mode. `cover(ScenarioPool)` from the rehearsal wallet (0xd306641e…2b94): **Defended(bnbIn 0.000914 tBNB, usdcOut $0.5006, crBefore 0.911410, crAfter 0.911574)**. `isDonor(vault)` was already true, so no `setDonor` was needed. |
| Scene 4 Reset + −22% + sell zone | **PASS** | reset (0x4a170078…4024), −22% (0xda9316d5…d4ec8): L 2.72. `rebalance()` (0x3939f84f…aadf) emits **SellZone**: sold 12.52 tNVDA for 1,467.56 mUSDC, L 2.72 → **1.89**. |
| Scene 4 back to start | **PASS** | `services/scripts/scenario-prep-97.sh`: price at the anchor $150.27, L 1.975, CR 2.03, U 0, S 2,655.95. A −55% from here gives CR 0.911. |
| Scene 5 risk + agent | **PASS** | 55 `CmcSnapshot` indexed. `agent once --asset NVDA` → **TIGHTEN**, proposal id 3, tx 0xc3aadf2ac3c573c41eab1cf4a2840caac391a00df5e645edb98f93d1065a4103 (target 1.9 → 1.8, lower trigger 1.6 → 1.5, maxDev 250 → 200 bps, closed fee 100 → 150 bps, gap guard 3600 → 5400 s; horizon 2 h, so it lapses about 20:50 UTC). |
| Scene 6 TSLA Market (TSLAM) | **READY (not run, reserved)** | Token 0xDf99BC0b04a166Dd3C21dDe4dA4a16e8Ad4981a3, 720k / 800k sold (90%), 3.6 / 4.0 tTSLA raised. `previewGraduation`: healthy, hasCreatorRole, feedFresh, breakerOk all true, mints not paused. The final 80,000 TSLAM costs **0.406 tTSLA** (0.400 + 0.006 fee). A fork simulation of that buy (rehearsal wallet, 12M gas limit) graduated on the pool branch: new TSLA pool, 2.0 tTSLA seeded as first-loss xTSLA to the BackstopTreasury, 2.0 tTSLA minted 760.0 sUSD (no mint cap hit), TSLAM/sUSD LP to 0xdead, gas used about 6.0M. |
| Scene 7 proof events | **PASS (chain + API)** | All of these are on chain 97 and served by `http://localhost:8080/events/all?name=…`: Mirrored (379), CmcSnapshot (55), SellZone (3), BuyZone (3), PoolOpened (1), MigrateExecuted (1, the Test Rocket rehearsal), AgentProposal (3), Defended (1), BufferValued (5). The app's `/proof` and `/risk` pages could not be checked because of the 500 above. |

### Vault funding numbers

| | Value |
|---|---|
| Launcher `claim()` | 500,000 tokens to the team wallet (0x5e71f702…d692) |
| Round 1 | 3 × 0.1 tBNB buys and 3 × 20k sells on the Flap V2 router, then `dispatch()` and `sync()` → vault 0.009141 tBNB = $5.05 |
| Round 2 (after the rehearsal cover, to refill the cover budget) | the same trades again, then `dispatch()` and `sync()` |
| Vault now | 0.040566 tBNB = **$22.43**. totalRevenue 0.041481, spentScenarioTotal 0.000914, totalDefendedUsd $0.50 |
| Cover budget left | ScenarioPool 0.003234 tBNB (about **$1.78**); live pool 0.0207 tBNB |
| Team wallet | **4.26 tBNB** (it was 2.67 before this run), 117,324 tokens, 9.41 WBNB/mUSDC LP |

**Not from this run: someone else broadcast from the team wallet during it.** At nonce 754 there was a Flap Portal buy of 1.0 tBNB (0x970b061b…536a), and at nonce 761 a Portal sell of 411,972 tokens (0x5b4a7882…a358). The keeper was stopped, and no repo script sends Portal `swapExactInput`, so this was probably a manual trade on Flap's site from the team wallet, or another agent. Effects: the Flap pair went from 4.51 WBNB / 498,895 tokens to **2.61 WBNB / 866,579 tokens**, so the token price on Flap is about 67% lower. The team wallet's tBNB rose by about 2.2. The vault received the extra fees, which is most of the $22.

**WBNB/mUSDC fix.** The pair had 0.15 WBNB at 1.3% under Atlas. That was too thin: the next cover would have halved down to about $0.2, and with a small BNB move it would have reverted `SwapShort`. I aligned it to Atlas (+0.3%) and added 0.25 tBNB of liquidity, giving 0.3997 WBNB / 221.6 mUSDC. A fork simulation of the recording's −55% now covers the full budget: **+$1.78, CR 0.9114 → 0.9121**.

### Things to know before recording

1. **Scene 4 needs the team wallet.** On the shared ScenarioPool, only the feed operator (the team wallet) can move the price, and `publicSetter` is false. The demo wallet sees the buttons disabled ("Only the feed operator … can move this price").
2. **The cover is real but small.** For the team-priced ScenarioPool, the vault may spend at most 10% of all the fees it has ever received, and 20% of its buffer per day. That allows about $1.78 against a $236 shortfall, so the app shows CR "91% → 91%" (0.9114 → 0.9121). Say "the vault steps in, capped" and point at the Defended toast or BscScan, rather than at a big CR jump. For a visible jump, the vault needs far more fees: about $10 of fees per $1 of cover, which is roughly 1 tBNB of Flap trading per $0.8.
3. **One cover per refill.** The recording's −55% uses the whole remaining budget. A retake shows "the insurance vault … cannot cover yet". To retake, first add Flap fees (trade on Flap's site, then wait ≤ 10 min for the keeper's dispatch). `scenario-prep-97.sh` now prints the budget left.
4. **Click order on `/scenario`.** CMC deviation → −55% → Reset → −22%. After −22% has run the sell zone, the pool holds mUSDC, and −55% no longer puts it under water.
5. **Avoid the gap-guard window.** Do not record 13:00–14:30 UTC on a trading day (90 min before the NYSE open while the agent TIGHTEN is active, 60 min otherwise). The mint caps drop then, and the scene 3 sUSD mint can revert.

## Recording checklist

Wallet **0x1c9b117e5b4667A0729b91Ba5d5358b1e0D075F3** in MetaMask on BSC testnet (chain 97). It holds 1 tBNB, 20 tNVDA, 20 tTSLA and 5,000 mUSDC, which is enough. For scene 4 only, you also need a second MetaMask account, "MORE ops": import the team wallet's key yourself from `.env` (`KEEPER_PRIVATE_KEY`).

### 0. Fifteen minutes before

```bash
cd /Users/derek/Developer/bnb26
docker start splitstock-pg
bash services/scripts/keeper-97.sh status      # must say running; if not: bash services/scripts/keeper-97.sh start
bash services/scripts/keeper-97.sh api-start   # read API on :8080 (prints "already running" if it is up)
# restart the app so it picks up tailwind.config.ts (the current dev server returns 500):
#   stop the running `next dev` on :3000, then
cd app && npm run dev                          # http://localhost:3000
```

- Open `http://localhost:3000/pools`, `/proof` and `/risk`. None of them may show a 500, and the NVDA price chip should read "Atlas · <60 s ago".
- Fresh AI proposal (optional; the last one lapses about 20:50 UTC on 2026-11-26). This signs with the agent wallet, not the team wallet:
  ```bash
  cd /Users/derek/Developer/bnb26/services && set -a && . ../.env && set +a && \
  KEY_FALLBACK=none DB_DISABLED=false DATABASE_URL=postgres://splitstock:splitstock@localhost:5432/splitstock \
  npx tsx src/cli.ts agent once --asset NVDA
  ```
  Expect `"classification": "tighten"` and a tx hash. If it returns noop, `/agent` still shows the previous proposal.
- Scenario state (only after a take, or if `/scenario` does not show L ≈ 1.97 and CR ≈ 203%): `bash services/scripts/scenario-prep-97.sh`. It stops and restarts the keeper. Check its last line: "ScenarioPool cover budget" must be > 0.
- Flap tab open on the launcher page (link in `docs/DEMO.md`, scene 2).
- Browser at 110% zoom, light mode, Demo mode on.

### Scenes

| # | Page | Clicks and amounts | Expect |
|---|---|---|---|
| 1 | `/pools` | Scroll. Point at NVDA "Opened by Flap" and TSLA "awaiting launch / Four.meme". | NVDA pool value about $790, L about 1.90. |
| 2 | Flap tab | Show the filled raise and "pool opened", then scroll to the vault panel: buffer about $22, first-loss xNVDA 120.5 held. | View only, no tx. |
| 3 | `/pools/nvda-flap` | **Mint xNVDA: 1 tNVDA** → approve (first time) → mint. Then **Mint sUSD: 1.2 tNVDA** → approve → mint. | About 145 xNVDA, L 1.90 → 1.66. Then about 178 sUSD, **L ≈ 1.97**, CR ≈ 203%. If the pool has moved, use about 85% of the "max" sUSD mint the page shows. Show the price chip, the market pill and the insurance vault card. |
| 4 | `/scenario` (shared ScenarioPool) | Right before: `bash services/scripts/keeper-97.sh stop`, then switch MetaMask to **MORE ops**. Click **CMC deviation** → **−55%** (two txs: price, then cover) → **Reset** → **−22%** (two txs: price, then rebalance). Right after: switch MetaMask back to the demo wallet, then `bash services/scripts/keeper-97.sh start`. | CMC: "Mint blocked by the breaker" (4% apart while the agent TIGHTEN is active, limit 2%; otherwise 5%, limit 2.5%). −55%: CR 91%, then "The insurance vault covered" (Defended, +$1.78). −22%: "leverage hit 2.72x … back to 1.89x" (SellZone). |
| 5 | `/risk` → `/agent` | Show Atlas vs CMC, volatility and the trigger. Open the latest proposal. | Wait about 15 s after the keeper restart so the Atlas age is fresh. Proposal: TIGHTEN, with the NYSE half day and weekend gap in its rationale. |
| 6 | `/memes` → TSLA Market (TSLAM) | Buy → **"Buy remaining 80,000"** → Approve tTSLA (first click), then Buy. In MetaMask: **Edit gas → Advanced → Gas limit 15,000,000** (at least 12M), unless the page already set it. | Pays about 0.406 tTSLA (max 0.410). The sell-out graduates and opens the TSLA pool. Back on `/pools`, TSLA says "Opened by Four.meme" (found on chain within about 15 s). |
| 7 | `/proof` | Show the address list, the BscScan links and one verified CMC log. | Mirrored, CmcSnapshot, SellZone, PoolOpened, MigrateExecuted, AgentProposal and Defended are all listed. |

### Retake reset

- Scene 3: nothing to do (each take just adds to the pool). Keep the demo wallet's tNVDA ≥ 3.
- Scene 4: run `bash services/scripts/scenario-prep-97.sh` (from the repo root: feed reset → redeem the rehearsal sUSD → buy zone → mintStable to L ≈ 1.97). If its "cover budget" line says 0, add Flap fees first.
- Scene 6: cannot be retaken. The TSLAM deadline is 2026-12-10 19:02 UTC; after that the keeper graduates it on its own.
