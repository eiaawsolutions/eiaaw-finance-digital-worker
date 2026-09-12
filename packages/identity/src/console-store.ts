/**
 * The persistence port for console identity, and an in-memory implementation.
 *
 * The service is written against this interface rather than against SQL so the
 * rules that matter — lockout, single-use links, expiry, refusing to say
 * whether an address exists — are provable without a database. The Postgres
 * adapter then has no logic in it worth testing separately: every decision
 * happens above this line.
 */

export interface DirectoryEntry {
  readonly tenantId: string;
  readonly principalId: string;
}

export interface StoredCredential {
  readonly tenantId: string;
  readonly principalId: string;
  /** Null until the invite is accepted. */
  readonly passwordHash: string | null;
  /** Sealed, never the base32 seed. Null until enrolment issues one. */
  readonly totpSecretSealed: string | null;
  /** Null while a seed exists but has not been proven from the device. */
  readonly totpConfirmedAt: Date | null;
  readonly failedAttempts: number;
  readonly lockedUntil: Date | null;
}

export type InvitePurpose = 'enrolment' | 'password_reset';

export interface StoredInvite {
  readonly tenantId: string;
  readonly tokenHash: string;
  readonly principalId: string;
  readonly purpose: InvitePurpose;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface StoredSession {
  readonly tenantId: string;
  readonly sessionHash: string;
  readonly principalId: string;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export interface ConsoleIdentityStore {
  /** The one cross-tenant lookup: which tenant owns this address. */
  findDirectoryEntry(emailHash: string): Promise<DirectoryEntry | null>;
  /** The address itself, read under tenant scope once the tenant is known. */
  findPrincipalEmail(tenantId: string, principalId: string): Promise<string | null>;

  findCredential(tenantId: string, principalId: string): Promise<StoredCredential | null>;
  setPassword(tenantId: string, principalId: string, hash: string, at: Date): Promise<void>;
  setTotpSecret(tenantId: string, principalId: string, sealed: string): Promise<void>;
  confirmTotp(tenantId: string, principalId: string, at: Date): Promise<void>;
  recordFailure(
    tenantId: string,
    principalId: string,
    attempts: number,
    lockedUntil: Date | null,
  ): Promise<void>;
  clearFailures(tenantId: string, principalId: string, signedInAt: Date): Promise<void>;

  saveInvite(invite: StoredInvite): Promise<void>;
  findInvite(tenantId: string, tokenHash: string): Promise<StoredInvite | null>;
  consumeInvite(tenantId: string, tokenHash: string, at: Date): Promise<void>;

  createSession(session: StoredSession): Promise<void>;
  findSession(tenantId: string, sessionHash: string): Promise<StoredSession | null>;
  touchSession(tenantId: string, sessionHash: string, at: Date): Promise<void>;
  revokeSession(tenantId: string, sessionHash: string, at: Date, reason: string): Promise<void>;
}

const key = (tenantId: string, id: string): string => `${tenantId}/${id}`;

/**
 * For unit tests and local development. Holds no state between processes, which
 * is exactly right for both and exactly wrong for anything else.
 */
export class InMemoryConsoleIdentityStore implements ConsoleIdentityStore {
  readonly directory = new Map<string, DirectoryEntry>();
  readonly emails = new Map<string, string>();
  readonly credentials = new Map<string, StoredCredential>();
  readonly invites = new Map<string, StoredInvite>();
  readonly sessions = new Map<string, StoredSession>();

  /** Enrol a principal for tests: directory entry, address, empty credential. */
  grant(tenantId: string, principalId: string, email: string, emailHash: string): void {
    this.directory.set(emailHash, { tenantId, principalId });
    this.emails.set(key(tenantId, principalId), email);
    this.credentials.set(key(tenantId, principalId), {
      tenantId,
      principalId,
      passwordHash: null,
      totpSecretSealed: null,
      totpConfirmedAt: null,
      failedAttempts: 0,
      lockedUntil: null,
    });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findDirectoryEntry(emailHash: string): Promise<DirectoryEntry | null> {
    return this.directory.get(emailHash) ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findPrincipalEmail(tenantId: string, principalId: string): Promise<string | null> {
    return this.emails.get(key(tenantId, principalId)) ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findCredential(tenantId: string, principalId: string): Promise<StoredCredential | null> {
    return this.credentials.get(key(tenantId, principalId)) ?? null;
  }

  #update(tenantId: string, principalId: string, patch: Partial<StoredCredential>): void {
    const existing = this.credentials.get(key(tenantId, principalId));
    if (!existing) return;
    this.credentials.set(key(tenantId, principalId), { ...existing, ...patch });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async setPassword(tenantId: string, principalId: string, hash: string): Promise<void> {
    this.#update(tenantId, principalId, { passwordHash: hash });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async setTotpSecret(tenantId: string, principalId: string, sealed: string): Promise<void> {
    this.#update(tenantId, principalId, { totpSecretSealed: sealed, totpConfirmedAt: null });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async confirmTotp(tenantId: string, principalId: string, at: Date): Promise<void> {
    this.#update(tenantId, principalId, { totpConfirmedAt: at });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async recordFailure(
    tenantId: string,
    principalId: string,
    attempts: number,
    lockedUntil: Date | null,
  ): Promise<void> {
    this.#update(tenantId, principalId, { failedAttempts: attempts, lockedUntil });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async clearFailures(tenantId: string, principalId: string): Promise<void> {
    this.#update(tenantId, principalId, { failedAttempts: 0, lockedUntil: null });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async saveInvite(invite: StoredInvite): Promise<void> {
    this.invites.set(key(invite.tenantId, invite.tokenHash), invite);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findInvite(tenantId: string, tokenHash: string): Promise<StoredInvite | null> {
    return this.invites.get(key(tenantId, tokenHash)) ?? null;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async consumeInvite(tenantId: string, tokenHash: string, at: Date): Promise<void> {
    const existing = this.invites.get(key(tenantId, tokenHash));
    if (existing) this.invites.set(key(tenantId, tokenHash), { ...existing, consumedAt: at });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async createSession(session: StoredSession): Promise<void> {
    this.sessions.set(key(session.tenantId, session.sessionHash), session);
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async findSession(tenantId: string, sessionHash: string): Promise<StoredSession | null> {
    return this.sessions.get(key(tenantId, sessionHash)) ?? null;
  }

  touchSession(): Promise<void> {
    // Last-seen is telemetry; the fake does not need to model it.
    return Promise.resolve();
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async revokeSession(tenantId: string, sessionHash: string, at: Date): Promise<void> {
    const existing = this.sessions.get(key(tenantId, sessionHash));
    if (existing) this.sessions.set(key(tenantId, sessionHash), { ...existing, revokedAt: at });
  }
}
