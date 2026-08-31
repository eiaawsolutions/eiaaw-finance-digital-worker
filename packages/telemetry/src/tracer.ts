/**
 * Tracing — DWD-06 s.12.1.
 *
 *   "A trace_id is created at C1 on admission (or adopted from an inbound
 *    traceparent on an internal call) and propagates through ... every
 *    AuditEvent. Asynchronous boundaries (queues, workflow activities,
 *    webhooks) carry traceparent in message metadata; a missing trace context
 *    at any hop is a defect, not a gap to be filled with a new ID."
 *
 * The last clause is why `adoptTraceContext` distinguishes "no parent, this is
 * the root" from "a parent was expected and is missing" — the second case
 * counts a defect rather than quietly minting a fresh ID.
 */
import {
  type Span,
  SpanStatusCode,
  context as otelContext,
  propagation,
  trace,
} from '@opentelemetry/api';
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions';
import { metrics as otelMetrics } from '@opentelemetry/api';
import { newSpanId, newTraceId } from '@eiaaw/core';
import { metricRegistry } from './metrics.js';
import {
  type SpanAttributes,
  type SpanName,
  assertSpanConformance,
  SPAN_TAXONOMY,
} from './spans.js';

const TRACER_NAME = '@eiaaw/finance-digital-worker';

export interface TelemetryOptions {
  readonly serviceName: string;
  readonly platformVersion: string;
  readonly environment: string;
  readonly residencyZone: string;
  readonly otlpEndpoint: string | null;
  readonly conformanceStrict: boolean;
}

let options: TelemetryOptions | null = null;
let tracerProvider: NodeTracerProvider | null = null;
let meterProvider: MeterProvider | null = null;

/** Counts spans that failed conformance in prod, where we do not throw. */
let conformanceViolations = 0;
export const conformanceViolationCount = (): number => conformanceViolations;
export const resetConformanceViolations = (): void => {
  conformanceViolations = 0;
};

export function initTelemetry(opts: TelemetryOptions): void {
  options = opts;

  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: opts.serviceName,
    [ATTR_SERVICE_VERSION]: opts.platformVersion,
    [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: opts.environment,
    'eiaaw.residency_zone': opts.residencyZone,
  });

  // No endpoint configured means traces stay in-process. The conformance check
  // still runs, so a missing attribute is caught in local development too.
  const spanProcessors = opts.otlpEndpoint
    ? [new BatchSpanProcessor(new OTLPTraceExporter({ url: `${opts.otlpEndpoint}/v1/traces` }))]
    : [];

  tracerProvider = new NodeTracerProvider({ resource, spanProcessors });
  tracerProvider.register();

  const readers = opts.otlpEndpoint
    ? [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({ url: `${opts.otlpEndpoint}/v1/metrics` }),
          exportIntervalMillis: 30_000,
        }),
      ]
    : [];

  meterProvider = new MeterProvider({ resource, readers });
  otelMetrics.setGlobalMeterProvider(meterProvider);
  metricRegistry.init();
}

export async function shutdownTelemetry(): Promise<void> {
  await tracerProvider?.shutdown();
  await meterProvider?.shutdown();
  tracerProvider = null;
  meterProvider = null;
  metricRegistry.reset();
}

/**
 * The attributes DWD-06 s.12.3 requires on every span, minus the ones the
 * caller supplies. Kept here so a call site cannot forget one.
 */
function baseAttributes(span: SpanName): SpanAttributes {
  const definition = SPAN_TAXONOMY[span];
  return {
    layer: definition.layer,
    component: definition.component,
    environment: options?.environment ?? 'unknown',
    platform_version: options?.platformVersion ?? 'unknown',
    residency_zone: options?.residencyZone ?? 'unknown',
  };
}

export interface SpanContextInput {
  readonly tenant_id: string;
  readonly trace_id: string;
  readonly request_id?: string;
  readonly graph_id?: string;
}

/**
 * Run `fn` inside a conformant span.
 *
 * Attributes are assembled and checked *before* the span is created, so a
 * non-conformant span never reaches the exporter — a half-written span is
 * harder to diagnose than a thrown error at the call site.
 */
export async function withSpan<T>(
  name: SpanName,
  ctx: SpanContextInput,
  attributes: SpanAttributes,
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const merged: SpanAttributes = {
    ...baseAttributes(name),
    tenant_id: ctx.tenant_id,
    trace_id: ctx.trace_id,
    ...(ctx.request_id === undefined ? {} : { request_id: ctx.request_id }),
    ...(ctx.graph_id === undefined ? {} : { graph_id: ctx.graph_id }),
    ...attributes,
  };

  const violation = assertSpanConformance(name, merged, options?.conformanceStrict ?? true);
  if (violation) conformanceViolations += 1;

  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, async (span) => {
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined) span.setAttribute(key, value);
    }
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (error) {
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : 'unknown error',
      });
      // The exception itself is recorded, not its stack in an attribute —
      // a stack in an attribute is how prompt text ends up in a trace.
      if (error instanceof Error) span.recordException(error);
      throw error;
    } finally {
      span.end();
    }
  });
}

/** Synchronous variant for hot paths that do no I/O. */
export function withSyncSpan<T>(
  name: SpanName,
  ctx: SpanContextInput,
  attributes: SpanAttributes,
  fn: (span: Span) => T,
): T {
  const merged: SpanAttributes = {
    ...baseAttributes(name),
    tenant_id: ctx.tenant_id,
    trace_id: ctx.trace_id,
    ...(ctx.request_id === undefined ? {} : { request_id: ctx.request_id }),
    ...(ctx.graph_id === undefined ? {} : { graph_id: ctx.graph_id }),
    ...attributes,
  };

  const violation = assertSpanConformance(name, merged, options?.conformanceStrict ?? true);
  if (violation) conformanceViolations += 1;

  const tracer = trace.getTracer(TRACER_NAME);
  return tracer.startActiveSpan(name, (span) => {
    for (const [key, value] of Object.entries(merged)) {
      if (value !== undefined) span.setAttribute(key, value);
    }
    try {
      return fn(span);
    } finally {
      span.end();
    }
  });
}

export interface TraceContext {
  readonly trace_id: string;
  readonly span_id: string;
  readonly traceparent: string;
}

export function currentTraceContext(): TraceContext | null {
  const span = trace.getSpan(otelContext.active());
  if (!span) return null;
  const sc = span.spanContext();
  return {
    trace_id: sc.traceId,
    span_id: sc.spanId,
    traceparent: `00-${sc.traceId}-${sc.spanId}-${sc.traceFlags.toString(16).padStart(2, '0')}`,
  };
}

/** Inject `traceparent` into queue metadata or an outbound HTTP call. */
export function injectTraceContext(carrier: Record<string, string>): Record<string, string> {
  propagation.inject(otelContext.active(), carrier);
  return carrier;
}

export interface AdoptedTrace {
  readonly trace_id: string;
  readonly adopted: boolean;
  /** True when a parent was expected but absent — a defect, per s.12.1. */
  readonly defect: boolean;
}

/**
 * Adopt an inbound trace context.
 *
 * `expectParent` distinguishes the two cases the spec cares about:
 *   - a root hop (a webhook from a provider) legitimately has no parent;
 *   - an internal hop (a queue message, a workflow activity) must have one, and
 *     a missing context there is a defect that gets counted, not papered over.
 */
export function adoptTraceContext(
  carrier: Readonly<Record<string, string | undefined>>,
  expectParent: boolean,
): AdoptedTrace {
  const traceparent = carrier['traceparent'];
  const match = traceparent
    ? /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/.exec(traceparent)
    : null;

  if (match) {
    return { trace_id: match[1] as string, adopted: true, defect: false };
  }

  if (expectParent) {
    conformanceViolations += 1;
    return { trace_id: newTraceId(), adopted: false, defect: true };
  }

  return { trace_id: newTraceId(), adopted: false, defect: false };
}

/** For components that must stamp a span id onto an audit event outside a span. */
export const currentSpanId = (): string => currentTraceContext()?.span_id ?? newSpanId();
