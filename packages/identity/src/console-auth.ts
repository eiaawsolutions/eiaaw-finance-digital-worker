/**
 * Console sign-in: enrolment, password, second factor, session.
 *
 * Written against a store port rather than SQL, so the rules below are provable
 * without a database and the Postgres adapter carries no decisions of its own.
 *
 * TWO PROPERTIES THIS FILE EXISTS TO HOLD
 *
 * 1. Every sign-in failure looks identical from outside. Unknown address, no
 *    console access, enrolment never completed, wrong password, locked out —
 *    one message, one shape. A form that answers differently for a real address
 *    than a fictional one is an account-enumeration oracle, and the first thing
 *    an attacker does with a finance console is find out who can sign in to it.
 *    The real reason is recorded for the operator; it is not returned.
 *
 * 2. A credential carries its own tenant. Session cookies and invite links are
 *    `tnt_x.<random>`, so the tenant context can be set before the lookup and
 *    the row is read under RLS like everything else. Editing the prefix does not
 *    widen access — it selects a context in which the row does not exist.
 */
import { randomBytes } from 'node:crypto';
import { WorkerError, sha256 } from '@eiaaw/core';
import type { EmailSender } from '@eiaaw/email';
import { enrolmentEmail, passwordResetEmail } from '@eiaaw/email';
import { type ChallengePurpose, signChallenge, verifyChallenge } from './challenge.js';
import type { ConsoleIdentityStore, StoredCredential } from './console-store.js';
import { assertPasswordAcceptable, hashPassword, verifyPassword } from './password.js';
import { openSecret, sealSecret } from './sealing.js';
import { generateTotpSecret, otpauthUri, verifyTotp } from './totp.js';

const TENANT_PATTERN = /^tnt_[a-z0-9][a-z0-9_-]{1,62}$/;
const SECRET_BYTES = 32;

export interface ConsoleAuthConfig {
  /** Shown in emails and in the authenticator app entry. */
  readonly consoleName: string;
  /** Origin the enrolment link points at, without a trailing slash. */
  readonly consoleBaseUrl: string;
  readonly sealingKey: Buffer;
  readonly challengeKey: Buffer;
  readonly inviteTtlMinutes: number;
  readonly sessionTtlHours: number;
  readonly maxFailedAttempts: number;
  readonly lockoutMinutes: number;
}

export const CONSOLE_AUTH_DEFAULTS = {
  inviteTtlMinutes: 60,
  sessionTtlHours: 12,
  maxFailedAttempts: 5,
  lockoutMinutes: 15,
} as const;

export interface ConsoleAuthDeps {
  readonly store: ConsoleIdentityStore;
  readonly email: EmailSender;
  readonly now: () => Date;
}

export interface PendingSecondFactor {
  readonly challenge: string;
  readonly purpose: ChallengePurpose;
  /** Present only while enrolling: the QR payload for the authenticator app. */
  readonly otpauthUri?: string;
  readonly totpSecret?: string;
}

export interface OpenedSession {
  /** The cookie value. Shown once; only its digest is stored. */
  readonly cookie: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly expiresAt: Date;
}

export interface ResolvedSession {
  readonly tenantId: string;
  readonly principalId: string;
  readonly expiresAt: Date;
}

/** The single outward-facing sign-in failure. See property 1 above. */
function signInRefused(): WorkerError {
  return new WorkerError('authority_insufficient', {
    detail:
      'Those sign-in details were not accepted. If you have not set a password yet, ' +
      'use the first-time link on the sign-in page.',
    failureClass: 'policy',
    retryable: false,
  });
}

function linkRefused(reason: string): WorkerError {
  return new WorkerError('authority_insufficient', {
    detail: reason,
    failureClass: 'policy',
    retryable: false,
  });
}

export const emailHash = (email: string): string => sha256(email.trim().toLowerCase());

/** `tnt_x.<random>` — the tenant travels with the credential. */
function mintScoped(tenantId: string): { value: string; hash: string } {
  const value = `${tenantId}.${randomBytes(SECRET_BYTES).toString('base64url')}`;
  return { value, hash: sha256(value) };
}

function splitScoped(value: string): { tenantId: string; hash: string } | null {
  const dot = value.indexOf('.');
  if (dot <= 0) return null;
  const tenantId = value.slice(0, dot);
  if (!TENANT_PATTERN.test(tenantId)) return null;
  return { tenantId, hash: sha256(value) };
}

export class ConsoleAuthService {
  readonly #config: ConsoleAuthConfig;
  readonly #store: ConsoleIdentityStore;
  readonly #email: EmailSender;
  readonly #now: () => Date;

  constructor(config: ConsoleAuthConfig, deps: ConsoleAuthDeps) {
    this.#config = config;
    this.#store = deps.store;
    this.#email = deps.email;
    this.#now = deps.now;
  }

  /**
   * Send a first-time or reset link.
   *
   * Returns nothing in every case, including when the address is unknown. The
   * caller says "if that address has console access, a link is on its way" and
   * means it literally — that sentence is true whether or not one was sent, and
   * it is the only honest thing that does not also answer "does this person
   * have an account here".
   */
  async requestEnrolmentLink(email: string): Promise<void> {
    const entry = await this.#store.findDirectoryEntry(emailHash(email));
    if (!entry) return;

    const credential = await this.#store.findCredential(entry.tenantId, entry.principalId);
    // No credential row means console access was never granted or was revoked.
    if (!credential) return;

    const address = await this.#store.findPrincipalEmail(entry.tenantId, entry.principalId);
    if (!address) return;

    const now = this.#now();
    const minted = mintScoped(entry.tenantId);
    const purpose = credential.passwordHash === null ? 'enrolment' : 'password_reset';

    await this.#store.saveInvite({
      tenantId: entry.tenantId,
      tokenHash: minted.hash,
      principalId: entry.principalId,
      purpose,
      expiresAt: new Date(now.getTime() + this.#config.inviteTtlMinutes * 60_000),
      consumedAt: null,
    });

    const link = `${this.#config.consoleBaseUrl}/set-password?token=${encodeURIComponent(minted.value)}`;
    const template = purpose === 'enrolment' ? enrolmentEmail : passwordResetEmail;

    await this.#email.send(
      template({
        to: address,
        link,
        expiresInMinutes: this.#config.inviteTtlMinutes,
        consoleName: this.#config.consoleName,
      }),
    );
  }

  /**
   * First factor. On success the caller holds a challenge, not a session: the
   * password alone opens nothing.
   */
  async signInWithPassword(email: string, password: string): Promise<PendingSecondFactor> {
    const entry = await this.#store.findDirectoryEntry(emailHash(email));
    if (!entry) throw signInRefused();

    const credential = await this.#store.findCredential(entry.tenantId, entry.principalId);
    if (!credential) throw signInRefused();

    const now = this.#now();

    // Checked before the password, so a locked account does not keep burning
    // scrypt time for whoever is guessing at it.
    if (credential.lockedUntil !== null && credential.lockedUntil > now) throw signInRefused();

    // Enrolment never completed. Indistinguishable from a wrong password by
    // design; the first-time link is how someone in this state proceeds.
    if (credential.passwordHash === null) throw signInRefused();

    if (!(await verifyPassword(password, credential.passwordHash))) {
      await this.#recordFailure(credential, now);
      throw signInRefused();
    }

    await this.#store.clearFailures(entry.tenantId, entry.principalId, now);

    // A password set but a factor never proven means enrolment was interrupted
    // between the two steps. Resume it rather than refusing.
    const purpose: ChallengePurpose =
      credential.totpConfirmedAt === null ? 'awaiting_totp_enrolment' : 'awaiting_totp';

    return this.#pending(entry.tenantId, entry.principalId, purpose, credential);
  }

  /** Second factor for an already-enrolled principal. */
  async completeSignIn(challenge: string, code: string): Promise<OpenedSession> {
    const payload = verifyChallenge(challenge, this.#config.challengeKey, this.#now().getTime());
    if (payload.purpose !== 'awaiting_totp') throw signInRefused();

    const credential = await this.#store.findCredential(payload.tenantId, payload.principalId);
    if (!credential?.totpSecretSealed || credential.totpConfirmedAt === null) throw signInRefused();

    const now = this.#now();
    if (
      !verifyTotp(
        openSecret(credential.totpSecretSealed, this.#config.sealingKey),
        code,
        now.getTime(),
      )
    ) {
      await this.#recordFailure(credential, now);
      throw signInRefused();
    }

    await this.#store.clearFailures(payload.tenantId, payload.principalId, now);
    return this.#openSession(payload.tenantId, payload.principalId, now);
  }

  /**
   * Accept a first-time or reset link and choose a password.
   *
   * Issues a fresh authenticator seed every time, including on a reset. The
   * seed is stored unconfirmed: it becomes usable only once a code generated
   * from the device proves the QR was actually scanned, so a half-finished
   * enrolment cannot leave an account reachable by password alone.
   */
  async acceptInvite(token: string, newPassword: string): Promise<PendingSecondFactor> {
    const scoped = splitScoped(token);
    if (!scoped) throw linkRefused('That link is not valid. Request a new one.');

    const invite = await this.#store.findInvite(scoped.tenantId, scoped.hash);
    if (!invite) throw linkRefused('That link is not valid. Request a new one.');

    const now = this.#now();
    if (invite.consumedAt !== null) {
      throw linkRefused(
        'That link has already been used. Request a new one — each link works once, ' +
          'so a copy left in an inbox cannot be replayed later.',
      );
    }
    if (invite.expiresAt <= now) {
      throw linkRefused('That link has expired. Request a new one.');
    }

    // Throws with the specific reason: this is the person's own password field,
    // and "not accepted" without saying why is a dead end.
    assertPasswordAcceptable(newPassword);

    const hash = await hashPassword(newPassword);
    await this.#store.setPassword(invite.tenantId, invite.principalId, hash, now);
    await this.#store.consumeInvite(invite.tenantId, scoped.hash, now);

    const secret = generateTotpSecret();
    await this.#store.setTotpSecret(
      invite.tenantId,
      invite.principalId,
      sealSecret(secret, this.#config.sealingKey),
    );

    const address = await this.#store.findPrincipalEmail(invite.tenantId, invite.principalId);

    return {
      challenge: this.#challengeFor(invite.tenantId, invite.principalId, 'awaiting_totp_enrolment'),
      purpose: 'awaiting_totp_enrolment',
      totpSecret: secret,
      otpauthUri: otpauthUri({
        secret,
        account: address ?? invite.principalId,
        issuer: this.#config.consoleName,
      }),
    };
  }

  /** Prove the authenticator was set up, and open the first session. */
  async confirmEnrolment(challenge: string, code: string): Promise<OpenedSession> {
    const payload = verifyChallenge(challenge, this.#config.challengeKey, this.#now().getTime());
    if (payload.purpose !== 'awaiting_totp_enrolment') throw signInRefused();

    const credential = await this.#store.findCredential(payload.tenantId, payload.principalId);
    if (!credential?.totpSecretSealed) throw signInRefused();

    const now = this.#now();
    if (
      !verifyTotp(
        openSecret(credential.totpSecretSealed, this.#config.sealingKey),
        code,
        now.getTime(),
      )
    ) {
      throw linkRefused(
        'That code was not accepted. Check the six digits currently shown in your ' +
          'authenticator app, and that your device clock is set automatically.',
      );
    }

    await this.#store.confirmTotp(payload.tenantId, payload.principalId, now);
    await this.#store.clearFailures(payload.tenantId, payload.principalId, now);
    return this.#openSession(payload.tenantId, payload.principalId, now);
  }

  async resolveSession(cookie: string): Promise<ResolvedSession | null> {
    const scoped = splitScoped(cookie);
    if (!scoped) return null;

    const session = await this.#store.findSession(scoped.tenantId, scoped.hash);
    if (!session || session.revokedAt !== null) return null;

    const now = this.#now();
    if (session.expiresAt <= now) return null;

    await this.#store.touchSession(scoped.tenantId, scoped.hash, now);

    return {
      tenantId: session.tenantId,
      principalId: session.principalId,
      expiresAt: session.expiresAt,
    };
  }

  async signOut(cookie: string, reason = 'signed out'): Promise<void> {
    const scoped = splitScoped(cookie);
    if (!scoped) return;
    await this.#store.revokeSession(scoped.tenantId, scoped.hash, this.#now(), reason);
  }

  #challengeFor(tenantId: string, principalId: string, purpose: ChallengePurpose): string {
    return signChallenge(
      {
        tenantId,
        principalId,
        purpose,
        // Long enough to open an authenticator app, short enough that a
        // half-finished sign-in left on a shared screen expires on its own.
        expiresAt: this.#now().getTime() + 10 * 60_000,
      },
      this.#config.challengeKey,
    );
  }

  #pending(
    tenantId: string,
    principalId: string,
    purpose: ChallengePurpose,
    credential: StoredCredential,
  ): PendingSecondFactor {
    const challenge = this.#challengeFor(tenantId, principalId, purpose);
    if (purpose === 'awaiting_totp' || !credential.totpSecretSealed) {
      return { challenge, purpose };
    }

    const secret = openSecret(credential.totpSecretSealed, this.#config.sealingKey);
    return {
      challenge,
      purpose,
      totpSecret: secret,
      otpauthUri: otpauthUri({ secret, account: principalId, issuer: this.#config.consoleName }),
    };
  }

  async #recordFailure(credential: StoredCredential, now: Date): Promise<void> {
    const attempts = credential.failedAttempts + 1;
    const locked =
      attempts >= this.#config.maxFailedAttempts
        ? new Date(now.getTime() + this.#config.lockoutMinutes * 60_000)
        : null;

    await this.#store.recordFailure(
      credential.tenantId,
      credential.principalId,
      // Reset the counter when the lock is applied, so one lockout is one
      // window rather than every subsequent attempt extending it forever.
      locked ? 0 : attempts,
      locked,
    );
  }

  async #openSession(tenantId: string, principalId: string, now: Date): Promise<OpenedSession> {
    const minted = mintScoped(tenantId);
    const expiresAt = new Date(now.getTime() + this.#config.sessionTtlHours * 3_600_000);

    await this.#store.createSession({
      tenantId,
      sessionHash: minted.hash,
      principalId,
      expiresAt,
      revokedAt: null,
    });

    return { cookie: minted.value, tenantId, principalId, expiresAt };
  }
}
