/**
 * Production authentication.
 *
 * `server.ts` keeps `authenticate` as the single place identity is decided, so
 * a route cannot accidentally trust a header. This is the production
 * implementation of that seam.
 *
 * TRUST MODEL, AND ITS LIMIT — read before relying on this for attribution.
 *
 * The service token proves one thing: the request came from a process holding
 * the token, which in this deployment is the console. It does NOT prove which
 * human is acting. The console names the principal, and the API takes its word
 * for it — the classic trusted-subsystem arrangement.
 *
 * The consequence is concrete. Anything attributed to a principal through this
 * path is attributable only as far as the console's own authentication goes,
 * and until OIDC lands the console's session is environment-configured rather
 * than established by a person signing in. So an approval recorded this way
 * names a principal without proving one was present.
 *
 * That is acceptable for a reviewer console on a private network during
 * enrolment and testing. It is not the end state, and it is not sufficient for
 * a dual-control decision that a regulator would ask you to evidence. The
 * remedy is the OIDC session this seam was designed for: when it arrives, this
 * authenticator is replaced rather than extended, and nothing above it changes.
 *
 * Anyone holding the token can name any principal. Treat it as equivalent to
 * the console's own credentials, not as a lower-value API key.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import type { SecretRef } from '@eiaaw/core';
import type { FastifyRequest } from 'fastify';
import type { Caller } from './server.js';

const CLEARANCES = ['public', 'internal', 'confidential', 'restricted'] as const;
type Clearance = (typeof CLEARANCES)[number];

const isClearance = (value: string): value is Clearance =>
  (CLEARANCES as readonly string[]).includes(value);

/**
 * Compare over SHA-256 digests rather than the raw strings.
 *
 * `timingSafeEqual` throws on length mismatch, so comparing raw would force a
 * length check first and the rejection path would then differ by length.
 * Digests are always 32 bytes, so every wrong token takes the same path.
 */
function tokenMatches(presented: string, expected: string): boolean {
  const a = createHash('sha256').update(presented).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

const headerValue = (request: FastifyRequest, name: string): string | null => {
  const raw = request.headers[name];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
};

export function serviceTokenAuthenticator(
  token: SecretRef,
): (request: FastifyRequest) => Promise<Caller | null> {
  // eslint-disable-next-line @typescript-eslint/require-await
  return async (request: FastifyRequest): Promise<Caller | null> => {
    const authorization = headerValue(request, 'authorization');
    if (!authorization) return null;

    // Only the Authorization header. Accepting the token from a query string or
    // a bespoke header would put it in access logs and referrers.
    const [scheme, presented] = authorization.split(' ');
    if (scheme !== 'Bearer' || !presented) return null;
    if (!tokenMatches(presented, token.expose())) return null;

    // The token authenticates the caller as the console; these say who the
    // console is acting for. Without them there is nobody to attribute an
    // action to, and an unattributable action is refused (DWD-06 s.13.3).
    const tenantId = headerValue(request, 'x-tenant-id');
    const principalId = headerValue(request, 'x-principal-id');
    if (!tenantId || !principalId) return null;

    // An unrecognised clearance is refused, not downgraded: silently reading
    // `confidental` as `internal` would return a successful response at a
    // clearance the caller did not ask for and would not notice.
    const declared = headerValue(request, 'x-clearance');
    if (declared !== null && !isClearance(declared)) return null;
    const clearance: Clearance = declared ?? 'internal';

    return {
      tenant_id: tenantId,
      principal_id: principalId,
      clearance,
      admin: headerValue(request, 'x-admin') === 'true',
    };
  };
}
