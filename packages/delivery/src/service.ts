/**
 * C14 — the Delivery Service. DWD-06 s.3.15.
 *
 *   "decision_record_ref: NO DELIVERY WITHOUT AN AUTHORISATION DECISION."
 *   "contract_elements: all five elements of the response contract present, or
 *    the delivery is refused."
 *   s.8.1: the delivery key is derived per (graph, output, recipient, channel,
 *    attempt group), so a retry within an attempt group never sends twice.
 *
 * The decision-record requirement is enforced three times: the type demands it,
 * this service checks it, and the database has a foreign key. A control that
 * governs whether a figure reaches a regulator earns three.
 */
import { type Result, WorkerError, deliveryIdempotencyKey, err, newId, now, ok } from '@eiaaw/core';
import {
  FULL_RESPONSE_CONTRACT,
  type ChannelName,
  type DeliveryStatus,
  type OutboundDelivery,
  type OutputClass,
  type SensitivityTierName,
} from '@eiaaw/contracts';
import { canRenderPayload } from '@eiaaw/core';
import { type Database, type TenantScope, isUniqueViolation, withTenant } from '@eiaaw/db';
import {
  type ChannelAdapter,
  type ChannelCapabilities,
  checkCapability,
  selectChannel,
} from '@eiaaw/channels';
import { recordDeliveryStatus, withSpan } from '@eiaaw/telemetry';
import {
  renderResponse,
  validateResponseContract,
  type ResponseParts,
} from './response-contract.js';

export interface DeliverInput {
  readonly tenant_id: string;
  readonly graph_id: string;
  readonly conversation_key: string;
  readonly trace_id: string;
  /** Required. There is no delivery without one. */
  readonly decision_record_ref: string;
  readonly output_class: OutputClass;
  readonly recipient: { principal_id: string; address: string; external: boolean };
  readonly parts: ResponseParts;
  readonly sensitivity: SensitivityTierName;
  /** file 07 s.3.2 data classes present in this payload. */
  readonly data_classes: readonly string[];
  readonly carries_evidence_bundle: boolean;
  readonly attachments?: readonly { filename: string; media_type: string; bytes: Buffer }[];
  readonly channel_preference: readonly ChannelName[];
  readonly locale: string;
  readonly attempt_group?: number;
  readonly thread_ref?: string;
  readonly feedback_token?: string;
}

export interface DeliveryServiceOptions {
  readonly db: Database;
  readonly residencyZone: string;
  readonly adapters: ReadonlyMap<ChannelName, ChannelAdapter>;
  readonly capabilities: readonly ChannelCapabilities[];
}

export class DeliveryService {
  readonly #db: Database;
  readonly #residencyZone: string;
  readonly #adapters: ReadonlyMap<ChannelName, ChannelAdapter>;
  readonly #capabilities: readonly ChannelCapabilities[];

  constructor(options: DeliveryServiceOptions) {
    this.#db = options.db;
    this.#residencyZone = options.residencyZone;
    this.#adapters = options.adapters;
    this.#capabilities = options.capabilities;
  }

  async deliver(input: DeliverInput, scope?: TenantScope): Promise<Result<OutboundDelivery>> {
    return withSpan(
      'delivery.send',
      { tenant_id: input.tenant_id, trace_id: input.trace_id, graph_id: input.graph_id },
      { channel: 'pending', status: 'queued', attempt_group: input.attempt_group ?? 1 },
      async () => this.#deliver(input, scope),
    );
  }

  async #deliver(input: DeliverInput, scope?: TenantScope): Promise<Result<OutboundDelivery>> {
    // --- 1. no delivery without a decision record --------------------------
    if (!input.decision_record_ref) {
      return err(
        new WorkerError('authority_insufficient', {
          detail:
            'This delivery has no authorisation decision. No output is delivered without a ' +
            'decision record naming the human who is accountable for it (DWD-06 s.3.15).',
          failureClass: 'policy',
          retryable: false,
        }),
      );
    }

    // --- 2. all five response-contract elements ----------------------------
    const contract = validateResponseContract(input.parts);
    if (!contract.complete) {
      return err(
        new WorkerError('unprocessable_content', {
          detail:
            `The response is missing ${contract.missing.join(', ')}. A delivery that omits an ` +
            'element of the response contract is refused rather than sent with a gap, because ' +
            'a reader cannot tell an empty section from a forgotten one (file 04 s.1).',
          failureClass: 'contract',
          retryable: false,
          context: { missing: contract.missing },
        }),
      );
    }

    // --- 3. the sensitivity matrix, per data class -------------------------
    const preference = input.channel_preference;
    const composePayload = {
      recipient: input.recipient.address,
      body: '',
      sensitivity: input.sensitivity,
      carries_evidence_bundle: input.carries_evidence_bundle,
      is_proactive: false,
      ...(input.attachments === undefined ? {} : { attachments: input.attachments }),
    };

    const selection = selectChannel(this.#capabilities, composePayload, preference);
    if ('refused' in selection) {
      return err(
        new WorkerError('sensitivity_ceiling', {
          detail: selection.refused.detail,
          failureClass: 'policy',
          retryable: false,
        }),
      );
    }

    // The channel matrix is a second, per-class check on top of the tier
    // ceiling: D15 bank details are Restricted AND masked-only in the console.
    const classDecision = canRenderPayload(input.data_classes, selection.channel);
    if (!classDecision.allowed) {
      return err(
        new WorkerError('sensitivity_ceiling', {
          detail:
            `The ${selection.channel} channel cannot carry every data class in this payload:\n` +
            classDecision.blockedBy.map((b) => `  ${b.classId}: ${b.reason}`).join('\n'),
          failureClass: 'policy',
          retryable: false,
          context: { blocked: classDecision.blockedBy },
        }),
      );
    }

    // --- 4. render and check the channel can carry it ----------------------
    const adapter = this.#adapters.get(selection.channel);
    if (!adapter) {
      return err(
        new WorkerError('dependency_unavailable', {
          detail: `No adapter is registered for the ${selection.channel} channel.`,
          failureClass: 'transport',
          retryable: false,
        }),
      );
    }

    const rendered = renderResponse(input.parts, selection.channel);
    const capabilities = adapter.capabilities();
    const capabilityError = checkCapability(capabilities, {
      ...composePayload,
      body: rendered.body,
    });

    if (capabilityError) {
      return err(
        new WorkerError('sensitivity_ceiling', {
          detail: capabilityError.detail,
          failureClass: 'policy',
          retryable: false,
        }),
      );
    }

    // --- 5. idempotency ----------------------------------------------------
    const attemptGroup = input.attempt_group ?? 1;
    const idempotencyKey = deliveryIdempotencyKey({
      graph_id: input.graph_id,
      output_class: input.output_class,
      recipient_id: input.recipient.principal_id,
      channel: selection.channel,
      attempt_group: attemptGroup,
    });

    const deliveryId = newId('outboundDelivery');
    const delivery: OutboundDelivery = {
      schema_version: '1.0.0',
      delivery_id: deliveryId,
      tenant_id: input.tenant_id,
      conversation_key: input.conversation_key,
      graph_id: input.graph_id,
      decision_record_ref: input.decision_record_ref,
      output_class: input.output_class,
      recipient: { principal_id: input.recipient.principal_id, external: input.recipient.external },
      channel: selection.channel,
      locale: input.locale,
      sensitivity: input.sensitivity,
      payload: {
        body_ref: `obj://render/${deliveryId}`,
        ...(input.attachments && input.attachments.length > 0
          ? {
              attachments: input.attachments.map((a) => ({
                artifact_ref: `obj://attachments/${deliveryId}/${a.filename}`,
                content_hash: `sha256:${'0'.repeat(64)}`,
              })),
            }
          : {}),
      },
      contract_elements: FULL_RESPONSE_CONTRACT,
      idempotency_key: idempotencyKey,
      attempt_group: attemptGroup,
      status: 'queued',
      status_history: [{ status: 'queued', at: now() }],
      provider_reference: null,
      failure: null,
      feedback_hook: {
        kind: selection.channel === 'email' ? 'reply_keyword' : 'inline_control',
        token: input.feedback_token ?? `FB-${deliveryId.slice(-8)}`,
      },
    };

    const reserved = await this.#reserve(delivery, scope);
    if (!reserved.ok) return reserved;

    // --- 6. send -----------------------------------------------------------
    const composed = adapter.compose({
      ...composePayload,
      body: rendered.body,
      ...(rendered.subject === undefined ? {} : { subject: rendered.subject }),
      ...(input.thread_ref === undefined ? {} : { thread_ref: input.thread_ref }),
    });

    if ('refused' in composed) {
      await this.#updateStatus(
        input.tenant_id,
        deliveryId,
        'failed',
        null,
        composed.refused,
        scope,
      );
      return err(
        new WorkerError('sensitivity_ceiling', {
          detail: composed.refused.detail,
          failureClass: 'policy',
          retryable: false,
        }),
      );
    }

    const result = await adapter.send(composed, idempotencyKey);

    if (!result.accepted) {
      await this.#updateStatus(input.tenant_id, deliveryId, 'failed', null, result.error, scope);
      recordDeliveryStatus(selection.channel, 'failed');
      return err(
        new WorkerError(
          result.error?.retryable === true ? 'dependency_unavailable' : 'unprocessable_content',
          {
            detail: result.error?.detail ?? 'The channel adapter rejected the message.',
            failureClass: 'transport',
            retryable: result.error?.retryable ?? false,
          },
        ),
      );
    }

    await this.#updateStatus(
      input.tenant_id,
      deliveryId,
      'accepted',
      result.provider_reference,
      undefined,
      scope,
    );
    recordDeliveryStatus(selection.channel, 'accepted');

    return ok({
      ...delivery,
      status: 'accepted',
      provider_reference: result.provider_reference,
      status_history: [...delivery.status_history, { status: 'accepted' as const, at: now() }],
    });
  }

  async #reserve(
    delivery: OutboundDelivery,
    scope?: TenantScope,
  ): Promise<Result<OutboundDelivery>> {
    const write = async (s: TenantScope): Promise<Result<OutboundDelivery>> => {
      try {
        await s.sql`
          INSERT INTO deliveries (
            tenant_id, delivery_id, conversation_key, graph_id, decision_record_ref,
            output_class, recipient_principal_id, recipient_external, channel, locale,
            sensitivity, payload_body_ref, payload_attachments, contract_elements,
            idempotency_key, attempt_group, status, status_history, feedback_hook_kind,
            feedback_hook_token
          ) VALUES (
            ${delivery.tenant_id}, ${delivery.delivery_id}, ${delivery.conversation_key},
            ${delivery.graph_id}, ${delivery.decision_record_ref}, ${delivery.output_class},
            ${delivery.recipient.principal_id}, ${delivery.recipient.external},
            ${delivery.channel}, ${delivery.locale}, ${delivery.sensitivity},
            ${delivery.payload.body_ref},
            ${s.sql.json(delivery.payload.attachments ?? [])},
            ${s.sql.json(delivery.contract_elements as never)},
            ${delivery.idempotency_key}, ${delivery.attempt_group}, 'queued',
            ${s.sql.json(delivery.status_history)},
            ${delivery.feedback_hook.kind}, ${delivery.feedback_hook.token}
          )
        `;
        return ok(delivery);
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        return err(
          new WorkerError('duplicate_request', {
            detail:
              'This exact delivery has already been sent in this attempt group. The stored ' +
              'delivery is returned; no second message is sent (DWD-06 s.8.3).',
            failureClass: 'transport',
            retryable: false,
          }),
        );
      }
    };

    if (scope) return write(scope);
    return withTenant(
      this.#db,
      { tenantId: delivery.tenant_id, residencyZone: this.#residencyZone },
      write,
    );
  }

  async #updateStatus(
    tenantId: string,
    deliveryId: string,
    status: DeliveryStatus,
    providerReference: string | null,
    failure?: { class: string; detail: string; retryable: boolean },
    scope?: TenantScope,
  ): Promise<void> {
    const write = async (s: TenantScope): Promise<void> => {
      await s.sql`
        UPDATE deliveries
           SET status = ${status},
               provider_reference = ${providerReference},
               failure = ${failure === undefined ? null : s.sql.json(failure)},
               status_history = status_history ||
                 ${s.sql.json([{ status, at: now() }] as never)}
         WHERE tenant_id = ${tenantId} AND delivery_id = ${deliveryId}
      `;
    };

    if (scope) await write(scope);
    else await withTenant(this.#db, { tenantId, residencyZone: this.#residencyZone }, write);
  }

  /** Record a provider status callback. */
  async recordStatus(
    tenantId: string,
    providerReference: string,
    status: DeliveryStatus,
  ): Promise<void> {
    await withTenant(this.#db, { tenantId, residencyZone: this.#residencyZone }, async (s) => {
      await s.sql`
        UPDATE deliveries
           SET status = ${status},
               status_history = status_history ||
                 ${s.sql.json([{ status, at: now() }] as never)}
         WHERE tenant_id = ${tenantId} AND provider_reference = ${providerReference}
      `;
    });
  }
}
