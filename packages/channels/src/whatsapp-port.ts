/**
 * The WhatsApp BSP port — DWD-06 s.4.4.
 *
 *   "The adapter is written against the Cloud API contract shape and talks to a
 *    PORT, so the BSP is substitutable without touching the adapter."
 *
 * Port rules (s.4.4):
 *   P1  No BSP-proprietary field reaches the adapter; `normaliseInbound` maps
 *       or drops.
 *   P2  A capability the port cannot express is not used, however convenient.
 *   P3  Template names, locales and variable order live in configuration at
 *       `AS-SYS-*`, never in code.
 *   P4  Swapping BSP is a new port implementation plus a conformance pass — not
 *       a MAJOR worker version, because nothing above L7 changes.
 *   P5  Session-window arithmetic is computed by the adapter from the canonical
 *       event timestamps, NOT read from a provider convenience field.
 *
 * P5 matters more than it looks: a provider's "session is open" flag is a
 * derived value the provider may compute differently from you, and being wrong
 * about it means a message rejected at send time or a template billed as a
 * conversation.
 */
import { asText, textAt, type SecretRef } from '@eiaaw/core';
import { adapterError, type AdapterError } from './adapter.js';

/** The canonical event. Nothing BSP-specific survives normalisation (P1). */
export interface CanonicalWhatsAppEvent {
  readonly wamid: string;
  readonly from: string;
  /** Epoch seconds, from the provider event — the input to P5 arithmetic. */
  readonly timestamp: number;
  readonly type: 'text' | 'image' | 'document' | 'audio' | 'interactive' | 'unsupported';
  readonly text: string | null;
  readonly media_ref: string | null;
  readonly interactive_reply_id: string | null;
  readonly context_wamid: string | null;
}

export interface ProviderSendResult {
  readonly accepted: boolean;
  readonly wamid: string | null;
  readonly error?: AdapterError;
}

export interface TemplateDescriptor {
  readonly name: string;
  readonly locale: string;
  readonly variable_count: number;
  readonly approved: boolean;
}

export interface NumberHealth {
  readonly quality_rating: 'green' | 'yellow' | 'red' | 'unknown';
  readonly messaging_limit: number | null;
  readonly number_status: 'connected' | 'flagged' | 'restricted' | 'unknown';
}

export interface WhatsAppTransportPort {
  readonly id: string;
  sendSessionMessage(to: string, body: string, idempotencyKey: string): Promise<ProviderSendResult>;
  sendTemplateMessage(
    to: string,
    templateName: string,
    locale: string,
    variables: readonly string[],
    idempotencyKey: string,
  ): Promise<ProviderSendResult>;
  sendInteractive(
    to: string,
    payload: unknown,
    idempotencyKey: string,
  ): Promise<ProviderSendResult>;
  uploadMedia(bytes: Buffer, mediaType: string): Promise<string>;
  downloadMedia(mediaId: string): Promise<Buffer>;
  verifyWebhookSignature(rawBody: Buffer, headers: Record<string, string>): boolean;
  normaliseInbound(providerEvent: unknown): CanonicalWhatsAppEvent[];
  normaliseStatus(providerStatusEvent: unknown): {
    wamid: string;
    status: string;
    at: string;
  }[];
  templateCatalogue(): Promise<readonly TemplateDescriptor[]>;
  healthAndQuality(): Promise<NumberHealth>;
}

/**
 * P5 — session-window arithmetic, computed here from canonical timestamps.
 *
 * The window runs from the LAST INBOUND message, not from the last message of
 * any kind: replying does not extend a customer's window.
 */
export function sessionWindowState(input: {
  readonly lastInboundEpochSeconds: number | null;
  readonly windowMs: number;
  readonly now?: number;
}): { open: boolean; remaining_ms: number; requires_template: boolean } {
  if (input.lastInboundEpochSeconds === null) {
    return { open: false, remaining_ms: 0, requires_template: true };
  }

  const elapsed = (input.now ?? Date.now()) - input.lastInboundEpochSeconds * 1000;
  const remaining = input.windowMs - elapsed;

  return {
    open: remaining > 0,
    remaining_ms: Math.max(0, remaining),
    requires_template: remaining <= 0,
  };
}

/**
 * A deterministic stub port for `dev` and `test`.
 *
 * Implements the same contract shape as a real BSP, so the adapter above it is
 * exercised for real. Swapping this for a Cloud API implementation touches this
 * file and nothing else (P4).
 */
export class StubWhatsAppPort implements WhatsAppTransportPort {
  readonly id = 'stub';
  readonly sent: {
    kind: 'session' | 'template' | 'interactive';
    to: string;
    body: string;
    idempotencyKey: string;
  }[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async sendSessionMessage(
    to: string,
    body: string,
    idempotencyKey: string,
  ): Promise<ProviderSendResult> {
    // Idempotent by key, the way a real provider with a client reference is.
    const existing = this.sent.find((s) => s.idempotencyKey === idempotencyKey);
    if (existing) return { accepted: true, wamid: `wamid.${idempotencyKey.slice(0, 12)}` };

    this.sent.push({ kind: 'session', to, body, idempotencyKey });
    return { accepted: true, wamid: `wamid.${idempotencyKey.slice(0, 12)}` };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async sendTemplateMessage(
    to: string,
    templateName: string,
    locale: string,
    variables: readonly string[],
    idempotencyKey: string,
  ): Promise<ProviderSendResult> {
    const catalogue = STUB_TEMPLATES.find((t) => t.name === templateName && t.locale === locale);
    if (!catalogue) {
      return {
        accepted: false,
        wamid: null,
        error: adapterError(
          'policy_blocked',
          `Template "${templateName}" (${locale}) is not in the approved catalogue. Template ` +
            'names and locales live in configuration at AS-SYS-*, never in code (P3).',
        ),
      };
    }
    if (variables.length !== catalogue.variable_count) {
      return {
        accepted: false,
        wamid: null,
        error: adapterError(
          'provider_contract',
          `Template "${templateName}" takes ${catalogue.variable_count} variables, ` +
            `${variables.length} supplied.`,
        ),
      };
    }

    this.sent.push({ kind: 'template', to, body: templateName, idempotencyKey });
    return { accepted: true, wamid: `wamid.${idempotencyKey.slice(0, 12)}` };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async sendInteractive(
    to: string,
    _payload: unknown,
    idempotencyKey: string,
  ): Promise<ProviderSendResult> {
    this.sent.push({ kind: 'interactive', to, body: '[interactive]', idempotencyKey });
    return { accepted: true, wamid: `wamid.${idempotencyKey.slice(0, 12)}` };
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async uploadMedia(bytes: Buffer): Promise<string> {
    return `media.${bytes.length}`;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async downloadMedia(mediaId: string): Promise<Buffer> {
    return Buffer.from(`stub media ${mediaId}`);
  }

  verifyWebhookSignature(): boolean {
    return true;
  }

  /** P1 — maps or drops. No provider field escapes. */
  normaliseInbound(providerEvent: unknown): CanonicalWhatsAppEvent[] {
    const event = providerEvent as {
      entry?: { changes?: { value?: { messages?: Record<string, unknown>[] } }[] }[];
    };

    const messages =
      event.entry?.flatMap((e) => e.changes?.flatMap((c) => c.value?.messages ?? []) ?? []) ?? [];

    return messages.map((message): CanonicalWhatsAppEvent => {
      const type = asText(message['type'], 'unsupported');
      return {
        wamid: asText(message['id'], ''),
        from: asText(message['from'], ''),
        timestamp: Number(message['timestamp'] ?? 0),
        type: (['text', 'image', 'document', 'audio', 'interactive'] as const).includes(
          type as never,
        )
          ? (type as CanonicalWhatsAppEvent['type'])
          : 'unsupported',
        text: type === 'text' ? textAt(message, ['text', 'body'], '') : null,
        media_ref:
          type === 'document' || type === 'image' ? textAt(message, [type, 'id'], '') : null,
        interactive_reply_id:
          type === 'interactive'
            ? textAt(message, ['interactive', 'button_reply', 'id'], '')
            : null,
        context_wamid: textAt(message, ['context', 'id'], '') || null,
      };
    });
  }

  normaliseStatus(providerStatusEvent: unknown): { wamid: string; status: string; at: string }[] {
    const event = providerStatusEvent as {
      entry?: { changes?: { value?: { statuses?: Record<string, unknown>[] } }[] }[];
    };
    const statuses =
      event.entry?.flatMap((e) => e.changes?.flatMap((c) => c.value?.statuses ?? []) ?? []) ?? [];

    return statuses.map((status) => ({
      wamid: asText(status['id'], ''),
      status: asText(status['status'], 'unknown'),
      at: new Date(Number(status['timestamp'] ?? 0) * 1000).toISOString(),
    }));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async templateCatalogue(): Promise<readonly TemplateDescriptor[]> {
    return STUB_TEMPLATES;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async healthAndQuality(): Promise<NumberHealth> {
    return { quality_rating: 'green', messaging_limit: 1000, number_status: 'connected' };
  }
}

/**
 * The templates a dev environment knows about.
 *
 * P3: in production these come from `AS-SYS-*` and are verified against the
 * provider's approved catalogue at startup. Nothing here is a default a tenant
 * inherits.
 */
const STUB_TEMPLATES: readonly TemplateDescriptor[] = [
  { name: 'handoff_awaiting_action', locale: 'en_MY', variable_count: 2, approved: true },
  { name: 'handoff_sla_breached', locale: 'en_MY', variable_count: 2, approved: true },
  { name: 'output_ready', locale: 'en_MY', variable_count: 1, approved: true },
];

export function createWhatsAppPort(options: {
  readonly driver: 'stub' | 'cloud-api';
  readonly appSecret?: SecretRef;
  readonly accessToken?: SecretRef;
  readonly phoneNumberId?: SecretRef;
}): WhatsAppTransportPort {
  if (options.driver === 'stub') return new StubWhatsAppPort();

  // P4: a real BSP is a new implementation of THIS interface, plus a
  // conformance-suite pass and a live delivery test per class and locale.
  throw new Error(
    'The Cloud API WhatsApp port is not wired in this build. Implement ' +
      'WhatsAppTransportPort against the BSP and register it here; nothing above L7 changes ' +
      '(DWD-06 s.4.4 P4). Set WHATSAPP_BSP_DRIVER=stub for development.',
  );
}
