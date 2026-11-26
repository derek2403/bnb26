import { anchorMainnetJob } from "./anchorMainnet.js";
import { atlasMirrorJob } from "./atlasMirror.js";
import { backstopOpsJob } from "./backstopOps.js";
import { cmcCollectorJob } from "./cmcCollector.js";
import { healthJob } from "./health.js";
import { indexerJob } from "./indexer.js";
import { logAnchorJob } from "./logAnchor.js";
import { openfourPokerJob } from "./openfourPoker.js";
import { accrueJob, rebalancerJob } from "./rebalancer.js";
import { riskEngineJob } from "./riskEngine.js";
import type { Job } from "./types.js";

/** Job names accepted by `keeper run|once --jobs a,b,c`. The agent runs in its own process (`agent run`). */
export const ALL_JOBS: Job[] = [
  atlasMirrorJob, // mirror       15 s
  cmcCollectorJob, // cmc         30 s tick, per-endpoint cadences
  riskEngineJob, // risk          5 min
  rebalancerJob, // rebalance     30 s
  accrueJob, // accrue            10 min check, hourly per pool
  backstopOpsJob, // backstop     10 min
  openfourPokerJob, // openfour   1 min
  indexerJob, // indexer          10 s
  logAnchorJob, // anchor         hourly
  anchorMainnetJob, // mainnet    15 min (+ daily LogAnchor56)
  healthJob, // health            10 min
];

export function selectJobs(names?: string[]): Job[] {
  if (!names || names.length === 0 || names.includes("all")) return ALL_JOBS;
  const unknown = names.filter((n) => !ALL_JOBS.some((j) => j.name === n));
  if (unknown.length) throw new Error(`unknown job(s): ${unknown.join(", ")}; known: ${ALL_JOBS.map((j) => j.name).join(", ")}`);
  return ALL_JOBS.filter((j) => names.includes(j.name));
}
