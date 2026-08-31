import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { defineWorkspace } from 'vitest/config';

/**
 * Map `@eiaaw/<pkg>` to that package's *source*, not its `dist`.
 *
 * Without this, every test run would need a full `tsc -b` first, and a stale
 * `dist` would let a test pass against code that is no longer there. Production
 * resolution still goes through `exports` → `dist`; this alias is test-only.
 */
const packagesDir = resolve(import.meta.dirname, 'packages');

const workspaceAliases = {
  ...Object.fromEntries(
    readdirSync(packagesDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .filter((entry) => existsSync(join(packagesDir, entry.name, 'src', 'index.ts')))
      .map((entry) => [`@eiaaw/${entry.name}`, join(packagesDir, entry.name, 'src', 'index.ts')]),
  ),
  // The API app exposes its composition root so the worker can share it — one
  // container definition, so the two processes cannot drift apart in how they
  // wire the same components.
  '@eiaaw/api/container': resolve(import.meta.dirname, 'apps/api/src/container.ts'),
  '@eiaaw/api/server': resolve(import.meta.dirname, 'apps/api/src/server.ts'),
};

export default defineWorkspace([
  {
    resolve: { alias: workspaceAliases },
    test: {
      name: 'unit',
      include: ['packages/*/src/**/*.test.ts', 'apps/*/src/**/*.test.ts'],
      environment: 'node',
      globals: false,
      coverage: {
        provider: 'v8',
        reporter: ['text', 'lcov'],
        include: ['packages/*/src/**/*.ts'],
        exclude: ['**/*.test.ts', '**/index.ts', '**/*.d.ts', '**/fixtures.ts'],
        thresholds: {
          // Gate, not aspiration. Governance packages carry the higher bar.
          lines: 70,
          functions: 70,
          branches: 65,
          statements: 70,
        },
      },
    },
  },
  {
    resolve: { alias: workspaceAliases },
    test: {
      name: 'integration',
      include: ['packages/*/test/**/*.itest.ts', 'apps/*/test/**/*.itest.ts'],
      environment: 'node',
      globals: false,
      testTimeout: 60_000,
      hookTimeout: 120_000,
      // Integration tests need a live Postgres. They are skipped when
      // DATABASE_URL is absent so `pnpm test` stays green on a clean checkout.
      setupFiles: ['./test/setup-integration.ts'],
    },
  },
]);
