/**
 * Evidence bundles and decision records — the L9 half of C15.
 *
 *   s.3.10: "worm_ref: written before the bundle is shown to any human."
 *   s.3.13: "No output is delivered without a decision record."
 *   s.3.10: "A bundle cannot be assembled with a failing gate."
 *
 * All three are enforced here and again in the database (migration 0002), on
 * the principle that a governance control protected in one place only is a
 * control protected by whoever last edited that place.
 */
import { WorkerError, hashObject, newId, now, type PrefixedHash } from '@eiaaw/core';
import {
  type DecisionRecord,
  type EvidenceBundle,
  type OutputClass,
  assertContract,
} from '@eiaaw/contracts';
import { type Database, type TenantScope, withTenant } from '@eiaaw/db';

export interface EvidenceStoreOptions {
  readonly db: Database;
  readonly residencyZone: string;
  readonly platformVersion: string;
}

export class EvidenceStore {
  readonly #db: Database;
  readonly #residencyZone: string;
  readonly #platformVersion: string;

  constructor(options: EvidenceStoreOptions) {
    this.#db = options.db;
    this.#residencyZone = options.residencyZone;
    this.#platformVersion = options.platformVersion;
  }

  /**
   * Assemble and persist an evidence bundle.
   *
   * Refuses a bundle with a failing gate before it reaches the database. The
   * DB constraint would also refuse it, but a constraint violation is a poor
   * error message for a governance decision that deserves an explanation.
   */
  async assemble(
    input: Omit<EvidenceBundle, 'bundle_id' | 'assembled_at' | 'worm_ref' | 'schema_version'> & {
      readonly bundle_id?: string;
    },
    scope?: TenantScope,
  ): Promise<EvidenceBundle> {
    const failing = (['grounding_gate', 'arithmetic_gate', 'consistency_gate'] as const).filter(
      (gate) => input.assurance[gate] === 'fail',
    );
    if (failing.length > 0) {
      throw new WorkerError('unprocessable_content', {
        detail:
          `Cannot assemble an evidence bundle: ${failing.join(', ')} failed. ` +
          'A bundle is the basis on which a human approves; assembling one over a ' +
          'failed gate would present unverified work as reviewable (DWD-06 s.3.10).',
        failureClass: 'grounding',
        retryable: false,
        context: { failing_gates: failing, graph_id: input.graph_id },
      });
    }

    const bundleId = input.bundle_id ?? newId('evidenceBundle');
    const bundle: EvidenceBundle = {
      ...input,
      schema_version: '1.0.0',
      bundle_id: bundleId,
      platform_version: this.#platformVersion,
      assembled_at: now(),
      worm_ref: `worm://eb/${bundleId}/${input.bundle_version}`,
    };

    assertContract('EvidenceBundle', bundle);

    const write = async (s: TenantScope): Promise<void> => {
      await s.sql`
        INSERT INTO evidence_bundles (
          tenant_id, bundle_id, bundle_version, graph_id, output_class,
          proposed_output, trace, citations, records, policy_verdicts,
          confidence_by_step, lowest_confidence_step, assurance, cost_to_date,
          pack_version, platform_version, assembled_at, worm_ref, content_hash
        ) VALUES (
          ${bundle.tenant_id}, ${bundle.bundle_id}, ${bundle.bundle_version},
          ${bundle.graph_id}, ${bundle.output_class},
          ${s.sql.json(bundle.proposed_output)},
          ${s.sql.json(bundle.trace as never)},
          ${s.sql.json(bundle.citations)},
          ${s.sql.json(bundle.records as never)},
          ${bundle.policy_verdicts},
          ${s.sql.json(bundle.confidence_by_step)},
          ${bundle.lowest_confidence_step},
          ${s.sql.json(bundle.assurance)},
          ${s.sql.json(bundle.cost_to_date as never)},
          ${bundle.pack_version}, ${bundle.platform_version},
          ${bundle.assembled_at}::timestamptz, ${bundle.worm_ref},
          ${hashObject(bundle)}
        )
      `;
    };

    if (scope) await write(scope);
    else
      await withTenant(
        this.#db,
        { tenantId: bundle.tenant_id, residencyZone: this.#residencyZone },
        write,
      );

    return bundle;
  }

  async getBundle(
    tenantId: string,
    bundleId: string,
    version?: number,
  ): Promise<EvidenceBundle | null> {
    return withTenant(
      this.#db,
      { tenantId, residencyZone: this.#residencyZone, readOnly: true },
      async (scope) => {
        const rows = await scope.sql<BundleRow[]>`
          SELECT * FROM evidence_bundles
           WHERE tenant_id = ${tenantId} AND bundle_id = ${bundleId}
             ${version === undefined ? scope.sql`` : scope.sql`AND bundle_version = ${version}`}
           ORDER BY bundle_version DESC
           LIMIT 1
        `;
        const row = rows[0];
        return row ? toBundle(row) : null;
      },
    );
  }

  /** The current version. A reviewer acting on an older one is rejected (s.5.4). */
  async currentBundleVersion(tenantId: string, bundleId: string): Promise<number | null> {
    return withTenant(
      this.#db,
      { tenantId, residencyZone: this.#residencyZone, readOnly: true },
      async (scope) => {
        const rows = await scope.sql<{ bundle_version: number }[]>`
          SELECT max(bundle_version) AS bundle_version FROM evidence_bundles
           WHERE tenant_id = ${tenantId} AND bundle_id = ${bundleId}
        `;
        return rows[0]?.bundle_version ?? null;
      },
    );
  }

  /**
   * Write a decision record.
   *
   * `may_issue` is only reachable when the output class is one the worker may
   * issue unattended at the granted autonomy and no immutable rule engages
   * (s.3.13). That determination belongs to the authorisation component; this
   * method records the outcome and refuses the shape that contradicts it.
   */
  async recordDecision(
    input: Omit<DecisionRecord, 'decision_id' | 'timestamp' | 'worm_ref' | 'schema_version'> & {
      readonly decision_id?: string;
    },
    scope?: TenantScope,
  ): Promise<DecisionRecord> {
    if (input.authorisation_verdict === 'requires_human' && input.reviewer_action_id === null) {
      throw new WorkerError('unprocessable_content', {
        detail:
          'A decision record with verdict "requires_human" must name the reviewer action ' +
          'that produced it. Accountability rests with a named human and cannot be ' +
          'delegated to the worker (immutable rule 11).',
        failureClass: 'policy',
        retryable: false,
      });
    }

    const decisionId = input.decision_id ?? newId('decisionRecord');
    const record: DecisionRecord = {
      ...input,
      schema_version: '1.0.0',
      decision_id: decisionId,
      platform_version: this.#platformVersion,
      timestamp: now(),
      worm_ref: `worm://dr/${decisionId}`,
    };

    assertContract('DecisionRecord', record);

    const write = async (s: TenantScope): Promise<void> => {
      await s.sql`
        INSERT INTO decision_records (
          tenant_id, decision_id, graph_id, output_class, authorisation_verdict,
          named_owner, evidence_bundle_ref, pack_version, platform_version,
          skill_versions, reviewer_action_id, reserved_act_ref, decided_at, worm_ref
        ) VALUES (
          ${record.tenant_id}, ${record.decision_id}, ${record.graph_id},
          ${record.output_class}, ${record.authorisation_verdict},
          ${s.sql.json(record.named_owner)},
          ${record.evidence_bundle_ref}, ${record.pack_version}, ${record.platform_version},
          ${s.sql.json(record.skill_versions)},
          ${record.reviewer_action_id}, ${record.reserved_act_ref},
          ${record.timestamp}::timestamptz, ${record.worm_ref}
        )
      `;
    };

    if (scope) await write(scope);
    else
      await withTenant(
        this.#db,
        { tenantId: record.tenant_id, residencyZone: this.#residencyZone },
        write,
      );

    return record;
  }

  async getDecision(tenantId: string, decisionId: string): Promise<DecisionRecord | null> {
    return withTenant(
      this.#db,
      { tenantId, residencyZone: this.#residencyZone, readOnly: true },
      async (scope) => {
        const rows = await scope.sql<DecisionRow[]>`
          SELECT * FROM decision_records
           WHERE tenant_id = ${tenantId} AND decision_id = ${decisionId}
        `;
        const row = rows[0];
        return row ? toDecision(row) : null;
      },
    );
  }

  async listDecisions(
    tenantId: string,
    filter: {
      readonly output_class?: OutputClass;
      readonly owner_principal_id?: string;
      readonly from?: string;
      readonly to?: string;
      readonly limit?: number;
    } = {},
  ): Promise<DecisionRecord[]> {
    return withTenant(
      this.#db,
      { tenantId, residencyZone: this.#residencyZone, readOnly: true },
      async (scope) => {
        const rows = await scope.sql<DecisionRow[]>`
          SELECT * FROM decision_records
           WHERE tenant_id = ${tenantId}
             ${filter.output_class ? scope.sql`AND output_class = ${filter.output_class}` : scope.sql``}
             ${
               filter.owner_principal_id
                 ? scope.sql`AND named_owner ->> 'principal_id' = ${filter.owner_principal_id}`
                 : scope.sql``
             }
             ${filter.from ? scope.sql`AND decided_at >= ${filter.from}::timestamptz` : scope.sql``}
             ${filter.to ? scope.sql`AND decided_at <= ${filter.to}::timestamptz` : scope.sql``}
           ORDER BY decided_at DESC
           LIMIT ${Math.min(filter.limit ?? 100, 500)}
        `;
        return rows.map(toDecision);
      },
    );
  }
}

interface BundleRow {
  tenant_id: string;
  bundle_id: string;
  bundle_version: number;
  graph_id: string;
  output_class: string;
  proposed_output: EvidenceBundle['proposed_output'];
  trace: EvidenceBundle['trace'];
  citations: EvidenceBundle['citations'];
  records: EvidenceBundle['records'];
  policy_verdicts: string[];
  confidence_by_step: EvidenceBundle['confidence_by_step'];
  lowest_confidence_step: string | null;
  assurance: EvidenceBundle['assurance'];
  cost_to_date: EvidenceBundle['cost_to_date'];
  pack_version: string;
  platform_version: string;
  assembled_at: string;
  worm_ref: string;
  schema_version: string;
}

function toBundle(row: BundleRow): EvidenceBundle {
  return {
    schema_version: row.schema_version,
    bundle_id: row.bundle_id,
    tenant_id: row.tenant_id,
    graph_id: row.graph_id,
    output_class: row.output_class as OutputClass,
    bundle_version: row.bundle_version,
    proposed_output: row.proposed_output,
    trace: row.trace,
    citations: row.citations,
    records: row.records,
    policy_verdicts: row.policy_verdicts,
    confidence_by_step: row.confidence_by_step,
    lowest_confidence_step: row.lowest_confidence_step,
    assurance: row.assurance,
    cost_to_date: row.cost_to_date,
    pack_version: row.pack_version,
    platform_version: row.platform_version,
    assembled_at: row.assembled_at,
    worm_ref: row.worm_ref,
  };
}

interface DecisionRow {
  tenant_id: string;
  decision_id: string;
  graph_id: string;
  output_class: string;
  authorisation_verdict: string;
  named_owner: DecisionRecord['named_owner'];
  evidence_bundle_ref: string;
  pack_version: string;
  platform_version: string;
  skill_versions: DecisionRecord['skill_versions'];
  reviewer_action_id: string | null;
  reserved_act_ref: string | null;
  decided_at: string;
  worm_ref: string;
  schema_version: string;
}

function toDecision(row: DecisionRow): DecisionRecord {
  return {
    schema_version: row.schema_version,
    decision_id: row.decision_id,
    tenant_id: row.tenant_id,
    output_class: row.output_class as OutputClass,
    authorisation_verdict: row.authorisation_verdict as DecisionRecord['authorisation_verdict'],
    named_owner: row.named_owner,
    evidence_bundle_ref: row.evidence_bundle_ref,
    pack_version: row.pack_version,
    platform_version: row.platform_version,
    skill_versions: row.skill_versions,
    reviewer_action_id: row.reviewer_action_id,
    reserved_act_ref: row.reserved_act_ref,
    graph_id: row.graph_id,
    timestamp: row.decided_at,
    worm_ref: row.worm_ref,
  };
}

/** Content hash of a bundle, for the reviewer action's `approved_output_hash`. */
export const bundleContentHash = (bundle: EvidenceBundle): PrefixedHash => hashObject(bundle);
