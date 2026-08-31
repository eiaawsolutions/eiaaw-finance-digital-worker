import { describe, expect, it } from 'vitest';
import {
  DATA_CLASSES,
  canRender,
  canRenderPayload,
  classifyPayload,
  exceedsCeiling,
  lowestCeiling,
  tierOf,
} from './sensitivity.js';

describe('data class register (file 07 s.3.2)', () => {
  it('carries all 22 classes', () => {
    expect(Object.keys(DATA_CLASSES)).toHaveLength(22);
  });

  it('treats an unknown class as Restricted — the default fails closed', () => {
    expect(tierOf('D99')).toBe('restricted');
    expect(tierOf(undefined)).toBe('restricted');
  });
});

describe('channel permission matrix (file 07 s.3.3)', () => {
  it('lets public guidance reach every channel', () => {
    for (const channel of ['email', 'chat', 'telegram', 'whatsapp'] as const) {
      expect(canRender('D02', channel).allowed).toBe(true);
    }
  });

  it('keeps counterparty identity off the consumer channels', () => {
    expect(canRender('D06', 'email').allowed).toBe(true);
    expect(canRender('D06', 'chat').allowed).toBe(true);
    expect(canRender('D06', 'telegram').allowed).toBe(false);
    expect(canRender('D06', 'whatsapp').allowed).toBe(false);
  });

  it('keeps ledger detail off Telegram and WhatsApp', () => {
    expect(canRender('D08', 'telegram').allowed).toBe(false);
    expect(canRender('D08', 'whatsapp').allowed).toBe(false);
  });

  it('allows process status onto WhatsApp only as a pointer', () => {
    const decision = canRender('D03', 'whatsapp');
    expect(decision.allowed).toBe(true);
    expect(decision.mode).toBe('pointer_only');
  });

  it('never emits secrets on any channel', () => {
    for (const channel of ['email', 'chat', 'telegram', 'whatsapp'] as const) {
      const decision = canRender('D18', channel);
      expect(decision.allowed).toBe(false);
      expect(decision.mode).toBe('never');
    }
  });

  it('masks bank and settlement data even in the console', () => {
    expect(canRender('D15', 'chat').mode).toBe('masked');
    expect(canRender('D15', 'email').allowed).toBe(false);
  });

  it('makes price-sensitive material conditional on the named AS- controls', () => {
    const decision = canRender('D13', 'email');
    expect(decision.allowed).toBe(true);
    expect(decision.mode).toBe('conditional');
    expect(decision.conditions).toEqual(['AS-SYS-105', 'AS-SYS-106', 'AS-SYS-097']);
  });

  it('requires step-up for individual payroll in the console', () => {
    expect(canRender('D16', 'chat').mode).toBe('step_up');
    expect(canRender('D16', 'email').allowed).toBe(false);
  });

  it('denies an unknown class everywhere', () => {
    const decision = canRender('D99', 'chat');
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toMatch(/not in the register/);
  });
});

describe('evidence bundles (D21)', () => {
  it('may be carried by email and the console', () => {
    expect(canRender('D21', 'email').allowed).toBe(true);
    expect(canRender('D21', 'chat').allowed).toBe(true);
  });

  it('is refused on Telegram and WhatsApp — a bundle is never summarised to fit', () => {
    expect(canRender('D21', 'telegram').allowed).toBe(false);
    expect(canRender('D21', 'whatsapp').allowed).toBe(false);
  });
});

describe('composite payloads', () => {
  it('takes the highest tier of its parts', () => {
    expect(classifyPayload(['D02', 'D07', 'D16']).tier).toBe('restricted');
    expect(classifyPayload(['D02', 'D03']).tier).toBe('internal');
    expect(classifyPayload([]).tier).toBe('public');
  });

  it('blocks a whole payload when any single class is blocked', () => {
    const decision = canRenderPayload(['D02', 'D08'], 'telegram');
    expect(decision.allowed).toBe(false);
    expect(decision.blockedBy.map((b) => b.classId)).toEqual(['D08']);
  });

  it('accumulates the conditions of every conditional class', () => {
    const decision = canRenderPayload(['D13', 'D14'], 'email');
    expect(decision.allowed).toBe(true);
    expect(decision.conditions).toEqual(['AS-SYS-105', 'AS-SYS-106', 'AS-SYS-097']);
  });
});

describe('ceilings', () => {
  it('a conversation ceiling is the lowest of the channels it has been seen on', () => {
    expect(lowestCeiling(['confidential', 'internal'])).toBe('internal');
    expect(lowestCeiling(['restricted'])).toBe('restricted');
    expect(lowestCeiling([])).toBe('public');
  });

  it('detects a tier above a ceiling', () => {
    expect(exceedsCeiling('restricted', 'confidential')).toBe(true);
    expect(exceedsCeiling('internal', 'confidential')).toBe(false);
    expect(exceedsCeiling('confidential', 'confidential')).toBe(false);
  });
});
