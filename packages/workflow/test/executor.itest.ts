/**
 * C7 durability semantics — DWD-06 s.9.
 *
 * The properties under test are the ones the whole failure model rests on:
 *
 *   s.9.2  a completed activity is served from history, never re-executed;
 *   s.9.5  a worker crash resumes rather than repeats;
 *   s.9.5  an in-flight run continues on its PINNED definition version;
 *   s.9.1  a hand-off wait is durable and holds no thread;
 *   s.9.4  a successful state-changing activity pushes a compensation entry;
 *   s.9.3  transient failures retry with backoff; permanent ones do not.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { WorkerError, newId } from '@eiaaw/core';
import {
  closeDatabase,
  createDatabase,
  withPlatformScope,
  withTenant,
  type Database,
} from '@eiaaw/db';
import { WorkflowExecutor, type WorkflowContext } from '../src/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];
const describeIfDb = DATABASE_URL ? describe : describe.skip;

const ZONE = 'my-central';
const TENANT = 'tnt_workflow-itest';

let db: Database;

/** Drain the executor until nothing is runnable. */
async function drain(executor: WorkflowExecutor, maxPolls = 60): Promise<void> {
  for (let i = 0; i < maxPolls; i += 1) {
    await executor.fireDueTimers();
    if (!(await executor.pollOnce())) return;
  }
}

async function runState(runId: string): Promise<{ state: string; result: unknown }> {
  const rows = await withPlatformScope(
    db,
    async (sql) =>
      sql<{ state: string; result: unknown }[]>`
      SELECT state, result FROM workflow_runs
       WHERE tenant_id = ${TENANT} AND workflow_run_id = ${runId}
    `,
  );
  return rows[0] as { state: string; result: unknown };
}

describeIfDb('C7 workflow executor', () => {
  beforeAll(async () => {
    db = createDatabase({ url: DATABASE_URL as string, poolMax: 6, ssl: false });
    await withPlatformScope(db, async (sql) => {
      await sql`
        INSERT INTO tenants (tenant_id, display_name, residency_zone, status)
        VALUES (${TENANT}, 'Workflow Itest', ${ZONE}, 'active')
        ON CONFLICT (tenant_id) DO NOTHING
      `;
    });
  });

  afterAll(async () => {
    if (db) await closeDatabase(db);
  });

  // -------------------------------------------------------------------------
  // s.9.2 — activity memoisation
  // -------------------------------------------------------------------------
  it('serves a completed activity from history rather than re-executing it', async () => {
    const executor = new WorkflowExecutor({ db, residencyZone: ZONE });
    let sideEffects = 0;

    executor.register({
      type: 'memoisation-test',
      version: '1.0.0',
      run: (ctx: WorkflowContext) => {
        const a = ctx.activity<number>('first', 'increment', {});
        const b = ctx.activity<number>('second', 'increment', {});
        const c = ctx.activity<number>('third', 'increment', {});
        return a + b + c;
      },
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    executor.registerActivity('increment', async () => {
      sideEffects += 1;
      return sideEffects;
    });

    const runId = await executor.start({
      tenantId: TENANT,
      workflowType: 'memoisation-test',
      input: {},
    });
    await drain(executor);

    const state = await runState(runId);
    expect(state.state).toBe('completed');
    // Three activities, three executions — despite the workflow function being
    // replayed four times (once per suspension, once to completion).
    expect(sideEffects).toBe(3);
    expect(state.result).toBe(6);
  });

  it('gives two calls with the same name distinct identities', async () => {
    const executor = new WorkflowExecutor({ db, residencyZone: ZONE });
    const inputs: unknown[] = [];

    executor.register({
      type: 'ordinal-test',
      version: '1.0.0',
      run: (ctx: WorkflowContext) => {
        // Same call-site name twice: the ordinal distinguishes them, so the
        // second must not be served the first's recorded result.
        const a = ctx.activity<string>('gate', 'echo', { which: 'a' });
        const b = ctx.activity<string>('gate', 'echo', { which: 'b' });
        return [a, b];
      },
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    executor.registerActivity('echo', async (input) => {
      inputs.push(input);
      return (input as { which: string }).which;
    });

    const runId = await executor.start({
      tenantId: TENANT,
      workflowType: 'ordinal-test',
      input: {},
    });
    await drain(executor);

    expect((await runState(runId)).result).toEqual(['a', 'b']);
    expect(inputs).toEqual([{ which: 'a' }, { which: 'b' }]);
  });

  // -------------------------------------------------------------------------
  // s.9.5 — surviving a crash
  // -------------------------------------------------------------------------
  it('resumes after a worker crash rather than repeating completed work', async () => {
    const posted: string[] = [];

    const build = (): WorkflowExecutor => {
      const executor = new WorkflowExecutor({ db, residencyZone: ZONE, leaseSeconds: 1 });
      executor.register({
        type: 'crash-test',
        version: '1.0.0',
        run: (ctx: WorkflowContext) => {
          ctx.activity<string>('post-1', 'post', { doc: 'INV-1' });
          ctx.activity<string>('post-2', 'post', { doc: 'INV-2' });
          ctx.activity<string>('post-3', 'post', { doc: 'INV-3' });
          return 'done';
        },
      });
      // eslint-disable-next-line @typescript-eslint/require-await
      executor.registerActivity('post', async (input) => {
        const doc = (input as { doc: string }).doc;
        posted.push(doc);
        return `ERP-${doc}`;
      });
      return executor;
    };

    // First worker: advance partway, then "crash" by stopping.
    const first = build();
    const runId = await first.start({
      tenantId: TENANT,
      workflowType: 'crash-test',
      input: {},
    });
    await first.pollOnce(); // performs post-1 and post-2 within one turn
    expect(posted.length).toBeGreaterThanOrEqual(1);
    const postedBeforeCrash = [...posted];

    // Second worker picks up the same run from history.
    await withPlatformScope(db, async (sql) => {
      await sql`
        UPDATE workflow_runs SET leased_by = NULL, leased_until = NULL
         WHERE tenant_id = ${TENANT} AND workflow_run_id = ${runId}
      `;
    });

    const second = build();
    await drain(second);

    expect((await runState(runId)).state).toBe('completed');
    // Each document posted exactly once across both workers. A replay that
    // re-executed completed activities would show duplicates here — which in
    // production is a double-posted journal.
    expect(posted).toEqual(['INV-1', 'INV-2', 'INV-3']);
    expect(posted.slice(0, postedBeforeCrash.length)).toEqual(postedBeforeCrash);
  });

  // -------------------------------------------------------------------------
  // s.9.5 — pinned definition versions
  // -------------------------------------------------------------------------
  it('continues an in-flight run on its pinned definition version', async () => {
    const executor = new WorkflowExecutor({ db, residencyZone: ZONE });
    const seen: string[] = [];

    executor.register({
      type: 'versioned',
      version: '1.0.0',
      run: (ctx: WorkflowContext) => {
        ctx.activity<string>('step', 'record', { version: 'v1' });
        ctx.activity<string>('await', 'record', { version: 'v1-second' });
        return 'v1-result';
      },
    });
    // eslint-disable-next-line @typescript-eslint/require-await
    executor.registerActivity('record', async (input) => {
      seen.push((input as { version: string }).version);
      return 'ok';
    });

    const runId = await executor.start({
      tenantId: TENANT,
      workflowType: 'versioned',
      input: {},
    });
    await executor.pollOnce();

    // Deploy v2 mid-run. The in-flight run must not switch.
    executor.register({
      type: 'versioned',
      version: '2.0.0',
      run: () => 'v2-result',
    });

    await withPlatformScope(db, async (sql) => {
      await sql`
        UPDATE workflow_runs SET leased_by = NULL, leased_until = NULL
         WHERE tenant_id = ${TENANT} AND workflow_run_id = ${runId}
      `;
    });
    await drain(executor);

    expect((await runState(runId)).result).toBe('v1-result');

    // A NEW run gets v2.
    const newRunId = await executor.start({
      tenantId: TENANT,
      workflowType: 'versioned',
      input: {},
    });
    await drain(executor);
    expect((await runState(newRunId)).result).toBe('v2-result');
  });

  // -------------------------------------------------------------------------
  // s.9.1 — a durable hand-off wait
  // -------------------------------------------------------------------------
  it('suspends durably on a signal and holds no thread', async () => {
    const executor = new WorkflowExecutor({ db, residencyZone: ZONE });

    executor.register({
      type: 'handoff-test',
      version: '1.0.0',
      run: (ctx: WorkflowContext) => {
        ctx.activity<string>('prepare', 'prepare', {});
        const decision = ctx.waitForSignal<{ move: string }>('reviewer_action');
        return `reviewer chose ${decision.move}`;
      },
    });
    // eslint-disable-next-line @typescript-eslint/require-await
    executor.registerActivity('prepare', async () => 'bundle-assembled');

    const runId = await executor.start({
      tenantId: TENANT,
      workflowType: 'handoff-test',
      input: {},
    });
    await drain(executor);

    // Durably waiting, not spinning: the run is parked and not runnable.
    const parked = await runState(runId);
    expect(parked.state).toBe('awaiting_signal');

    // Polling again does nothing — no busy-wait on a human decision.
    expect(await executor.pollOnce()).toBe(false);

    // Days later (or seconds, here), the reviewer acts.
    await executor.signal(TENANT, runId, 'reviewer_action', { move: 'approve' });
    await drain(executor);

    const done = await runState(runId);
    expect(done.state).toBe('completed');
    expect(done.result).toBe('reviewer chose approve');
  });

  // -------------------------------------------------------------------------
  // s.9.3 — retry policy
  // -------------------------------------------------------------------------
  it('retries a transient failure and succeeds', async () => {
    const executor = new WorkflowExecutor({ db, residencyZone: ZONE });
    let attempts = 0;

    executor.register({
      type: 'retry-test',
      version: '1.0.0',
      run: (ctx: WorkflowContext) =>
        ctx.activity<string>('flaky', 'flaky', {}, { retryClass: 'tool_read', maxAttempts: 4 }),
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    executor.registerActivity('flaky', async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new WorkerError('dependency_unavailable', {
          detail: 'connector unavailable',
          retryable: true,
        });
      }
      return 'succeeded-on-third';
    });

    const runId = await executor.start({
      tenantId: TENANT,
      workflowType: 'retry-test',
      input: {},
    });

    // Backoff is durable, so draining requires the timer sweep between polls.
    for (let i = 0; i < 40 && (await runState(runId)).state !== 'completed'; i += 1) {
      await withPlatformScope(db, async (sql) => {
        await sql`
          UPDATE workflow_runs SET runnable_at = now()
           WHERE tenant_id = ${TENANT} AND workflow_run_id = ${runId}
             AND state IN ('running', 'awaiting_timer')
        `;
      });
      await executor.pollOnce();
    }

    expect(attempts).toBe(3);
    expect((await runState(runId)).result).toBe('succeeded-on-third');
  });

  it('does not retry a permanent failure', async () => {
    const executor = new WorkflowExecutor({ db, residencyZone: ZONE });
    let attempts = 0;

    executor.register({
      type: 'permanent-failure-test',
      version: '1.0.0',
      run: (ctx: WorkflowContext) =>
        ctx.activity<string>('refused', 'refused', {}, { retryClass: 'policy_gate' }),
    });

    // eslint-disable-next-line @typescript-eslint/require-await
    executor.registerActivity('refused', async () => {
      attempts += 1;
      // s.7.4: "never retry a policy refusal."
      throw new WorkerError('authority_insufficient', {
        detail: 'immutable rule 2 engaged',
        failureClass: 'policy',
        retryable: false,
      });
    });

    const runId = await executor.start({
      tenantId: TENANT,
      workflowType: 'permanent-failure-test',
      input: {},
    });
    await drain(executor);

    expect(attempts).toBe(1);
    expect((await runState(runId)).state).toBe('failed');
  });

  // -------------------------------------------------------------------------
  // s.9.4 — the compensation stack
  // -------------------------------------------------------------------------
  it('pushes a compensation entry for every successful state-changing activity', async () => {
    const executor = new WorkflowExecutor({ db, residencyZone: ZONE });
    const graphId = newId('taskGraph');

    // A graph row is required for the compensation stack's foreign key.
    await withTenant(db, { tenantId: TENANT, residencyZone: ZONE }, async (s) => {
      const contextId = newId('context');
      await s.sql`
        INSERT INTO contexts (tenant_id, context_id, request_id, resolution_status,
                              axes, pack_id, pack_version, residency_zone, resolved_locale,
                              knowledge_pin, context_token_hash, expires_at)
        VALUES (${TENANT}, ${contextId}, ${'0192f3c1-7a10-7c31-9b6a-1f0d2c4b5e60'}, 'resolved',
                '{}'::jsonb, 'pack-my-mfrs', '2026.08.1', ${ZONE}, 'en-MY',
                '{}'::jsonb, 'abc', now() + interval '1 hour')
      `;
      await s.sql`
        INSERT INTO task_graphs (tenant_id, graph_id, request_id, context_ref, trigger_class,
                                 intent, root_skill_id, skill_version, effective_autonomy,
                                 autonomy_basis, admission, budget, state, workflow_run_id)
        VALUES (${TENANT}, ${graphId}, ${'0192f3c1-7a10-7c31-9b6a-1f0d2c4b5e60'}, ${contextId},
                'request', 'test', 'SK-P2P-05', '1.0.0', 'execute',
                '{}'::jsonb, '{}'::jsonb, '{}'::jsonb, 'running', 'wf_pending')
      `;
    });

    executor.register({
      type: 'compensation-test',
      version: '1.0.0',
      run: (ctx: WorkflowContext) => {
        ctx.activity(
          'post-a',
          'post',
          { doc: 'A' },
          {
            compensation: {
              tool_id: 'TL-ERPW-12',
              compensation_key: 'a'.repeat(64),
              business_key: 'A',
            },
          },
        );
        ctx.activity(
          'post-b',
          'post',
          { doc: 'B' },
          {
            compensation: {
              tool_id: 'TL-ERPW-12',
              compensation_key: 'b'.repeat(64),
              business_key: 'B',
            },
          },
        );
        return 'posted';
      },
    });
    // eslint-disable-next-line @typescript-eslint/require-await
    executor.registerActivity('post', async (input) => ({
      provider_reference: `ERP-${(input as { doc: string }).doc}`,
    }));

    const runId = await executor.start({
      tenantId: TENANT,
      workflowType: 'compensation-test',
      input: {},
      graphId,
    });
    await drain(executor);
    expect((await runState(runId)).state).toBe('completed');

    const stack = await withTenant(
      db,
      { tenantId: TENANT, residencyZone: ZONE },
      async (s) =>
        s.sql<{ stack_position: number; business_key: string; provider_reference: string }[]>`
        SELECT stack_position, business_key, provider_reference FROM compensation_stack
         WHERE tenant_id = ${TENANT} AND graph_id = ${graphId}
         ORDER BY stack_position
      `,
    );

    expect(stack).toHaveLength(2);
    // Pushed in execution order; popped in reverse when compensating.
    expect(stack[0]?.business_key).toBe('A');
    expect(stack[1]?.business_key).toBe('B');
    expect(stack[0]?.provider_reference).toBe('ERP-A');
  });

  // -------------------------------------------------------------------------
  // Determinism
  // -------------------------------------------------------------------------
  it('gives workflow code a deterministic clock and randomness', async () => {
    const executor = new WorkflowExecutor({ db, residencyZone: ZONE });
    const observed: { now: string; random: number }[] = [];

    executor.register({
      type: 'determinism-test',
      version: '1.0.0',
      run: (ctx: WorkflowContext) => {
        observed.push({ now: ctx.now(), random: ctx.random('jitter') });
        ctx.activity('step', 'noop', {});
        return 'done';
      },
    });
    // eslint-disable-next-line @typescript-eslint/require-await
    executor.registerActivity('noop', async () => null);

    const runId = await executor.start({
      tenantId: TENANT,
      workflowType: 'determinism-test',
      input: {},
    });
    await drain(executor);
    expect((await runState(runId)).state).toBe('completed');

    // The function ran more than once (suspend then resume). `random` is
    // seeded from the call-site identity, so both passes agree — a
    // `Math.random()` here would have produced different values and, in a real
    // workflow, a different branch on replay.
    expect(observed.length).toBeGreaterThan(1);
    const randoms = new Set(observed.map((o) => o.random));
    expect(randoms.size).toBe(1);
  });

  it('parallel workers do not both take the same run', async () => {
    const executor = new WorkflowExecutor({ db, residencyZone: ZONE });
    let executions = 0;

    executor.register({
      type: 'lease-test',
      version: '1.0.0',
      run: (ctx: WorkflowContext) => ctx.activity<string>('only', 'count', {}),
    });
    // eslint-disable-next-line @typescript-eslint/require-await
    executor.registerActivity('count', async () => {
      executions += 1;
      return 'counted';
    });

    const runId = await executor.start({
      tenantId: TENANT,
      workflowType: 'lease-test',
      input: {},
    });

    // Six concurrent pollers against one runnable workflow.
    await Promise.all(Array.from({ length: 6 }, () => executor.pollOnce()));
    await drain(executor);

    expect((await runState(runId)).state).toBe('completed');
    expect(executions).toBe(1);
  });
});
