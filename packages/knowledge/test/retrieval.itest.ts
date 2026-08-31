/**
 * C11 against the real corpus.
 *
 * These run over the actual 36 ingested modules rather than a fixture, because
 * the behaviours being tested — effective-date candidacy, coverage gaps,
 * cite-or-refuse — only mean something against a corpus with real gaps in it.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { toTimestamp } from '@eiaaw/core';
import type { ResolvedContext } from '@eiaaw/contracts';
import { closeDatabase, createDatabase, withPlatformScope, type Database } from '@eiaaw/db';
import { DeterministicEmbeddingProvider, KnowledgeService } from '../src/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const ZONE = 'my-central';
const TENANT = 'tnt_knowledge-itest';

let db: Database;
let service: KnowledgeService;

function contextAt(
  asOf: string,
  overrides: Partial<ResolvedContext['axes']> = {},
): ResolvedContext {
  const at = toTimestamp(new Date());
  return {
    schema_version: '1.0.0',
    context_id: 'ctx_0192f3c1-7a10-7c31-9b6a-1f0d2c4b5e60',
    request_id: '0192f3c1-7a10-7c31-9b6a-1f0d2c4b5e60',
    tenant_id: TENANT,
    resolution_status: 'resolved',
    resolution_reason: null,
    axes: {
      jurisdiction: { value: 'MY', source: 'AS-ORG-002', coverage_tier: 'full' },
      reporting_framework: { value: 'MFRS', source: 'AS-ORG-003', coverage_tier: 'full' },
      legal_entity: { value: 'ENT-0007', source: 'AS-ORG-001', coverage_tier: 'full' },
      currency: { value: 'MYR', source: 'AS-ORG-004', coverage_tier: 'full' },
      as_of_date: { value: asOf, source: 'request', coverage_tier: 'full' },
      ...overrides,
    },
    pack: { pack_id: 'pack-my-mfrs', pack_version: '2026.08.1' },
    residency_zone: ZONE,
    resolved_locale: 'en-MY',
    knowledge_pin: { pinned_at: at, modules: [] },
    resolved_at: at,
    expires_at: toTimestamp(Date.now() + 3_600_000),
  };
}

describeIfDb('C11 knowledge retrieval over the real corpus', () => {
  beforeAll(async () => {
    db = createDatabase({ url: DATABASE_URL as string, poolMax: 4, ssl: false });
    service = new KnowledgeService({
      db,
      residencyZone: ZONE,
      embeddings: new DeterministicEmbeddingProvider(1536),
      // The deterministic provider is lexical, so a real ceiling would reject
      // everything. Retrieval *logic* is what these tests assert.
      relevanceCeiling: 1.2,
    });

    await withPlatformScope(db, async (sql) => {
      await sql`
        INSERT INTO tenants (tenant_id, display_name, residency_zone, status)
        VALUES (${TENANT}, 'Knowledge Itest', ${ZONE}, 'active')
        ON CONFLICT (tenant_id) DO NOTHING
      `;
      // Remove any fixture left by a previous run so the suite is idempotent.
      // A test that plants a row in the shared corpus and leaves it there makes
      // every later run order-dependent.
      await sql`DELETE FROM knowledge_embeddings WHERE chunk_id = 'ck_stale_rate_itest'`;
      await sql`DELETE FROM knowledge_chunks WHERE chunk_id = 'ck_stale_rate_itest'`;
    });
  });

  afterAll(async () => {
    if (db) await closeDatabase(db);
  });

  it('has a corpus to retrieve from', async () => {
    const rows = await withPlatformScope(
      db,
      async (sql) => sql<{ count: string }[]>`SELECT count(*)::text AS count FROM knowledge_chunks`,
    );
    expect(Number(rows[0]?.count)).toBeGreaterThan(1000);
  });

  it('retrieves cited chunks with version and effective date', async () => {
    const result = await service.retrieve(
      contextAt('2026-07-31'),
      'three way match tolerance between purchase order goods receipt and supplier invoice',
    );

    expect(result.chunks.length).toBeGreaterThan(0);
    for (const chunk of result.chunks) {
      // Every field the grounding gate needs, present on every chunk.
      expect(chunk.chunk_id).toMatch(/^ck_/);
      expect(chunk.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(chunk.effective_from).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(chunk.citation_locator.length).toBeGreaterThan(0);
      expect(chunk.content_hash).toMatch(/^sha256:[0-9a-f]{64}$/);
    }
  });

  it('excludes every chunk whose effective range does not cover the as-of date', async () => {
    // The corpus is effective from 2026-01-01, so a 2025 question has no
    // candidates at all — not merely lower-ranked ones.
    const result = await service.retrieve(contextAt('2025-06-30'), 'output tax computation');
    expect(result.chunks).toHaveLength(0);
    expect(result.coverage_tier).toBe('none');
  });

  it('filters on the jurisdiction axis', async () => {
    const result = await service.retrieve(
      contextAt('2026-07-31', {
        jurisdiction: { value: 'ZZ', source: 'test', coverage_tier: 'full' },
      }),
      'output tax computation',
    );
    // Modules tagged for Malaysia are not candidates for jurisdiction ZZ.
    // Untagged (global) modules remain, so this asserts the tagged ones are gone.
    const tagged = result.chunks.filter((c) => c.module_id.startsWith('05-tax'));
    expect(tagged).toHaveLength(0);
  });

  it('records a coverage gap rather than smoothing over it', async () => {
    const query = `what is the maritime tonnage tax basis for a Panamanian charter ${Date.now()}`;
    await service.retrieve(contextAt('2025-01-15'), query);

    const rows = await withPlatformScope(
      db,
      async (sql) =>
        sql<{ gap_kind: string; detail: string }[]>`
        SELECT gap_kind, detail FROM knowledge_coverage_gaps
         WHERE tenant_id = ${TENANT} AND query_text = ${query}
      `,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.gap_kind).toBe('no_coverage');
  });

  it('increments a repeat gap rather than inserting a duplicate row', async () => {
    const query = `repeated question with no coverage ${Date.now()}`;
    await service.retrieve(contextAt('2025-01-15'), query);
    await service.retrieve(contextAt('2025-01-15'), query);
    await service.retrieve(contextAt('2025-01-15'), query);

    const rows = await withPlatformScope(
      db,
      async (sql) =>
        sql<{ occurrences: number }[]>`
        SELECT occurrences FROM knowledge_coverage_gaps
         WHERE tenant_id = ${TENANT} AND query_text = ${query}
      `,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.occurrences).toBe(3);
  });

  // -------------------------------------------------------------------------
  // CITE OR REFUSE — file 01 s.5.3
  // -------------------------------------------------------------------------
  describe('ground()', () => {
    it('returns citable knowledge when the corpus covers the question', async () => {
      const result = await service.ground(
        contextAt('2026-07-31'),
        'reconciliation break classification and ageing',
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.used.length).toBeGreaterThan(0);
      for (const used of result.value.used) {
        expect(used.chunk_id).toBeTruthy();
        expect(used.version).toBeTruthy();
        expect(used.effective_from).toBeTruthy();
        expect(used.citation_locator).toBeTruthy();
        expect(used.licence_class).toBeTruthy();
      }
    });

    it('refuses rather than answering from general knowledge', async () => {
      const result = await service.ground(
        contextAt('2025-01-15'),
        `an entirely uncovered topic ${Date.now()}`,
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;

      expect(result.error.message).toMatch(/will not answer from general knowledge/);
      expect(result.error.failureClass).toBe('grounding');
      expect(result.error.retryable).toBe(false);
    });

    it('halts on a stale statutory rate rather than using it with a caveat', async () => {
      // Plant a rate whose verification is far past its horizon.
      await withPlatformScope(db, async (sql) => {
        const content =
          'The prescribed contribution rate for the period is set by the authority and ' +
          'applied to the wage ceiling as gazetted.';
        await sql`
          INSERT INTO knowledge_chunks (
            chunk_id, tenant_id, pack_id, pack_version, module_id, source_id, version,
            citation_locator, content, content_hash, effective_from, effective_to,
            jurisdictions, frameworks, is_statutory_rate, verified_at,
            verification_horizon_days
          -- Effective for July 2026 only, so this fixture is a candidate for
          -- the query below and for nothing else in the suite.
          ) VALUES (
            'ck_stale_rate_itest', NULL, 'pack-my-mfrs', '2026.08.1',
            'stale-rate-module', 'stale', '1.0.0', 's.1', ${content},
            ${'sha256:' + 'c'.repeat(64)}, '2026-07-01', '2026-07-31',
            ARRAY['MY'], ARRAY['MFRS'], true, '2020-01-01', 30
          ) ON CONFLICT DO NOTHING
        `;
        await sql`
          INSERT INTO knowledge_embeddings (chunk_id, version, embedding_model, embedding)
          VALUES ('ck_stale_rate_itest', '1.0.0', 'deterministic-hash-v1',
                  ${`[${Array.from({ length: 1536 }, (_u, i) => (i === 0 ? 1 : 0)).join(',')}]`}::vector)
          ON CONFLICT DO NOTHING
        `;
      });

      const result = await service.ground(
        contextAt('2026-07-31'),
        'prescribed contribution rate wage ceiling gazetted',
        { modules: ['stale-rate-module'] },
      );

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/past its verification horizon/);
      expect(result.error.message).toMatch(
        /do not interpolate, carry forward, average, or use a prior-period rate/,
      );
    });
  });

  it('resolves a chunk at the version in force on a historical date', async () => {
    // Pick a chunk that is genuinely in force on the test date. Taking an
    // arbitrary row would sometimes pick a superseded version and make the
    // assertion depend on insertion order.
    const rows = await withPlatformScope(
      db,
      async (sql) =>
        sql<{ chunk_id: string }[]>`
        SELECT chunk_id FROM knowledge_chunks
         WHERE tenant_id IS NULL
           AND effective_from <= '2026-07-31'::date
           AND effective_to IS NULL
           AND effective_from > '2020-01-01'::date
         ORDER BY chunk_id
         LIMIT 1
      `,
    );
    const chunkId = rows[0]?.chunk_id as string;
    expect(chunkId).toBeDefined();

    const resolved = await service.resolveVersion(TENANT, chunkId, '2026-07-31');
    expect(resolved?.chunk_id).toBe(chunkId);

    // Before the corpus was effective, the same id resolves to nothing —
    // which is what makes "what did it say then" answerable rather than guessed.
    expect(await service.resolveVersion(TENANT, chunkId, '2020-01-01')).toBeNull();
  });

  it('produces a freshness watchlist of rates approaching their horizon', async () => {
    const watchlist = await service.freshnessWatchlist(TENANT, 3650);
    expect(watchlist.length).toBeGreaterThan(0);
    expect(watchlist[0]).toHaveProperty('days_remaining');
    // Sorted by urgency: the most overdue first.
    for (let i = 1; i < Math.min(watchlist.length, 10); i += 1) {
      expect(watchlist[i]?.days_remaining).toBeGreaterThanOrEqual(
        watchlist[i - 1]?.days_remaining as number,
      );
    }
  });
});
