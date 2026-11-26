#!/usr/bin/env bash
# Verify every SplitStock contract listed in deployments/<chainId>.json on BscScan (Etherscan V2 API).
# Usage: script/verify.sh 97|56     (run from anywhere; needs forge, jq, ETHERSCAN_API_KEY and the chain's RPC env)
#        VERIFIER=sourcify script/verify.sh 97   (Sourcify instead of BscScan; no API key needed)
# Constructor args are recovered from the creation tx (--guess-constructor-args), so no args are hardcoded.
# EIP-1167 clones (pools, sUSD/x tokens, StabilityPools, ScenarioFeeds) are not verified here: BscScan shows them
# as minimal proxies of the verified implementations.
set -euo pipefail

CHAIN="${1:-97}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/.." && pwd)"               # contracts/
BOOK="$ROOT/../deployments/$CHAIN.json"
[ -f "$BOOK" ] || { echo "missing $BOOK" >&2; exit 1; }
VERIFIER="${VERIFIER:-etherscan}"
if [ "$VERIFIER" = "sourcify" ]; then
  VARGS=(--verifier sourcify)
else
  : "${ETHERSCAN_API_KEY:?set ETHERSCAN_API_KEY (Etherscan V2 key, works for BscScan), or VERIFIER=sourcify}"
  VARGS=(--etherscan-api-key "$ETHERSCAN_API_KEY" --guess-constructor-args)
fi

if [ "$CHAIN" = "56" ]; then RPC="${BSC_MAINNET_RPC:?}"; else RPC="${BSC_TESTNET_RPC:?}"; fi
export FOUNDRY_OUT=out FOUNDRY_CACHE_PATH=cache
cd "$ROOT"

j() { jq -r "$1 // empty" "$BOOK"; }

verify() { # verify <address> <path:Contract> [extra forge args...]
  local addr="$1" id="$2"; shift 2
  if [ -z "$addr" ] || [ "$addr" = "0x0000000000000000000000000000000000000000" ]; then
    echo "skip $id (no address)"; return 0
  fi
  echo "== $id $addr"
  forge verify-contract "$addr" "$id" \
    --chain "$CHAIN" "${VARGS[@]}" \
    --rpc-url "$RPC" --watch "$@" || echo "!! failed: $id $addr"
}

if [ "$CHAIN" = "56" ]; then
  verify "$(j .mainnet.atlasCmcAnchor)" src/oracle/AtlasCmcAnchor.sol:AtlasCmcAnchor
  verify "$(j .mainnet.nvdabLens)"      src/oracle/NvdabLens.sol:NvdabLens
  verify "$(j .core.riskOracle)"        src/core/RiskOracle.sol:RiskOracle
  verify "$(j .core.logAnchor)"         src/core/LogAnchor.sol:LogAnchor
  exit 0
fi

LOGIC="$(j .core.poolLogic)"
verify "$(j .tokens.tNVDA)"              src/mocks/MockERC20Permit.sol:MockERC20Permit
verify "$(j .tokens.tTSLA)"              src/mocks/MockERC20Permit.sol:MockERC20Permit
verify "$(j .tokens.mUSDC)"              src/mocks/MockERC20Permit.sol:MockERC20Permit
verify "$LOGIC"                          src/core/PoolMath.sol:PoolLogic
verify "$(j .core.poolImpl)"             src/core/LeveragePool.sol:LeveragePool --libraries "src/core/PoolMath.sol:PoolLogic:$LOGIC"
verify "$(j .core.tokenImpl)"            src/core/SplitToken.sol:SplitToken
verify "$(j .core.stabilityPoolImpl)"    src/core/StabilityPool.sol:StabilityPool
verify "$(j .core.scenarioFeedImpl)"     src/oracle/ScenarioFeed.sol:ScenarioFeed
verify "$(j .core.poolFactory)"          src/core/PoolFactory.sol:PoolFactory
verify "$(j .core.riskOracle)"           src/core/RiskOracle.sol:RiskOracle
verify "$(j .core.marketCalendar)"       src/core/MarketCalendar.sol:MarketCalendar
verify "$(j .core.logAnchor)"            src/core/LogAnchor.sol:LogAnchor
verify "$(j .core.sandboxFactory)"       src/core/SandboxFactory.sol:SandboxFactory
verify "$(j .core.creatorRegistrar)"     src/periphery/CreatorRegistrar.sol:CreatorRegistrar
verify "$(j .core.timelock)"             lib/openzeppelin-contracts/contracts/governance/TimelockController.sol:TimelockController
verify "$(j .oracles.NVDA.mirror)"       src/oracle/AtlasMirror.sol:AtlasMirror
verify "$(j .oracles.TSLA.mirror)"       src/oracle/AtlasMirror.sol:AtlasMirror
verify "$(j .oracles.NVDA.pullAdapter)"  src/oracle/AtlasPullAdapter.sol:AtlasPullAdapter
verify "$(j .oracles.TSLA.pullAdapter)"  src/oracle/AtlasPullAdapter.sol:AtlasPullAdapter
verify "$(j .dex.mockRouter)"            src/mocks/MockRouter.sol:MockRouter
# Flap side (DeployFlap / DeployBackstopTreasury). Launchers / vaults are beacon proxies: verify the implementations.
verify "$(j .flap.config)"               src/launch/SplitStockConfig.sol:SplitStockConfig
verify "$(j .flap.launcherFactory)"      src/launch/SplitLauncherFactory.sol:SplitLauncherFactory
verify "$(j .flap.vaultFactory)"         src/launch/BackstopVaultFactory.sol:BackstopVaultFactory
verify "$(j .openfour.backstopTreasury)" src/backstop/BackstopTreasury.sol:BackstopTreasury
# OpenFour modules (Hardhat) are verified with `npx hardhat verify` from openfour/startup.
