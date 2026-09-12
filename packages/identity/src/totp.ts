/**
 * Time-based one-time passwords — RFC 6238 over RFC 4226.
 *
 * Implemented here rather than taken from a package because the algorithm is
 * forty lines, the RFC publishes test vectors that prove interoperability, and
 * a second factor is the last dependency worth pulling from a registry.
 *
 * SHA-1, six digits, thirty-second steps. Not a modernisation oversight: every
 * authenticator app in circulation implements exactly this, and the HMAC
 * construction is unaffected by SHA-1's collision weakness. Changing any of the
 * three locks out every already-enrolled device.
 */
import { createHmac, randomBytes } from 'node:crypto';
import { WorkerError, safeEqual } from '@eiaaw/core';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

/**
 * One step either side. Phone clocks drift, so zero tolerance produces support
 * tickets; but every extra step multiplies how long an intercepted code stays
 * usable, which is the exact property the second factor exists to provide.
 */
export const TOTP_DRIFT_STEPS = 1;

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4226 §4 puts the floor at 128 bits and recommends 160. */
const SECRET_BYTES = 20;

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }

  if (bits > 0) output += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];

  return output;
}

function base32Decode(input: string): Buffer {
  const clean = input.replace(/\s+/g, '').replace(/=+$/, '').toUpperCase();
  const bytes: number[] = [];
  let bits = 0;
  let value = 0;

  for (const character of clean) {
    const index = BASE32_ALPHABET.indexOf(character);
    if (index === -1) {
      throw new WorkerError('contract_invalid', {
        detail: `"${character}" is not a base32 character; a TOTP secret cannot contain it.`,
        failureClass: 'contract',
        retryable: false,
      });
    }
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }

  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(SECRET_BYTES));
}

export interface TotpOptions {
  readonly digits?: number;
  readonly stepSeconds?: number;
}

export function totpCode(secret: string, atMs: number, options: TotpOptions = {}): string {
  const digits = options.digits ?? TOTP_DIGITS;
  const step = options.stepSeconds ?? TOTP_STEP_SECONDS;
  const counter = Math.floor(atMs / 1000 / step);

  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const mac = createHmac('sha1', base32Decode(secret)).update(message).digest();

  // RFC 4226 §5.3 dynamic truncation: the low nibble of the last byte selects
  // the offset, and the high bit is masked to keep the result positive across
  // implementations that lack unsigned integers.
  const offset = mac.readUInt8(mac.length - 1) & 0x0f;
  const binary = mac.readUInt32BE(offset) & 0x7fff_ffff;

  return String(binary % 10 ** digits).padStart(digits, '0');
}

/**
 * Never throws on user input. A malformed code is a wrong code — a sign-in form
 * that returns a 500 for `abcdef` tells an attacker which inputs reach further
 * into the system than others.
 */
export function verifyTotp(
  secret: string,
  presented: string,
  atMs: number,
  options: TotpOptions & { readonly driftSteps?: number } = {},
): boolean {
  const digits = options.digits ?? TOTP_DIGITS;
  const step = options.stepSeconds ?? TOTP_STEP_SECONDS;
  const drift = options.driftSteps ?? TOTP_DRIFT_STEPS;

  // Authenticator apps display `123 456`; people paste what they see.
  const candidate = presented.replace(/\s+/g, '');
  if (candidate.length !== digits) return false;
  if (!/^\d+$/.test(candidate)) return false;

  for (let offset = -drift; offset <= drift; offset += 1) {
    const at = atMs + offset * step * 1000;
    if (safeEqual(candidate, totpCode(secret, at, { digits, stepSeconds: step }))) return true;
  }

  return false;
}

export interface OtpauthInput {
  readonly secret: string;
  readonly account: string;
  readonly issuer: string;
}

/**
 * The `otpauth://` URI an authenticator app reads from a QR code.
 *
 * Built with `encodeURIComponent` rather than `URLSearchParams`, which encodes
 * a space as `+`. Some apps read that literally and enrol an issuer with plus
 * signs in it.
 */
export function otpauthUri(input: OtpauthInput): string {
  const label = `${encodeURIComponent(input.issuer)}:${encodeURIComponent(input.account)}`;
  const query = [
    `secret=${input.secret}`,
    `issuer=${encodeURIComponent(input.issuer)}`,
    'algorithm=SHA1',
    `digits=${String(TOTP_DIGITS)}`,
    `period=${String(TOTP_STEP_SECONDS)}`,
  ].join('&');

  return `otpauth://totp/${label}?${query}`;
}
