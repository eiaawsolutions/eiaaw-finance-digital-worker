/**
 * Migration runner.
 *
 * DWD-06 s.14.4: "database migrations expand-then-contract" and, in the red
 * flags, "A migration that rewrites historical records."
 *
 * Two properties this runner enforces:
 *
 *   - Forward-only, applied in filename order, each in its own transaction, and
 *     recorded with the checksum of the file that was applied. A file whose
 *     contents change after being applied is a hard error, not a silent re-run:
 *     the schema in the database would no longer match the file in the repo.
 *
 *   - Advisory-locked, so two instances booting at once (which Railway does on
 *     every deploy) cannot apply the same migration twice.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '@eiaaw/core';
import type { Database } from './client.js';

export interface Migration {
  readonly id: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface MigrationResult {
  readonly applied: readonly string[];
  readonly skipped: readonly string[];
  readonly durationMs: number;
}

/** One well-known key. Any instance running migrations contends on it. */
const ADVISORY_LOCK_KEY = 8_147_236_591;

export function loadMigrations(directory: string): Migration[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((filename) => {
      const sql = readFileSync(join(directory, filename), 'utf8');
      return {
        id: filename.replace(/\.sql$/, ''),
        filename,
        sql,
        checksum: sha256(sql.replace(/\r\n/g, '\n')),
      };
    });
}

async function ensureLedger(db: Database): Promise<void> {
  await db.unsafe(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id          text PRIMARY KEY,
      checksum    text        NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer     NOT NULL
    )
  `);
}

export async function runMigrations(
  db: Database,
  directory: string,
  log: (message: string) => void = () => undefined,
): Promise<MigrationResult> {
  const started = Date.now();
  const migrations = loadMigrations(directory);
  const applied: string[] = [];
  const skipped: string[] = [];

  await ensureLedger(db);

  // Blocks until any other instance finishes; released when the session ends.
  await db`SELECT pg_advisory_lock(${ADVISORY_LOCK_KEY})`;

  try {
    const rows = await db<{ id: string; checksum: string }[]>`
      SELECT id, checksum FROM schema_migrations
    `;
    const existing = new Map(rows.map((r) => [r.id, r.checksum]));

    for (const migration of migrations) {
      const previous = existing.get(migration.id);

      if (previous !== undefined) {
        if (previous !== migration.checksum) {
          throw new Error(
            `Migration ${migration.filename} has changed since it was applied.\n` +
              `  applied checksum: ${previous}\n` +
              `  current checksum: ${migration.checksum}\n` +
              'Migrations are forward-only. Editing an applied migration means the ' +
              'schema in the database no longer matches the file in the repository. ' +
              'Write a new migration instead.',
          );
        }
        skipped.push(migration.id);
        continue;
      }

      log(`applying ${migration.filename}`);
      const migrationStarted = Date.now();

      // Each migration in its own transaction: a failure leaves the ledger and
      // the schema consistent with each other, and the next run resumes here.
      await db.begin(async (sql) => {
        await sql.unsafe(migration.sql);
        await sql`
          INSERT INTO schema_migrations (id, checksum, duration_ms)
          VALUES (${migration.id}, ${migration.checksum}, ${Date.now() - migrationStarted})
        `;
      });

      applied.push(migration.id);
      log(`  applied in ${Date.now() - migrationStarted}ms`);
    }
  } finally {
    await db`SELECT pg_advisory_unlock(${ADVISORY_LOCK_KEY})`;
  }

  return { applied, skipped, durationMs: Date.now() - started };
}

export interface MigrationStatus {
  readonly id: string;
  readonly applied: boolean;
  readonly checksumMatches: boolean | null;
  readonly appliedAt: string | null;
}

export async function migrationStatus(db: Database, directory: string): Promise<MigrationStatus[]> {
  await ensureLedger(db);
  const rows = await db<{ id: string; checksum: string; applied_at: string }[]>`
    SELECT id, checksum, applied_at FROM schema_migrations
  `;
  const existing = new Map(rows.map((r) => [r.id, r]));

  return loadMigrations(directory).map((migration) => {
    const record = existing.get(migration.id);
    return {
      id: migration.id,
      applied: record !== undefined,
      checksumMatches: record === undefined ? null : record.checksum === migration.checksum,
      appliedAt: record?.applied_at ?? null,
    };
  });
}
