/**
 * The console's own sign-in.
 *
 * Everything here is server-side. The session cookie is httpOnly, so the
 * browser can present it but no script can read it, and the service token that
 * reaches the API never exists in a page the browser receives.
 *
 * This file is what replaces `currentSession()` reading environment variables.
 * Until it existed the console asserted a principal that nobody had proved, and
 * `apps/api/src/authenticate.ts` says plainly what that did and did not
 * evidence. Now the principal named on every API call is the person who signed
 * in, and the audit trail means what it says.
 */
import { cookies } from 'next/headers';
import { API_URL, serviceToken } from './service';

export const SESSION_COOKIE = 'eiaaw_console_session';

export interface ConsoleSession {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly clearance: string;
  readonly admin: boolean;
  readonly expires_at: string;
}

export interface AuthFailure {
  readonly detail: string;
}

async function post<T>(
  path: string,
  body: Record<string, unknown>,
): Promise<{ ok: true; data: T } | { ok: false; status: number; detail: string }> {
  const token = await serviceToken();

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, {
      method: 'POST',
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      cache: 'no-store',
    });
  } catch {
    return {
      ok: false,
      status: 503,
      detail: 'The service is not reachable right now. Try again in a moment.',
    };
  }

  if (response.status === 204) return { ok: true, data: undefined as T };

  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;

  if (!response.ok) {
    const detail = payload['detail'];
    return {
      ok: false,
      status: response.status,
      // The API writes these to be read by the person in front of the screen.
      detail: typeof detail === 'string' ? detail : 'That request was not accepted.',
    };
  }

  return { ok: true, data: payload as T };
}

/** The signed-in principal, or null. Never throws — callers decide what to do. */
export async function getSession(): Promise<ConsoleSession | null> {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!cookie) return null;

  const result = await post<ConsoleSession>('/v1/console-auth/session', { cookie });
  return result.ok ? result.data : null;
}

async function setSessionCookie(cookie: string, expiresAt: string): Promise<void> {
  (await cookies()).set(SESSION_COOKIE, cookie, {
    httpOnly: true,
    // Lax rather than Strict: Strict would drop the cookie when arriving from
    // the emailed link, and the person would land signed out on the page that
    // just signed them in.
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    path: '/',
    expires: new Date(expiresAt),
  });
}

export async function clearSessionCookie(): Promise<void> {
  (await cookies()).delete(SESSION_COOKIE);
}

export async function requestLink(email: string): Promise<void> {
  // Ignores the result on purpose. The endpoint answers 202 whatever happened,
  // and surfacing anything else here would reintroduce the enumeration oracle
  // the API went to some trouble to close.
  await post('/v1/console-auth/request-link', { email });
}

export interface PendingFactor {
  readonly challenge: string;
  readonly purpose: 'awaiting_totp' | 'awaiting_totp_enrolment';
  readonly otpauth_uri?: string;
  readonly totp_secret?: string;
}

export async function signInWithPassword(
  email: string,
  password: string,
): Promise<PendingFactor | AuthFailure> {
  const result = await post<PendingFactor>('/v1/console-auth/password', { email, password });
  return result.ok ? result.data : { detail: result.detail };
}

export async function acceptInvite(
  token: string,
  password: string,
): Promise<PendingFactor | AuthFailure> {
  const result = await post<PendingFactor>('/v1/console-auth/accept-invite', { token, password });
  return result.ok ? result.data : { detail: result.detail };
}

interface SessionResponse {
  readonly cookie: string;
  readonly expires_at: string;
}

export async function submitCode(
  challenge: string,
  code: string,
  purpose: PendingFactor['purpose'],
): Promise<AuthFailure | null> {
  const path =
    purpose === 'awaiting_totp_enrolment'
      ? '/v1/console-auth/confirm-enrolment'
      : '/v1/console-auth/totp';

  const result = await post<SessionResponse>(path, { challenge, code });
  if (!result.ok) return { detail: result.detail };

  await setSessionCookie(result.data.cookie, result.data.expires_at);
  return null;
}

export async function signOut(): Promise<void> {
  const cookie = (await cookies()).get(SESSION_COOKIE)?.value;
  if (cookie) await post('/v1/console-auth/sign-out', { cookie });
  await clearSessionCookie();
}

export const isFailure = (value: PendingFactor | AuthFailure): value is AuthFailure =>
  'detail' in value;

/**
 * The half-finished sign-in, parked between the two factors.
 *
 * In a cookie rather than a URL: a challenge in a query string lands in browser
 * history and in any referrer the next request sends, and it names a principal
 * who has already cleared the first factor. httpOnly so no script can read it,
 * and short-lived so an abandoned sign-in on a shared screen stops mattering.
 *
 * The challenge is itself signed and carries its own expiry, so this cookie is
 * a convenience for the browser, not the thing being trusted.
 */
const CHALLENGE_COOKIE = 'eiaaw_console_challenge';

export async function setPendingFactor(pending: PendingFactor): Promise<void> {
  (await cookies()).set(CHALLENGE_COOKIE, JSON.stringify(pending), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env['NODE_ENV'] === 'production',
    path: '/',
    maxAge: 600,
  });
}

export async function getPendingFactor(): Promise<PendingFactor | null> {
  const raw = (await cookies()).get(CHALLENGE_COOKIE)?.value;
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PendingFactor;
  } catch {
    return null;
  }
}

export async function clearPendingFactor(): Promise<void> {
  (await cookies()).delete(CHALLENGE_COOKIE);
}
