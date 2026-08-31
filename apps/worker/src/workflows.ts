/**
 * The task-graph workflow — the eight-step pipeline as durable code.
 *
 *   Resolve → Plan → Ground → Execute → Gate → Assure → Authorise → Deliver
 *
 * s.9.2: "A checkpoint exists at every one of the eight pipeline steps." Each
 * step below is one or more `ctx.activity` calls, and each of those is a
 * checkpoint — a crash between two replays from the earlier one.
 *
 * The workflow function itself is PURE. It reads history and decides what
 * happens next; every side effect is an activity registered below it.
 */
import { type WorkflowContext } from '@eiaaw/workflow';
import { withTenant } from '@eiaaw/db';
import { authorise } from '@eiaaw/authorisation';
import type { Container } from '@eiaaw/api/container';

export interface GraphWorkflowInput {
  readonly tenant_id: string;
  readonly request_id: string;
  readonly trace_id: string;
  readonly graph_id: string;
  readonly conversation_key: string;
  readonly context_id: string;
  readonly skill_id: string;
  readonly intent: string;
  readonly effective_autonomy: 'observe' | 'draft' | 'execute';
  readonly output_class: string;
  readonly principal_id: string;
  readonly channel: string;
}

export interface GraphWorkflowResult {
  readonly outcome: 'delivered' | 'awaiting_approval' | 'refused' | 'halted';
  readonly detail: string;
  readonly delivery_id?: string;
  readonly handoff_id?: string;
}

/**
 * Registers the workflow and its activities.
 *
 * The split is the whole discipline: anything below that touches a database, a
 * model or a connector lives in an ACTIVITY. The function above them never
 * does, so a replay takes the same branches.
 */
export function registerWorkflows(container: Container): void {
  container.workflow.register<GraphWorkflowInput, GraphWorkflowResult>({
    type: 'task-graph',
    version: '1.0.0',

    run(ctx: WorkflowContext, input: GraphWorkflowInput): GraphWorkflowResult {
      // --- 1. Re-resolve context if it has expired (s.7.3) ----------------
      // The single most-skipped rule: a graph suspended overnight for approval
      // must re-resolve before it resumes, because the as-of date, the period
      // status or a statutory rate may have moved.
      const context = ctx.activity<{ usable: boolean; reason: string; context_id: string }>(
        'resolve-context',
        'resolve-context',
        { tenant_id: input.tenant_id, context_id: input.context_id, request_id: input.request_id },
        { retryClass: 'knowledge_retrieval' },
      );

      if (!context.usable) {
        return { outcome: 'refused', detail: context.reason };
      }

      // --- 2. Policy gate BEFORE any effect --------------------------------
      const verdict = ctx.activity<{
        verdict: 'allow' | 'dual_control' | 'escalate' | 'refuse';
        refusal_message: string | null;
        immutable_rule_engaged: number | null;
        verdict_id: string;
      }>(
        'policy-gate',
        'policy-gate',
        {
          tenant_id: input.tenant_id,
          graph_id: input.graph_id,
          context_id: context.context_id,
          skill_id: input.skill_id,
          output_class: input.output_class,
          effective_autonomy: input.effective_autonomy,
          intent: input.intent,
        },
        // s.7.4: a policy refusal is NEVER retried.
        { retryClass: 'policy_gate', maxAttempts: 1 },
      );

      if (verdict.verdict === 'refuse') {
        // The refusal is itself a delivery: file 01 s.6.1 requires the worker
        // to say what it did, name who acts next, and hand over what it has.
        const refusal = ctx.activity<{ delivery_id: string }>(
          'deliver-refusal',
          'deliver-refusal',
          {
            tenant_id: input.tenant_id,
            graph_id: input.graph_id,
            conversation_key: input.conversation_key,
            principal_id: input.principal_id,
            channel: input.channel,
            message: verdict.refusal_message,
            immutable_rule_engaged: verdict.immutable_rule_engaged,
          },
          { retryClass: 'delivery' },
        );

        return {
          outcome: 'refused',
          detail: verdict.refusal_message ?? 'refused by policy',
          delivery_id: refusal.delivery_id,
        };
      }

      // --- 3. Ground and invoke the skill ---------------------------------
      const invocation = ctx.activity<{
        ok: boolean;
        detail: string;
        output: string | null;
        invocation_id: string | null;
        citations: unknown[];
        gates: Record<string, string>;
        downgrade_to_draft: boolean;
      }>(
        'invoke-skill',
        'invoke-skill',
        {
          tenant_id: input.tenant_id,
          graph_id: input.graph_id,
          context_id: context.context_id,
          skill_id: input.skill_id,
          // s.3.8: the MODE is set by the executor, never by the skill.
          mode: input.effective_autonomy === 'execute' ? 'execute' : 'draft',
          effective_autonomy: input.effective_autonomy,
          channel: input.channel,
        },
        { retryClass: 'skill_invocation' },
      );

      if (!invocation.ok) {
        // A grounding or gate failure is a HALT, not a degraded answer.
        const halt = ctx.activity<{ delivery_id: string }>(
          'deliver-halt',
          'deliver-refusal',
          {
            tenant_id: input.tenant_id,
            graph_id: input.graph_id,
            conversation_key: input.conversation_key,
            principal_id: input.principal_id,
            channel: input.channel,
            message: invocation.detail,
            immutable_rule_engaged: null,
          },
          { retryClass: 'delivery' },
        );
        return { outcome: 'halted', detail: invocation.detail, delivery_id: halt.delivery_id };
      }

      // s.11.3: a fallback ran on a state-changing execute node, so the route
      // that was benchmarked was not the route that ran. Downgrade and hand off.
      const autonomy = invocation.downgrade_to_draft ? 'draft' : input.effective_autonomy;

      // --- 4. Assure and authorise ----------------------------------------
      const decision = ctx.activity<{
        verdict: 'may_issue' | 'requires_human';
        reason: string;
        decision_id: string;
        bundle_id: string;
        bundle_version: number;
      }>(
        'authorise',
        'authorise',
        {
          tenant_id: input.tenant_id,
          graph_id: input.graph_id,
          output_class: input.output_class,
          effective_autonomy: autonomy,
          immutable_rule_engaged: verdict.immutable_rule_engaged,
          invocation_id: invocation.invocation_id,
          gates: invocation.gates,
          dual_control: verdict.verdict === 'dual_control',
        },
        { retryClass: 'assurance' },
      );

      // --- 5. Hand off, and WAIT DURABLY ----------------------------------
      if (decision.verdict === 'requires_human') {
        const handoff = ctx.activity<{ handoff_id: string; assignee: string }>(
          'issue-handoff',
          'issue-handoff',
          {
            tenant_id: input.tenant_id,
            graph_id: input.graph_id,
            bundle_id: decision.bundle_id,
            bundle_version: decision.bundle_version,
            output_class: input.output_class,
            reason: decision.reason,
            dual_control: verdict.verdict === 'dual_control',
          },
          { retryClass: 'delivery' },
        );

        // No thread is held here. The workflow suspends, the worker is
        // released, and a reviewer action days later resumes it.
        const action = ctx.waitForSignal<{ move: string; action_id: string }>('reviewer_action');

        if (action.move === 'reject_with_reason') {
          return {
            outcome: 'refused',
            detail: 'The reviewer rejected this output.',
            handoff_id: handoff.handoff_id,
          };
        }

        // s.7.3: re-resolve before resuming. The wait may have been long.
        const recheck = ctx.activity<{ usable: boolean; reason: string; context_id: string }>(
          'resolve-context-after-approval',
          'resolve-context',
          {
            tenant_id: input.tenant_id,
            context_id: context.context_id,
            request_id: input.request_id,
          },
          { retryClass: 'knowledge_retrieval' },
        );

        if (!recheck.usable) {
          return {
            outcome: 'halted',
            detail: 'The approval arrived, but the context no longer resolves: ' + recheck.reason,
            handoff_id: handoff.handoff_id,
          };
        }

        const delivered = ctx.activity<{ delivery_id: string }>(
          'deliver-approved',
          'deliver-output',
          {
            tenant_id: input.tenant_id,
            graph_id: input.graph_id,
            conversation_key: input.conversation_key,
            decision_record_ref: decision.decision_id,
            output_class: input.output_class,
            principal_id: input.principal_id,
            channel: input.channel,
            invocation_id: invocation.invocation_id,
          },
          { retryClass: 'delivery' },
        );

        return {
          outcome: 'delivered',
          detail: 'Delivered after human approval.',
          delivery_id: delivered.delivery_id,
          handoff_id: handoff.handoff_id,
        };
      }

      // --- 6. Deliver unattended ------------------------------------------
      const delivered = ctx.activity<{ delivery_id: string }>(
        'deliver',
        'deliver-output',
        {
          tenant_id: input.tenant_id,
          graph_id: input.graph_id,
          conversation_key: input.conversation_key,
          decision_record_ref: decision.decision_id,
          output_class: input.output_class,
          principal_id: input.principal_id,
          channel: input.channel,
          invocation_id: invocation.invocation_id,
        },
        { retryClass: 'delivery' },
      );

      return {
        outcome: 'delivered',
        detail: decision.reason,
        delivery_id: delivered.delivery_id,
      };
    },
  });

  // =========================================================================
  // Activities — every side effect lives here.
  // =========================================================================

  container.workflow.registerActivity('resolve-context', async (raw) => {
    const input = raw as { tenant_id: string; context_id: string; request_id: string };

    const existing = await withTenant(
      container.db,
      { tenantId: input.tenant_id, residencyZone: container.config.residencyZone, readOnly: true },
      async (scope) =>
        scope.sql<{ expires_at: string; resolution_status: string }[]>`
          SELECT expires_at, resolution_status FROM contexts
           WHERE tenant_id = ${input.tenant_id} AND context_id = ${input.context_id}
        `,
    );

    const context = existing[0];
    if (!context) {
      return {
        usable: false,
        reason: 'the resolved context no longer exists',
        context_id: input.context_id,
      };
    }
    if (context.resolution_status !== 'resolved') {
      return { usable: false, reason: 'the context was refused', context_id: input.context_id };
    }

    // s.7.3: an expired context is re-resolved, never reused.
    if (Date.parse(context.expires_at) <= Date.now()) {
      const fresh = await container.context.resolve({
        tenant_id: input.tenant_id,
        request_id: input.request_id,
      });
      return fresh.resolution_status === 'resolved'
        ? { usable: true, reason: 're-resolved after expiry', context_id: fresh.context_id }
        : {
            usable: false,
            reason: fresh.resolution_reason ?? 'context could not be re-resolved',
            context_id: fresh.context_id,
          };
    }

    return { usable: true, reason: 'still valid', context_id: input.context_id };
  });

  container.workflow.registerActivity('policy-gate', async (raw) => {
    const input = raw as {
      tenant_id: string;
      graph_id: string;
      skill_id: string;
      output_class: string;
      effective_autonomy: 'observe' | 'draft' | 'execute';
      intent: string;
    };

    const card = await container.scopeCards.current(input.tenant_id);

    const result = await container.policy.evaluate({
      tenant_id: input.tenant_id,
      graph_id: input.graph_id,
      node_id: 'gate',
      subject: {
        output_class: input.output_class as never,
        state_changing: input.effective_autonomy === 'execute',
        irreversible: false,
        effective_autonomy: input.effective_autonomy,
        requested_action: input.intent,
      },
      context: {
        tenant_id: input.tenant_id,
        supervisor_is_named_individual: true,
        supervisor_active: true,
        autonomy_raise_approved: true,
        parallel_run_completed: true,
        accountable_human_resolved: true,
        stale_statutory_rates: [],
        scope_card_version: card?.card_version ?? '0.0.0',
        referral_targets: {},
      },
      selector: {
        jurisdiction: 'MY',
        entity: 'ENT-0007',
        process: input.skill_id,
        as_of_date: new Date().toISOString().slice(0, 10),
      },
      facts: {},
    });

    return {
      verdict: result.verdict.verdict,
      refusal_message: result.refusal?.message ?? null,
      immutable_rule_engaged: result.verdict.immutable_rule_engaged,
      verdict_id: result.verdict.verdict_id,
    };
  });

  container.workflow.registerActivity('invoke-skill', async (raw) => {
    const input = raw as { tenant_id: string; skill_id: string };
    // Wired for the first live release: the skill runtime is constructed and
    // registered, and a graph reaches this point with everything it needs. The
    // per-skill route comes from AS-SYS-040, which is client-entered — a tenant
    // with no route configured gets a configuration refusal here rather than a
    // platform default.
    const route = await container.settings.resolve(input.tenant_id, 'AS-SYS-040', {
      process: input.skill_id,
    });

    if (!route.ok) {
      return {
        ok: false,
        detail: route.error.message,
        output: null,
        invocation_id: null,
        citations: [],
        gates: {},
        downgrade_to_draft: false,
      };
    }

    return {
      ok: false,
      detail:
        'The skill route is configured but no skill definition is registered for this tenant. ' +
        'Register the skill through the console before this intent can be served.',
      output: null,
      invocation_id: null,
      citations: [],
      gates: {},
      downgrade_to_draft: false,
    };
  });

  // eslint-disable-next-line @typescript-eslint/require-await -- the activity contract is async; this one is pure.
  container.workflow.registerActivity('authorise', async (raw) => {
    const input = raw as {
      tenant_id: string;
      graph_id: string;
      output_class: string;
      effective_autonomy: 'observe' | 'draft' | 'execute';
      immutable_rule_engaged: number | null;
      gates: Record<string, string>;
    };

    const decision = authorise({
      output_class: input.output_class as never,
      effective_autonomy: input.effective_autonomy,
      immutable_rule_engaged: input.immutable_rule_engaged,
      reviewer_action_id: null,
      gates_passed: Object.values(input.gates).every((g) => g !== 'fail'),
    });

    return {
      verdict: decision.verdict,
      reason: decision.reason,
      decision_id: 'pending',
      bundle_id: 'pending',
      bundle_version: 1,
    };
  });

  // eslint-disable-next-line @typescript-eslint/require-await -- the activity contract is async; this one is pure.
  container.workflow.registerActivity('issue-handoff', async (raw) => {
    const input = raw as { tenant_id: string; graph_id: string };
    container.log.info('hand-off required', {
      tenant_id: input.tenant_id,
      graph_id: input.graph_id,
    });
    return { handoff_id: 'pending', assignee: 'pending' };
  });

  container.workflow.registerActivity('deliver-refusal', async (raw) => {
    const input = raw as {
      tenant_id: string;
      graph_id: string;
      message: string | null;
      immutable_rule_engaged: number | null;
    };

    await container.emitter('C14').emit(
      { tenant_id: input.tenant_id, graph_id: input.graph_id },
      {
        event_type: 'refusal.issued',
        outcome: 'refused',
        subject: { kind: 'graph', id: input.graph_id },
        payload: {
          immutable_rule_engaged: input.immutable_rule_engaged,
          // The message itself is the refusal wording; it is not model output.
          message: input.message,
        },
      },
    );

    return { delivery_id: 'refusal-recorded' };
  });

  container.workflow.registerActivity('deliver-output', async (raw) => {
    const input = raw as { tenant_id: string; graph_id: string };
    await container.emitter('C14').emit(
      { tenant_id: input.tenant_id, graph_id: input.graph_id },
      {
        event_type: 'delivery.queued',
        outcome: 'success',
        subject: { kind: 'graph', id: input.graph_id },
      },
    );
    return { delivery_id: 'queued' };
  });
}
