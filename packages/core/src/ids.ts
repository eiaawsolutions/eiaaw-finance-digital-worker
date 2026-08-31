/**
 * Identifiers — DWD-06 s.2.1.
 *
 * Surrogate IDs are UUIDv7: opaque, unique, and sortable by creation time.
 * The spec's stated requirement is exactly those three properties; v7 is chosen
 * for index locality, which matters because every hot table is partitioned by
 * tenant then by month and scanned in time order.
 *
 * Node 22 does not ship `randomUUID({ version: 7 })`, so v7 is generated here
 * from the RFC 9562 layout: 48-bit big-endian Unix milliseconds, 4-bit version,
 * 12 bits of entropy, 2-bit variant, 62 bits of entropy.
 */
import { randomBytes, randomUUID } from 'node:crypto';

const HEX = '0123456789abcdef';

/** A monotonic counter guards against collisions inside the same millisecond. */
let lastTimestamp = -1;
let sequence = 0;

export function uuidv7(now: number = Date.now()): string {
  if (now === lastTimestamp) {
    sequence = (sequence + 1) & 0x0fff;
    // Sequence exhausted inside one millisecond — borrow from the next.
    if (sequence === 0) now += 1;
  } else {
    sequence = randomBytes(2).readUInt16BE(0) & 0x0fff;
  }
  lastTimestamp = now;

  const bytes = new Uint8Array(16);

  // 48-bit big-endian timestamp
  const ts = BigInt(now);
  bytes[0] = Number((ts >> 40n) & 0xffn);
  bytes[1] = Number((ts >> 32n) & 0xffn);
  bytes[2] = Number((ts >> 24n) & 0xffn);
  bytes[3] = Number((ts >> 16n) & 0xffn);
  bytes[4] = Number((ts >> 8n) & 0xffn);
  bytes[5] = Number(ts & 0xffn);

  // version 7 in the high nibble of byte 6, then 12 bits of sequence
  bytes[6] = 0x70 | ((sequence >> 8) & 0x0f);
  bytes[7] = sequence & 0xff;

  const entropy = randomBytes(8);
  for (let i = 0; i < 8; i += 1) bytes[8 + i] = entropy[i] as number;

  // RFC 9562 variant bits (10xx) in the high bits of byte 8
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;

  let out = '';
  for (let i = 0; i < 16; i += 1) {
    const b = bytes[i] as number;
    out += HEX[b >> 4];
    out += HEX[b & 0x0f];
    if (i === 3 || i === 5 || i === 7 || i === 9) out += '-';
  }
  return out;
}

/** Extract the creation instant from a UUIDv7. Used by retention partitioning. */
export function uuidv7Timestamp(id: string): Date {
  const hex = id.replace(/-/g, '').slice(0, 12);
  return new Date(Number(BigInt(`0x${hex}`)));
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (value: string): boolean => UUID_PATTERN.test(value);

/**
 * Prefixed surrogate IDs. The prefix is part of the wire contract — DWD-06 s.3
 * shows `ctx_`, `tg_`, `si_`, `tc_`, `eb_` and so on in every example instance,
 * and an audit reading a raw UUID cannot tell what it points at.
 */
export const ID_PREFIX = {
  context: 'ctx',
  conversation: 'cnv',
  message: 'msg',
  taskGraph: 'tg',
  policyVerdict: 'pv',
  skillInvocation: 'si',
  toolCall: 'tc',
  evidenceBundle: 'eb',
  handoff: 'hnd',
  reviewerAction: 'ra',
  decisionRecord: 'dr',
  auditEvent: 'ae',
  outboundDelivery: 'od',
  feedbackEvent: 'fb',
  attachment: 'att',
  binding: 'bnd',
  workflowRun: 'wf',
  workingMemory: 'wm',
  changeRequest: 'cr',
  settingsSnapshot: 'snp',
  incident: 'inc',
  scopeCard: 'sc',
} as const;

export type IdKind = keyof typeof ID_PREFIX;

export function newId(kind: IdKind): string {
  return `${ID_PREFIX[kind]}_${uuidv7()}`;
}

/** `request_id` is a bare UUIDv7 — it is the root correlation key (DWD-06 s.3.1). */
export const newRequestId = (): string => uuidv7();

export function isId(kind: IdKind, value: string): boolean {
  const prefix = `${ID_PREFIX[kind]}_`;
  return value.startsWith(prefix) && isUuid(value.slice(prefix.length));
}

/** Tenant IDs are opaque, stable, and assigned at onboarding (DWD-06 s.2.1). */
const TENANT_PATTERN = /^tnt_[a-z0-9][a-z0-9_-]{1,62}$/;
export const isTenantId = (value: string): boolean => TENANT_PATTERN.test(value);

export function tenantId(slug: string): string {
  const normalised = slug
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const id = `tnt_${normalised}`;
  if (!isTenantId(id)) {
    throw new Error(`Cannot derive a valid tenant_id from "${slug}".`);
  }
  return id;
}

/** W3C Trace Context: 32 lowercase hex, never all zeroes. */
export function newTraceId(): string {
  let id: string;
  do {
    id = randomBytes(16).toString('hex');
  } while (/^0{32}$/.test(id));
  return id;
}

export function newSpanId(): string {
  let id: string;
  do {
    id = randomBytes(8).toString('hex');
  } while (/^0{16}$/.test(id));
  return id;
}

export const isTraceId = (value: string): boolean =>
  /^[0-9a-f]{32}$/.test(value) && !/^0{32}$/.test(value);

/**
 * Approval nonce (DWD-06 s.6.5): single-use, high entropy, stored server-side
 * as a hash. The raw value leaves the process exactly once, in the hand-off.
 */
export const newNonce = (): string => randomBytes(32).toString('hex');

/** Non-correlating opaque ID for anything that is not a domain object. */
export const newOpaqueId = (): string => randomUUID();
