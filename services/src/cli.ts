#!/usr/bin/env node
/**
 * SplitStock services CLI.
 *
 *   keeper run  [--jobs a,b] [--dry-run]            long-running keeper (all jobs by default)
 *   keeper once --jobs mirror,rebalance,accrue [--dry-run] [--force] [--no-db]
 *                                                   one pass (GitHub Actions backup cron uses --no-db)
 *   agent run   [--asset NVDA] [--dry-run]          AI Risk Steward loop (hourly + calendar edges)
 *   agent once  [--asset NVDA] [--dry-run]          one gather -> decide -> validate -> propose
 *   agent register --chain 97|56 [--dry-run]        ERC-8004 register(agentURI)
 *   agent set-wallet --chain 97|56 --agent-id N     ERC-8004 setAgentWallet (EIP-712)
 *   agent feedback --agent-id N --score 0-100 --tag risk   evaluator feedback (self-assessment)
 *   api                                             Fastify API
 *   serve                                           api + keeper in one process (local dev)
 *   verify-snapshot <tx> [--chain 97] [--api URL]   check a RiskOracle.post against the log + anchor
 *   backtest [--days 30] [--json]                   30-day replay on stored 1h candles
 *   log verify [--from N] [--to M]                  recompute the hash chain
 *   db migrate                                      apply db/schema.sql
 *
 * Job names: mirror, cmc, risk, rebalance, accrue, backstop, openfour, indexer, anchor, mainnet, health.
 */
import type { Hex } from "viem";

const argv = process.argv.slice(2);
const flags = new Map<string, string | true>();
const positional: string[] = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const [k, v] = a.slice(2).split("=", 2);
    if (v !== undefined) flags.set(k, v);
    else if (i + 1 < argv.length && !argv[i + 1].startsWith("--") && !["dry-run", "force", "no-db", "json"].includes(k)) flags.set(k, argv[++i]);
    else flags.set(k, true);
  } else positional.push(a);
}
const flag = (k: string) => {
  const v = flags.get(k);
  return typeof v === "string" ? v : undefined;
};
const has = (k: string) => flags.has(k);
// must be set before the first env() read
if (has("no-db")) process.env.DB_DISABLED = "1";

function out(v: unknown) {
  process.stdout.write(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x), 2) + "\n");
}

function abortOnSignals(): AbortController {
  const ac = new AbortController();
  for (const s of ["SIGINT", "SIGTERM"] as const) process.on(s, () => ac.abort());
  return ac;
}

async function maybeMigrate() {
  const { env } = await import("./config/env.js");
  if (env().DB_DISABLED) return;
  const { migrate } = await import("./lib/db.js");
  await migrate();
}

async function main() {
  const [cmd, sub] = positional;
  const dryRun = has("dry-run");
  switch (cmd) {
    case "keeper": {
      const { selectJobs } = await import("./jobs/index.js");
      const { runForever, runJobOnce } = await import("./lib/scheduler.js");
      const jobs = selectJobs(flag("jobs")?.split(",").map((s) => s.trim()).filter(Boolean));
      if (sub === "once") {
        await maybeMigrate().catch(() => undefined);
        const results: Record<string, unknown> = {};
        let failed = false;
        for (const j of jobs) {
          const r = await runJobOnce(j, { dryRun, force: has("force") });
          results[j.name] = r;
          failed ||= !r.ok;
        }
        out(results);
        return failed ? 1 : 0;
      }
      if (sub === "run") {
        await maybeMigrate();
        const ac = abortOnSignals();
        await runForever(jobs, { dryRun, force: false }, ac.signal);
        return 0;
      }
      break;
    }
    case "agent": {
      const assets = flag("asset") ? [flag("asset")!] : undefined;
      if (sub === "once") {
        await maybeMigrate().catch(() => undefined);
        const { runStewardAll } = await import("./agent/steward.js");
        const r = await runStewardAll({ dryRun, assets });
        out(r);
        return r.some((x) => x.status === "failed") ? 1 : 0;
      }
      if (sub === "run") {
        await maybeMigrate();
        const { runAgentForever } = await import("./agent/steward.js");
        const ac = abortOnSignals();
        await runAgentForever(ac.signal, { dryRun, assets });
        return 0;
      }
      const chainKind = flag("chain") === "56" ? "mainnet" : "testnet";
      if (sub === "register") {
        const { registerAgent } = await import("./agent/erc8004.js");
        out(await registerAgent(chainKind, dryRun));
        return 0;
      }
      if (sub === "set-wallet") {
        const { setAgentWallet } = await import("./agent/erc8004.js");
        const role = chainKind === "testnet" ? "agent" : "agent56";
        out(await setAgentWallet(chainKind, BigInt(flag("agent-id") ?? "0"), role, role, dryRun));
        return 0;
      }
      if (sub === "feedback") {
        const { giveFeedback } = await import("./agent/erc8004.js");
        out(await giveFeedback(BigInt(flag("agent-id") ?? "0"), Number(flag("score") ?? "80"), flag("tag") ?? "risk", dryRun));
        return 0;
      }
      break;
    }
    case "api": {
      await maybeMigrate();
      const { startApi } = await import("./api/server.js");
      const ac = abortOnSignals();
      await startApi(ac.signal);
      await new Promise<void>((r) => ac.signal.addEventListener("abort", () => r(), { once: true }));
      return 0;
    }
    case "serve": {
      await maybeMigrate();
      const { startApi } = await import("./api/server.js");
      const { selectJobs } = await import("./jobs/index.js");
      const { runForever } = await import("./lib/scheduler.js");
      const ac = abortOnSignals();
      await startApi(ac.signal);
      await runForever(selectJobs(flag("jobs")?.split(",")), { dryRun, force: false }, ac.signal);
      return 0;
    }
    case "verify-snapshot": {
      const tx = sub as Hex | undefined;
      if (!tx || !/^0x[0-9a-fA-F]{64}$/.test(tx)) throw new Error("usage: verify-snapshot <txHash> [--chain 97] [--api URL]");
      const { env } = await import("./config/env.js");
      const { verifySnapshot, apiSource, dbSource } = await import("./lib/verify.js");
      const api = flag("api");
      if (api) process.env.DB_DISABLED = "1";
      const r = await verifySnapshot(tx, Number(flag("chain") ?? env().CHAIN_ID), api ? apiSource(api) : dbSource);
      out(r);
      return r.ok ? 0 : 1;
    }
    case "backtest": {
      const { runBacktest } = await import("./backtest/backtest.js");
      const r = await runBacktest({ days: Number(flag("days") ?? "30") });
      out(has("json") ? r : { asset: r.asset, from: r.from, to: r.to, candles: r.candles, summary: r.summary, events: r.events.length });
      return 0;
    }
    case "log": {
      if (sub === "verify") {
        const { entriesRange, latestSeq, verifyChain } = await import("./lib/hashlog.js");
        const last = (await latestSeq()) ?? -1;
        const from = Number(flag("from") ?? "0");
        const to = Number(flag("to") ?? String(last));
        let bad: number | null = null;
        let prev: Hex | undefined;
        for (let f = from; f <= to && bad === null; f += 2000) {
          const es = await entriesRange(f, Math.min(to, f + 1999));
          bad = verifyChain(es, prev);
          prev = es.at(-1)?.entryHash;
        }
        out({ from, to, ok: bad === null, firstBadSeq: bad });
        return bad === null ? 0 : 1;
      }
      break;
    }
    case "db": {
      if (sub === "migrate") {
        const { migrate } = await import("./lib/db.js");
        await migrate();
        return 0;
      }
      break;
    }
  }
  process.stderr.write(
    "usage: cli <keeper run|keeper once|agent run|agent once|agent register|agent set-wallet|agent feedback|api|serve|verify-snapshot <tx>|backtest|log verify|db migrate> [flags]\n",
  );
  return 2;
}

main()
  .then(async (code) => {
    const { closeDb } = await import("./lib/db.js");
    await closeDb().catch(() => undefined);
    process.exit(code);
  })
  .catch(async (e) => {
    process.stderr.write(`error: ${e instanceof Error ? (e.message || e.stack || e.name) : String(e)}\n`);
    try {
      const { closeDb } = await import("./lib/db.js");
      await closeDb();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });
