/**
 * The eleven immutable rules — file 01 s.6.2.
 *
 *   "Eleven platform rules are not configurable by anyone; each has a defined
 *    refusal behaviour, a defined referral target and a defined record, so a
 *    refusal is a governed act rather than a silence."
 *
 *   "A refusal is never overridden by any human instruction in any channel
 *    (AS-SCP-026). A human with the authority to do the act does the act
 *    themselves; they cannot instruct the worker to do it for them."
 *
 * These live in code, not in configuration, and that is the point. A rule read
 * from `settings_values` is a rule a tenant can edit, and the register exists
 * precisely because these must not be editable. The AS- entries that mirror
 * them (AS-DOA-001, AS-SCP-002, AS-SCP-014, AS-SCP-026) are there for register
 * completeness; the engine reads from here.
 *
 * Defence in depth is mandatory (file 01 s.7.3): every reserved act must be
 * blocked at L6 by permission scope AND at L5 by this engine AND at L9 by the
 * register. "A reserved act protected by policy alone is treated as unprotected."
 */
import type { AutonomyLevel, ImmutableRuleNumber, OutputClass } from '@eiaaw/contracts';

/** What the worker is being asked to do, in terms the rules can test. */
export interface RuleSubject {
  readonly output_class: OutputClass | null;
  /** The registry tool about to be invoked, if any. */
  readonly tool_id?: string | null;
  readonly permission_scope?: string | null;
  readonly state_changing: boolean;
  readonly irreversible: boolean;
  readonly effective_autonomy: AutonomyLevel;
  /** The action verb the requester used, normalised by intake. */
  readonly requested_action?: string | null;
  readonly recipient_external?: boolean;
  /** Fields the action would write, for the payment-destination rule. */
  readonly fields_written?: readonly string[];
}

/** The governance facts the rules read. */
export interface RuleContext {
  readonly tenant_id: string;
  /** AS-SCP-008. A role, a mailbox or a team is not a supervisor. */
  readonly supervisor_is_named_individual: boolean;
  readonly supervisor_active: boolean;
  /** AS-SCP-010. Both must exist before a raised level may be used. */
  readonly autonomy_raise_approved: boolean;
  readonly parallel_run_completed: boolean;
  /** AS-PPL-010. Absence blocks the output class entirely. */
  readonly accountable_human_resolved: boolean;
  /** Immutable rule 10. Any statutory rate past its verification horizon. */
  readonly stale_statutory_rates: readonly string[];
  readonly scope_card_version: string;
  /** Where a refusal should send the requester, resolved from AS-PPL-*. */
  readonly referral_targets: Readonly<Partial<Record<ImmutableRuleNumber, string>>>;
}

export interface RuleEngagement {
  readonly rule: ImmutableRuleNumber;
  readonly statement: string;
  /** The act the worker is declining, phrased for the refusal message. */
  readonly act: string;
  readonly referral_target: string;
  readonly what_was_done: string;
  readonly where_it_sits: string;
  readonly layer: string;
  readonly as_reference: string;
}

export interface ImmutableRule {
  readonly number: ImmutableRuleNumber;
  readonly name: string;
  readonly statement: string;
  readonly defaultReferralTarget: string;
  readonly asReference: string;
  readonly layer: string;
  /** Returns the engagement when the rule bites, else null. */
  evaluate(subject: RuleSubject, context: RuleContext): Omit<RuleEngagement, keyof RuleMeta> | null;
}

type RuleMeta = Pick<
  RuleEngagement,
  'rule' | 'statement' | 'referral_target' | 'layer' | 'as_reference'
>;

/** Output classes each rule guards, from the reserved-acts register (file 01 s.7.2). */
const RESERVED_BY_RULE: Readonly<Partial<Record<ImmutableRuleNumber, readonly OutputClass[]>>> = {
  2: ['payment_release'],
  3: ['statutory_filing_submission', 'statutory_contribution_schedule'],
  4: ['payroll_approval_and_release'],
  5: ['reconciliation_certification'],
  6: ['payment_destination_masterdata_change'],
  7: ['external_communication'],
};

/**
 * Verbs that mean "record an approval". Matched on the *requested action*, which
 * intake normalises — a rule that only checked output class would miss
 * "just mark it approved so the queue clears" (file 01 s.6.4, red flags).
 */
const APPROVAL_VERBS =
  /\b(approve|approved|approving|sign[- ]?off|signoff|authorise|authorize|certify|certified|endorse)\b/i;

const RELEASE_VERBS = /\b(release|transmit|remit|pay out|disburse|execute the payment)\b/i;
const SUBMIT_VERBS = /\b(submit|file|lodge|transmit to (?:lhdn|the authority|the portal))\b/i;

/** Fields that redirect money. Rule 6 guards these by name, not by table. */
const PAYMENT_DESTINATION_FIELDS = [
  'bank_account_number',
  'iban',
  'swift',
  'bic',
  'payee_name',
  'settlement_instruction',
  'ewallet_id',
  'beneficiary_account',
];

const rule = (r: ImmutableRule): ImmutableRule => r;

export const IMMUTABLE_RULES: readonly ImmutableRule[] = [
  rule({
    number: 1,
    name: 'never_an_approver',
    statement: 'I hold no approval right in any delegation of authority.',
    defaultReferralTarget: 'the approver named in AS-DOA- for this item class',
    asReference: 'AS-SCP-002, AS-DOA-001',
    layer: 'L9',
    evaluate(subject) {
      const asked = subject.requested_action ?? '';
      if (!APPROVAL_VERBS.test(asked)) return null;
      return {
        act: 'approve this, or record an approval on anyone’s behalf',
        what_was_done:
          'prepared the item and re-presented it for the named approver, with its evidence',
        where_it_sits: 'the approval queue, unchanged',
      };
    },
  }),

  rule({
    number: 2,
    name: 'never_releases_payment',
    statement: 'Releasing a payment is reserved to the bank mandate signatories.',
    defaultReferralTarget: 'the bank mandate signatories named in AS-DOA-',
    asReference: 'file 01 s.6.2 rule 2',
    layer: 'L9',
    evaluate(subject) {
      const guarded = RESERVED_BY_RULE[2] ?? [];
      const byClass = subject.output_class !== null && guarded.includes(subject.output_class);
      const byVerb =
        RELEASE_VERBS.test(subject.requested_action ?? '') &&
        /\b(payment|bank|transfer|remittance|giro|rtgs)\b/i.test(subject.requested_action ?? '');
      const byScope = /^(?:payment|bank):(?:release|transmit|authorise)$/.test(
        subject.permission_scope ?? '',
      );
      if (!byClass && !byVerb && !byScope) return null;
      return {
        act: 'release this payment or transmit it to the bank',
        what_was_done:
          'prepared the payment proposal, validated it against the controls and flagged ' +
          'every anomaly. The file stops here',
        where_it_sits: 'the retained payment proposal and its validation evidence',
      };
    },
  }),

  rule({
    number: 3,
    name: 'never_submits_statutory_filing',
    statement: 'A statutory submission carries a personal declaration, so it remains a human act.',
    defaultReferralTarget: 'the licensed or authorised human submitter; the tax lead at AS-PPL-',
    asReference: 'file 01 s.6.2 rule 3',
    layer: 'L9',
    evaluate(subject) {
      const guarded = RESERVED_BY_RULE[3] ?? [];
      const byClass = subject.output_class !== null && guarded.includes(subject.output_class);
      const byVerb =
        SUBMIT_VERBS.test(subject.requested_action ?? '') &&
        /\b(return|filing|form|declaration|sst|gst|cp204|e-?invoice|contribution)\b/i.test(
          subject.requested_action ?? '',
        );
      const byScope = /^(?:tax|einvoice|statutory):(?:submit|transmit)$/.test(
        subject.permission_scope ?? '',
      );
      if (!byClass && !byVerb && !byScope) return null;
      return {
        act: 'submit this filing to the authority',
        what_was_done:
          'prepared the computation, the workings and the submission payload, and ran the ' +
          'pre-submission validations',
        where_it_sits: 'the retained payload, validation results and reconciliation to the books',
      };
    },
  }),

  rule({
    number: 4,
    name: 'never_approves_payroll',
    statement: 'Approving a payroll run and releasing its payment are reserved human acts.',
    defaultReferralTarget:
      'the payroll approver at AS-PPL-, and the treasury approver for the payment side',
    asReference: 'file 01 s.6.2 rule 4',
    layer: 'L9',
    evaluate(subject) {
      const guarded = RESERVED_BY_RULE[4] ?? [];
      const byClass = subject.output_class !== null && guarded.includes(subject.output_class);
      const byVerb =
        APPROVAL_VERBS.test(subject.requested_action ?? '') &&
        /\bpayroll\b/i.test(subject.requested_action ?? '');
      if (!byClass && !byVerb) return null;
      return {
        act: 'approve this payroll run or release its payment file',
        what_was_done:
          'computed, validated and reconciled the payroll, and reported every variance',
        where_it_sits: 'the retained payroll pack and its variance analysis',
      };
    },
  }),

  rule({
    number: 5,
    name: 'never_certifies_a_reconciliation',
    statement: 'Certifying a reconciliation is an assertion only a human may make.',
    defaultReferralTarget: 'the reconciliation certifier named in AS-DOA-',
    asReference: 'file 01 s.6.2 rule 5',
    layer: 'L9',
    evaluate(subject) {
      const guarded = RESERVED_BY_RULE[5] ?? [];
      const byClass = subject.output_class !== null && guarded.includes(subject.output_class);

      const asked = subject.requested_action ?? '';
      // Two shapes, because operators use both: the verb ("certify this"), and
      // the state assertion ("mark the bank reconciliation cleared"). The
      // second is the more common phrasing and the easier one to miss — the
      // words between "mark" and the state can be arbitrary.
      const certifyVerb = /\b(?:certify|certified|certifying|sign[- ]?off|signoff)\b/i.test(asked);
      const markAsDone =
        /\bmark\b[^.!?]{0,48}?\b(?:complete|completed|cleared|signed|certified|done)\b/i.test(
          asked,
        );
      const byVerb = (certifyVerb || markAsDone) && /\brecon(?:ciliation)?s?\b/i.test(asked);

      if (!byClass && !byVerb) return null;
      return {
        act: 'certify this reconciliation, or mark it complete, cleared or signed',
        what_was_done:
          'performed the matching, aged the unmatched items and proposed a classification ' +
          'for every break',
        where_it_sits: 'the prepared reconciliation with its break analysis',
      };
    },
  }),

  rule({
    number: 6,
    name: 'never_changes_payment_destination',
    statement:
      'Any field that redirects money is changed by a human under dual control, never by me.',
    defaultReferralTarget:
      'the master data approver at AS-DOA-, with the dual-control second person',
    asReference: 'file 01 s.6.2 rule 6',
    layer: 'L9',
    evaluate(subject) {
      const guarded = RESERVED_BY_RULE[6] ?? [];
      const byClass = subject.output_class !== null && guarded.includes(subject.output_class);
      const byField = (subject.fields_written ?? []).some((field) =>
        PAYMENT_DESTINATION_FIELDS.includes(field.toLowerCase()),
      );
      const byScope = /^md:(?:write|update)$/.test(subject.permission_scope ?? '') && byField;
      if (!byClass && !byField && !byScope) return null;
      return {
        act: 'create or amend a field that changes where money is sent',
        what_was_done:
          'prepared a change request with the supporting evidence, and reported any ' +
          'mismatch I detected',
        where_it_sits: 'the change request package awaiting dual control',
      };
    },
  }),

  rule({
    number: 7,
    name: 'never_sends_external_communication',
    statement: 'Nothing leaves the tenant without a named human approving it first.',
    defaultReferralTarget: 'the approver for this communication class at AS-DOA-',
    asReference: 'file 01 s.6.2 rule 7',
    layer: 'L9',
    evaluate(subject) {
      const guarded = RESERVED_BY_RULE[7] ?? [];
      const byClass = subject.output_class !== null && guarded.includes(subject.output_class);
      const byRecipient = subject.recipient_external === true;
      if (!byClass && !byRecipient) return null;
      return {
        act: 'send this to a recipient outside the tenant',
        what_was_done: 'drafted the message and named the approver',
        where_it_sits: 'the held draft and its approval request',
      };
    },
  }),

  rule({
    number: 8,
    name: 'supervisor_must_be_a_named_individual',
    statement:
      'Any autonomy above Observe requires a named, active individual supervisor — not a ' +
      'role, a mailbox or a team.',
    defaultReferralTarget: 'the manager of record and the accountable owner',
    asReference: 'AS-SCP-008, AS-SCP-009',
    layer: 'L9',
    evaluate(subject, context) {
      if (subject.effective_autonomy === 'observe') return null;
      if (context.supervisor_is_named_individual && context.supervisor_active) return null;

      const why = !context.supervisor_is_named_individual
        ? 'the supervisor for this row does not resolve to a named individual'
        : 'the named supervisor for this row is inactive or has left';

      return {
        act: `act at ${subject.effective_autonomy} level on this row`,
        what_was_done: `treated the row as Observe and raised a configuration defect, because ${why}`,
        where_it_sits: 'the configuration defect queue, with every affected item marked Observe',
      };
    },
  }),

  rule({
    number: 9,
    name: 'autonomy_raise_needs_approval_and_parallel_run',
    statement:
      'A raised autonomy level requires both a dated written approval and a completed ' +
      'parallel run. I cannot request, apply or approve my own raise.',
    defaultReferralTarget: 'the accountable owner and the process approver',
    asReference: 'AS-SCP-010, AS-SCP-014',
    layer: 'L9',
    evaluate(subject, context) {
      if (subject.effective_autonomy === 'observe') return null;
      if (context.autonomy_raise_approved && context.parallel_run_completed) return null;

      const missing = [
        context.autonomy_raise_approved ? null : 'the dated written approval',
        context.parallel_run_completed ? null : 'the completed parallel run',
      ]
        .filter(Boolean)
        .join(' and ');

      return {
        act: `act at ${subject.effective_autonomy} level on this row`,
        what_was_done: `blocked the raise, because ${missing} is not recorded against it`,
        where_it_sits: 'the blocked change record',
      };
    },
  }),

  rule({
    number: 10,
    name: 'stale_statutory_rate_halts',
    statement:
      'Where a statutory rate I rely on is past its verification horizon, I halt. I do not ' +
      'interpolate, carry forward, average, or use a prior-period rate.',
    defaultReferralTarget: 'the tax lead at AS-PPL-, and the research and freshness owner',
    asReference: 'file 01 s.6.2 rule 10',
    layer: 'L0/L2',
    evaluate(_subject, context) {
      if (context.stale_statutory_rates.length === 0) return null;
      return {
        act: 'proceed using a statutory rate that is past its verification horizon',
        what_was_done:
          'halted at the point of use and stated exactly which rate and effective date I ' +
          `need: ${context.stale_statutory_rates.join(', ')}`,
        where_it_sits: 'the halt record and the escalation naming the rate required',
      };
    },
  }),

  rule({
    number: 11,
    name: 'accountability_rests_with_a_named_human',
    statement:
      'Accountability for this output rests with a named human and cannot be delegated to me.',
    defaultReferralTarget: 'the accountable human for this output class',
    asReference: 'file 01 s.6.2 rule 11',
    layer: 'L9',
    evaluate(subject, context) {
      if (subject.output_class === null) return null;
      if (context.accountable_human_resolved) return null;
      return {
        act: 'deliver this output class with no accountable human named',
        what_was_done:
          'refused to deliver, because every output must name the human who is accountable ' +
          'for it and none resolves for this class',
        where_it_sits: 'the blocked output, pending an AS-PPL- assignment',
      };
    },
  }),
];

export const RULES_BY_NUMBER: ReadonlyMap<ImmutableRuleNumber, ImmutableRule> = new Map(
  IMMUTABLE_RULES.map((r) => [r.number, r]),
);

export interface RuleEvaluation {
  readonly engaged: RuleEngagement | null;
  readonly evaluated: readonly ImmutableRuleNumber[];
}

/**
 * Evaluate all eleven, in order, and return the first engagement.
 *
 * Every rule is evaluated and recorded as evaluated even after one engages, so
 * the PolicyVerdict's `immutable_rules_evaluated` is truthful — an audit should
 * be able to see that all eleven were considered, not just the one that bit.
 */
export function evaluateImmutableRules(subject: RuleSubject, context: RuleContext): RuleEvaluation {
  const evaluated: ImmutableRuleNumber[] = [];
  let engaged: RuleEngagement | null = null;

  for (const r of IMMUTABLE_RULES) {
    evaluated.push(r.number);
    const outcome = r.evaluate(subject, context);
    if (outcome && engaged === null) {
      engaged = {
        ...outcome,
        rule: r.number,
        statement: r.statement,
        referral_target: context.referral_targets[r.number] ?? r.defaultReferralTarget,
        layer: r.layer,
        as_reference: r.asReference,
      };
    }
  }

  return { engaged, evaluated };
}

/**
 * Render a refusal in the fixed pattern from file 01 s.6.3.
 *
 *   "The refusal never apologises for the rule, never offers a workaround, and
 *    never suggests that a different phrasing would succeed."
 */
export function renderRefusal(engagement: RuleEngagement, scopeCardVersion: string): string {
  return [
    `I cannot ${engagement.act}. ${engagement.statement}`,
    `What I have done: ${engagement.what_was_done}.`,
    `What happens next: ${engagement.referral_target} does this using ${engagement.where_it_sits}.`,
    `Reference: Scope Card ${scopeCardVersion}, rule ${engagement.rule}.`,
  ].join('\n');
}
