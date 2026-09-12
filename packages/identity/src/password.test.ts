import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MIN_LENGTH,
  assertPasswordAcceptable,
  hashPassword,
  verifyPassword,
} from './password.js';

const GOOD = 'correct horse battery staple';

describe('password hashing', () => {
  it('verifies a password against its own hash', async () => {
    const encoded = await hashPassword(GOOD);

    expect(await verifyPassword(GOOD, encoded)).toBe(true);
  });

  it('refuses a password that does not match', async () => {
    const encoded = await hashPassword(GOOD);

    expect(await verifyPassword('correct horse battery stapl', encoded)).toBe(false);
  });

  /**
   * Per-password salt is what stops one cracked hash from cracking every other
   * account that chose the same password, and stops a rainbow table entirely.
   */
  it('produces a different encoding each time, and both still verify', async () => {
    const first = await hashPassword(GOOD);
    const second = await hashPassword(GOOD);

    expect(first).not.toEqual(second);
    expect(await verifyPassword(GOOD, first)).toBe(true);
    expect(await verifyPassword(GOOD, second)).toBe(true);
  });

  it('carries its parameters in the encoding, so they can be raised later', async () => {
    const encoded = await hashPassword(GOOD);

    expect(encoded.startsWith('scrypt$')).toBe(true);
    expect(encoded.split('$')).toHaveLength(6);
  });

  /**
   * A stored credential that cannot be parsed is a data-integrity problem, not
   * a wrong password. Returning `false` would let a corrupted row look exactly
   * like a typo and quietly lock someone out with no signal anywhere.
   */
  it('refuses a malformed stored credential loudly rather than returning false', async () => {
    await expect(verifyPassword(GOOD, 'not-an-encoded-hash')).rejects.toThrow(/credential/i);
  });

  it('refuses an unknown algorithm rather than guessing', async () => {
    await expect(verifyPassword(GOOD, 'bcrypt$1$2$3$abc$def')).rejects.toThrow(/bcrypt/);
  });
});

describe('password policy', () => {
  it('accepts a reasonable passphrase', () => {
    expect(() => assertPasswordAcceptable(GOOD)).not.toThrow();
  });

  it('refuses a password shorter than the minimum', () => {
    expect(() => assertPasswordAcceptable('a'.repeat(PASSWORD_MIN_LENGTH - 1))).toThrow(
      new RegExp(String(PASSWORD_MIN_LENGTH)),
    );
  });

  /**
   * Length is the only strength rule. Composition rules (a digit, a symbol)
   * push people towards `Password1!` and are not what makes a secret hard to
   * guess — NIST SP 800-63B drops them for the same reason.
   */
  it('accepts a long passphrase with no digits or symbols', () => {
    expect(() => assertPasswordAcceptable('the quiet ledger balances itself')).not.toThrow();
  });

  it('refuses a password long enough to be a denial-of-service payload', () => {
    expect(() => assertPasswordAcceptable('a'.repeat(5000))).toThrow(/too long/i);
  });
});
