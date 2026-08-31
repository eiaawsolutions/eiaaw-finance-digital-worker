/**
 * The audit emitter — the façade every component writes through.
 *
 * DWD-06 s.1.3 D6: "C15 is write-only from every component." Rather than have
 * sixteen components each assemble an `AuditEvent` envelope by hand (and each
 * forget a different field), they take an `AuditEmitter` bound to their layer
 * and component and call one method.
 *
 * The binding is the point: a `C10` emitter cannot claim to be `C6`, so an
 * audit query filtered by component returns what it says it does.
 */
import {
  buildAuditEvent,
  type AuditEventType,
  type ComponentId,
  type Layer,
} from '@eiaaw/contracts';
import type { AuditOutcome, ActorKind } from '@eiaaw/contracts';
import { currentSpanId, currentTraceContext } from '@eiaaw/telemetry';
import { newSpanId, newTraceId } from '@eiaaw/core';
import type { TenantScope } from '@eiaaw/db';
import type { AppendResult, AuditStore } from './store.js';

export interface EmitContext {
  readonly tenant_id: string;
  readonly trace_id?: string;
  readonly context_ref?: string | null;
  readonly graph_id?: string | null;
}

export interface EmitInput {
  readonly event_type: AuditEventType;
  readonly outcome: AuditOutcome;
  readonly subject: { readonly kind: string; readonly id: string };
  readonly actor?: {
    readonly kind: ActorKind;
    readonly skill_id?: string;
    readonly principal_id?: string | null;
  };
  readonly payload?: Record<string, unknown>;
  readonly occurred_at?: string;
  /** Reuse the caller's transaction so the event and the action commit together. */
  readonly scope?: TenantScope;
}

export class AuditEmitter {
  constructor(
    private readonly store: AuditStore,
    private readonly layer: Layer,
    private readonly component: ComponentId,
  ) {}

  /**
   * Emit an event.
   *
   * Deliberately NOT fire-and-forget. s.3.14: "A write failure to the WORM
   * store fails the operation that produced it; it never proceeds unlogged."
   * Callers must await this, and must not catch and continue.
   */
  async emit(context: EmitContext, input: EmitInput): Promise<AppendResult> {
    const traceContext = currentTraceContext();

    const event = buildAuditEvent({
      tenant_id: context.tenant_id,
      trace_id: context.trace_id ?? traceContext?.trace_id ?? newTraceId(),
      span_id: traceContext?.span_id ?? currentSpanId() ?? newSpanId(),
      layer: this.layer,
      component: this.component,
      event_type: input.event_type,
      outcome: input.outcome,
      actor: {
        kind: input.actor?.kind ?? 'worker',
        principal_id: input.actor?.principal_id ?? null,
        ...(input.actor?.skill_id === undefined ? {} : { skill_id: input.actor.skill_id }),
      },
      subject: input.subject,
      payload_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
      context_ref: context.context_ref ?? null,
      graph_id: context.graph_id ?? null,
      ...(input.occurred_at === undefined ? {} : { occurred_at: input.occurred_at }),
    });

    // The store recomputes payload_hash from the payload it is given, so the
    // placeholder above never reaches the chain.
    return this.store.append(event, input.payload ?? {}, input.scope);
  }

  /** A differently-bound emitter for a component that spans two layers. */
  forLayer(layer: Layer): AuditEmitter {
    return new AuditEmitter(this.store, layer, this.component);
  }
}

export function createEmitter(
  store: AuditStore,
  layer: Layer,
  component: ComponentId,
): AuditEmitter {
  return new AuditEmitter(store, layer, component);
}

/**
 * The component bindings, in one place.
 *
 * A component that appears here but nowhere in the call graph is a component
 * that was specified and never built — which is exactly what Phase 0 acceptance
 * P0-1 checks by requiring every event type to be emittable.
 */
export const COMPONENT_BINDINGS: Readonly<Record<ComponentId, Layer>> = {
  C1: 'L7', // Channel Gateway
  C2: 'L3', // Identity and Binding
  C3: 'L0', // Context Resolver
  C4: 'L5', // Intake and Classifier
  C5: 'L5', // Planner
  C6: 'L5', // Policy Engine
  C7: 'L5', // Workflow Executor
  C8: 'L4', // Skill Runtime
  C9: 'rail', // LLM Gateway
  C10: 'L6', // Tool Invoker
  C11: 'L2', // Knowledge Service
  C12: 'L1', // Records Service
  C13: 'L8', // Assurance Harness
  C14: 'L7', // Delivery Service
  C15: 'rail', // Audit and Evidence Store
  C16: 'rail', // Configuration Service
};

export function emitterFor(store: AuditStore, component: ComponentId): AuditEmitter {
  return new AuditEmitter(store, COMPONENT_BINDINGS[component], component);
}
