# Verifying SplitStock contracts on BscScan

BscScan uses the **Etherscan V2** API: one `ETHERSCAN_API_KEY` works for chain 97 (testnet) and 56 (mainnet);
`forge verify-contract --chain 97|56` picks the endpoint. Compiler settings come from `contracts/foundry.toml`
(solc 0.8.26, optimizer 200 runs, evm cancun, via_ir off).

The fastest path is the script, which reads every address from `deployments/<chainId>.json`:

```bash
make verify          # chain 97
make verify-mainnet  # chain 56
# or directly
contracts/script/verify.sh 97
```

It passes `--guess-constructor-args` (args recovered from the creation tx over `--rpc-url`), so nothing below
needs hand-encoded arguments. Run from `contracts/` with `FOUNDRY_OUT=out FOUNDRY_CACHE_PATH=cache`.

## Chain 97: individual commands

Replace `$X` with the address from `deployments/97.json` (key in brackets).

```bash
export FOUNDRY_OUT=out FOUNDRY_CACHE_PATH=cache
V="--chain 97 --etherscan-api-key $ETHERSCAN_API_KEY --rpc-url $BSC_TESTNET_RPC --guess-constructor-args --watch"

forge verify-contract $X src/mocks/MockERC20Permit.sol:MockERC20Permit $V            # [tokens.tNVDA] [tokens.tTSLA] [tokens.mUSDC]
forge verify-contract $X src/core/PoolMath.sol:PoolLogic $V                          # [core.poolLogic]
forge verify-contract $X src/core/LeveragePool.sol:LeveragePool $V \
  --libraries src/core/PoolMath.sol:PoolLogic:$POOL_LOGIC                            # [core.poolImpl]  (library link REQUIRED)
forge verify-contract $X src/core/SplitToken.sol:SplitToken $V                       # [core.tokenImpl]
forge verify-contract $X src/core/StabilityPool.sol:StabilityPool $V                 # [core.stabilityPoolImpl]
forge verify-contract $X src/oracle/ScenarioFeed.sol:ScenarioFeed $V                 # [core.scenarioFeedImpl]
forge verify-contract $X src/core/PoolFactory.sol:PoolFactory $V                     # [core.poolFactory]
forge verify-contract $X src/core/RiskOracle.sol:RiskOracle $V                       # [core.riskOracle]
forge verify-contract $X src/core/MarketCalendar.sol:MarketCalendar $V               # [core.marketCalendar]
forge verify-contract $X src/core/LogAnchor.sol:LogAnchor $V                         # [core.logAnchor]
forge verify-contract $X src/core/SandboxFactory.sol:SandboxFactory $V               # [core.sandboxFactory]
forge verify-contract $X lib/openzeppelin-contracts/contracts/governance/TimelockController.sol:TimelockController $V  # [core.timelock]
forge verify-contract $X src/oracle/AtlasMirror.sol:AtlasMirror $V                   # [oracles.NVDA.mirror] [oracles.TSLA.mirror]
forge verify-contract $X src/oracle/AtlasPullAdapter.sol:AtlasPullAdapter $V         # [oracles.*.pullAdapter]
forge verify-contract $X src/mocks/MockRouter.sol:MockRouter $V                      # [dex.mockRouter]
```

EIP-1167 clones (every pool, its sUSD-/x- tokens and StabilityPool, the canonical ScenarioFeeds and sandbox
feeds) are not verified one by one: once the implementation is verified, BscScan marks each clone as a minimal
proxy of it ("Similar Match"). If a clone page shows no code link, use BscScan "More Options -> Is this a proxy?".

`AtlasPullAdapter` embeds the vendored BUSL-1.1 Atlas sources (`lib/atlas-pull`); forge submits them with their
headers through the standard-JSON input, so the license stays visible on BscScan.

## Chain 56 (read-only mainnet)

```bash
V="--chain 56 --etherscan-api-key $ETHERSCAN_API_KEY --rpc-url $BSC_MAINNET_RPC --guess-constructor-args --watch"
forge verify-contract $X src/oracle/AtlasCmcAnchor.sol:AtlasCmcAnchor $V   # [mainnet.atlasCmcAnchor]
forge verify-contract $X src/oracle/NvdabLens.sol:NvdabLens $V             # [mainnet.nvdabLens]
forge verify-contract $X src/core/RiskOracle.sol:RiskOracle $V             # [core.riskOracle]  (RiskOracle56)
forge verify-contract $X src/core/LogAnchor.sol:LogAnchor $V               # [core.logAnchor]   (LogAnchor56)
```

## Explicit constructor args (only if --guess-constructor-args fails)

```bash
cast abi-encode "constructor(address,address,address)" $ADMIN $KEEPER 0xf25Af12920D408bAf6211e9e90eDa89DF3D8CCDa  # AtlasCmcAnchor
cast abi-encode "constructor(address,address)" 0x8FB4243b553aC29BA088aCf00B9B7dA24bD6690C 0x02Fca66C1D1aFB4E2A7884261eB00F63598a7436  # NvdabLens
cast abi-encode "constructor(address)" $ADMIN                                  # RiskOracle, LogAnchor, MarketCalendar, MockRouter
cast abi-encode "constructor(address,bytes4,address,string)" $MIRROR 0x000003a6 0x0000000000000000000000000000000000000000 "NVDAB / USD (Atlas pull)"  # AtlasPullAdapter NVDA
cast abi-encode "constructor(address,uint256,address,uint8,string)" $ADMIN 56 0xf25Af12920D408bAf6211e9e90eDa89DF3D8CCDa 18 "NVDAB / USD (Atlas mirror, BSC 56)"  # AtlasMirror NVDA
```
Pass the result with `--constructor-args <hex>` instead of `--guess-constructor-args`.
