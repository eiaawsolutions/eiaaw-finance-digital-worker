/**
 * C11 — the L2 Knowledge Service.
 *
 * The invariant this component exists to hold is stated in file 01 s.5.3:
 *
 *   "Every substantive statement traces to an L2 source with its version and
 *    effective date, or to an L1 record with its provenance. CITE OR REFUSE."
 *
 *   "If the corpus does not cover the question at the resolved jurisdiction and
 *    effective date, the worker refuses and names what is missing. IT DOES NOT
 *    ANSWER FROM GENERAL KNOWLEDGE."
 *
 * Three retrieval behaviours follow from that, and none of them is a ranking
 * preference:
 *
 *   1. filters before similarity (DWD-06 s.10.3) — enforced in `retrieve_chunks`;
 *   2. a coverage gap is RECORDED and returned as a gap, never smoothed over;
 *   3. a statutory rate past its verification horizon halts the task
 *      (immutable rule 10) rather than being used with a caveat.
 */
import {
  type DateOnly,
  type Result,
  coversDate,
  err,
  newId,
  ok,
  parseDateOnly,
  WorkerError,
} from '@eiaaw/core';
import type { KnowledgeUsed, ResolvedContext } from '@eiaaw/contracts';
import { type Database, type TenantScope, withTenant } from '@eiaaw/db';

export interface RetrievedChunk {
  readonly chunk_id: string;
  readonly version: string;
  readonly module_id: string;
  readonly source_id: string;
  readonly citation_locator: string;
  readonly content: string;
  readonly content_hash: string;
  readonly effective_from: DateOnly;
  readonly effective_to: DateOnly | null;
  readonly licence_class: string;
  readonly conflict_flags: readonly string[];
  readonly is_statutory_rate: boolean;
  readonly verified_at: DateOnly | null;
  readonly verification_horizon_days: number | null;
  readonly distance: number;
}

export type CoverageTier = 'full' | 'partial' | 'none';

export interface RetrievalResult {
  readonly chunks: readonly RetrievedChunk[];
  readonly coverage_tier: CoverageTier;
  /** Rates past their horizon. A non-empty list halts the task (rule 10). */
  readonly stale_statutory_rates: readonly string[];
  /** Sources that disagree on the same axis and period (s.10.3). */
  readonly conflicts: readonly { readonly chunk_ids: readonly string[]; readonly flag: string }[];
  readonly gap: { readonly kind: string; readonly detail: string } | null;
}

export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface KnowledgeServiceOptions {
  readonly db: Database;
  readonly residencyZone: string;
  readonly embeddings: EmbeddingProvider;
  /** Cosine distance above which a chunk is too far to count as coverage. */
  readonly relevanceCeiling?: number;
  readonly defaultLimit?: number;
}

export class KnowledgeService {
  readonly #db: Database;
  readonly #residencyZone: string;
  readonly #embeddings: EmbeddingProvider;
  readonly #relevanceCeiling: number;
  readonly #defaultLimit: number;

  constructor(options: KnowledgeServiceOptions) {
    this.#db = options.db;
    this.#residencyZone = options.residencyZone;
    this.#embeddings = options.embeddings;
    // 0.6 cosine distance is a deliberately generous ceiling: the hard filters
    // have already removed everything from the wrong jurisdiction, framework
    // and period, so what remains is on-topic or the corpus has a gap.
    this.#relevanceCeiling = options.relevanceCeiling ?? 0.6;
    this.#defaultLimit = options.defaultLimit ?? 12;
  }

  /**
   * Retrieve for a query, within a resolved context.
   *
   * The context is not advisory: its axes are the filters, and its as-of date
   * decides which version of a rule is a candidate at all.
   */
  async retrieve(
    context: ResolvedContext,
    query: string,
    options: {
      readonly modules?: readonly string[];
      readonly clearance?: string;
      readonly limit?: number;
      readonly graph_id?: string;
    } = {},
    scope?: TenantScope,
  ): Promise<RetrievalResult> {
    const [embedding] = await this.#embeddings.embed([query]);
    if (!embedding) {
      throw new WorkerError('dependency_unavailable', {
        detail: 'The embedding provider returned no vector for the query.',
        failureClass: 'grounding',
        retryable: true,
      });
    }

    const asOf = context.axes.as_of_date.value;
    const run = async (s: TenantScope): Promise<RetrievedChunk[]> =>
      s.sql<RetrievedChunk[]>`
        SELECT * FROM retrieve_chunks(
          ${context.tenant_id},
          ${`[${embedding.join(',')}]`}::vector,
          ${this.#embeddings.model},
          ${asOf}::date,
          ${context.axes.jurisdiction.value},
          ${context.axes.reporting_framework.value},
          ${options.clearance ?? 'internal'},
          ${options.modules ?? null},
          ${options.limit ?? this.#defaultLimit}
        )
      `;

    const raw = scope
      ? await run(scope)
      : await withTenant(
          this.#db,
          { tenantId: context.tenant_id, residencyZone: this.#residencyZone, readOnly: true },
          run,
        );

    const relevant = raw.filter((chunk) => chunk.distance <= this.#relevanceCeiling);
    const staleRates = relevant.filter((chunk) => this.#isStale(chunk, asOf));
    const conflicts = this.#detectConflicts(relevant);

    const coverage: CoverageTier =
      relevant.length === 0 ? 'none' : relevant.length < 3 ? 'partial' : 'full';

    let gap: RetrievalResult['gap'] = null;
    if (relevant.length === 0) {
      // Distinguish "nothing exists" from "nothing exists for this date". The
      // second is a far more actionable gap for the freshness owner.
      const anyVersion =
        raw.length > 0 || (await this.#existsInAnyPeriod(context, options.modules));
      gap = anyVersion
        ? {
            kind: 'effective_date_gap',
            detail:
              `the corpus covers this topic but no version is in force at ${asOf} for ` +
              `${context.axes.jurisdiction.value}/${context.axes.reporting_framework.value}`,
          }
        : {
            kind: 'no_coverage',
            detail:
              `nothing in the corpus covers this at ${context.axes.jurisdiction.value}/` +
              `${context.axes.reporting_framework.value}`,
          };
    } else if (staleRates.length > 0) {
      gap = {
        kind: 'stale_statutory_rate',
        detail: `${staleRates.length} statutory rate(s) are past their verification horizon`,
      };
    } else if (conflicts.length > 0) {
      gap = {
        kind: 'conflicting_sources',
        detail: `${conflicts.length} conflict flag(s) on the retrieved set`,
      };
    }

    if (gap) {
      await this.#recordGap(context, query, gap, options.modules ?? [], options.graph_id);
    }

    return {
      chunks: relevant,
      coverage_tier: coverage,
      stale_statutory_rates: staleRates.map(
        (chunk) => `${chunk.module_id} ${chunk.citation_locator} (verified ${chunk.verified_at})`,
      ),
      conflicts,
      gap,
    };
  }

  /**
   * The grounding decision.
   *
   * CITE OR REFUSE, expressed as a Result: either a citable set, or a refusal
   * that names what is missing. There is no third branch, and deliberately no
   * "answer with a caveat" option.
   */
  async ground(
    context: ResolvedContext,
    query: string,
    options: Parameters<KnowledgeService['retrieve']>[2] = {},
    scope?: TenantScope,
  ): Promise<Result<{ chunks: readonly RetrievedChunk[]; used: readonly KnowledgeUsed[] }>> {
    const result = await this.retrieve(context, query, options, scope);

    if (result.stale_statutory_rates.length > 0) {
      return err(
        new WorkerError('unprocessable_content', {
          detail:
            'I have halted rather than answer. A statutory rate this answer depends on is ' +
            `past its verification horizon: ${result.stale_statutory_rates.join('; ')}. ` +
            'I do not interpolate, carry forward, average, or use a prior-period rate.',
          failureClass: 'grounding',
          retryable: false,
          context: { stale_statutory_rates: result.stale_statutory_rates },
        }),
      );
    }

    if (result.coverage_tier === 'none') {
      return err(
        new WorkerError('unprocessable_content', {
          detail:
            `I cannot answer this from the corpus. ${result.gap?.detail ?? 'No coverage found'}. ` +
            'I will not answer from general knowledge. The gap is recorded for the ' +
            'research and freshness owner.',
          failureClass: 'grounding',
          retryable: false,
          context: { gap: result.gap },
        }),
      );
    }

    if (result.conflicts.length > 0) {
      return err(
        new WorkerError('unprocessable_content', {
          detail:
            'The corpus holds sources that disagree on this point for the resolved ' +
            `jurisdiction and period: ${result.conflicts.map((c) => c.flag).join('; ')}. ` +
            'I have surfaced the conflict rather than choosing between them.',
          failureClass: 'grounding',
          retryable: false,
          context: { conflicts: result.conflicts },
        }),
      );
    }

    return ok({
      chunks: result.chunks,
      used: result.chunks.map((chunk): KnowledgeUsed => ({
        module_id: chunk.module_id,
        chunk_id: chunk.chunk_id,
        version: chunk.version,
        effective_from: chunk.effective_from,
        effective_to: chunk.effective_to,
        citation_locator: chunk.citation_locator,
        licence_class: chunk.licence_class,
      })),
    });
  }

  /**
   * Immutable rule 10, evaluated per chunk.
   *
   * A rate whose verification is older than its horizon is stale — regardless
   * of whether its effective range still covers the as-of date. Those are two
   * different questions: "is this the rule that applied then" and "do we still
   * believe our copy of it is right".
   */
  #isStale(chunk: RetrievedChunk, asOf: DateOnly): boolean {
    if (!chunk.is_statutory_rate) return false;
    if (chunk.verified_at === null || chunk.verification_horizon_days === null) return true;

    const verified = parseDateOnly(chunk.verified_at).getTime();
    const horizonMs = chunk.verification_horizon_days * 24 * 60 * 60 * 1000;
    // Measured against the as-of date, not against today: a question about a
    // 2024 period is answered from what was verified for 2024.
    const measuredAt = Math.max(parseDateOnly(asOf).getTime(), Date.now() - horizonMs);
    return measuredAt > verified + horizonMs;
  }

  /**
   * s.10.3: conflict flags are surfaced, never resolved by rank.
   *
   * Two chunks carrying the same flag are the shape the corpus uses to say
   * "these disagree"; the worker's job is to say so, not to pick.
   */
  #detectConflicts(chunks: readonly RetrievedChunk[]): { chunk_ids: string[]; flag: string }[] {
    const byFlag = new Map<string, string[]>();
    for (const chunk of chunks) {
      for (const flag of chunk.conflict_flags) {
        byFlag.set(flag, [...(byFlag.get(flag) ?? []), chunk.chunk_id]);
      }
    }
    return [...byFlag.entries()]
      .filter(([, ids]) => ids.length > 1)
      .map(([flag, chunk_ids]) => ({ flag, chunk_ids }));
  }

  async #existsInAnyPeriod(
    context: ResolvedContext,
    modules: readonly string[] | undefined,
  ): Promise<boolean> {
    if (modules === undefined || modules.length === 0) return false;
    const rows = await withTenant(
      this.#db,
      { tenantId: context.tenant_id, residencyZone: this.#residencyZone, readOnly: true },
      async (s) =>
        s.sql<{ exists: boolean }[]>`
          SELECT EXISTS (
            SELECT 1 FROM knowledge_chunks
             WHERE module_id = ANY (${modules as unknown as string[]})
               AND retired_at IS NULL
          ) AS exists
        `,
    );
    return rows[0]?.exists ?? false;
  }

  /**
   * Roadmap s.4.5: "a recorded gap is a Research and Freshness input, not a
   * defect in the answer." Repeats increment a counter rather than piling up
   * rows, so the register shows what is actually being asked for.
   */
  async #recordGap(
    context: ResolvedContext,
    query: string,
    gap: { kind: string; detail: string },
    modules: readonly string[],
    graphId?: string,
  ): Promise<void> {
    await withTenant(
      this.#db,
      { tenantId: context.tenant_id, residencyZone: this.#residencyZone },
      async (s) => {
        const existing = await s.sql<{ gap_id: string }[]>`
          SELECT gap_id FROM knowledge_coverage_gaps
           WHERE tenant_id = ${context.tenant_id}
             AND query_text = ${query}
             AND jurisdiction = ${context.axes.jurisdiction.value}
             AND framework = ${context.axes.reporting_framework.value}
             AND as_of_date = ${context.axes.as_of_date.value}::date
             AND gap_kind = ${gap.kind}
             AND resolved_at IS NULL
           LIMIT 1
        `;

        if (existing[0]) {
          await s.sql`
            UPDATE knowledge_coverage_gaps
               SET occurrences = occurrences + 1, last_seen_at = now()
             WHERE tenant_id = ${context.tenant_id} AND gap_id = ${existing[0].gap_id}
          `;
          return;
        }

        await s.sql`
          INSERT INTO knowledge_coverage_gaps (
            tenant_id, gap_id, graph_id, query_text, jurisdiction, framework,
            as_of_date, modules_searched, gap_kind, detail
          ) VALUES (
            ${context.tenant_id}, ${newId('auditEvent')}, ${graphId ?? null}, ${query},
            ${context.axes.jurisdiction.value}, ${context.axes.reporting_framework.value},
            ${context.axes.as_of_date.value}::date,
            ${modules}, ${gap.kind}, ${gap.detail}
          )
        `;
      },
    );
  }

  /**
   * Resolve a chunk at the version in force on a date — the supersession chain.
   *
   * An evidence bundle cites a chunk *version*, and an auditor reading it two
   * years later must be able to fetch exactly that text.
   */
  async resolveVersion(
    tenantId: string,
    chunkId: string,
    asOf: DateOnly,
  ): Promise<RetrievedChunk | null> {
    const rows = await withTenant(
      this.#db,
      { tenantId, residencyZone: this.#residencyZone, readOnly: true },
      async (s) =>
        s.sql<RetrievedChunk[]>`
          SELECT chunk_id, version, module_id, source_id, citation_locator, content,
                 content_hash, effective_from, effective_to, licence_class,
                 conflict_flags, is_statutory_rate, verified_at,
                 verification_horizon_days, 0::double precision AS distance
            FROM knowledge_chunks
           WHERE chunk_id = ${chunkId}
             AND (tenant_id IS NULL OR tenant_id = ${tenantId})
             AND effective_from <= ${asOf}::date
             AND (effective_to IS NULL OR effective_to >= ${asOf}::date)
           ORDER BY effective_from DESC LIMIT 1
        `,
    );
    return rows[0] ?? null;
  }

  /** Which rates are approaching or past their horizon — the freshness watchlist. */
  async freshnessWatchlist(
    tenantId: string,
    withinDays = 30,
  ): Promise<
    { chunk_id: string; module_id: string; verified_at: DateOnly; days_remaining: number }[]
  > {
    return withTenant(
      this.#db,
      { tenantId, residencyZone: this.#residencyZone, readOnly: true },
      async (s) =>
        s.sql<
          { chunk_id: string; module_id: string; verified_at: DateOnly; days_remaining: number }[]
        >`
          SELECT chunk_id, module_id, verified_at,
                 -- Cast to date before subtracting: date − date yields an
                 -- integer number of days, whereas timestamp − date yields an
                 -- interval, which has no cast to integer.
                 ((verified_at + (verification_horizon_days || ' days')::interval)::date
                    - CURRENT_DATE) AS days_remaining
            FROM knowledge_chunks
           WHERE is_statutory_rate AND retired_at IS NULL
             AND (tenant_id IS NULL OR tenant_id = ${tenantId})
             AND verified_at + (verification_horizon_days || ' days')::interval
                 <= CURRENT_DATE + (${withinDays} || ' days')::interval
           ORDER BY days_remaining
        `,
    );
  }
}

/** Effective-date coverage, exposed for the assurance harness's gate. */
export const chunkCoversDate = (chunk: RetrievedChunk, asOf: DateOnly): boolean =>
  coversDate(asOf, chunk.effective_from, chunk.effective_to);
