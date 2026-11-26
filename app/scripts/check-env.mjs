#!/usr/bin/env node
// prebuild guard: fail the build if any NEXT_PUBLIC_*KEY* variable is defined, in the process env or in any
// app/.env* file Next would load. Only variable NAMES are inspected and printed, never values.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BAD = /^NEXT_PUBLIC_.*KEY/i;
const hits = new Set();

for (const name of Object.keys(process.env)) if (BAD.test(name)) hits.add(`${name} (process env)`);

for (const file of fs.readdirSync(appRoot)) {
  if (!file.startsWith(".env") || file === ".env.example") continue;
  const full = path.join(appRoot, file);
  if (!fs.statSync(full).isFile()) continue;
  for (const line of fs.readFileSync(full, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (m && BAD.test(m[1])) hits.add(`${m[1]} (${file})`);
  }
}

if (hits.size > 0) {
  console.error("check-env: refusing to build. These names would ship a secret to the browser:");
  for (const h of hits) console.error(`  - ${h}`);
  console.error("Rename them without the NEXT_PUBLIC_ prefix and read them only in server routes.");
  process.exit(1);
}
console.log("check-env: ok (no NEXT_PUBLIC_*KEY variables)");
