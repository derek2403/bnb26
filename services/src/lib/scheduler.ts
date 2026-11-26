import type postgres from "postgres";
import { toJsonValue } from "./canonical.js";
import { db } from "./db.js";
import { errMsg, logger } from "./log.js";
import type { Job, JobContext } from "../jobs/types.js";
import { env } from "../config/env.js";

const log = logger("scheduler");

export interface JobStatus {
  job: string;
  lastRunAt?: string;
  lastOkAt?: string;
  lastErrAt?: string;
  lastErr?: string;
  lastDetail?: unknown;
  runs: number;
  fails: number;
}

const memStatus = new Map<string, JobStatus>();

export async function recordRun(job: string, ok: boolean, detail: unknown, err?: string) {
  const now = new Date().toISOString();
  const s = memStatus.get(job) ?? { job, runs: 0, fails: 0 };
  s.lastRunAt = now;
  s.runs++;
  if (ok) s.lastOkAt = now;
  else {
    s.fails++;
    s.lastErrAt = now;
    s.lastErr = err;
  }
  s.lastDetail = detail;
  memStatus.set(job, s);
  const sql = db();
  if (!sql) return;
  try {
    const d = sql.json(toJsonValue(detail ?? null) as postgres.JSONValue);
    await sql`insert into job_state (job, last_run_at, last_ok_at, last_err_at, last_err, last_detail, runs, fails)
              values (${job}, now(), ${ok ? sql`now()` : null}, ${ok ? null : sql`now()`}, ${err ?? null}, ${d}, 1, ${ok ? 0 : 1})
              on conflict (job) do update set
                last_run_at = now(),
                last_ok_at = case when ${ok} then now() else job_state.last_ok_at end,
                last_err_at = case when ${ok} then job_state.last_err_at else now() end,
                last_err = case when ${ok} then job_state.last_err else ${err ?? null} end,
                last_detail = ${d},
                runs = job_state.runs + 1,
                fails = job_state.fails + case when ${ok} then 0 else 1 end`;
  } catch (e) {
    log.warn("job_state write failed", { job, error: errMsg(e) });
  }
}

export async function jobStatuses(): Promise<JobStatus[]> {
  const sql = db();
  if (!sql) return [...memStatus.values()];
  const rows = await sql<
    { job: string; last_run_at: Date | null; last_ok_at: Date | null; last_err_at: Date | null; last_err: string | null; last_detail: unknown; runs: bigint; fails: bigint }[]
  >`select * from job_state order by job`;
  return rows.map((r) => ({
    job: r.job,
    lastRunAt: r.last_run_at?.toISOString(),
    lastOkAt: r.last_ok_at?.toISOString(),
    lastErrAt: r.last_err_at?.toISOString(),
    lastErr: r.last_err ?? undefined,
    lastDetail: r.last_detail,
    runs: Number(r.runs),
    fails: Number(r.fails),
  }));
}

export async function runJobOnce(job: Job, ctx: JobContext): Promise<{ ok: boolean; detail?: unknown; error?: string }> {
  if (job.needsDb && env().DB_DISABLED) {
    log.info("skip (needs database)", { job: job.name });
    return { ok: true, detail: { skipped: "no database" } };
  }
  const t0 = Date.now();
  try {
    const detail = await job.run(ctx);
    await recordRun(job.name, true, detail);
    log.debug("job ok", { job: job.name, ms: Date.now() - t0 });
    return { ok: true, detail };
  } catch (e) {
    const error = errMsg(e);
    await recordRun(job.name, false, undefined, error);
    log.error("job failed", { job: job.name, ms: Date.now() - t0, error });
    return { ok: false, error };
  }
}

/** Runs each job on its cadence, never overlapping itself. Resolves when `signal` aborts. */
export async function runForever(jobs: Job[], ctx: JobContext, signal: AbortSignal): Promise<void> {
  const timers: NodeJS.Timeout[] = [];
  for (const [i, job] of jobs.entries()) {
    let running = false;
    const tick = async () => {
      if (running || signal.aborted) return;
      running = true;
      try {
        await runJobOnce(job, ctx);
      } finally {
        running = false;
      }
    };
    // stagger starts so all RPC calls do not land in the same second
    timers.push(setTimeout(() => void tick(), 500 + i * 750));
    timers.push(setInterval(() => void tick(), job.everyMs));
  }
  log.info("scheduler started", { jobs: jobs.map((j) => `${j.name}@${Math.round(j.everyMs / 1000)}s`) });
  await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
  for (const t of timers) clearTimeout(t);
}
