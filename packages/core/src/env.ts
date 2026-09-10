/**
 * Environment loading — fail closed.
 *
 * DWD-06 s.13.3: "Absence is refusal, not a default." That rule is written for
 * AS- settings, but it applies with equal force to platform configuration: a
 * process that boots with a guessed value is a process whose behaviour nobody
 * can reconstruct afterwards.
 *
 * Every required variable is declared here. A missing one aborts the boot with
 * a message that names the variable and what it is for.
 */
import { WorkerError } from './errors.js';
import { type SecretRef, SecretResolver, createSecretProvider } from './secrets.js';

export const DEPLOY_ENVIRONMENTS = ['dev', 'test', 'staging', 'prod'] as const;
export type DeployEnvironment = (typeof DEPLOY_ENVIRONMENTS)[number];

export interface AppConfig {
  readonly nodeEnv: string;
  readonly deployEnvironment: DeployEnvironment;
  readonly platformVersion: string;
  readonly residencyZone: string;

  readonly api: {
    readonly host: string;
    readonly port: number;
    readonly publicUrl: string;
    /**
     * Authenticates the console to the API. Null when unset, which `prod`
     * refuses at boot rather than serving an API nothing can call.
     */
    readonly serviceToken: SecretRef | null;
  };
  readonly consoleUrl: string;

  readonly database: {
    readonly url: SecretRef;
    readonly poolMax: number;
    readonly ssl: boolean;
  };
  readonly redisUrl: SecretRef | null;

  readonly objectStore: {
    readonly driver: 'local' | 's3';
    readonly localPath: string;
    readonly bucket: string;
    readonly endpoint: SecretRef | null;
    readonly accessKeyId: SecretRef | null;
    readonly secretAccessKey: SecretRef | null;
  };

  readonly worm: {
    readonly driver: 'postgres';
    readonly secondaryDriver: 'none' | 's3-object-lock';
    readonly secondaryBucket: string;
    readonly anchorIntervalMinutes: number;
  };

  readonly crypto: {
    readonly auditChainAnchorKey: SecretRef;
    readonly kmsMasterKey: SecretRef;
    readonly nonceSigningKey: SecretRef;
    readonly sessionSigningKey: SecretRef;
    readonly canary: SecretRef | null;
  };

  readonly llm: {
    readonly globalCostCeilingMinor: number;
    readonly globalCostCurrency: string;
    /**
     * Null when the deployment has no Anthropic credential. The provider is
     * then not registered at all, so a tenant routed to it refuses rather than
     * falling back to some other key (DWD-06 s.13: absence is a refusal).
     */
    readonly anthropicApiKey: SecretRef | null;
  };

  /**
   * Retrieval embeddings. `provider` is `none` unless a deployment names one —
   * s.11.1 keeps vendor choices out of the platform, so there is no default
   * model here and `prod` refuses to boot on the deterministic provider.
   */
  readonly embeddings: {
    readonly provider: 'none' | 'voyage';
    readonly model: string | null;
    /** Must match the width of `knowledge_embeddings.embedding`. */
    readonly dimensions: number;
    readonly apiKey: SecretRef | null;
  };

  readonly webhooks: { readonly replayWindowSeconds: number };

  readonly workflow: {
    readonly concurrency: number;
    readonly pollIntervalMs: number;
    readonly leaseSeconds: number;
    readonly maxActivityAttempts: number;
    readonly sweeperIntervalMs: number;
  };

  readonly assurance: {
    readonly suitesPath: string;
    readonly runOutputPath: string;
    readonly releaseGateBlocking: boolean;
  };

  readonly observability: {
    readonly serviceName: string;
    readonly otlpEndpoint: string | null;
    readonly logLevel: 'debug' | 'info' | 'warn' | 'error';
    readonly conformanceStrict: boolean;
  };

  /**
   * DWD-06 s.14.3: dry-run is forced on for every state-changing tool in dev,
   * test and staging — "at the runtime, not by configuration a developer can
   * flip". This is that flag, and it is derived, never read.
   */
  readonly forceDryRun: boolean;
}

interface RequiredOptions {
  readonly purpose: string;
}

function required(env: NodeJS.ProcessEnv, key: string, options: RequiredOptions): string {
  const value = env[key];
  if (value === undefined || value.trim() === '') {
    throw new WorkerError('contract_invalid', {
      detail:
        `Required environment variable ${key} is not set. It is needed to ${options.purpose}. ` +
        'The process refuses to start rather than substitute a value. See .env.example.',
      failureClass: 'configuration',
      retryable: false,
      context: { variable: key },
    });
  }
  return value.trim();
}

function optional(env: NodeJS.ProcessEnv, key: string, fallback: string): string {
  const value = env[key];
  return value === undefined || value.trim() === '' ? fallback : value.trim();
}

function integer(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) {
    throw new WorkerError('contract_invalid', {
      detail: `Environment variable ${key} must be an integer, received "${raw}".`,
      failureClass: 'configuration',
      retryable: false,
    });
  }
  return parsed;
}

const boolean_ = (env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean => {
  const raw = env[key];
  if (raw === undefined || raw.trim() === '') return fallback;
  return raw.trim().toLowerCase() === 'true';
};

function oneOf<T extends string>(
  env: NodeJS.ProcessEnv,
  key: string,
  allowed: readonly T[],
  fallback: T,
): T {
  const raw = optional(env, key, fallback);
  if (!allowed.includes(raw as T)) {
    throw new WorkerError('contract_invalid', {
      detail:
        `Environment variable ${key} must be one of ${allowed.join(', ')}, received "${raw}". ` +
        'Enumerations are closed; a permissive default is a red flag (DWD-06 s.2.3).',
      failureClass: 'configuration',
      retryable: false,
    });
  }
  return raw as T;
}

// `Object.freeze` widens literal types, so the return is asserted rather than
// inferred. The shape is still checked — `satisfies` would reject a mismatch.
export async function loadConfig(env: NodeJS.ProcessEnv = process.env): Promise<AppConfig> {
  const deployEnvironment = oneOf(env, 'DEPLOY_ENVIRONMENT', DEPLOY_ENVIRONMENTS, 'dev');
  const resolver = new SecretResolver(createSecretProvider(env));

  const resolveOptional = async (key: string): Promise<SecretRef | null> => {
    const raw = env[key];
    if (raw === undefined || raw.trim() === '') return null;
    return resolver.resolve(raw, key);
  };

  const databaseUrl = await resolver.resolve(
    required(env, 'DATABASE_URL', { purpose: 'connect to the relational store' }),
    'DATABASE_URL',
  );

  return Object.freeze({
    nodeEnv: optional(env, 'NODE_ENV', 'development'),
    deployEnvironment,
    platformVersion: optional(env, 'PLATFORM_VERSION', '0.1.0'),
    residencyZone: required(env, 'RESIDENCY_ZONE', {
      purpose:
        'stamp every context and every store with a residency zone, so a cross-zone ' +
        'read or write can be refused (DWD-06 s.10.6)',
    }),

    api: {
      host: optional(env, 'API_HOST', '0.0.0.0'),
      port: integer(env, 'API_PORT', 3000),
      publicUrl: optional(env, 'PUBLIC_API_URL', 'http://localhost:3000'),
      serviceToken: await resolveOptional('API_SERVICE_TOKEN'),
    },
    consoleUrl: optional(env, 'PUBLIC_CONSOLE_URL', 'http://localhost:3001'),

    database: {
      url: databaseUrl,
      poolMax: integer(env, 'DATABASE_POOL_MAX', 10),
      ssl: boolean_(env, 'DATABASE_SSL', deployEnvironment === 'prod'),
    },
    redisUrl: await resolveOptional('REDIS_URL'),

    objectStore: {
      driver: oneOf(env, 'OBJECT_STORE_DRIVER', ['local', 's3'] as const, 'local'),
      localPath: optional(env, 'OBJECT_STORE_LOCAL_PATH', './.local-object-store'),
      bucket: optional(env, 'OBJECT_STORE_BUCKET', 'eiaaw-fdw-artifacts'),
      endpoint: await resolveOptional('OBJECT_STORE_ENDPOINT'),
      accessKeyId: await resolveOptional('OBJECT_STORE_ACCESS_KEY_ID'),
      secretAccessKey: await resolveOptional('OBJECT_STORE_SECRET_ACCESS_KEY'),
    },

    worm: {
      driver: 'postgres' as const,
      secondaryDriver: oneOf(
        env,
        'WORM_SECONDARY_DRIVER',
        ['none', 's3-object-lock'] as const,
        'none',
      ),
      secondaryBucket: optional(env, 'WORM_SECONDARY_BUCKET', 'eiaaw-fdw-worm'),
      anchorIntervalMinutes: integer(env, 'WORM_ANCHOR_INTERVAL_MINUTES', 60),
    },

    crypto: {
      auditChainAnchorKey: await resolver.resolve(
        required(env, 'AUDIT_CHAIN_ANCHOR_KEY', {
          purpose: 'sign periodic anchors of the immutable audit hash chain',
        }),
        'AUDIT_CHAIN_ANCHOR_KEY',
      ),
      kmsMasterKey: await resolver.resolve(
        required(env, 'KMS_MASTER_KEY', { purpose: 'derive tenant-scoped field encryption keys' }),
        'KMS_MASTER_KEY',
      ),
      nonceSigningKey: await resolver.resolve(
        required(env, 'NONCE_SIGNING_KEY', {
          purpose: 'bind an approval nonce to a hand-off and a bundle version',
        }),
        'NONCE_SIGNING_KEY',
      ),
      sessionSigningKey: await resolver.resolve(
        required(env, 'SESSION_SIGNING_KEY', { purpose: 'sign console sessions' }),
        'SESSION_SIGNING_KEY',
      ),
      canary: await resolveOptional('SECRET_CANARY'),
    },

    llm: {
      globalCostCeilingMinor: integer(env, 'LLM_GLOBAL_COST_CEILING_MINOR', 500_000),
      globalCostCurrency: optional(env, 'LLM_GLOBAL_COST_CURRENCY', 'MYR'),
      anthropicApiKey: await resolveOptional('ANTHROPIC_API_KEY'),
    },

    embeddings: {
      provider: oneOf(env, 'EMBEDDING_PROVIDER', ['none', 'voyage'] as const, 'none'),
      model: env['EMBEDDING_MODEL']?.trim() || null,
      // 1024 is the width migration 0010 set on knowledge_embeddings.embedding.
      dimensions: integer(env, 'EMBEDDING_DIMENSIONS', 1024),
      apiKey: await resolveOptional('VOYAGE_API_KEY'),
    },

    webhooks: { replayWindowSeconds: integer(env, 'WEBHOOK_REPLAY_WINDOW_SECONDS', 300) },

    workflow: {
      concurrency: integer(env, 'WORKFLOW_WORKER_CONCURRENCY', 8),
      pollIntervalMs: integer(env, 'WORKFLOW_POLL_INTERVAL_MS', 500),
      leaseSeconds: integer(env, 'WORKFLOW_LEASE_SECONDS', 60),
      maxActivityAttempts: integer(env, 'WORKFLOW_MAX_ACTIVITY_ATTEMPTS', 5),
      sweeperIntervalMs: integer(env, 'WORKFLOW_SWEEPER_INTERVAL_MS', 5000),
    },

    assurance: {
      suitesPath: optional(env, 'ASSURANCE_SUITES_PATH', './packages/assurance/suites'),
      runOutputPath: optional(env, 'ASSURANCE_RUN_OUTPUT_PATH', './assurance-runs'),
      // Blocking by default. Making the gate advisory requires an explicit
      // opt-out, which shows up in a config diff.
      releaseGateBlocking: boolean_(env, 'ASSURANCE_RELEASE_GATE_BLOCKING', true),
    },

    observability: {
      serviceName: optional(env, 'OTEL_SERVICE_NAME', 'eiaaw-finance-digital-worker'),
      otlpEndpoint: env['OTEL_EXPORTER_OTLP_ENDPOINT']?.trim() || null,
      logLevel: oneOf(
        env,
        'LOG_LEVEL',
        ['debug', 'info', 'warn', 'error'] as const,
        deployEnvironment === 'prod' ? 'info' : 'debug',
      ),
      conformanceStrict: boolean_(
        env,
        'OBSERVABILITY_CONFORMANCE_STRICT',
        deployEnvironment !== 'prod',
      ),
    },

    // Derived, never read from the environment. A developer cannot flip this.
    forceDryRun: deployEnvironment !== 'prod',
  });
}
