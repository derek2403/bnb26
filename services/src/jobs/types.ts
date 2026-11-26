export interface JobContext {
  /** Simulate only; never send a transaction. */
  dryRun: boolean;
  /** Set by `keeper once`: run every sub-task now, ignoring internal cadences. */
  force: boolean;
}

export interface Job {
  name: string;
  /** Base cadence. */
  everyMs: number;
  /** Needs Postgres (skipped when DB_DISABLED). */
  needsDb?: boolean;
  run(ctx: JobContext): Promise<unknown>;
}

export const SEC = 1000;
export const MIN = 60 * SEC;
export const HOUR = 60 * MIN;
