/**
 * Safe constructors for shapes built in more than one component.
 *
 * These exist so that invariants which are easy to state and easy to forget —
 * "an inbound message is always untrusted", "a refused context carries a
 * reason", "a delivery declares all five contract elements" — are satisfied by
 * construction rather than by review.
 *
 * A component that owns a contract end to end (the planner owns TaskGraph, the
 * policy engine owns PolicyVerdict) builds it itself; only the cross-cutting
 * shapes live here.
 */
import { type Money, newId, newRequestId, now, toTimestamp } from '@eiaaw/core';
import type {
  AuditEventType,
  ActorKind,
  AuditOutcome,
  ChannelName,
  ComponentId,
  ContextAxis,
  Layer,
  ResolutionStatus,
} from './enums.js';
import {
  CURRENT_SCHEMA_VERSION,
  type AxisResolution,
  type InboundRequest,
  type Message,
  type ResolvedContext,
  type ResponseContractElements,
  type UnsealedAuditEvent,
} from './types.js';

/** All five elements of the response contract. There is no partial form. */
export const FULL_RESPONSE_CONTRACT: ResponseContractElements = Object.freeze({
  answer: true,
  basis_and_citations: true,
  status_and_limits: true,
  exclusions: true,
  next_action_and_owner: true,
});

// ---------------------------------------------------------------------------
// AuditEvent — every component writes these
// ---------------------------------------------------------------------------

export interface AuditEventInput {
  readonly tenant_id: string;
  readonly trace_id: string;
  readonly span_id: string;
  readonly layer: Layer;
  readonly component: ComponentId;
  readonly event_type: AuditEventType;
  readonly outcome: AuditOutcome;
  readonly actor: { kind: ActorKind; skill_id?: string; principal_id: string | null };
  readonly subject: { kind: string; id: string };
  readonly payload_hash: string;
  readonly payload_ref?: string | null;
  readonly context_ref?: string | null;
  readonly graph_id?: string | null;
  readonly occurred_at?: string;
}

/**
 * Build the pre-chain form. The audit store computes `prev_event_hash`,
 * `event_hash` and `recorded_at` when it appends, because only the store knows
 * the tip of the tenant's chain.
 *
 * `occurred_at` defaults to now but is accepted explicitly: DWD-06 s.3.14 makes
 * divergence between `occurred_at` and `recorded_at` an alertable condition, so
 * the caller must be able to report when the thing actually happened.
 */
export function buildAuditEvent(input: AuditEventInput): UnsealedAuditEvent {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    event_id: newId('auditEvent'),
    tenant_id: input.tenant_id,
    trace_id: input.trace_id,
    span_id: input.span_id,
    occurred_at: input.occurred_at ?? now(),
    layer: input.layer,
    component: input.component,
    event_type: input.event_type,
    actor: {
      kind: input.actor.kind,
      principal_id: input.actor.principal_id,
      ...(input.actor.skill_id === undefined ? {} : { skill_id: input.actor.skill_id }),
    },
    subject: input.subject,
    context_ref: input.context_ref ?? null,
    graph_id: input.graph_id ?? null,
    outcome: input.outcome,
    payload_hash: input.payload_hash,
    payload_ref: input.payload_ref ?? null,
  };
}

// ---------------------------------------------------------------------------
// ResolvedContext
// ---------------------------------------------------------------------------

export interface ResolvedContextInput {
  readonly request_id: string;
  readonly tenant_id: string;
  readonly axes: Readonly<Record<ContextAxis, AxisResolution>>;
  readonly pack: { pack_id: string; pack_version: string };
  readonly residency_zone: string;
  readonly resolved_locale: string;
  readonly knowledge_pin: ResolvedContext['knowledge_pin'];
  readonly ttlMs: number;
  readonly fiscal_period?: ResolvedContext['fiscal_period'];
  readonly resolution_status?: ResolutionStatus;
  readonly resolution_reason?: string;
}

export function buildResolvedContext(input: ResolvedContextInput): ResolvedContext {
  const resolvedAt = new Date();
  const status = input.resolution_status ?? 'resolved';
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    context_id: newId('context'),
    request_id: input.request_id,
    tenant_id: input.tenant_id,
    resolution_status: status,
    resolution_reason: input.resolution_reason ?? null,
    axes: input.axes,
    pack: input.pack,
    residency_zone: input.residency_zone,
    resolved_locale: input.resolved_locale,
    ...(input.fiscal_period === undefined ? {} : { fiscal_period: input.fiscal_period }),
    knowledge_pin: input.knowledge_pin,
    resolved_at: toTimestamp(resolvedAt),
    // A context that never expires is a context that can be reused after the
    // as-of date, the period status or a statutory rate has moved (s.7.3).
    expires_at: toTimestamp(resolvedAt.getTime() + input.ttlMs),
  };
}

/**
 * A refused context. `resolution_status: refused` terminates the pipeline —
 * "there is no downstream component permitted to proceed on a refused context,
 * and none that can construct one itself" (DWD-06 s.3.2).
 *
 * The unresolvable axis is named so the refusal message can be specific.
 */
export function buildRefusedContext(input: {
  readonly request_id: string;
  readonly tenant_id: string;
  readonly residency_zone: string;
  readonly resolved_locale: string;
  readonly unresolved_axis: ContextAxis;
  readonly reason: string;
  readonly partial_axes?: Partial<Record<ContextAxis, AxisResolution>>;
}): ResolvedContext {
  // The axis carries the sentinel rather than an empty string: a blank value
  // reads as "resolved to nothing", which is the ambiguity the refusal exists
  // to remove. `coverage_tier: 'none'` is the machine-readable half.
  const unresolved: AxisResolution = {
    value: 'unresolved',
    source: 'unresolved',
    coverage_tier: 'none',
  };
  const axes = {
    jurisdiction: input.partial_axes?.jurisdiction ?? unresolved,
    reporting_framework: input.partial_axes?.reporting_framework ?? unresolved,
    legal_entity: input.partial_axes?.legal_entity ?? unresolved,
    currency: input.partial_axes?.currency ?? unresolved,
    as_of_date: input.partial_axes?.as_of_date ?? unresolved,
  } satisfies Record<ContextAxis, AxisResolution>;

  const at = now();
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    context_id: newId('context'),
    request_id: input.request_id,
    tenant_id: input.tenant_id,
    resolution_status: 'refused',
    resolution_reason: `${input.unresolved_axis}: ${input.reason}`,
    axes,
    pack: { pack_id: 'unresolved', pack_version: '0.0.0' },
    residency_zone: input.residency_zone,
    resolved_locale: input.resolved_locale,
    knowledge_pin: { pinned_at: at, modules: [] },
    resolved_at: at,
    // Already expired: nothing may act on it, and nothing may cache it.
    expires_at: at,
  };
}

export const isUsableContext = (context: ResolvedContext): boolean =>
  context.resolution_status === 'resolved';

// ---------------------------------------------------------------------------
// Message
// ---------------------------------------------------------------------------

/**
 * An inbound message. `trust_class` is hard-coded rather than accepted as a
 * parameter — DWD-06 s.3.4: "Inbound is always untrusted." Making it an
 * argument would make the wrong value expressible.
 */
export function buildInboundMessage(input: {
  readonly conversation_key: string;
  readonly tenant_id: string;
  readonly channel: ChannelName;
  readonly transport_message_id: string | null;
  readonly principal_id: string | null;
  readonly content_text: string;
  readonly sent_at?: string;
  readonly attachment_ids?: readonly string[];
  readonly related_request_id?: string | null;
}): Message {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    message_id: newId('message'),
    conversation_key: input.conversation_key,
    tenant_id: input.tenant_id,
    direction: 'inbound',
    channel: input.channel,
    transport_message_id: input.transport_message_id,
    author: { kind: 'human', principal_id: input.principal_id },
    sent_at: input.sent_at ?? now(),
    content_text: input.content_text,
    ...(input.attachment_ids === undefined ? {} : { attachment_ids: input.attachment_ids }),
    trust_class: 'untrusted_content',
    related_request_id: input.related_request_id ?? null,
    related_delivery_id: null,
    redaction_state: 'none',
  };
}

export function buildOutboundMessage(input: {
  readonly conversation_key: string;
  readonly tenant_id: string;
  readonly channel: ChannelName;
  readonly content_text: string;
  readonly content_blocks?: Message['content_blocks'];
  readonly related_delivery_id: string | null;
  readonly transport_message_id?: string | null;
}): Message {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    message_id: newId('message'),
    conversation_key: input.conversation_key,
    tenant_id: input.tenant_id,
    direction: 'outbound',
    channel: input.channel,
    transport_message_id: input.transport_message_id ?? null,
    author: { kind: 'worker', principal_id: null },
    sent_at: now(),
    content_text: input.content_text,
    ...(input.content_blocks === undefined ? {} : { content_blocks: input.content_blocks }),
    trust_class: 'reference_data',
    related_request_id: null,
    related_delivery_id: input.related_delivery_id,
    redaction_state: 'none',
  };
}

// ---------------------------------------------------------------------------
// InboundRequest
// ---------------------------------------------------------------------------

export interface InboundRequestInput {
  readonly tenant_id: string;
  readonly trace_id: string;
  readonly channel: ChannelName;
  readonly transport_message_id: string;
  readonly conversation_key: string;
  readonly principal: InboundRequest['principal'];
  readonly body_text: string;
  readonly body_raw_ref: string;
  readonly security_flags: InboundRequest['security_flags'];
  readonly attachments?: InboundRequest['attachments'];
  readonly intent_hint?: InboundRequest['intent_hint'];
  readonly reply_context?: InboundRequest['reply_context'];
  readonly locale_hint?: string;
  readonly transport_sent_at?: string;
  readonly request_id?: string;
}

export function buildAdmittedRequest(input: InboundRequestInput): InboundRequest {
  return {
    schema_version: CURRENT_SCHEMA_VERSION,
    request_id: input.request_id ?? newRequestId(),
    tenant_id: input.tenant_id,
    trace_id: input.trace_id,
    channel: input.channel,
    transport_message_id: input.transport_message_id,
    conversation_key: input.conversation_key,
    received_at: now(),
    ...(input.transport_sent_at === undefined
      ? {}
      : { transport_sent_at: input.transport_sent_at }),
    principal: input.principal,
    body_text: input.body_text,
    body_raw_ref: input.body_raw_ref,
    ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
    ...(input.intent_hint === undefined ? {} : { intent_hint: input.intent_hint }),
    ...(input.reply_context === undefined ? {} : { reply_context: input.reply_context }),
    ...(input.locale_hint === undefined ? {} : { locale_hint: input.locale_hint }),
    security_flags: input.security_flags,
    admission: { decision: 'admitted', reason_code: null },
  };
}

export function buildRejectedRequest(
  input: InboundRequestInput & { readonly reason_code: string },
): InboundRequest {
  return {
    ...buildAdmittedRequest(input),
    admission: { decision: 'rejected', reason_code: input.reason_code },
  };
}

// ---------------------------------------------------------------------------
// Cost helpers
// ---------------------------------------------------------------------------

/** Zero cost in the tenant's currency. Used as the seed for cost accumulation. */
export const zeroCost = (currency: string, scale = 2): Money => ({
  amount_minor: 0,
  currency,
  scale,
});
