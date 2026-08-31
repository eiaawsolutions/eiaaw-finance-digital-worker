#!/usr/bin/env tsx
/**
 * Observability conformance — the CI job behind DWD-06 s.12.3.
 *
 *   "A span missing any of these fails the observability conformance test in CI."
 *
 * Three checks:
 *   1. every span in the taxonomy declares a layer, component and parent that
 *      exist, so the trace tree in s.12.2 is actually buildable;
 *   2. every metric in s.12.4 is registered — a metric that was specified and
 *      never wired is the failure mode this catches;
 *   3. the four governance-dashboard metrics are present, since they are the
 *      operational face of governance and their absence is not a nuance.
 */
import { COMPONENTS, LAYERS } from '@eiaaw/contracts';
import { GOVERNANCE_DASHBOARD_METRICS, METRIC_DEFINITIONS, metricRegistry } from './metrics.js';
import { SPAN_NAMES, SPAN_TAXONOMY, REQUIRED_SPAN_ATTRIBUTES } from './spans.js';
import { initTelemetry, shutdownTelemetry } from './tracer.js';

interface Failure {
  readonly check: string;
  readonly detail: string;
}

function checkSpanTaxonomy(): Failure[] {
  const failures: Failure[] = [];
  const names = new Set<string>(SPAN_NAMES);

  for (const name of SPAN_NAMES) {
    const definition = SPAN_TAXONOMY[name];

    if (!(LAYERS as readonly string[]).includes(definition.layer)) {
      failures.push({
        check: 'span.layer',
        detail: `${name} declares unknown layer "${definition.layer}"`,
      });
    }
    if (!(COMPONENTS as readonly string[]).includes(definition.component)) {
      failures.push({
        check: 'span.component',
        detail: `${name} declares unknown component "${definition.component}"`,
      });
    }
    if (definition.parent !== null && !names.has(definition.parent)) {
      failures.push({
        check: 'span.parent',
        detail: `${name} declares parent "${definition.parent}", which is not in the taxonomy`,
      });
    }
    if (definition.keyAttributes.length === 0) {
      failures.push({
        check: 'span.attributes',
        detail: `${name} declares no key attributes; s.12.2 names at least one for every span`,
      });
    }
  }

  // A cycle in the parent chain would make the trace tree unbuildable.
  for (const name of SPAN_NAMES) {
    const seen = new Set<string>([name]);
    let cursor = SPAN_TAXONOMY[name].parent;
    while (cursor !== null) {
      if (seen.has(cursor)) {
        failures.push({ check: 'span.parent', detail: `${name} has a cyclic parent chain` });
        break;
      }
      seen.add(cursor);
      cursor = SPAN_TAXONOMY[cursor].parent;
    }
  }

  return failures;
}

function checkMetrics(): Failure[] {
  const failures: Failure[] = [];

  initTelemetry({
    serviceName: 'conformance',
    platformVersion: '0.0.0',
    environment: 'test',
    residencyZone: 'my-central',
    otlpEndpoint: null,
    conformanceStrict: true,
  });

  const registered = new Set(metricRegistry.registeredNames());

  for (const definition of METRIC_DEFINITIONS) {
    if (!registered.has(definition.name)) {
      failures.push({
        check: 'metric.registered',
        detail: `${definition.name} is specified in s.12.4 but is not registered`,
      });
    }
    if (definition.dimensions.length === 0) {
      failures.push({
        check: 'metric.dimensions',
        detail: `${definition.name} declares no dimensions`,
      });
    }
  }

  for (const name of GOVERNANCE_DASHBOARD_METRICS) {
    if (!registered.has(name)) {
      failures.push({
        check: 'metric.governance',
        detail: `${name} is one of the four governance-dashboard metrics and is missing`,
      });
    }
  }

  if (GOVERNANCE_DASHBOARD_METRICS.length !== 4) {
    failures.push({
      check: 'metric.governance',
      detail:
        `s.12.4 names four governance-dashboard metrics; ` +
        `${GOVERNANCE_DASHBOARD_METRICS.length} are marked`,
    });
  }

  return failures;
}

async function main(): Promise<void> {
  const failures = [...checkSpanTaxonomy(), ...checkMetrics()];
  await shutdownTelemetry();

  console.log('Observability conformance (DWD-06 s.12)');
  console.log(`  spans in taxonomy      : ${SPAN_NAMES.length}`);
  console.log(`  required attributes    : ${REQUIRED_SPAN_ATTRIBUTES.join(', ')}`);
  console.log(`  metrics specified      : ${METRIC_DEFINITIONS.length}`);
  console.log(`  governance dashboard   : ${GOVERNANCE_DASHBOARD_METRICS.join(', ')}`);

  if (failures.length === 0) {
    console.log('\n✔ conformance passed');
    process.exit(0);
  }

  console.error(`\n✖ conformance failed with ${failures.length} finding(s):`);
  for (const failure of failures) console.error(`  [${failure.check}] ${failure.detail}`);
  process.exit(1);
}

void main();
