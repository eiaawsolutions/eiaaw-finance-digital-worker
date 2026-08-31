import { describe, expect, it } from 'vitest';
import {
  CHAIN_GENESIS,
  type ChainLink,
  canonicalJson,
  chainEventHash,
  contextTokenHash,
  hashObject,
  inboundDedupeKey,
  safeEqual,
  toolCallIdempotencyKey,
  verifyChain,
} from './hash.js';

describe('canonicalJson', () => {
  it('sorts keys at every depth so the hash is order-independent', () => {
    const a = { b: 1, a: { d: 2, c: 3 } };
    const b = { a: { c: 3, d: 2 }, b: 1 };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(canonicalJson(a)).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('omits undefined but preserves null', () => {
    expect(canonicalJson({ a: undefined, b: null })).toBe('{"b":null}');
  });

  it('preserves array order — position is meaning', () => {
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });

  it('refuses non-finite numbers rather than emitting null', () => {
    expect(() => canonicalJson({ a: NaN })).toThrow(/non-finite/);
    expect(() => canonicalJson({ a: Infinity })).toThrow(/non-finite/);
  });

  it('refuses a circular structure', () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj['self'] = obj;
    expect(() => canonicalJson(obj)).toThrow(/circular/);
  });
});

describe('hashObject', () => {
  it('is stable across key ordering', () => {
    expect(hashObject({ x: 1, y: 2 })).toBe(hashObject({ y: 2, x: 1 }));
  });

  it('changes when any value changes', () => {
    expect(hashObject({ x: 1 })).not.toBe(hashObject({ x: 2 }));
  });

  it('emits the sha256: prefix the contracts use', () => {
    expect(hashObject({})).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe('idempotency key derivation (DWD-06 s.8.1)', () => {
  const base = {
    tenant_id: 'tnt_acme',
    entity_id: 'ENT-0007',
    sop_id: 'PP/01#5.3',
    business_key: 'INV-7741',
    context_token_hash: 'abc123',
  };

  it('is deterministic — the same business identity always derives the same key', () => {
    expect(toolCallIdempotencyKey(base)).toBe(toolCallIdempotencyKey({ ...base }));
  });

  it('is 64 lowercase hex characters', () => {
    expect(toolCallIdempotencyKey(base)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('separates tenants — the same invoice number in two tenants is two keys', () => {
    expect(toolCallIdempotencyKey(base)).not.toBe(
      toolCallIdempotencyKey({ ...base, tenant_id: 'tnt_other' }),
    );
  });

  it('separates business keys', () => {
    expect(toolCallIdempotencyKey(base)).not.toBe(
      toolCallIdempotencyKey({ ...base, business_key: 'INV-7742' }),
    );
  });

  it('does not collide across field boundaries', () => {
    // Without a separator, ("ab","c") and ("a","bc") would hash identically.
    const left = toolCallIdempotencyKey({ ...base, entity_id: 'AB', sop_id: 'C' });
    const right = toolCallIdempotencyKey({ ...base, entity_id: 'A', sop_id: 'BC' });
    expect(left).not.toBe(right);
  });

  it('inbound dedupe keys are distinct per channel', () => {
    const args = { tenant_id: 'tnt_acme', transport_message_id: 'm1', content_hash: 'h1' };
    expect(inboundDedupeKey({ ...args, channel: 'email' })).not.toBe(
      inboundDedupeKey({ ...args, channel: 'chat' }),
    );
  });
});

describe('contextTokenHash', () => {
  it('is identical for a re-resolution of the same context', () => {
    const axes = {
      jurisdiction: 'MY',
      reporting_framework: 'MFRS',
      legal_entity: 'ENT-0007',
      currency: 'MYR',
      as_of_date: '2026-07-31',
      pack_version: '2026.07.1',
    };
    expect(contextTokenHash(axes)).toBe(contextTokenHash({ ...axes }));
  });

  it('changes when the as-of date moves', () => {
    const axes = {
      jurisdiction: 'MY',
      reporting_framework: 'MFRS',
      legal_entity: 'ENT-0007',
      currency: 'MYR',
      as_of_date: '2026-07-31',
      pack_version: '2026.07.1',
    };
    expect(contextTokenHash(axes)).not.toBe(
      contextTokenHash({ ...axes, as_of_date: '2026-08-31' }),
    );
  });
});

// ---------------------------------------------------------------------------
// Phase 0 acceptance P0-2: "The chain verifies, seals, and an induced tamper
// is detected."
// ---------------------------------------------------------------------------
describe('audit hash chain', () => {
  function buildChain(payloads: readonly Record<string, unknown>[]): ChainLink[] {
    let previous = CHAIN_GENESIS;
    return payloads.map((payload, index) => {
      const event_hash = chainEventHash(previous, payload);
      const link: ChainLink = {
        event_id: `ae_${index}`,
        prev_event_hash: previous,
        event_hash,
        payload,
      };
      previous = event_hash;
      return link;
    });
  }

  const payloads = [
    { event_type: 'request.admitted', outcome: 'success' },
    { event_type: 'context.resolved', outcome: 'success' },
    { event_type: 'tool_call_completed', outcome: 'success' },
  ];

  it('verifies an intact chain', () => {
    const result = verifyChain(buildChain(payloads));
    expect(result.ok).toBe(true);
    expect(result.verified).toBe(3);
  });

  it('detects a payload that was altered after it was written', () => {
    const chain = buildChain(payloads);
    const tampered = chain.map((link, index) =>
      index === 1 ? { ...link, payload: { ...link.payload, outcome: 'failure' } } : link,
    );

    const result = verifyChain(tampered);
    expect(result.ok).toBe(false);
    expect(result.brokenAt?.index).toBe(1);
    expect(result.brokenAt?.reason).toMatch(/event_hash mismatch/);
  });

  it('detects a deleted link', () => {
    const chain = buildChain(payloads);
    const result = verifyChain([chain[0] as ChainLink, chain[2] as ChainLink]);
    expect(result.ok).toBe(false);
    expect(result.brokenAt?.index).toBe(1);
    expect(result.brokenAt?.reason).toMatch(/missing or reordered/);
  });

  it('detects reordering', () => {
    const chain = buildChain(payloads);
    const result = verifyChain([
      chain[1] as ChainLink,
      chain[0] as ChainLink,
      chain[2] as ChainLink,
    ]);
    expect(result.ok).toBe(false);
    expect(result.brokenAt?.index).toBe(0);
  });

  it('detects an appended forgery that does not follow the tip', () => {
    const chain = buildChain(payloads);
    const forged: ChainLink = {
      event_id: 'ae_forged',
      prev_event_hash: CHAIN_GENESIS, // does not follow the real tip
      event_hash: chainEventHash(CHAIN_GENESIS, { event_type: 'forged' }),
      payload: { event_type: 'forged' },
    };
    const result = verifyChain([...chain, forged]);
    expect(result.ok).toBe(false);
    expect(result.brokenAt?.index).toBe(3);
  });

  it('verifies an empty chain', () => {
    expect(verifyChain([])).toEqual({ ok: true, verified: 0 });
  });
});

describe('safeEqual', () => {
  it('matches identical strings', () => {
    expect(safeEqual('abcdef', 'abcdef')).toBe(true);
  });
  it('rejects different strings of equal length', () => {
    expect(safeEqual('abcdef', 'abcdeg')).toBe(false);
  });
  it('rejects different lengths without throwing', () => {
    expect(safeEqual('abc', 'abcdef')).toBe(false);
  });
});
