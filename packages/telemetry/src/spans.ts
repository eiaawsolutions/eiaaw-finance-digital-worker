/**
 * The span taxonomy — DWD-06 s.12.2 and s.12.3.
 *
 * Two rules from the spec are enforced here rather than documented:
 *
 *   s.12.1 "A missing trace context at any hop is a defect, not a gap to be
 *           filled with a new ID."
 *   s.12.3 "A span missing any of these fails the observability conformance
 *           test in CI."
 *
 * So `REQUIRED_SPAN_ATTRIBUTES` is not advisory. `assertSpanConformance` runs on
 * every span in dev/test and in the CI conformance job; in prod it degrades to a
 * counter so a defect is visible without taking traffic down.
 */
import type { ComponentId, Layer } from '@eiaaw/contracts';

/** DWD-06 s.12.2 — the fixed span names. A span outside this list is a defect. */
export const SPAN_NAMES = [
  'channel.receive',
  'identity.resolve',
  'context.resolve',
  'intake.classify',
  'plan.compile',
  'graph.execute',
  'node.execute',
  'knowledge.retrieve',
  'records.fetch',
  'policy.evaluate',
  'skill.invoke',
  'llm.call',
  'tool.invoke',
  'assurance.gate',
  'authorise.decide',
  'delivery.send',
  'compensation.run',
  'audit.append',
] as const;

export type SpanName = (typeof SPAN_NAMES)[number];

export interface SpanDefinition {
  readonly name: SpanName;
  readonly layer: Layer;
  readonly component: ComponentId;
  /** `null` means the span is a root child of the request trace. */
  readonly parent: SpanName | null;
  /** Attributes beyond the universally required set. */
  readonly keyAttributes: readonly string[];
}

export const SPAN_TAXONOMY: Readonly<Record<SpanName, SpanDefinition>> = Object.freeze({
  'channel.receive': {
    name: 'channel.receive',
    layer: 'L7',
    component: 'C1',
    parent: null,
    keyAttributes: ['channel', 'transport_message_id', 'admission.decision'],
  },
  'identity.resolve': {
    name: 'identity.resolve',
    layer: 'L3',
    component: 'C2',
    parent: 'channel.receive',
    keyAttributes: ['principal.resolution', 'confidence'],
  },
  'context.resolve': {
    name: 'context.resolve',
    layer: 'L0',
    component: 'C3',
    parent: null,
    keyAttributes: ['pack_version', 'resolution_status'],
  },
  'intake.classify': {
    name: 'intake.classify',
    layer: 'L5',
    component: 'C4',
    parent: null,
    keyAttributes: ['intent', 'confidence', 'clarification_asked'],
  },
  'plan.compile': {
    name: 'plan.compile',
    layer: 'L5',
    component: 'C5',
    parent: null,
    keyAttributes: ['root_skill_id', 'node_count', 'effective_autonomy', 'admission.decision'],
  },
  'graph.execute': {
    name: 'graph.execute',
    layer: 'L5',
    component: 'C7',
    parent: null,
    keyAttributes: ['graph_id', 'state', 'trigger_class'],
  },
  'node.execute': {
    name: 'node.execute',
    layer: 'L5',
    component: 'C7',
    parent: 'graph.execute',
    keyAttributes: ['node_id', 'kind', 'sequence_rank', 'attempt'],
  },
  'knowledge.retrieve': {
    name: 'knowledge.retrieve',
    layer: 'L2',
    component: 'C11',
    parent: 'node.execute',
    keyAttributes: ['module_ids', 'versions', 'chunk_count', 'coverage_tier', 'as_of_date'],
  },
  'records.fetch': {
    name: 'records.fetch',
    layer: 'L1',
    component: 'C12',
    parent: 'node.execute',
    keyAttributes: ['source_system_id', 'record_count', 'connector_version'],
  },
  'policy.evaluate': {
    name: 'policy.evaluate',
    layer: 'L5',
    component: 'C6',
    parent: 'node.execute',
    keyAttributes: ['rule_id', 'verdict', 'precedence_rank', 'immutable_rule_engaged'],
  },
  'skill.invoke': {
    name: 'skill.invoke',
    layer: 'L4',
    component: 'C8',
    parent: 'node.execute',
    keyAttributes: ['skill_id', 'skill_version', 'mode', 'confidence', 'status'],
  },
  'llm.call': {
    name: 'llm.call',
    layer: 'rail',
    component: 'C9',
    parent: 'skill.invoke',
    keyAttributes: ['route_id', 'model', 'tokens_in', 'tokens_out', 'fallback_used', 'cost_minor'],
  },
  'tool.invoke': {
    name: 'tool.invoke',
    layer: 'L6',
    component: 'C10',
    parent: 'node.execute',
    keyAttributes: [
      'tool_id',
      'scope_granted',
      'state_changing',
      'dry_run',
      'idempotency_key_hash',
      'outcome',
    ],
  },
  'assurance.gate': {
    name: 'assurance.gate',
    layer: 'L8',
    component: 'C13',
    parent: 'node.execute',
    keyAttributes: ['gate', 'result', 'harness_version'],
  },
  'authorise.decide': {
    name: 'authorise.decide',
    layer: 'L9',
    component: 'C15',
    parent: 'graph.execute',
    keyAttributes: ['output_class', 'authorisation_verdict', 'named_owner_ref'],
  },
  'delivery.send': {
    name: 'delivery.send',
    layer: 'L7',
    component: 'C14',
    parent: 'graph.execute',
    keyAttributes: ['channel', 'status', 'attempt_group'],
  },
  'compensation.run': {
    name: 'compensation.run',
    layer: 'L6',
    component: 'C10',
    parent: 'graph.execute',
    keyAttributes: ['original_node_id', 'compensation_tool_id', 'outcome'],
  },
  'audit.append': {
    name: 'audit.append',
    layer: 'rail',
    component: 'C15',
    parent: null,
    keyAttributes: ['event_type', 'layer', 'chain_ok'],
  },
});

/**
 * DWD-06 s.12.3 — required on every span, without exception.
 *
 * `tenant_id` is first because it is also the isolation key: a span without one
 * cannot be scoped to a dashboard or filtered out of an export, which makes it
 * a data-protection defect as well as an observability one.
 */
export const REQUIRED_SPAN_ATTRIBUTES = [
  'tenant_id',
  'trace_id',
  'layer',
  'component',
  'environment',
  'platform_version',
  'residency_zone',
] as const;

/** Required only where the pipeline has produced one yet. */
export const CONDITIONAL_SPAN_ATTRIBUTES = ['request_id', 'graph_id'] as const;

export type SpanAttributes = Record<string, string | number | boolean | undefined>;

export interface ConformanceViolation {
  readonly span: string;
  readonly missing: readonly string[];
  readonly forbidden: readonly string[];
}

/**
 * DWD-06 s.12, red flag: "Model reasoning text in span attributes or logs."
 *
 * These attribute names are never permitted. The check is on the *name* rather
 * than the content because a length heuristic would be both unreliable and
 * expensive on a hot path — and because a field called `reasoning` is a
 * defect regardless of what happens to be in it today.
 */
export const FORBIDDEN_SPAN_ATTRIBUTES: readonly string[] = [
  'prompt',
  'prompt_text',
  'completion',
  'completion_text',
  'reasoning',
  'reasoning_text',
  'model_output',
  'raw_response',
  'system_prompt',
  'messages',
  'body_text',
  'secret',
  'token',
  'api_key',
  'credential',
  'password',
];

export function checkSpanConformance(
  spanName: string,
  attributes: SpanAttributes,
): ConformanceViolation | null {
  const present = new Set(
    Object.entries(attributes)
      .filter(([, value]) => value !== undefined && value !== '')
      .map(([key]) => key),
  );

  const missing = REQUIRED_SPAN_ATTRIBUTES.filter((key) => !present.has(key));
  const forbidden = FORBIDDEN_SPAN_ATTRIBUTES.filter((key) => present.has(key));

  if (missing.length === 0 && forbidden.length === 0) return null;
  return { span: spanName, missing, forbidden };
}

export class SpanConformanceError extends Error {
  readonly violation: ConformanceViolation;

  constructor(violation: ConformanceViolation) {
    const parts: string[] = [];
    if (violation.missing.length > 0) {
      parts.push(`missing required attribute(s): ${violation.missing.join(', ')}`);
    }
    if (violation.forbidden.length > 0) {
      parts.push(
        `carries forbidden attribute(s): ${violation.forbidden.join(', ')} — ` +
          'model reasoning text and secrets never enter a span',
      );
    }
    super(`Span "${violation.span}" ${parts.join('; ')} (DWD-06 s.12.3).`);
    this.name = 'SpanConformanceError';
    this.violation = violation;
  }
}

/**
 * Throws in dev/test so the defect surfaces at authoring time; returns the
 * violation in prod so the caller can count it without dropping the request.
 */
export function assertSpanConformance(
  spanName: string,
  attributes: SpanAttributes,
  strict: boolean,
): ConformanceViolation | null {
  const violation = checkSpanConformance(spanName, attributes);
  if (violation && strict) throw new SpanConformanceError(violation);
  return violation;
}

export const isKnownSpanName = (name: string): name is SpanName =>
  (SPAN_NAMES as readonly string[]).includes(name);
