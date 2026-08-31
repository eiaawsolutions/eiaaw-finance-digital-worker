/**
 * C15 acceptance — Phase 0 criteria P0-1, P0-2 and P0-3.
 *
 *   P0-1  "Every event type in the taxonomy is emittable and a synthetic
 *          end-to-end run produces the expected set."
 *   P0-2  "The chain verifies, seals, and an induced tamper is detected."
 *   P0-3  the log has two destinations, one outside the worker's write control
 *          — proven here as the anchor, which is the mechanism.
 *
 * P0-1 is the interesting one. It is easy to specify an event taxonomy and
 * discover a year later that a third of it was never wired. The test below
 * emits every single type.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import { AUDIT_EVENT_TYPES, COMPONENTS } from '@eiaaw/contracts';
import { newId, newTraceId, tenantId as makeTenantId } from '@eiaaw/core';
import {
  closeDatabase,
  createDatabase,
  withPlatformScope,
  withTenant,
  type Database,
} from '@eiaaw/db';
import { AuditStore, COMPONENT_BINDINGS, emitterFor } from '../src/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const ZONE = 'my-central';
const TENANT = makeTenantId('audit-itest');

let db: Database;
let store: AuditStore;

describeIfDb('C15 audit store', () => {
  beforeAll(async () => {
    db = createDatabase({ url: DATABASE_URL as string, poolMax: 4, ssl: false });
    store = new AuditStore({ db, residencyZone: ZONE });

    await withPlatformScope(db, async (sql) => {
      await sql`
        INSERT INTO tenants (tenant_id, display_name, residency_zone, status)
        VALUES (${TENANT}, 'Audit Itest', ${ZONE}, 'active')
        ON CONFLICT (tenant_id) DO NOTHING
      `;
    });
  });

  afterAll(async () => {
    if (db) await closeDatabase(db);
  });

  // -------------------------------------------------------------------------
  // P0-1 — every event type is emittable
  // -------------------------------------------------------------------------
  describe('P0-1 the full event taxonomy is emittable', () => {
    it('emits every type in the taxonomy and reads them all back', async () => {
      const traceId = newTraceId();
      const emitter = emitterFor(store, 'C15');

      for (const eventType of AUDIT_EVENT_TYPES) {
        await emitter.emit(
          { tenant_id: TENANT, trace_id: traceId },
          {
            event_type: eventType,
            outcome: 'success',
            subject: { kind: 'synthetic', id: eventType },
            payload: { synthetic: true, event_type: eventType },
          },
        );
      }

      const { events } = await store.query(TENANT, { trace_id: traceId, limit: 1000 });
      const emitted = new Set(events.map((e) => e.event_type));

      // The set produced must be exactly the set specified — no gaps, and
      // nothing invented along the way.
      expect(emitted.size).toBe(AUDIT_EVENT_TYPES.length);
      for (const eventType of AUDIT_EVENT_TYPES) {
        expect(emitted, `${eventType} was never emitted`).toContain(eventType);
      }
    });

    it('binds every component to exactly one layer', () => {
      for (const component of COMPONENTS) {
        expect(COMPONENT_BINDINGS[component]).toBeDefined();
      }
      expect(Object.keys(COMPONENT_BINDINGS)).toHaveLength(COMPONENTS.length);
    });

    it('stamps the emitting component, so an audit query by component is truthful', async () => {
      const traceId = newTraceId();
      await emitterFor(store, 'C10').emit(
        { tenant_id: TENANT, trace_id: traceId },
        {
          event_type: 'tool_call_completed',
          outcome: 'success',
          subject: { kind: 'tool_call', id: newId('toolCall') },
        },
      );

      const { events } = await store.query(TENANT, { trace_id: traceId });
      expect(events[0]?.component).toBe('C10');
      expect(events[0]?.layer).toBe('L6');
    });

    it('refuses an event type outside the closed taxonomy', async () => {
      const emitter = emitterFor(store, 'C15');
      await expect(
        emitter.emit(
          { tenant_id: TENANT },
          {
            // Deliberately outside the enumeration.
            event_type: 'something.invented' as never,
            outcome: 'success',
            subject: { kind: 'x', id: 'y' },
          },
        ),
      ).rejects.toThrow(/not in the audit event taxonomy|closed/);
    });
  });

  // -------------------------------------------------------------------------
  // P0-2 — chain verification and tamper detection
  // -------------------------------------------------------------------------
  describe('P0-2 chain verification', () => {
    it('verifies the whole chain for a tenant', async () => {
      const result = await store.verifySegment(TENANT);
      expect(result.ok).toBe(true);
      expect(result.verified).toBeGreaterThan(AUDIT_EVENT_TYPES.length);
    });

    it('verifies a mid-chain segment without starting from genesis', async () => {
      const result = await store.verifySegment(TENANT, { from: 5, to: 15 });
      expect(result.ok).toBe(true);
      expect(result.verified).toBe(11);
    });

    it('detects a tamper applied out of band', async () => {
      // Simulate an attacker with direct database access who has defeated the
      // triggers — the chain is the last line, and it must still notice.
      const before = await store.verifySegment(TENANT);
      expect(before.ok).toBe(true);

      await withPlatformScope(db, async (sql) => {
        await sql.unsafe('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
        await sql`
          UPDATE audit_events SET outcome = 'failure'
           WHERE tenant_id = ${TENANT} AND sequence_number = 3
        `;
        await sql.unsafe('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
      });

      const after = await store.verifySegment(TENANT);
      expect(after.ok).toBe(false);
      expect(after.brokenAt?.reason).toMatch(/event_hash mismatch|altered/);

      // Restore so later assertions are not confused by the induced damage.
      await withPlatformScope(db, async (sql) => {
        await sql.unsafe('ALTER TABLE audit_events DISABLE TRIGGER audit_events_no_update');
        await sql`
          UPDATE audit_events SET outcome = 'success'
           WHERE tenant_id = ${TENANT} AND sequence_number = 3
        `;
        await sql.unsafe('ALTER TABLE audit_events ENABLE TRIGGER audit_events_no_update');
      });

      expect((await store.verifySegment(TENANT)).ok).toBe(true);
    });

    it('records a verification result as durable evidence', async () => {
      const result = await store.verifySegment(TENANT);
      const verificationId = newId('auditEvent');
      await store.recordVerification(TENANT, result, verificationId);

      const rows = await withTenant(
        db,
        { tenantId: TENANT, residencyZone: ZONE },
        async (scope) =>
          scope.sql<{ ok: boolean; events_verified: string }[]>`
            SELECT ok, events_verified FROM audit_chain_verifications
             WHERE tenant_id = ${TENANT} AND verification_id = ${verificationId}
          `,
      );
      expect(rows[0]?.ok).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // P0-3 — sealing / second destination
  // -------------------------------------------------------------------------
  describe('P0-3 anchoring', () => {
    it('seals the chain with a signed anchor', async () => {
      const anchorId = newId('auditEvent');
      const anchor = await store.anchor(TENANT, anchorId, (payload) =>
        createHmac('sha256', 'test-anchor-key').update(payload).digest('hex'),
      );

      expect(anchor).not.toBeNull();
      expect(anchor?.head_sequence).toBeGreaterThan(0);

      const rows = await withTenant(
        db,
        { tenantId: TENANT, residencyZone: ZONE },
        async (scope) =>
          scope.sql<{ signature: string; head_sequence: string }[]>`
            SELECT signature, head_sequence FROM audit_chain_anchors
             WHERE tenant_id = ${TENANT} AND anchor_id = ${anchorId}
          `,
      );
      expect(rows[0]?.signature).toMatch(/^[0-9a-f]{64}$/);
    });

    it('refuses to delete an anchor', async () => {
      await expect(
        withPlatformScope(db, async (sql) => {
          await sql`DELETE FROM audit_chain_anchors WHERE tenant_id = ${TENANT}`;
        }),
      ).rejects.toThrow(/append-only/);
    });
  });

  // -------------------------------------------------------------------------
  // Concurrency — the chain cannot fork
  // -------------------------------------------------------------------------
  describe('concurrent appends', () => {
    it('produces a single total chain under parallel writers', async () => {
      const emitter = emitterFor(store, 'C7');
      const traceId = newTraceId();

      await Promise.all(
        Array.from({ length: 20 }, (_unused, index) =>
          emitter.emit(
            { tenant_id: TENANT, trace_id: traceId },
            {
              event_type: 'node.completed',
              outcome: 'success',
              subject: { kind: 'node', id: `n${index}` },
              payload: { index },
            },
          ),
        ),
      );

      const rows = await withTenant(
        db,
        { tenantId: TENANT, residencyZone: ZONE },
        async (scope) =>
          scope.sql<{ sequence_number: string }[]>`
            SELECT sequence_number FROM audit_events
             WHERE tenant_id = ${TENANT} ORDER BY sequence_number
          `,
      );

      // Contiguous with no gaps and no duplicates: a fork would show as a
      // repeated prev_event_hash, which verifyChain would then reject.
      const sequences = rows.map((r) => Number(r.sequence_number));
      expect(sequences).toEqual(Array.from({ length: sequences.length }, (_u, i) => i + 1));
      expect((await store.verifySegment(TENANT)).ok).toBe(true);
    });
  });
});
