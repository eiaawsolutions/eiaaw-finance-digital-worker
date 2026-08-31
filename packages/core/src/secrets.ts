/**
 * Secret resolution — the EIAAW Deploy Contract, made executable.
 *
 * Every non-bootstrap secret is referenced as a handle:
 *
 *     secret://<project>/<environment>/<path>/<NAME>
 *
 * and is dereferenced through Infisical at boot. The three Infisical bootstrap
 * credentials are the only raw values permitted in any deployment target's env.
 *
 * Two invariants this module enforces at runtime, not by convention:
 *
 *   1. A resolved value is held in a `SecretRef`, never in a plain string that
 *      could be interpolated into a log line, a prompt segment or an error. The
 *      value comes out only through `.expose()`, which is greppable.
 *
 *   2. `redact()` scrubs every resolved value from any string before it leaves
 *      the process. The logging boundary and the LLM gateway both call it.
 *      Phase 0 acceptance P0-7 ("no secret is reachable from prompt
 *      construction; the canary never appears") is tested against this.
 */
import { WorkerError } from './errors.js';

const HANDLE_PATTERN = /^secret:\/\/([^/\s]+)\/([^/\s]+)\/(.+)\/([A-Z0-9_]+)$/;

export interface SecretHandle {
  readonly raw: string;
  readonly project: string;
  readonly environment: string;
  readonly path: string;
  readonly name: string;
}

export function isSecretHandle(value: string): boolean {
  return HANDLE_PATTERN.test(value.trim());
}

export function parseSecretHandle(value: string): SecretHandle {
  const match = HANDLE_PATTERN.exec(value.trim());
  if (!match) {
    throw new WorkerError('contract_invalid', {
      detail:
        `"${value}" is not a valid secret handle. The form is ` +
        'secret://<project>/<environment>/<path>/<NAME>. Raw secret values are ' +
        'not permitted outside the three Infisical bootstrap credentials.',
      failureClass: 'configuration',
      retryable: false,
    });
  }
  const [, project = '', environment = '', path = '', name = ''] = match;
  return { raw: value.trim(), project, environment, path: `/${path.replace(/^\/+/, '')}`, name };
}

/**
 * A resolved secret. The value is closed over, not stored as an own property,
 * so `JSON.stringify`, `console.log`, a template literal and a structured-clone
 * all produce the redaction marker rather than the secret.
 */
export class SecretRef {
  readonly name: string;
  readonly #expose: () => string;

  constructor(name: string, value: string) {
    this.name = name;
    this.#expose = () => value;
  }

  /** The only way out. Call at the point of use, never at the point of assembly. */
  expose(): string {
    return this.#expose();
  }

  toString(): string {
    return `[secret:${this.name}]`;
  }
  toJSON(): string {
    return `[secret:${this.name}]`;
  }
  get [Symbol.toStringTag](): string {
    return 'SecretRef';
  }
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    return `[secret:${this.name}]`;
  }
}

export interface SecretProvider {
  /** Resolve one handle. Throws if absent — fail closed, never default. */
  resolve(handle: SecretHandle): Promise<string>;
  /** Warm a batch. Providers with a list API implement this efficiently. */
  prefetch?(handles: readonly SecretHandle[]): Promise<void>;
}

/**
 * Reads from `process.env` using the handle's NAME. For local development and
 * CI only; `INFISICAL_RESOLVER_ENABLED=false` selects it. Refuses to run when
 * DEPLOY_ENVIRONMENT is `prod`.
 */
export class EnvSecretProvider implements SecretProvider {
  constructor(private readonly env: NodeJS.ProcessEnv = process.env) {
    if (this.env['DEPLOY_ENVIRONMENT'] === 'prod') {
      throw new WorkerError('contract_invalid', {
        detail:
          'EnvSecretProvider is refusing to start in a prod deployment. Production ' +
          'secrets resolve through Infisical; set INFISICAL_RESOLVER_ENABLED=true ' +
          'and supply the three bootstrap credentials.',
        failureClass: 'configuration',
        retryable: false,
      });
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async resolve(handle: SecretHandle): Promise<string> {
    const value = this.env[handle.name];
    if (value === undefined || value === '') {
      throw new WorkerError('contract_invalid', {
        detail:
          `Secret "${handle.name}" is not set. In local mode it is read from the ` +
          `environment variable of the same name. Handle: ${handle.raw}`,
        failureClass: 'configuration',
        retryable: false,
        context: { secret_name: handle.name },
      });
    }
    return value;
  }
}

interface InfisicalClientShape {
  secrets(): {
    getSecret(args: {
      environment: string;
      projectId: string;
      secretName: string;
      secretPath: string;
    }): Promise<{ secretValue: string }>;
  };
}

/**
 * Infisical machine-identity provider. Uses the `<project>-app` identity, which
 * holds `secrets:read`. The `mcp-reader` identity (`secrets:list` only) is a
 * different credential and must never be used here.
 */
export class InfisicalSecretProvider implements SecretProvider {
  #client: InfisicalClientShape | undefined;

  constructor(
    private readonly config: {
      readonly clientId: string;
      readonly clientSecret: string;
      readonly projectId: string;
      readonly siteUrl: string;
      readonly defaultEnvironment: string;
    },
  ) {}

  async #ensureClient(): Promise<InfisicalClientShape> {
    if (this.#client) return this.#client;
    // Imported lazily so a local-mode boot never loads the SDK.
    const mod = (await import('@infisical/sdk')) as unknown as {
      InfisicalSDK: new (opts: { siteUrl: string }) => InfisicalClientShape & {
        auth(): {
          universalAuth: { login(a: { clientId: string; clientSecret: string }): Promise<void> };
        };
      };
    };
    const client = new mod.InfisicalSDK({ siteUrl: this.config.siteUrl });
    await client.auth().universalAuth.login({
      clientId: this.config.clientId,
      clientSecret: this.config.clientSecret,
    });
    this.#client = client;
    return client;
  }

  async resolve(handle: SecretHandle): Promise<string> {
    const client = await this.#ensureClient();
    try {
      const result = await client.secrets().getSecret({
        environment: handle.environment || this.config.defaultEnvironment,
        projectId: this.config.projectId,
        secretName: handle.name,
        secretPath: handle.path,
      });
      return result.secretValue;
    } catch (cause) {
      throw new WorkerError('dependency_unavailable', {
        detail:
          `Could not resolve secret "${handle.name}" from Infisical at ` +
          `${handle.environment}${handle.path}. Verify the handle matches a real secret, ` +
          'that the machine identity is scoped to this workspace, and that the ' +
          'three bootstrap credentials are set. Never work around this by setting a raw value.',
        failureClass: 'configuration',
        retryable: true,
        cause,
        context: { secret_name: handle.name, secret_path: handle.path },
      });
    }
  }
}

/** Values registered here are scrubbed from every string passed to `redact`. */
const REGISTERED_VALUES = new Set<string>();
const MIN_REDACTABLE_LENGTH = 8;

export function registerForRedaction(value: string): void {
  if (value.length >= MIN_REDACTABLE_LENGTH) REGISTERED_VALUES.add(value);
}

/**
 * Scrub every known secret value from a string. Called at the logging boundary
 * and immediately before prompt assembly (DWD-06 s.11.2).
 *
 * Defence in depth, not the primary control — the primary control is that a
 * secret never reaches a place where redaction would be needed.
 */
export function redact(input: string): string {
  let out = input;
  for (const value of REGISTERED_VALUES) {
    if (out.includes(value)) out = out.split(value).join('[REDACTED]');
  }
  return out;
}

/** Recursively redact an arbitrary structure before it is logged. */
export function redactDeep<T>(value: T): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return (value as unknown[]).map((v) => redactDeep(v)) as T;
  if (value !== null && typeof value === 'object') {
    if (value instanceof SecretRef) return '[REDACTED]' as T;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out as T;
  }
  return value;
}

export function clearRedactionRegistry(): void {
  REGISTERED_VALUES.clear();
}

/** Caching resolver. One instance per process; handles resolve once. */
export class SecretResolver {
  readonly #cache = new Map<string, SecretRef>();

  constructor(private readonly provider: SecretProvider) {}

  /**
   * Resolve a value that may be a handle or a literal.
   *
   * A literal is returned as-is *and registered for redaction* — that path
   * exists only for values Railway itself owns (DATABASE_URL) and for local
   * development. It is never how a production secret arrives.
   */
  async resolve(value: string, nameHint = 'value'): Promise<SecretRef> {
    const trimmed = value.trim();
    const cached = this.#cache.get(trimmed);
    if (cached) return cached;

    let resolved: string;
    let name: string;

    if (isSecretHandle(trimmed)) {
      const handle = parseSecretHandle(trimmed);
      name = handle.name;
      resolved = await this.provider.resolve(handle);
    } else {
      name = nameHint;
      resolved = trimmed;
    }

    registerForRedaction(resolved);
    const ref = new SecretRef(name, resolved);
    this.#cache.set(trimmed, ref);
    return ref;
  }

  async resolveAll(values: Readonly<Record<string, string>>): Promise<Record<string, SecretRef>> {
    const handles = Object.values(values).filter(isSecretHandle).map(parseSecretHandle);
    if (handles.length > 0 && this.provider.prefetch) await this.provider.prefetch(handles);

    const out: Record<string, SecretRef> = {};
    for (const [key, value] of Object.entries(values)) {
      out[key] = await this.resolve(value, key);
    }
    return out;
  }

  clear(): void {
    this.#cache.clear();
  }
}

export function createSecretProvider(env: NodeJS.ProcessEnv = process.env): SecretProvider {
  const enabled = env['INFISICAL_RESOLVER_ENABLED'] !== 'false';
  if (!enabled) return new EnvSecretProvider(env);

  const clientId = env['INFISICAL_APP_CLIENT_ID'];
  const clientSecret = env['INFISICAL_APP_CLIENT_SECRET'];
  const projectId = env['INFISICAL_PROJECT_ID'];

  if (!clientId || !clientSecret || !projectId) {
    throw new WorkerError('contract_invalid', {
      detail:
        'Infisical resolution is enabled but the bootstrap credentials are incomplete. ' +
        'INFISICAL_APP_CLIENT_ID, INFISICAL_APP_CLIENT_SECRET and INFISICAL_PROJECT_ID ' +
        'must all be set. These three are the only raw credentials permitted; do not ' +
        'work around this by setting raw values for the secrets they unlock.',
      failureClass: 'configuration',
      retryable: false,
    });
  }

  return new InfisicalSecretProvider({
    clientId,
    clientSecret,
    projectId,
    siteUrl: env['INFISICAL_SITE_URL'] ?? 'https://app.infisical.com',
    defaultEnvironment: env['INFISICAL_ENVIRONMENT'] ?? 'dev',
  });
}
