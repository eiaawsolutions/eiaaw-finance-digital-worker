#!/usr/bin/env tsx
/**
 * Migration CLI. Runs on boot in Railway (release command) and in CI.
 */
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { closeDatabase, createDatabase } from './client.js';
import { migrationStatus, runMigrations } from './migrate.js';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, '..', 'migrations');

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error(
      'DATABASE_URL is not set. The migration runner refuses to guess a connection ' +
        'string; absence is a refusal, not a default (DWD-06 s.13.3).',
    );
    process.exit(1);
  }

  const db = createDatabase({
    url,
    poolMax: 2,
    ssl: process.env['DATABASE_SSL'] === 'true',
    applicationName: 'eiaaw-fdw-migrate',
    // Migrations legitimately take longer than a request.
    statementTimeoutMs: 300_000,
  });

  try {
    if (process.argv.includes('--status')) {
      const rows = await migrationStatus(db, MIGRATIONS_DIR);
      console.log('Migration status\n');
      for (const row of rows) {
        const state = row.applied
          ? row.checksumMatches
            ? `applied  ${row.appliedAt}`
            : 'CHECKSUM MISMATCH'
          : 'pending';
        console.log(`  ${row.id.padEnd(40)} ${state}`);
      }
      const mismatched = rows.filter((r) => r.checksumMatches === false);
      process.exit(mismatched.length > 0 ? 1 : 0);
    }

    const result = await runMigrations(db, MIGRATIONS_DIR, (m) => console.log(m));
    console.log(
      `\nMigrations complete in ${result.durationMs}ms — ` +
        `${result.applied.length} applied, ${result.skipped.length} already present.`,
    );
    process.exit(0);
  } catch (error) {
    console.error('\nMigration failed:\n');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    await closeDatabase(db);
  }
}

void main();
