/**
 * Structured logging.
 *
 * file 07 s.5.2 draws a line this module enforces:
 *
 *   "The **operational log** (Observability rail) is for engineers and is
 *    aggressively pseudonymised. The **audit log** (Governance rail, section 9)
 *    must name the human who approved something, because non-repudiation
 *    requires it."
 *
 * This is the operational log. It never names a principal, never carries model
 * text, and passes everything through the secret redaction registry on the way
 * out. Anything that must name a human goes to `@eiaaw/audit` instead.
 */
import { createRequire } from 'node:module';
import { pino, type Logger as PinoLogger } from 'pino';
import { redactDeep } from '@eiaaw/core';
import { currentTraceContext } from './tracer.js';
import { FORBIDDEN_SPAN_ATTRIBUTES } from './spans.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  readonly tenant_id?: string;
  readonly request_id?: string;
  readonly graph_id?: string;
  readonly node_id?: string;
  readonly component?: string;
  readonly layer?: string;
  readonly [key: string]: unknown;
}

/**
 * Pseudonymise a principal id.
 *
 * Deliberately not a hash of the id alone: an engineer correlating two log
 * lines needs to know they refer to the same person, but nobody reading the
 * operational log should be able to recover who. Truncating the id keeps
 * within-session correlation and drops identity.
 */
export function pseudonymise(principalId: string | null | undefined): string {
  if (!principalId) return 'anon';
  return `p:${principalId.slice(-4)}`;
}

const FORBIDDEN = new Set(FORBIDDEN_SPAN_ATTRIBUTES);

/**
 * Strip fields that must never appear in an operational log line, at any depth.
 *
 * `principal_id` is rewritten rather than dropped — a log line that has lost
 * the ability to distinguish two users is much less useful, and pseudonymising
 * keeps that without keeping identity.
 */
function scrubFields(value: unknown, depth = 0): unknown {
  if (depth > 8 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => scrubFields(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (FORBIDDEN.has(lower)) {
      out[key] = '[WITHHELD]';
      continue;
    }
    if (lower === 'principal_id' || lower === 'assignee_principal_id') {
      out[key] = pseudonymise(typeof child === 'string' ? child : null);
      continue;
    }
    out[key] = scrubFields(child, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

class PinoLoggerAdapter implements Logger {
  constructor(private readonly inner: PinoLogger) {}

  #emit(level: LogLevel, message: string, fields: LogFields = {}): void {
    const traceContext = currentTraceContext();
    // Redaction order matters: scrub structure first, then sweep for any
    // registered secret value that survived as a substring.
    const payload = redactDeep(
      scrubFields({
        ...fields,
        ...(traceContext === null
          ? {}
          : { trace_id: traceContext.trace_id, span_id: traceContext.span_id }),
      }),
    );
    this.inner[level](payload as object, redactDeep(message));
  }

  debug(message: string, fields?: LogFields): void {
    this.#emit('debug', message, fields);
  }
  info(message: string, fields?: LogFields): void {
    this.#emit('info', message, fields);
  }
  warn(message: string, fields?: LogFields): void {
    this.#emit('warn', message, fields);
  }
  error(message: string, fields?: LogFields): void {
    this.#emit('error', message, fields);
  }
  child(fields: LogFields): Logger {
    return new PinoLoggerAdapter(this.inner.child(scrubFields(fields) as object));
  }
}

export interface LoggerOptions {
  readonly level: LogLevel;
  readonly serviceName: string;
  readonly environment: string;
  readonly pretty?: boolean;
}

/**
 * Pretty output is a local-development nicety, not a dependency.
 *
 * `pino-pretty` is deliberately not a runtime dependency: shipping a formatter
 * into a production image to make logs readable on a laptop is the wrong
 * trade. If it happens to be installed, dev uses it; otherwise dev gets JSON,
 * which is what production gets anyway.
 */
function prettyTransportIfAvailable(): { target: string; options: object } | null {
  try {
    createRequire(import.meta.url).resolve('pino-pretty');
    return { target: 'pino-pretty', options: { colorize: true, translateTime: 'HH:MM:ss.l' } };
  } catch {
    return null;
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const transport = options.pretty === true ? prettyTransportIfAvailable() : null;

  const inner = pino({
    level: options.level,
    base: { service: options.serviceName, environment: options.environment },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Belt and braces: pino's own redaction catches these paths even if a
    // caller bypasses `scrubFields` by logging a pino object directly.
    redact: {
      paths: [
        'password',
        'token',
        'api_key',
        'apiKey',
        'authorization',
        'cookie',
        '*.password',
        '*.token',
        '*.api_key',
        '*.secret',
        'headers.authorization',
        'headers.cookie',
      ],
      censor: '[REDACTED]',
    },
    ...(transport === null ? {} : { transport }),
  });
  return new PinoLoggerAdapter(inner);
}

/**
 * A no-op logger for tests and for code paths that must not emit.
 * Never the default: silence in production is worse than noise.
 */
export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => nullLogger,
};
