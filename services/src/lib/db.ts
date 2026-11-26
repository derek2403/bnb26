import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { env } from "../config/env.js";
import { logger } from "./log.js";

const log = logger("db");
export type Sql = postgres.Sql<Record<string, unknown>>;

let client: Sql | null | undefined;

/** The shared Postgres client, or null when DB_DISABLED (backup cron) or DATABASE_URL is unusable. */
export function db(): Sql | null {
  if (client !== undefined) return client;
  if (env().DB_DISABLED) {
    client = null;
    return client;
  }
  client = postgres(env().DATABASE_URL, {
    max: 10,
    idle_timeout: 30,
    connect_timeout: 10,
    onnotice: () => {},
    types: { bigint: postgres.BigInt },
  }) as unknown as Sql;
  return client;
}

export function requireDb(): Sql {
  const s = db();
  if (!s) throw new Error("database required (DB_DISABLED is set)");
  return s;
}

export async function closeDb() {
  if (client) await client.end({ timeout: 5 });
  client = undefined;
}

const here = dirname(fileURLToPath(import.meta.url));

export function schemaPath(): string {
  const candidates = [resolve(here, "..", "..", "db", "schema.sql"), resolve(process.cwd(), "db", "schema.sql")];
  return candidates.find((c) => existsSync(c)) ?? candidates[0];
}

/** Idempotent: schema.sql only uses CREATE ... IF NOT EXISTS. */
export async function migrate() {
  const sql = requireDb();
  const text = readFileSync(schemaPath(), "utf8");
  await sql.unsafe(text);
  log.info("schema applied", { path: schemaPath() });
}

/** Small key/value store for cadence bookkeeping and cached state across restarts. */
export async function kvGet<T = unknown>(key: string): Promise<T | undefined> {
  const sql = db();
  if (!sql) return memKv.get(key) as T | undefined;
  const rows = await sql<{ value: T }[]>`select value from kv where key = ${key}`;
  return rows[0]?.value;
}

export async function kvSet(key: string, value: unknown): Promise<void> {
  const sql = db();
  if (!sql) {
    memKv.set(key, value);
    return;
  }
  await sql`insert into kv (key, value, updated_at) values (${key}, ${sql.json(value as postgres.JSONValue)}, now())
            on conflict (key) do update set value = excluded.value, updated_at = now()`;
}

const memKv = new Map<string, unknown>();
