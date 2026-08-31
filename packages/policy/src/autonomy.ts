/**
 * Autonomy computation — file 05 s.3.5, DWD-06 s.3.5.
 *
 *   effective_autonomy = min(platform_ceiling, as_scp_grant, immutable cap)
 *
 * and the result is recorded as `autonomy_basis` on the TaskGraph so the
 * computation is auditable after the fact rather than re-derived from memory.
 *
 * Three collapse conditions apply on top of the minimum (DWD-06 s.13.3):
 *
 *   - "The autonomy grant is absent → Treat as Observe (the documented
 *      default), and say so."
 *   - "The named supervisor is absent, inactive or a leaver → Collapse autonomy
 *      to Observe, log and notify."
 *   - a skill pending revalidation runs at its interim ceiling (file 05 s.7.4).
 */
import { AUTONOMY_RANK, type AutonomyLevel } from '@eiaaw/contracts';

export interface AutonomyInputs {
  /** From the output-class register — the highest any row producing it may hold. */
  readonly platform_ceiling: AutonomyLevel;
  /** From the skill definition's max_autonomy. */
  readonly skill_ceiling: AutonomyLevel;
  /** From AS-SCP-020 for this row. `null` means no grant recorded. */
  readonly as_scp_grant: AutonomyLevel | null;
  readonly supervisor_ref: string | null;
  readonly supervisor_is_named_individual: boolean;
  readonly supervisor_active: boolean;
  readonly autonomy_raise_approved: boolean;
  readonly parallel_run_completed: boolean;
  readonly accountable_human_resolved: boolean;
  /** file 05 s.7.4 — while a revalidation is pending. */
  readonly revalidation_pending: boolean;
  readonly revalidation_interim_ceiling?: AutonomyLevel;
  /** file 05 s.9.4 — the pull-back rule lowers by one level on a floor breach. */
  readonly accuracy_floor_breached: boolean;
}

export interface AutonomyDecision {
  readonly effective: AutonomyLevel;
  readonly basis: {
    readonly platform_ceiling: AutonomyLevel;
    readonly as_scp_grant: AutonomyLevel;
    readonly supervisor_ref: string | null;
    readonly supervisor_active: boolean;
  };
  /** Every constraint that reduced the level, in the order applied. */
  readonly reductions: readonly {
    readonly from: AutonomyLevel;
    readonly to: AutonomyLevel;
    readonly because: string;
  }[];
  /** Stated to the requester when the level is lower than the grant. */
  readonly explanation: string | null;
}

const lower = (a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel =>
  AUTONOMY_RANK[a] <= AUTONOMY_RANK[b] ? a : b;

const oneLevelDown = (level: AutonomyLevel): AutonomyLevel =>
  level === 'execute' ? 'draft' : 'observe';

export function computeAutonomy(inputs: AutonomyInputs): AutonomyDecision {
  const reductions: { from: AutonomyLevel; to: AutonomyLevel; because: string }[] = [];

  // s.13.3: an absent grant is Observe, and the worker says so.
  const grant = inputs.as_scp_grant ?? 'observe';
  if (inputs.as_scp_grant === null) {
    reductions.push({
      from: 'observe',
      to: 'observe',
      because:
        'no autonomy grant is recorded for this row at AS-SCP-020, so it runs at the ' +
        'documented default of Observe',
    });
  }

  let level = lower(lower(inputs.platform_ceiling, inputs.skill_ceiling), grant);

  if (AUTONOMY_RANK[level] < AUTONOMY_RANK[grant]) {
    reductions.push({
      from: grant,
      to: level,
      because:
        AUTONOMY_RANK[inputs.platform_ceiling] < AUTONOMY_RANK[grant]
          ? 'the output-class register caps this class below the granted level'
          : 'the skill definition caps this skill below the granted level',
    });
  }

  const apply = (to: AutonomyLevel, because: string): void => {
    if (AUTONOMY_RANK[to] < AUTONOMY_RANK[level]) {
      reductions.push({ from: level, to, because });
      level = to;
    }
  };

  // Immutable rule 8. A role, mailbox or team is not a supervisor.
  if (level !== 'observe' && !inputs.supervisor_is_named_individual) {
    apply(
      'observe',
      'the supervisor for this row does not resolve to a named individual (immutable rule 8)',
    );
  }
  if (level !== 'observe' && !inputs.supervisor_active) {
    apply(
      'observe',
      'the named supervisor for this row is inactive or has left (immutable rule 8)',
    );
  }

  // Immutable rule 9. Both records, or no raise.
  if (level !== 'observe' && !(inputs.autonomy_raise_approved && inputs.parallel_run_completed)) {
    apply(
      'observe',
      'the raise is missing its dated written approval or its completed parallel run ' +
        '(immutable rule 9)',
    );
  }

  // Immutable rule 11. No accountable human, no output class.
  if (level !== 'observe' && !inputs.accountable_human_resolved) {
    apply('observe', 'no accountable human resolves for this output class (immutable rule 11)');
  }

  // file 05 s.9.4 — the pull-back rule.
  if (inputs.accuracy_floor_breached && level !== 'observe') {
    apply(
      oneLevelDown(level),
      'the measured accuracy for this skill is below its floor, so it is pulled back one level',
    );
  }

  // file 05 s.7.4 — pending revalidation.
  if (inputs.revalidation_pending) {
    apply(
      inputs.revalidation_interim_ceiling ?? 'observe',
      'this skill is awaiting revalidation after a dependency change',
    );
  }

  const explanation =
    AUTONOMY_RANK[level] < AUTONOMY_RANK[grant] || inputs.as_scp_grant === null
      ? reductions.map((r) => r.because).join('; ')
      : null;

  return {
    effective: level,
    basis: {
      platform_ceiling: lower(inputs.platform_ceiling, inputs.skill_ceiling),
      as_scp_grant: grant,
      supervisor_ref: inputs.supervisor_ref,
      supervisor_active: inputs.supervisor_active && inputs.supervisor_is_named_individual,
    },
    reductions,
    explanation,
  };
}

/**
 * The service-class algorithm from file 01 s.5.2, evaluated at Plan and
 * re-evaluated before Execute.
 *
 *   "Any condition failing on the EXECUTE branch degrades the output to
 *    PREPARE. Degradation is silent to the outcome but explicit in the record
 *    and in the message to the human."
 */
export type ServiceClass = 'ANSWER' | 'PREPARE' | 'EXECUTE';

export interface ServiceClassInputs {
  readonly effect: 'none' | 'proposed' | 'state_changing';
  readonly autonomy: AutonomyLevel;
  readonly limits_satisfied: boolean;
  readonly reversible_or_compensatable: boolean;
  readonly reserved_act_touched: boolean;
}

export interface ServiceClassDecision {
  readonly serviceClass: ServiceClass;
  readonly degraded: boolean;
  readonly reason: string | null;
}

export function classifyService(inputs: ServiceClassInputs): ServiceClassDecision {
  if (inputs.effect === 'none') {
    return { serviceClass: 'ANSWER', degraded: false, reason: null };
  }

  if (inputs.effect === 'proposed') {
    // PREPARE requires >= Draft-for-review (file 01 s.5.1).
    if (inputs.autonomy === 'observe') {
      return {
        serviceClass: 'PREPARE',
        degraded: true,
        reason:
          'this row is at Observe, so I can flag but not prepare. The item is returned ' +
          'for a human to produce.',
      };
    }
    return { serviceClass: 'PREPARE', degraded: false, reason: null };
  }

  // effect === 'state_changing' — every condition must hold, or degrade.
  const failures: string[] = [];
  if (inputs.autonomy !== 'execute') failures.push('this row is not set to Execute');
  if (!inputs.limits_satisfied) failures.push('a configured limit is not satisfied');
  if (!inputs.reversible_or_compensatable) {
    failures.push('the action is neither reversible nor compensatable');
  }
  if (inputs.reserved_act_touched) failures.push('the action touches a reserved act');

  if (failures.length === 0) {
    return { serviceClass: 'EXECUTE', degraded: false, reason: null };
  }

  return {
    serviceClass: 'PREPARE',
    degraded: true,
    reason: `I prepared this rather than completing it, because ${failures.join(', and ')}.`,
  };
}
