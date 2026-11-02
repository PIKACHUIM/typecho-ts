import { SCHEMA_STATEMENTS } from '../generated/schema';
import type { Db } from './db';

/** Prefix baked into migrations/*.sql; rewritten for custom `DB_PREFIX` setups. */
const SCHEMA_PREFIX = 'typecho_';

/**
 * D1 reports a missing table as `D1_ERROR: no such table: typecho_options: SQLITE_ERROR`.
 * The original error can be wrapped in `cause`, so walk the chain.
 */
export function isMissingTableError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 5; depth += 1) {
    const message = current instanceof Error ? current.message : String(current);
    if (/no such table/i.test(message)) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export function schemaStatements(prefix: string): string[] {
  if (prefix === SCHEMA_PREFIX) return SCHEMA_STATEMENTS;
  return SCHEMA_STATEMENTS.map((sql) => sql.split(SCHEMA_PREFIX).join(prefix));
}

/**
 * Creates the Typecho tables in one atomic D1 batch. Every statement uses
 * `IF NOT EXISTS`, so only missing tables are added and existing data is kept.
 */
export async function createSchema(db: Db): Promise<void> {
  await db.batch(schemaStatements(db.prefix).map((sql) => ({ sql })));
}
