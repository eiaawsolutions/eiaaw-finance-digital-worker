import { afterEach, describe, expect, it } from 'vitest';
import { clearRedactionRegistry, registerForRedaction } from '@eiaaw/core';
import { createLogger, nullLogger, pseudonymise } from './logger.js';

afterEach(() => clearRedactionRegistry());

/** Capture what pino actually writes, rather than what we hope it writes. */
function captureLog(fn: (log: ReturnType<typeof createLogger>) => void): string {
  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  // pino writes to fd 1 by default; intercept rather than mock the module so
  // the test exercises the real serialiser and the real redaction config.
  (process.stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
    written.push(chunk);
    return true;
  };
  try {
    fn(createLogger({ level: 'debug', serviceName: 'test', environment: 'test' }));
  } finally {
    (process.stdout as unknown as { write: typeof original }).write = original;
  }
  return written.join('');
}

describe('pseudonymise', () => {
  it('keeps within-session correlation without identity', () => {
    expect(pseudonymise('usr_00417')).toBe('p:0417');
    expect(pseudonymise('usr_00417')).toBe(pseudonymise('usr_00417'));
    expect(pseudonymise('usr_00417')).not.toBe(pseudonymise('usr_00092'));
  });

  it('handles absence', () => {
    expect(pseudonymise(null)).toBe('anon');
    expect(pseudonymise(undefined)).toBe('anon');
  });
});

// file 07 s.5.2: the operational log is aggressively pseudonymised. The audit
// log is where a human is named, and that is a different store.
describe('operational log discipline', () => {
  it('pseudonymises a principal id', () => {
    const output = captureLog((log) => {
      log.info('handoff issued', { tenant_id: 'tnt_acme', principal_id: 'usr_00417' });
    });
    expect(output).not.toContain('usr_00417');
    expect(output).toContain('p:0417');
  });

  it('withholds model reasoning text', () => {
    const output = captureLog((log) => {
      log.info('skill completed', {
        tenant_id: 'tnt_acme',
        reasoning: 'Step 1: the taxpayer is...',
        completion: 'the answer is 42',
      });
    });
    expect(output).not.toContain('the taxpayer is');
    expect(output).not.toContain('the answer is 42');
    expect(output).toContain('[WITHHELD]');
  });

  it('withholds forbidden fields nested inside a payload', () => {
    const output = captureLog((log) => {
      log.info('gateway call', {
        tenant_id: 'tnt_acme',
        route: { id: 'rt-tax-draft', system_prompt: 'You are a finance expert...' },
      });
    });
    expect(output).not.toContain('You are a finance expert');
  });

  it('sweeps registered secret values out of message and fields', () => {
    registerForRedaction('EIAAW-CANARY-3f8b2d91c4a7');
    const output = captureLog((log) => {
      log.error('connector auth failed with EIAAW-CANARY-3f8b2d91c4a7', {
        tenant_id: 'tnt_acme',
        detail: 'token was EIAAW-CANARY-3f8b2d91c4a7',
      });
    });
    expect(output).not.toContain('EIAAW-CANARY-3f8b2d91c4a7');
    expect(output).toContain('[REDACTED]');
  });

  it('keeps the fields an engineer actually needs', () => {
    const output = captureLog((log) => {
      log.warn('node retried', {
        tenant_id: 'tnt_acme',
        graph_id: 'tg_0192',
        node_id: 'n4',
        component: 'C7',
      });
    });
    expect(output).toContain('tnt_acme');
    expect(output).toContain('tg_0192');
    expect(output).toContain('n4');
  });

  it('scrubs fields on a child logger too', () => {
    const output = captureLog((log) => {
      log.child({ principal_id: 'usr_00417' }).info('acted');
    });
    expect(output).not.toContain('usr_00417');
  });
});

describe('nullLogger', () => {
  it('emits nothing and still supports child()', () => {
    expect(() => {
      nullLogger.info('nothing');
      nullLogger.child({ tenant_id: 'tnt_acme' }).error('also nothing');
    }).not.toThrow();
  });
});
