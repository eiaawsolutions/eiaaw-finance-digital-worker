/**
 * Webhook security — DWD-06 s.6.
 *
 *   W1: "Signature verification runs on the RAW BYTE BODY before any parsing or
 *        normalisation."
 *   W2: comparison is constant-time.
 *   W3: "Timestamp skew beyond the channel's replay window is a REJECTION, not
 *        a warning."
 *   s.6.3: two active secrets at all times, current and next, so rotation never
 *        leaves a window with no verification.
 *
 * W1 is the one that is easy to get subtly wrong: a framework that parses JSON
 * before the handler runs has already destroyed the bytes the signature covers.
 * Every function here takes a `Buffer`, never an object.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SecretRef } from '@eiaaw/core';
import type { WebhookVerification } from './adapter.js';

export interface VerificationSecrets {
  /** Both are accepted during the rotation overlap window (s.6.3). */
  readonly current: SecretRef;
  readonly next?: SecretRef;
}

function constantTimeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

/**
 * HMAC-SHA256 over `timestamp.rawBody`, the shape most providers use.
 *
 * The timestamp is inside the signed payload, so an attacker cannot replay a
 * valid body with a fresh timestamp.
 */
export function verifyHmacSignature(input: {
  readonly rawBody: Buffer;
  readonly signature: string;
  readonly timestamp: string;
  readonly secrets: VerificationSecrets;
  readonly replayWindowSeconds: number;
  readonly providerEventId: string | null;
  readonly now?: number;
}): WebhookVerification {
  const timestampSeconds = Number(input.timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return {
      verified: false,
      reason: 'the signature timestamp is not a number',
      timestamp_skew_seconds: Number.POSITIVE_INFINITY,
      provider_event_id: input.providerEventId,
    };
  }

  const nowSeconds = Math.floor((input.now ?? Date.now()) / 1000);
  const skew = nowSeconds - timestampSeconds;

  // W3: checked BEFORE the HMAC, so a replayed body does not even get compared.
  if (Math.abs(skew) > input.replayWindowSeconds) {
    return {
      verified: false,
      reason: `timestamp skew of ${skew}s exceeds the ${input.replayWindowSeconds}s replay window`,
      timestamp_skew_seconds: skew,
      provider_event_id: input.providerEventId,
    };
  }

  const payload = `${input.timestamp}.${input.rawBody.toString('utf8')}`;
  const candidates = [input.secrets.current, input.secrets.next].filter(
    (s): s is SecretRef => s !== undefined,
  );

  for (const secret of candidates) {
    const expected = createHmac('sha256', secret.expose()).update(payload).digest('hex');
    const presented = input.signature.replace(/^(?:sha256=|v1=)/, '');
    if (constantTimeEquals(expected, presented)) {
      return {
        verified: true,
        timestamp_skew_seconds: skew,
        provider_event_id: input.providerEventId,
      };
    }
  }

  return {
    verified: false,
    reason: 'no configured secret produced a matching signature',
    timestamp_skew_seconds: skew,
    provider_event_id: input.providerEventId,
  };
}

/**
 * Telegram uses a static secret token header rather than a signature.
 *
 * s.6.2: "the bot token is never the webhook secret." Two different
 * credentials, and conflating them means anyone who has seen an outbound API
 * call can forge an inbound update.
 */
export function verifySecretToken(input: {
  readonly presented: string | undefined;
  readonly secrets: VerificationSecrets;
  readonly providerEventId: string | null;
}): WebhookVerification {
  if (!input.presented) {
    return {
      verified: false,
      reason: 'the secret token header is absent',
      timestamp_skew_seconds: 0,
      provider_event_id: input.providerEventId,
    };
  }

  const candidates = [input.secrets.current, input.secrets.next].filter(
    (s): s is SecretRef => s !== undefined,
  );

  for (const secret of candidates) {
    if (constantTimeEquals(secret.expose(), input.presented)) {
      return {
        verified: true,
        timestamp_skew_seconds: 0,
        provider_event_id: input.providerEventId,
      };
    }
  }

  return {
    verified: false,
    reason: 'the secret token did not match the current or next secret',
    timestamp_skew_seconds: 0,
    provider_event_id: input.providerEventId,
  };
}

/**
 * Counts verification failures per source and trips a block — s.6.1 W5.
 *
 * In-memory and per-process, which is adequate: a distributed attacker hitting
 * many instances still trips each one, and the audit events aggregate centrally.
 */
export class VerificationFailureTracker {
  readonly #failures = new Map<string, { count: number; firstAt: number }>();

  constructor(
    private readonly threshold = 10,
    private readonly windowMs = 60_000,
  ) {}

  record(source: string, now = Date.now()): { blocked: boolean; count: number } {
    const entry = this.#failures.get(source);

    if (!entry || now - entry.firstAt > this.windowMs) {
      this.#failures.set(source, { count: 1, firstAt: now });
      return { blocked: false, count: 1 };
    }

    entry.count += 1;
    return { blocked: entry.count >= this.threshold, count: entry.count };
  }

  isBlocked(source: string, now = Date.now()): boolean {
    const entry = this.#failures.get(source);
    if (!entry) return false;
    if (now - entry.firstAt > this.windowMs) {
      this.#failures.delete(source);
      return false;
    }
    return entry.count >= this.threshold;
  }

  reset(source?: string): void {
    if (source === undefined) this.#failures.clear();
    else this.#failures.delete(source);
  }
}
