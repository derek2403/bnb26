#!/usr/bin/env node
// CI guard: fails if any source file references the keyless CMC /public-api prefix (those calls are not tied to our
// key and do not count as verifiable usage). A line may opt out with the marker "public-api-check: allow" on it or
// on the line above.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const SKIP = new Set(["node_modules", ".git", "dist", "out", "cache", "broadcast", ".next", "artifacts", "docs"]);
const SKIP_PATHS = ["contracts/lib"]; // vendored Foundry libraries
const EXT = /\.(ts|tsx|js|mjs|cjs|json|yml|yaml|sh)$/;
const NEEDLE = "/public-api";
const hits = [];

function walk(dir) {
  for (const name of readdirSync(dir)) {
    if (SKIP.has(name)) continue;
    const p = join(dir, name);
    if (SKIP_PATHS.some((x) => relative(repo, p).startsWith(x))) continue;
    const st = statSync(p);
    if (st.isDirectory()) walk(p);
    else if (EXT.test(name) && st.size < 2_000_000 && !p.endsWith("check-public-api.mjs")) {
      const lines = readFileSync(p, "utf8").split("\n");
      lines.forEach((l, i) => {
        if (!l.includes(NEEDLE)) return;
        if (l.includes("public-api-check: allow") || (i > 0 && lines[i - 1].includes("public-api-check: allow"))) return;
        hits.push(`${relative(repo, p)}:${i + 1}: ${l.trim()}`);
      });
    }
  }
}

walk(repo);
if (hits.length) {
  console.error("Keyless CMC /public-api references found (use the keyed Pro API with the X-CMC_PRO_API_KEY header):");
  for (const h of hits) console.error("  " + h);
  process.exit(1);
}
console.log("ok: no keyless CMC /public-api references");
