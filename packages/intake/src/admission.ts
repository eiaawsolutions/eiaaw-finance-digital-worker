/**
 * Admission control and inbound dedupe — DWD-06 s.5.2, s.8.1.
 *
 *   s.5.2: "A webhook endpoint does exactly four things: verify, deduplicate,
 *           admit or reject, enqueue. It never plans, never resolves context and
 *           never answers synchronously."
 *
 * Admission is the cheapest possible filter and runs before anything else
 * touches the message. Everything it rejects is logged and goes no further.
 */
import { type Result, err, inboundDedupeKey, ok, sha256 } from '@eiaaw/core';
import type { ChannelName, InboundRequest, SecurityFlags } from '@eiaaw/contracts';
import { type Database, withTenant } from '@eiaaw/db';

export type RejectionReason =
  | 'signature_invalid'
  | 'replay_window_exceeded'
  | 'duplicate'
  | 'sender_unknown'
  | 'loop_detected'
  | 'authentication_failed'
  | 'attachment_unscanned'
  | 'payload_too_large'
  | 'tenant_suspended';

export interface AdmissionDecision {
  readonly decision: 'admitted' | 'rejected';
  readonly reason_code: RejectionReason | null;
  readonly detail: string | null;
  /** Set on a duplicate: the request_id of the original (s.8.3). */
  readonly original_request_id?: string;
}

export interface AdmissionInput {
  readonly tenant_id: string;
  readonly channel: ChannelName;
  readonly transport_message_id: string;
  readonly body_text: string;
  readonly security_flags: SecurityFlags;
  readonly signature_verified: boolean;
  readonly timestamp_skew_seconds: number;
  readonly replay_window_seconds: number;
  readonly attachments_scanned: boolean;
  readonly size_bytes: number;
  readonly max_size_bytes?: number;
}

const MAX_INBOUND_BYTES = 25 * 1024 * 1024;

export function evaluateAdmission(input: AdmissionInput): AdmissionDecision {
  const reject = (reason: RejectionReason, detail: string): AdmissionDecision => ({
    decision: 'rejected',
    reason_code: reason,
    detail,
  });

  // s.6.1 W1: verification happens on the raw bytes before parsing. By the time
  // admission runs it has either passed or it has not.
  if (!input.signature_verified) {
    return reject(
      'signature_invalid',
      'The webhook signature did not verify. Repeated failures from one source trip a block.',
    );
  }

  // s.6.1 W3: skew beyond the replay window is a REJECTION, not a warning.
  if (Math.abs(input.timestamp_skew_seconds) > input.replay_window_seconds) {
    return reject(
      'replay_window_exceeded',
      `The message timestamp is ${Math.round(input.timestamp_skew_seconds)}s from now, outside ` +
        `the ${input.replay_window_seconds}s replay window.`,
    );
  }

  if (input.security_flags.replay_suspected) {
    return reject('replay_window_exceeded', 'The provider flagged this delivery as a replay.');
  }

  // file 02 s.2: loop protection. A worker replying to its own auto-reply is a
  // mail storm, and the cheapest place to stop it is here.
  if (input.security_flags.loop_indicator) {
    return reject(
      'loop_detected',
      'The message carries a loop indicator (auto-submitted or a precedence header).',
    );
  }

  if (input.size_bytes > (input.max_size_bytes ?? MAX_INBOUND_BYTES)) {
    return reject('payload_too_large', `The payload is ${input.size_bytes} bytes.`);
  }

  // Email authentication. An external sender that fails DMARC is not merely
  // untrusted content — it is a probable forgery of someone the worker trusts.
  if (input.channel === 'email' && input.security_flags.sender_external) {
    if (input.security_flags.dmarc === 'fail') {
      return reject(
        'authentication_failed',
        'The sending domain failed DMARC. An external message that fails domain ' +
          'authentication is treated as a forgery attempt.',
      );
    }
    if (input.security_flags.allow_list === 'non_member') {
      return reject(
        'sender_unknown',
        'The sender is external and not on the allow list. Immutable rule 7 means the worker ' +
          'would not be able to reply in any case.',
      );
    }
  }

  return { decision: 'admitted', reason_code: null, detail: null };
}

/**
 * Inbound dedupe — s.8.1, family 1.
 *
 * Keyed on the content hash as well as the transport id, so a provider that
 * reuses an id for a genuinely different message is not silently swallowed.
 */
export async function checkDuplicate(
  db: Database,
  residencyZone: string,
  input: {
    readonly tenant_id: string;
    readonly channel: ChannelName;
    readonly transport_message_id: string;
    readonly body_text: string;
    readonly request_id: string;
    readonly ttl_seconds: number;
  },
): Promise<Result<{ readonly key: string }, { readonly original_request_id: string }>> {
  const key = inboundDedupeKey({
    tenant_id: input.tenant_id,
    channel: input.channel,
    transport_message_id: input.transport_message_id,
    content_hash: sha256(input.body_text),
  });

  return withTenant(db, { tenantId: input.tenant_id, residencyZone }, async (s) => {
    const claimed = await s.sql<{ key: string }[]>`
        INSERT INTO idempotency_records (
          tenant_id, key, family, state, request_hash, outcome_ref, expires_at
        ) VALUES (
          ${input.tenant_id}, ${key}, 'inbound_dedupe', 'completed',
          ${sha256(input.body_text)}, ${input.request_id},
          now() + (${input.ttl_seconds} || ' seconds')::interval
        )
        ON CONFLICT (tenant_id, key) DO NOTHING
        RETURNING key
      `;

    if (claimed.length === 1) return ok({ key });

    const existing = await s.sql<{ outcome_ref: string | null }[]>`
        SELECT outcome_ref FROM idempotency_records
         WHERE tenant_id = ${input.tenant_id} AND key = ${key}
      `;

    // s.8.3: a duplicate webhook returns 409 with the ORIGINAL request_id, so
    // the provider treats it as delivered and stops retrying.
    return err({ original_request_id: existing[0]?.outcome_ref ?? input.request_id });
  });
}

/**
 * The conversation key.
 *
 * file 02 s.10: logical, not the transport thread — so a conversation that
 * starts on email and continues in chat is one conversation. Derived from the
 * principal plus a stable thread root, never from a provider thread id alone.
 */
export function deriveConversationKey(input: {
  readonly tenant_id: string;
  readonly principal_id: string | null;
  readonly thread_root: string | null;
  readonly channel: ChannelName;
  readonly transport_message_id: string;
}): string {
  // An unbound sender gets a per-message conversation: there is no identity to
  // hang continuity on, and inventing one would merge two strangers' threads.
  const anchor =
    input.principal_id === null
      ? `${input.channel}:${input.transport_message_id}`
      : `${input.principal_id}:${input.thread_root ?? input.transport_message_id}`;

  return `cnv_${sha256(`${input.tenant_id}|${anchor}`).slice(0, 32)}`;
}

/** The five security-flag defaults for a channel with no transport auth of its own. */
export const defaultSecurityFlags = (external: boolean): SecurityFlags => ({
  sender_external: external,
  allow_list: external ? 'non_member' : 'member',
  loop_indicator: false,
  replay_suspected: false,
});

export const requestIsAdmitted = (request: InboundRequest): boolean =>
  request.admission.decision === 'admitted';
