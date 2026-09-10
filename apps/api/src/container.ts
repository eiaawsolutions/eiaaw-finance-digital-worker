/**
 * The composition root.
 *
 * Every component is constructed here, once, and wired in the order the build
 * graph requires (DWD-06 s.15): foundations → audit → configuration → context →
 * knowledge → registries → tool invoker → assurance → orchestration → skill
 * runtime → delivery → authorisation.
 *
 * The order is not decorative. s.15.1: "Never build a layer whose dependencies
 * are stubbed by something that acts." Constructing in build order means a
 * missing dependency fails at boot rather than at the first request.
 */
import { type AppConfig, type SecretRef, WorkerError, loadConfig, money } from '@eiaaw/core';
import {
  type Database,
  type ObjectStore,
  closeDatabase,
  createDatabase,
  createObjectStore,
} from '@eiaaw/db';
import { AuditStore, EvidenceStore, emitterFor, type AuditEmitter } from '@eiaaw/audit';
import { ConfigService } from '@eiaaw/config';
import { ContextResolver } from '@eiaaw/context';
import { KnowledgeService, createEmbeddingProvider } from '@eiaaw/knowledge';
import { SkillRegistry } from '@eiaaw/registry';
import { PolicyEngine } from '@eiaaw/policy';
import {
  LlmGateway,
  StubProvider,
  AnthropicProvider,
  VoyageEmbeddingProvider,
  type ModelProvider,
} from '@eiaaw/llm';
import { CalculationConnector, ToolInvoker, stubConnectors } from '@eiaaw/connectors';
import { SkillRuntime } from '@eiaaw/skills';
import { Planner } from '@eiaaw/planner';
import { WorkflowExecutor } from '@eiaaw/workflow';
import { HandoffService, ScopeCardService } from '@eiaaw/authorisation';
import { DeliveryService } from '@eiaaw/delivery';
import { ALL_CAPABILITIES, type ChannelAdapter, type ChannelName } from '@eiaaw/channels';
import { HARNESS_VERSION } from '@eiaaw/assurance';
import {
  createLogger,
  initTelemetry,
  metricRegistry,
  shutdownTelemetry,
  type Logger,
} from '@eiaaw/telemetry';

export interface Container {
  readonly config: AppConfig;
  readonly log: Logger;
  readonly db: Database;
  readonly objects: ObjectStore;
  readonly audit: AuditStore;
  readonly evidence: EvidenceStore;
  readonly emitter: (component: Parameters<typeof emitterFor>[1]) => AuditEmitter;
  readonly settings: ConfigService;
  readonly context: ContextResolver;
  readonly knowledge: KnowledgeService;
  readonly skills: SkillRegistry;
  readonly policy: PolicyEngine;
  readonly gateway: LlmGateway;
  readonly tools: ToolInvoker;
  readonly runtime: SkillRuntime;
  readonly planner: Planner;
  readonly workflow: WorkflowExecutor;
  readonly handoffs: HandoffService;
  readonly scopeCards: ScopeCardService;
  readonly delivery: DeliveryService;
  shutdown(): Promise<void>;
}

/**
 * The hosted embedding provider, or undefined when this deployment names none.
 *
 * Undefined is not "fall back to something": `createEmbeddingProvider` returns
 * the deterministic provider in dev and refuses outright in prod. Naming a
 * provider without the settings it needs is the louder failure, so it is
 * reported here rather than surfacing later as empty retrieval.
 */
function buildHostedEmbeddings(config: AppConfig): VoyageEmbeddingProvider | undefined {
  if (config.embeddings.provider === 'none') return undefined;

  const missing = [
    config.embeddings.model ? null : 'EMBEDDING_MODEL',
    config.embeddings.apiKey ? null : 'VOYAGE_API_KEY',
  ].filter((name): name is string => name !== null);

  if (missing.length > 0) {
    throw new WorkerError('contract_invalid', {
      detail:
        `EMBEDDING_PROVIDER is "${config.embeddings.provider}" but ${missing.join(' and ')} ` +
        `${missing.length === 1 ? 'is' : 'are'} not set. Retrieval without embeddings ` +
        'returns nothing, which reads as "the knowledge base has no answer" rather than ' +
        'as a misconfiguration — so this refuses at boot instead.',
      failureClass: 'configuration',
      retryable: false,
    });
  }

  return new VoyageEmbeddingProvider({
    apiKey: config.embeddings.apiKey as SecretRef,
    model: config.embeddings.model as string,
    dimensions: config.embeddings.dimensions,
  });
}

export async function buildContainer(
  adapters: ReadonlyMap<ChannelName, ChannelAdapter> = new Map(),
): Promise<Container> {
  // --- S1 foundations ----------------------------------------------------
  const config = await loadConfig();

  initTelemetry({
    serviceName: config.observability.serviceName,
    platformVersion: config.platformVersion,
    environment: config.deployEnvironment,
    residencyZone: config.residencyZone,
    otlpEndpoint: config.observability.otlpEndpoint,
    conformanceStrict: config.observability.conformanceStrict,
  });
  metricRegistry.init();

  const log = createLogger({
    level: config.observability.logLevel,
    serviceName: config.observability.serviceName,
    environment: config.deployEnvironment,
    pretty: config.deployEnvironment === 'dev',
  });

  const db = createDatabase({
    url: config.database.url,
    poolMax: config.database.poolMax,
    ssl: config.database.ssl,
    applicationName: 'eiaaw-fdw-api',
  });

  const objects = createObjectStore({
    db,
    residencyZone: config.residencyZone,
    driver: config.objectStore.driver,
    localPath: config.objectStore.localPath,
    bucket: config.objectStore.bucket,
    // `expose()` at the point of use, not at assembly — the resolved values go
    // straight into the S3 client and never sit in an intermediate string.
    endpoint: config.objectStore.endpoint?.expose() ?? null,
    accessKeyId: config.objectStore.accessKeyId?.expose() ?? null,
    secretAccessKey: config.objectStore.secretAccessKey?.expose() ?? null,
  });

  // --- S2 audit — before anything that can act ---------------------------
  const audit = new AuditStore({
    db,
    residencyZone: config.residencyZone,
    payloadSink: {
      put: async (tenantId, key, body) => {
        const stored = await objects.put({
          tenantId,
          objectClass: 'audit_payload',
          body,
          mediaType: 'application/json',
          key,
        });
        return stored.storage_ref;
      },
    },
  });

  const evidence = new EvidenceStore({
    db,
    residencyZone: config.residencyZone,
    platformVersion: config.platformVersion,
  });

  // --- S3 configuration --------------------------------------------------
  const settings = new ConfigService({ db, residencyZone: config.residencyZone });

  // --- S4 context --------------------------------------------------------
  const context = new ContextResolver({
    db,
    config: settings,
    residencyZone: config.residencyZone,
  });

  // --- S5 knowledge ------------------------------------------------------
  // Spread rather than passed as `hosted: undefined`: exactOptionalPropertyTypes
  // distinguishes "absent" from "present and undefined", and absent is what
  // "this deployment names no hosted provider" means.
  const hostedEmbeddings = buildHostedEmbeddings(config);
  const knowledge = new KnowledgeService({
    db,
    residencyZone: config.residencyZone,
    embeddings: createEmbeddingProvider({
      deployEnvironment: config.deployEnvironment,
      dimensions: config.embeddings.dimensions,
      ...(hostedEmbeddings ? { hosted: hostedEmbeddings } : {}),
    }),
  });

  // --- S6 registries -----------------------------------------------------
  const skills = new SkillRegistry(db, config.residencyZone);

  // --- S7 tool invoker — before orchestration ----------------------------
  const tools = new ToolInvoker({
    db,
    residencyZone: config.residencyZone,
    // Derived from the environment, never read from configuration.
    forceDryRun: config.forceDryRun,
    connectors: [new CalculationConnector(), ...stubConnectors()],
  });

  // --- S9/S10 policy, gateway, skill runtime -----------------------------
  const policy = new PolicyEngine({ db, config: settings, residencyZone: config.residencyZone });

  const providers = new Map<string, ModelProvider>();
  providers.set('stub', new StubProvider());
  // The model and provider a tenant uses come from AS-SYS-040. Register the
  // Anthropic provider only when its own credential resolved: the gateway
  // refuses a route to an unregistered provider, and a refusal is the correct
  // outcome of a missing credential (DWD-06 s.13.3).
  //
  // This previously passed `config.crypto.kmsMasterKey`, which the provider
  // would have sent to api.anthropic.com as the bearer credential on the first
  // real call — handing a third party the key that derives every tenant's
  // field-encryption keys. Never substitute one secret for another to make a
  // constructor signature happy.
  if (config.llm.anthropicApiKey) {
    providers.set('anthropic', new AnthropicProvider(config.llm.anthropicApiKey));
  }

  const gateway = new LlmGateway({
    providers,
    globalCostCeiling: money(config.llm.globalCostCeilingMinor, config.llm.globalCostCurrency),
  });

  const runtime = new SkillRuntime({
    db,
    residencyZone: config.residencyZone,
    knowledge,
    gateway,
    harnessVersion: HARNESS_VERSION,
  });

  const planner = new Planner({
    db,
    residencyZone: config.residencyZone,
    config: settings,
    skills,
    forceDryRun: config.forceDryRun,
  });

  const workflow = new WorkflowExecutor({
    db,
    residencyZone: config.residencyZone,
    audit: emitterFor(audit, 'C7'),
    logger: log,
    leaseSeconds: config.workflow.leaseSeconds,
  });

  // --- S11 delivery ------------------------------------------------------
  const delivery = new DeliveryService({
    db,
    residencyZone: config.residencyZone,
    adapters,
    capabilities: ALL_CAPABILITIES,
  });

  // --- S12 authorisation -------------------------------------------------
  const handoffs = new HandoffService({
    db,
    residencyZone: config.residencyZone,
    nonceSigningKey: config.crypto.nonceSigningKey,
  });

  const scopeCards = new ScopeCardService(db, config.residencyZone);

  // `environment` is already a base binding on the logger; repeating it here
  // emitted the key twice in one JSON object, which some log ingesters reject
  // and others silently pick a winner from.
  log.info('container built', {
    residency_zone: config.residencyZone,
    platform_version: config.platformVersion,
    force_dry_run: config.forceDryRun,
  });

  return {
    config,
    log,
    db,
    objects,
    audit,
    evidence,
    emitter: (component) => emitterFor(audit, component),
    settings,
    context,
    knowledge,
    skills,
    policy,
    gateway,
    tools,
    runtime,
    planner,
    workflow,
    handoffs,
    scopeCards,
    delivery,
    async shutdown() {
      log.info('shutting down');
      await shutdownTelemetry();
      await closeDatabase(db);
    },
  };
}
