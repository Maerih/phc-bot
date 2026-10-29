/**
 * Database client.
 *
 * One pooled connection for the process. `assertDatabaseReachable` is called
 * during startup so a misconfigured DATABASE_URL fails loudly at boot instead
 * of surfacing as a broken command reply to a member.
 */
import { drizzle } from 'drizzle-orm/postgres-js';
import { sql } from 'drizzle-orm';
import postgres from 'postgres';
import { env } from '../config/env.js';
import { logger } from '../core/logger.js';
import * as schema from './schema.js';

const log = logger.child({ component: 'db' });

export const connection = postgres(env.DATABASE_URL, {
  max: 10,
  idle_timeout: 30,
  connect_timeout: 10,
  onnotice: (notice) => log.debug({ notice: notice.message }, 'postgres notice'),
});

export const db = drizzle(connection, { schema });

export type Database = typeof db;

/** Verify connectivity. Throws with a readable message when unreachable. */
export async function assertDatabaseReachable(): Promise<void> {
  try {
    await db.execute(sql`select 1`);
    log.info('database connection established');
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `Cannot reach the database at the configured DATABASE_URL: ${reason}\n` +
        `Start a local dev database with: ./scripts/dev-services.sh start`,
    );
  }
}

export async function closeDatabase(): Promise<void> {
  await connection.end({ timeout: 5 });
  log.info('database connection closed');
}

/**
 * Apply schema changes this database has not seen yet.
 *
 * Runs at every startup, so updating the code is all an operator does; a
 * database that is already current costs one small query.
 */
export async function runMigrations(): Promise<void> {
  const { MIGRATIONS } = await import('./migrations.js');
  await connection`
    CREATE TABLE IF NOT EXISTS public.schema_migrations (
      name text PRIMARY KEY,
      applied_at timestamp with time zone DEFAULT now() NOT NULL
    )`;
  const rows = await connection<{ name: string }[]>`select name from public.schema_migrations`;
  const applied = new Set(rows.map((row) => row.name));

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.name)) continue;
    // One transaction per migration: a failure leaves the schema as it was.
    await connection.begin(async (tx) => {
      await tx.unsafe(migration.sql);
      await tx`insert into public.schema_migrations (name) values (${migration.name})`;
    });
    log.info({ migration: migration.name }, 'database migration applied');
  }
}
