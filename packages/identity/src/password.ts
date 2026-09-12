/**
 * Password storage for the reviewer console.
 *
 * scrypt rather than bcrypt or PBKDF2: it is memory-hard, so the advantage a
 * GPU or ASIC farm holds over the login server is bounded by RAM rather than by
 * clock speed. It is also in Node's standard library, which keeps a credential
 * primitive out of the dependency supply chain — the one place a compromised
 * package would be worth the most to an attacker.
 *
 * The cost parameters are written into every stored value rather than assumed
 * at read time. That is what lets them be raised later: an old hash keeps
 * verifying with the parameters it was made with, and is re-hashed on the next
 * successful sign-in. A constant here instead would have invalidated every
 * existing credential the day someone raised it.
 */
import { type ScryptOptions, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { WorkerError } from '@eiaaw/core';

/**
 * `promisify` infers the three-argument overload and drops the options one, so
 * the cost parameters would be silently unpassable without this annotation.
 */
const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: ScryptOptions,
) => Promise<Buffer>;

/**
 * N = 2^15 puts a single hash at roughly 100 ms and 32 MB on server hardware —
 * unnoticeable on a login, ruinous at the scale offline cracking needs.
 */
const SCRYPT = { N: 32_768, r: 8, p: 1 } as const;
const KEY_BYTES = 32;
const SALT_BYTES = 16;

/**
 * Node's default `maxmem` is exactly 128 * N * r, so the parameters above sit
 * precisely on the limit and throw. Asking for headroom is not optional.
 */
const MAX_MEM = 128 * SCRYPT.N * SCRYPT.r * 2;

const ALGORITHM = 'scrypt';

/**
 * Twelve, and no composition rules.
 *
 * NIST SP 800-63B dropped "must contain a digit and a symbol" because those
 * rules push people towards `Password1!` — predictable to a cracker and hostile
 * to a human. Length is what actually costs an attacker work.
 */
export const PASSWORD_MIN_LENGTH = 12;

/**
 * An upper bound exists only because scrypt runs over whatever it is given, so
 * an unbounded field is a cheap way to make the login server do expensive work.
 */
export const PASSWORD_MAX_LENGTH = 1024;

export function assertPasswordAcceptable(plaintext: string): void {
  if (plaintext.length < PASSWORD_MIN_LENGTH) {
    throw new WorkerError('contract_invalid', {
      detail:
        `A password must be at least ${String(PASSWORD_MIN_LENGTH)} characters. ` +
        'Length is the only rule — a long passphrase of ordinary words is both ' +
        'stronger and easier to remember than a short one with substitutions.',
      failureClass: 'contract',
      retryable: false,
    });
  }

  if (plaintext.length > PASSWORD_MAX_LENGTH) {
    throw new WorkerError('contract_invalid', {
      detail:
        `A password of ${String(plaintext.length)} characters is too long; the limit is ` +
        `${String(PASSWORD_MAX_LENGTH)}. The bound exists because the hash runs over ` +
        'whatever it is given, and an unbounded field is free work for an attacker.',
      failureClass: 'contract',
      retryable: false,
    });
  }
}

async function derive(
  plaintext: string,
  salt: Buffer,
  params: { readonly N: number; readonly r: number; readonly p: number },
): Promise<Buffer> {
  return scryptAsync(plaintext, salt, KEY_BYTES, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem: 128 * params.N * params.r * 2,
  });
}

/** `scrypt$N$r$p$salt$hash`, salt and hash base64url. */
export async function hashPassword(plaintext: string): Promise<string> {
  assertPasswordAcceptable(plaintext);
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(plaintext, salt, SCRYPT);

  return [
    ALGORITHM,
    String(SCRYPT.N),
    String(SCRYPT.r),
    String(SCRYPT.p),
    salt.toString('base64url'),
    key.toString('base64url'),
  ].join('$');
}

interface StoredCredential {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly salt: Buffer;
  readonly key: Buffer;
}

function parse(encoded: string): StoredCredential {
  const parts = encoded.split('$');

  if (parts.length !== 6) {
    throw new WorkerError('internal_error', {
      detail:
        'A stored credential could not be parsed. This is a data-integrity problem, ' +
        'not a wrong password — returning "no match" here would make a corrupted row ' +
        'indistinguishable from a typo and lock someone out with no signal anywhere.',
      failureClass: 'internal',
      retryable: false,
    });
  }

  const [algorithm, n, r, p, salt, key] = parts as [string, string, string, string, string, string];

  if (algorithm !== ALGORITHM) {
    throw new WorkerError('internal_error', {
      detail:
        `A stored credential names algorithm "${algorithm}", but this build only ` +
        `implements "${ALGORITHM}". Refusing rather than guessing: verifying with the ` +
        'wrong algorithm cannot succeed, and silently failing would read as a bad password.',
      failureClass: 'internal',
      retryable: false,
    });
  }

  const parsed = {
    N: Number.parseInt(n, 10),
    r: Number.parseInt(r, 10),
    p: Number.parseInt(p, 10),
    salt: Buffer.from(salt, 'base64url'),
    key: Buffer.from(key, 'base64url'),
  };

  if (!Number.isFinite(parsed.N) || !Number.isFinite(parsed.r) || !Number.isFinite(parsed.p)) {
    throw new WorkerError('internal_error', {
      detail: 'A stored credential carries non-numeric scrypt parameters and cannot be verified.',
      failureClass: 'internal',
      retryable: false,
    });
  }

  return parsed;
}

/**
 * Throws when the *stored* value is unusable; returns false only when the
 * password genuinely does not match. Callers depend on that distinction to tell
 * "wrong password" from "this account's row is broken".
 */
export async function verifyPassword(plaintext: string, encoded: string): Promise<boolean> {
  const stored = parse(encoded);
  const candidate = await derive(plaintext, stored.salt, stored);

  // Length can differ only if the stored key was truncated, which `parse`
  // cannot detect; `timingSafeEqual` throws on mismatched lengths.
  if (candidate.length !== stored.key.length) return false;

  return timingSafeEqual(candidate, stored.key);
}

/**
 * True when a credential was made with weaker parameters than the current ones,
 * so a successful sign-in can transparently upgrade it.
 */
export function needsRehash(encoded: string): boolean {
  const stored = parse(encoded);
  return stored.N < SCRYPT.N || stored.r < SCRYPT.r || stored.p < SCRYPT.p;
}

export const SCRYPT_PARAMETERS = SCRYPT;
export const SCRYPT_MAX_MEM = MAX_MEM;
