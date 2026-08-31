/**
 * C1 — the Channel Adapter interface. DWD-06 s.4.
 *
 *   s.4.1: "One interface, four implementations, NO GOVERNANCE LOGIC BELOW IT."
 *   s.4.1: "Every value in ChannelCapabilities is read by the router. NO
 *           COMPONENT CONTAINS A `switch (channel)`; the router asks the
 *           capability object."
 *   s.1.3 D3: "C1 never calls C5, C6, C7, C10, C11 or C12; it emits an
 *           InboundRequest and receives an OutboundDelivery."
 *
 * The capability object is the whole design. Every question a caller might
 * answer with `if (channel === 'whatsapp')` is instead a field here, so adding
 * a fifth channel does not require finding every branch that assumed four.
 */
import type { ChannelName, InboundRequest, SensitivityTierName } from '@eiaaw/contracts';

// Re-exported so a consumer of the adapter interface does not have to reach
// past it into the contracts package for the two types it always needs.
export type { ChannelName, SensitivityTierName };

export interface ChannelCapabilities {
  readonly channel: ChannelName;
  readonly max_body_chars: number;
  readonly supports_attachments: boolean;
  readonly max_attachment_bytes: number;
  readonly supports_rich_blocks: boolean;
  readonly supports_interactive_controls: 'full' | 'limited' | 'none';
  readonly supports_streaming: boolean;
  readonly identity_strength: 'high' | 'medium' | 'low';
  /** file 07 s.3.3 — the highest tier this channel may carry at all. */
  readonly sensitivity_ceiling: SensitivityTierName;
  readonly supports_proactive: 'always' | 'template_only' | 'never';
  readonly supports_delivery_receipt: boolean;
  readonly supports_read_receipt: boolean;
  /** ISO 8601 duration, or null where the channel has no session window. */
  readonly session_window: string | null;
  readonly template_required_outside_window: boolean;
  /** file 05 s.14 — can this channel carry a full evidence bundle? */
  readonly can_carry_evidence_bundle: boolean;
  /** Can a reviewer act on a hand-off here? */
  readonly can_carry_approval: boolean;
}

export interface RenderedMessage {
  readonly channel: ChannelName;
  readonly recipient: string;
  readonly subject?: string;
  readonly body: string;
  readonly blocks?: readonly { kind: string; data: unknown }[];
  readonly attachments?: readonly { filename: string; media_type: string; bytes: Buffer }[];
  readonly thread_ref?: string;
  readonly interactive?: readonly { id: string; label: string }[];
}

export interface SendResult {
  readonly accepted: boolean;
  readonly provider_reference: string | null;
  readonly error?: AdapterError;
}

/** DWD-06 s.4.2 — the seven classes, common to all four adapters. */
export type AdapterErrorClass =
  | 'transport_transient'
  | 'transport_permanent'
  | 'capability_refusal'
  | 'auth'
  | 'rate_limited'
  | 'policy_blocked'
  | 'provider_contract';

export interface AdapterError {
  readonly class: AdapterErrorClass;
  readonly detail: string;
  readonly retryable: boolean;
  readonly retry_after_seconds?: number;
}

export const RETRYABLE_CLASSES: readonly AdapterErrorClass[] = [
  'transport_transient',
  'rate_limited',
];

export function adapterError(
  errorClass: AdapterErrorClass,
  detail: string,
  retryAfterSeconds?: number,
): AdapterError {
  return {
    class: errorClass,
    detail,
    retryable: RETRYABLE_CLASSES.includes(errorClass),
    ...(retryAfterSeconds === undefined ? {} : { retry_after_seconds: retryAfterSeconds }),
  };
}

export interface WebhookVerification {
  readonly verified: boolean;
  readonly reason?: string;
  readonly timestamp_skew_seconds: number;
  readonly provider_event_id: string | null;
}

export interface DeliveryStatusEvent {
  readonly provider_reference: string;
  readonly status: 'queued' | 'accepted' | 'delivered' | 'read' | 'failed' | 'expired';
  readonly at: string;
  readonly detail?: string;
}

export interface Principal {
  readonly principal_id: string | null;
  readonly resolution: 'bound' | 'unbound' | 'unresolved';
  readonly confidence: 'high' | 'medium' | 'low';
  readonly binding_id?: string;
  readonly claimed_identity?: string;
}

/**
 * The interface, per s.4.1.
 *
 * `compose` returns either a rendered message or a capability refusal — it
 * never truncates. s.4.2: "Escalate channel, never truncate."
 */
export interface ChannelAdapter {
  capabilities(): ChannelCapabilities;
  receiveInbound(
    rawEvent: unknown,
    headers: Record<string, string>,
  ): Promise<InboundRequest | { rejected: AdapterError }>;
  compose(payload: ComposePayload): RenderedMessage | { refused: AdapterError };
  send(message: RenderedMessage, idempotencyKey: string): Promise<SendResult>;
  onStatus(rawStatusEvent: unknown): DeliveryStatusEvent | null;
  onFeedback(rawEvent: unknown): { token: string; signal: string } | null;
  health(): Promise<{ ok: boolean; detail?: string }>;
  resolvePrincipal(transportIdentity: string): Promise<Principal>;
  verifyWebhook(rawBody: Buffer, headers: Record<string, string>): WebhookVerification;
  revoke(): Promise<{ revoked: boolean }>;
}

export interface ComposePayload {
  readonly recipient: string;
  readonly subject?: string;
  readonly body: string;
  readonly blocks?: readonly { kind: string; data: unknown }[];
  readonly attachments?: readonly { filename: string; media_type: string; bytes: Buffer }[];
  readonly thread_ref?: string;
  readonly interactive?: readonly { id: string; label: string }[];
  readonly sensitivity: SensitivityTierName;
  readonly carries_evidence_bundle: boolean;
  readonly is_proactive: boolean;
  /** Time since the last inbound, for a session-window channel. */
  readonly session_age_ms?: number;
}

/**
 * The capability check every adapter's `compose` runs first.
 *
 * Shared so the four adapters cannot disagree about what a ceiling means, and
 * so the reasons a message is refused read identically wherever it happened.
 */
export function checkCapability(
  capabilities: ChannelCapabilities,
  payload: ComposePayload,
): AdapterError | null {
  const tierRank = { public: 0, internal: 1, confidential: 2, restricted: 3 } as const;

  if (tierRank[payload.sensitivity] > tierRank[capabilities.sensitivity_ceiling]) {
    return adapterError(
      'capability_refusal',
      `This payload is "${payload.sensitivity}" and the ${capabilities.channel} channel ceiling ` +
        `is "${capabilities.sensitivity_ceiling}". The channel is escalated, never the payload ` +
        'truncated.',
    );
  }

  if (payload.carries_evidence_bundle && !capabilities.can_carry_evidence_bundle) {
    return adapterError(
      'capability_refusal',
      `The ${capabilities.channel} channel cannot carry an evidence bundle. A reviewer would be ` +
        'approving on partial information, so the hand-off is escalated to a channel that can ' +
        '(file 05 s.14).',
    );
  }

  if (payload.body.length > capabilities.max_body_chars) {
    return adapterError(
      'capability_refusal',
      `The body is ${payload.body.length} characters and the ${capabilities.channel} limit is ` +
        `${capabilities.max_body_chars}. Truncating a finance answer would drop the citations ` +
        'or the limits, so the channel is escalated instead.',
    );
  }

  if (payload.attachments && payload.attachments.length > 0 && !capabilities.supports_attachments) {
    return adapterError(
      'capability_refusal',
      `The ${capabilities.channel} channel does not carry attachments.`,
    );
  }

  for (const attachment of payload.attachments ?? []) {
    if (attachment.bytes.length > capabilities.max_attachment_bytes) {
      return adapterError(
        'capability_refusal',
        `"${attachment.filename}" is ${attachment.bytes.length} bytes, above the ` +
          `${capabilities.max_attachment_bytes} limit for ${capabilities.channel}.`,
      );
    }
  }

  if (payload.is_proactive && capabilities.supports_proactive === 'never') {
    return adapterError(
      'capability_refusal',
      `The ${capabilities.channel} channel cannot be used to start a conversation.`,
    );
  }

  // A session-window channel outside its window needs an approved template.
  if (
    capabilities.session_window !== null &&
    capabilities.template_required_outside_window &&
    payload.session_age_ms !== undefined &&
    payload.session_age_ms > parseDurationMs(capabilities.session_window)
  ) {
    return adapterError(
      'capability_refusal',
      `The ${capabilities.channel} session window has closed, so only an approved template may ` +
        'be sent. A free-text message would be rejected by the provider.',
    );
  }

  return null;
}

function parseDurationMs(duration: string): number {
  const hours = /PT(\d+)H/.exec(duration);
  if (hours) return Number(hours[1]) * 3_600_000;
  const minutes = /PT(\d+)M/.exec(duration);
  if (minutes) return Number(minutes[1]) * 60_000;
  return 24 * 3_600_000;
}

/**
 * Pick a channel for a payload — the router.
 *
 * Asks the capability objects; contains no channel names of its own. Ordered by
 * the recipient's preference, then by the first that can carry the payload.
 */
export function selectChannel(
  candidates: readonly ChannelCapabilities[],
  payload: ComposePayload,
  preference: readonly ChannelName[],
): { channel: ChannelName; escalated: boolean } | { refused: AdapterError } {
  const ordered = [...candidates].sort(
    (a, b) => indexOrLast(preference, a.channel) - indexOrLast(preference, b.channel),
  );

  const first = ordered[0];
  for (const capabilities of ordered) {
    if (checkCapability(capabilities, payload) === null) {
      return {
        channel: capabilities.channel,
        escalated: first !== undefined && capabilities.channel !== first.channel,
      };
    }
  }

  return {
    refused: adapterError(
      'capability_refusal',
      'No available channel can carry this payload at its sensitivity. The output is held and ' +
        'the recipient is told where it is, rather than being sent a reduced version.',
    ),
  };
}

const indexOrLast = (list: readonly ChannelName[], value: ChannelName): number => {
  const index = list.indexOf(value);
  return index === -1 ? list.length : index;
};
