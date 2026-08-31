/**
 * @eiaaw/telemetry — the observability contract (DWD-06 s.12).
 *
 * One trace ID from the inbound byte to the delivered artefact, a fixed span
 * taxonomy across all ten layers, required attributes enforced in CI rather
 * than by convention, and cost attributed at emission.
 */
export * from './spans.js';
export * from './metrics.js';
export * from './tracer.js';
export * from './logger.js';
