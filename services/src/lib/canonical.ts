import { keccak256, toBytes, type Hex } from "viem";

/**
 * Canonical JSON (RFC 8785-style subset): object keys sorted by UTF-16 code unit order, no whitespace,
 * bigint rendered as a decimal string, undefined fields dropped, non-finite numbers rejected.
 * Every hash we publish over a JSON value is keccak256(utf8(canonicalJSON(value))).
 */
export function canonicalJSON(value: unknown): string {
  return ser(value);
}

function ser(v: unknown): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
      return JSON.stringify(v);
    case "boolean":
      return v ? "true" : "false";
    case "number":
      if (!Number.isFinite(v)) throw new Error("canonicalJSON: non-finite number");
      return JSON.stringify(v);
    case "bigint":
      return JSON.stringify(v.toString());
    case "object": {
      if (Array.isArray(v)) return `[${v.map((x) => (x === undefined ? "null" : ser(x))).join(",")}]`;
      if (v instanceof Date) return JSON.stringify(v.toISOString());
      if (v instanceof Uint8Array) return JSON.stringify(Buffer.from(v).toString("hex"));
      const obj = v as Record<string, unknown>;
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined && typeof obj[k] !== "function")
        .sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${ser(obj[k])}`).join(",")}}`;
    }
    default:
      return "null";
  }
}

export function hashJSON(value: unknown): Hex {
  return keccak256(toBytes(canonicalJSON(value)));
}

export function hashText(text: string): Hex {
  return keccak256(toBytes(text));
}

export function hashBytes(bytes: Uint8Array): Hex {
  return keccak256(bytes);
}

/** JSON.stringify replacer-safe clone (bigint -> string) for DB jsonb columns and API responses. */
export function toJsonValue<T>(v: T): unknown {
  return JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)));
}
