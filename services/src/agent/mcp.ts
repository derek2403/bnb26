import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Hex } from "viem";
import { z } from "zod";
import { env, mcpKey } from "../config/env.js";
import type { CmcAsset } from "../config/assets.js";
import { canonicalJSON, hashJSON, hashText } from "../lib/canonical.js";
import { kvGet, kvSet } from "../lib/db.js";
import { allow } from "../lib/governor.js";
import { appendLog, storeRaw } from "../lib/hashlog.js";
import { errMsg, logger } from "../lib/log.js";

const log = logger("agent.mcp");

/**
 * Local MCP client for the CMC MCP server (streamable HTTP, header X-CMC-MCP-API-KEY; the key stays on the VM).
 * Read-only market-data tools only; the LLM never gets these as tools: code calls them and passes the results
 * in as UNTRUSTED data. Every response is hashed: responseHash = keccak256(utf8(canonicalJSON(callToolResult))),
 * argsHash = keccak256(utf8(canonicalJSON({tool, args}))). Raw results are stored under responseHash.
 */
export interface ToolPlan {
  tool: string;
  args: Record<string, unknown>;
  ttlMs: number;
}

export interface McpEvidence {
  tool: string;
  args: Record<string, unknown>;
  argsHash: Hex;
  responseHash: Hex;
  text: string; // flattened text content (possibly truncated for the prompt; the hash covers the full result)
  truncated: boolean;
  cached: boolean;
  isError: boolean;
  fetchedAt: string;
}

const H = 3_600_000;

export function defaultPlan(a: CmcAsset): ToolPlan[] {
  return [
    { tool: "us_equity_upcoming_event_calendar", args: { symbol: a.symbol }, ttlMs: 3 * H },
    { tool: "get_upcoming_macro_events", args: {}, ttlMs: 3 * H },
    { tool: "get_crypto_technical_analysis", args: { id: String(a.cmcId) }, ttlMs: H - 60_000 },
    { tool: "get_crypto_latest_news", args: { id: String(a.cmcId) }, ttlMs: H - 60_000 },
    { tool: "get_global_metrics_latest", args: {}, ttlMs: H - 60_000 },
  ];
}

const planOverride = z.array(z.object({ tool: z.string(), args: z.record(z.string(), z.unknown()).default({}), ttlMs: z.number().default(H) }));

export function toolPlan(a: CmcAsset): ToolPlan[] {
  const raw = env().AGENT_MCP_TOOLS;
  if (raw) {
    const p = planOverride.safeParse(JSON.parse(raw));
    if (p.success) return p.data;
    log.warn("AGENT_MCP_TOOLS invalid, using default plan");
  }
  return defaultPlan(a);
}

type JsonSchema = { type?: string | string[]; properties?: Record<string, JsonSchema>; required?: string[]; items?: JsonSchema; enum?: unknown[] };

/** Fit planned args to the tool's advertised input schema: drop unknown keys, fill required ones, coerce types. */
export function fitArgs(schema: JsonSchema | undefined, args: Record<string, unknown>, a: CmcAsset): Record<string, unknown> {
  if (!schema?.properties) return args;
  const known: Record<string, unknown> = {
    symbol: a.symbol,
    symbols: a.symbol,
    ticker: a.symbol,
    id: String(a.cmcId),
    ids: String(a.cmcId),
    crypto_id: String(a.cmcId),
    query: a.symbol,
    limit: 10,
    count: 10,
  };
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) if (k in schema.properties) out[k] = v;
  for (const k of schema.required ?? []) if (!(k in out) && k in known) out[k] = known[k];
  for (const [k, v] of Object.entries(out)) {
    const t = schema.properties[k]?.type;
    const ty = Array.isArray(t) ? t[0] : t;
    if (ty === "string" && typeof v !== "string") out[k] = String(v);
    else if ((ty === "number" || ty === "integer") && typeof v === "string" && Number.isFinite(Number(v))) out[k] = Number(v);
    else if (ty === "array" && !Array.isArray(v)) out[k] = [v];
  }
  return out;
}

function flatten(result: unknown): { text: string; isError: boolean } {
  const r = result as { content?: { type: string; text?: string }[]; structuredContent?: unknown; isError?: boolean };
  const parts: string[] = [];
  for (const c of r.content ?? []) if (c.type === "text" && typeof c.text === "string") parts.push(c.text);
  if (parts.length === 0 && r.structuredContent !== undefined) parts.push(JSON.stringify(r.structuredContent));
  return { text: parts.join("\n"), isError: Boolean(r.isError) };
}

export const MAX_TOOL_TEXT = 12_000;

export async function gatherMcp(a: CmcAsset): Promise<{ evidence: McpEvidence[]; errors: { tool: string; error: string }[]; toolsListed: number }> {
  const key = mcpKey();
  const evidence: McpEvidence[] = [];
  const errors: { tool: string; error: string }[] = [];
  if (!key) return { evidence, errors: [{ tool: "*", error: "CMC_MCP_API_KEY / CMC_API_KEY not set" }], toolsListed: 0 };
  const client = new Client({ name: "splitstock-risk-steward", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(env().CMC_MCP_URL), {
    requestInit: { headers: { "X-CMC-MCP-API-KEY": key } },
  });
  let toolsListed = 0;
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    toolsListed = listed.tools.length;
    const schemas = new Map(listed.tools.map((t) => [t.name, t.inputSchema as JsonSchema]));
    for (const p of toolPlan(a)) {
      if (!schemas.has(p.tool)) {
        errors.push({ tool: p.tool, error: "tool not offered by the server for this key" });
        continue;
      }
      const args = fitArgs(schemas.get(p.tool), p.args, a);
      const argsHash = hashJSON({ tool: p.tool, args });
      const cacheKey = `mcp:cache:${p.tool}:${argsHash}`;
      const cached = await kvGet<McpEvidence>(cacheKey);
      if (cached && Date.now() - Date.parse(cached.fetchedAt) < p.ttlMs) {
        evidence.push({ ...cached, cached: true });
        continue;
      }
      const g = await allow(env().CMC_MCP_CREDITS_PER_CALL, "optional");
      if (!g.ok) {
        if (cached) evidence.push({ ...cached, cached: true });
        errors.push({ tool: p.tool, error: `budget ${g.state.mode}` });
        continue;
      }
      const t0 = Date.now();
      try {
        const result = await client.callTool({ name: p.tool, arguments: args });
        const raw = canonicalJSON(result);
        const responseHash = hashText(raw);
        await storeRaw(responseHash, "mcp", raw);
        await appendLog({ service: "agent", kind: "mcp", endpoint: p.tool, params: args, elapsedMs: Date.now() - t0, bodyHash: responseHash, creditCount: env().CMC_MCP_CREDITS_PER_CALL, data: { argsHash } });
        const { text, isError } = flatten(result);
        const ev: McpEvidence = {
          tool: p.tool,
          args,
          argsHash,
          responseHash,
          text: text.length > MAX_TOOL_TEXT ? text.slice(0, MAX_TOOL_TEXT) : text,
          truncated: text.length > MAX_TOOL_TEXT,
          cached: false,
          isError,
          fetchedAt: new Date().toISOString(),
        };
        evidence.push(ev);
        await kvSet(cacheKey, ev);
      } catch (e) {
        errors.push({ tool: p.tool, error: errMsg(e) });
      }
    }
  } catch (e) {
    errors.push({ tool: "*", error: `MCP connect/list failed: ${errMsg(e)}` });
  } finally {
    try {
      await client.close();
    } catch {
      /* ignore */
    }
  }
  return { evidence, errors, toolsListed };
}
