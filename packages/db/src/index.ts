/**
 * @eiaaw/db — the storage model (DWD-06 s.10).
 *
 * Five stores, each with one job, one tenant isolation mechanism applied
 * uniformly, and retention driven by configuration rather than by code.
 *
 * The public surface is deliberately narrow: `withTenant` and
 * `withPlatformScope` are the only ways to reach a connection, so every query
 * in the system runs inside a scope that has declared which tenant it is for.
 */
export * from './client.js';
export * from './migrate.js';
export * from './objects.js';
