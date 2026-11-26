import { env } from "../config/env.js";

/** Minimal JSON-lines logger. Never pass secrets in `extra` (keys, tokens, auth headers). */
type Level = "debug" | "info" | "warn" | "error";
const ORDER: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
  try {
    return ORDER[env().LOG_LEVEL];
  } catch {
    return ORDER.info;
  }
}

export function jsonSafe(v: unknown): unknown {
  return JSON.parse(
    JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x instanceof Error ? { message: x.message, name: x.name } : x)),
  );
}

function emit(level: Level, scope: string, msg: string, extra?: Record<string, unknown>) {
  if (ORDER[level] < threshold()) return;
  const line = { t: new Date().toISOString(), level, scope, msg, ...(extra ? (jsonSafe(extra) as object) : {}) };
  const s = JSON.stringify(line);
  if (level === "error" || level === "warn") process.stderr.write(s + "\n");
  else process.stdout.write(s + "\n");
}

export interface Logger {
  debug(msg: string, extra?: Record<string, unknown>): void;
  info(msg: string, extra?: Record<string, unknown>): void;
  warn(msg: string, extra?: Record<string, unknown>): void;
  error(msg: string, extra?: Record<string, unknown>): void;
  child(scope: string): Logger;
}

export function logger(scope: string): Logger {
  return {
    debug: (m, e) => emit("debug", scope, m, e),
    info: (m, e) => emit("info", scope, m, e),
    warn: (m, e) => emit("warn", scope, m, e),
    error: (m, e) => emit("error", scope, m, e),
    child: (s) => logger(`${scope}.${s}`),
  };
}

export function errMsg(e: unknown): string {
  if (e instanceof Error) {
    // viem errors carry a shortMessage that is far more readable than the full dump.
    const short = (e as { shortMessage?: string }).shortMessage;
    return short ?? e.message;
  }
  return String(e);
}
