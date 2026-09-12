/**
 * Identity primitives for the reviewer console: password storage, TOTP second
 * factor, and single-use enrolment tokens.
 *
 * Everything here is pure and side-effect free. Persistence, rate limiting and
 * lockout live with the API, which owns the database; this package owns only
 * the cryptography, so it can be tested against published vectors without a
 * running system.
 */
export {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  SCRYPT_MAX_MEM,
  SCRYPT_PARAMETERS,
  assertPasswordAcceptable,
  hashPassword,
  needsRehash,
  verifyPassword,
} from './password.js';

export {
  TOTP_DIGITS,
  TOTP_DRIFT_STEPS,
  TOTP_STEP_SECONDS,
  generateTotpSecret,
  otpauthUri,
  totpCode,
  verifyTotp,
  type OtpauthInput,
  type TotpOptions,
} from './totp.js';

export {
  createInviteToken,
  hashInviteToken,
  inviteTokenMatches,
  type IssuedToken,
} from './tokens.js';

export { deriveSealingKey, openSecret, sealSecret } from './sealing.js';
