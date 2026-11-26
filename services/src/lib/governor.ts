import { env } from "../config/env.js";
import { db } from "./db.js";

/**
 * CMC credit budget governor (target ~415 credits/day on the free Basic plan: 15,000/month, 50 req/min).
 *
 *   budget     = min(CMC_DAILY_CREDIT_BUDGET, monthlyLeft / daysLeftInMonth)   (monthlyLeft from the last /v1/key/info)
 *   pace       = budget × (fraction of the UTC day elapsed) + 1 hour of budget as grace
 *   used > 90% of pace      -> slow (every cadence ×2: "halves polling")
 *   used ≥ budget           -> exhausted: only essential calls (reference price for the breaker, ×4) and 0-credit calls
 *
 * "used" = Σ status.credit_count of today's keyed REST calls + MCP calls × CMC_MCP_CREDITS_PER_CALL.
 */
export type Priority = "essential" | "normal" | "optional";

let memUsed = { day: "", credits: 0 };
let monthlyLeft: number | undefined;
let backoffUntil = 0;

function utcDay(d = new Date()): string {
  return d.toISOString().slice(0, 10);
}

export function noteCredits(n: number) {
  const day = utcDay();
  if (memUsed.day !== day) memUsed = { day, credits: 0 };
  memUsed.credits += n;
}

export function noteKeyInfo(creditsLeftMonth: number | undefined) {
  if (creditsLeftMonth !== undefined && Number.isFinite(creditsLeftMonth)) monthlyLeft = creditsLeftMonth;
}

export function noteRateLimited(ms = 60_000) {
  backoffUntil = Date.now() + ms;
}

export function rateLimited(): boolean {
  return Date.now() < backoffUntil;
}

export async function creditsUsedToday(): Promise<number> {
  const sql = db();
  if (!sql) {
    if (memUsed.day !== utcDay()) memUsed = { day: utcDay(), credits: 0 };
    return memUsed.credits;
  }
  const start = `${utcDay()}T00:00:00.000Z`;
  const r = await sql<{ rest: number | null; mcp: number | null }[]>`
    select coalesce(sum(credit_count) filter (where kind = 'cmc'), 0)::int as rest,
           coalesce(count(*) filter (where kind = 'mcp'), 0)::int as mcp
    from log_entries where ts >= ${start} and kind in ('cmc', 'mcp')`;
  const rest = Number(r[0]?.rest ?? 0);
  const mcp = Number(r[0]?.mcp ?? 0) * env().CMC_MCP_CREDITS_PER_CALL;
  return rest + mcp;
}

export function dailyBudget(now = new Date()): number {
  const configured = env().CMC_DAILY_CREDIT_BUDGET;
  if (monthlyLeft === undefined) return configured;
  const endOfMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1);
  const daysLeft = Math.max(1, (endOfMonth - now.getTime()) / 86_400_000);
  return Math.max(0, Math.min(configured, Math.floor(monthlyLeft / daysLeft)));
}

export interface GovernorState {
  day: string;
  used: number;
  budget: number;
  pace: number;
  mode: "normal" | "slow" | "exhausted";
  multiplier: number;
  monthlyLeft?: number;
  rateLimited: boolean;
}

export async function governorState(now = new Date()): Promise<GovernorState> {
  const used = await creditsUsedToday();
  const budget = dailyBudget(now);
  const frac = (now.getTime() - Date.parse(`${utcDay(now)}T00:00:00.000Z`)) / 86_400_000;
  const pace = budget * frac + budget / 24;
  const mode = used >= budget ? "exhausted" : used > 0.9 * pace ? "slow" : "normal";
  return { day: utcDay(now), used, budget, pace: Math.round(pace), mode, multiplier: mode === "normal" ? 1 : mode === "slow" ? 2 : 4, monthlyLeft, rateLimited: rateLimited() };
}

/** Whether a call of `cost` credits at `priority` may run now. 0-credit calls always may (rate limit aside). */
export async function allow(cost: number, priority: Priority): Promise<{ ok: boolean; state: GovernorState }> {
  const state = await governorState();
  if (state.rateLimited) return { ok: false, state };
  if (cost === 0) return { ok: true, state };
  if (state.mode === "exhausted") return { ok: priority === "essential", state };
  return { ok: true, state };
}
