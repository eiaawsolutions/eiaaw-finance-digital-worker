/**
 * The worker process.
 *
 * Runs the durable workflow executor's poll loop plus the periodic jobs the
 * governance rails require:
 *
 *   - the chain verification job (s.10.5) — "walks the chain and alerts on a break"
 *   - chain anchoring (s.10.5) — periodic sealing
 *   - hand-off SLA escalation (s.7.3) — "the original SLA start is not reset"
 *   - conversation idle close (s.7.1) — closing destroys working memory
 *   - timer firing and lease reclamation (s.9.5)
 *
 * These are jobs, not request handlers, and they run here rather than in the
 * API so a deploy that scales the API to zero does not silently stop verifying
 * the audit chain.
 */
import { createHmac } from 'node:crypto';
import { newId } from '@eiaaw/core';
import { withPlatformScope, withTenant } from '@eiaaw/db';
import { runPollLoop } from '@eiaaw/workflow';
import { buildContainer, type Container } from '@eiaaw/api/container';
import { registerWorkflows } from './workflows.js';

interface PeriodicJob {
  readonly name: string;
  readonly intervalMs: number;
  run(container: Container): Promise<string | null>;
}

const JOBS: readonly PeriodicJob[] = [
  {
    name: 'audit-chain-verification',
    intervalMs: 15 * 60_000,
    async run(container) {
      const tenants = await activeTenants(container);
      let broken = 0;

      for (const tenantId of tenants) {
        const result = await container.audit.verifySegment(tenantId);
        await container.audit.recordVerification(tenantId, result, newId('auditEvent'));

        if (!result.ok) {
          broken += 1;
          // A break is an incident, not a warning: the audit log is the record
          // every other control depends on.
          container.log.error('AUDIT CHAIN BROKEN', {
            tenant_id: tenantId,
            detail: result.brokenAt?.reason ?? 'unknown',
          });
          await container.emitter('C15').emit(
            { tenant_id: tenantId },
            {
              event_type: 'audit.chain_broken',
              outcome: 'failure',
              subject: { kind: 'audit_chain', id: tenantId },
              payload: { broken_at: result.brokenAt },
            },
          );
        }
      }

      return broken > 0 ? `${broken} chain(s) BROKEN` : `${tenants.length} chain(s) verified`;
    },
  },

  {
    name: 'audit-chain-anchoring',
    intervalMs: 60 * 60_000,
    async run(container) {
      const key = container.config.crypto.auditChainAnchorKey;
      let anchored = 0;

      for (const tenantId of await activeTenants(container)) {
        const anchor = await container.audit.anchor(tenantId, newId('auditEvent'), (payload) =>
          createHmac('sha256', key.expose()).update(payload).digest('hex'),
        );
        if (anchor) anchored += 1;
      }

      return anchored > 0 ? `${anchored} chain(s) anchored` : null;
    },
  },

  {
    name: 'handoff-sla-escalation',
    intervalMs: 60_000,
    async run(container) {
      let escalated = 0;

      for (const tenantId of await activeTenants(container)) {
        for (const breach of await container.handoffs.breached(tenantId)) {
          // The escalation target resolves through AS-PPL-ESC-*; without a
          // resolvable target the hand-off halts with a governed stop rather
          // than escalating into nothing (s.7.3).
          const target = await container.settings.resolve<{
            principal_id: string;
            role_ref: string;
          }>(tenantId, 'AS-PPL-ESC-001');

          if (!target.ok) {
            container.log.warn('hand-off breached with no resolvable escalation target', {
              tenant_id: tenantId,
              detail: target.error.message,
            });
            continue;
          }

          const result = await container.handoffs.escalate(
            tenantId,
            breach.handoff_id,
            target.value.value,
            '1 day',
          );

          if (result.ok) {
            escalated += 1;
            await container.emitter('C15').emit(
              { tenant_id: tenantId },
              {
                event_type: 'handoff.escalated',
                outcome: 'success',
                subject: { kind: 'handoff', id: breach.handoff_id },
                payload: { age_seconds: breach.age_seconds },
              },
            );
          }
        }
      }

      return escalated > 0 ? `${escalated} hand-off(s) escalated` : null;
    },
  },

  {
    name: 'conversation-idle-close',
    intervalMs: 5 * 60_000,
    async run(container) {
      let closed = 0;

      for (const tenantId of await activeTenants(container)) {
        const rows = await withTenant(
          container.db,
          { tenantId, residencyZone: container.config.residencyZone },
          async (scope) =>
            scope.sql<{ conversation_key: string }[]>`
              UPDATE conversations
                 SET state = 'closed',
                     -- Closing DESTROYS working memory (s.3.3). Preference
                     -- memory is retained; the task-scoped memory is not.
                     working_memory_ref = NULL
               WHERE tenant_id = ${tenantId} AND state = 'active' AND closes_at < now()
               RETURNING conversation_key
            `,
        );
        closed += rows.length;
      }

      return closed > 0 ? `${closed} conversation(s) closed` : null;
    },
  },

  {
    name: 'settings-staleness-check',
    intervalMs: 30 * 60_000,
    async run(container) {
      const stale: string[] = [];

      for (const tenantId of await activeTenants(container)) {
        const health = await container.settings.health(tenantId);
        if (health.stale || !health.families.every((f) => f.complete)) {
          stale.push(tenantId);
          await container.emitter('C16').emit(
            { tenant_id: tenantId },
            {
              event_type: health.stale ? 'config.stale' : 'config.missing',
              outcome: 'failure',
              subject: { kind: 'settings', id: tenantId },
              payload: {
                snapshot_age_seconds: health.snapshot_age_seconds,
                incomplete: health.families.filter((f) => !f.complete).map((f) => f.family),
              },
            },
          );
        }
      }

      return stale.length > 0
        ? `${stale.length} tenant(s) with stale or incomplete settings`
        : null;
    },
  },
];

async function activeTenants(container: Container): Promise<string[]> {
  const rows = await withPlatformScope(
    container.db,
    async (sql) =>
      sql<{ tenant_id: string }[]>`
      SELECT tenant_id FROM tenants WHERE status = 'active'
    `,
  );
  return rows.map((r) => r.tenant_id);
}

async function main(): Promise<void> {
  const container = await buildContainer();
  registerWorkflows(container);

  const controller = new AbortController();

  container.log.info('worker starting', {
    concurrency: container.config.workflow.concurrency,
    poll_interval_ms: container.config.workflow.pollIntervalMs,
    jobs: JOBS.length,
  });

  // The executor poll loop. `concurrency` independent loops share the lease
  // table, and SKIP LOCKED means they take different runs rather than queueing.
  const loops = Array.from({ length: container.config.workflow.concurrency }, () =>
    runPollLoop(container.workflow, {
      pollIntervalMs: container.config.workflow.pollIntervalMs,
      sweeperIntervalMs: container.config.workflow.sweeperIntervalMs,
      signal: controller.signal,
      logger: container.log,
    }),
  );

  // Periodic jobs, each on its own cadence and each isolated: one that throws
  // must not stop the others, because they protect different invariants.
  const timers = JOBS.map((job) =>
    setInterval(() => {
      void (async () => {
        try {
          const summary = await job.run(container);
          if (summary !== null) container.log.info(`job: ${job.name}`, { summary });
        } catch (error) {
          container.log.error(`job failed: ${job.name}`, {
            detail: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    }, job.intervalMs),
  );

  const shutdown = async (signal: string): Promise<void> => {
    container.log.info('shutdown signal received', { signal });
    controller.abort();
    for (const timer of timers) clearInterval(timer);
    // Let in-flight steps finish: a workflow interrupted mid-activity resumes
    // from history, but finishing cleanly avoids a lease timeout.
    await Promise.race([Promise.all(loops), new Promise((resolve) => setTimeout(resolve, 10_000))]);
    await container.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await Promise.all(loops);
}

main().catch((error: unknown) => {
  console.error('\nWorker failed to start.\n');
  console.error(error instanceof Error ? error.message : error);
  if (error instanceof Error && error.stack) console.error(`\n${error.stack}`);
  process.exit(1);
});
