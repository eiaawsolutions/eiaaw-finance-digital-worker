/**
 * API entrypoint.
 *
 * Boots the container in build order, starts Fastify, and installs a graceful
 * shutdown so an in-flight request is not cut off mid-audit-write — an
 * operation that fails after its audit event but before its effect is the one
 * shape the failure model cannot describe.
 */
import { buildContainer } from './container.js';
import { startServer } from './server.js';

async function main(): Promise<void> {
  const container = await buildContainer();
  const app = await startServer(container);

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
