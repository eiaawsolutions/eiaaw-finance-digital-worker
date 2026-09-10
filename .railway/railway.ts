/**
 * Railway infrastructure for the EIAAW Finance Expert digital worker.
 *
 * This file is the desired state of the project. It replaces the deprecated
 * railway.json / deploy/railway/*.json config-as-code, which Railway supports
 * only until 2026-12-01.
 *
 * EIAAW DEPLOY CONTRACT — read before editing.
 *
 *   The only raw secret values that ever exist in this Railway project are the
 *   three Infisical machine-identity bootstrap credentials. They are declared
 *   below with `preserve()`, which means: this file asserts they must exist and
 *   never overwrites them. A human sets their values in the Railway dashboard,
 *   and they never pass through a chat message, a commit, or an agent session.
 *
 *   Every other secret is a `secret://project/env/NAME` HANDLE. A handle is a
 *   pointer, not a credential, so it belongs in source. The resolver
 *   dereferences it at boot; the value never enters a config export, a log line
 *   or a prompt.
 *
 * Four services from one image. Same image means the API and the worker always
 * report the same PLATFORM_VERSION, which the decision record and the evidence
 * bundle both cite — two processes on different versions would produce evidence
 * that disagrees with itself.
 */
import { defineRailway, github, postgres, preserve, project, service } from 'railway/iac';

const REPO = 'eiaawsolutions/eiaaw-finance-digital-worker';
const BRANCH = 'main';

/**
 * Singapore. The residency zone is `my-central` and the nearest Railway region
 * that keeps data inside the intended jurisdiction band is asia-southeast1.
 * A cross-zone read or write refuses with HTTP 451, so this is not cosmetic.
 */
const REGION = 'asia-southeast1-eqsg3a';

/**
 * Restart policy and app-sleeping are deliberately absent from api, worker and
 * console. Railway's defaults are already restart-on-failure and never-sleep,
 * and it stores a default as null — so declaring them here produces a plan that
 * proposes the same three fields forever and never converges. `migrate` sets
 * `NEVER` because that one is not the default and is load-bearing.
 */

export default defineRailway(() => {
  // pgvector ships in Railway's postgres-ssl image; migration 0001 creates the
  // extension and fails loudly rather than silently disabling retrieval.
  const db = postgres('Postgres');

  /** Settings that are not secret and are identical on every service. */
  const runtime = {
    NODE_ENV: 'production',
    // The ONLY thing that lifts forced dry-run. In anything but `prod` every
    // state-changing tool is dry-run at the runtime, not by a flag.
    DEPLOY_ENVIRONMENT: 'prod',
    PLATFORM_VERSION: '0.1.0',
    RESIDENCY_ZONE: 'my-central',

    DATABASE_URL: db.env.DATABASE_URL,
    DATABASE_SSL: 'true',
    DATABASE_POOL_MAX: '10',

    // --- Infisical bootstrap: the only raw credentials in this project ------
    // Set by a human in the Railway dashboard. `preserve()` means this file
    // requires them and never writes them.
    INFISICAL_APP_CLIENT_ID: preserve(),
    INFISICAL_APP_CLIENT_SECRET: preserve(),
    INFISICAL_PROJECT_ID: preserve(),
    INFISICAL_ENVIRONMENT: 'prod',
    INFISICAL_SITE_URL: 'https://app.infisical.com',
    INFISICAL_RESOLVER_ENABLED: 'true',

    // --- everything below is a handle, never a value -----------------------
    //
    // These follow the EIAAW house convention (2026-09-10): the shared
    // `eiaaw-all-projects` workspace, one environment per stage, every secret
    // flat at the root. No per-domain folders — that is how every other EIAAW
    // service already reads its secrets, and matching it means an operator
    // reads one layout across the whole estate instead of one per project.
    //
    // The cost is blast-radius separation. The audit-chain anchor key and the
    // KMS master key sit in the same workspace as every other EIAAW app's
    // secrets, read by an identity already spread across six services.
    // Compromise of that identity reaches this worker's integrity keys.
    //
    // If the finance worker ever takes on a client whose contract requires
    // segregated key custody, this is the first thing to change: create a
    // dedicated workspace, move these nine secrets into it, issue a dedicated
    // machine identity, and repoint INFISICAL_PROJECT_ID. The handles keep
    // working — the resolver dereferences them by environment, path and name
    // against INFISICAL_PROJECT_ID, so the project segment is documentation.
    // Keeping that segment honest is what stops a future reader hunting for a
    // workspace that does not exist.
    AUDIT_CHAIN_ANCHOR_KEY: 'secret://eiaaw-all-projects/prod/AUDIT_CHAIN_ANCHOR_KEY',
    KMS_MASTER_KEY: 'secret://eiaaw-all-projects/prod/KMS_MASTER_KEY',
    NONCE_SIGNING_KEY: 'secret://eiaaw-all-projects/prod/NONCE_SIGNING_KEY',
    SESSION_SIGNING_KEY: 'secret://eiaaw-all-projects/prod/SESSION_SIGNING_KEY',
    SECRET_CANARY: 'secret://eiaaw-all-projects/prod/SECRET_CANARY',

    ANTHROPIC_API_KEY: 'secret://eiaaw-all-projects/prod/ANTHROPIC_API_KEY',
    LLM_GLOBAL_COST_CEILING_MINOR: '500000',
    LLM_GLOBAL_COST_CURRENCY: 'MYR',

    OBJECT_STORE_DRIVER: 's3',
    OBJECT_STORE_BUCKET: 'eiaaw-fdw-artifacts',
    OBJECT_STORE_ENDPOINT: 'secret://eiaaw-all-projects/prod/R2_ENDPOINT',
    OBJECT_STORE_ACCESS_KEY_ID: 'secret://eiaaw-all-projects/prod/R2_ACCESS_KEY_ID',
    OBJECT_STORE_SECRET_ACCESS_KEY: 'secret://eiaaw-all-projects/prod/R2_SECRET_ACCESS_KEY',

    WORM_DRIVER: 'postgres',
    WORM_SECONDARY_DRIVER: 'none',
    WORM_ANCHOR_INTERVAL_MINUTES: '60',

    WEBHOOK_REPLAY_WINDOW_SECONDS: '300',
    WHATSAPP_BSP_DRIVER: 'stub',

    OTEL_SERVICE_NAME: 'eiaaw-finance-digital-worker',
    LOG_LEVEL: 'info',
    OBSERVABILITY_CONFORMANCE_STRICT: 'true',

    ASSURANCE_RELEASE_GATE_BLOCKING: 'true',
  } as const;

  const dockerBuild = {
    builder: 'DOCKERFILE',
    dockerfilePath: 'Dockerfile',
  } as const;

  /**
   * Schema and platform registries. Run-once per deploy, and it must finish
   * before the API boots against a schema it does not expect.
   *
   * The migration runner takes a Postgres advisory lock, so this is safe to
   * overlap with a rolling API deploy — but ordering it first means the
   * question never arises. It restarts NEVER: a failed migration is a signal to
   * look, not to retry in a loop.
   *
   * It seeds no client value and no statutory rate. Every threshold, rate,
   * limit and approver is entered by a human at enrolment.
   */
  const migrate = service('migrate', {
    source: github(REPO, { branch: BRANCH }),
    build: dockerBuild,
    deploy: {
      // One script, not `A && B` inline: the chaining is then pnpm's, and does
      // not depend on how the platform invokes the start command.
      startCommand: 'pnpm db:release',
      restartPolicyType: 'NEVER',
    },
    replicas: { [REGION]: 1 },
    env: {
      DATABASE_URL: db.env.DATABASE_URL,
      DATABASE_SSL: 'true',
      RESIDENCY_ZONE: 'my-central',
      NODE_ENV: 'production',
    },
  });

  const api = service('api', {
    source: github(REPO, { branch: BRANCH }),
    build: dockerBuild,
    deploy: {
      startCommand: 'node apps/api/dist/main.js',
      // Reports force_dry_run, so you never have to guess which mode a
      // deployment is in.
      healthcheckPath: '/v1/health',
      healthcheckTimeout: 90,
    },
    replicas: { [REGION]: 2 },
    env: { ...runtime, API_HOST: '0.0.0.0', API_PORT: '3000' },
  });

  /**
   * Not optional, and not just the workflow executor.
   *
   * It also runs the governance jobs: audit chain verification (15 min), chain
   * anchoring (60 min), hand-off SLA escalation (1 min), conversation idle
   * close (5 min) and settings staleness checks (30 min). Scaling the API and
   * forgetting this service leaves the audit chain unverified.
   *
   * One replica to start. Leasing is FOR UPDATE SKIP LOCKED so N replicas are
   * safe and will not double-execute, but raise WORKFLOW_WORKER_CONCURRENCY
   * before raising replica count: in-process loops are cheaper than containers.
   */
  const worker = service('worker', {
    source: github(REPO, { branch: BRANCH }),
    build: dockerBuild,
    deploy: {
      startCommand: 'node apps/worker/dist/main.js',
    },
    replicas: { [REGION]: 1 },
    env: {
      ...runtime,
      WORKFLOW_WORKER_CONCURRENCY: '8',
      WORKFLOW_POLL_INTERVAL_MS: '500',
      WORKFLOW_LEASE_SECONDS: '60',
      WORKFLOW_MAX_ACTIVITY_ATTEMPTS: '5',
      WORKFLOW_SWEEPER_INTERVAL_MS: '5000',
    },
  });

  /**
   * The reviewer's workspace and the operator's view.
   *
   * It calls the API server-side only, over the private network, so the session
   * credential never reaches a browser and the API needs no public origin
   * allowance for it.
   */
  const consoleUi = service('console', {
    source: github(REPO, { branch: BRANCH }),
    build: dockerBuild,
    deploy: {
      startCommand: 'pnpm --filter @eiaaw/console start',
      healthcheckPath: '/',
      healthcheckTimeout: 90,
    },
    replicas: { [REGION]: 1 },
    env: {
      NODE_ENV: 'production',
      PORT: '3001',
      // Railway's own reference syntax, resolved at deploy time. A JavaScript
      // template literal cannot be used here: `api.env.X` is a reference
      // object, not a string, so interpolating it yields "[object Object]".
      PUBLIC_API_URL: 'http://${{api.RAILWAY_PRIVATE_DOMAIN}}:3000',
    },
  });

  return project('eiaaw-finance-digital-worker', {
    resources: [db, migrate, api, worker, consoleUi],
  });
});
