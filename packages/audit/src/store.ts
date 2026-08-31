/**
 * C15 — Audit and Evidence Store. The first of the two undeferrable components.
 *
 *   s.1.3 D6: "C15 is write-only from every component and read-only from the
 *              audit query API."
 *   s.3.14:   "The audit log is one of the two undeferrable components. A write
 *              failure to the WORM store FAILS THE OPERATION THAT PRODUCED IT;
 *              it never proceeds unlogged."
 *
 * That second rule is the one with teeth, and it inverts the usual instinct.
 * Logging is normally best-effort: you swallow the error so the request still
 * succeeds. Here, an unloggable action is an action that must not happen, so
 * `append` throws and the caller's transaction unwinds.
 */
import {
  CHAIN_GENESIS,
  type PrefixedHash,
  WorkerError,
  chainEventHash,
  hashObject,
  now,
  toTimestamp,
  verifyChain,
  type ChainLink,
  type ChainVerification,
} from '@eiaaw/core';
import type { AuditEvent, AuditEventType, UnsealedAuditEvent } from '@eiaaw/contracts';
import { AUDIT_EVENT_TYPES } from '@eiaaw/contracts';
import { type Database, type TenantScope, isSerializationFailure, withTenant } from '@eiaaw/db';
import { recordAuditChainFailure } from '@eiaaw/telemetry';

export interface AppendResult {
  readonly event_id: string;
  readonly sequence_number: number;
  readonly prev_event_hash: PrefixedHash;
  readonly event_hash: PrefixedHash;
}

export class AuditWriteError extends WorkerError {
  constructor(detail: string, cause?: unknown) {
    super('dependency_unavailable', {
      detail:
        `${detail} The operation that produced this event must NOT proceed: ` +
        'nothing runs unlogged (DWD-06 s.3.14).',
      failureClass: 'internal',
      // Retryable at the caller's discretion, but never ignorable.
      retryable: true,
      cause,
    });
    this.name = 'AuditWriteError';
  }
}

/** Payload bodies large enough to belong in the object store rather than inline. */
const INLINE_PAYLOAD_LIMIT_BYTES = 8_192;

export interface PayloadSink {
  put(tenantId: string, key: string, body: string): Promise<string>;
}

export interface AuditStoreOptions {
  readonly db: Database;
  readonly residencyZone: string;
  /** When absent, oversized payloads are truncated to their hash alone. */
  readonly payloadSink?: PayloadSink;
  readonly maxAppendAttempts?: number;
}

export class AuditStore {
  readonly #db: Database;
  readonly #residencyZone: string;
  readonly #payloadSink: PayloadSink | undefined;
  readonly #maxAttempts: number;

  constructor(options: AuditStoreOptions) {
    this.#db = options.db;
    this.#residencyZone = options.residencyZone;
    this.#payloadSink = options.payloadSink;
    this.#maxAttempts = options.maxAppendAttempts ?? 5;
  }

  /**
   * Append one event, computing its chain position atomically.
   *
   * The chain arithmetic happens inside `append_audit_event`, which locks the
   * tenant's tip row. Two concurrent appenders serialise there rather than
   * forking. When the tip moves between our read and the insert the function
   * raises a serialisation failure, and we recompute rather than retry blindly
   * — retrying with a stale `prev_event_hash` would just fail again.
   */
  async append(
    event: UnsealedAuditEvent,
    payload: Record<string, unknown> = {},
    scope?: TenantScope,
  ): Promise<AppendResult> {
    this.#assertKnownEventType(event.event_type);

    const payloadJson = JSON.stringify(payload);
    const payloadHash = hashObject(payload);
    const payloadRef = await this.#storePayloadIfLarge(
      event.tenant_id,
      event.event_id,
      payloadJson,
    );

    const run = async (tenantScope: TenantScope): Promise<AppendResult> =>
      this.#appendInScope(tenantScope, event, payloadHash, payloadRef);

    try {
      if (scope) return await run(scope);
      return await this.#withRetry(() =>
        withTenant(
          this.#db,
          { tenantId: event.tenant_id, residencyZone: this.#residencyZone },
          run,
        ),
      );
    } catch (error) {
      throw new AuditWriteError(
        `Failed to append audit event "${event.event_type}" for tenant ${event.tenant_id}.`,
        error,
      );
    }
  }

  async #appendInScope(
    scope: TenantScope,
    event: UnsealedAuditEvent,
    payloadHash: PrefixedHash,
    payloadRef: string | null,
  ): Promise<AppendResult> {
    const tip = await this.#lockAndReadTip(scope);

    // Normalised before hashing, and stored in the same normalised form.
    //
    // Postgres renders a timestamptz as `2026-08-30 14:43:04.449+00`, not the
    // RFC 3339 `2026-08-30T14:43:04.449+00:00` the application produced. If the
    // hash were computed over one form and re-verified over the other, every
    // chain would appear broken. Round-tripping through `toTimestamp` here and
    // in `chainBodyOf` means both sides canonicalise identically.
    const occurredAt = toTimestamp(event.occurred_at);

    // The hash covers the fields that identify the event, not the whole row:
    // `recorded_at` and `sequence_number` are assigned by the database, and
    // including them would make the caller's hash unreproducible.
    const body = {
      event_id: event.event_id,
      tenant_id: event.tenant_id,
      trace_id: event.trace_id,
      span_id: event.span_id,
      occurred_at: occurredAt,
      layer: event.layer,
      component: event.component,
      event_type: event.event_type,
      actor: event.actor,
      subject: event.subject,
      context_ref: event.context_ref,
      graph_id: event.graph_id,
      outcome: event.outcome,
      payload_hash: payloadHash,
    };
    const eventHash = chainEventHash(tip, body);

    const rows = await scope.sql<
      { sequence_number: string; prev_event_hash: string; event_hash: string }[]
    >`
      SELECT * FROM append_audit_event(
        ${event.tenant_id}, ${event.event_id}, ${event.trace_id}, ${event.span_id},
        ${occurredAt}::timestamptz,
        ${event.layer}, ${event.component}, ${event.event_type},
        ${scope.sql.json(event.actor)},
        ${scope.sql.json(event.subject)},
        ${event.context_ref}, ${event.graph_id}, ${event.outcome},
        ${payloadHash}, ${payloadRef},
        ${tip}, ${eventHash}
      )
    `;

    const row = rows[0];
    if (!row) throw new Error('append_audit_event returned no row');

    return {
      event_id: event.event_id,
      sequence_number: Number(row.sequence_number),
      prev_event_hash: row.prev_event_hash,
      event_hash: row.event_hash,
    };
  }

  /**
   * Read the tip **while holding its row lock**.
   *
   * The lock has to be taken before the hash is computed, not after. The event
   * hash chains from `prev_event_hash`, so a tip read outside the lock is stale
   * the moment another writer commits — and under any real concurrency that is
   * almost every read. Taking `FOR UPDATE` here means the tip cannot move
   * between this read and the insert, so writers queue on the lock instead of
   * racing and retrying.
   *
   * The `expected_prev_hash` check inside `append_audit_event` therefore never
   * fires in normal operation. It is kept as a guard against a future caller
   * that computes a hash without holding the lock.
   */
  async #lockAndReadTip(scope: TenantScope): Promise<PrefixedHash> {
    // Create the tip on first write. Separate from the SELECT because
    // `INSERT ... ON CONFLICT DO NOTHING` does not return the existing row.
    await scope.sql`
      INSERT INTO audit_chain_tips (tenant_id, head_event_hash, head_sequence)
      VALUES (${scope.tenantId}, ${'0'.repeat(64)}, 0)
      ON CONFLICT (tenant_id) DO NOTHING
    `;

    const rows = await scope.sql<{ head_event_hash: string }[]>`
      SELECT head_event_hash FROM audit_chain_tips
       WHERE tenant_id = ${scope.tenantId}
         FOR UPDATE
    `;

    const head = rows[0]?.head_event_hash;
    if (head === undefined) return CHAIN_GENESIS;
    return head.startsWith('sha256:') ? head : `sha256:${head}`;
  }

  async #withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        const contention =
          isSerializationFailure(error) ||
          (error instanceof Error && /chain tip moved/.test(error.message));
        if (!contention) throw error;
        // Jittered backoff: two writers racing on the tip should not
        // synchronise their retries.
        await new Promise((resolve) => setTimeout(resolve, 10 * attempt + Math.random() * 20));
      }
    }
    throw lastError;
  }

  async #storePayloadIfLarge(
    tenantId: string,
    eventId: string,
    payloadJson: string,
  ): Promise<string | null> {
    if (payloadJson.length <= INLINE_PAYLOAD_LIMIT_BYTES) return null;
    if (!this.#payloadSink) return null;
    return this.#payloadSink.put(tenantId, `audit/payloads/${eventId}.json`, payloadJson);
  }

  #assertKnownEventType(eventType: string): void {
    if (!(AUDIT_EVENT_TYPES as readonly string[]).includes(eventType)) {
      // s.3.14: the enumeration is closed. An unknown type would pass the
      // database CHECK-free column but break every audit query that filters by
      // type, so it is refused here.
      throw new WorkerError('contract_invalid', {
        detail:
          `"${eventType}" is not in the audit event taxonomy. The enumeration is ` +
          'closed; adding a type is a MINOR contract change (DWD-06 s.3.14).',
        failureClass: 'contract',
        retryable: false,
      });
    }
  }

  // -------------------------------------------------------------------------
  // Read side — read-only, and only through here (D6)
  // -------------------------------------------------------------------------

  async query(
    tenantId: string,
    filter: {
      readonly trace_id?: string;
      readonly graph_id?: string;
      readonly event_type?: AuditEventType;
      readonly layer?: string;
      readonly from?: string;
      readonly to?: string;
      readonly limit?: number;
      readonly cursor?: number;
    },
  ): Promise<{ readonly events: AuditEvent[]; readonly nextCursor: number | null }> {
    const limit = Math.min(filter.limit ?? 100, 1000);

    return withTenant(
      this.#db,
      { tenantId, residencyZone: this.#residencyZone, readOnly: true },
      async (scope) => {
        const rows = await scope.sql<AuditEventRow[]>`
          SELECT * FROM audit_events
           WHERE tenant_id = ${tenantId}
             ${filter.trace_id ? scope.sql`AND trace_id = ${filter.trace_id}` : scope.sql``}
             ${filter.graph_id ? scope.sql`AND graph_id = ${filter.graph_id}` : scope.sql``}
             ${filter.event_type ? scope.sql`AND event_type = ${filter.event_type}` : scope.sql``}
             ${filter.layer ? scope.sql`AND layer = ${filter.layer}` : scope.sql``}
             ${filter.from ? scope.sql`AND occurred_at >= ${filter.from}::timestamptz` : scope.sql``}
             ${filter.to ? scope.sql`AND occurred_at <= ${filter.to}::timestamptz` : scope.sql``}
             ${filter.cursor ? scope.sql`AND sequence_number > ${filter.cursor}` : scope.sql``}
           ORDER BY sequence_number
           LIMIT ${limit + 1}
        `;

        const page = rows.slice(0, limit);
        const nextCursor =
          rows.length > limit ? Number(page[page.length - 1]?.sequence_number ?? 0) : null;

        return { events: page.map(toAuditEvent), nextCursor };
      },
    );
  }

  /**
   * Walk the chain and recompute every link — s.10.5.
   *
   * Phase 0 acceptance P0-2 requires an induced tamper to be detected. A break
   * increments `audit_chain_verification_failures_total`, which is an incident
   * at any value above zero.
   */
  async verifySegment(
    tenantId: string,
    range: { readonly from?: number; readonly to?: number } = {},
  ): Promise<ChainVerification & { readonly from: number; readonly to: number }> {
    return withTenant(
      this.#db,
      { tenantId, residencyZone: this.#residencyZone, readOnly: true },
      async (scope) => {
        const from = range.from ?? 1;
        const rows = await scope.sql<AuditEventRow[]>`
          SELECT * FROM audit_events
           WHERE tenant_id = ${tenantId}
             AND sequence_number >= ${from}
             ${range.to ? scope.sql`AND sequence_number <= ${range.to}` : scope.sql``}
           ORDER BY sequence_number
        `;

        const links: ChainLink[] = rows.map((row) => ({
          event_id: row.event_id,
          prev_event_hash: row.prev_event_hash,
          event_hash: row.event_hash,
          payload: chainBodyOf(row),
        }));

        // Verifying a mid-chain segment starts from the predecessor's hash,
        // not from genesis.
        const expectedStart =
          from === 1 ? CHAIN_GENESIS : (links[0]?.prev_event_hash ?? CHAIN_GENESIS);

        const result = verifyChain(links, expectedStart);
        if (!result.ok) recordAuditChainFailure(tenantId);

        const to = Number(rows[rows.length - 1]?.sequence_number ?? from);
        return { ...result, from, to };
      },
    );
  }

  /** Record a verification outcome so a break is durable evidence, not a log line. */
  async recordVerification(
    tenantId: string,
    verification: ChainVerification & { readonly from: number; readonly to: number },
    verificationId: string,
  ): Promise<void> {
    await withTenant(this.#db, { tenantId, residencyZone: this.#residencyZone }, async (scope) => {
      await scope.sql`
          INSERT INTO audit_chain_verifications (
            tenant_id, verification_id, from_sequence, to_sequence,
            events_verified, ok, broken_at_sequence, broken_event_id, failure_reason
          ) VALUES (
            ${tenantId}, ${verificationId}, ${verification.from}, ${verification.to},
            ${verification.verified}, ${verification.ok},
            ${verification.brokenAt ? verification.from + verification.brokenAt.index : null},
            ${verification.brokenAt?.event_id ?? null},
            ${verification.brokenAt?.reason ?? null}
          )
        `;
    });
  }

  /**
   * Seal the chain with a signed anchor — s.10.5 "periodic anchoring".
   *
   * An attacker who could rewrite history would still have to forge every
   * anchor signed before the change.
   */
  async anchor(
    tenantId: string,
    anchorId: string,
    sign: (payload: string) => string,
    keyEpoch = 1,
  ): Promise<{ readonly head_sequence: number; readonly head_event_hash: string } | null> {
    return withTenant(this.#db, { tenantId, residencyZone: this.#residencyZone }, async (scope) => {
      const rows = await scope.sql<{ head_event_hash: string; head_sequence: string }[]>`
          SELECT head_event_hash, head_sequence FROM audit_chain_tips
           WHERE tenant_id = ${tenantId}
        `;
      const tip = rows[0];
      if (!tip || Number(tip.head_sequence) === 0) return null;

      const anchoredAt = now();
      const signature = sign(
        `${tenantId}|${tip.head_sequence}|${tip.head_event_hash}|${anchoredAt}`,
      );

      await scope.sql`
          INSERT INTO audit_chain_anchors (
            tenant_id, anchor_id, anchored_at, head_sequence, head_event_hash, signature, key_epoch
          ) VALUES (
            ${tenantId}, ${anchorId}, ${anchoredAt}::timestamptz,
            ${Number(tip.head_sequence)}, ${tip.head_event_hash}, ${signature}, ${keyEpoch}
          )
        `;

      return {
        head_sequence: Number(tip.head_sequence),
        head_event_hash: tip.head_event_hash,
      };
    });
  }
}

interface AuditEventRow {
  tenant_id: string;
  event_id: string;
  trace_id: string;
  span_id: string;
  occurred_at: string;
  recorded_at: string;
  layer: string;
  component: string;
  event_type: string;
  actor: Record<string, unknown>;
  subject: Record<string, unknown>;
  context_ref: string | null;
  graph_id: string | null;
  outcome: string;
  payload_hash: string;
  payload_ref: string | null;
  sequence_number: string;
  prev_event_hash: string;
  event_hash: string;
  schema_version: string;
}

/**
 * Exactly the fields that went into the hash. Key order is irrelevant — the
 * canonicaliser sorts — but the *values* must be byte-identical to what was
 * hashed, which is why `occurred_at` is renormalised here.
 */
function chainBodyOf(row: AuditEventRow): Record<string, unknown> {
  return {
    event_id: row.event_id,
    tenant_id: row.tenant_id,
    trace_id: row.trace_id,
    span_id: row.span_id,
    occurred_at: toTimestamp(row.occurred_at),
    layer: row.layer,
    component: row.component,
    event_type: row.event_type,
    actor: row.actor,
    subject: row.subject,
    context_ref: row.context_ref,
    graph_id: row.graph_id,
    outcome: row.outcome,
    payload_hash: row.payload_hash,
  };
}

function toAuditEvent(row: AuditEventRow): AuditEvent {
  return {
    schema_version: row.schema_version,
    event_id: row.event_id,
    tenant_id: row.tenant_id,
    trace_id: row.trace_id,
    span_id: row.span_id,
    occurred_at: row.occurred_at,
    recorded_at: row.recorded_at,
    layer: row.layer as AuditEvent['layer'],
    component: row.component as AuditEvent['component'],
    event_type: row.event_type as AuditEventType,
    actor: row.actor as AuditEvent['actor'],
    subject: row.subject as AuditEvent['subject'],
    context_ref: row.context_ref,
    graph_id: row.graph_id,
    outcome: row.outcome as AuditEvent['outcome'],
    payload_hash: row.payload_hash,
    payload_ref: row.payload_ref,
    prev_event_hash: row.prev_event_hash,
    event_hash: row.event_hash,
  };
}
