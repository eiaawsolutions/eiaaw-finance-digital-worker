/**
 * Integration tests need a live Postgres with pgvector. When DATABASE_URL is
 * absent they are skipped rather than failed, so `pnpm test` stays green on a
 * clean checkout while CI (which provisions Postgres) runs them for real.
 */
import { beforeAll } from 'vitest';

export const hasDatabase = Boolean(process.env['DATABASE_URL']);

beforeAll(() => {
  if (!hasDatabase) {
    console.warn(
      '\n[integration] DATABASE_URL is not set — integration suites are skipped.\n' +
        '              Start Postgres and export DATABASE_URL to run them.\n',
    );
  }
});
