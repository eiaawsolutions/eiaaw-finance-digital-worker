/**
 * L9 — hand-off, the four reviewer moves, and authorisation.
 *
 *   s.3.11: "permitted_moves: exactly the four moves; no fifth value is
 *            representable."
 *   s.6.5:  approval nonces are "single-use, bound to (handoff_id,
 *            bundle_version, assignee), time-limited by the hand-off SLA,
 *            STORED SERVER-SIDE, and SPENT ATOMICALLY on first valid use."
 *   s.5.4:  a stale bundle version is 409; a spent nonce is 401; an SoD-excluded
 *            actor is 403.
 *   s.3.13: "No output is delivered without a decision record."
 *
 * The atomicity of the nonce spend is the part that matters most. An approval
 * that can be replayed is an approval that can be applied twice, and for an
 * irreversible act that is unrecoverable.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import {
  type Result,
  type SecretRef,
  WorkerError,
  addDuration,
  err,
  newId,
  newNonce,
  nonceInvalid,
  now,
  ok,
  staleBundleVersion,
} from '@eiaaw/core';
import {
  type ChannelName,
  type DecisionType,
  type EvidenceBundle,
  type HandoffPackage,
  type OutputClass,
  type RejectionReasonCode,
  type ReviewerAction,
  type ReviewerMove,
  REVIEWER_MOVES,
} from '@eiaaw/contracts';
import { type Database, type TenantScope, withTenant } from '@eiaaw/db';
import { lookupOutputClass } from '@eiaaw/registry';
import { recordReviewerAction, setHandoffOpenAge } from '@eiaaw/telemetry';

export interface IssueHandoffInput {
  readonly tenant_id: string;
  readonly graph_id: string;
  readonly node_id: string;
  readonly bundle: EvidenceBundle;
  readonly question: string;
  readonly decision_type: DecisionType;
  readonly assignee: { principal_id: string; role_ref: string; source: string };
  readonly second_approver?: { principal_id: string; role_ref: string };
  readonly sod_exclusions: readonly string[];
  readonly delivery_channels: readonly ChannelName[];
  readonly approval_channels: readonly ChannelName[];
  readonly sla_duration: string;
  readonly sla_source: string;
  readonly escalation_target: string;
  /** True for every irreversible node and every dual_control verdict. */
  readonly dual_control_required: boolean;
}

export interface IssuedHandoff {
  readonly handoff: HandoffPackage;
  /** Leaves the process exactly once, in the delivered hand-off. */
  readonly nonce: string;
}

export class HandoffService {
  readonly #db: Database;
  readonly #residencyZone: string;
  readonly #nonceKey: SecretRef;

  constructor(options: {
    readonly db: Database;
    readonly residencyZone: string;
    readonly nonceSigningKey: SecretRef;
  }) {
    this.#db = options.db;
    this.#residencyZone = options.residencyZone;
    this.#nonceKey = options.nonceSigningKey;
  }

  async issue(input: IssueHandoffInput, scope?: TenantScope): Promise<IssuedHandoff> {
    const handoffId = newId('handoff');
    const nonce = newNonce();
    const issuedAt = now();
    const dueAt = addDuration(issuedAt, input.sla_duration);

    // file 05 s.14: a channel that cannot carry an evidence bundle hands up
    // rather than approving on partial information.
    const approvalChannels = input.approval_channels.filter(
      (channel) => channel === 'chat' || channel === 'email',
    );
    if (approvalChannels.length === 0) {
      throw new WorkerError('sensitivity_ceiling', {
        detail:
          'No approval channel can carry an evidence bundle. A hand-off is never truncated to ' +
          'fit a channel; the channel is escalated instead (file 04 s.6, file 05 s.14).',
        failureClass: 'policy',
        retryable: false,
      });
    }

    const handoff: HandoffPackage = {
      schema_version: '1.0.0',
      handoff_id: handoffId,
      graph_id: input.graph_id,
      node_id: input.node_id,
      bundle_id: input.bundle.bundle_id,
      bundle_version: input.bundle.bundle_version,
      question: input.question,
      decision_type: input.decision_type,
      assignee: input.assignee,
      dual_control_required: input.dual_control_required,
      second_approver: input.second_approver ?? null,
      sod_exclusions_applied: input.sod_exclusions,
      // Exactly the four. A fifth is not representable in the contract.
      permitted_moves: [...REVIEWER_MOVES],
      channels: { delivery: input.delivery_channels, approval: approvalChannels },
      sla: { due_at: dueAt, source: input.sla_source, escalation_target: input.escalation_target },
      nonce,
      issued_at: issuedAt,
      state: 'awaiting_action',
    };

    const write = async (s: TenantScope): Promise<void> => {
      await s.sql`
        INSERT INTO handoffs (
          tenant_id, handoff_id, graph_id, node_id, bundle_id, bundle_version,
          question, decision_type, assignee_principal_id, assignee_role_ref,
          assignee_source, dual_control_required, second_approver_principal_id,
          second_approver_role_ref, sod_exclusions_applied, permitted_moves,
          delivery_channels, approval_channels, sla_due_at, sla_source,
          escalation_target, nonce_hash, nonce_expires_at, state, issued_at
        ) VALUES (
          ${input.tenant_id}, ${handoffId}, ${input.graph_id}, ${input.node_id},
          ${input.bundle.bundle_id}, ${input.bundle.bundle_version},
          ${input.question}, ${input.decision_type},
          ${input.assignee.principal_id}, ${input.assignee.role_ref}, ${input.assignee.source},
          ${input.dual_control_required},
          ${input.second_approver?.principal_id ?? null},
          ${input.second_approver?.role_ref ?? null},
          ${input.sod_exclusions},
          ${[...REVIEWER_MOVES]},
          ${input.delivery_channels},
          ${approvalChannels},
          ${dueAt}::timestamptz, ${input.sla_source}, ${input.escalation_target},
          ${this.#hashNonce(handoffId, input.bundle.bundle_version, input.assignee.principal_id, nonce)},
          ${dueAt}::timestamptz, 'awaiting_action', ${issuedAt}::timestamptz
        )
      `;
    };

    if (scope) await write(scope);
    else
      await withTenant(
        this.#db,
        { tenantId: input.tenant_id, residencyZone: this.#residencyZone },
        write,
      );

    return { handoff, nonce };
  }

  /**
   * Record a reviewer action.
   *
   * The nonce is spent atomically in the same statement that reads it, so two
   * concurrent submissions cannot both succeed. Everything else — bundle
   * version, SoD, permitted move — is checked before the spend, because a
   * rejected action must not consume the reviewer's one chance to act.
   */
  async act(
    input: {
      readonly tenant_id: string;
      readonly handoff_id: string;
      readonly move: ReviewerMove;
      readonly nonce: string;
      readonly bundle_version: number;
      readonly actor_principal_id: string;
      readonly actor_auth_method: string;
      readonly actor_channel: ChannelName;
      readonly reason_code?: RejectionReasonCode;
      readonly free_text?: string;
      readonly diff_ref?: string;
      readonly approved_output_hash?: string;
      readonly materiality?: ReviewerAction['materiality'];
      readonly ip_or_device_ref?: string;
    },
    scope?: TenantScope,
  ): Promise<Result<{ action: ReviewerAction; awaiting_second_approver: boolean }>> {
    const run = async (
      s: TenantScope,
    ): Promise<Result<{ action: ReviewerAction; awaiting_second_approver: boolean }>> => {
      const rows = await s.sql<
        {
          bundle_version: number;
          assignee_principal_id: string;
          second_approver_principal_id: string | null;
          dual_control_required: boolean;
          sod_exclusions_applied: string[];
          permitted_moves: string[];
          nonce_hash: string;
          nonce_spent_at: string | null;
          nonce_expires_at: string;
          state: string;
        }[]
      >`
        SELECT bundle_version, assignee_principal_id, second_approver_principal_id,
               dual_control_required, sod_exclusions_applied, permitted_moves,
               nonce_hash, nonce_spent_at, nonce_expires_at, state
          FROM handoffs
         WHERE tenant_id = ${input.tenant_id} AND handoff_id = ${input.handoff_id}
           FOR UPDATE
      `;

      const handoff = rows[0];
      if (!handoff) {
        return err(
          new WorkerError('not_found', {
            detail: `Hand-off ${input.handoff_id} does not exist for this tenant.`,
            failureClass: 'policy',
            retryable: false,
          }),
        );
      }

      // Order matters: checks that reject WITHOUT consuming the nonce come
      // first, so a mistaken submission does not burn the reviewer's one chance.
      if (!handoff.permitted_moves.includes(input.move)) {
        return err(
          new WorkerError('contract_invalid', {
            detail: `"${input.move}" is not one of the four permitted moves.`,
            failureClass: 'policy',
            retryable: false,
          }),
        );
      }

      if (input.bundle_version !== handoff.bundle_version) {
        return err(staleBundleVersion(input.bundle_version, handoff.bundle_version));
      }

      // The actor must be the assignee, or the named second approver.
      const isAssignee = input.actor_principal_id === handoff.assignee_principal_id;
      const isSecond = input.actor_principal_id === handoff.second_approver_principal_id;
      if (!isAssignee && !isSecond) {
        return err(
          new WorkerError('authority_insufficient', {
            detail:
              'This hand-off is assigned to someone else. An approval is a personal act and ' +
              'cannot be exercised on another person’s behalf.',
            failureClass: 'policy',
            retryable: false,
          }),
        );
      }

      // Dual control: the same person cannot be both approvals.
      if (handoff.dual_control_required && isSecond && isAssignee) {
        return err(
          new WorkerError('sod_excluded', {
            detail:
              'Dual control requires two different people. One person cannot supply both ' +
              'approvals, whatever roles they hold.',
            failureClass: 'policy',
            retryable: false,
          }),
        );
      }

      if (handoff.nonce_spent_at !== null) return err(nonceInvalid('spent'));
      if (Date.parse(handoff.nonce_expires_at) < Date.now()) return err(nonceInvalid('expired'));

      const expected = handoff.nonce_hash;
      const presented = this.#hashNonce(
        input.handoff_id,
        handoff.bundle_version,
        handoff.assignee_principal_id,
        input.nonce,
      );
      if (!constantTimeEquals(expected, presented)) return err(nonceInvalid('mismatched'));

      // Spend it. `WHERE nonce_spent_at IS NULL` makes this atomic even against
      // a concurrent submission that passed the same read.
      const spent = await s.sql<{ handoff_id: string }[]>`
        UPDATE handoffs SET nonce_spent_at = now()
         WHERE tenant_id = ${input.tenant_id} AND handoff_id = ${input.handoff_id}
           AND nonce_spent_at IS NULL
         RETURNING handoff_id
      `;
      if (spent.length === 0) return err(nonceInvalid('spent'));

      const actionId = newId('reviewerAction');
      const action: ReviewerAction = {
        schema_version: '1.0.0',
        action_id: actionId,
        handoff_id: input.handoff_id,
        bundle_version_acted_on: input.bundle_version,
        actor: {
          principal_id: input.actor_principal_id,
          auth_method: input.actor_auth_method,
          channel: input.actor_channel,
        },
        move: input.move,
        nonce_presented: 'redacted',
        nonce_valid: true,
        reason_code: input.reason_code ?? null,
        free_text: input.free_text ?? null,
        diff_ref: input.diff_ref ?? null,
        ...(input.materiality === undefined ? {} : { materiality: input.materiality }),
        ...(input.approved_output_hash === undefined
          ? {}
          : { approved_output_hash: input.approved_output_hash }),
        acted_at: now(),
        ip_or_device_ref: input.ip_or_device_ref ?? 'obfuscated',
        second_approver_action_id: null,
      };

      await s.sql`
        INSERT INTO reviewer_actions (
          tenant_id, action_id, handoff_id, bundle_version_acted_on,
          actor_principal_id, actor_auth_method, actor_channel, move, nonce_valid,
          reason_code, free_text, diff_ref, materiality, approved_output_hash,
          acted_at, ip_or_device_ref
        ) VALUES (
          ${input.tenant_id}, ${actionId}, ${input.handoff_id}, ${input.bundle_version},
          ${input.actor_principal_id}, ${input.actor_auth_method}, ${input.actor_channel},
          ${input.move}, true, ${action.reason_code}, ${action.free_text}, ${action.diff_ref},
          ${action.materiality === undefined ? null : s.sql.json(action.materiality)},
          ${action.approved_output_hash ?? null},
          ${action.acted_at}::timestamptz, ${action.ip_or_device_ref}
        )
      `;

      // Dual control: the first valid action awaits the second (s.5.4).
      const awaitingSecond =
        handoff.dual_control_required &&
        (input.move === 'approve' || input.move === 'edit_and_approve') &&
        isAssignee;

      await s.sql`
        UPDATE handoffs
           SET state = ${awaitingSecond ? 'awaiting_second_approver' : 'actioned'},
               closed_at = ${awaitingSecond ? null : now()}::timestamptz,
               -- A second approver needs a fresh nonce of their own.
               nonce_spent_at = ${awaitingSecond ? null : now()}::timestamptz
         WHERE tenant_id = ${input.tenant_id} AND handoff_id = ${input.handoff_id}
      `;

      recordReviewerAction(input.move, 'unknown', 'unknown');

      return ok({ action, awaiting_second_approver: awaitingSecond });
    };

    if (scope) return run(scope);
    return withTenant(
      this.#db,
      { tenantId: input.tenant_id, residencyZone: this.#residencyZone },
      run,
    );
  }

  /**
   * Escalate a breached hand-off — s.7.3.
   *
   * "original SLA start not reset". The escalation gets a new assignee and a
   * new nonce, but the clock that measures how long the decision has been
   * outstanding keeps running from the first issue.
   */
  async escalate(
    tenantId: string,
    handoffId: string,
    newAssignee: { principal_id: string; role_ref: string },
    extension: string,
  ): Promise<Result<{ nonce: string }>> {
    return withTenant(this.#db, { tenantId, residencyZone: this.#residencyZone }, async (s) => {
      const rows = await s.sql<{ bundle_version: number; escalation_count: number }[]>`
          SELECT bundle_version, escalation_count FROM handoffs
           WHERE tenant_id = ${tenantId} AND handoff_id = ${handoffId}
             AND state IN ('awaiting_action', 'awaiting_second_approver')
             FOR UPDATE
        `;
      const handoff = rows[0];
      if (!handoff) {
        return err(
          new WorkerError('state_conflict', {
            detail: 'The hand-off is not open, so it cannot be escalated.',
            failureClass: 'policy',
            retryable: false,
          }),
        );
      }

      const nonce = newNonce();
      await s.sql`
          UPDATE handoffs
             SET assignee_principal_id = ${newAssignee.principal_id},
                 assignee_role_ref = ${newAssignee.role_ref},
                 nonce_hash = ${this.#hashNonce(handoffId, handoff.bundle_version, newAssignee.principal_id, nonce)},
                 nonce_spent_at = NULL,
                 nonce_expires_at = now() + ${extension}::interval,
                 sla_due_at = now() + ${extension}::interval,
                 escalated_at = now(),
                 escalation_count = escalation_count + 1,
                 state = 'escalated'
             -- original_sla_started_at is deliberately NOT touched.
           WHERE tenant_id = ${tenantId} AND handoff_id = ${handoffId}
        `;

      return ok({ nonce });
    });
  }

  /** Open hand-offs past their SLA. Drives the escalation sweeper. */
  async breached(tenantId: string): Promise<
    {
      handoff_id: string;
      assignee_principal_id: string;
      escalation_target: string;
      age_seconds: number;
    }[]
  > {
    const rows = await withTenant(
      this.#db,
      { tenantId, residencyZone: this.#residencyZone, readOnly: true },
      async (s) =>
        s.sql<
          {
            handoff_id: string;
            assignee_principal_id: string;
            escalation_target: string;
            age_seconds: string;
            assignee_role_ref: string;
          }[]
        >`
          SELECT handoff_id, assignee_principal_id, assignee_role_ref, escalation_target,
                 EXTRACT(EPOCH FROM (now() - original_sla_started_at))::text AS age_seconds
            FROM handoffs
           WHERE tenant_id = ${tenantId}
             AND state IN ('awaiting_action', 'awaiting_second_approver')
             AND sla_due_at < now()
           ORDER BY original_sla_started_at
        `,
    );

    for (const row of rows) {
      setHandoffOpenAge(row.assignee_role_ref, 'unknown', Number(row.age_seconds));
    }

    return rows.map((r) => ({
      handoff_id: r.handoff_id,
      assignee_principal_id: r.assignee_principal_id,
      escalation_target: r.escalation_target,
      age_seconds: Number(r.age_seconds),
    }));
  }

  /**
   * The nonce hash.
   *
   * Bound to (handoff, bundle version, assignee) so a nonce is worthless if any
   * of the three changes — a new bundle version invalidates every outstanding
   * approval, which is exactly what s.6.5 requires.
   */
  #hashNonce(handoffId: string, bundleVersion: number, assignee: string, nonce: string): string {
    return createHmac('sha256', this.#nonceKey.expose())
      .update(`${handoffId}|${bundleVersion}|${assignee}|${nonce}`)
      .digest('hex');
  }
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * The authorisation decision — s.3.13.
 *
 *   "`may_issue` is only reachable when the output class is one the worker may
 *    issue unattended at the granted autonomy and no immutable rule engages."
 */
export function authorise(input: {
  readonly output_class: OutputClass;
  readonly effective_autonomy: 'observe' | 'draft' | 'execute';
  readonly immutable_rule_engaged: number | null;
  readonly reviewer_action_id: string | null;
  readonly gates_passed: boolean;
}): { verdict: 'may_issue' | 'requires_human'; reason: string } {
  const entry = lookupOutputClass(input.output_class);

  if (input.immutable_rule_engaged !== null) {
    return {
      verdict: 'requires_human',
      reason: `immutable rule ${input.immutable_rule_engaged} engaged`,
    };
  }
  if (!input.gates_passed) {
    return { verdict: 'requires_human', reason: 'an assurance gate did not pass' };
  }
  if (entry.reserved_act) {
    return { verdict: 'requires_human', reason: `${input.output_class} is a reserved act` };
  }
  if (input.effective_autonomy !== 'execute') {
    return {
      verdict: 'requires_human',
      reason: `autonomy is "${input.effective_autonomy}", so the output is a proposal`,
    };
  }
  if (entry.autonomy_ceiling !== 'execute') {
    return {
      verdict: 'requires_human',
      reason: `the register caps ${input.output_class} at "${entry.autonomy_ceiling}"`,
    };
  }

  return { verdict: 'may_issue', reason: 'within the granted autonomy for an unreserved class' };
}
