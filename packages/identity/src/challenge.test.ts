import { describe, expect, it } from 'vitest';
import { signChallenge, verifyChallenge } from './challenge.js';
import { deriveSealingKey } from './sealing.js';

const KEY = deriveSealingKey('s'.repeat(64), 'challenge');
const OTHER = deriveSealingKey('t'.repeat(64), 'challenge');
const NOW = 1_700_000_000_000;

const PAYLOAD = {
  tenantId: 'tnt_eiaaw',
  principalId: 'usr_amos',
  purpose: 'awaiting_totp',
  expiresAt: NOW + 300_000,
} as const;

describe('sign-in challenge', () => {
  it('round-trips the payload', () => {
    const token = signChallenge(PAYLOAD, KEY);

    expect(verifyChallenge(token, KEY, NOW)).toEqual(PAYLOAD);
  });

  /**
   * The whole point. Without the signature a holder could rewrite principalId
   * and walk into any account having proved only that they know one password.
   */
  it('refuses a payload that has been rewritten', () => {
    const token = signChallenge(PAYLOAD, KEY);
    const [body, mac] = token.split('.');
    const forged = JSON.parse(Buffer.from(body as string, 'base64url').toString('utf8')) as Record<
      string,
      unknown
    >;
    forged['principalId'] = 'usr_someone_else';
    const tampered = [Buffer.from(JSON.stringify(forged), 'utf8').toString('base64url'), mac].join(
      '.',
    );

    expect(() => verifyChallenge(tampered, KEY, NOW)).toThrow(/signature/i);
  });

  it('refuses a challenge signed with a different key', () => {
    expect(() => verifyChallenge(signChallenge(PAYLOAD, OTHER), KEY, NOW)).toThrow(/signature/i);
  });

  /**
   * A challenge that outlived its window is the second factor becoming
   * optional for whoever picks it up later.
   */
  it('refuses an expired challenge', () => {
    const token = signChallenge(PAYLOAD, KEY);

    expect(() => verifyChallenge(token, KEY, PAYLOAD.expiresAt + 1)).toThrow(/expired/i);
  });

  it('accepts a challenge on its last millisecond', () => {
    const token = signChallenge(PAYLOAD, KEY);

    expect(verifyChallenge(token, KEY, PAYLOAD.expiresAt).principalId).toBe('usr_amos');
  });

  it('refuses a malformed challenge rather than reading past it', () => {
    expect(() => verifyChallenge('nonsense', KEY, NOW)).toThrow(/challenge/i);
    expect(() => verifyChallenge('a.b.c', KEY, NOW)).toThrow(/challenge/i);
  });

  /**
   * Enrolment and sign-in issue structurally identical tokens. Without the
   * purpose, an enrolment challenge would be accepted at the sign-in step and
   * skip the factor it exists to establish.
   */
  it('carries the purpose, so one step cannot be replayed at another', () => {
    const enrolment = signChallenge({ ...PAYLOAD, purpose: 'awaiting_totp_enrolment' }, KEY);

    expect(verifyChallenge(enrolment, KEY, NOW).purpose).toBe('awaiting_totp_enrolment');
  });
});
