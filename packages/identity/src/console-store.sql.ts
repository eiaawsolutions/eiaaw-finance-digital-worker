/**
 * The Postgres adapter behind `ConsoleIdentityStore`.
 *
 * Deliberately decision-free. Every rule — lockout thresholds, expiry,
 * single-use, what a failure is allowed to reveal — lives in
 * `ConsoleAuthService` and is tested against the in-memory store. This file
 * only moves rows, so there is nothing here that can be wrong in an
 * interesting way.
 *
 * One thing is load-bearing: which scope each query runs in. `console_directory`
 * is the single cross-tenant table and uses the platform scope. Everything else
 * runs inside `withTenant`, which is what puts RLS in force — the tenant comes
 * from the credential the caller presented, so a forged prefix selects a
 * context where the row does not exist rather than one where it belongs to
 * somebody else.
 */
import { type Database, type TenantScope, withPlatformScope, withTenant } from '@eiaaw/db';
import type {
  ConsoleIdentityStore,
  DirectoryEntry,
  InvitePurpose,
  StoredCredential,
  StoredInvite,
  StoredSession,
} from './console-store.js';

interface DirectoryRow {
  readonly tenant_id: string;
  readonly principal_id: string;
}

interface CredentialRow {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly password_hash: string | null;
  readonly totp_secret_sealed: string | null;
  readonly totp_confirmed_at: Date | null;
  readonly failed_attempts: number;
  readonly locked_until: Date | null;
}

interface InviteRow {
  readonly tenant_id: string;
  readonly token_hash: string;
  readonly principal_id: string;
  readonly purpose: InvitePurpose;
  readonly expires_at: Date;
  readonly consumed_at: Date | null;
}

interface SessionRow {
  readonly tenant_id: string;
  readonly session_hash: string;
  readonly principal_id: string;
  readonly expires_at: Date;
  readonly revoked_at: Date | null;
}

export class SqlConsoleIdentityStore implements ConsoleIdentityStore {
  readonly #db: Database;
  readonly #residencyZone: string;

  constructor(db: Database, residencyZone: string) {
    this.#db = db;
    this.#residencyZone = residencyZone;
  }

  #scope<T>(tenantId: string, fn: (sql: TenantScope['sql']) => Promise<T>): Promise<T> {
    return withTenant(this.#db, { tenantId, residencyZone: this.#residencyZone }, async (scope) =>
      fn(scope.sql),
    );
  }

  async findDirectoryEntry(emailHash: string): Promise<DirectoryEntry | null> {
    // The one query with no tenant to run in: it is what supplies one.
    return withPlatformScope(this.#db, async (sql) => {
      const rows = await sql<DirectoryRow[]>`
        SELECT tenant_id, principal_id FROM console_directory WHERE email_hash = ${emailHash}
      `;
      const row = rows[0];
      return row ? { tenantId: row.tenant_id, principalId: row.principal_id } : null;
    });
  }

  async findPrincipalEmail(tenantId: string, principalId: string): Promise<string | null> {
    return this.#scope(tenantId, async (sql) => {
      const rows = await sql<{ primary_email: string | null }[]>`
        SELECT primary_email FROM principals
         WHERE tenant_id = ${tenantId} AND principal_id = ${principalId}
      `;
      return rows[0]?.primary_email ?? null;
    });
  }

  async findCredential(tenantId: string, principalId: string): Promise<StoredCredential | null> {
    return this.#scope(tenantId, async (sql) => {
      const rows = await sql<CredentialRow[]>`
        SELECT tenant_id, principal_id, password_hash, totp_secret_sealed,
               totp_confirmed_at, failed_attempts, locked_until
          FROM console_credentials
         WHERE tenant_id = ${tenantId} AND principal_id = ${principalId}
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        tenantId: row.tenant_id,
        principalId: row.principal_id,
        passwordHash: row.password_hash,
        totpSecretSealed: row.totp_secret_sealed,
        totpConfirmedAt: row.totp_confirmed_at,
        failedAttempts: row.failed_attempts,
        lockedUntil: row.locked_until,
      };
    });
  }

  async setPassword(tenantId: string, principalId: string, hash: string, at: Date): Promise<void> {
    await this.#scope(tenantId, async (sql) => {
      await sql`
        UPDATE console_credentials
           SET password_hash = ${hash}, password_set_at = ${at},
               failed_attempts = 0, locked_until = NULL, updated_at = now()
         WHERE tenant_id = ${tenantId} AND principal_id = ${principalId}
      `;
    });
  }

  async setTotpSecret(tenantId: string, principalId: string, sealed: string): Promise<void> {
    await this.#scope(tenantId, async (sql) => {
      // Confirmation is cleared with the seed: a new seed has not been proven
      // from a device yet, whatever the old one had established.
      await sql`
        UPDATE console_credentials
           SET totp_secret_sealed = ${sealed}, totp_confirmed_at = NULL, updated_at = now()
         WHERE tenant_id = ${tenantId} AND principal_id = ${principalId}
      `;
    });
  }

  async confirmTotp(tenantId: string, principalId: string, at: Date): Promise<void> {
    await this.#scope(tenantId, async (sql) => {
      await sql`
        UPDATE console_credentials
           SET totp_confirmed_at = ${at}, updated_at = now()
         WHERE tenant_id = ${tenantId} AND principal_id = ${principalId}
      `;
    });
  }

  async recordFailure(
    tenantId: string,
    principalId: string,
    attempts: number,
    lockedUntil: Date | null,
  ): Promise<void> {
    await this.#scope(tenantId, async (sql) => {
      await sql`
        UPDATE console_credentials
           SET failed_attempts = ${attempts}, locked_until = ${lockedUntil}, updated_at = now()
         WHERE tenant_id = ${tenantId} AND principal_id = ${principalId}
      `;
    });
  }

  async clearFailures(tenantId: string, principalId: string, signedInAt: Date): Promise<void> {
    await this.#scope(tenantId, async (sql) => {
      await sql`
        UPDATE console_credentials
           SET failed_attempts = 0, locked_until = NULL,
               last_sign_in_at = ${signedInAt}, updated_at = now()
         WHERE tenant_id = ${tenantId} AND principal_id = ${principalId}
      `;
    });
  }

  async saveInvite(invite: StoredInvite): Promise<void> {
    await this.#scope(invite.tenantId, async (sql) => {
      // Supersede any outstanding invite for this principal. Two live links to
      // the same account means revoking one leaves the other working.
      await sql`
        UPDATE console_invites SET consumed_at = now()
         WHERE tenant_id = ${invite.tenantId} AND principal_id = ${invite.principalId}
           AND consumed_at IS NULL
      `;
      await sql`
        INSERT INTO console_invites (tenant_id, token_hash, principal_id, purpose, expires_at)
        VALUES (${invite.tenantId}, ${invite.tokenHash}, ${invite.principalId},
                ${invite.purpose}, ${invite.expiresAt})
      `;
    });
  }

  async findInvite(tenantId: string, tokenHash: string): Promise<StoredInvite | null> {
    return this.#scope(tenantId, async (sql) => {
      const rows = await sql<InviteRow[]>`
        SELECT tenant_id, token_hash, principal_id, purpose, expires_at, consumed_at
          FROM console_invites
         WHERE tenant_id = ${tenantId} AND token_hash = ${tokenHash}
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        tenantId: row.tenant_id,
        tokenHash: row.token_hash,
        principalId: row.principal_id,
        purpose: row.purpose,
        expiresAt: row.expires_at,
        consumedAt: row.consumed_at,
      };
    });
  }

  async consumeInvite(tenantId: string, tokenHash: string, at: Date): Promise<void> {
    await this.#scope(tenantId, async (sql) => {
      await sql`
        UPDATE console_invites SET consumed_at = ${at}
         WHERE tenant_id = ${tenantId} AND token_hash = ${tokenHash} AND consumed_at IS NULL
      `;
    });
  }

  async createSession(session: StoredSession): Promise<void> {
    await this.#scope(session.tenantId, async (sql) => {
      await sql`
        INSERT INTO console_sessions (tenant_id, session_hash, principal_id, expires_at)
        VALUES (${session.tenantId}, ${session.sessionHash}, ${session.principalId},
                ${session.expiresAt})
      `;
    });
  }

  async findSession(tenantId: string, sessionHash: string): Promise<StoredSession | null> {
    return this.#scope(tenantId, async (sql) => {
      const rows = await sql<SessionRow[]>`
        SELECT tenant_id, session_hash, principal_id, expires_at, revoked_at
          FROM console_sessions
         WHERE tenant_id = ${tenantId} AND session_hash = ${sessionHash}
      `;
      const row = rows[0];
      if (!row) return null;
      return {
        tenantId: row.tenant_id,
        sessionHash: row.session_hash,
        principalId: row.principal_id,
        expiresAt: row.expires_at,
        revokedAt: row.revoked_at,
      };
    });
  }

  async touchSession(tenantId: string, sessionHash: string, at: Date): Promise<void> {
    await this.#scope(tenantId, async (sql) => {
      await sql`
        UPDATE console_sessions SET last_seen_at = ${at}
         WHERE tenant_id = ${tenantId} AND session_hash = ${sessionHash}
      `;
    });
  }

  async revokeSession(
    tenantId: string,
    sessionHash: string,
    at: Date,
    reason: string,
  ): Promise<void> {
    await this.#scope(tenantId, async (sql) => {
      await sql`
        UPDATE console_sessions SET revoked_at = ${at}, revoked_reason = ${reason}
         WHERE tenant_id = ${tenantId} AND session_hash = ${sessionHash} AND revoked_at IS NULL
      `;
    });
  }
}
