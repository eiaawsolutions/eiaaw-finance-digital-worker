/**
 * The workflow execution context — the deterministic surface workflow code sees.
 *
 * DWD-06 s.9.1 is the whole design brief:
 *
 *   "Workflow code must be deterministic: no clock reads, no random values, no
 *    direct I/O, no model calls. Every non-deterministic input arrives as an
 *    activity result recorded in history. This is what makes replay safe."
 *
 * So workflow code never calls `Date.now()`, `Math.random()`, a database, or a
 * model. It calls `ctx.activity(...)`, `ctx.now()`, `ctx.random()`,
 * `ctx.sleep(...)` and `ctx.waitForSignal(...)` — every one of which is served
 * from recorded history on replay and only actually performed the first time.
 *
 * The mechanism is a deterministic *call-site sequence*. On replay the executor
 * walks the same code path in the same order, so the Nth `activity()` call is
 * matched to the Nth recorded `activity_completed` event. This is why an
 * activity id is derived from a caller-supplied name plus an ordinal, never
 * from a timestamp.
 */
import { type Timestamp, WorkerError, toTimestamp } from '@eiaaw/core';

export interface HistoryEvent {
  readonly sequence_number: number;
  readonly event_type: string;
  readonly activity_id: string | null;
  readonly activity_type: string | null;
  readonly payload: Record<string, unknown>;
  readonly attempt: number;
  readonly recorded_at: string;
}

export interface ActivityOptions {
  /** Retry policy class from DWD-06 s.9.3. */
  readonly retryClass?: RetryClass;
  readonly maxAttempts?: number;
  /** Recorded on the history event so a compensation can find it later. */
  readonly compensation?: {
    readonly tool_id: string;
    readonly compensation_key: string;
    readonly business_key?: string;
  };
}

/** DWD-06 s.9.3 — retry policy per activity class. */
export type RetryClass =
  | 'knowledge_retrieval'
  | 'records_read'
  | 'skill_invocation'
  | 'tool_read'
  | 'tool_state_changing'
  | 'policy_gate'
  | 'assurance'
  | 'delivery'
  | 'compensation';

export interface RetryPolicy {
  readonly initialIntervalMs: number;
  readonly backoffMultiplier: number;
  readonly jitter: boolean;
  readonly maxAttempts: number;
}

export const RETRY_POLICIES: Readonly<Record<RetryClass, RetryPolicy>> = {
  knowledge_retrieval: {
    initialIntervalMs: 1000,
    backoffMultiplier: 2,
    jitter: true,
    maxAttempts: 5,
  },
  records_read: { initialIntervalMs: 2000, backoffMultiplier: 2, jitter: true, maxAttempts: 5 },
  skill_invocation: { initialIntervalMs: 2000, backoffMultiplier: 2, jitter: true, maxAttempts: 3 },
  tool_read: { initialIntervalMs: 2000, backoffMultiplier: 2, jitter: true, maxAttempts: 5 },
  // s.9.3: "Same idempotency key on every attempt; a timeout is resolved by
  // querying the provider by key or reference before retrying."
  tool_state_changing: {
    initialIntervalMs: 5000,
    backoffMultiplier: 2,
    jitter: true,
    maxAttempts: 3,
  },
  policy_gate: { initialIntervalMs: 1000, backoffMultiplier: 2, jitter: false, maxAttempts: 3 },
  assurance: { initialIntervalMs: 2000, backoffMultiplier: 2, jitter: false, maxAttempts: 3 },
  delivery: { initialIntervalMs: 5000, backoffMultiplier: 2, jitter: true, maxAttempts: 5 },
  // s.9.3: "Compensations retry harder than the original, because leaving state
  // applied is worse than trying again."
  compensation: { initialIntervalMs: 5000, backoffMultiplier: 2, jitter: true, maxAttempts: 10 },
};

/**
 * Thrown when workflow code needs something that has not happened yet.
 *
 * Not an error: it is how the workflow yields control. The executor catches it,
 * durably records what is being waited on, releases the worker, and re-runs the
 * workflow from the top when the wait is satisfied.
 */
export class WorkflowSuspension extends Error {
  override readonly name = 'WorkflowSuspension';
  constructor(
    readonly reason: 'activity_pending' | 'timer_pending' | 'signal_pending',
    readonly detail: {
      readonly activity_id?: string;
      readonly activity_type?: string;
      readonly input?: unknown;
      readonly due_at?: Timestamp;
      readonly signal_name?: string;
      readonly retryClass?: RetryClass;
      readonly maxAttempts?: number;
      readonly compensation?: ActivityOptions['compensation'];
    },
  ) {
    // Extends Error only so that it travels like one: a suspension that ever
    // escapes to a top-level handler arrives with a stack instead of as an
    // opaque object. It is still a control-flow signal, not a failure, and the
    // executor treats it as such.
    super(`workflow suspended: ${reason}`);
  }
}

export const isSuspension = (e: unknown): e is WorkflowSuspension =>
  typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'WorkflowSuspension';

/** A permanent activity failure that the workflow chose not to catch. */
export class ActivityFailure extends WorkerError {
  constructor(
    readonly activityType: string,
    readonly failure: { class: string; code: string; message: string; retryable: boolean },
  ) {
    super('internal_error', {
      detail: `Activity "${activityType}" failed permanently: ${failure.message}`,
      failureClass: 'internal',
      retryable: false,
      context: { activity_type: activityType, failure },
    });
    this.name = 'ActivityFailure';
  }
}

export interface WorkflowContextOptions {
  readonly tenantId: string;
  readonly workflowRunId: string;
  readonly graphId: string | null;
  readonly definitionVersion: string;
  readonly history: readonly HistoryEvent[];
  readonly startedAt: Timestamp;
}

/**
 * What workflow code is handed.
 *
 * Every method that could introduce non-determinism is served from history
 * first. If history has the answer, it is returned synchronously; if not, the
 * context throws a suspension and the executor performs the work.
 */
export class WorkflowContext {
  readonly tenantId: string;
  readonly workflowRunId: string;
  readonly graphId: string | null;
  readonly definitionVersion: string;

  readonly #history: readonly HistoryEvent[];
  readonly #startedAt: Timestamp;

  /** Per-name ordinal, so two calls to `activity('gate')` get distinct ids. */
  readonly #callCounts = new Map<string, number>();
  /** Set during a replay pass so the executor knows nothing new was decided. */
  #replaying = true;

  constructor(options: WorkflowContextOptions) {
    this.tenantId = options.tenantId;
    this.workflowRunId = options.workflowRunId;
    this.graphId = options.graphId;
    this.definitionVersion = options.definitionVersion;
    this.#history = options.history;
    this.#startedAt = options.startedAt;
  }

  get isReplaying(): boolean {
    return this.#replaying;
  }

  /**
   * Run an activity, or return its recorded result.
   *
   * `name` must be stable across replays: it is half of the identity that
   * matches this call site to its recorded outcome. A name derived from a
   * timestamp or a random value would match nothing on replay and the activity
   * would run twice.
   */
  activity<T>(
    name: string,
    activityType: string,
    input: unknown,
    options: ActivityOptions = {},
  ): T {
    const activityId = this.#nextActivityId(name);

    const completed = this.#findEvent('activity_completed', activityId);
    if (completed) return completed.payload['result'] as T;

    const failed = this.#findEvent('activity_failed', activityId);
    if (failed) {
      const failure = failed.payload['failure'] as ActivityFailure['failure'];
      throw new ActivityFailure(activityType, failure);
    }

    // Not in history: the executor must perform it.
    this.#replaying = false;
    throw new WorkflowSuspension('activity_pending', {
      activity_id: activityId,
      activity_type: activityType,
      input,
      ...(options.retryClass === undefined ? {} : { retryClass: options.retryClass }),
      ...(options.maxAttempts === undefined ? {} : { maxAttempts: options.maxAttempts }),
      ...(options.compensation === undefined ? {} : { compensation: options.compensation }),
    });
  }

  /**
   * A durable timer.
   *
   * s.7.4 red flag: "An `awaiting_approval` implemented as an in-memory timer."
   * This is not that: the wait is a row, and it survives a process restart, a
   * deploy, and a week of elapsed time.
   */
  sleepUntil(name: string, dueAt: Timestamp): void {
    const timerId = this.#nextActivityId(name);
    if (this.#findEvent('timer_fired', timerId)) return;

    this.#replaying = false;
    throw new WorkflowSuspension('timer_pending', { activity_id: timerId, due_at: dueAt });
  }

  sleep(name: string, ms: number): void {
    this.sleepUntil(name, toTimestamp(Date.parse(this.now()) + ms));
  }

  /**
   * Wait for an external signal — the hand-off wait (s.9.1).
   *
   * "Durable; no thread is held." The workflow suspends, the worker is
   * released, and a reviewer action days later resumes it.
   */
  waitForSignal<T>(signalName: string): T {
    const received = this.#history.find(
      (e) => e.event_type === 'signal_received' && e.payload['signal_name'] === signalName,
    );
    if (received) return received.payload['payload'] as T;

    this.#replaying = false;
    throw new WorkflowSuspension('signal_pending', { signal_name: signalName });
  }

  /** True when the signal has already arrived, without suspending. */
  hasSignal(signalName: string): boolean {
    return this.#history.some(
      (e) => e.event_type === 'signal_received' && e.payload['signal_name'] === signalName,
    );
  }

  /**
   * The deterministic clock.
   *
   * Returns the recorded time of the last history event, not the wall clock, so
   * a replay takes the same branches it took originally. Workflow code that
   * needs the real current time gets it through an activity.
   */
  now(): Timestamp {
    const last = this.#history[this.#history.length - 1];
    return last ? toTimestamp(last.recorded_at) : this.#startedAt;
  }

  /**
   * Deterministic pseudo-randomness, seeded from the run id.
   *
   * Present so workflow code that legitimately needs a jittered choice does not
   * reach for `Math.random()` and silently break replay.
   */
  random(name: string): number {
    const id = this.#nextActivityId(name);
    let hash = 2166136261;
    for (let i = 0; i < id.length; i += 1) {
      hash ^= id.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return ((hash >>> 0) % 1_000_000) / 1_000_000;
  }

  /** A marker recorded in history — for decisions worth seeing in a trace. */
  marker(name: string, data: Record<string, unknown>): void {
    const markerId = this.#nextActivityId(name);
    if (this.#findEvent('marker_recorded', markerId)) return;
    this.#replaying = false;
    throw new WorkflowSuspension('activity_pending', {
      activity_id: markerId,
      activity_type: '__marker__',
      input: data,
    });
  }

  #nextActivityId(name: string): string {
    const ordinal = (this.#callCounts.get(name) ?? 0) + 1;
    this.#callCounts.set(name, ordinal);
    return `${name}#${ordinal}`;
  }

  #findEvent(eventType: string, activityId: string): HistoryEvent | undefined {
    return this.#history.find((e) => e.event_type === eventType && e.activity_id === activityId);
  }
}

export function computeBackoffMs(policy: RetryPolicy, attempt: number, seed = 0.5): number {
  const base = policy.initialIntervalMs * policy.backoffMultiplier ** Math.max(0, attempt - 1);
  if (!policy.jitter) return base;
  // Full jitter, seeded rather than random so a replay computes the same delay.
  return Math.floor(base * (0.5 + seed * 0.5));
}
