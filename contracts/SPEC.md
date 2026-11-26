# SplitStock core contracts: build spec (phase 1)

This spec is the contract between the architect and two builders. The interfaces in `src/interfaces/` are frozen. If an interface has to change, do not edit it: write `INTERFACE CHANGE REQUEST: <file> <reason>` in your report and work around it in your own files until it is resolved.

Sources: `full-plan.md` §3.1 and `safety.md`, plus one design change that overrides them: **each launch opens a new pool** through `PoolFactory.createPool`, and pools can hold any stock. Where this spec differs from those plans, this spec wins (see §14).

---

## 0. Ownership, toolchain, rules

| Owner | Files (create exactly these; helpers only under your own paths) |
|---|---|
| **ARCHITECT** (frozen) | `src/interfaces/*.sol`, `SPEC.md` |
| **BUILDER_A** | `src/core/SplitToken.sol`, `src/core/LeveragePool.sol`, `src/core/PoolFactory.sol`, `src/core/StabilityPool.sol`, `src/core/SandboxFactory.sol`. Optional: `src/core/PoolMath.sol`, used only if LeveragePool exceeds the size limit (§2.8). Tests: `test/core/{SplitToken,LeveragePool,PoolFactory,StabilityPool,SandboxFactory}.t.sol`, `test/invariant/Pool*.sol`, `test/scenario/*.t.sol`, `test/utils/A_*.sol`, `test/stubs/*` (temporary stubs of B contracts, deleted at integration) |
| **BUILDER_B** | `src/oracle/AtlasMirror.sol`, `src/oracle/ScenarioFeed.sol`, `src/core/RiskOracle.sol`, `src/core/MarketCalendar.sol`, `src/core/LogAnchor.sol`, `src/mocks/MockERC20Permit.sol`, `src/mocks/MockRouter.sol`, `src/mocks/MockAggregator.sol`. Tests: `test/oracle/*.t.sol`, `test/core/{RiskOracle,MarketCalendar,LogAnchor}.t.sol`, `test/mocks/*.t.sol`, `test/invariant/Risk*.sol`, `test/utils/B_*.sol` |

Out of scope: `src/launch`, `src/flap`, `src/backstop`, OpenFour, AtlasPullAdapter, AtlasCmcAnchor, NvdabLens, deploy scripts, services and app.

**Toolchain.** `export PATH="$HOME/.foundry/bin:$PATH"; cd /Users/derek/Developer/bnb26/contracts`. Use solc 0.8.26 (pragma `0.8.26` in implementations), evm cancun, OpenZeppelin v5.1.0 (`@openzeppelin/contracts/...`) and forge-std. Run `forge build`, `forge test`, `forge build --sizes`. Never read `../.env`. Never commit. Never deploy to a network.

**Working in parallel.** BUILDER_A must not wait for BUILDER_B:
- A's tests reach B's contracts only through interfaces.
- Until B's files exist, A uses stubs in `test/stubs/`: `StubRiskOracle` (settable `RiskView`), `StubCalendar` (settable open/gapGuard), `StubFeed` (settable round and halted), and a plain ERC20 with mint.
- At integration, A switches to `deployCode("MockAggregator.sol:MockAggregator", abi.encode(...))` and the other contracts, using the constructor signatures frozen in §0.1.

### 0.1 Frozen constructor and initializer signatures

| Contract | Deployment |
|---|---|
| `SplitToken` | clone impl; `constructor()` calls `_disableInitializers()`; `initialize(name, symbol, pool)` |
| `StabilityPool` | clone impl; `constructor()` disables; `initialize(pool, stable, asset)` |
| `LeveragePool` | clone impl; `constructor()` disables; `initialize(InitArgs)` |
| `PoolFactory` | `constructor(address admin, address usdc, address riskOracle, address calendar, address poolImpl, address tokenImpl, address stabilityPoolImpl, ILeveragePool.PoolParams memory defaults)` |
| `SandboxFactory` | ABI: `(address poolFactory, address mockRouter, address feedImpl, address asset, address usdc, bytes32 assetId, string symbol, address referenceFeed, int256 fallbackAnswer, uint256 seedAssetAmount, uint256 stableAssetAmount)`. Solidity: `constructor(Wiring memory w, string memory symbol, Amounts memory m)`, where the static structs encode in place, so the calldata is byte-identical (resolution R1) |
| `RiskOracle` | `constructor(address admin)`: defaults from §7.9 |
| `MarketCalendar` | `constructor(address admin)`: preloads the §8 tables |
| `LogAnchor` | `constructor(address admin)` |
| `AtlasMirror` | `constructor(address admin, uint256 srcChainId, address srcFeed, uint8 decimals_, string memory description_)` |
| `ScenarioFeed` | clone impl; `constructor()` disables; `initialize(reference, operator, publicSetter, initialAnswer)` |
| `MockERC20Permit` | `constructor(string memory name_, string memory symbol_, uint8 decimals_, address admin, uint256 faucetAmount, uint256 faucetCooldown)` |
| `MockRouter` | `constructor(address admin)` |
| `MockAggregator` | `constructor(uint8 decimals_, int256 initialAnswer, string memory description_)`; the initial answer has `updatedAt = block.timestamp` |

Every implementation `is` its interface (`contract LeveragePool is ILeveragePool, ...`). Constants come from `src/interfaces/SplitConstants.sol` (`SplitConstants`, `Roles`). Access control is OpenZeppelin `AccessControl` with `DEFAULT_ADMIN_ROLE` = the Timelock. Pools have **no AccessControl of their own**; they ask their factory (`isAdmin`, `isGuardian`).

---

## 1. Conventions (both builders)

**Units**
- USD values are WAD (`1e18` = $1). sUSD has 18 decimals, so `S` in wei equals USD WAD.
- Leverage and ratios are WAD. Fees are bps (`BPS = 1e4`).
- Token amounts are in native decimals. **Never hardcode 18.** Read `decimals()` once at initialize and require it to be ≤ 18 for the asset, mUSDC and the feed, otherwise `UnsupportedDecimals`.

**Scale factors** (store them at initialize):
`aU = 10**assetDec`, `uS = 10**(18 - usdcDec)`, `fS = 10**(18 - feedDec)`.

**Price.** `P = uint256(answer) * fS` (WAD USD per 1 whole asset unit). mUSDC is valued at exactly $1, with no oracle.

**Helpers.** Use OZ `Math.mulDiv(x, y, d, Math.Rounding.Floor|Ceil)` everywhere:
- `val(c, r) = mulDiv(c, P, aU, r)`: asset to USD
- `amt(usd, r) = mulDiv(usd, aU, P, r)`: USD to asset
- `uw(u) = u * uS`: usdc to USD, exact
- `wu(w, Floor) = w / uS`; `wu(w, Ceil) = ceilDiv(w, uS)`

**Rounding rule.** Every user output rounds **down**. Every input the protocol requires rounds **up**. Every L or CR used in a check rounds toward the side that makes the check stricter (§2.2).

**Safety rules for every mutating function**
- `nonReentrant` (OZ v5 `ReentrancyGuard`; its zero-initialised `_status` works in clones).
- Checks-effects-interactions, with this exception: token pulls happen before the accounting update and are verified by balance delta (`received == requested`, otherwise revert). This rejects fee-on-transfer tokens.
- `SafeERC20` throughout. Router approvals use `forceApprove(exact)` and are reset to 0 afterwards.

**Clones.** Use OZ `Clones.clone(impl)` and initialize in the same transaction. Implementation constructors call `_disableInitializers()` (OZ `proxy/utils/Initializable.sol`). A clone cannot use constructor-set `immutable` values or EIP-712, so SplitToken stores its name and symbol and overrides `name()` and `symbol()`.

**Views that never revert.** `state()`, `maxMintStable()`, `currentRisk()`, `previewRebalance()`, every RiskOracle view, MarketCalendar queries and `LogAnchor.latest()`. Read external data like this:
- **Feed:** low-level `staticcall` of `latestRoundData()`. If `!ok || returndata.length < 160`, the price is unusable.
- **`halted()`:** low-level `staticcall`. If `!ok || returndata.length < 32`, treat it as `false`.
- **RiskOracle and calendar:** `try/catch` (our contracts).
  - On a RiskOracle failure, use the pool's built-in fallback (§2.3) with `mintsPaused = true` and `refPrice = 0`.
  - On a calendar failure, treat the market as closed with `gapGuard = false`.
- Arithmetic must not overflow for supplies and reserves up to `2**128`.

---

## 2. LeveragePool (BUILDER_A)

### 2.1 Storage
- **Set once at initialize:** `factory, asset, usdc, feed, assetId, riskOracle, calendar, stable (sUSD), lever (x), stabilityPool, creator, kind`, plus `aU, uS, fS`.
- **Mutable:** `router` (admin), `PoolParams p`, `C, U` (internal accounting, **never `balanceOf`**), `localMintsPaused`, `isDonor[addr]`, `lastRebalanceAt`, `lastAccrualAt` (set to `block.timestamp` at initialize and again at seed), `lastMode` (UNSEEDED at initialize).
- **Not stored:** `S = sUSD.totalSupply()` and `X = x.totalSupply()`. Only the pool can change them.

### 2.2 Derived values (for given C, U, S, X, P)
```
CP_f = val(C,Floor)            CP_c = val(C,Ceil)
V_f  = CP_f + uw(U)            V_c  = CP_c + uw(U)
E_f  = int(V_f) - int(S)       E_c  = int(V_c) - int(S)            (signed)
xNAV = X==0 ? 1e18 : (E_f<=0 ? 0 : mulDiv(uint(E_f), 1e18, X, Floor))
L    = E_f<=0 ? (C==0 ? 0 : MAX) : mulDiv(CP_c, 1e18, uint(E_f), Ceil)     // upper estimate, used everywhere
CR   = S==0 ? MAX : mulDiv(V_f, 1e18, S, Floor)                            // lower estimate
```
`MAX = type(uint256).max`. Use this single L for every check: the sell zone fires slightly early, the buy zone slightly late and the mint cap is slightly strict, which are all the conservative choices.

**Mode** (checked in this order):
1. `X == 0` → UNSEEDED
2. price unusable → NO_PRICE
3. `S > 0 && E_f <= 0` → UNDERWATER
4. `CR < p.stabilityCR` → STABILITY
5. otherwise → NORMAL

Staleness is not a mode; it is the `priceFresh` flag.

### 2.3 External reads
- **`_price()`** returns `(usable, P, updatedAt, age, halted)`.
  - Usable means the call succeeded, `answer > 0`, `updatedAt != 0` and `answer * fS <= type(uint96).max` (about $7.9e10 per share; this keeps every derived value overflow-free, resolution R8).
  - `age = now > updatedAt ? now - updatedAt : 0`, a saturating subtraction.
  - **`fresh(maxAge)`** = `usable && age <= maxAge && updatedAt <= now + MAX_FUTURE_SKEW`.
- **`_risk()`** calls `IRiskOracle.riskView(assetId)`. If the call fails, use the built-in fallback:
  - trigger 2.2e18, target 1.9e18, lower 1.5e18
  - maxDev 150, open and closed fee 100, gapGuard 7200, chunk 1_000e18
  - FALLBACK source, refPrice 0, `mintsPaused = true`
- **`_market()`** returns `open = calendar.isOpen(now)` and `gap = calendar.inGapGuard(now, risk.gapGuardSec)`.
- **Effective params:**
```
T  = risk.targetLev;  Tr = risk.triggerLev;  Lo = risk.lowerTriggerLev
if gap: T = min(T, p.gapTargetLev); Tr = min(Tr, p.gapTriggerLev)
Lo = min(Lo, T > 0.2e18 ? T - 0.2e18 : 0)
maxMintLev = (T + Tr) / 2;  if !open: maxMintLev = min(maxMintLev, p.closedMaxLev)
baseFee = open ? risk.openFeeBps : risk.closedFeeBps
mintsPausedAll = localMintsPaused || risk.mintsPaused || halted
```
- **Dynamic fees,** computed with the pre-action L:
```
lower(b, d) = b <= p.minFeeBps ? b : max(p.minFeeBps, b - d)
if L >= T: u = (Tr > T) ? min(BPS, mulDiv(L - T, BPS, Tr - T)) : BPS     (L == MAX -> BPS)
           d = p.dynFeeMaxBps * u / BPS;  stableFee = baseFee + d;  leverFee = lower(baseFee, d)
else:      u = (T > Lo) ? min(BPS, mulDiv(T - L, BPS, T - Lo)) : BPS
           d = p.dynFeeMaxBps * u / BPS;  leverFee = baseFee + d;   stableFee = lower(baseFee, d)
if mode == STABILITY: leverFee = 0
```
- **Breaker** (mints only):
  - Require `ref = risk.refPrice > 0`, otherwise `StaleRefPrice(MAX, p.maxRefAge)`.
  - `refAge = sat(now - risk.refTs)` must be `<= p.maxRefAge`, otherwise `StaleRefPrice`.
  - `dev = mulDiv(|P - ref|, BPS, ref, Ceil)` must be `<= risk.params.maxDevBps`, otherwise `BreakerTripped(dev, max)`.

### 2.4 Common mint checks, in order
1. `deadline >= now`, else `Expired`
2. `cIn > 0`, else `ZeroAmount`
3. `X > 0`, else `NotSeeded`
4. `!localMintsPaused && !risk.mintsPaused`, else `MintsArePaused`
5. usable, else `NoPrice`
6. fresh(`p.maxPriceAge`), else `StalePrice(age, max)`
7. `!halted`, else `FeedHalted`
8. breaker

Every mutating function starts with `_accrue()` and ends with `_syncMode()`: recompute the mode, and if it differs from `lastMode`, store it and emit `ModeChanged(old, new)`.

### 2.5 Functions

**`seed(cIn, to)`**
- **Guards:** `msg.sender == creator || factory.isAdmin(msg.sender)`, else `NotCreatorOrAdmin`. `X > 0` → `AlreadySeeded`. `S|C|U != 0` → `SeedNotEmpty`. `to != 0`, `cIn > 0`, fresh(maxPriceAge), not halted.
- **Math:** `xTotal = val(cIn, Floor)`, so 1 x = $1. Require `xTotal > MIN_X`, else `SeedTooSmall`.
- **Effects:** pull `cIn`, set `C = cIn`, mint `MIN_X` to `DEAD` and `xTotal - MIN_X` to `to`, set `lastAccrualAt = now`.
- **Emits:** `Seeded(msg.sender, to, cIn, xTotal - MIN_X, MIN_X, P)`.
- No fee and no breaker. The x minted to `to` (BackstopVault or BackstopTreasury) is protocol-owned first-loss capital.

**`mintStable(cIn, minOut, deadline)`**
- **Guards:** the §2.4 checks. Mode must be NORMAL: STABILITY → `StabilityMode`, UNDERWATER → `Underwater`.
- **Math:** `v = val(cIn, Floor)`, `sOut = mulDiv(v, BPS - stableFee, BPS, Floor)`. Require `sOut > 0` (`ZeroOutput`) and `sOut >= minOut` (`Slippage`).
- **Post-checks** on `(C + cIn, U, S + sOut)`:
  - `L' <= maxMintLev`, else `LeverageTooHigh(L', cap)`
  - `CR' >= p.stabilityCR`, else `CRTooLow`
- **Effects:** pull, `C += cIn`, mint sOut to msg.sender.
- **Emits:** `Minted(msg.sender, MINT_STABLE, cIn, sOut, fee, P)`.

**`mintLever(cIn, minOut, deadline)`**
- **Guards:** the §2.4 checks. UNDERWATER (or `E_c <= 0`) → `Underwater`. Allowed in NORMAL and STABILITY, with fee 0 in STABILITY.
- **Math:** `vNet = mulDiv(val(cIn,Floor), BPS - leverFee, BPS, Floor)`, then `xOut = mulDiv(vNet, X, uint(E_c), Floor)`. E is rounded **up** so that fewer x are minted. Require `xOut > 0` and `xOut >= minOut`.
- **Effects:** pull, `C += cIn`, mint x.
- **Emits:** `Minted(..., MINT_LEVER, ...)`.
- There is no leverage cap, because this mint always moves L toward 1. Tests must assert that.

**`mint*WithPermit(...)`** calls `try IERC20Permit(asset).permit(msg.sender, this, cIn, permitDeadline, v, r, s) {} catch {}`, then runs the normal path.

**`redeemStable(s, minC, minU)`**: never pausable. A feed halt blocks it only through the bounded halt hold below.
- **Guards:** `s > 0`; usable and `age <= p.maxRedeemPriceAge` (and no more than the future skew), else `StalePrice`.
- **Halt hold:** while the feed is halted AND the pool is under water by more than 1 bp (`V_c + S/BPS < S`) AND `block.timestamp < feed.haltedAtSrc() + MAX_REDEEM_HOLD` (6 h), revert `RedeemHeld`. `haltedAtSrc()` is read with a low-level staticcall; a failed call, short return or 0 means no hold. This lets a backstop cover (donate works while halted) land before anyone redeems at the V/S haircut, so early redeemers cannot take the haircut that later holders avoid. `previewRedeemStable` reverts the same way. redeemPair is never held.
- **Math:** `sNet = mulDiv(s, BPS - p.redeemFeeBps, BPS, Floor)`, `den = max(V_c, S)`, `cOut = mulDiv(C, sNet, den, Floor)`, `uOut = mulDiv(U, sNet, den, Floor)`.
  - When V ≥ S this pays a share of C and U worth about `sNet` dollars and leaves E unchanged.
  - When V < S it pays exactly `sNet/S` of each.
- **Checks:** `cOut + uOut > 0`, `cOut >= minC` (`SlippageC`), `uOut >= minU` (`SlippageU`).
- **Effects:** burn s from msg.sender, `C -= cOut`, `U -= uOut`, transfer.
- **Emits:** `Redeemed(user, REDEEM_STABLE, s, 0, cOut, uOut, fee, P)`.

**`redeemLever(x, minC, minU)`**
- **Guards:** `x > 0`, fresh(maxPriceAge), not halted (→ `FeedHalted`; x holders use redeemPair instead). `E_f > 0`, else `Underwater`.
- **Fee:** `p.stabilityRedeemFeeBps` in STABILITY, otherwise `p.redeemFeeBps`.
- **Math:**
```
value = mulDiv(x, uint(E_f), X, Floor);  valueNet = mulDiv(value, BPS - fee, BPS, Floor)
cOut = min(C, amt(valueNet, Floor))                       // stock first
rem  = valueNet - min(valueNet, val(cOut, Ceil))
uOut = min(U, wu(rem, Floor))
```
- **Checks:** `cOut + uOut > 0`; on `(C - cOut, U - uOut, S)`, `L' <= Tr` (effective trigger), else `LeverageTooHigh`; then the slippage checks.
- **Effects:** burn x, update C and U, transfer.
- **Emits:** `Redeemed(..., REDEEM_LEVER, 0, x, ...)`.

**`redeemPair(sMax, xMax, minC, minU)`**: needs no oracle, never paused, not blocked by a halt.
- **Guards:** `X > 0`. When `S > 0`, cap `sMax = min(sMax, S)` and `xMax = min(xMax, X)` first, so the products stay below 2**256 (resolution R7).
```
if S == 0:  require sMax == 0 (BadPairRatio); xBurn = xMax; sBurn = 0; (num, den) = (xBurn, X)
elif sMax * X <= xMax * S:  sBurn = sMax; xBurn = ceilDiv(sMax * X, S); (num, den) = (sBurn, S)
else:                       xBurn = xMax; sBurn = ceilDiv(xMax * S, X); (num, den) = (xBurn, X)
fee = p.redeemFeeBps
cOut = mulDiv(mulDiv(C, num, den, Floor), BPS - fee, BPS, Floor);  uOut likewise with U
```
- **Checks:** `xBurn > 0 || sBurn > 0`, `cOut + uOut > 0`, then slippage. `_accrue()` is still called first; it never reverts and does nothing without a price.
- **Effects:** burn both, update C and U, transfer.
- **Emits:** `Redeemed(..., REDEEM_PAIR, sBurn, xBurn, cOut, uOut, fee, 0)`.
- L is unchanged apart from the retained fee. That is invariant 6.

**`rebalance()`**: permissionless, never blocked by a pause.
- **Guards:** `X > 0`, fresh(maxPriceAge), and not halted (`FeedHalted`, because a suspicious price would misprice the sale).
- Read risk and market, compute effective `T, Tr, Lo`, then `Lb = L`.
- `SELL` if `Lb > Tr`. `BUY` if `Lb < Lo && U > 0 && E_f > 0 && mode == NORMAL && !gap`. Otherwise revert `NotInZone(Lb)`. The zone is checked before the cooldown, so an in-band call reverts `NotInZone` even while cooling down (resolution R5).

*SELL zone*
- **Route:**
  - STABILITY_POOL if `sp.totalDeposits() > 0` and either `mode == STABILITY` or (`mode == NORMAL && !open`).
  - Never in UNDERWATER, because absorbing at par while CR < 1 would hurt the remaining sUSD holders. The SP route raises CR only while CR > 1/(1 - disc).
  - Otherwise DEX.
- **Size,** with `s` = `p.spDiscountBps` (SP) or `p.maxSlipBps` (DEX):
```
if E_f <= 0: D = CP_f
else: TE = mulDiv(T, uint(E_f), 1e18, Floor);  D = CP_f > TE ? mulDiv(CP_f - TE, 1e18, 1e18 - mulDiv(T, s, BPS, Ceil), Floor) : 0
```
  This is `D = (C·P − T·E)/(1 − T·s)`, rounded down so the pool never oversells.
- **SP route:**
```
spD = sp.totalDeposits();  cap = mulDiv(spD, BPS, BPS - disc, Floor)
chunkUsd = min(D, cap);  cSold = min(C, amt(chunkUsd, Floor));  value = val(cSold, Floor)
sBurn = min(spD, mulDiv(value, BPS - disc, BPS, Ceil));  require sBurn > 0
C -= cSold;  sUSD.burn(sp, sBurn);  asset.safeTransfer(sp, cSold);  sp.offset(sBurn, cSold)
```
  No cooldown. `out = sBurn`. `cSold == 0 || sBurn == 0` reverts `ZeroOutput` (resolution R5).
- **DEX route:**
  - Require `now >= lastRebalanceAt + p.rebalanceCooldown`, else `Cooldown(left)`.
  - Start from `chunkUsd = min(D, risk.maxSellChunkUsd)` and repeat at most `MAX_CHUNK_HALVINGS` times:
```
cSold = min(C, amt(chunkUsd, Floor));  value = val(cSold, Floor)
minOut = wu(mulDiv(value, BPS - p.maxSlipBps, BPS, Ceil), Ceil)
quote  = try router.getAmountsOut(cSold, [asset, usdc]) -> amounts[1]  catch -> 0
if quote >= minOut: break;  else chunkUsd /= 2
```
  - If the **initial** `chunkUsd < p.minRebalanceUsd` → `BelowDust`. If halving takes the chunk below the floor, the loop stops and counts as a failed quote (resolution R5). If the quote still fails: use the SP route when it is eligible by deposits (`spD > 0`, mode not UNDERWATER), otherwise revert `RebalanceCheckFailed(1)`.
  - **Swap:** `forceApprove(router, cSold)`, `swapExactTokensForTokens(cSold, minOut, path, this, now)`, then `forceApprove(router, 0)`. Measure `out` by the usdc balance delta and check that the asset delta equals `cSold`; otherwise `RebalanceCheckFailed(5)`. Then `C -= cSold`, `U += out`, `lastRebalanceAt = now`.
- **Post-checks** (`La = L` after), each as `RebalanceCheckFailed(code)`:
  - (2) if `E_f(before) > 0`, then `La < Lb`
  - (3) `La + p.levEpsilon >= T`, so there is no oversell. Skipped, like (2), when `E_f(before) <= 0` (resolution R4).
  - (4) `Eb - Ea <= mulDiv(value, s, BPS, Ceil) + 2`, comparing E_f before and after
- **Emits:** `SellZone(Lb, La, cSold, out, Tr, snapshotId, route)`.

*BUY zone* (DEX only, cooldown applies, `s = p.maxSlipBps`)
```
TE = mulDiv(T, uint(E_f), 1e18, Floor);  B = TE > CP_c ? mulDiv(TE - CP_c, 1e18, 1e18 + mulDiv(T - 1e18, s, BPS, Ceil), Floor) : 0
chunkUsd = min(B, uw(U), risk.maxSellChunkUsd)          // same halving loop
uIn = min(U, wu(chunkUsd, Floor));  minOut = amt(mulDiv(uw(uIn), BPS - s, BPS, Ceil), Ceil)
swap [usdc, asset]; out = asset balance delta; C += out; U -= uIn
```
- `B = (T·E − C·P)/(1 + (T − 1)·s)`.
- **Post-checks:** `La > Lb`; `La <= T + p.levEpsilon`; E loss `<= mulDiv(uw(uIn), s, BPS, Ceil) + 2`.
- **Emits:** `BuyZone(Lb, La, uIn, out, Lo, snapshotId, DEX)`.
- Returns `(zone, route, amountIn, amountOut)`.

**`accrue()` / `_accrue()`**: never reverts.
```
dt = min(now - lastAccrualAt, MAX_ACCRUAL_DT);  lastAccrualAt = now   (always)
skip (return 0) if: dt==0 || S==0 || p.fundingRateBps==0 || !usable || age > p.maxRedeemPriceAge
                   || mode != NORMAL || sp.totalDeposits()==0
minted = mulDiv(S, p.fundingRateBps * dt, BPS * YEAR, Floor)
skip if minted == 0 || E_f <= int(minted)
sUSD.mint(sp, minted);  sp.notifyReward(minted);  emit FundingAccrued(minted, rate, dt)
```
Funding is paid by xSTOCK holders (it lowers E) to SP depositors. The agent cannot change the rate.

**`donate(usdcAmount, assetAmount)`**
- **Guards:** `isDonor[msg.sender]`, else `NotDonor`. Fresh price (`maxPriceAge`). Allowed while the feed is halted, at the latest (halted) price, so a cover can land during the redeem hold.
- **Math:** `deficit = S - V_c`, using the upper-estimate V so the deficit is smaller. Require `S > V_c`, else `NotUnderwater`.
```
usdcAcc  = min(usdcAmount, wu(deficit, Floor));  deficit -= uw(usdcAcc)
assetAcc = min(assetAmount, amt(deficit, Floor))
```
- **Checks and effects:** `usdcAcc + assetAcc > 0`. Pull each with a balance-delta check, then `U += usdcAcc`, `C += assetAcc`.
- **Emits:** `Donated(donor, usdcAcc, assetAcc, CRb, CRa)`.
- Donations are only allowed while CR < 1 and are capped at the deficit, so a donation cannot gift value to x holders or be sandwiched.

**Admin**
- `setParams(p)`: admin only. Accrue first, check every hard bound in §2.6 (`InvalidParams`), store, then emit `ParamsUpdated`.
- `setMintsPaused(b)`: admin or guardian. Emits `MintsPaused`.
- `setDonor(d, ok)`: admin or creator. Emits `DonorSet`.
- `setRouter(r)`: admin, nonzero with code. Emits `RouterSet`.
- There is **no sweep, withdraw or upgrade**. Tokens sent to the pool directly are ignored.

**Views**
- **`state()`** fills `PoolState` from §2.2 and §2.3 and must never revert:
  - `priceFresh = fresh(maxPriceAge) && !halted`
  - `mintsPaused = mintsPausedAll`
  - when the price is unusable: `price = 0`, `V = uw(U)`, `E = V − S`, and L/xNAV/CR computed from those
- **`maxMintStable()`** returns 0 unless `X > 0`, mode NORMAL, fresh, not halted, not paused and the breaker passes (computed, never reverting). Otherwise:
```
aL  = mulDiv(maxMintLev, uint(E_f), 1e18, Floor) - CP_c        (0 if negative or E_f<=0)
k   = p.stabilityCR;  kS = mulDiv(k, S, 1e18, Ceil)
aCR = V_f > kS ? mulDiv(V_f - kS, 1e18, k - 1e18, Floor) : 0  (ignores the fee, so it is conservative)
a   = mulDiv(min(aL, aCR), BPS - 1, BPS, Floor);  return amt(a, Floor)
```
- **`currentRisk()`** returns the effective `RiskParams`, with T, Tr and Lo after the gap guard, plus maxMintLev.
- **`previewRebalance()`** runs the same sizing without state changes, using a router quote through try/catch.
- **`preview*`** return the exact action outputs and may revert with the action's errors.

### 2.6 PoolParams: defaults and hard bounds (setParams reverts outside them)

| field | default | bounds |
|---|---|---|
| redeemFeeBps | 20 | [0, 100] |
| stabilityRedeemFeeBps | 100 | [redeemFeeBps, 300] |
| dynFeeMaxBps | 50 | [0, 200] |
| minFeeBps | 10 | [0, 100] |
| fundingRateBps | 400 | [0, 1500] |
| maxPriceAge | 120 | [30, 3600] |
| maxRedeemPriceAge | 86400 | [maxPriceAge, 7 days] |
| maxRefAge | 3600 | [300, 7200] |
| maxSlipBps | 50 | [10, 200] |
| spDiscountBps | 100 | [0, 300] |
| rebalanceCooldown | 30 | [0, 3600] |
| minRebalanceUsd | 1e18 | [0, 1000e18] |
| stabilityCR | 1.3e18 | [1.1e18, 2e18] |
| closedMaxLev | 2.2e18 | [1.5e18, 3e18] |
| gapTargetLev | 1.8e18 | [1.4e18, 2.2e18] |
| gapTriggerLev | 2.3e18 | [gapTargetLev + 0.3e18, 3e18] |
| levEpsilon | 0.05e18 | [0.001e18, 0.2e18] |

PoolFactory validates `defaults` with the same bounds. Put the check in a shared internal library in A's files, or duplicate it.

### 2.7 Roles seen by a pool
| Actor | Can |
|---|---|
| admin (`factory.isAdmin`) | seed (as fallback), setParams, setRouter, setDonor, setMintsPaused |
| guardian (`factory.isGuardian`) | setMintsPaused only |
| creator (caller of createPool) | seed once, setDonor |
| donor | donate (CR < 1, capped) |
| anyone | mints, redeems, rebalance, accrue |

### 2.8 Size
Run `forge build --sizes`; LeveragePool must stay under 24,576 bytes. If it goes over, move the pure math into `src/core/PoolMath.sol` as an **external** library (public functions). Do not change `foundry.toml`'s `via_ir` without reporting it.

**Resolved (R2):** `PoolMath.sol` holds `library PoolMath` (internal math, inlined, so PoolFactory needs no linking) and `library PoolLogic` (public quotes, `maxMintStable`, effective params and fees, rebalance planning and post-checks, reached by DELEGATECALL). LeveragePool is 23,971 bytes (605 spare) and PoolLogic is 11,160. PoolLogic must be **deployed once and linked** into LeveragePool: `forge test` and `forge script` do this automatically, while a manual `forge create` needs `--libraries src/core/PoolMath.sol:PoolLogic:<addr>`. The deploy phase must record the PoolLogic address in `deployments/`. With only 605 bytes spare, any new pool logic goes into PoolLogic, not LeveragePool.

---

## 3. SplitToken (BUILDER_A)
- ERC20 with 18 decimals.
- `initialize(name, symbol, pool)` is one-shot; a zero pool reverts `ZeroPool`.
- Stores name and symbol and overrides `name()` and `symbol()` with `override(ERC20, IERC20Metadata)`.
- `mint` and `burn` are `onlyPool` (`OnlyPool`); `burn` needs no allowance.
- No permit, no owner, no pause.

## 4. StabilityPool (BUILDER_A): Liquity v1 product-sum
**State:**
- `P` (WAD, starts at 1e18), `currentScale`, `currentEpoch`, `SCALE_FACTOR = 1e9`
- `epochToScaleToS[e][s]` (asset gain sum) and `epochToScaleToG[e][s]` (sUSD reward sum)
- `totalDeposits`
- per user: `initialValue` and a snapshot `{P, S, G, scale, epoch}`
- error-feedback terms `lastAssetError`, `lastLossError`, `lastRewardError`

**`offset(debt, coll)`** (pool only; `0 < debt <= totalDeposits`):
```
collNum = coll*1e18 + lastAssetError;  assetPerUnit = collNum / totalDeposits;  lastAssetError = collNum - assetPerUnit*totalDeposits
if debt == totalDeposits: lossPerUnit = 1e18; lastLossError = 0
else: lossNum = debt*1e18 - lastLossError; lossPerUnit = lossNum/totalDeposits + 1; lastLossError = lossPerUnit*totalDeposits - lossNum
S[epoch][scale] += assetPerUnit * P
f = 1e18 - lossPerUnit
if f == 0: epoch++, scale = 0, P = 1e18
elif P*f/1e18 < SCALE_FACTOR: P = P*f*SCALE_FACTOR/1e18; scale++
else: P = P*f/1e18
require P > 0; totalDeposits -= debt; emit Offset
```

**`notifyReward(amount)`** (pool only; `totalDeposits > 0`): `num = amount*1e18 + lastRewardError; perUnit = num/totalDeposits; lastRewardError = num - perUnit*totalDeposits; G[epoch][scale] += perUnit*P`.

**Compounded deposit:**
- 0 if the snapshot epoch is older than the current epoch.
- If `scaleDiff == 0`: `d*P/snapP`. If `scaleDiff == 1`: `d*P/snapP/1e9`. Otherwise 0.
- 0 if the result is `< d/1e9`.

**Gains:** `d * ((S[e][s] - snapS) + S[e][s+1]/1e9) / snapP / 1e18`, and the same with G. Every result rounds down.

**User actions:**
- `deposit`, `withdraw` and `claimGains` all pay pending gains (asset plus sUSD reward), then re-snapshot.
- `withdraw(max)` withdraws the full compounded amount. `totalDeposits` uses a saturating subtraction.
- **Withdrawals are never blocked.**

**Edge cases (resolution R6):**
- In `offset`, if `debt*1e18 <= lastLossError`, the previous overcharge already covers the debt: `lastLossError -= debt*1e18` and P is unchanged. Liquity's formula would underflow here.
- When `lossPerUnit == 1e18`, the epoch rolls over and `totalDeposits = 0`, even if rounding left `debt < totalDeposits`. Any leftover dust sUSD stays in the SP.
- `withdraw(amount)` caps at the compounded deposit and never reverts `InsufficientDeposit` (that error is reserved). `withdraw(0)` reverts `ZeroAmount`. A `P` that would reach 0 reverts `ProductUnderflow`.

**Invariants:**
- `Σ compounded deposits <= totalDeposits <= sUSD.balanceOf(sp)`
- `Σ asset gains <= asset.balanceOf(sp)`
- `Σ sUSD rewards <= sUSD.balanceOf(sp) - totalDeposits`

## 5. PoolFactory (BUILDER_A)
- **Constructor:** AccessControl with `DEFAULT_ADMIN_ROLE = admin`. Checks that usdc, riskOracle, calendar and the three implementations are nonzero and have code, and that usdc decimals are ≤ 18. Stores the default params after validating them.
- **`createPool(asset, feed, assetId, symbol, router, kind)`:**
  1. Caller must have `CREATOR_ROLE` or `DEFAULT_ADMIN_ROLE`, else `NotCreatorOrAdmin`.
  2. Validate: nonzero addresses with code; `asset != usdc`; symbol 1–10 bytes; asset and feed decimals ≤ 18 (read by staticcall); `assetId != 0`.
  3. Clone stable, lever, sp and pool.
  4. Initialize the stable token (`"SplitStock USD <SYM> (MOCK)"`, `"sUSD-<SYM>"`) and the lever token (`"SplitStock Lever <SYM> (MOCK)"`, `"x<SYM>"`), both with the pool.
  5. `sp.initialize(pool, stable, asset)`.
  6. `pool.initialize(InitArgs{factory: this, usdc, riskOracle, calendar, creator: msg.sender, params: defaultParams, ...})`.
  7. Record `PoolInfo`, push it to `pools`, `byAsset[assetId]` and `byCreator[msg.sender]`, then emit `PoolCreated`.
- **Views:** `isAdmin/isGuardian/isCreator` return `hasRole(...)`.
- **Registrar (phase 2, §16):** `grantCreator(who)` is gated by `REGISTRAR_ROLE` (`Roles.REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE")`). It grants `CREATOR_ROLE` (reverts `ZeroAddress` for 0) and emits `CreatorGranted(creator, registrar)` only when the role was new. A registrar can never revoke; `DEFAULT_ADMIN_ROLE` still grants and revokes `CREATOR_ROLE` directly. `isRegistrar(who)` returns `hasRole(REGISTRAR_ROLE, who)`. Both functions live on `PoolFactory` only, not on `IPoolFactory`, because that interface file is compiled into the frozen Flap contracts.
- No pool is ever removed. The factory holds no funds.

## 6. SandboxFactory (BUILDER_A)
- **Required roles:** `CREATOR_ROLE` on PoolFactory, `AUTHORIZER_ROLE` on MockRouter, `MINTER_ROLE` on the mock asset. The deploy script grants them.
- **`create()`:**
  1. Revert `AlreadyHasSandbox` if the caller already has one.
  2. `feed = Clones.clone(feedImpl)`, then `IScenarioFeed(feed).initialize(referenceFeed, msg.sender, false, fallbackAnswer)`.
  3. `pool = factory.createPool(asset, feed, assetId, symbol, mockRouter, SANDBOX)`.
  4. `IMockRouter.setCaller(pool, {true, feed, asset, usdc, 0, 0})`.
  5. Mint `seedAssetAmount + stableAssetAmount` of the asset to itself and `forceApprove` the pool.
  6. `seed(seedAssetAmount, msg.sender)`.
  7. `try pool.mintStable(stableAssetAmount, 0, now)` and transfer the sUSD to msg.sender. On a catch, transfer the unused asset to msg.sender instead.
  8. Record the sandbox and emit `SandboxCreated`.
- Default amounts: equal seed and stable values, which puts the sandbox at L ≈ 2.
- Sandboxes share the real asset's RiskOracle entry, so a scenario shock trips the real CMC breaker. That is intended for the demo.

---

## 7. RiskOracle (BUILDER_B)

### 7.1 Storage
- `assetConfig[id]`
- `snap[id]` plus `hasSnap[id]`
- `rule[id]` (RiskParams computed at post)
- `agent[id] = {AgentParams q; expiresAt; proposalId; epoch}`
- `proposals[id]`, `proposalEpoch[id]`, `proposalCount`, `queued[assetId]`, `lastProposalBlock[assetId]`
- `clamps`, `caps` (StepCaps), `timing`, `fb` (Fallback)
- `agentEnabled` (true), `agentEpoch`, `expectedAgentId`
- `globalPaused`, `assetPaused[id]`

**Roles:** POSTER, PROPOSER, GUARDIAN and DEFAULT_ADMIN (from `Roles`).

### 7.2 Helpers
- `clamp(x, lo, hi)`. If the value changes, emit `Clamped(assetId, field, x, clamped)`, where `field = bytes32("triggerLev")` and so on.
- `step(x, prev, cap)` limits x to `[prev - cap, prev + cap]`, with a saturating low end, and emits `Clamped` when it bites.
- `gaps(q)`: `q.target = min(q.target, q.trigger - minTriggerTargetGap)`, then `q.lower = min(q.lower, q.target - minTargetLowerGap)`. setClamps sanity (§7.8) keeps both results inside the clamps.

### 7.3 `post(assetId, s)` (POSTER)
- **Guards:**
  - `cfg.enabled`, else `AssetNotConfigured`; `s.refPrice > 0`, else `ZeroRefPrice`
  - `s.cmcTs <= now + 30`, else `FutureTimestamp`
  - if a snapshot exists: `s.snapshotId > prev.snapshotId` and `s.cmcTs > prev.cmcTs`
- `prevRule = hasSnap ? rule[id] : baseRule(cfg)`, where baseRule is the cfg base values clamped.
```
if s.volBps == 0 && hasSnap:  trigger/target/lower = prevRule's
else:
  cut  = s.volBps > cfg.volRefBps ? (s.volBps - cfg.volRefBps) * cfg.volSlopeLev : 0
  trig = clamp(cfg.baseTriggerLev > cut ? cfg.baseTriggerLev - cut : 0, minTrig, maxTrig)
  if hasSnap: trig = step(trig, prevRule.triggerLev, caps.lev)
  tgt  = clamp(min(cfg.baseTargetLev, trig - gapTT), minTgt, maxTgt);   lower = clamp(cfg.baseLowerTriggerLev, minLo, maxLo);  gaps()
maxDev   = clamp(cfg.maxDevBps);  closedFee = clamp(cfg.closedFeeBps);  gapGuard = clamp(cfg.gapGuardSec)
openFee  = clamp(cfg.baseOpenFeeBps + min(|premiumBps|, 1e6) * cfg.premiumFeeShareBps / BPS)
chunk    = (s.liqUsd == 0 && hasSnap) ? prevRule.maxSellChunkUsd
           : min(max(mulDiv(s.liqUsd, cfg.chunkBpsOfLiq, BPS), cfg.minChunkUsd), cfg.maxChunkUsd)
```
- **Effects:** store the snapshot and rule, then emit `CmcSnapshot(..., rule)`.
- The trigger step cap applies **only to the rule trigger**; target and lower are derived from it. The step cap stops a keeper from posting 2.2 and forcing a sell in one step.

### 7.4 Effective params `_eff(id)`: total, never reverts
```
stale = !hasSnap || sat(now - snap.cmcTs) > timing.staleAfter
base  = stale ? merge(hasSnap ? rule : fbParams, fbParams) : rule
        // fbParams = {fb.trigger, fb.target, fb.lower, fb.maxDev, fb.feeBps (open), fb.feeBps (closed), fb.gapGuardSec, fb.maxSellChunkUsd}
active = agentEnabled && agent.epoch == agentEpoch && agent.proposalId != 0 && now < agent.expiresAt
eff   = active ? mergeAgent(base, agent.q) : base
```
- **`merge` directions,** always the more conservative value: trigger min, target min, lower min, maxDev min, openFee max, closedFee max, gapGuard max, chunk min. `mergeAgent` applies these only to the six agent fields. The min of two gap-consistent parameter sets is still gap-consistent, so no re-check is needed.
- **`source`:**
  - `stale` → FALLBACK
  - otherwise, an active agent with at least one agent field strictly tighter than `rule` → AGENT
  - otherwise → RULE
- **`refPrice(id)`** returns `(snap.refPrice, snap.cmcTs)` and never reverts; it is `(0, 0)` if none exists. Pools fail mints closed on ref age (`maxRefAge`, 60 min). It is never "breaker off".
- **`mintsPaused(id)`** = `globalPaused || assetPaused[id]`.
- **`riskView(id)`** bundles all of the above.

### 7.5 `propose(...)` (PROPOSER)
- **Guards:**
  - `agentEnabled`, else `AgentDisabled`; `expectedAgentId == 0 || agentId == expectedAgentId`, else `WrongAgentId`
  - `cfg.enabled`; `horizonSec >= 300`, else `HorizonTooShort`
  - `lastProposalBlock == 0 || block.number >= lastProposalBlock + minProposalGapBlocks`, else `ProposalRateLimited`
- **Steps:**
```
b = active ? agent.q : _base(id)      // baseline: active agent values, else rule/fallback base (no agent)
q = clamp each field (trigger, target, lower, maxDev [minMaxDev,maxMaxDev], closedFee, gapGuard)
q.trigger = step(q.trigger, b.trigger, caps.lev); q.target = step(.., caps.lev); q.lower = step(.., caps.lev)
q.maxDev = step(.., caps.bps); q.closedFee = step(.., caps.bps); q.gapGuard = step(.., caps.sec)
gaps(q)                                // gap enforcement only tightens; it may exceed a step cap
q.horizonSec = min(horizonSec, timing.agentMaxTtl)
tightenOnly = q.trigger<=b.trigger && q.target<=b.target && q.lower<=b.lower && q.maxDev<=b.maxDev
              && q.closedFee>=b.closedFee && q.gapGuard>=b.gapGuard
cancel queued[assetId] (status CANCELLED, emit ProposalCancelled)
id = ++proposalCount; store; proposalEpoch[id] = agentEpoch; lastProposalBlock = block.number
tightenOnly ? (apply now: agent = {q, now + q.horizonSec, id, agentEpoch}; status APPLIED; eta = now; emit ParamsApplied)
            : (status QUEUED; eta = now + timing.loosenDelay; queued[assetId] = id)
emit AgentProposal(id, assetId, agentId, keccak256(abi.encode(q)), inputsHash, outputHash, modelIdHash, rationaleURI, tightenOnly, eta)
```
- **`applyProposal(id)`** (anyone):
  - Requires status QUEUED (`NotQueued`), `now >= eta` (`TooEarly`), `agentEnabled` and `proposalEpoch[id] == agentEpoch` (`AgentDisabled`).
  - Recompute the baseline, re-run step caps and gaps on the stored q, and apply with expiry `now + horizonSec`.
  - Set status EXECUTED, clear `queued`, emit `ParamsApplied`.
- **`veto(id)`** (GUARDIAN): QUEUED → VETOED, clear `queued`, emit `Vetoed`.
- **`revokeAgent()`** (GUARDIAN): `agentEnabled = false; agentEpoch++`. This invalidates every active value and pending proposal lazily. Emits `AgentRevoked`.
- **`restoreAgent()`** (admin): `agentEnabled = true`.
- **`setMintsPaused(id, b)`** (GUARDIAN or admin): `id == 0` sets the global pause. Emits `MintsPausedSet`.

### 7.6 Precedence summary
`effective = conservative(rule-or-fallback, agent-if-active)`.
- The agent can never loosen beyond the rule.
- An agent loosening only relaxes its own earlier tightening, after 30 minutes and subject to veto.
- A stale snapshot means fallback, but agent tightening still applies.
- The agent never touches funding, openFee, maxSellChunk, refPrice or any funds.

### 7.7 Agent TTL decision
Agent values last `min(horizonSec, agentMaxTtl = 2 h)`. The plan's 15 minutes would expire hourly agent runs before the next run (§14). Admin can set `timing.agentMaxTtl = 900` to match the plan exactly.

### 7.8 Admin setters: validation, or revert `InvalidConfig`
- **`setClamps`:**
  - every `min <= max`
  - `minTriggerLev >= 1.5e18`, `maxTriggerLev <= 4e18`, `minLowerTriggerLev >= 1.05e18`
  - `minTriggerTargetGap >= 0.1e18`, `minTargetLowerGap >= 0.1e18`
  - `minTriggerLev - minTriggerTargetGap >= minTargetLev`, `minTargetLev - minTargetLowerGap >= minLowerTriggerLev`
  - bps maxima `<= 1000`, `maxGapGuardSec <= 6 h`
- **`setStepCaps`:** `lev ∈ [0.01e18, 0.5e18]`, `bps ∈ [1, 500]`, `sec ∈ [60, 6 h]`.
- **`setTiming`:** `staleAfter ∈ [60, 1 day]`, `agentMaxTtl ∈ [300, 1 day]`, `loosenDelay ∈ [60, 1 day]`, `minProposalGapBlocks <= 10_000`.
- **`setFallback`:** every value inside the clamps, gaps satisfied, `maxSellChunkUsd > 0`.
- **`configureAsset`:** base values inside the clamps and gap-consistent, `minChunkUsd <= maxChunkUsd`, `chunkBpsOfLiq <= BPS`, `premiumFeeShareBps <= BPS`, `volSlopeLev <= 1e16`.
- Every setter emits its event.

### 7.9 Constructor defaults
- **Clamps:**
  - trigger [2.2e18, 3.0e18], target [1.6e18, 2.2e18], lower [1.2e18, 1.8e18]
  - gaps 0.3e18 and 0.2e18
  - maxDev [50, 300], openFee [10, 150], closedFee [50, 300], gapGuard [1800, 7200]
- **StepCaps:** `{0.1e18, 50, 1800}`.
- **Timing:** `{900, 7200, 1800, 20}`.
- **Fallback:** `{2.2e18, 1.9e18, 1.5e18, 150, 100, 7200, 1_000e18}`.
- **Recommended NVDA AssetConfig** (set by the deploy script): `{true, 2.67e18, 2.0e18, 1.6e18, 5000, 1e14, 250, 100, 30, 5000, 3600, 200, 100e18, 50_000e18}`. TSLA uses the same values.

---

## 8. MarketCalendar (BUILDER_B)

**Data model**
- `holiday[dayIndex] => bool`, `earlyClose[dayIndex] => closeMinuteEt` (0 means normal)
- `dstYears[]` plus `dst[year] => (startUtc, endUtc)`
- `coverageFrom` and `coverageTo`
- Admin-settable through `setHoliday/setEarlyClose/setDst/setCoverage`. Preloaded in the constructor. AccessControl.

**Algorithm**
```
isDST(ts)       = exists year in dstYears: start <= ts < end
utcOffset(ts)   = isDST(ts) ? 14400 : 18000
dayIndexOf(ts)  = (ts - utcOffset(ts)) / 86400
weekday(day)    = (day + 4) % 7          // 0 = Sunday, 6 = Saturday (1970-01-01 was a Thursday)
offsetForDay(d) = utcOffset(d*86400 + 61200)   // 17:00 UTC = noon EST; DST flips on Sundays at 02:00 local
sessionOf(d)    = weekend || holiday[d] || !covered(d*86400 + 34200 + offsetForDay(d)) ? (0,0)
                  : (d*86400 + 570*60 + off, d*86400 + (earlyClose[d] != 0 ? earlyClose[d] : 960)*60 + off)
isOpen(ts)      = covered(ts) && (o,c)=sessionOf(dayIndexOf(ts)) && o != 0 && o <= ts < c
nextOpen(ts)    = !covered(ts) ? MAX : first o of sessionOf(dayIndexOf(ts)+i), i = 0..14, with o > ts; else MAX
nextClose(ts)   = isOpen(ts) ? current c : c of the first session with o > ts (same scan); else MAX
inGapGuard(ts,w)= !isOpen(ts) && (n = nextOpen(ts)) != MAX && n - ts <= w
```

**Preloaded tables** (ET dates, day index in brackets)
- **Coverage:** `[1767243600, 1830315600)`, which is 2026-01-01 00:00 ET to 2028-01-01 00:00 ET.
- **DST:** 2026 `[1772953200, 1793512800)` (8 Mar to 1 Nov); 2027 `[1805007600, 1825567200)` (14 Mar to 7 Nov).
- **2026 holidays:**
  - Jan 1 [20454], Jan 19 [20472], Feb 16 [20500], Apr 3 Good Friday [20546], May 25 [20598]
  - Jun 19 [20623], Jul 3 observed [20637], Sep 7 [20703], Nov 26 [20783], Dec 25 [20812]
- **2027 holidays:**
  - Jan 1 [20819], Jan 18 [20836], Feb 15 [20864], Mar 26 Good Friday [20903], May 31 [20969]
  - Jun 18 observed [20987], Jul 5 observed [21004], Sep 6 [21067], Nov 25 [21147], Dec 24 observed [21176]
- **Early closes at 13:00 ET (minute 780):** 2026-11-27 [20784], 2026-12-24 [20811], 2027-11-26 [21148].
- **[UNVERIFIED]** Confirm against NYSE's published 2027 calendar: no early close on 2027-07-02 or 2027-12-23, and 2027-12-31 is a normal day, because NYSE does not observe New Year's 2028 on a Friday. The table is admin-amendable.

**Required test vectors (UTC unix)**

| Query | Expected |
|---|---|
| `nextOpen(1795723200)` (Thu 26 Nov 2026, 15:00 ET, holiday) | `1795789800` (Fri 27 Nov, 09:30 EST) |
| `isOpen(1795789800)` | true |
| `nextClose(1795789800)` | `1795802400` (13:00 EST half day) |
| `isOpen(1795802400)` | false (half-open interval) |
| `nextOpen(1795802400)` | `1796049000` (Mon 30 Nov) |
| Fri 2026-03-06 open | `1772807400` (14:30 UTC, EST) |
| Mon 2026-03-09 open | `1773063000` (13:30 UTC, EDT) |
| Thu 2026-07-02 | open `1782999000`, close `1783022400` (normal day) |
| Mon 2026-11-02 open | `1793629800` (EST again) |
| Fri 2027-12-31 | open `1830263400`, close `1830286800` |
| `isOpen(1830315600)` | false; `nextOpen = MAX` (uncovered) |
| `inGapGuard(1795789800 - 3600, 3600)` | true |
| `inGapGuard(1795789800 - 3601, 3600)` | false |

---

## 9. AtlasMirror (BUILDER_B)
- **Storage:** `rounds[srcRoundId] => MirrorRound`, `latestId`, `count`, `limits`, `halted`, `haltedAtSrc`, `confirmCount`, plus immutable `srcChainId`, `srcFeed`, `decimals` and `description`. Roles: PUSHER, GUARDIAN, admin.
- **`push(...)`:**
  - Guards, in order: PUSHER (`NotPusher`); `answer > 0`; `srcStartedAt <= srcUpdatedAt`; `srcUpdatedAt <= now + MAX_FUTURE_SKEW`; if previous data exists, `srcRoundId > latestId` and `srcUpdatedAt > last.srcUpdatedAt`.
  - With previous data:
```
changeBps = mulDiv(|answer - last|, BPS, last, Ceil)
cap = min(maxStepBps + ((srcUpdatedAt - last.srcUpdatedAt) / 3600) * allowancePerHourBps, maxAllowanceBps)
if changeBps > cap: halted = true; haltedAtSrc = srcUpdatedAt; confirmCount = 0; emit Halted(...)
elif halted: if ++confirmCount >= confirmPushes && srcUpdatedAt >= haltedAtSrc + confirmMinSec: halted = false; emit HaltCleared(msg.sender, true)
```
  - Effects: store the round with `pushedAt = now`, emit `Mirrored(srcChainId, srcFeed, srcRoundId, answer, srcUpdatedAt, srcBlock, srcTxHash)`.
  - The mirror never rejects a large move. It halts mints instead, and pools still allow redeemPair (and redeemStable, except the bounded halt hold of at most 6 h from `haltedAtSrc` while the pool is under water).
- **`latestRoundData()`** returns `(latestId, answer, srcStartedAt, srcUpdatedAt, latestId)`. `updatedAt` is the **Atlas** time, not the push time. It reverts `NoData` before the first push.
- **`getRoundData(id)`** returns the stored round, or reverts `UnknownRound`. `version()` returns 1.
- **`clearHalt`/`forceHalt`:** GUARDIAN or admin.
- **`setLimits`** (admin) bounds: `maxStepBps ∈ [50, 2000]`, `allowancePerHourBps <= 1000`, `maxAllowanceBps ∈ [maxStepBps, 5000]`, `confirmPushes ∈ [1, 20]`, `confirmMinSec <= 1 day`.
- **Defaults:** `{500, 100, 2000, 3, 300}`.

## 10. ScenarioFeed (BUILDER_B)
- **Clone storage:** `ref`, `operator`, `publicSetter`, `anchor`, `answer`, `roundId`, `staleBy`, `halted`, `dec`.
- **`initialize(...)`:**
  - If `ref != 0` and `ref.latestRoundData()` succeeds (staticcall) with answer > 0, then `anchor = that`. Otherwise `anchor = initialAnswer`, which must be > 0, else `NoAnchor`.
  - `dec = ref != 0 ? ref.decimals() : 8`; on a failed call, 8.
  - `answer = anchor`, `roundId = 1`.
- **Bounds:** `min = ceil(anchor*4000/BPS)`, `max = floor(anchor*16000/BPS)`. Outside them, revert `OutOfBounds`.
- **Setters:**
  - `setPrice`/`shock`/`reset` need the operator, or anyone when `publicSetter`, else `NotOperator`.
  - `shock(bps)` requires `-1e4 < bps < 1e4` and sets `answer*(1e4+bps)/1e4`, bounded.
  - `reset` re-anchors (keeping the old anchor if the reference is unusable), then sets `answer = anchor`, `staleBy = 0`, `halted = false`.
  - `setStaleness` and `setHalted` are operator only.
  - Every price change increments `roundId`.
- **`latestRoundData()`** returns `(roundId, answer, t, t, roundId)` with `t = now > staleBy ? now - staleBy : 0`. `getRoundData(id)` returns the same for `id == roundId`, otherwise reverts. `description = "SCENARIO (team-set price)"`.

## 11. LogAnchor (BUILDER_B)
- `anchor(root, fromSeq, toSeq)`:
  - Requires ANCHOR_ROLE (`NotAnchorer`), `root != 0` (`ZeroRoot`), `fromSeq == nextSeq` and `toSeq >= fromSeq`, else `BadRange(nextSeq, fromSeq, toSeq)`.
  - Pushes the anchor, sets `nextSeq = toSeq + 1`, emits `Anchored`.
- `latest()` returns a zeroed struct when empty.

## 12. Mocks (BUILDER_B)
**MockERC20Permit**
- `ERC20 + ERC20Permit(name) + AccessControl`; `decimals()` returns the constructor value.
- Override `nonces` as `override(ERC20Permit, IERC20Permit)` and `supportsInterface` as needed.
- **`faucet()`:** if `last != 0 && now < last + cooldown`, revert `FaucetCooldown(left)`. Otherwise mint `faucetAmount` and record the time.
- `mint` and `burn` require MINTER_ROLE (`NotMinter`); `burn` needs no allowance.
- `setFaucet` is admin only.
- Testnet tokens:
  - `tNVDA ("Test NVDA (MOCK)", 18)`
  - `tTSLA ("Test TSLA (MOCK)", 18)`
  - `mUSDC ("Mock USDC (MOCK)", 18)`
  - tests must also cover 6-decimal mUSDC and 8-decimal feeds

**MockRouter**
- **Roles:** AccessControl admin and AUTHORIZER. `setCaller` and `setFill` require admin or AUTHORIZER (`NotAuthorized`).
- **Config bounds:** `slippageBps <= 5000`, `|offsetBps| < 5000`, feed, asset and usdc nonzero (`BadConfig`).
- **Quotes** use the **msg.sender** config (`UnknownCaller`). `path.length == 2` and `{path[0], path[1]} == {asset, usdc}`, else `BadPath`. P comes from `feed.latestRoundData()` (answer > 0, else `BadPrice`), normalized to WAD the same way as the pool, and ignores staleness.
```
pEff = P * (BPS + offsetBps) / BPS
asset->usdc: out = wu(mulDiv(mulDiv(amountIn, pEff, aU, Floor), BPS - slip, BPS, Floor), Floor)
usdc->asset: out = mulDiv(mulDiv(uw(amountIn), BPS - slip, BPS, Floor), aU, pEff, Floor)
```
- **`swapExactTokensForTokens`:** `deadline >= now` (`Expired`), `out >= amountOutMin` (`InsufficientOutput`). `transferFrom(msg.sender → this, amountIn)`, `IMockERC20(tokenIn).burn(this, amountIn)`, `IMockERC20(tokenOut).mint(to, out)`. Emits `MockSwap`. Returns `[amountIn, out]`.
- **Other functions:** `getAmountsIn` is the inverse, rounded up. `quoteFor(caller, ...)` is the same as a quote with an explicit caller. `factory()` returns `address(this)`, `WETH()` returns `address(0)`, and `swapExactETHForTokens` reverts `EthNotSupported`.
- MockRouter needs MINTER_ROLE on every mock token it fills.

**MockAggregator**
- No access control; follows the IMockAggregator semantics.
- Keeps a history mapping for `getRoundData`.
- `version() = 1`.
- `setRevertOnRead(true)` makes `latestRoundData` revert.

---

## 13. Tests and invariants

All of these run under `forge test`. Fuzz runs: 512. Invariant runs/depth: 128/64 (foundry.toml).

### 13.1 BUILDER_A: pool invariants
The handler has 3–5 actors. Its actions are mintStable, mintLever, redeemStable, redeemLever, redeemPair, donate, rebalance (MockRouter with configurable slippage and offset), accrue, SP deposit/withdraw, price moves (a bounded random walk plus jumps of −60%..+60% through MockAggregator) and warp. Keep ghost totals of value in and out. Run once with 18/18/8 decimals and once with 18/6/8.

1. **Books:** `asset.balanceOf(pool) >= C`, `usdc.balanceOf(pool) >= U`, `sUSD.totalSupply() == S`, `x.totalSupply() == X`.
2. **Claims ≤ value:** `S·min(1, V/S) + X·xNAV <= V + 1e6 wei`.
3. **No dilution:** at a fixed P, no user action lowers xNAV (−1 wei tolerance) or the sUSD backing `min(1e18, CR)`. Only price moves, rebalance slippage and accrue may.
4. **No round-trip profit:** mint then an immediate redeem at the same P returns ≤ the input, for every path and amount, from dust to 1e30.
5. **Dead shares:** after seed `X >= MIN_X` always, and `S > 0` implies `X > 0`.
6. **Leverage limits:**
   - after mintStable, `L <= maxMintLev`
   - mintLever never raises L
   - after redeemLever, `L <= trigger`
   - redeemPair changes L by at most ε (fee only, ≤ 0.5%)
7. **Rebalance:** `La < Lb` (sell, with E > 0); `La >= target − levEpsilon`; `sold ≤ D` and `≤ chunk cap`; `E_b − E_a <= slip·value`; it reverts with `NotInZone` when `Lo <= L <= Tr`.
8. **Underwater (V ≤ S):** both mints revert; redeemStable pays exactly `sNet/S` of C and U (±1 wei); redeemLever reverts `Underwater`; the SP route is never used.
9. **Totality:** `state()`, `maxMintStable()`, `currentRisk()` and `previewRebalance()` never revert, including at X=0, S=0, E≤0, a stale price, `updatedAt` in the future, a feed that reverts (`setRevertOnRead`) and a RiskOracle stub that reverts. With a stale price, mints revert and redeemPair works.
10. **Isolation:** two pools on the same asset; operations on one never change the other's C, U, S or X, or its token supplies. Only the pool can mint or burn its tokens.
11. **maxMintStable:** when it returns > 0, `mintStable(maxMintStable())` succeeds; `mintStable(max·1.01 + 1)` reverts with `LeverageTooHigh` or `CRTooLow` when the cap binds.
12. **StabilityPool:** the §4 invariants. Withdraw always succeeds.

### 13.2 BUILDER_A: scenario regressions
Fees are 0 through a risk stub with fees 0 and `minFeeBps = 0`; MockRouter has slip 0 unless stated. Setup: P=$100, seed $1,000 (10e18 asset), then mintStable $1,000, so L = 2.0, CR = 2.0, S = 1000e18.
- **Trigger edge (about −20.06%):** −20.05% gives L ≈ 2.6695, not in the zone (`NotInZone`). −20.07% gives L ≈ 2.6706, in the sell zone.
- **−22%:** `L = 1.56/0.56 = 2.7857…`. rebalance (DEX, s = 0.5%; the stub's `maxSellChunkUsd` must be ≥ 500e18; no SP deposits) sells `D = 440/0.99 = 444.44e18` USD, bringing L to about 1.992, inside ±ε of 2.0. Emits SellZone with `trigger = 2.67e18`. Then a mint reverts `BreakerTripped` when the ref is still $100 (dev 2200 bps > 250).
- **−50%:** E = 0, so L = MAX and the mode is UNDERWATER (de-peg edge). donate reverts `NotUnderwater`, because the deficit is 0. **−55%:** V = 900, S = 1000. redeemStable pays `sNet/S` of C and U (about $0.90 per sUSD before fees); donate accepts at most 100e18 USD; the SP route is never used; mints revert.
- **+33%:** L ≈ 1.6024, not in the buy zone. **Buy zone (amended, R3):** straight after the seed and mint, `U = 0`, so a +35% move alone cannot fire the buy zone, which needs `U > 0`. Run the −22% sell first, then recover the price to $105: L ≈ 1.587 < 1.6, and the buy brings L back to about 2.0. Refresh the ref price to $105 so later mints pass the breaker.
- **Gap guard:** warp to 30 minutes before an open with L = 2.4 and no SP deposits. The effective trigger is 2.3, so rebalance sells via DEX to about 1.8.
- **Closed market:** the mint cap is `min(2.335, 2.2)`, and the fee is closedFee.
- **Stability mode:** build it through a sell zone (which adds U) followed by a drop, for example `CP=500, U=700, S=1000`, giving CR = 1.2 and L = 2.5. mintStable reverts `StabilityMode` and the mintLever fee is 0. Then push L above the trigger with SP deposits present: rebalance takes the SP route, burns SP sUSD at a 1% discount and raises CR.
- **Funding:** 400 bps/yr on S = 1000e18 for 1 day mints `1000e18·400·86400/(1e4·365d)` to the SP; the SP reward equals it; E drops by the same amount.

### 13.3 BUILDER_B
11. **AtlasMirror:** `updatedAt` and `roundId` increase strictly; a push above the cap sets `halted` and still stores the price; auto-clear behaves as specified; a non-pusher reverts; a future timestamp beyond 30 s reverts; `latestRoundData.updatedAt == srcUpdatedAt`.
12. **RiskOracle** (fuzz the inputs):
    - stored and effective values always sit inside the clamps
    - `trigger − target >= gap` and `target − lower >= lowerGap`
    - the rule trigger moves `<= caps.lev` per snapshot
    - stale (warp > 900 s) gives FALLBACK values ≤ fallback
    - a tighten-only proposal applies immediately; a loosening one queues; a veto blocks it; applying before eta reverts
    - effective = the per-field conservative merge
    - revokeAgent removes agent influence immediately
    - views never revert for unknown ids
    - rate limit by blocks
- **MarketCalendar:** every §8 vector, plus a fuzz check that `isOpen(ts)` implies `nextClose(ts) > ts` and `nextOpen(ts) > ts`.
- **ScenarioFeed:** bounds, reset, the public versus operator setter, staleness and the clone initializer one-shot.
- **MockRouter:** fills at the feed price with slippage and offset applied; an unknown caller reverts; balances burn and mint correctly; decimals 18/6.
- **LogAnchor:** contiguity.

---

## 14. Design decisions and deviations from full-plan.md

1. **One pool per launch, multi-asset.** `PoolFactory.createPool(asset, feed, assetId, symbol, router, kind)`, called by CREATOR (launchers, the OpenFour module, SandboxFactory) or the admin. Every pool gets its own `sUSD-<SYM>`, `x<SYM>` and StabilityPool, which is the P0 isolation fix. `seed(cIn, to)` sends the first-loss x to the backstop (protocol-owned), and `MIN_X` goes to `0xdead`. The creator may seed and set donors.
2. **Clones everywhere.** LeveragePool, SplitToken, StabilityPool and ScenarioFeed are EIP-1167 clones. This keeps PoolFactory under 24 KB and makes a per-judge sandbox cheap. The consequence is that SplitToken has no permit; tNVDA does.
3. **The pool has no AccessControl.** Roles live on PoolFactory, and pools query `isAdmin` and `isGuardian`. One Timelock grant covers every pool.
4. **One RiskOracle keyed by assetId.** It computes the rule params on-chain from posted CMC inputs, so a judge can recompute the trigger from `CmcSnapshot`. Effective = the conservative merge with the agent. It exposes `riskView()` so a pool reads everything in one call.
5. **Halting rather than rejecting.** AtlasMirror accepts large moves and sets `halted`. Pools block mints, redeemLever and rebalance while halted. redeemPair stays open. redeemStable stays open unless the pool is under water, in which case it is held for at most 6 h from `haltedAtSrc` (`RedeemHeld`) while donate (the backstop cover) keeps working.
6. **Two price ages.** Mints, redeemLever, rebalance, seed and donate use `maxPriceAge` (120 s). redeemStable uses `maxRedeemPriceAge` (1 day), so retail sUSD holders are not trapped while the keeper is offline. redeemPair needs no price at all.
7. **The SP route is never used while UNDERWATER.** Absorbing at par below CR 1 would move value from the remaining sUSD holders to SP depositors.
8. **`donate(usdcAmount, assetAmount)`** takes either asset (BackstopTreasury holds tNVDA, BackstopVault holds mUSDC) and returns what it accepted. It is still capped at S − V and allowed only while CR < 1.
9. **Fees.** The base fee (open or closed) comes from RiskOracle. The redeem fee (0.2%) also applies to redeemPair to close oracle-lag round trips. In STABILITY, the xMint fee is 0 and the xRedeem fee is 1%.
10. **Agent TTL** is `min(horizonSec, 2 h)` instead of 15 minutes (§7.7). It can be changed through `setTiming`.
11. **Calendar coverage** is 2026–2027. Outside it the market is treated as closed (closed fee, 2.2x cap, never a block). The 2027 early-close dates are **[UNVERIFIED]**.
12. **Hooks kept for later phases:**
    - donor allowlist (`setDonor` by admin or creator) for BackstopVault and BackstopTreasury
    - `CREATOR_ROLE` for SplitLauncher and the OpenFour module
    - `maxMintStable()`, `state()`, `sUSD()` and `asset()` for the OpenFour validator and module
    - `IUniswapV2Router02.swapExactETHForTokens` for `BackstopVault.cover`
    - AtlasPullAdapter later becomes a feed wrapper or an internal `_userPrice()` override point: keep price reads inside one internal function
13. **mUSDC is valued at $1 with no oracle.** This is stated in the write-up.
14. **No same-block rule,** per safety.md item 12.

### 14.1 Deploy-time wiring (next phase, listed so builders know what is assumed)
- PoolFactory: `CREATOR_ROLE` → SandboxFactory, SplitLauncher(s) and the OpenFour module; `GUARDIAN_ROLE` → Guardian; `REGISTRAR_ROLE` → CreatorRegistrar (§16), which grants `CREATOR_ROLE` to each new SplitLauncher and OpenFour migrate module without a Timelock operation.
- MockRouter: `AUTHORIZER_ROLE` → SandboxFactory; `setCaller(ScenarioPool, ...)`.
- Mock tokens: `MINTER_ROLE` → MockRouter and SandboxFactory.
- RiskOracle: `POSTER_ROLE` → K_RISK, `PROPOSER_ROLE` → K_AGENT, `GUARDIAN_ROLE` → Guardian; `configureAsset(keccak256("NVDA"), ...)` and `configureAsset(keccak256("TSLA"), ...)`.
- AtlasMirror (one per feed): `PUSHER_ROLE` → K_MIRROR and its backup.
- LogAnchor: `ANCHOR_ROLE` → K_ANCHOR.
- Finally, `DEFAULT_ADMIN_ROLE` moves to the TimelockController (24 h) and the deployer renounces it.

---

## 15. Integration resolutions (phase 1)

All of BUILDER_A's interface change requests are **accepted**. None needed an edit to `src/interfaces/`: R1 and R2 work around compiler limits and keep the frozen ABI, and the rest are spec clarifications. They are now folded into the sections above. BUILDER_B made no change requests; B's beyond-spec decisions are recorded in R12 to R18 so both halves are documented in one place.

| # | Topic | Resolution | Where |
|---|---|---|---|
| R1 | SandboxFactory constructor: stack too deep with `via_ir = false` | Accepted. Two static structs `Wiring {poolFactory, mockRouter, feedImpl, asset, usdc, assetId}` and `Amounts {referenceFeed, fallbackAnswer, seedAssetAmount, stableAssetAmount}` encode byte-identically to the 11 flat arguments. Deploy scripts use `deployCode`/`abi.encode(<11 flat values>)`; only `new SandboxFactory(...)` callers pass structs. `via_ir` stays off. | §0.1 |
| R2 | LeveragePool size | Accepted. External `PoolLogic` library, which must be linked at deploy. | §2.8 |
| R3 | §13.2 +35% buy-zone scenario cannot fire (U = 0) | Accepted. Run the sell first, then recover to $105. | §13.2 |
| R4 | Sell-side overshoot check (3) while `E_f <= 0` | Accepted. Skip it, as (2) is skipped. The E-loss check (4) still applies. | §2.5 |
| R5 | Rebalance error mapping | Accepted. `BelowDust` only for the initial chunk; halving below the floor counts as a failed quote and falls back to SP, else `RebalanceCheckFailed(1)`. SP `cSold == 0 \|\| sBurn == 0` reverts `ZeroOutput`. `NotInZone` is checked before `Cooldown`. | §2.5 |
| R6 | StabilityPool loss-error underflow, epoch wipe, withdraw cap | Accepted. | §4 |
| R7 | `redeemPair` overflow | Accepted. Cap at supply before the ratio test. | §2.5 |
| R8 | Feed answers above `uint96.max` WAD | Accepted. Treated as unusable, so `state()` stays total. | §2.3 |
| R9 | Implementation-only errors | Accepted. They stay in the implementations, not the interfaces. **Off-chain consumers (app, services, keeper) must decode reverts with the implementation ABIs** (`out/<Contract>.sol/<Contract>.json`), not the interface ABIs. See the list below. | here |
| R10 | Calendar reads | Accepted. `inGapGuard` is queried only when `isOpen` is false (equivalent). Either call reverting means closed, with no gap guard. | §2.3 |
| R11 | SandboxFactory event ordering | Accepted. The sandbox is recorded before the external calls, and the call is atomic and `nonReentrant`. `SandboxCreated.stableC == 0` when the try-mint failed. | §6 |
| R12 | Access-control reverts on B contracts | Accepted. The interface errors are kept where the spec names them: `NotPusher` (AtlasMirror.push), `NotAnchorer` (LogAnchor.anchor), `NotAuthorized` (MockRouter), `NotMinter` (mocks) and `NotOperator` (ScenarioFeed). Every other role gate uses OZ `onlyRole` and reverts `AccessControlUnauthorizedAccount(account, role)`: RiskOracle post, propose, veto, revoke and admin setters; the AtlasMirror and MarketCalendar admin setters. Guardian-or-admin gates revert `NotGuardianOrAdmin`. | §7, §9, §11 |
| R13 | RiskOracle clamps change | Accepted. The clamps are re-applied after the step cap. `setClamps` refuses a band that excludes the current fallback. Stored rule values are refreshed on the next `post()`, not clamped at read time. | §7.8 |
| R14 | AtlasMirror manual halt | Accepted. A `forceHalt()` is lifted only by `clearHalt()`; the automatic 3-push clear applies only to jump halts. `push` rejects `srcUpdatedAt == 0`. | §9 |
| R15 | ScenarioFeed shock out of band | Accepted. It reverts `OutOfBounds` instead of clamping. The anchor is capped at `uint128.max`. If the reference reports decimals but no usable answer, `initialAnswer` is read in the reference's decimals. | §10 |
| R16 | MockRouter config | Accepted. Decimal scales are cached at `setCaller`, and decimals above 18 are rejected (`BadConfig`). A disabled config deregisters a caller without validation. `setFill` requires a registered caller. | §12 |
| R17 | MockERC20Permit constructor | Accepted. The admin also gets `MINTER_ROLE`, for deploy-script inventory. | §12 |
| R18 | MarketCalendar limits | Accepted. At most 64 DST years. `setDst(year, 0, 0)` removes a year. Values are capped at uint64. | §8 |

**Implementation-only errors (R9):**
- **LeveragePool:** `TransferAmountMismatch(received, expected)`
- **StabilityPool:** `TransferAmountMismatch`, `ZeroAddress`, `ProductUnderflow`
- **PoolFactory:** `ZeroAssetId`. A failed `decimals()` call is reported as `UnsupportedDecimals(token, 0)`.
- **SandboxFactory:** `ZeroAddress`, `ZeroAmount`, `BadSymbol`
- **RiskOracle:** `ZeroAdmin`, `NotGuardianOrAdmin`
- **AtlasMirror:** `ZeroAddress`, `UnsupportedDecimals(decimals)`, `NotGuardianOrAdmin`
- **MarketCalendar, MockRouter, MockERC20Permit:** `ZeroAdmin`
- **LogAnchor:** `ZeroAdmin`, `IndexOutOfRange(index, count)`
- **MockAggregator:** `ReadReverted`, `UnknownRound(roundId)`
- **ScenarioFeed:** `BadShock(bps)`, `UnknownRound(roundId)`

**Reserved (declared, never raised):** `ILeveragePool.InsufficientReserves` and `IStabilityPool.InsufficientDeposit` (withdraw caps instead, R6).

**Stubs (§0).** BUILDER_A's stubs live inline in `test/smoke/BUILDER_A.t.sol` (`A_*` contracts), not in `test/stubs/`. They stay there, because that smoke test is the stub-isolated unit check. Real-contract coverage is in `test/smoke/INTEGRATION.t.sol`, and new suites must use the real B contracts.

### 15.1 Integration smoke test (`test/smoke/INTEGRATION.t.sol`)
The full A stack runs against B's real contracts with no stubs: 18-dec tNVDA, **6-dec mUSDC**, 8-dec feeds, default PoolParams, the §7.9 NVDA AssetConfig and the real NYSE calendar. It covers:
- seed and mint on the RULE source (trigger 2.67, cap 2.335, fee floor 10 bps)
- a −22% DEX sell through MockRouter, with books matching balances and the allowance reset
- the breaker on the posted ref
- the SP route on a closed market (Thu 2 Jul 2026 17:00 ET)
- the gap guard before Mon 6 Jul open (Tr 2.3, T 1.8, DEX sell to 1.8)
- an AtlasMirror jump halt: mints and rebalance blocked, redeemStable and redeemPair open, guardian clear
- `mintStableWithPermit` with a real EIP-2612 signature
- agent tighten (2.67 → 2.57 step-capped, AGENT), revoke (RULE) and stale (FALLBACK 2.2/1.9)
- a reverting feed (NO_PRICE, views total, redeemPair works)
- an unconfigured assetId (FALLBACK, mints `StaleRefPrice(max, 3600)`)
- SandboxFactory with a real ScenarioFeed clone and MockRouter roles, operator-only shock, a sell, and the live pool isolated

### 15.2 Open items for the next phase
1. Full suites from §13 are not written: `test/core/*`, `test/oracle/*`, `test/mocks/*`, the pool and risk invariants in `test/invariant/*`, and the §13.2 scenarios, run with both 18/18/8 and 18/6/8 decimals.
2. The 2027 NYSE early closes are [UNVERIFIED] (§8).
3. Deploy scripts must deploy and link `PoolLogic` (R2), grant the §14.1 roles, plus `MINTER_ROLE` on the asset and `AUTHORIZER_ROLE` on MockRouter for SandboxFactory. They must also call `MockRouter.setCaller` for the ScenarioPool. LIVE pools route through PancakeSwap v2 and need no `setCaller`.
4. LeveragePool has only 605 bytes spare; new logic goes into PoolLogic.
5. NatSpec and lint pass (forge lint warnings are mostly the intended Liquity divide-before-multiply, reentrancy-order warnings covered by `nonReentrant`, and test-only `vm.warp` notes).

---

## 16. Integration resolutions (phase 2: Flap, OpenFour, oracle scripts)

Three core change requests were raised in `BUILD_NOTES.md`. The frozen Flap contracts (`src/launch/*`, `src/flap/*`) compile `src/interfaces/{IPoolFactory,ILeveragePool,IRiskOracle,IAggregatorV3,IUniswapV2Router02}.sol`. Any edit to those files changes the Flap metadata hash and therefore the bytecode, so all of them stay byte-identical.

1. **CREATOR_ROLE per launch (raised by flap-contracts and openfour): accepted.**
   - `Roles.REGISTRAR_ROLE` is added to `SplitConstants.sol`, which the Flap contracts do not import.
   - `PoolFactory.grantCreator(who)` and `PoolFactory.isRegistrar(who)` are added (§5).
   - New periphery contract: `src/periphery/CreatorRegistrar.sol` `CreatorRegistrar(admin, poolFactory)`. DeployCore deploys it and grants it `REGISTRAR_ROLE`, and it is part of the admin handoff. It is permissionless and only grants to:
     - `registerFlapLauncher(factory, salt)`: grants to `factory.predictLauncher(salt)` for an allowlisted `SplitLauncherFactory`. The address is a CREATE2 beacon proxy that only that factory can deploy, so granting before the launcher exists is safe. The salt is `SplitLauncher.launchSalt()` and is also in the `SplitLauncherCreated` event.
     - `registerOpenFourToken(core, token)`: grants to the `migrateModule` that `core.tokens(token)` reports, when `exists`, the token matches, and `(core, presetId)` is allowlisted. The fields are decoded by word position (head words 2, 3, 13 and 17 of the `RuntimeConfig` getter).
   - The admin, which is the deployer and then the Timelock, only edits `setFlapFactory(factory, bool)` and `setOpenFourPreset(core, presetId, bool)`, through `script/ConfigureRegistrar.s.sol`.
   - Callers:
     - `FlapLaunch.newLauncher`, `lifecycle-splitstock.js`, the services keeper (`backstopOps` before `openPool()`, `openfourPoker` before `Core.migrate`) and the app "Register CREATOR_ROLE" button all prefer the registrar.
     - A direct admin grant remains as a fallback.
2. **Worse-of-two pull pricing inside LeveragePool (raised by oracle-scripts): deferred, no core change.**
   - LeveragePool has 605 bytes of runtime margin. A `_userPrice` hook that parses trailing calldata and calls the adapter does not fit without moving mint/redeem pricing into PoolLogic, and that refactor is too risky before the test phase.
   - `ILeveragePool` is also frozen by the Flap bytecode (see above).
   - `AtlasPullAdapter` stays a standalone verifier: `verify()` and `verifyAndPrice()` emit `PullVerified`, and the app's `/api/atlas/pull` builds the payload. Pools keep the push mirror.
   - Revisit after tests. The first option is a new pool implementation set via `PoolFactory.setImplementations` for new pools only. The second is a router that calls `adapter.verify()` and then the pool, with the pool reading `userPrice()`.
3. **`PoolFactory.poolLogic()` getter (optional, oracle-scripts): declined.** PoolFactory does not link PoolLogic. The address is a library linked into the LeveragePool implementation, and `DeployCore` already records it as `core.poolLogic`. The bytecode scan in the script stays.
