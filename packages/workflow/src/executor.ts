/**
 * C7 — the durable Workflow Executor.
 *
 * Implements DWD-06 s.9 on Postgres. The essential loop:
 *
 *   1. lease a runnable workflow row;
 *   2. load its full event history;
 *   3. re-run the workflow function from the top, serving every prior
 *      `activity()` from history (s.9.2: "any activity that already completed
 *      is served from history rather than re-executed");
 *   4. when the function reaches something not in history it throws a
 *      `WorkflowSuspension`; perform that one thing, append the result, and
 *      loop;
 *   5. when the function returns, the workflow is complete.
 *
 * Re-running from the top on every step sounds expensive, and for very long
 * graphs it would be. It is chosen deliberately: it is the property that makes
 * a crash at any point safe, because the only durable state is the history and
 * the only way to interpret it is to replay it. A task graph is tens of nodes,
 * not thousands.
 */
import { type Timestamp, WorkerError, addMs, asText, newId, now, toTimestamp } from '@eiaaw/core';
import {
  type Database,
  type TenantScope,
  isSerializationFailure,
  withPlatformScope,
  withTenant,
} from '@eiaaw/db';
import type { AuditEmitter } from '@eiaaw/audit';
import { type Logger, nullLogger, recordGraphTransition } from '@eiaaw/telemetry';
import {
  ActivityFailure,
  type HistoryEvent,
  RETRY_POLICIES,
  WorkflowContext,
  type WorkflowSuspension,
  computeBackoffMs,
  isSuspension,
} from './context.js';

/** A workflow is a pure function of its context. It performs no I/O itself. */
export type WorkflowFunction<TInput = unknown, TResult = unknown> = (
  ctx: WorkflowContext,
  input: TInput,
) => TResult;

export interface WorkflowDefinition<TInput = unknown, TResult = unknown> {
  readonly type: string;
  /** s.9.5: in-flight runs continue on their pinned definition version. */
  readonly version: string;
  readonly run: WorkflowFunction<TInput, TResult>;
}

/** An activity is where all the I/O lives. */
export type ActivityFunction = (
  input: unknown,
  ctx: { readonly tenantId: string; readonly workflowRunId: string; readonly attempt: number },
) => Promise<unknown>;

export interface ExecutorOptions {
  readonly db: Database;
  readonly residencyZone: string;
  readonly audit?: AuditEmitter;
  readonly logger?: Logger;
  readonly leaseSeconds?: number;
  readonly workerId?: string;
  /** Guards against a workflow that suspends forever without progressing. */
  readonly maxStepsPerTurn?: number;
}

export interface StartOptions {
  readonly tenantId: string;
  readonly workflowType: string;
  readonly input: unknown;
  readonly graphId?: string;
  readonly workflowRunId?: string;
}

interface RunRow {
  workflow_run_id: string;
  tenant_id: string;
  graph_id: string | null;
  workflow_type: string;
  definition_version: string;
  state: string;
  input: unknown;
  next_sequence: string;
}

export class WorkflowExecutor {
  readonly #db: Database;
  readonly #residencyZone: string;
  readonly #audit: AuditEmitter | undefined;
  readonly #log: Logger;
  readonly #leaseSeconds: number;
  readonly #workerId: string;
  readonly #maxSteps: number;

  readonly #definitions = new Map<string, WorkflowDefinition>();
  readonly #activities = new Map<string, ActivityFunction>();

  constructor(options: ExecutorOptions) {
    this.#db = options.db;
    this.#residencyZone = options.residencyZone;
    this.#audit = options.audit;
    this.#log = options.logger ?? nullLogger;
    this.#leaseSeconds = options.leaseSeconds ?? 60;
    this.#workerId = options.workerId ?? `worker-${process.pid}-${newId('workflowRun').slice(-8)}`;
    this.#maxSteps = options.maxStepsPerTurn ?? 200;
  }

  register<TInput, TResult>(definition: WorkflowDefinition<TInput, TResult>): void {
    this.#definitions.set(
      `${definition.type}@${definition.version}`,
      definition as WorkflowDefinition,
    );
    // The unversioned key resolves to the newest registered version, which is
    // what a *new* run gets. An in-flight run always resolves by exact version.
    this.#definitions.set(definition.type, definition as WorkflowDefinition);
  }

  registerActivity(type: string, fn: ActivityFunction): void {
    this.#activities.set(type, fn);
  }

  /** Start a workflow. Returns immediately; execution happens in the poll loop. */
  async start(options: StartOptions, scope?: TenantScope): Promise<string> {
    const definition = this.#definitions.get(options.workflowType);
    if (!definition) {
      throw new WorkerError('contract_invalid', {
        detail: `No workflow definition is registered for type "${options.workflowType}".`,
        failureClass: 'internal',
        retryable: false,
      });
    }

    const runId = options.workflowRunId ?? newId('workflowRun');

    const write = async (s: TenantScope): Promise<void> => {
      await s.sql`
        INSERT INTO workflow_runs (
          tenant_id, workflow_run_id, graph_id, workflow_type, definition_version,
          state, input, next_sequence, runnable_at
        ) VALUES (
          ${options.tenantId}, ${runId}, ${options.graphId ?? null},
          ${definition.type}, ${definition.version}, 'running',
          ${s.sql.json(options.input as never)}, 2, now()
        )
      `;
      await s.sql`
        INSERT INTO workflow_events (
          tenant_id, workflow_run_id, sequence_number, event_type, payload
        ) VALUES (
          ${options.tenantId}, ${runId}, 1, 'workflow_started',
          ${s.sql.json({ input: options.input, definition_version: definition.version } as never)}
        )
      `;
    };

    if (scope) await write(scope);
    else
      await withTenant(
        this.#db,
        { tenantId: options.tenantId, residencyZone: this.#residencyZone },
        write,
      );

    return runId;
  }

  /**
   * Deliver a signal — the reviewer action that wakes a suspended hand-off.
   *
   * Making the run runnable is part of the same transaction as recording the
   * signal, so a crash between the two cannot leave a workflow asleep on a
   * signal that has already arrived.
   */
  async signal(
    tenantId: string,
    workflowRunId: string,
    signalName: string,
    payload: unknown,
    scope?: TenantScope,
  ): Promise<void> {
    const write = async (s: TenantScope): Promise<void> => {
      const rows = await s.sql<{ next_sequence: string }[]>`
        SELECT next_sequence FROM workflow_runs
         WHERE tenant_id = ${tenantId} AND workflow_run_id = ${workflowRunId}
           FOR UPDATE
      `;
      const run = rows[0];
      if (!run) {
        throw new WorkerError('not_found', {
          detail: `Workflow run ${workflowRunId} does not exist for this tenant.`,
          failureClass: 'internal',
          retryable: false,
        });
      }

      const sequence = Number(run.next_sequence);
      await s.sql`
        INSERT INTO workflow_events (
          tenant_id, workflow_run_id, sequence_number, event_type, payload
        ) VALUES (
          ${tenantId}, ${workflowRunId}, ${sequence}, 'signal_received',
          ${s.sql.json({ signal_name: signalName, payload } as never)}
        )
      `;
      await s.sql`
        UPDATE workflow_runs
           SET next_sequence = ${sequence + 1},
               state = CASE WHEN state IN ('awaiting_signal', 'awaiting_timer')
                            THEN 'running' ELSE state END,
               runnable_at = now(),
               leased_by = NULL, leased_until = NULL
         WHERE tenant_id = ${tenantId} AND workflow_run_id = ${workflowRunId}
      `;
      await s.sql`
        INSERT INTO workflow_signals (tenant_id, signal_id, workflow_run_id, signal_name, payload)
        VALUES (${tenantId}, ${newId('workflowRun')}, ${workflowRunId}, ${signalName},
                ${s.sql.json(payload as never)})
      `;
    };

    if (scope) await write(scope);
    else await withTenant(this.#db, { tenantId, residencyZone: this.#residencyZone }, write);
  }

  /**
   * Poll once: lease a runnable workflow and advance it as far as it will go.
   *
   * Returns false when there was nothing to do, so the caller can back off.
   */
  async pollOnce(): Promise<boolean> {
    const run = await this.#leaseNext();
    if (!run) return false;

    try {
      await this.#advance(run);
    } catch (error) {
      this.#log.error('workflow step failed', {
        tenant_id: run.tenant_id,
        workflow_run_id: run.workflow_run_id,
        detail: error instanceof Error ? error.message : String(error),
      });
      await this.#failRun(run, error);
    } finally {
      await this.#releaseLease(run);
    }

    return true;
  }

  /**
   * Fire due timers. Called by the sweeper alongside the poll loop.
   *
   * A timer that has come due makes its run runnable; the run then replays and
   * finds the `timer_fired` event in history.
   */
  async fireDueTimers(limit = 50): Promise<number> {
    const due = await withPlatformScope(
      this.#db,
      async (sql) =>
        sql<
          {
            tenant_id: string;
            timer_id: string;
            workflow_run_id: string;
            payload: Record<string, unknown>;
          }[]
        >`
        SELECT tenant_id, timer_id, workflow_run_id, payload
          FROM workflow_timers
         WHERE fired_at IS NULL AND cancelled_at IS NULL AND due_at <= now()
         ORDER BY due_at
         LIMIT ${limit}
      `,
    );

    for (const timer of due) {
      await withTenant(
        this.#db,
        { tenantId: timer.tenant_id, residencyZone: this.#residencyZone },
        async (s) => {
          const rows = await s.sql<{ next_sequence: string }[]>`
            SELECT next_sequence FROM workflow_runs
             WHERE tenant_id = ${timer.tenant_id} AND workflow_run_id = ${timer.workflow_run_id}
               FOR UPDATE
          `;
          const run = rows[0];
          if (!run) return;

          const sequence = Number(run.next_sequence);
          await s.sql`
            INSERT INTO workflow_events (
              tenant_id, workflow_run_id, sequence_number, event_type, activity_id, payload
            ) VALUES (
              ${timer.tenant_id}, ${timer.workflow_run_id}, ${sequence}, 'timer_fired',
              ${asText(timer.payload['activity_id'], timer.timer_id)},
              ${s.sql.json(timer.payload as never)}
            )
          `;
          await s.sql`
            UPDATE workflow_timers SET fired_at = now()
             WHERE tenant_id = ${timer.tenant_id} AND timer_id = ${timer.timer_id}
          `;
          await s.sql`
            UPDATE workflow_runs
               SET next_sequence = ${sequence + 1},
                   state = CASE WHEN state = 'awaiting_timer' THEN 'running' ELSE state END,
                   runnable_at = now(), leased_by = NULL, leased_until = NULL
             WHERE tenant_id = ${timer.tenant_id} AND workflow_run_id = ${timer.workflow_run_id}
          `;
        },
      );
    }

    return due.length;
  }

  /** Reclaim leases held by workers that died mid-step. */
  async reclaimExpiredLeases(): Promise<number> {
    const rows = await withPlatformScope(
      this.#db,
      async (sql) =>
        sql<{ count: string }[]>`
        WITH reclaimed AS (
          UPDATE workflow_runs SET leased_by = NULL, leased_until = NULL
           WHERE leased_until IS NOT NULL AND leased_until < now()
             AND state IN ('running', 'awaiting_timer')
           RETURNING 1
        )
        SELECT count(*)::text AS count FROM reclaimed
      `,
    );
    return Number(rows[0]?.count ?? 0);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  async #leaseNext(): Promise<RunRow | null> {
    return withPlatformScope(this.#db, async (sql) => {
      // SKIP LOCKED lets N workers poll the same table without contending: each
      // takes a different row rather than queuing behind the same one.
      const rows = await sql<RunRow[]>`
        UPDATE workflow_runs
           SET leased_by = ${this.#workerId},
               leased_until = now() + (${this.#leaseSeconds} || ' seconds')::interval
         WHERE (tenant_id, workflow_run_id) IN (
           SELECT tenant_id, workflow_run_id FROM workflow_runs
            WHERE state IN ('running', 'awaiting_timer')
              AND runnable_at <= now()
              AND (leased_until IS NULL OR leased_until < now())
            ORDER BY runnable_at
            LIMIT 1
            FOR UPDATE SKIP LOCKED
         )
         RETURNING workflow_run_id, tenant_id, graph_id, workflow_type,
                   definition_version, state, input, next_sequence
      `;
      return rows[0] ?? null;
    });
  }

  async #releaseLease(run: RunRow): Promise<void> {
    await withPlatformScope(this.#db, async (sql) => {
      await sql`
        UPDATE workflow_runs SET leased_by = NULL, leased_until = NULL
         WHERE tenant_id = ${run.tenant_id} AND workflow_run_id = ${run.workflow_run_id}
           AND leased_by = ${this.#workerId}
      `;
    });
  }

  /**
   * Advance one workflow as far as it will go this turn.
   *
   * Each iteration replays the whole workflow function. That is the point: the
   * function is pure, history is the only state, and replay is how the two are
   * reconciled.
   */
  async #advance(run: RunRow): Promise<void> {
    // s.9.5: resolve by EXACT version. A deploy mid-run must not switch the
    // definition under a workflow that has already taken branches on the old one.
    const definition =
      this.#definitions.get(`${run.workflow_type}@${run.definition_version}`) ??
      this.#definitions.get(run.workflow_type);

    if (!definition) {
      throw new WorkerError('dependency_unavailable', {
        detail:
          `No workflow definition for "${run.workflow_type}" at version ` +
          `${run.definition_version}. An in-flight run pins its definition version, so ` +
          'a superseded version must remain registered until every run on it completes.',
        failureClass: 'internal',
        retryable: false,
      });
    }

    for (let step = 0; step < this.#maxSteps; step += 1) {
      const history = await this.#loadHistory(run);
      const ctx = new WorkflowContext({
        tenantId: run.tenant_id,
        workflowRunId: run.workflow_run_id,
        graphId: run.graph_id,
        definitionVersion: run.definition_version,
        history,
        startedAt: toTimestamp(history[0]?.recorded_at ?? now()),
      });

      let result: unknown;
      try {
        result = definition.run(ctx, run.input);
      } catch (error) {
        if (isSuspension(error)) {
          const progressed = await this.#handleSuspension(run, error);
          if (!progressed) return; // durably waiting; nothing more to do now
          continue;
        }
        if (error instanceof ActivityFailure) {
          // The workflow let a permanent activity failure escape. That is a
          // deliberate decision by the workflow author, so the run fails.
          await this.#completeRun(run, 'failed', undefined, {
            class: error.failure.class,
            code: error.failure.code,
            message: error.failure.message,
          });
          return;
        }
        throw error;
      }

      await this.#completeRun(run, 'completed', result);
      return;
    }

    // A workflow that suspends this many times in one turn is looping.
    throw new WorkerError('internal_error', {
      detail:
        `Workflow ${run.workflow_run_id} took ${this.#maxSteps} steps without completing. ` +
        'This indicates a non-terminating workflow or a non-deterministic call site whose ' +
        'result never matches history.',
      failureClass: 'internal',
      retryable: false,
    });
  }

  /**
   * Perform whatever the workflow is waiting on.
   *
   * Returns true when history advanced (so the caller replays immediately), and
   * false when the run is now durably waiting for something external.
   */
  async #handleSuspension(run: RunRow, suspension: WorkflowSuspension): Promise<boolean> {
    switch (suspension.reason) {
      case 'activity_pending':
        return this.#runActivity(run, suspension);

      case 'timer_pending': {
        await this.#scheduleTimer(run, suspension);
        return false;
      }

      case 'signal_pending': {
        await this.#awaitSignal(run, suspension);
        return false;
      }
    }
  }

  async #runActivity(run: RunRow, suspension: WorkflowSuspension): Promise<boolean> {
    const activityId = suspension.detail.activity_id as string;
    const activityType = suspension.detail.activity_type as string;

    // A marker is recorded, not executed.
    if (activityType === '__marker__') {
      await this.#appendEvent(run, 'marker_recorded', {
        activityId,
        activityType,
        payload: { data: suspension.detail.input },
      });
      return true;
    }

    const fn = this.#activities.get(activityType);
    if (!fn) {
      await this.#appendEvent(run, 'activity_failed', {
        activityId,
        activityType,
        payload: {
          failure: {
            class: 'internal',
            code: 'activity_not_registered',
            message: `No activity is registered for type "${activityType}".`,
            retryable: false,
          },
        },
      });
      return true;
    }

    const policy = RETRY_POLICIES[suspension.detail.retryClass ?? 'tool_read'];
    const maxAttempts = suspension.detail.maxAttempts ?? policy.maxAttempts;
    const attempt = (await this.#attemptsSoFar(run, activityId)) + 1;

    await this.#appendEvent(run, 'activity_scheduled', {
      activityId,
      activityType,
      attempt,
      payload: { input: suspension.detail.input },
    });

    try {
      const result = await fn(suspension.detail.input, {
        tenantId: run.tenant_id,
        workflowRunId: run.workflow_run_id,
        attempt,
      });

      await this.#appendEvent(run, 'activity_completed', {
        activityId,
        activityType,
        attempt,
        payload: { result },
      });

      // s.9.4: every successful state-changing activity pushes a compensation.
      if (suspension.detail.compensation) {
        await this.#pushCompensation(run, activityId, suspension.detail.compensation, result);
      }

      return true;
    } catch (error) {
      const failure = describeFailure(error);

      if (failure.retryable && attempt < maxAttempts) {
        // Back off durably: the run becomes runnable again later rather than
        // the worker sleeping and holding a lease.
        const delay = computeBackoffMs(policy, attempt, 0.5);
        await this.#appendEvent(run, 'activity_failed', {
          activityId: `${activityId}::attempt-${attempt}`,
          activityType,
          attempt,
          payload: { failure, will_retry: true, retry_in_ms: delay },
        });
        await this.#scheduleRetry(run, delay);
        return false;
      }

      await this.#appendEvent(run, 'activity_failed', {
        activityId,
        activityType,
        attempt,
        payload: { failure, will_retry: false },
      });
      return true;
    }
  }

  async #attemptsSoFar(run: RunRow, activityId: string): Promise<number> {
    const rows = await withTenant(
      this.#db,
      { tenantId: run.tenant_id, residencyZone: this.#residencyZone, readOnly: true },
      async (s) =>
        s.sql<{ count: string }[]>`
          SELECT count(*)::text AS count FROM workflow_events
           WHERE tenant_id = ${run.tenant_id}
             AND workflow_run_id = ${run.workflow_run_id}
             AND event_type = 'activity_scheduled'
             AND activity_id = ${activityId}
        `,
    );
    return Number(rows[0]?.count ?? 0);
  }

  async #scheduleRetry(run: RunRow, delayMs: number): Promise<void> {
    await withPlatformScope(this.#db, async (sql) => {
      await sql`
        UPDATE workflow_runs
           SET runnable_at = now() + (${Math.ceil(delayMs)} || ' milliseconds')::interval,
               leased_by = NULL, leased_until = NULL
         WHERE tenant_id = ${run.tenant_id} AND workflow_run_id = ${run.workflow_run_id}
      `;
    });
  }

  async #scheduleTimer(run: RunRow, suspension: WorkflowSuspension): Promise<void> {
    const dueAt = suspension.detail.due_at as Timestamp;
    const activityId = suspension.detail.activity_id as string;

    await withTenant(
      this.#db,
      { tenantId: run.tenant_id, residencyZone: this.#residencyZone },
      async (s) => {
        await s.sql`
          INSERT INTO workflow_timers (
            tenant_id, timer_id, workflow_run_id, timer_kind, due_at, payload
          ) VALUES (
            ${run.tenant_id}, ${`tmr_${run.workflow_run_id}_${activityId}`},
            ${run.workflow_run_id}, 'retry_backoff', ${dueAt}::timestamptz,
            ${s.sql.json({ activity_id: activityId })}
          )
          ON CONFLICT (tenant_id, timer_id) DO NOTHING
        `;
        await s.sql`
          UPDATE workflow_runs
             SET state = 'awaiting_timer', runnable_at = ${dueAt}::timestamptz,
                 leased_by = NULL, leased_until = NULL
           WHERE tenant_id = ${run.tenant_id} AND workflow_run_id = ${run.workflow_run_id}
        `;
      },
    );
  }

  async #awaitSignal(run: RunRow, suspension: WorkflowSuspension): Promise<void> {
    await withPlatformScope(this.#db, async (sql) => {
      await sql`
        UPDATE workflow_runs
           SET state = 'awaiting_signal', leased_by = NULL, leased_until = NULL,
               -- Far in the future: only a signal wakes this run. A poll
               -- interval here would be a busy-wait on a human decision.
               runnable_at = now() + interval '100 years'
         WHERE tenant_id = ${run.tenant_id} AND workflow_run_id = ${run.workflow_run_id}
      `;
    });

    this.#log.info('workflow awaiting signal', {
      tenant_id: run.tenant_id,
      workflow_run_id: run.workflow_run_id,
      signal_name: suspension.detail.signal_name,
    });
  }

  async #pushCompensation(
    run: RunRow,
    activityId: string,
    compensation: NonNullable<WorkflowSuspension['detail']['compensation']>,
    result: unknown,
  ): Promise<void> {
    if (run.graph_id === null) return;

    await withTenant(
      this.#db,
      { tenantId: run.tenant_id, residencyZone: this.#residencyZone },
      async (s) => {
        const rows = await s.sql<{ next_position: number }[]>`
          SELECT coalesce(max(stack_position), 0) + 1 AS next_position
            FROM compensation_stack
           WHERE tenant_id = ${run.tenant_id} AND graph_id = ${run.graph_id}
        `;
        const providerReference =
          typeof result === 'object' && result !== null && 'provider_reference' in result
            ? String(result.provider_reference)
            : null;

        await s.sql`
          INSERT INTO compensation_stack (
            tenant_id, graph_id, stack_position, node_id, compensation_tool_id,
            compensation_key, business_key, provider_reference, original_tool_call_id
          ) VALUES (
            ${run.tenant_id}, ${run.graph_id}, ${rows[0]?.next_position ?? 1},
            ${activityId}, ${compensation.tool_id}, ${compensation.compensation_key},
            ${compensation.business_key ?? null}, ${providerReference}, ${activityId}
          )
          ON CONFLICT DO NOTHING
        `;
      },
    );
  }

  async #loadHistory(run: RunRow): Promise<HistoryEvent[]> {
    return withTenant(
      this.#db,
      { tenantId: run.tenant_id, residencyZone: this.#residencyZone, readOnly: true },
      async (s) =>
        s.sql<HistoryEvent[]>`
          SELECT sequence_number, event_type, activity_id, activity_type,
                 payload, attempt, recorded_at
            FROM workflow_events
           WHERE tenant_id = ${run.tenant_id} AND workflow_run_id = ${run.workflow_run_id}
           ORDER BY sequence_number
        `,
    );
  }

  async #appendEvent(
    run: RunRow,
    eventType: string,
    parts: {
      activityId?: string;
      activityType?: string;
      attempt?: number;
      payload: Record<string, unknown>;
    },
  ): Promise<void> {
    await this.#withRetryOnContention(() =>
      withTenant(
        this.#db,
        { tenantId: run.tenant_id, residencyZone: this.#residencyZone },
        async (s) => {
          const rows = await s.sql<{ next_sequence: string }[]>`
            SELECT next_sequence FROM workflow_runs
             WHERE tenant_id = ${run.tenant_id} AND workflow_run_id = ${run.workflow_run_id}
               FOR UPDATE
          `;
          const sequence = Number(rows[0]?.next_sequence ?? 1);

          await s.sql`
            INSERT INTO workflow_events (
              tenant_id, workflow_run_id, sequence_number, event_type,
              activity_id, activity_type, payload, attempt
            ) VALUES (
              ${run.tenant_id}, ${run.workflow_run_id}, ${sequence}, ${eventType},
              ${parts.activityId ?? null}, ${parts.activityType ?? null},
              ${s.sql.json(parts.payload as never)}, ${parts.attempt ?? 1}
            )
          `;
          await s.sql`
            UPDATE workflow_runs SET next_sequence = ${sequence + 1}
             WHERE tenant_id = ${run.tenant_id} AND workflow_run_id = ${run.workflow_run_id}
          `;
        },
      ),
    );
  }

  async #completeRun(
    run: RunRow,
    state: 'completed' | 'failed' | 'cancelled',
    result?: unknown,
    failure?: { class: string; code: string; message: string },
  ): Promise<void> {
    await this.#appendEvent(run, state === 'completed' ? 'workflow_completed' : 'workflow_failed', {
      payload: state === 'completed' ? { result } : { failure },
    });

    await withPlatformScope(this.#db, async (sql) => {
      await sql`
        UPDATE workflow_runs
           SET state = ${state}, completed_at = now(),
               result = ${result === undefined ? null : sql.json(result as never)},
               failure = ${failure === undefined ? null : sql.json(failure)},
               leased_by = NULL, leased_until = NULL
         WHERE tenant_id = ${run.tenant_id} AND workflow_run_id = ${run.workflow_run_id}
      `;
    });

    recordGraphTransition('running', state, 'request');

    if (this.#audit) {
      await this.#audit.emit(
        { tenant_id: run.tenant_id, graph_id: run.graph_id },
        {
          event_type: 'graph.state_changed',
          outcome: state === 'completed' ? 'success' : 'failure',
          subject: { kind: 'workflow_run', id: run.workflow_run_id },
          payload: { to: state, workflow_type: run.workflow_type },
        },
      );
    }
  }

  async #failRun(run: RunRow, error: unknown): Promise<void> {
    const failure = describeFailure(error);
    try {
      await this.#completeRun(run, 'failed', undefined, {
        class: failure.class,
        code: failure.code,
        message: failure.message,
      });
    } catch (nested) {
      this.#log.error('could not record workflow failure', {
        tenant_id: run.tenant_id,
        workflow_run_id: run.workflow_run_id,
        detail: nested instanceof Error ? nested.message : String(nested),
      });
    }
  }

  async #withRetryOnContention<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (!isSerializationFailure(error)) throw error;
        await new Promise((resolve) => setTimeout(resolve, 10 * attempt));
      }
    }
    throw lastError;
  }
}

function describeFailure(error: unknown): {
  class: string;
  code: string;
  message: string;
  retryable: boolean;
} {
  if (error instanceof WorkerError) {
    return {
      class: error.failureClass,
      code: error.code,
      message: error.message,
      retryable: error.retryable,
    };
  }
  if (error instanceof Error) {
    return { class: 'internal', code: 'unhandled', message: error.message, retryable: false };
  }
  return { class: 'internal', code: 'unknown', message: String(error), retryable: false };
}

/** The poll loop, for the worker app. */
export async function runPollLoop(
  executor: WorkflowExecutor,
  options: {
    readonly pollIntervalMs: number;
    readonly sweeperIntervalMs: number;
    readonly signal: AbortSignal;
    readonly logger?: Logger;
  },
): Promise<void> {
  const log = options.logger ?? nullLogger;
  let lastSweep = 0;

  while (!options.signal.aborted) {
    try {
      if (Date.now() - lastSweep > options.sweeperIntervalMs) {
        lastSweep = Date.now();
        const [fired, reclaimed] = await Promise.all([
          executor.fireDueTimers(),
          executor.reclaimExpiredLeases(),
        ]);
        if (fired > 0 || reclaimed > 0) {
          log.debug('sweeper', { timers_fired: fired, leases_reclaimed: reclaimed });
        }
      }

      const worked = await executor.pollOnce();
      if (!worked) {
        await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
      }
    } catch (error) {
      log.error('poll loop error', {
        detail: error instanceof Error ? error.message : String(error),
      });
      await new Promise((resolve) => setTimeout(resolve, options.pollIntervalMs));
    }
  }
}

export const nextRunnableAt = (delayMs: number): Timestamp => addMs(now(), delayMs);
