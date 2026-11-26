#!/usr/bin/env node
// Copies ../deployments/<chainId>.json (the ONLY address book, see deployments/SCHEMA.md) into
// src/generated/deployments.<chainId>.json so the app can import it. When a file is missing or invalid an
// empty example is written instead, so the app always builds (it then shows "awaiting deployment").
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const srcDir = process.env.DEPLOYMENTS_DIR || path.resolve(appRoot, "..", "deployments");
const outDir = path.join(appRoot, "src", "generated");
fs.mkdirSync(outDir, { recursive: true });

const empty = (chainId) => ({
  chainId,
  updatedAt: null,
  deployer: null,
  tokens: {},
  core: {},
  oracles: {},
  pools: [],
  dex: {},
  flap: { launchers: [] },
  openfour: { tokens: [] },
  mainnet: {},
  erc8004: {},
  _example: true,
});

for (const chainId of [97, 56]) {
  const src = path.join(srcDir, `${chainId}.json`);
  const dst = path.join(outDir, `deployments.${chainId}.json`);
  let data = empty(chainId);
  let note = "empty example (no deployments file)";
  if (fs.existsSync(src)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(src, "utf8"));
      if (parsed && typeof parsed === "object") {
        data = { ...empty(chainId), ...parsed, _example: false };
        note = `from ${path.relative(appRoot, src)}`;
      }
    } catch (err) {
      note = `empty example (${src} is not valid JSON: ${err.message})`;
    }
  }
  fs.writeFileSync(dst, JSON.stringify(data, null, 2) + "\n");
  console.log(`sync-deployments: ${chainId} <- ${note}`);
}
