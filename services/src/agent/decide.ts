import { z } from "zod";
import { env, llmKey } from "../config/env.js";
import { logger } from "../lib/log.js";
import { decisionSchema, type Decision } from "./schema.js";
import { SYSTEM_PROMPT } from "./prompt.js";

const log = logger("agent.decide");

export interface DecideResult {
  status: "ok" | "refused" | "invalid" | "truncated";
  decision?: Decision;
  /** Exact text the model returned (outputHash = keccak256(utf8(outputText))). */
  outputText: string;
  requestedModel: string;
  servedModel: string;
  fallbackRan: boolean;
  stopReason: string | null;
  refusal?: { category: string | null; explanation: string | null };
  usage: unknown;
  /** Provider request id (Phala Private AI: verifiable receipt id for the TEE-attested call). */
  requestId?: string;
  error?: string;
}

/** JSON Schema of the decision, embedded in the system prompt so small models know the exact shape. */
function decisionJsonSchema(): string {
  try {
    return JSON.stringify(z.toJSONSchema(decisionSchema));
  } catch {
    return "";
  }
}

const SHAPE_HINT = `Return ONLY one JSON object with exactly these keys:
{"action":"tighten"|"hold"|"loosen","triggerLev":number,"targetLev":number,"lowerTriggerLev":number,"maxDevBps":integer,"closedFeeBps":integer,"gapGuardSec":integer,"horizonSec":integer,"confidence":number,"rationale":string,"events":[{"source":string,"title":string,"dateUtc":string,"materiality":"none"|"low"|"medium"|"high","note":string}],"evidence":[{"tool":string,"argsHash":string,"responseHash":string}]}
No markdown, no code fences, no extra keys.`;

interface ChatResponse {
  id?: string;
  model?: string;
  choices?: { message?: { content?: string | null; refusal?: string | null }; finish_reason?: string | null }[];
  usage?: unknown;
  error?: { message?: string };
}

async function chat(model: string, messages: { role: string; content: string }[]): Promise<ChatResponse> {
  const e = env();
  const key = llmKey();
  if (!key) throw new Error("no LLM key: set PHALA_AI_API_KEY (or LLM_API_KEY)");
  const res = await fetch(`${e.LLM_BASE_URL.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    // gpt-oss-120b is a reasoning model: its reasoning tokens count against max_tokens, and 2000 truncated real runs.
    body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: e.AGENT_MAX_TOKENS, response_format: { type: "json_object" } }),
    signal: AbortSignal.timeout(120_000),
  });
  const body = (await res.json().catch(() => ({}))) as ChatResponse;
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${body.error?.message ?? "unknown error"}`);
  return body;
}

/**
 * One LLM call through an OpenAI-compatible endpoint (default: Phala Private AI, TEE-attested inference),
 * no tools. The model's only output is the JSON decision; MCP data reaches it only as untrusted text in the
 * user turn. If the first answer does not match the schema, one repair turn is attempted.
 */
export async function decide(userPrompt: string): Promise<DecideResult> {
  const model = env().AGENT_MODEL;
  const schema = decisionJsonSchema();
  const system = `${SYSTEM_PROMPT}\n\n${SHAPE_HINT}${schema ? `\nJSON Schema: ${schema}` : ""}`;
  const messages = [
    { role: "system", content: system },
    { role: "user", content: userPrompt },
  ];
  let res = await chat(model, messages);
  let outputText = res.choices?.[0]?.message?.content ?? "";
  let parsed = safeParse(outputText);
  if (!parsed && outputText) {
    log.warn("decision did not match schema; one repair attempt");
    res = await chat(model, [
      ...messages,
      { role: "assistant", content: outputText },
      { role: "user", content: `That did not match the required JSON shape. ${SHAPE_HINT}` },
    ]);
    outputText = res.choices?.[0]?.message?.content ?? "";
    parsed = safeParse(outputText);
  }
  const finish = res.choices?.[0]?.finish_reason ?? null;
  const base = {
    outputText,
    requestedModel: model,
    servedModel: res.model ?? model,
    fallbackRan: false,
    stopReason: finish,
    usage: res.usage,
    requestId: res.id,
  };
  const refusal = res.choices?.[0]?.message?.refusal;
  if (refusal) return { ...base, status: "refused", refusal: { category: null, explanation: refusal } };
  if (finish === "length") return { ...base, status: "truncated", error: "max_tokens reached" };
  if (!parsed) return { ...base, status: "invalid", error: "output did not match the decision schema" };
  return { ...base, status: "ok", decision: parsed };
}

function safeParse(text: string): Decision | undefined {
  try {
    const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    const r = decisionSchema.safeParse(JSON.parse(cleaned));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}
