/**
 * API entrypoint.
 *
 * Boots the container in build order, starts Fastify, and installs a graceful
 * shutdown so an in-flight request is not cut off mid-audit-write — an
 * operation that fails after its audit event but before its effect is the one
 * shape the failure model cannot describe.
 */
import { WorkerError } from '@eiaaw/core';
import { serviceTokenAuthenticator } from './authenticate.js';
import { buildContainer } from './container.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
  const container = await buildContainer();

  // Outside prod the default header authenticator stands, which is what the
  // integration tests and local development use.
  //
  // In prod that default returns null for every request by design, so without a
  // real authenticator the API boots healthy and answers 401 to everything that
  // needs a caller. That is precisely how this deployment spent its first day:
  // green health check, unreachable console. Refusing to start is the louder
  // failure and the correct one.
  let authenticate;
  if (container.config.deployEnvironment === 'prod') {
    const token = container.config.api.serviceToken;
    if (!token) {
      throw new WorkerError('contract_invalid', {
        detail:
          'API_SERVICE_TOKEN is not set. In prod the header authenticator is refused, so ' +
          'without it every endpoint requiring a caller answers 401 and the console cannot ' +
          'reach the API at all. Set the handle rather than running an API nothing can call.',
        failureClass: 'configuration',
        retryable: false,
      });
    }
    authenticate = serviceTokenAuthenticator(token);
  }

  const app = await startServer(container, authenticate);

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    container.log.info('shutdown signal received', { signal });

    // Stop accepting, drain in-flight, then release resources.
    await app.close();
    await container.shutdown();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  process.on('unhandledRejection', (reason) => {
    container.log.error('unhandled rejection', { detail: String(reason) });
  });
}

main().catch((error: unknown) => {
  // Boot failures print plainly: the logger may be the thing that failed.
  console.error('\nAPI failed to start.\n');
  console.error(error instanceof Error ? error.message : error);
  if (error instanceof Error && error.stack) console.error(`\n${error.stack}`);
  process.exit(1);
});
