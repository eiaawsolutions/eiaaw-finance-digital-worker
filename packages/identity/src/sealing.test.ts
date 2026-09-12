import { describe, expect, it } from 'vitest';
import { deriveSealingKey, openSecret, sealSecret } from './sealing.js';

const MASTER = 'a'.repeat(64);
const KEY = deriveSealingKey(MASTER, 'totp');
const OTHER_KEY = deriveSealingKey('b'.repeat(64), 'totp');

describe('sealing a secret at rest', () => {
  it('round-trips through seal and open', () => {
    const sealed = sealSecret('GEZDGNBVGY3TQOJQ', KEY);

    expect(openSecret(sealed, KEY)).toBe('GEZDGNBVGY3TQOJQ');
  });

  /**
   * A fresh nonce per seal. Reusing one under AES-GCM is not a weakened cipher,
   * it is a broken one — two messages under the same key and nonce leak their
   * XOR and forfeit authentication entirely.
   */
  it('produces different ciphertext each time for the same plaintext', () => {
    const first = sealSecret('same', KEY);
    const second = sealSecret('same', KEY);

    expect(first).not.toEqual(second);
    expect(openSecret(first, KEY)).toBe(openSecret(second, KEY));
  });

  it('refuses a value sealed under a different key', () => {
    const sealed = sealSecret('GEZDGNBVGY3TQOJQ', KEY);

    expect(() => openSecret(sealed, OTHER_KEY)).toThrow(/authenticat/i);
  });

  /**
   * The authentication tag is the point. Without it an attacker with write
   * access to the row could flip ciphertext bits and steer the decrypted secret,
   * and the second factor would verify against a value they chose.
   */
  it('refuses ciphertext that has been altered', () => {
    const sealed = sealSecret('GEZDGNBVGY3TQOJQ', KEY);
    const parts = sealed.split('.');
    const body = Buffer.from(parts[3] as string, 'base64url');
    body[0] ^= 0xff;
    const tampered = [parts[0], parts[1], parts[2], body.toString('base64url')].join('.');

    expect(() => openSecret(tampered, KEY)).toThrow(/authenticat/i);
  });

  it('refuses a sealed value whose tag has been altered', () => {
    const sealed = sealSecret('GEZDGNBVGY3TQOJQ', KEY);
    const parts = sealed.split('.');
    const tag = Buffer.from(parts[2] as string, 'base64url');
    tag[0] ^= 0xff;
    const tampered = [parts[0], parts[1], tag.toString('base64url'), parts[3]].join('.');

    expect(() => openSecret(tampered, KEY)).toThrow(/authenticat/i);
  });

  it('refuses a malformed sealed value rather than returning something', () => {
    expect(() => openSecret('not-sealed', KEY)).toThrow(/sealed/i);
  });

  it('refuses an unknown format version rather than guessing', () => {
    const sealed = sealSecret('x'.repeat(16), KEY);
    const [, iv, tag, body] = sealed.split('.');

    expect(() => openSecret(['v9', iv, tag, body].join('.'), KEY)).toThrow(/v9/);
  });

  it('carries its version so the format can change later', () => {
    expect(sealSecret('x'.repeat(16), KEY).startsWith('v1.')).toBe(true);
  });
});

describe('key derivation', () => {
  it('derives a 32-byte key for AES-256', () => {
    expect(KEY).toHaveLength(32);
  });

  /**
   * Separate labels from one master key, so the TOTP key and any future key
   * are unrelated. Reusing one key across purposes means a weakness in either
   * use compromises both.
   */
  it('derives unrelated keys for different purposes', () => {
    expect(deriveSealingKey(MASTER, 'totp')).not.toEqual(deriveSealingKey(MASTER, 'recovery'));
  });

  it('is deterministic, so a restart can still open what it sealed', () => {
    expect(deriveSealingKey(MASTER, 'totp')).toEqual(deriveSealingKey(MASTER, 'totp'));
  });

  it('refuses a master key too short to be real key material', () => {
    expect(() => deriveSealingKey('short', 'totp')).toThrow(/master key/i);
  });
});
