/**
 * Result — an explicit success/refusal type.
 *
 * Most of this system's interesting outcomes are *refusals*, not exceptions:
 * an unresolved context, a policy verdict of `refuse`, a coverage gap, a
 * missing setting. Those are governed outcomes that must be recorded, cited and
 * explained — modelling them as thrown errors makes it too easy to catch and
 * continue, which is exactly the failure mode DWD-06 s.13.3 warns about.
 *
 * Exceptions remain for genuine defects (a broken invariant, an unreachable
 * store). Refusals are values.
 */
import type { WorkerError } from './errors.js';

export type Result<T, E = WorkerError> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const isOk = <T, E>(r: Result<T, E>): r is { ok: true; value: T } => r.ok;
export const isErr = <T, E>(r: Result<T, E>): r is { ok: false; error: E } => !r.ok;

export function map<T, U, E>(r: Result<T, E>, fn: (value: T) => U): Result<U, E> {
  return r.ok ? ok(fn(r.value)) : r;
}

export function mapErr<T, E, F>(r: Result<T, E>, fn: (error: E) => F): Result<T, F> {
  return r.ok ? r : err(fn(r.error));
}

export function andThen<T, U, E>(r: Result<T, E>, fn: (value: T) => Result<U, E>): Result<U, E> {
  return r.ok ? fn(r.value) : r;
}

export function unwrapOr<T, E>(r: Result<T, E>, fallback: T): T {
  return r.ok ? r.value : fallback;
}

/** Throws on refusal. Use only at a boundary that has an error handler above it. */
export function unwrap<T>(r: Result<T, WorkerError>): T {
  if (r.ok) return r.value;
  throw r.error;
}

/** Collect a list of results, failing on the first refusal. */
export function all<T, E>(results: readonly Result<T, E>[]): Result<T[], E> {
  const values: T[] = [];
  for (const r of results) {
    if (!r.ok) return r;
    values.push(r.value);
  }
  return ok(values);
}

/** Partition into successes and refusals — used where partial progress is meaningful. */
export function partition<T, E>(
  results: readonly Result<T, E>[],
): { readonly values: T[]; readonly errors: E[] } {
  const values: T[] = [];
  const errors: E[] = [];
  for (const r of results) {
    if (r.ok) values.push(r.value);
    else errors.push(r.error);
  }
  return { values, errors };
}

export async function fromPromise<T>(
  promise: Promise<T>,
  onError: (e: unknown) => WorkerError,
): Promise<Result<T, WorkerError>> {
  try {
    return ok(await promise);
  } catch (e) {
    return err(onError(e));
  }
}
