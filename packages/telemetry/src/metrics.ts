/**
 * The metric set — DWD-06 s.12.4.
 *
 * "Metrics that must exist." Declaring them in one place means the CI
 * conformance job can assert that each is registered, rather than discovering
 * six months later that `accuracy_floor_margin` was never wired.
 *
 * s.12.4 (L8) singles out four as "the operational face of governance": they
 * belong on the primary dashboard, and they are marked here so the dashboard
 * definition is derived rather than hand-maintained.
 */
import { type Attributes, type Counter, type Histogram, metrics } from '@opentelemetry/api';

export type MetricKind = 'counter' | 'histogram' | 'gauge';

export interface MetricDefinition {
  readonly name: string;
  readonly kind: MetricKind;
  readonly description: string;
  readonly unit?: string;
  readonly dimensions: readonly string[];
  /** DWD-06 s.12.4 — belongs on the primary governance dashboard. */
  readonly governanceDashboard?: true;
}

export const METRIC_DEFINITIONS: readonly MetricDefinition[] = [
  {
    name: 'requests_admitted_total',
    kind: 'counter',
    description: 'Inbound requests admitted at the channel gateway.',
    dimensions: ['channel', 'reason'],
  },
  {
    name: 'requests_rejected_total',
    kind: 'counter',
    description: 'Inbound requests rejected by admission control.',
    dimensions: ['channel', 'reason'],
  },
  {
    name: 'context_resolution_total',
    kind: 'counter',
    description: 'L0 context resolutions by outcome.',
    dimensions: ['status', 'jurisdiction', 'framework', 'coverage_tier'],
  },
  {
    name: 'graph_state_transitions_total',
    kind: 'counter',
    description: 'Task graph state machine transitions.',
    dimensions: ['from', 'to', 'trigger_class'],
  },
  {
    name: 'node_duration_seconds',
    kind: 'histogram',
    description: 'Wall-clock duration of a task node.',
    unit: 's',
    dimensions: ['kind', 'skill', 'tool'],
  },
  {
    name: 'policy_verdicts_total',
    kind: 'counter',
    description: 'Policy engine verdicts, including immutable-rule engagements.',
    dimensions: ['rule', 'verdict', 'immutable_rule_engaged'],
  },
  {
    name: 'grounding_gate_result_total',
    kind: 'counter',
    description: 'Grounding gate results. A failure is a halt, never a downgrade.',
    dimensions: ['skill', 'result'],
  },
  {
    name: 'arithmetic_gate_result_total',
    kind: 'counter',
    description: 'Arithmetic and consistency gate results.',
    dimensions: ['skill', 'result'],
  },
  {
    name: 'tool_calls_total',
    kind: 'counter',
    description: 'Tool invocations by outcome, dry-run flag and state-changing flag.',
    dimensions: ['tool', 'outcome', 'dry_run', 'state_changing'],
  },
  {
    name: 'compensations_total',
    kind: 'counter',
    description: 'Compensating actions run, by outcome.',
    dimensions: ['tool', 'outcome'],
  },
  {
    name: 'handoff_open_age_seconds',
    kind: 'gauge',
    description: 'Age of the oldest open hand-off. Rising means humans are the bottleneck.',
    unit: 's',
    dimensions: ['assignee_role', 'output_class'],
    governanceDashboard: true,
  },
  {
    name: 'reviewer_actions_total',
    kind: 'counter',
    description: 'Reviewer moves. A rising material-edit rate is a defect signal.',
    dimensions: ['move', 'skill', 'output_class'],
  },
  {
    name: 'accuracy_floor_margin',
    kind: 'gauge',
    description: 'Distance between measured accuracy and the client-entered floor.',
    dimensions: ['skill', 'entity'],
    governanceDashboard: true,
  },
  {
    name: 'autonomy_level_current',
    kind: 'gauge',
    description: 'Effective autonomy per skill and entity (0 observe, 1 draft, 2 execute).',
    dimensions: ['skill', 'entity'],
    governanceDashboard: true,
  },
  {
    name: 'revalidation_pending_total',
    kind: 'gauge',
    description: 'Skills awaiting revalidation after a dependency change.',
    dimensions: ['skill', 'trigger'],
    governanceDashboard: true,
  },
  {
    name: 'llm_tokens_total',
    kind: 'counter',
    description: 'Model tokens consumed, attributed at emission.',
    dimensions: ['skill', 'route', 'tenant', 'channel', 'direction'],
  },
  {
    name: 'llm_cost_minor_total',
    kind: 'counter',
    description: 'Model spend in minor units, attributed at emission, never reconstructed.',
    dimensions: ['skill', 'route', 'tenant', 'channel'],
  },
  {
    name: 'tool_cost_minor_total',
    kind: 'counter',
    description: 'Connector spend in minor units.',
    dimensions: ['tool', 'tenant'],
  },
  {
    name: 'delivery_status_total',
    kind: 'counter',
    description: 'Outbound delivery status transitions.',
    dimensions: ['channel', 'status'],
  },
  {
    name: 'audit_chain_verification_failures_total',
    kind: 'counter',
    description:
      'Hash-chain breaks detected by the verification job. Any value above zero is an incident.',
    dimensions: ['tenant'],
  },
  {
    name: 'settings_missing_total',
    kind: 'counter',
    description: 'Reads that found a required AS- field absent, causing a refusal.',
    dimensions: ['family', 'field'],
  },
];

export const GOVERNANCE_DASHBOARD_METRICS: readonly string[] = METRIC_DEFINITIONS.filter(
  (m) => m.governanceDashboard === true,
).map((m) => m.name);

const METER_NAME = '@eiaaw/finance-digital-worker';

/**
 * Registry of live instruments.
 *
 * Gauges are modelled as observable-with-last-value: the caller `set`s, and the
 * async callback reports. That fits the four governance gauges, which are
 * derived state rather than sampled events.
 */
class MetricRegistry {
  readonly #counters = new Map<string, Counter>();
  readonly #histograms = new Map<string, Histogram>();
  readonly #gaugeValues = new Map<string, Map<string, { value: number; attributes: Attributes }>>();
  #initialised = false;

  init(): void {
    if (this.#initialised) return;
    const meter = metrics.getMeter(METER_NAME);

    for (const definition of METRIC_DEFINITIONS) {
      switch (definition.kind) {
        case 'counter':
          this.#counters.set(
            definition.name,
            meter.createCounter(definition.name, {
              description: definition.description,
              ...(definition.unit === undefined ? {} : { unit: definition.unit }),
            }),
          );
          break;
        case 'histogram':
          this.#histograms.set(
            definition.name,
            meter.createHistogram(definition.name, {
              description: definition.description,
              ...(definition.unit === undefined ? {} : { unit: definition.unit }),
            }),
          );
          break;
        case 'gauge': {
          this.#gaugeValues.set(definition.name, new Map());
          const gauge = meter.createObservableGauge(definition.name, {
            description: definition.description,
            ...(definition.unit === undefined ? {} : { unit: definition.unit }),
          });
          gauge.addCallback((observer) => {
            for (const entry of this.#gaugeValues.get(definition.name)?.values() ?? []) {
              observer.observe(entry.value, entry.attributes);
            }
          });
          break;
        }
      }
    }
    this.#initialised = true;
  }

  increment(name: string, attributes: Attributes = {}, by = 1): void {
    this.#counters.get(name)?.add(by, attributes);
  }

  record(name: string, value: number, attributes: Attributes = {}): void {
    this.#histograms.get(name)?.record(value, attributes);
  }

  setGauge(name: string, value: number, attributes: Attributes = {}): void {
    const series = this.#gaugeValues.get(name);
    if (!series) return;
    series.set(JSON.stringify(attributes), { value, attributes });
  }

  /** For the CI conformance job. */
  registeredNames(): readonly string[] {
    return [...this.#counters.keys(), ...this.#histograms.keys(), ...this.#gaugeValues.keys()];
  }

  reset(): void {
    this.#counters.clear();
    this.#histograms.clear();
    this.#gaugeValues.clear();
    this.#initialised = false;
  }
}

export const metricRegistry = new MetricRegistry();

// ---------------------------------------------------------------------------
// Named helpers — the call sites that matter, spelled out so a dimension is
// never forgotten and a metric name is never mistyped at a call site.
// ---------------------------------------------------------------------------

export const recordRequestAdmitted = (channel: string): void =>
  metricRegistry.increment('requests_admitted_total', { channel, reason: 'admitted' });

export const recordRequestRejected = (channel: string, reason: string): void =>
  metricRegistry.increment('requests_rejected_total', { channel, reason });

export const recordContextResolution = (a: {
  status: string;
  jurisdiction: string;
  framework: string;
  coverage_tier: string;
}): void => metricRegistry.increment('context_resolution_total', { ...a });

export const recordGraphTransition = (from: string, to: string, trigger_class: string): void =>
  metricRegistry.increment('graph_state_transitions_total', { from, to, trigger_class });

export const recordNodeDuration = (
  seconds: number,
  a: { kind: string; skill?: string; tool?: string },
): void =>
  metricRegistry.record('node_duration_seconds', seconds, {
    kind: a.kind,
    skill: a.skill ?? '',
    tool: a.tool ?? '',
  });

export const recordPolicyVerdict = (
  rule: string,
  verdict: string,
  immutableRuleEngaged: number | null,
): void =>
  metricRegistry.increment('policy_verdicts_total', {
    rule,
    verdict,
    immutable_rule_engaged: immutableRuleEngaged ?? 'none',
  });

export const recordGateResult = (
  gate: 'grounding' | 'arithmetic',
  skill: string,
  result: string,
): void => metricRegistry.increment(`${gate}_gate_result_total`, { skill, result });

export const recordToolCall = (a: {
  tool: string;
  outcome: string;
  dry_run: boolean;
  state_changing: boolean;
}): void =>
  metricRegistry.increment('tool_calls_total', {
    tool: a.tool,
    outcome: a.outcome,
    dry_run: String(a.dry_run),
    state_changing: String(a.state_changing),
  });

export const recordCompensation = (tool: string, outcome: string): void =>
  metricRegistry.increment('compensations_total', { tool, outcome });

export const recordReviewerAction = (move: string, skill: string, outputClass: string): void =>
  metricRegistry.increment('reviewer_actions_total', { move, skill, output_class: outputClass });

export const recordDeliveryStatus = (channel: string, status: string): void =>
  metricRegistry.increment('delivery_status_total', { channel, status });

export const recordSettingsMissing = (family: string, field: string): void =>
  metricRegistry.increment('settings_missing_total', { family, field });

export const recordAuditChainFailure = (tenant: string): void =>
  metricRegistry.increment('audit_chain_verification_failures_total', { tenant });

/**
 * DWD-06 s.12.5: "Cost is attributed at emission, not reconstructed later."
 * Both the token counts and the money are emitted in the same call so they can
 * never drift apart.
 */
export function recordLlmUsage(a: {
  skill: string;
  route: string;
  tenant: string;
  channel: string;
  tokensIn: number;
  tokensOut: number;
  costMinor: number;
}): void {
  const base = { skill: a.skill, route: a.route, tenant: a.tenant, channel: a.channel };
  metricRegistry.increment('llm_tokens_total', { ...base, direction: 'input' }, a.tokensIn);
  metricRegistry.increment('llm_tokens_total', { ...base, direction: 'output' }, a.tokensOut);
  metricRegistry.increment('llm_cost_minor_total', base, a.costMinor);
}

export const recordToolCost = (tool: string, tenant: string, costMinor: number): void =>
  metricRegistry.increment('tool_cost_minor_total', { tool, tenant }, costMinor);

// --- the four governance gauges --------------------------------------------

export const setAutonomyLevel = (skill: string, entity: string, level: number): void =>
  metricRegistry.setGauge('autonomy_level_current', level, { skill, entity });

export const setAccuracyFloorMargin = (skill: string, entity: string, margin: number): void =>
  metricRegistry.setGauge('accuracy_floor_margin', margin, { skill, entity });

export const setRevalidationPending = (skill: string, trigger: string, count: number): void =>
  metricRegistry.setGauge('revalidation_pending_total', count, { skill, trigger });

export const setHandoffOpenAge = (role: string, outputClass: string, seconds: number): void =>
  metricRegistry.setGauge('handoff_open_age_seconds', seconds, {
    assignee_role: role,
    output_class: outputClass,
  });
