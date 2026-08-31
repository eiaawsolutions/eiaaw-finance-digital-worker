/**
 * @eiaaw/context — C3, the L0 Context Resolver.
 *
 * On the critical path of every request, including scheduled and event
 * triggers. There is no privileged path where a job proceeds on a stale or
 * assumed context (DWD-06 s.1.4).
 */
export * from './resolver.js';
