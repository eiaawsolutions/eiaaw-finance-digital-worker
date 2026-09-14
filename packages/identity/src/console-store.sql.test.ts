import { describe, expect, it } from 'vitest';
import {
  mapCredentialRow,
  mapInviteRow,
  mapSessionRow,
  type CredentialRow,
  type InviteRow,
  type SessionRow,
} from './console-store.sql.js';

/**
 * The exact form this database returns.
 *
 * `createDatabase` overrides postgres.js's date parser to hand back the RFC
 * 3339 string rather than a Date (DWD-06 s.2.2). Nothing in the type system
 * says so, which is how the adapter shipped returning strings through a port
 * that declares Date.
 */
const ISO = '2026-09-14T09:00:00.000Z';
const PAST = '2026-09-13T09:00:00.000Z';

const credentialRow = (overrides: Partial<CredentialRow> = {}): CredentialRow => ({
  tenant_id: 'tnt_eiaaw',
  principal_id: 'usr_amos',
  password_hash: 'scrypt$1$2$3$a$b',
  totp_secret_sealed: 'v1.a.b.c',
  totp_confirmed_at: ISO,
  failed_attempts: 0,
  locked_until: null,
  ...overrides,
});

const inviteRow = (overrides: Partial<InviteRow> = {}): InviteRow => ({
  tenant_id: 'tnt_eiaaw',
  token_hash: 'a'.repeat(64),
  principal_id: 'usr_amos',
  purpose: 'enrolment',
  expires_at: ISO,
  consumed_at: null,
  ...overrides,
});

const sessionRow = (overrides: Partial<SessionRow> = {}): SessionRow => ({
  tenant_id: 'tnt_eiaaw',
  session_hash: 'b'.repeat(64),
  principal_id: 'usr_amos',
  expires_at: ISO,
  revoked_at: null,
  ...overrides,
});

/**
 * THE REGRESSION THIS FILE EXISTS FOR
 *
 * The service compares these fields against `new Date()` to decide whether a
 * lock is still in force, a link has expired, or a session has ended. A string
 * does not fail those comparisons loudly — it fails them silently and in the
 * permissive direction.
 *
 * `"2026-09-13T09:00:00.000Z" <= new Date()` coerces both operands toward
 * numbers. `Number` of an ISO string is NaN, and every comparison involving
 * NaN is false. So an expired session reads as live, an expired link reads as
 * valid, and a locked account reads as unlocked.
 *
 * The in-memory store stores real Dates, so the whole service suite passed
 * while production had no working expiry and no working lockout at all.
 */
describe('the trap these mappers exist to close', () => {
  it('shows that comparing the raw string is false in both directions', () => {
    const now = new Date(ISO);

    // Neither of these is true. That is the bug: the guard never fires.
    expect(PAST <= (now as unknown as string)).toBe(false);
    expect(PAST > (now as unknown as string)).toBe(false);
  });

  it('compares correctly once mapped', () => {
    const expired = mapSessionRow(sessionRow({ expires_at: PAST }));

    expect(expired.expiresAt <= new Date(ISO)).toBe(true);
  });
});

describe('session rows', () => {
  it('converts the timestamp string into a Date', () => {
    const mapped = mapSessionRow(sessionRow());

    expect(mapped.expiresAt).toBeInstanceOf(Date);
    expect(mapped.expiresAt.toISOString()).toBe(ISO);
  });

  it('keeps a null revocation null rather than epoch zero', () => {
    expect(mapSessionRow(sessionRow()).revokedAt).toBeNull();
  });

  it('converts a revocation when there is one', () => {
    const mapped = mapSessionRow(sessionRow({ revoked_at: PAST }));

    expect(mapped.revokedAt?.toISOString()).toBe(PAST);
  });

  /** A driver configuration change that restores Date parsing must not break this. */
  it('passes a Date through unchanged', () => {
    const mapped = mapSessionRow(sessionRow({ expires_at: new Date(ISO) }));

    expect(mapped.expiresAt.toISOString()).toBe(ISO);
  });
});

describe('credential rows', () => {
  it('converts the lockout timestamp, which is what makes lockout work at all', () => {
    const mapped = mapCredentialRow(credentialRow({ locked_until: ISO }));

    expect(mapped.lockedUntil).toBeInstanceOf(Date);
    expect(mapped.lockedUntil?.toISOString()).toBe(ISO);
  });

  it('leaves an unlocked account unlocked', () => {
    expect(mapCredentialRow(credentialRow()).lockedUntil).toBeNull();
  });

  it('converts the second-factor confirmation', () => {
    expect(mapCredentialRow(credentialRow()).totpConfirmedAt).toBeInstanceOf(Date);
  });

  it('treats an unconfirmed authenticator as unconfirmed', () => {
    expect(mapCredentialRow(credentialRow({ totp_confirmed_at: null })).totpConfirmedAt).toBeNull();
  });

  /** Postgres returns bigint-ish counts as strings in some drivers. */
  it('coerces the attempt counter to a number', () => {
    const mapped = mapCredentialRow(credentialRow({ failed_attempts: '3' as unknown as number }));

    expect(mapped.failedAttempts).toBe(3);
  });
});

describe('invite rows', () => {
  it('converts the expiry, which is what makes a link single-lifetime', () => {
    const mapped = mapInviteRow(inviteRow());

    expect(mapped.expiresAt).toBeInstanceOf(Date);
    expect(mapped.expiresAt.toISOString()).toBe(ISO);
  });

  it('keeps an unconsumed invite unconsumed', () => {
    expect(mapInviteRow(inviteRow()).consumedAt).toBeNull();
  });

  it('converts a consumption timestamp', () => {
    expect(mapInviteRow(inviteRow({ consumed_at: PAST })).consumedAt?.toISOString()).toBe(PAST);
  });
});
