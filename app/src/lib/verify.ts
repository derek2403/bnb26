// Browser-side re-implementation of the services' hashing rules (services/src/lib/{canonical,hashlog,merkle}.ts).
// Keep in sync: canonical JSON = sorted keys (UTF-16 order), no whitespace, undefined dropped, bigint as string.
import { concat, keccak256, toBytes, type Hex } from "viem";

export const GENESIS: Hex = `0x${"0".repeat(64)}`;

export function canonicalJSON(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      return JSON.stringify(v);
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new Error("non-finite number");
      return JSON.stringify(v);
    case "bigint":
      return JSON.stringify(v.toString());
    case "object": {
      if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : canonicalJSON(x))).join(",")}]`;
      const o = v as Record<string, unknown>;
      const keys = Object.keys(o).filter((k) => o[k] !== undefined && typeof o[k] !== "function").sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(o[k])}`).join(",")}}`;
    }
    default:
      return "null";
  }
}

const OPTIONAL = ["endpoint", "params", "http", "cmcTs", "creditCount", "elapsedMs", "bodyHash", "txHash", "chainId", "data"] as const;

/** The hashed body of a log entry: {seq, ts, service, kind} plus the optional fields that are set. */
export function entryBody(e: Record<string, unknown>): Record<string, unknown> {
  const o: Record<string, unknown> = { seq: e.seq, ts: e.ts, service: e.service, kind: e.kind };
  for (const k of OPTIONAL) if (e[k] !== undefined && e[k] !== null) o[k] = e[k];
  return o;
}

export function entryHash(prevHash: Hex, e: Record<string, unknown>): Hex {
  return keccak256(concat([prevHash, toBytes(canonicalJSON(entryBody(e)))]));
}

export type ProofStep = { sibling: Hex; left: boolean };

/** Ordered Merkle (parent = keccak(left ‖ right)); `left` = sibling sits on the left. */
export function rootFromProof(leaf: Hex, proof: ProofStep[]): Hex {
  let node = leaf;
  for (const s of proof) node = s.left ? keccak256(concat([s.sibling, node])) : keccak256(concat([node, s.sibling]));
  return node;
}

/** RiskOracle Snapshot.responseHash = keccak256(bodyHash_1 ‖ bodyHash_2 ‖ …) in data.components order. */
export function responseHashOf(bodyHashes: Hex[]): Hex {
  return keccak256(concat(bodyHashes));
}

export function bytesHash(buf: ArrayBuffer): Hex {
  return keccak256(new Uint8Array(buf));
}
