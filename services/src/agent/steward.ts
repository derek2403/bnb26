import Anthropic from "@anthropic-ai/sdk";
import type postgres from "postgres";
import { riskOracleAbi } from "../abi/index.js";
import { env } from "../config/env.js";
import { agentIdFrom, riskSymbols, testnet } from "../config/deployments.js";
import { canonicalJSON, hashText, toJsonValue } from "../lib/canonical.js";
import { signer } from "../lib/chains.js";
import { db } from "../lib/db.js";
import { appendLog, storeRaw } from "../lib/hashlog.js";
import { errMsg, logger } from "../lib/log.js";
import { nowSec } from "../lib/math.js";
import { sendTx } from "../lib/tx.js";
import { decide } from "./decide.js";
import { gather, readCalendar } from "./gather.js";
import { buildUserPrompt, SYSTEM_PROMPT } from "./prompt.js";
import { validate } from "./validate.js";

const log = logger("agent");

/**
 * AI Risk Steward: a workflow, not a free-roaming agent.
 *   gather (code) -> decide (one Claude call, no tools) -> validate (clamps, step caps, classify) -> propose (K_AGENT)
 *   -> publish raw JSON at GET /agent/raw/:hash
 * Hashes put on-chain by RiskOracle.propose:
 *   inputsHash  = keccak256(utf8(canonicalJSON({model, effort, system, user})))   (the exact model input)
 *   outputHash  = keccak256(utf8(outputText))                                    (the exact model output)
 *   modelIdHash = keccak256(utf8(servedModel))
 *   rationaleURI= <PUBLIC_BASE_URL>/agent/raw/<outputHash>
 * Both raw bodies are stored under their hash, so anyone can re-hash what the API serves.
 */
export interface RunResult {
  asset: string;
  runId?: number;
  status: "proposed" | "held" | "refused" | "invalid" | "failed" | "dry";
  classification?: string;
  inputsHash?: string;
  outputHash?: string;
  tx?: string;
  proposalId?: string;
  applied?: boolean;
  reason?: string;
  rationale?: string;
}

async function startRun(asset: string, model: string): Promise<number | undefined> {
  const sql = db();
  if (!sql) return undefined;
  const r = await sql<{ id: bigint }[]>`insert into agent_runs (asset, model, status) values (${asset}, ${model}, 'running') returning id`;
  return Number(r[0].id);
}

async function finishRun(id: number | undefined, f: Record<string, unknown>) {
  const sql = db();
  if (!sql || id === undefined) return;
  const j = (v: unknown) => (v === undefined ? null : sql.json(toJsonValue(v) as postgres.JSONValue));
  await sql`update agent_runs set finished_at = now(), served_model = ${(f.servedModel as string) ?? null},
              inputs_hash = ${(f.inputsHash as string) ?? null}, output_hash = ${(f.outputHash as string) ?? null},
              model_id_hash = ${(f.modelIdHash as string) ?? null}, raw_output = ${j(f.rawOutput)}, validated = ${j(f.validated)},
              classification = ${(f.classification as string) ?? null}, status = ${f.status as string}, tx_hash = ${(f.tx as string) ?? null},
              proposal_id = ${(f.proposalId as string) ?? null}, applied = ${(f.applied as boolean | undefined) ?? null},
              usage = ${j(f.usage)}, error = ${(f.error as string) ?? null}
            where id = ${id}`;
}

export async function runSteward(asset: string, opts: { dryRun?: boolean } = {}): Promise<RunResult> {
  const e = env();
  const dryRun = opts.dryRun ?? e.AGENT_DRY_RUN;
  const runId = await startRun(asset, e.AGENT_MODEL);
  try {
    const { g } = await gather(asset);
    const user = buildUserPrompt(g);
    const inputsText = canonicalJSON({ model: e.AGENT_MODEL, effort: e.AGENT_EFFORT, system: SYSTEM_PROMPT, user });
    const inputsHash = hashText(inputsText);
    await storeRaw(inputsHash, "agent_input", inputsText);

    let d;
    try {
      d = await decide(user);
    } catch (err) {
      let reason = errMsg(err);
      if (err instanceof Anthropic.RateLimitError) reason = `rate limited: ${reason}`;
      else if (err instanceof Anthropic.AuthenticationError) reason = `authentication: ${reason}`;
      else if (err instanceof Anthropic.BadRequestError) reason = `bad request: ${reason}`;
      else if (err instanceof Anthropic.APIConnectionError) reason = `connection: ${reason}`;
      await finishRun(runId, { status: "failed", inputsHash, error: reason });
      return { asset, runId, status: "failed", inputsHash, reason };
    }
    const outputHash = hashText(d.outputText);
    if (d.outputText) await storeRaw(outputHash, "agent_output", d.outputText);
    const modelIdHash = hashText(d.servedModel);
    await appendLog({ service: "agent", kind: "agent", endpoint: "decide", bodyHash: outputHash, data: { asset, inputsHash, outputHash, model: d.servedModel, status: d.status, fallbackRan: d.fallbackRan, stopReason: d.stopReason } });

    if (d.status !== "ok" || !d.decision) {
      const status = d.status === "refused" ? "refused" : "invalid";
      await finishRun(runId, { status, inputsHash, outputHash, modelIdHash, servedModel: d.servedModel, usage: d.usage, error: d.error ?? (d.refusal ? `refusal: ${d.refusal.category ?? "unknown"}` : undefined) });
      return { asset, runId, status, inputsHash, outputHash, reason: d.error ?? d.refusal?.explanation ?? undefined };
    }

    const v = validate(d.decision, g.onchain, nowSec());
    // evidence must reference something we actually gathered
    const known = new Set(g.mcp.map((m) => m.responseHash.toLowerCase()));
    const evidence = d.decision.evidence.filter((x) => known.has(x.responseHash.toLowerCase()));
    const validated = { ...v, evidence, droppedEvidence: d.decision.evidence.length - evidence.length, rationale: d.decision.rationale.slice(0, 800), events: d.decision.events, confidence: d.decision.confidence };
    const common = { inputsHash, outputHash, modelIdHash, servedModel: d.servedModel, rawOutput: d.decision, validated, classification: v.classification, usage: d.usage };

    if (!g.onchain.agentEnabled) {
      await finishRun(runId, { ...common, status: "held", error: "agent revoked on-chain" });
      return { asset, runId, status: "held", classification: v.classification, inputsHash, outputHash, reason: "agent revoked on-chain", rationale: validated.rationale };
    }
    // a no-op only goes on-chain to refresh an active agent value that is about to expire
    const expiresIn = Number(g.onchain.agent.expiresAt) - nowSec();
    if (v.noop && !(g.onchain.agent.active && expiresIn < 30 * 60)) {
      await finishRun(runId, { ...common, status: "held" });
      return { asset, runId, status: "held", classification: v.classification, inputsHash, outputHash, reason: "no change from baseline", rationale: validated.rationale };
    }

    const s = signer("agent");
    if (!s) {
      await finishRun(runId, { ...common, status: "held", error: "AGENT_PRIVATE_KEY not set" });
      return { asset, runId, status: "held", classification: v.classification, inputsHash, outputHash, reason: "AGENT_PRIVATE_KEY not set" };
    }
    const expected = g.onchain.expectedAgentId;
    const agentId = expected > 0n ? expected : (agentIdFrom(testnet()) ?? 0n);
    const rationaleURI = `${e.PUBLIC_BASE_URL.replace(/\/$/, "")}/agent/raw/${outputHash}`;
    const r = await sendTx(
      s,
      "agent",
      { address: g.onchain.oracle, abi: riskOracleAbi, functionName: "propose", args: [g.assetId, v.params, inputsHash, outputHash, modelIdHash, rationaleURI, agentId] },
      { dryRun, note: { asset, classification: v.classification } },
    );
    const res = (r.result ?? []) as readonly [bigint, boolean] | [];
    const proposalId = res[0]?.toString();
    const applied = res[1];
    const status = dryRun ? "dry" : r.ok ? "proposed" : "failed";
    await finishRun(runId, { ...common, status, tx: r.hash, proposalId, applied, error: r.ok ? undefined : (r.revert ?? r.error) });
    log.info("steward run", { asset, status, classification: v.classification, tx: r.hash, proposalId, applied });
    return { asset, runId, status, classification: v.classification, inputsHash, outputHash, tx: r.hash, proposalId, applied, reason: r.ok ? undefined : (r.revert ?? r.error), rationale: validated.rationale };
  } catch (err) {
    log.error("steward run failed", { asset, error: errMsg(err), stack: err instanceof Error ? err.stack : undefined });
    await finishRun(runId, { status: "failed", error: errMsg(err) });
    return { asset, runId, status: "failed", reason: errMsg(err) };
  }
}

export async function runStewardAll(opts: { dryRun?: boolean; assets?: string[] } = {}): Promise<RunResult[]> {
  const assets = opts.assets?.length ? opts.assets : riskSymbols(testnet());
  const out: RunResult[] = [];
  for (const a of assets.length ? assets : ["NVDA"]) out.push(await runSteward(a, opts));
  return out;
}

/** Seconds until the next run: hourly, or earlier for a calendar edge (gap-guard start before the open, ~15 min before a close). */
export async function nextWakeSec(): Promise<number> {
  const base = env().AGENT_INTERVAL_SEC;
  try {
    const cal = await readCalendar(3600n);
    if (!cal.available) return base;
    const cands = [base];
    if (cal.secondsToNextOpen !== undefined) cands.push(cal.secondsToNextOpen - 7200 - 600, cal.secondsToNextOpen - 3600 - 300);
    if (cal.secondsToNextClose !== undefined) cands.push(cal.secondsToNextClose - 900);
    const next = Math.min(...cands.filter((x) => x > 120));
    return Number.isFinite(next) ? next : base;
  } catch {
    return base;
  }
}

export async function runAgentForever(signal: AbortSignal, opts: { dryRun?: boolean; assets?: string[] } = {}) {
  while (!signal.aborted) {
    const results = await runStewardAll(opts);
    log.info("agent cycle", { results: results.map((r) => ({ asset: r.asset, status: r.status, classification: r.classification, tx: r.tx })) });
    const wait = await nextWakeSec();
    log.info("agent sleeping", { seconds: wait });
    await new Promise<void>((resolve) => {
      const t = setTimeout(resolve, wait * 1000);
      signal.addEventListener("abort", () => {
        clearTimeout(t);
        resolve();
      }, { once: true });
    });
  }
}
