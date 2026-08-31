/**
 * Errors — RFC 7807 Problem Details, with the closed error-code list from
 * DWD-06 s.5.6 and the failure-class taxonomy from s.7.4.
 *
 * Two rules from the spec shape this file:
 *
 *   s.5.6 red flag: "A 200 returned for a refused context." Every refusal here
 *   carries a status that a caller cannot mistake for success.
 *
 *   s.13.3: "A configuration refusal is a specific, actionable message: what is
 *   missing, why it is needed, who owns it, and what the requester can do
 *   meanwhile. It is never 'an error occurred'." `ProblemDetails.detail` is the
 *   field that has to carry that, so `configurationMissing` builds it for you.
 */

/** DWD-06 s.5.6 — the closed list. A new code is a MINOR contract change. */
export const ERROR_CODE = {
  contract_invalid: { status: 400, title: 'Payload failed schema validation' },
  auth_failed: { status: 401, title: 'Authentication failed' },
  signature_invalid: { status: 401, title: 'Webhook signature invalid' },
  nonce_invalid: { status: 401, title: 'Approval nonce spent or unknown' },
  authority_insufficient: { status: 403, title: 'Authority insufficient' },
  sod_excluded: { status: 403, title: 'Excluded by segregation of duties' },
  scope_denied: { status: 403, title: 'Permission scope denied' },
  sensitivity_ceiling: { status: 403, title: 'Above the channel sensitivity ceiling' },
  not_found: { status: 404, title: 'Resource not found' },
  duplicate_request: { status: 409, title: 'Duplicate request' },
  stale_bundle_version: { status: 409, title: 'Evidence bundle version is stale' },
  state_conflict: { status: 409, title: 'State conflict' },
  context_unresolved: { status: 412, title: 'L0 context could not be resolved' },
  payload_too_large: { status: 413, title: 'Payload too large' },
  unprocessable_content: { status: 422, title: 'Content could not be processed' },
  attachment_unscanned: { status: 422, title: 'Attachment has not cleared scanning' },
  skill_suspended: { status: 423, title: 'Skill suspended' },
  period_locked: { status: 423, title: 'Accounting period is locked' },
  rate_limited: { status: 429, title: 'Rate limited' },
  residency_violation: { status: 451, title: 'Residency violation' },
  internal_error: { status: 500, title: 'Internal error' },
  dependency_unavailable: { status: 503, title: 'Dependency unavailable' },
} as const;

export type ErrorCode = keyof typeof ERROR_CODE;

/** DWD-06 s.7.4 — behaviour is chosen by class, so the class is on every error. */
export const FAILURE_CLASS = [
  'context', // L0, C3 → graph refused, no retry
  'grounding', // L2, C11/C13 → graph halted, no retry
  'tool', // L6, C10 → retry transient, then compensate
  'policy', // L5/L9, C6 → halt or await approval; NEVER retried
  'model', // rail, C9 → fallback chain, then halt; never a guess
  'budget', // C9/C10 → halt with partial results preserved
  'transport', // channel/provider transport
  'contract', // schema validation
  'configuration', // C16 → refuse, never default
  'internal',
] as const;

export type FailureClass = (typeof FAILURE_CLASS)[number];

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly instance?: string;
  readonly error_code: ErrorCode;
  readonly trace_id?: string;
  readonly failure_class: FailureClass;
  readonly retryable: boolean;
  readonly retry_after_seconds?: number;
  /** Structured extras — a missing axis name, an owning role, a rule id. */
  readonly context?: Readonly<Record<string, unknown>>;
}

const PROBLEM_BASE = 'https://errors.eiaaw.dev/finance-digital-worker';

export interface WorkerErrorOptions {
  readonly detail: string;
  readonly failureClass?: FailureClass;
  readonly retryable?: boolean;
  readonly retryAfterSeconds?: number;
  readonly instance?: string;
  readonly traceId?: string;
  readonly context?: Readonly<Record<string, unknown>>;
  readonly cause?: unknown;
}

export class WorkerError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly failureClass: FailureClass;
  readonly retryable: boolean;
  readonly retryAfterSeconds: number | undefined;
  readonly instance: string | undefined;
  readonly traceId: string | undefined;
  readonly context: Readonly<Record<string, unknown>> | undefined;

  constructor(code: ErrorCode, options: WorkerErrorOptions) {
    super(options.detail, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'WorkerError';
    this.code = code;
    this.status = ERROR_CODE[code].status;
    this.failureClass = options.failureClass ?? inferFailureClass(code);
    this.retryable = options.retryable ?? defaultRetryable(code);
    this.retryAfterSeconds = options.retryAfterSeconds;
    this.instance = options.instance;
    this.traceId = options.traceId;
    this.context = options.context;
  }

  toProblemDetails(): ProblemDetails {
    const base = ERROR_CODE[this.code];
    return {
      type: `${PROBLEM_BASE}/${this.code}`,
      title: base.title,
      status: this.status,
      detail: this.message,
      error_code: this.code,
      failure_class: this.failureClass,
      retryable: this.retryable,
      ...(this.instance === undefined ? {} : { instance: this.instance }),
      ...(this.traceId === undefined ? {} : { trace_id: this.traceId }),
      ...(this.retryAfterSeconds === undefined
        ? {}
        : { retry_after_seconds: this.retryAfterSeconds }),
      ...(this.context === undefined ? {} : { context: this.context }),
    };
  }
}

function inferFailureClass(code: ErrorCode): FailureClass {
  switch (code) {
    case 'context_unresolved':
      return 'context';
    case 'authority_insufficient':
    case 'sod_excluded':
    case 'scope_denied':
    case 'sensitivity_ceiling':
    case 'skill_suspended':
    case 'period_locked':
      return 'policy';
    case 'contract_invalid':
    case 'unprocessable_content':
      return 'contract';
    case 'rate_limited':
    case 'dependency_unavailable':
      return 'transport';
    case 'residency_violation':
      return 'configuration';
    default:
      return 'internal';
  }
}

function defaultRetryable(code: ErrorCode): boolean {
  // DWD-06 s.7.4: "never retry a policy refusal". Everything below 500 that is
  // not explicitly a throttle or an outage is a decision, not a hiccup.
  return code === 'rate_limited' || code === 'dependency_unavailable';
}

export const isWorkerError = (e: unknown): e is WorkerError => e instanceof WorkerError;

// ---------------------------------------------------------------------------
// Constructors for the refusals the spec names explicitly
// ---------------------------------------------------------------------------

/**
 * DWD-06 s.3.2, s.5.6: L0 failed closed. The body names the missing axis —
 * "the reason" is a required field on a refused ResolvedContext, so the caller
 * always learns which axis could not be resolved.
 */
export function contextUnresolved(
  missingAxis: string,
  reason: string,
  extra?: Readonly<Record<string, unknown>>,
): WorkerError {
  return new WorkerError('context_unresolved', {
    detail:
      `Context could not be resolved: ${reason} ` +
      `The unresolved axis is "${missingAxis}". No task may proceed on an unresolved context.`,
    failureClass: 'context',
    retryable: false,
    context: { missing_axis: missingAxis, ...extra },
  });
}

/**
 * DWD-06 s.13.3: names what is missing, why it is needed, who owns it, and what
 * the requester can do meanwhile. Never "an error occurred".
 */
export function configurationMissing(input: {
  readonly settingFamily: string;
  readonly fieldPurpose: string;
  readonly ownerRef: string;
  readonly meanwhile?: string;
}): WorkerError {
  const meanwhile =
    input.meanwhile ??
    'Until it is set, this request cannot be answered and no substitute value will be used.';
  return new WorkerError('contract_invalid', {
    detail:
      `A required configuration value is not set. Missing: ${input.settingFamily}. ` +
      `It is needed to ${input.fieldPurpose}. ` +
      `The owner of this setting is ${input.ownerRef}. ${meanwhile}`,
    failureClass: 'configuration',
    retryable: false,
    context: {
      setting_family: input.settingFamily,
      field_purpose: input.fieldPurpose,
      owner_ref: input.ownerRef,
    },
  });
}

/**
 * DWD-06 s.10.6: a cross-zone read or write refuses with 451. Residency is a
 * PDPA constraint, so this is a legal refusal, not a routing failure.
 */
export function residencyViolation(from: string, to: string): WorkerError {
  return new WorkerError('residency_violation', {
    detail:
      `Refused: a call from residency zone "${from}" to "${to}" would move data across a ` +
      'residency boundary. Cross-zone access is refused rather than proxied.',
    failureClass: 'configuration',
    retryable: false,
    context: { from_zone: from, to_zone: to },
  });
}

/** DWD-06 s.8.3: a duplicate returns the original outcome; it never re-performs. */
export function duplicateRequest(originalRef: string, retryAfterSeconds?: number): WorkerError {
  return new WorkerError('duplicate_request', {
    detail:
      `This request has already been seen. The original outcome is at ${originalRef}. ` +
      'The action was not performed a second time.',
    failureClass: 'contract',
    retryable: false,
    ...(retryAfterSeconds === undefined ? {} : { retryAfterSeconds }),
    context: { original_ref: originalRef },
  });
}

/**
 * DWD-06 s.8.2: a changed payload under a reused key is a defect, never an
 * update. This surfaces it rather than silently applying the new payload.
 */
export function stateConflict(detail: string, extra?: Record<string, unknown>): WorkerError {
  return new WorkerError('state_conflict', {
    detail,
    failureClass: 'contract',
    retryable: false,
    ...(extra === undefined ? {} : { context: extra }),
  });
}

/** DWD-06 s.5.4: an action against a superseded bundle version is rejected. */
export function staleBundleVersion(presented: number, current: number): WorkerError {
  return new WorkerError('stale_bundle_version', {
    detail:
      `This decision was made against evidence bundle version ${presented}, but version ` +
      `${current} is now current. Re-open the hand-off and review the current bundle before acting.`,
    failureClass: 'policy',
    retryable: false,
    context: { presented_version: presented, current_version: current },
  });
}

/** DWD-06 s.6.5: an approval link that works twice is a red flag. */
export function nonceInvalid(reason: 'spent' | 'unknown' | 'expired' | 'mismatched'): WorkerError {
  const explanation = {
    spent: 'This approval has already been used. An approval nonce is single-use.',
    unknown: 'This approval token is not recognised.',
    expired:
      'This approval token has expired with the hand-off SLA. A new hand-off will be issued.',
    mismatched: 'This approval token does not match the bundle version it was issued against.',
  }[reason];
  return new WorkerError('nonce_invalid', {
    detail: explanation,
    failureClass: 'policy',
    retryable: false,
    context: { nonce_state: reason },
  });
}

/**
 * A refusal driven by one of the eleven immutable rules (file 01 s.6.2).
 * Wording follows the fixed pattern in file 01 s.6.3 so that a refusal is
 * recognisable and never reads as a system error.
 */
export function immutableRuleRefusal(input: {
  readonly ruleNumber: number;
  readonly act: string;
  readonly ruleStatement: string;
  readonly whatWasDone: string;
  readonly referralTarget: string;
  readonly whereItSits: string;
  readonly scopeCardVersion: string;
}): WorkerError {
  return new WorkerError('authority_insufficient', {
    detail:
      `I cannot ${input.act}. ${input.ruleStatement}\n` +
      `What I have done: ${input.whatWasDone}.\n` +
      `What happens next: ${input.referralTarget} does this using ${input.whereItSits}.\n` +
      `Reference: Scope Card ${input.scopeCardVersion}, rule ${input.ruleNumber}.`,
    failureClass: 'policy',
    retryable: false,
    context: {
      immutable_rule_engaged: input.ruleNumber,
      referral_target: input.referralTarget,
      scope_card_version: input.scopeCardVersion,
    },
  });
}

/** Normalise anything thrown into a WorkerError without losing the cause. */
export function toWorkerError(
  error: unknown,
  fallbackDetail = 'An unexpected error occurred.',
): WorkerError {
  if (isWorkerError(error)) return error;
  const detail = error instanceof Error ? error.message : fallbackDetail;
  return new WorkerError('internal_error', {
    detail,
    failureClass: 'internal',
    retryable: false,
    cause: error,
  });
}
