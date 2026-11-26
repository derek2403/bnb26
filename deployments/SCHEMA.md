# deployments/<chainId>.json

This is the only address book in the repo. Deploy scripts write it, and `services/`, `app/`, `flap-ui/` and `openfour/` scripts read it. Never hardcode an address elsewhere.

```jsonc
{
  "chainId": 97,
  "updatedAt": "2026-11-26T12:00:00Z",
  "deployer": "0x…",
  "tokens": {
    "tNVDA": "0x…", "tTSLA": "0x…", "mUSDC": "0x…", "WBNB": "0x…"
  },
  "core": {
    "poolFactory": "0x…", "poolLogic": "0x…", "riskOracle": "0x…",
    "marketCalendar": "0x…", "logAnchor": "0x…", "sandboxFactory": "0x…",
    "creatorRegistrar": "0x…",       // holds REGISTRAR_ROLE on PoolFactory (CREATOR_ROLE per launch)
    "timelock": "0x…", "guardian": "0x…",
    "poolImpl": "0x…", "tokenImpl": "0x…", "stabilityPoolImpl": "0x…", "scenarioFeedImpl": "0x…"
  },
  "oracles": {
    "NVDA": { "mirror": "0x…", "scenarioFeed": "0x…", "pullAdapter": "0x…", "atlasSource": { "chainId": 56, "feed": "0xf25af12920d408baf6211e9e90eda89df3d8ccda" } },
    "TSLA": { "mirror": "0x…", "scenarioFeed": "0x…", "pullAdapter": "0x…", "atlasSource": { "chainId": 56, "feed": "0x…", "feedId": "0x000003a5" } },
    "atlasBnbUsd": "0x3957d289ee9c38272377786787ea34f9dd29788d"
  },
  "pools": [
    {
      "id": "nvda-flap",            // stable slug used in app routes /pools/[id]
      "symbol": "NVDA",
      "assetId": "0x…",              // keccak256("NVDA")
      "kind": "flap",                // flap | four | scenario | dev
      "pool": "0x…", "sUSD": "0x…", "xToken": "0x…", "stabilityPool": "0x…",
      "feed": "0x…",                 // the mirror (live) or scenarioFeed (scenario)
      "openedBy": "0x…",             // launcher or OpenFour module
      "openTx": "0x…"
    }
  ],
  "dex": {
    "router": "0xD99D1c33F9fC3444f8101754aBC46c52416550D1",
    "factory": "0x6725F303b657a9451d8BA641348b6761A6CC7a17",
    "mockRouter": "0x…",
    "pairs": { "tNVDA_mUSDC": "0x…", "tTSLA_mUSDC": "0x…", "WBNB_mUSDC": "0x…", "WBNB_tNVDA": "0x…" }
  },
  "flap": {
    "portal": "0x000042108465206185A077Edc3F3fd2b49060000",
    "guardian": "0x00004d58290854c5E9880F4b5B1993c6Ad8b0000",
    "v2Router": "0xc9D63ddCB9549578057EAB6A83a543DdFEE2b8c3",
    "config": "0x…", "configAdmin": "0x0…",  // immutable SplitStockConfig (pool config fixed per factory pair); configAdmin is always 0x0 (no admin)
    "launcherFactory": "0x…", "vaultFactory": "0x…",
    "launchers": [ { "launcher": "0x…", "token": "0x…", "vault": "0x…", "taxProcessor": "0x…", "poolId": "nvda-flap" } ]
  },
  "openfour": {
    "registry": "0x…", "core": "0x…", "tools": "0x…", "feeRouter": "0x…",
    "presetId": "…", "migrateModule": "0x…", "customDataModule": "0x…", "validator": "0x…",
    "backstopTreasury": "0x…",
    "tokens": [ { "token": "0x…", "poolId": "tsla-four", "migrateModule": "0x…" /* per-token module, the pool creator */ } ]
  },
  "erc8004": { "identity": "0x8004A818BFB912233c491871b3d84c89A494BD9e", "reputation": "0x8004B663056A597Dffe9eCcC1965A193B7388713", "agentId": null }
}
```

`56.json` (mainnet, read-only) uses `core.riskOracle`, `core.logAnchor`, `mainnet.atlasCmcAnchor`, `mainnet.nvdabLens`, `erc8004.*` and the external addresses (NVDAB `0x02fca66c1d1afb4e2a7884261eb00f63598a7436`, Atlas NVDAB feed `0xf25af12920d408baf6211e9e90eda89df3d8ccda`, PCS v3 NVDAB/USDT `0x8fb4243b553ac29ba088acf00b9b7da24bd6690c`).

Demo-only pools shown in the app (AAPL, MSFT, GOOGL, AMZN, META, …) are **not** in this file. They live in `app/src/config/demoPools.ts`.

Rules:
- **Pool ids:** `nvda-flap` (kind `flap`), `tsla-four` (kind `four`), `nvda-dev` (kind `dev`), and `nvda-scenario` / `tsla-scenario` (kind `scenario`). The app uses them as route slugs.
- **Writers:**
  - `DeployCore` writes the whole file. On a re-run it keeps `flap`, `openfour` and `erc8004`, and resets `pools`.
  - Every other script writes only its own keys through `contracts/script/lib/DeploymentsIO.sol` (`_writeSection` needs the key to exist already; `DeployCore` writes the placeholders) or through the Hardhat helpers' read-modify-write.
- **Extra keys are additive:** readers must ignore keys they do not know. The full list of who reads and writes what is in `BUILD_NOTES.md`.
- **Placeholders:** `0x0000…0000` and `null` mean "not deployed yet". Every reader treats them as missing.
