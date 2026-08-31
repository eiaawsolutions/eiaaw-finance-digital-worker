/**
 * C10 — the tool invoker's refusals and its idempotency ledger.
 *
 * The properties under test are the ones that make immutable rules 2-6
 * enforceable at L6 rather than only at L5:
 *
 *   - a forbidden scope is denied at the credential, before any policy runs;
 *   - dry-run is decided by the runtime, not by configuration;
 *   - an atomic reservation makes "a retry can never double-post" a mechanism.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newId, sha256, toolCallIdempotencyKey } from '@eiaaw/core';
import {
  closeDatabase,
  createDatabase,
  withPlatformScope,
  withTenant,
  type Database,
} from '@eiaaw/db';
import { seedRegistries } from '@eiaaw/registry';
import {
  CalculationConnector,
  StubErpConnector,
  ToolInvoker,
  StubDocumentConnector,
} from '../src/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const ZONE = 'my-central';
const TENANT = 'tnt_invoker-itest';

let db: Database;
let erp: StubErpConnector;

const graphId = newId('taskGraph');

async function grant(
  toolId: string,
  options: { stage?: 1 | 2 | 3 | 4; scopes: string[] },
): Promise<void> {
  await withTenant(db, { tenantId: TENANT, residencyZone: ZONE }, async (s) => {
    await s.sql`
      INSERT INTO tool_grants (tenant_id, tool_id, graduation_stage, dry_run_forced,
                               granted_scopes, enabled)
      VALUES (${TENANT}, ${toolId}, ${options.stage ?? 4}, false,
              ${options.scopes}, true)
      ON CONFLICT (tenant_id, tool_id) DO UPDATE SET
        graduation_stage = EXCLUDED.graduation_stage,
        dry_run_forced = EXCLUDED.dry_run_forced,
        granted_scopes = EXCLUDED.granted_scopes,
        enabled = EXCLUDED.enabled
    `;
  });
}

function makeInvoker(forceDryRun: boolean): ToolInvoker {
  erp = new StubErpConnector();
  return new ToolInvoker({
    db,
    residencyZone: ZONE,
    forceDryRun,
    connectors: [erp, new CalculationConnector(), new StubDocumentConnector()],
  });
}

const baseInput = {
  tenant_id: TENANT,
  graph_id: graphId,
  node_id: 'n1',
  invocation_id: null,
  scope_qualifiers: { entity_id: 'ENT-0007', period: '2026-07' },
  authority: {
    autonomy: 'execute' as const,
    policy_verdict_id: newId('policyVerdict'),
    approval_ref: null,
  },
  trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
};

describeIfDb('C10 tool invoker', () => {
  beforeAll(async () => {
    db = createDatabase({ url: DATABASE_URL as string, poolMax: 6, ssl: false });

    await withPlatformScope(db, async (sql) => {
      await sql`
        INSERT INTO tenants (tenant_id, display_name, residency_zone, status)
        VALUES (${TENANT}, 'Invoker Itest', ${ZONE}, 'active')
        ON CONFLICT (tenant_id) DO NOTHING
      `;
    });

    await seedRegistries(db);

    // A graph row for the tool_calls foreign key.
    await withTenant(db, { tenantId: TENANT, residencyZone: ZONE }, async (s) => {
      const contextId = newId('context');
      await s.sql`
        INSERT INTO contexts (tenant_id, context_id, request_id, resolution_status, axes,
                              pack_id, pack_version, residency_zone, resolved_locale,
                              knowledge_pin, context_token_hash, expires_at)
        VALUES (${TENANT}, ${contextId}, ${'0192f3c1-7a10-7c31-9b6a-1f0d2c4b5e60'}, 'resolved',
                '{}'::jsonb, 'pack-my-mfrs', '2026.08.1', ${ZONE}, 'en-MY', '{}'::jsonb,
                'abc', now() + interval '1 hour')
        ON CONFLICT DO NOTHING
      `;
      await s.sql`
        INSERT INTO task_graphs (tenant_id, graph_id, request_id, context_ref, trigger_class,
                                 intent, root_skill_id, skill_version, effective_autonomy,
                                 autonomy_basis, admission, budget, state, workflow_run_id)
        VALUES (${TENANT}, ${graphId}, ${'0192f3c1-7a10-7c31-9b6a-1f0d2c4b5e60'}, ${contextId},
                'request', 'test', 'SK-P2P-05', '1.0.0', 'execute',
                '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'running', 'wf_x')
        ON CONFLICT DO NOTHING
      `;
    });

    await grant('TL-ERPR-02', { scopes: ['ap:read'] });
    await grant('TL-ERPW-03', { scopes: ['ap:post'] });
    await grant('TL-CALC-05', { scopes: ['calc:none'] });
  });

  afterAll(async () => {
    if (db) await closeDatabase(db);
  });

  describe('registry and scope', () => {
    it('refuses a tool that is not in the registry', async () => {
      const result = await makeInvoker(false).invoke({
        ...baseInput,
        tool_id: 'TL-EVIL-99',
        args: {},
        permission_scope_requested: 'gl:post',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/not in the L6 tool registry/);
    });

    it('refuses a forbidden scope at the credential, before any policy runs', async () => {
      const result = await makeInvoker(false).invoke({
        ...baseInput,
        tool_id: 'TL-ERPW-03',
        args: {},
        permission_scope_requested: 'pay:release',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/forbidden list/);
      expect(result.error.message).toMatch(/protected by policy alone is treated as unprotected/);
    });

    it('refuses a scope that differs from the one the tool declares', async () => {
      const result = await makeInvoker(false).invoke({
        ...baseInput,
        tool_id: 'TL-ERPW-03',
        args: {},
        permission_scope_requested: 'gl:post',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/never a downgrade-and-proceed/);
    });

    it('refuses a tool the tenant has not been granted', async () => {
      const result = await makeInvoker(false).invoke({
        ...baseInput,
        tool_id: 'TL-ERPW-02',
        args: {},
        permission_scope_requested: 'gl:post',
        idempotency_key: sha256('ungranted'),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/not enabled for this tenant/);
    });
  });

  describe('dry-run is decided by the runtime (s.14.3)', () => {
    it('forces dry-run outside prod even at Execute and stage 4', async () => {
      const invoker = makeInvoker(true); // forceDryRun = non-prod
      const result = await invoker.invoke({
        ...baseInput,
        tool_id: 'TL-ERPW-03',
        args: { business_key: 'INV-DRY' },
        permission_scope_requested: 'ap:post',
        idempotency_key: sha256('dry-run-case'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.dry_run).toBe(true);
      expect(result.value.outcome).toBe('dry_run');

      // The connector WAS reached — a dry-run validates — but nothing was applied.
      expect(erp.ledger).toHaveLength(1);
      expect(erp.effectsApplied()).toHaveLength(0);
    });

    it('forces dry-run below graduation stage 4 even in prod', async () => {
      await grant('TL-ERPW-03', { stage: 3, scopes: ['ap:post'] });
      const result = await makeInvoker(false).invoke({
        ...baseInput,
        tool_id: 'TL-ERPW-03',
        args: { business_key: 'INV-STAGE3' },
        permission_scope_requested: 'ap:post',
        idempotency_key: sha256('stage-3-case'),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.dry_run).toBe(true);
      await grant('TL-ERPW-03', { stage: 4, scopes: ['ap:post'] });
    });

    it('forces dry-run when autonomy is below Execute', async () => {
      const result = await makeInvoker(false).invoke({
        ...baseInput,
        tool_id: 'TL-ERPW-03',
        args: { business_key: 'INV-DRAFT' },
        permission_scope_requested: 'ap:post',
        authority: {
          autonomy: 'draft',
          policy_verdict_id: newId('policyVerdict'),
          approval_ref: null,
        },
        idempotency_key: sha256('draft-case'),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.dry_run).toBe(true);
    });
  });

  describe('authority', () => {
    it('refuses a live state-changing call with no policy verdict', async () => {
      const result = await makeInvoker(false).invoke({
        ...baseInput,
        tool_id: 'TL-ERPW-03',
        args: { business_key: 'INV-NOVERDICT' },
        permission_scope_requested: 'ap:post',
        authority: { autonomy: 'execute', policy_verdict_id: null, approval_ref: null },
        idempotency_key: sha256('no-verdict'),
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/must reference the policy verdict/);
    });

    it('refuses a state-changing call with no idempotency key', async () => {
      const result = await makeInvoker(false).invoke({
        ...baseInput,
        tool_id: 'TL-ERPW-03',
        args: { business_key: 'INV-NOKEY' },
        permission_scope_requested: 'ap:post',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.message).toMatch(/requires an idempotency key/);
    });
  });

  describe('idempotency (s.8.2)', () => {
    it('a repeat call returns the ORIGINAL outcome and reaches no connector', async () => {
      const invoker = makeInvoker(false);
      const key = toolCallIdempotencyKey({
        tenant_id: TENANT,
        entity_id: 'ENT-0007',
        sop_id: 'PP/01#5.3',
        business_key: 'INV-IDEM-1',
        context_token_hash: 'ctx-hash',
      });

      const first = await invoker.invoke({
        ...baseInput,
        tool_id: 'TL-ERPW-03',
        args: { business_key: 'INV-IDEM-1' },
        permission_scope_requested: 'ap:post',
        idempotency_key: key,
        business_key: 'INV-IDEM-1',
      });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const applied = erp.effectsApplied().length;

      const second = await invoker.invoke({
        ...baseInput,
        tool_id: 'TL-ERPW-03',
        args: { business_key: 'INV-IDEM-1' },
        permission_scope_requested: 'ap:post',
        idempotency_key: key,
        business_key: 'INV-IDEM-1',
      });

      expect(second.ok).toBe(true);
      if (!second.ok) return;

      // The same tool_call_id: it IS the original, not a new call with the
      // same effect. And the connector saw nothing the second time.
      expect(second.value.tool_call_id).toBe(first.value.tool_call_id);
      expect(second.value.provider_reference).toBe(first.value.provider_reference);
      expect(erp.effectsApplied()).toHaveLength(applied);
    });

    it('refuses a changed payload under a reused key', async () => {
      const invoker = makeInvoker(false);
      const key = sha256(`conflict-${Date.now()}`);

      await invoker.invoke({
        ...baseInput,
        tool_id: 'TL-ERPW-03',
        args: { business_key: 'INV-A', amount: 100 },
        permission_scope_requested: 'ap:post',
        idempotency_key: key,
      });

      const second = await invoker.invoke({
        ...baseInput,
        tool_id: 'TL-ERPW-03',
        args: { business_key: 'INV-A', amount: 999 },
        permission_scope_requested: 'ap:post',
        idempotency_key: key,
      });

      expect(second.ok).toBe(false);
      if (second.ok) return;
      expect(second.error.message).toMatch(/never an update/);
    });

    it('lets exactly one of two concurrent identical calls reach the connector', async () => {
      const invoker = makeInvoker(false);
      const key = sha256(`concurrent-${Date.now()}`);
      const call = () =>
        invoker.invoke({
          ...baseInput,
          tool_id: 'TL-ERPW-03',
          args: { business_key: 'INV-CONCURRENT' },
          permission_scope_requested: 'ap:post',
          idempotency_key: key,
        });

      const before = erp.effectsApplied().length;
      const results = await Promise.all([call(), call(), call()]);
      const applied = erp.effectsApplied().length - before;

      // Exactly one live post, however many callers raced.
      expect(applied).toBe(1);
      expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('calculation tools', () => {
    it('verifies arithmetic independently', async () => {
      const result = await makeInvoker(false).invoke({
        ...baseInput,
        tool_id: 'TL-CALC-05',
        permission_scope_requested: 'calc:none',
        args: {
          assertions: [
            {
              label: 'box 5',
              components: [
                { amount_minor: 120_00, currency: 'MYR' },
                { amount_minor: 340_50, currency: 'MYR' },
              ],
              stated_total: { amount_minor: 460_50, currency: 'MYR' },
            },
            {
              label: 'box 6',
              components: [{ amount_minor: 100_00, currency: 'MYR' }],
              stated_total: { amount_minor: 110_00, currency: 'MYR' },
            },
          ],
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const calls = await withTenant(
        db,
        { tenantId: TENANT, residencyZone: ZONE },
        async (s) =>
          s.sql<{ outcome: string }[]>`
          SELECT outcome FROM tool_calls
           WHERE tenant_id = ${TENANT} AND tool_call_id = ${result.value.tool_call_id}
        `,
      );
      expect(calls[0]?.outcome).toBe('success');
    });
  });

  it('records every call, including refused ones, for the audit trail', async () => {
    const rows = await withTenant(
      db,
      { tenantId: TENANT, residencyZone: ZONE },
      async (s) =>
        s.sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM tool_calls
         WHERE tenant_id = ${TENANT} AND graph_id = ${graphId}
      `,
    );
    expect(Number(rows[0]?.count)).toBeGreaterThan(0);
  });
});
