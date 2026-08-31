/**
 * Hashing, canonical serialisation and idempotency-key derivation.
 *
 * Three things depend on byte-stable serialisation:
 *   - the audit hash chain (DWD-06 s.3.14) — a re-serialisation that differs by
 *     key order would break the chain and look like tampering;
 *   - `inputs_hash` on a PolicyVerdict (s.3.7), which must make a verdict
 *     re-derivable during an audit years later;
 *   - `content_hash` on records and artefacts (s.3.8, s.3.10).
 *
 * Canonical form: keys sorted lexicographically, no insignificant whitespace,
 * `undefined` omitted, numbers rendered by the shortest round-trip form.
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export type Sha256Hex = string;
/** `sha256:<64 hex>` — the form that appears inside every contract. */
export type PrefixedHash = string;

export class HashError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HashError';
  }
}

/** Deterministic JSON. Key order is lexicographic at every depth. */
export function canonicalJson(value: unknown): string {
  return serialise(value, new WeakSet());
}

function serialise(value: unknown, seen: WeakSet<object>): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new HashError(
          `Cannot canonicalise non-finite number ${String(value)}. ` +
            'NaN and Infinity have no JSON representation and indicate a computation defect.',
        );
      }
      return JSON.stringify(value);
    case 'bigint':
      // BigInt has no JSON form; monetary values are already integers-as-number.
      return `"${value.toString()}"`;
    case 'string':
      return JSON.stringify(value);
    case 'undefined':
    case 'function':
    case 'symbol':
      throw new HashError(`Value of type ${typeof value} is not serialisable.`);
    default:
      break;
  }

  const obj = value;
  if (seen.has(obj)) throw new HashError('Cannot canonicalise a circular structure.');
  seen.add(obj);

  try {
    if (Array.isArray(obj)) {
      return `[${obj.map((item) => serialise(item ?? null, seen)).join(',')}]`;
    }
    if (obj instanceof Date) return JSON.stringify(obj.toISOString());

    const record = obj as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${serialise(record[key], seen)}`);
    return `{${entries.join(',')}}`;
  } finally {
    seen.delete(obj);
  }
}

export function sha256(input: string | Uint8Array): Sha256Hex {
  return createHash('sha256').update(input).digest('hex');
}

export const sha256Prefixed = (input: string | Uint8Array): PrefixedHash =>
  `sha256:${sha256(input)}`;

/** Hash a contract instance. Used for `inputs_hash`, `output_hash`, `payload_hash`. */
export const hashObject = (value: unknown): PrefixedHash => sha256Prefixed(canonicalJson(value));

export const hashBytes = (bytes: Uint8Array): PrefixedHash => sha256Prefixed(bytes);

/** Constant-time comparison. Webhook signature checks require this (s.6.1 W2). */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    // Still burn a comparison so length is not a timing oracle.
    timingSafeEqual(bufA, bufA);
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

// ---------------------------------------------------------------------------
// Idempotency key derivation — DWD-06 s.8.1
//
// All four families are SHA-256 over a `|`-joined tuple of business identity.
// The rule that matters: derivation is at *compile time*, from business
// identity, and never includes a timestamp, a random value or an attempt
// counter (s.8.1, s.8.4 red flags). Every function here is pure.
// ---------------------------------------------------------------------------

const SEPARATOR = '|';

function derive(parts: readonly (string | number)[]): Sha256Hex {
  return sha256(parts.map((p) => String(p)).join(SEPARATOR));
}

/** Family 1 — inbound dedupe at the channel gateway. */
export function inboundDedupeKey(input: {
  readonly tenant_id: string;
  readonly channel: string;
  readonly transport_message_id: string;
  readonly content_hash: string;
}): Sha256Hex {
  return derive([input.tenant_id, input.channel, input.transport_message_id, input.content_hash]);
}

/** Family 2 — public API requests, namespaced by (tenant, principal, endpoint). */
export function apiIdempotencyKey(input: {
  readonly tenant_id: string;
  readonly principal_id: string;
  readonly endpoint: string;
  readonly client_key: string;
}): Sha256Hex {
  return derive([input.tenant_id, input.principal_id, input.endpoint, input.client_key]);
}

/**
 * Family 3 — tool calls.
 *
 * Fixed by file 03 s.11.3 and restated at DWD-06 s.8.1. Computed by the planner
 * at compile time, recorded in the TaskNode, and written to the trace before
 * execution. This is the mechanism that makes "a retry can never double-post"
 * true rather than aspirational.
 */
export function toolCallIdempotencyKey(input: {
  readonly tenant_id: string;
  readonly entity_id: string;
  readonly sop_id: string;
  readonly business_key: string;
  readonly context_token_hash: string;
}): Sha256Hex {
  return derive([
    input.tenant_id,
    input.entity_id,
    input.sop_id,
    input.business_key,
    input.context_token_hash,
  ]);
}

/** Family 4 — outbound delivery, per (task, output, recipient, channel, attempt group). */
export function deliveryIdempotencyKey(input: {
  readonly graph_id: string;
  readonly output_class: string;
  readonly recipient_id: string;
  readonly channel: string;
  readonly attempt_group: number;
}): Sha256Hex {
  return derive([
    input.graph_id,
    input.output_class,
    input.recipient_id,
    input.channel,
    input.attempt_group,
  ]);
}

/**
 * The context token hash that feeds tool-call derivation. It pins the axes that
 * make a call *this* call: same entity, same period, same framework, same pack.
 * Deliberately excludes `resolved_at` so a re-resolution of an identical context
 * derives an identical key.
 */
export function contextTokenHash(input: {
  readonly jurisdiction: string;
  readonly reporting_framework: string;
  readonly legal_entity: string;
  readonly currency: string;
  readonly as_of_date: string;
  readonly pack_version: string;
}): Sha256Hex {
  return sha256(canonicalJson(input));
}

// ---------------------------------------------------------------------------
// Audit hash chain — DWD-06 s.3.14, s.10.5
// ---------------------------------------------------------------------------

/** The genesis link of a per-tenant chain. */
export const CHAIN_GENESIS: PrefixedHash = `sha256:${'0'.repeat(64)}`;

/**
 * `event_hash = sha256(prev_event_hash | canonical(event without event_hash))`.
 *
 * Chaining the previous hash *into* the current one is what makes an
 * intermediate deletion detectable: removing a link breaks every hash after it.
 */
export function chainEventHash(
  previousEventHash: PrefixedHash,
  eventWithoutHash: Record<string, unknown>,
): PrefixedHash {
  return sha256Prefixed(`${previousEventHash}${SEPARATOR}${canonicalJson(eventWithoutHash)}`);
}

export interface ChainLink {
  readonly event_id: string;
  readonly prev_event_hash: PrefixedHash;
  readonly event_hash: PrefixedHash;
  readonly payload: Record<string, unknown>;
}

export interface ChainVerification {
  readonly ok: boolean;
  readonly verified: number;
  readonly brokenAt?: {
    readonly index: number;
    readonly event_id: string;
    readonly reason: string;
  };
}

/**
 * Walk a chain segment and recompute every link. The verification job runs this
 * on a schedule and alerts on a break (DWD-06 s.10.5); Phase 0 acceptance P0-2
 * requires an induced tamper to be detected here.
 */
export function verifyChain(
  links: readonly ChainLink[],
  expectedStart: PrefixedHash = CHAIN_GENESIS,
): ChainVerification {
  let previous = expectedStart;

  for (let index = 0; index < links.length; index += 1) {
    const link = links[index] as ChainLink;

    if (link.prev_event_hash !== previous) {
      return {
        ok: false,
        verified: index,
        brokenAt: {
          index,
          event_id: link.event_id,
          reason: `prev_event_hash ${link.prev_event_hash} does not follow ${previous}; a link is missing or reordered.`,
        },
      };
    }

    const recomputed = chainEventHash(link.prev_event_hash, link.payload);
    if (recomputed !== link.event_hash) {
      return {
        ok: false,
        verified: index,
        brokenAt: {
          index,
          event_id: link.event_id,
          reason: `event_hash mismatch: stored ${link.event_hash}, recomputed ${recomputed}; the payload was altered after it was written.`,
        },
      };
    }

    previous = link.event_hash;
  }

  return { ok: true, verified: links.length };
}
