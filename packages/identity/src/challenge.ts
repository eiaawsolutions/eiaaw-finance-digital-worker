/**
 * The short-lived token that carries a sign-in between its two factors.
 *
 * Between "the password was right" and "the authenticator code was right"
 * there is a state that has to survive a round trip to the browser. Writing it
 * to the database would mean a table whose rows are meaningless after five
 * minutes and which needs sweeping; signing it instead makes expiry a property
 * of the value itself.
 *
 * It is not a session and must never be accepted as one. It names a principal
 * who has proved exactly one factor, which is why the purpose is inside the
 * signature: an enrolment challenge presented at the sign-in step would skip
 * the very factor enrolment exists to establish.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { WorkerError } from '@eiaaw/core';

export type ChallengePurpose = 'awaiting_totp' | 'awaiting_totp_enrolment';

export interface ChallengePayload {
  readonly tenantId: string;
  readonly principalId: string;
  readonly purpose: ChallengePurpose;
  /** Epoch milliseconds. */
  readonly expiresAt: number;
}

function mac(body: string, key: Buffer): string {
  return createHmac('sha256', key).update(body).digest('base64url');
}

export function signChallenge(payload: ChallengePayload, key: Buffer): string {
  const body = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${body}.${mac(body, key)}`;
}

function invalid(reason: string): WorkerError {
  return new WorkerError('authority_insufficient', {
    detail: reason,
    failureClass: 'policy',
    retryable: false,
  });
}

export function verifyChallenge(token: string, key: Buffer, nowMs: number): ChallengePayload {
  const parts = token.split('.');
  if (parts.length !== 2) {
    throw invalid('The sign-in challenge is malformed. Start the sign-in again.');
  }

  const [body, presented] = parts as [string, string];
  const expected = mac(body, key);
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');

  // Compare before parsing. Parsing first would let a forged payload steer the
  // code path — and an error that differs by payload is an oracle.
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw invalid('The sign-in challenge signature does not verify. Start the sign-in again.');
  }

  let payload: ChallengePayload;
  try {
    payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ChallengePayload;
  } catch {
    // Signature verified, so we wrote this — a parse failure here is our bug.
    throw new WorkerError('internal_error', {
      detail: 'A correctly signed sign-in challenge did not contain readable JSON.',
      failureClass: 'internal',
      retryable: false,
    });
  }

  if (nowMs > payload.expiresAt) {
    throw invalid(
      'The sign-in challenge has expired. A second factor that stays valid indefinitely ' +
        'is not a second factor; start the sign-in again.',
    );
  }

  return payload;
}
