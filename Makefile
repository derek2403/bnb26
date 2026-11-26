# SplitStock: build and deploy entry points.
#
# Secrets: every on-chain target sources ./.env inside the recipe shell (set -a) and the forge scripts read the keys
# with vm.envOr (DEPLOYER_PRIVATE_KEY, MAINNET_DEPLOYER_PRIVATE_KEY, ...). No key is ever passed on the command line
# or echoed. Names are listed in .env.example. OpenFour Hardhat scripts read openfour/.env or openfour/startup/.env.
#
# Build (no chain access):
#   make deps               install pinned Solidity libs into contracts/lib (gitignored)
#   make build              forge build (default contracts/out + contracts/cache)
#   make build-all          forge build + OpenFour hardhat compile + services tsc + app next build + flap-ui checks
#   make abi                regenerate services/src/abi and app/src/abi from the compiled contracts
#
# Deploy, BSC testnet 97, in this order (DRY=1 simulates against the live RPC without broadcasting):
#   make deploy-core               core + mocks + PCS pairs + CreatorRegistrar -> deployments/97.json (handoff deferred)
#   (keeper pushes the mirrors: cd services && npx tsx src/cli.ts keeper once --jobs mirror)
#   make open-dev-pools            nvda-dev, nvda-scenario, tsla-scenario -> pools[] (re-run to seed nvda-dev)
#   make deploy-flap               immutable SplitStockConfig (from the current core) + BackstopVaultFactory + SplitLauncherFactory -> flap.*
#                                  (config is fixed per factory pair: a core redeploy = re-run deploy-flap + new Flap enable)
#   make upgrade-pool-impl         new LeveragePool impl (+ PoolLogic) -> PoolFactory.setImplementations (new pools only)
#   make deploy-backstop-treasury  BackstopTreasury (OpenFour fees) -> openfour.backstopTreasury
#   make openfour-fork             our own OpenFour proxy set on 97 (openfour/fork-deploy)
#   make openfour-register         FairLaunch baseline + SplitStock Pool Launch preset -> openfour.*
#   make configure-registrar       allowlist flap.launcherFactory + openfour core/preset on core.creatorRegistrar
#   make flap S_SIG='newLauncher()'   FlapLaunch steps: newLauncher() fill() openPool() dispatch() cover() status()
#   make openfour-lifecycle        create -> buy -> sell -> sell-out -> graduation into a NEW TSLA pool
#   make handoff                   DEFAULT_ADMIN_ROLE -> Timelock, deployer renounces (irreversible, do LAST)
#   make deploy-mainnet            56: AtlasCmcAnchor, NvdabLens, RiskOracle56, LogAnchor56 -> deployments/56.json
#   make verify / make verify-mainnet
#   make script S=script/X.s.sol SIG='fn()'   any other script on 97

SHELL := /bin/bash
.DEFAULT_GOAL := build

CONTRACTS := contracts
# Empty values in .env are unset so vm.envOr falls back to its default instead of failing to parse "".
LOAD_ENV  := set -a; if [ -f ./.env ]; then . ./.env; fi; set +a; for v in $$(compgen -e); do [ -n "$${!v}" ] || unset "$$v"; done;
FOUNDRY   := export PATH="$$HOME/.foundry/bin:$$PATH";
FORGE     := $(FOUNDRY) cd $(CONTRACTS) && forge
BROADCAST := $(if $(DRY),,--broadcast --slow)
# BSC testnet rejects EIP-1559 txs below the 0.1 gwei floor: force legacy txs at 0.1 gwei (override with GAS_PRICE=).
GAS_PRICE ?= 100000000
TESTNET   := --rpc-url bsc_testnet --legacy --with-gas-price $(GAS_PRICE) $(BROADCAST)
MAINNET   := --rpc-url bsc $(BROADCAST)
HARDHAT97 := --network bsctestnet

FLAP_SCRIPT ?= script/DeployFlap.s.sol:DeployFlap
SIG ?= run()
S_SIG ?= status()

.PHONY: deps build build-all abi deploy-core open-dev-pools deploy-flap set-flap-config deploy-backstop-treasury \
        openfour-fork openfour-register openfour-lifecycle configure-registrar flap handoff deploy-mainnet verify \
        upgrade-pool-impl \
        verify-mainnet script clean

deps:
	@$(FOUNDRY) cd $(CONTRACTS) && \
	  ([ -d lib/forge-std ] || forge install foundry-rs/forge-std@v1.17.0 --no-git) && \
	  ([ -d lib/openzeppelin-contracts ] || forge install OpenZeppelin/openzeppelin-contracts@v5.1.0 --no-git) && \
	  ([ -d lib/openzeppelin-contracts-upgradeable ] || forge install OpenZeppelin/openzeppelin-contracts-upgradeable@v4.9.6 --no-git) && \
	  ([ -d lib/solady ] || forge install Vectorized/solady@v0.1.26 --no-git)

build:
	@$(FORGE) build

build-all: build
	@cd openfour/startup && npx hardhat compile
	@cd services && npx tsc --noEmit
	@cd app && npm run build
	@if [ -d flap-ui/.template ] || [ -n "$$FLAP_LAUNCHER_TEMPLATE_DIR" ]; then cd flap-ui && npm run build:launcher && npm run check:vault; \
	  else echo "flap-ui: run 'cd flap-ui && npm run setup' once to enable the template checks"; fi

abi: build
	@cd openfour/startup && npx hardhat compile
	@$(FOUNDRY) cd services && npm run abi
	@$(FOUNDRY) cd app && npm run abi -- --no-forge

deploy-core:
	@$(LOAD_ENV) $(FORGE) script script/DeployCore.s.sol:DeployCore $(TESTNET)

open-dev-pools:
	@$(LOAD_ENV) $(FORGE) script script/OpenDevPools.s.sol:OpenDevPools $(TESTNET)

deploy-flap:
	@$(LOAD_ENV) $(FORGE) script $(FLAP_SCRIPT) $(TESTNET)

set-flap-config:
	@echo "set-flap-config: no-op. SplitStockConfig is immutable (fixed per factory pair, set by make deploy-flap)."
	@echo "A new core needs a new pair: make deploy-flap, then ask Flap to enable the new factories."

upgrade-pool-impl:
	@$(LOAD_ENV) $(FORGE) script script/UpgradePoolImpl.s.sol:UpgradePoolImpl $(TESTNET)

deploy-backstop-treasury:
	@$(LOAD_ENV) $(FORGE) script script/DeployBackstopTreasury.s.sol:DeployBackstopTreasury $(TESTNET)

openfour-fork:
	@cd openfour/fork-deploy && $(if $(DRY),npm run fork:dry,npm run fork)

openfour-register:
	@cd openfour/startup && npx hardhat run scripts/register-splitstock.js $(HARDHAT97)

openfour-lifecycle:
	@cd openfour/startup && npx hardhat run scripts/lifecycle-splitstock.js $(HARDHAT97)

configure-registrar:
	@$(LOAD_ENV) $(FORGE) script script/ConfigureRegistrar.s.sol:ConfigureRegistrar $(TESTNET)

flap:
	@$(LOAD_ENV) $(FORGE) script script/FlapLaunch.s.sol:FlapLaunch --sig '$(S_SIG)' $(TESTNET)

handoff:
	@$(LOAD_ENV) $(FORGE) script script/HandoffAdmin.s.sol:HandoffAdmin $(TESTNET)

deploy-mainnet:
	@$(LOAD_ENV) $(FORGE) script script/DeployMainnet.s.sol:DeployMainnet $(MAINNET)

verify:
	@$(LOAD_ENV) $(FOUNDRY) bash $(CONTRACTS)/script/verify.sh 97

verify-mainnet:
	@$(LOAD_ENV) $(FOUNDRY) bash $(CONTRACTS)/script/verify.sh 56

script:
	@test -n "$(S)" || { echo "usage: make script S=script/X.s.sol [SIG='fn()']"; exit 1; }
	@$(LOAD_ENV) $(FORGE) script $(S) --sig '$(SIG)' $(TESTNET)

clean:
	@rm -rf $(CONTRACTS)/out $(CONTRACTS)/cache $(CONTRACTS)/out-scripts $(CONTRACTS)/cache-scripts \
	  $(CONTRACTS)/out-flap $(CONTRACTS)/cache-flap
