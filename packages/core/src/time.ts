/**
 * Time — DWD-06 s.2.2.
 *
 *   Timestamps  RFC 3339 with explicit offset, stored UTC. Field names end `_at`.
 *   Dates       `YYYY-MM-DD`. Field names end `_date`.
 *   Periods     `YYYY-MM` or a named fiscal period ID resolved through AS-ORG-FIS-*.
 *   As-of date  Always explicit, never implied by "now".
 *   Duration    ISO 8601 (`PT30M`).
 *
 * The as-of rule is the one with teeth: a scheduled job with a hard-coded or
 * implied as-of date is called out as a red flag in DWD-06 s.1, and a graph
 * resumed after an approval must re-resolve rather than reuse (s.7.3).
 */

export type Timestamp = string; // RFC 3339, e.g. 2026-08-29T02:14:11.221+00:00
export type DateOnly = string; // YYYY-MM-DD
export type Period = string; // YYYY-MM
export type Duration = string; // ISO 8601 duration

export class TimeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TimeError';
  }
}

const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const PERIOD_PATTERN = /^\d{4}-(?:0[1-9]|1[0-2])$/;
const DURATION_PATTERN =
  /^P(?!$)(?:\d+Y)?(?:\d+M)?(?:\d+W)?(?:\d+D)?(?:T(?!$)(?:\d+H)?(?:\d+M)?(?:\d+(?:\.\d+)?S)?)?$/;

export const isTimestamp = (v: string): boolean =>
  TIMESTAMP_PATTERN.test(v) && !isNaN(Date.parse(v));
export const isDateOnly = (v: string): boolean => DATE_PATTERN.test(v) && !isNaN(Date.parse(v));
export const isPeriod = (v: string): boolean => PERIOD_PATTERN.test(v);
export const isDuration = (v: string): boolean => DURATION_PATTERN.test(v);

/**
 * Serialise to the canonical form: UTC with an explicit `+00:00` offset.
 *
 * `toISOString()` renders `Z`. Both are valid RFC 3339 and both are accepted on
 * input, but one form is written so that hashes over serialised contracts are
 * stable — an evidence bundle hash must not depend on which library wrote it.
 */
export function toTimestamp(value: Date | number | string = new Date()): Timestamp {
  const date =
    value instanceof Date ? value : typeof value === 'number' ? new Date(value) : new Date(value);
  if (isNaN(date.getTime())) throw new TimeError(`Not a valid instant: ${String(value)}`);
  return `${date.toISOString().replace(/Z$/, '')}+00:00`;
}

export const now = (): Timestamp => toTimestamp(new Date());

export function parseTimestamp(value: Timestamp): Date {
  if (!isTimestamp(value)) {
    throw new TimeError(
      `Timestamp must be RFC 3339 with an explicit offset, received "${value}". ` +
        'A timestamp without an offset is ambiguous and is rejected at the boundary.',
    );
  }
  return new Date(value);
}

export function toDateOnly(value: Date | Timestamp): DateOnly {
  const date = value instanceof Date ? value : parseTimestamp(value);
  return date.toISOString().slice(0, 10);
}

export function parseDateOnly(value: DateOnly): Date {
  if (!isDateOnly(value)) throw new TimeError(`Date must be YYYY-MM-DD, received "${value}".`);
  return new Date(`${value}T00:00:00.000Z`);
}

export const periodOf = (value: DateOnly): Period => value.slice(0, 7);

export function periodBounds(period: Period): { start_date: DateOnly; end_date: DateOnly } {
  if (!isPeriod(period)) throw new TimeError(`Period must be YYYY-MM, received "${period}".`);
  const [yearRaw, monthRaw] = period.split('-');
  const year = Number(yearRaw);
  const month = Number(monthRaw);
  const start = new Date(Date.UTC(year, month - 1, 1));
  const end = new Date(Date.UTC(year, month, 0)); // day 0 of next month = last of this
  return { start_date: toDateOnly(start), end_date: toDateOnly(end) };
}

/** Inclusive-start, exclusive-null-end range test used by every effective-dating check. */
export function coversDate(
  asOf: DateOnly,
  effectiveFrom: DateOnly,
  effectiveTo: DateOnly | null | undefined,
): boolean {
  if (asOf < effectiveFrom) return false;
  if (effectiveTo === null || effectiveTo === undefined) return true;
  return asOf <= effectiveTo;
}

const DURATION_UNIT_MS: Record<string, number> = {
  Y: 365 * 24 * 3_600_000, // nominal; exact calendar arithmetic uses addMonths
  M: 30 * 24 * 3_600_000,
  W: 7 * 24 * 3_600_000,
  D: 24 * 3_600_000,
  H: 3_600_000,
  MIN: 60_000,
  S: 1_000,
};

/** ISO 8601 duration → milliseconds. Nominal for Y/M; use addMonths for calendar work. */
export function durationToMs(duration: Duration): number {
  if (!isDuration(duration)) {
    throw new TimeError(`Duration must be ISO 8601, e.g. "PT30M", received "${duration}".`);
  }
  const [datePart = '', timePart = ''] = duration.slice(1).split('T');
  let total = 0;
  for (const [, amount, unit] of datePart.matchAll(/(\d+)([YMWD])/g)) {
    total += Number(amount) * (DURATION_UNIT_MS[unit as string] as number);
  }
  for (const [, amount, unit] of timePart.matchAll(/(\d+(?:\.\d+)?)([HMS])/g)) {
    const key = unit === 'M' ? 'MIN' : (unit as string);
    total += Number(amount) * (DURATION_UNIT_MS[key] as number);
  }
  return total;
}

export function addMs(at: Timestamp, ms: number): Timestamp {
  return toTimestamp(parseTimestamp(at).getTime() + ms);
}

export function addDuration(at: Timestamp, duration: Duration): Timestamp {
  return addMs(at, durationToMs(duration));
}

export function addMonths(date: DateOnly, months: number): DateOnly {
  const d = parseDateOnly(date);
  const targetMonth = d.getUTCMonth() + months;
  const candidate = new Date(Date.UTC(d.getUTCFullYear(), targetMonth, d.getUTCDate()));
  // Clamp 31 Jan + 1 month to 28/29 Feb rather than rolling into March.
  if (candidate.getUTCMonth() !== ((targetMonth % 12) + 12) % 12) {
    candidate.setUTCDate(0);
  }
  return toDateOnly(candidate);
}

export const isBefore = (a: Timestamp, b: Timestamp): boolean =>
  parseTimestamp(a).getTime() < parseTimestamp(b).getTime();

export const isAfter = (a: Timestamp, b: Timestamp): boolean =>
  parseTimestamp(a).getTime() > parseTimestamp(b).getTime();

/**
 * A resolved context past `expires_at` must be re-resolved, never reused
 * (DWD-06 s.3.2, s.7.3). This is the check that enforces it.
 */
export const hasExpired = (expiresAt: Timestamp, at: Timestamp = now()): boolean =>
  !isBefore(at, expiresAt);

export const elapsedMs = (from: Timestamp, to: Timestamp = now()): number =>
  parseTimestamp(to).getTime() - parseTimestamp(from).getTime();

/**
 * A deterministic clock for workflow replay.
 *
 * DWD-06 s.9.1: "Workflow code must be deterministic: no clock reads, no random
 * values, no direct I/O." Workflow code takes a Clock; on replay the executor
 * supplies one backed by the recorded history so the same branch is taken.
 */
export interface Clock {
  now(): Timestamp;
  nowMs(): number;
}

export const systemClock: Clock = {
  now: () => now(),
  nowMs: () => Date.now(),
};

export function fixedClock(at: Timestamp): Clock {
  const ms = parseTimestamp(at).getTime();
  return { now: () => at, nowMs: () => ms };
}
