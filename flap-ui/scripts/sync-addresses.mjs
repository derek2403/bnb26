#!/usr/bin/env node
// Rewrites the deployment addresses baked into the Flap UI packages from deployments/<chainId>.json.
// Usage: node flap-ui/scripts/sync-addresses.mjs [--chain 97] [--dry-run]
// Reads: flap.launcherFactory, flap.vaultFactory, flap.launchers[].token (first one ending in 7777 is the vault test token).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const flapUi = path.resolve(here, "..");
const repo = path.resolve(flapUi, "..");
const args = process.argv.slice(2);
const chainArg = args.indexOf("--chain");
const chainId = chainArg >= 0 ? Number(args[chainArg + 1]) : 97;
const dryRun = args.includes("--dry-run");
const address = /^0x(?!0{40}$)[0-9a-fA-F]{40}$/;

function fail(message) {
  console.error(JSON.stringify({ ok: false, error: message }));
  process.exit(1);
}

const bookPath = path.join(repo, "deployments", `${chainId}.json`);
if (!fs.existsSync(bookPath)) fail(`${path.relative(repo, bookPath)} does not exist yet. Deploy the Flap factories first.`);
const book = JSON.parse(fs.readFileSync(bookPath, "utf8"));
if (book.chainId !== chainId) fail(`${bookPath} has chainId ${book.chainId}, expected ${chainId}.`);
const flap = book.flap ?? {};
const launcherFactory = flap.launcherFactory;
const vaultFactory = flap.vaultFactory;
if (!address.test(launcherFactory ?? "")) fail("flap.launcherFactory is missing or not an address.");
if (!address.test(vaultFactory ?? "")) fail("flap.vaultFactory is missing or not an address.");
const splitToken = (flap.launchers ?? []).map((entry) => entry?.token).find((token) => address.test(token ?? "") && /7777$/i.test(token));

const changes = [];

function write(file, next) {
  const before = fs.readFileSync(file, "utf8");
  if (before === next) return;
  changes.push(path.relative(repo, file));
  if (!dryRun) fs.writeFileSync(file, next);
}

// launcher/Component.tsx: lines tagged `// @sync <path>`
const componentPath = path.join(flapUi, "launcher", "Component.tsx");
const values = { "flap.launcherFactory": launcherFactory.toLowerCase(), "flap.vaultFactory": vaultFactory.toLowerCase() };
let component = fs.readFileSync(componentPath, "utf8");
for (const [key, value] of Object.entries(values)) {
  const tag = new RegExp(`"0x[0-9a-fA-F]{40}"(;\\s*//\\s*@sync ${key.replace(".", "\\.")})`, "g");
  if (!tag.test(component)) fail(`Component.tsx has no "// @sync ${key}" line.`);
  component = component.replace(tag, `"${value}"$1`);
}
write(componentPath, component);

// launcher/manifest.json: factoryAddress and chainId
const launcherManifestPath = path.join(flapUi, "launcher", "manifest.json");
const launcherManifest = JSON.parse(fs.readFileSync(launcherManifestPath, "utf8"));
launcherManifest.chainId = chainId;
launcherManifest.factoryAddress = launcherFactory.toLowerCase();
write(launcherManifestPath, JSON.stringify(launcherManifest, null, 2) + "\n");

// vault/manifest.json: binding factory and the E2E test token (the launched SPLIT token once it exists)
const vaultManifestPath = path.join(flapUi, "vault", "manifest.json");
const vaultManifest = JSON.parse(fs.readFileSync(vaultManifestPath, "utf8"));
const binding = vaultManifest.match?.bindings?.find((entry) => entry.chainId === chainId) ?? vaultManifest.match?.bindings?.[0];
if (!binding) fail("vault/manifest.json has no match.bindings entry.");
binding.chainId = chainId;
binding.factoryAddress = vaultFactory;
if (splitToken) binding.tokenAddresses = [splitToken.toLowerCase()];
write(vaultManifestPath, JSON.stringify(vaultManifest, null, 2) + "\n");

console.log(JSON.stringify({
  ok: true, dryRun, chainId, launcherFactory, vaultFactory,
  vaultTestToken: splitToken ?? "unchanged (no 7777 launcher token in deployments yet)", changed: changes,
}, null, 2));
