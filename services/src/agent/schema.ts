import { z } from "zod";

/**
 * The model's structured output. Sent to the API as a JSON schema (output_config.format) and parsed with zod.
 * Leverage values are plain multiples (2.55 = 2.55x); code converts them to WAD (triggerLevE18 etc.).
 * Kept free of numeric range constraints on purpose: the off-chain validator re-applies the on-chain clamps and
 * step caps itself and records every adjustment, instead of the schema silently rejecting an output.
 */
export const decisionSchema = z.object({
  action: z.enum(["tighten", "hold", "loosen"]).describe("Direction relative to the current baseline values."),
  triggerLev: z.number().describe("Sell-zone trigger leverage, e.g. 2.55"),
  targetLev: z.number().describe("Rebalance target leverage, e.g. 1.95"),
  lowerTriggerLev: z.number().describe("Buy-zone trigger leverage, e.g. 1.6"),
  maxDevBps: z.number().int().describe("On-chain breaker: max |pool price - CMC reference| in bps"),
  closedFeeBps: z.number().int().describe("Base mint fee while NYSE is closed, bps"),
  gapGuardSec: z.number().int().describe("Gap-guard window before the next NYSE open, seconds"),
  horizonSec: z.number().int().describe("How long these values should stay valid, seconds (>= 300)"),
  confidence: z.number().describe("0..1"),
  rationale: z.string().describe("Plain-English reasoning, at most 800 characters. Cite evidence by responseHash."),
  events: z
    .array(
      z.object({
        source: z.string().describe("tool name or 'calendar' / 'onchain'"),
        title: z.string(),
        dateUtc: z.string().describe("YYYY-MM-DD or empty if unknown"),
        materiality: z.enum(["none", "low", "medium", "high"]),
        note: z.string(),
      }),
    )
    .describe("Detected events that could gap the stock; mark immaterial ones (e.g. a ~$0.01 dividend) as none."),
  evidence: z.array(z.object({ tool: z.string(), argsHash: z.string(), responseHash: z.string() })).describe("Evidence items actually relied on, copied from the input."),
});

export type Decision = z.infer<typeof decisionSchema>;
