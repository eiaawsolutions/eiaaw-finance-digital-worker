/**
 * @eiaaw/planner — C5, the Planner.
 *
 * Compiles the SOP-bound skill into a governed TaskGraph. Idempotency keys are
 * computed here, at compile time, from business identity — never at call time,
 * and never from a timestamp (DWD-06 s.8.1).
 */
export * from './planner.js';
