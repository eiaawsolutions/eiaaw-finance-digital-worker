#!/usr/bin/env tsx
/**
 * Corpus ingestion CLI.
 *
 * Usage:
 *   pnpm --filter @eiaaw/knowledge ingest \
 *     --dir "<path to a knowledgebase folder>" \
 *     --pack pack-my-mfrs --version 2026.08.1 \
 *     --jurisdiction MY --framework MFRS --effective-from 2026-01-01 [--publish]
 */
import { closeDatabase, createDatabase } from '@eiaaw/db';
import { createEmbeddingProvider } from './embeddings.js';
import { ingestDirectory, publishPack } from './ingest.js';

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.startsWith('--')) {
    if (fallback !== undefined) return fallback;
    console.error(`Missing required argument --${name}`);
    process.exit(1);
  }
  return value;
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const directory = arg('dir');
  const packId = arg('pack');
  const packVersion = arg('version');
  const jurisdiction = arg('jurisdiction', 'MY');
  const framework = arg('framework', 'MFRS');
  const effectiveFrom = arg('effective-from', '2026-01-01');
  const shouldPublish = process.argv.includes('--publish');

  const db = createDatabase({
    url,
    poolMax: 4,
    ssl: process.env['DATABASE_SSL'] === 'true',
    statementTimeoutMs: 300_000,
  });

  const embeddings = createEmbeddingProvider({
    deployEnvironment: process.env['DEPLOY_ENVIRONMENT'] ?? 'dev',
  });

  try {
    console.log(`Ingesting ${directory}`);
    console.log(`  pack        ${packId} ${packVersion}`);
    console.log(`  axes        ${jurisdiction} / ${framework}`);
    console.log(`  effective   ${effectiveFrom}`);
    console.log(`  embeddings  ${embeddings.model} (${embeddings.dimensions}d)\n`);

    const started = Date.now();
    const result = await ingestDirectory(directory, {
      db,
      embeddings,
      packId,
      packVersion,
      jurisdiction,
      framework,
      effectiveFrom,
      verificationHorizonDays: Number(process.env['VERIFICATION_HORIZON_DAYS'] ?? 365),
    });

    console.log(`  modules              ${result.modules}`);
    console.log(`  chunks inserted      ${result.chunksInserted}`);
    console.log(`  chunks superseded    ${result.chunksSuperseded}`);
    console.log(`  chunks unchanged     ${result.chunksUnchanged}`);
    console.log(`  statutory-rate chunks ${result.statutoryRateChunks}`);
    console.log(`  elapsed              ${((Date.now() - started) / 1000).toFixed(1)}s`);

    if (shouldPublish) {
      await publishPack(db, packId, packVersion, 'ingest-cli', 'Initial corpus load');
      console.log('\n  pack published');
    } else {
      console.log('\n  pack left in draft. Re-run with --publish to make it resolvable.');
    }

    process.exit(0);
  } catch (error) {
    console.error('\nIngestion failed:');
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  } finally {
    await closeDatabase(db);
  }
}

void main();
