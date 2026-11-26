#!/usr/bin/env node
// Checks and packages the Flap UI sources with the official template tooling.
//
//   node flap-ui/scripts/build.mjs setup      clone both template checkouts into flap-ui/.template and install them
//   node flap-ui/scripts/build.mjs launcher   check-source + typecheck + zip -X -j -> flap-ui/dist/splitstock-launcher.zip
//   node flap-ui/scripts/build.mjs vault      typecheck + vault:check (packaging needs vault:e2e, run later)
//
// Template locations can be overridden with FLAP_LAUNCHER_TEMPLATE_DIR (branch test/pool-launch-developer-preview)
// and FLAP_VAULT_TEMPLATE_DIR (branch main).
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const flapUi = path.resolve(here, "..");
const templateRepo = "https://github.com/flap-sh/flap-vault-component-template";
const launcherTemplate = path.resolve(process.env.FLAP_LAUNCHER_TEMPLATE_DIR ?? path.join(flapUi, ".template", "launcher"));
const vaultTemplate = path.resolve(process.env.FLAP_VAULT_TEMPLATE_DIR ?? path.join(flapUi, ".template", "vault"));
const launcherDir = path.join(flapUi, "launcher");
const vaultDir = path.join(flapUi, "vault");
const distDir = path.join(flapUi, "dist");
const launcherZip = path.join(distDir, "splitstock-launcher.zip");
const launcherFiles = ["Component.tsx", "manifest.json", "i18n.json"];
const vaultFolder = "splitstock-backstop";
const vaultFiles = ["Component.tsx", "manifest.json", "VaultABI.ts", "i18n.json"];

function run(command, args, cwd) {
  console.log(`$ (${path.relative(flapUi, cwd) || "."}) ${command} ${args.join(" ")}`);
  execFileSync(command, args, { cwd, stdio: "inherit" });
}

function requireTemplate(dir, branch) {
  if (!fs.existsSync(path.join(dir, "package.json")) || !fs.existsSync(path.join(dir, "node_modules"))) {
    console.error(`Template checkout (${branch}) missing or not installed at ${dir}. Run: node flap-ui/scripts/build.mjs setup`);
    process.exit(1);
  }
}

function setup() {
  for (const [dir, branch] of [[launcherTemplate, "test/pool-launch-developer-preview"], [vaultTemplate, "main"]]) {
    if (!fs.existsSync(path.join(dir, "package.json"))) {
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      run("git", ["clone", "--depth", "1", "-b", branch, templateRepo, dir], flapUi);
    }
    run("yarn", ["install", "--frozen-lockfile"], dir);
  }
}

function typecheckIn(template, targetDir, files, sourceDir) {
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.mkdirSync(targetDir, { recursive: true });
  for (const file of files) fs.copyFileSync(path.join(sourceDir, file), path.join(targetDir, file));
  run(path.join(template, "node_modules", ".bin", "tsc"), ["--noEmit", "--incremental", "false"], template);
}

function launcher() {
  requireTemplate(launcherTemplate, "test/pool-launch-developer-preview");
  run("yarn", ["-s", "launcher:check-source", launcherDir], launcherTemplate);
  const copy = path.join(launcherTemplate, "examples", "launcher-runtime", "splitstock-launcher");
  try {
    typecheckIn(launcherTemplate, copy, launcherFiles, launcherDir);
  } finally {
    fs.rmSync(copy, { recursive: true, force: true });
  }
  fs.mkdirSync(distDir, { recursive: true });
  fs.rmSync(launcherZip, { force: true });
  run("zip", ["-X", "-j", launcherZip, ...launcherFiles.map((file) => path.join(launcherDir, file))], flapUi);
  console.log(JSON.stringify({ ok: true, zip: launcherZip, bytes: fs.statSync(launcherZip).size }));
}

function vault() {
  requireTemplate(vaultTemplate, "main");
  const target = path.join(vaultTemplate, "src", "vaults", vaultFolder);
  const registered = fs.readFileSync(path.join(vaultTemplate, "src", "vaults", "index.ts"), "utf8").includes(vaultFolder);
  typecheckIn(vaultTemplate, target, vaultFiles, vaultDir);
  if (!registered) run("yarn", ["-s", "vault:register", vaultFolder], vaultTemplate);
  run("yarn", ["-s", "vault:check", vaultFolder], vaultTemplate);
  console.log(`Vault source checked. To package after SPLIT exists: (cd ${vaultTemplate} && yarn vault:e2e ${vaultFolder} && yarn vault:package ${vaultFolder} && yarn vault:verify-package dist/${vaultFolder}.zip)`);
}

const command = process.argv[2];
if (command === "setup") setup();
else if (command === "launcher") launcher();
else if (command === "vault") vault();
else {
  console.error("Usage: node flap-ui/scripts/build.mjs <setup|launcher|vault>");
  process.exit(1);
}
