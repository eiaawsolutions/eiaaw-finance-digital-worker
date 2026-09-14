/**
 * Liveness for the platform's health check.
 *
 * Deliberately outside the `(app)` route group and deliberately trivial.
 * The check used to point at `/`, which was fine while the console had no
 * authentication; now `/` redirects an unauthenticated request to `/sign-in`,
 * and a 307 is not a passing health check. The deploy was marked failed while
 * the container was running perfectly.
 *
 * It answers for the console process only. It does not reach the API or the
 * database on purpose: a health check that fails when a dependency is down
 * takes this service out of rotation for something it cannot fix, and the
 * dependency has its own check at GET /v1/health.
 */
export const dynamic = 'force-dynamic';

export function GET(): Response {
  return Response.json({ status: 'ok' });
}
