import { describe, expect, it } from 'vitest';
import { TOTP_STEP_SECONDS, generateTotpSecret, otpauthUri, totpCode, verifyTotp } from './totp.js';

/**
 * RFC 6238 Appendix B, the SHA-1 rows.
 *
 * These are not decoration. An authenticator app is a third party we cannot
 * test against directly, so the published vectors are the only evidence that
 * what we generate is what Google Authenticator will expect. If these ever
 * fail, every enrolled device is locked out.
 *
 * The shared secret in the appendix is the ASCII string "12345678901234567890",
 * which is this in base32.
 */
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

const RFC_VECTORS: readonly { readonly seconds: number; readonly code: string }[] = [
  { seconds: 59, code: '94287082' },
  { seconds: 1111111109, code: '07081804' },
  { seconds: 1111111111, code: '14050471' },
  { seconds: 1234567890, code: '89005924' },
  { seconds: 2000000000, code: '69279037' },
  { seconds: 20000000000, code: '65353130' },
];

describe('TOTP against the RFC 6238 vectors', () => {
  for (const vector of RFC_VECTORS) {
    it(`matches the published code at t=${vector.seconds}`, () => {
      expect(totpCode(RFC_SECRET, vector.seconds * 1000, { digits: 8 })).toBe(vector.code);
    });
  }
});

describe('TOTP verification', () => {
  const now = 1_700_000_000_000;

  it('accepts the code for the current step', () => {
    expect(verifyTotp(RFC_SECRET, totpCode(RFC_SECRET, now), now)).toBe(true);
  });

  /**
   * One step of tolerance each way, and no more. Phone clocks drift; a wider
   * window multiplies the number of codes a stolen one-time code stays valid
   * for, which is the whole thing the second factor is protecting.
   */
  it('accepts the previous step, for clock drift', () => {
    const previous = totpCode(RFC_SECRET, now - TOTP_STEP_SECONDS * 1000);

    expect(verifyTotp(RFC_SECRET, previous, now)).toBe(true);
  });

  it('accepts the next step, for a phone running fast', () => {
    const next = totpCode(RFC_SECRET, now + TOTP_STEP_SECONDS * 1000);

    expect(verifyTotp(RFC_SECRET, next, now)).toBe(true);
  });

  it('refuses a code two steps old', () => {
    const stale = totpCode(RFC_SECRET, now - 2 * TOTP_STEP_SECONDS * 1000);

    expect(verifyTotp(RFC_SECRET, stale, now)).toBe(false);
  });

  it('refuses a wrong code', () => {
    expect(verifyTotp(RFC_SECRET, '000000', now)).toBe(false);
  });

  it('refuses malformed input without throwing', () => {
    expect(verifyTotp(RFC_SECRET, 'abcdef', now)).toBe(false);
    expect(verifyTotp(RFC_SECRET, '', now)).toBe(false);
    expect(verifyTotp(RFC_SECRET, '12345', now)).toBe(false);
  });

  it('tolerates the spaces authenticator apps display', () => {
    const code = totpCode(RFC_SECRET, now);
    const spaced = `${code.slice(0, 3)} ${code.slice(3)}`;

    expect(verifyTotp(RFC_SECRET, spaced, now)).toBe(true);
  });
});

describe('secret generation', () => {
  it('produces distinct base32 secrets', () => {
    const a = generateTotpSecret();
    const b = generateTotpSecret();

    expect(a).not.toEqual(b);
    expect(a).toMatch(/^[A-Z2-7]+$/);
  });

  it('produces at least 160 bits, the RFC 4226 floor', () => {
    // Base32 packs 5 bits per character.
    expect(generateTotpSecret().length * 5).toBeGreaterThanOrEqual(160);
  });
});

describe('otpauth URI', () => {
  it('carries the issuer, account and secret an authenticator app needs', () => {
    const uri = otpauthUri({
      secret: RFC_SECRET,
      account: 'eiaawsolutions@gmail.com',
      issuer: 'EIAAW Finance Worker',
    });

    expect(uri).toContain('otpauth://totp/');
    expect(uri).toContain(`secret=${RFC_SECRET}`);
    expect(uri).toContain('issuer=EIAAW%20Finance%20Worker');
    expect(uri).toContain('eiaawsolutions%40gmail.com');
  });
});
