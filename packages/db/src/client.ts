/**
 * Database client and the tenant-scoped transaction.
 *
 * DWD-06 s.10.6 names four layers of tenant isolation. Two of them live here:
 *
 *   Query:  "A repository layer that cannot construct a query without a tenant
 *            predicate; a missing predicate is a compile-time or startup failure."
 *   Data:   row-level security, enforced by the database (migration 0008).
 *
 * The mechanism is `withTenant`: it opens a transaction, sets `app.tenant_id`
 * for that transaction only, and hands the caller a `TenantScope`. Every
 * repository method takes a `TenantScope` and cannot be called without one, so
 * "forgot the tenant predicate" is not a mistake the type system permits. If
 * one slipped through anyway, RLS would return zero rows rather than another
 * tenant's data.
 */
import postgres, { type Sql, type TransactionSql } from 'postgres';
import { WorkerError, type SecretRef } from '@eiaaw/core';

export type Database = Sql;
export type Transaction = TransactionSql;

export interface DatabaseOptions {
  readonly url: SecretRef | string;
  readonly poolMax: number;
  readonly ssl: boolean;
  readonly applicationName?: string;
  readonly statementTimeoutMs?: number;
}

export function createDatabase(options: DatabaseOptions): Database {
  const url = typeof options.url === 'string' ? options.url : options.url.expose();

  return postgres(url, {
    max: options.poolMax,
    ssl: options.ssl ? 'require' : false,
    // postgres.js parses timestamptz into Date by default. We want the RFC 3339
    // string form the contracts use, so a value never round-trips through a
    // local-timezone Date and back (DWD-06 s.2.2).
    types: {
      date: {
        to: 1184,
        from: [1082, 1114, 1184],
        serialize: (value: Date | string) =>
          value instanceof Date ? value.toISOString() : String(value),
        parse: (value: string) => value,
      },
    },
    connection: {
      application_name: options.applicationName ?? 'eiaaw-fdw',
      // A runaway query holds a connection the workflow executor needs.
      statement_timeout: options.statementTimeoutMs ?? 30_000,
    },
    onnotice: () => undefined,
    transform: { undefined: null },
  });
}

/**
 * A handle proving the caller has established a tenant context.
 *
 * It cannot be constructed outside this module: `withTenant` is the only way to
 * obtain one. That is what makes "a query without a tenant predicate" a
 * compile-time impossibility rather than a code-review responsibility.
 */
declare const TenantScopeBrand: unique symbol;

export interface TenantScope {
  readonly [TenantScopeBrand]: true;
  readonly tenantId: string;
  readonly residencyZone: string;
  readonly sql: Transaction;
}

export interface TenantScopeOptions {
  readonly tenantId: string;
  readonly residencyZone: string;
  /** Set the transaction read-only. Used by the audit query API (s.5.5). */
  readonly readOnly?: boolean;
  /** Serializable for the append paths that must not interleave. */
  readonly isolation?: 'read committed' | 'repeatable read' | 'serializable';
}

/**
 * Run `fn` inside a transaction scoped to one tenant.
 *
 * `SET LOCAL` scopes the GUC to this transaction, so a pooled connection
 * handed to the next caller carries no residue. A `SET` without `LOCAL` here
 * would leak one tenant's scope into another's query — the exact failure RLS
 * exists to make impossible.
 */
export async function withTenant<T>(
  db: Database,
  options: TenantScopeOptions,
  fn: (scope: TenantScope) => Promise<T>,
): Promise<T> {
  if (!/^tnt_[a-z0-9][a-z0-9_-]{1,62}$/.test(options.tenantId)) {
    throw new WorkerError('contract_invalid', {
      detail:
        `"${options.tenantId}" is not a valid tenant_id. A malformed tenant id must ` +
        'never reach a SET LOCAL, because that is where an injection would land.',
      failureClass: 'internal',
      retryable: false,
    });
  }
  if (!/^[a-z0-9-]{1,64}$/.test(options.residencyZone)) {
    throw new WorkerError('contract_invalid', {
      detail: `"${options.residencyZone}" is not a valid residency zone.`,
      failureClass: 'configuration',
      retryable: false,
    });
  }

  return db.begin(async (sql) => {
    if (options.isolation) {
      await sql.unsafe(`SET TRANSACTION ISOLATION LEVEL ${options.isolation.toUpperCase()}`);
    }
    if (options.readOnly === true) {
      await sql.unsafe('SET TRANSACTION READ ONLY');
    }

    // Drop to the unprivileged role for the life of this transaction.
    //
    // Managed Postgres hands the application a schema-owning role that usually
    // carries BYPASSRLS, and a connection made as that role ignores every
    // policy. `SET LOCAL ROLE` sheds those attributes so row-level security is
    // actually in force. Without this line, tenant isolation would be enforced
    // by the application alone — which DWD-06 s.10.6 explicitly rejects.
    await sql.unsafe('SET LOCAL ROLE app_worker');

    // Parameterised, so the tenant id cannot be interpolated into SQL text.
    await sql`SELECT set_config('app.tenant_id', ${options.tenantId}, true)`;
    await sql`SELECT set_config('app.residency_zone', ${options.residencyZone}, true)`;

    const scope = {
      tenantId: options.tenantId,
      residencyZone: options.residencyZone,
      sql,
    } as unknown as TenantScope;

    return fn(scope);
  }) as Promise<T>;
}

/**
 * Platform-scoped work: the registries, the settings catalogue, the shared
 * corpus. Deliberately separate and deliberately awkward to reach — nothing
 * tenant-scoped may be read through it, because RLS will return nothing.
 */
export async function withPlatformScope<T>(
  db: Database,
  fn: (sql: Transaction) => Promise<T>,
): Promise<T> {
  return db.begin(async (sql) => fn(sql)) as Promise<T>;
}

export async function closeDatabase(db: Database): Promise<void> {
  await db.end({ timeout: 5 });
}

export interface HealthResult {
  readonly ok: boolean;
  readonly latencyMs: number;
  readonly error?: string;
}

export async function checkDatabaseHealth(db: Database): Promise<HealthResult> {
  const started = Date.now();
  try {
    await db`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - started };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : 'unknown',
    };
  }
}

/**
 * Postgres error codes this codebase reacts to by name rather than by message.
 * `23505` and `40001` in particular drive idempotency and workflow retry paths.
 */
export const PG_ERROR = {
  uniqueViolation: '23505',
  foreignKeyViolation: '23503',
  checkViolation: '23514',
  notNullViolation: '23502',
  serializationFailure: '40001',
  deadlockDetected: '40P01',
  insufficientPrivilege: '42501',
} as const;

export function isPgError(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as { code?: unknown }).code === code
  );
}

export const isUniqueViolation = (e: unknown): boolean => isPgError(e, PG_ERROR.uniqueViolation);
export const isSerializationFailure = (e: unknown): boolean =>
  isPgError(e, PG_ERROR.serializationFailure) || isPgError(e, PG_ERROR.deadlockDetected);

/**
 * An append-only table refused an UPDATE or DELETE.
 *
 * Surfaced distinctly because it is never a transient fault to retry: it means
 * a code path tried to mutate the audit log, an evidence bundle, a decision
 * record or a reviewer action, and that is a defect to fix, not a blip.
 */
export function isAppendOnlyViolation(error: unknown): boolean {
  return (
    isPgError(error, PG_ERROR.insufficientPrivilege) &&
    typeof error === 'object' &&
    error !== null &&
    'message' in error &&
    String((error as { message?: unknown }).message).includes('append-only')
  );
}
