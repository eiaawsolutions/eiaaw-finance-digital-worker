/**
 * How this console reaches the API, and how it proves it is the console.
 *
 * Extracted so both the API client and the sign-in flow can use it without
 * importing each other — sign-in needs the transport, and the API client needs
 * the session that sign-in establishes.
 *
 * Server-side only. The token is dereferenced here and never appears in
 * anything the browser receives.
 */
import { SecretResolver, createSecretProvider } from '@eiaaw/core';

export const API_URL = process.env['PUBLIC_API_URL'] ?? 'http://localhost:3000';

/**
 * `API_SERVICE_TOKEN` arrives as a `secret://` handle like every other secret,
 * so it is dereferenced rather than sent as-is — the deploy contract puts
 * handles in configuration and values only in memory. Resolved once and held,
 * so a page render never waits on Infisical twice.
 *
 * It proves the request came from the console, not which human is acting. The
 * principal headers say that, and since the console now establishes its own
 * sessions, they name somebody who actually signed in.
 */
let resolvedToken: Promise<string> | null = null;

export function serviceToken(): Promise<string> {
  const raw = process.env['API_SERVICE_TOKEN'];
  if (!raw) return Promise.resolve('');

  resolvedToken ??= new SecretResolver(createSecretProvider())
    .resolve(raw, 'API_SERVICE_TOKEN')
    .then((ref) => ref.expose())
    .catch(() => {
      // Let the next render try again rather than caching a failure for the
      // lifetime of the process.
      resolvedToken = null;
      return '';
    });

  return resolvedToken;
}
