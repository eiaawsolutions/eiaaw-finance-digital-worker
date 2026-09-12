/**
 * Single-use tokens for enrolment and password-reset links.
 *
 * The token is sent; only its SHA-256 is stored. A reader of the database
 * therefore cannot complete anybody's enrolment, for the same reason passwords
 * are not stored either — and unlike a password, this one arrives by email, so
 * assume the transport is quotable.
 *
 * SHA-256 without a work factor is deliberate. Stretching defends a
 * low-entropy secret against guessing; these carry 256 bits from a CSPRNG, so
 * there is nothing to guess and the cost would buy nothing.
 */
import { randomBytes } from 'node:crypto';
import { safeEqual, sha256 } from '@eiaaw/core';

const TOKEN_BYTES = 32;

export interface IssuedToken {
  /** Sent to the recipient. Never stored, never logged. */
  readonly token: string;
  /** Stored, and what a presented token is looked up by. */
  readonly tokenHash: string;
}

export function createInviteToken(): IssuedToken {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  return { token, tokenHash: hashInviteToken(token) };
}

export function hashInviteToken(token: string): string {
  return sha256(token);
}

/**
 * Constant-time, so a near-miss cannot be distinguished from a wild guess by
 * timing. The empty token is refused outright: it hashes to a perfectly valid
 * digest, and a row that somehow held it would otherwise be openable by anyone
 * who submitted nothing at all.
 */
export function inviteTokenMatches(token: string, storedHash: string): boolean {
  if (token.length === 0) return false;
  return safeEqual(hashInviteToken(token), storedHash);
}
