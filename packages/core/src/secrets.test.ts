import { afterEach, describe, expect, it } from 'vitest';
import {
  EnvSecretProvider,
  SecretRef,
  SecretResolver,
  clearRedactionRegistry,
  isSecretHandle,
  parseSecretHandle,
  redact,
  redactDeep,
  registerForRedaction,
} from './secrets.js';

afterEach(() => clearRedactionRegistry());

describe('secret handles', () => {
  it('recognises the contract form', () => {
    expect(isSecretHandle('secret://eiaaw-fdw/prod/llm/ANTHROPIC_API_KEY')).toBe(true);
    expect(isSecretHandle('secret://eiaaw-fdw/prod/a/b/c/SOME_KEY')).toBe(true);
  });

  it('rejects anything that is not a handle', () => {
    expect(isSecretHandle('sk-ant-not-a-handle')).toBe(false);
    expect(isSecretHandle('secret://missing-name/')).toBe(false);
    expect(isSecretHandle('')).toBe(false);
  });

  it('parses project, environment, path and name', () => {
    const handle = parseSecretHandle('secret://eiaaw-fdw/prod/llm/ANTHROPIC_API_KEY');
    expect(handle).toMatchObject({
      project: 'eiaaw-fdw',
      environment: 'prod',
      path: '/llm',
      name: 'ANTHROPIC_API_KEY',
    });
  });

  it('explains the required form when given a raw value', () => {
    expect(() => parseSecretHandle('sk-ant-abc')).toThrow(/not a valid secret handle/);
  });

  /**
   * The EIAAW house convention keeps every secret flat at the root of a shared
   * workspace rather than in per-domain folders, so the path segment is
   * optional and its absence means the root.
   */
  it('accepts the flat house form with no path segment', () => {
    expect(isSecretHandle('secret://eiaaw-all-projects/prod/ANTHROPIC_API_KEY')).toBe(true);
  });

  it('reads a pathless handle as the workspace root', () => {
    const handle = parseSecretHandle('secret://eiaaw-all-projects/prod/ANTHROPIC_API_KEY');
    expect(handle).toMatchObject({
      project: 'eiaaw-all-projects',
      environment: 'prod',
      path: '/',
      name: 'ANTHROPIC_API_KEY',
    });
  });

  /**
   * A nested path must still win over reading the last-but-one segment as part
   * of the name — otherwise adopting the flat form would silently re-point
   * every existing foldered handle at the root.
   */
  it('still prefers an explicit path when one is present', () => {
    expect(parseSecretHandle('secret://p/prod/crypto/KMS_MASTER_KEY')).toMatchObject({
      path: '/crypto',
      name: 'KMS_MASTER_KEY',
    });
    expect(parseSecretHandle('secret://p/prod/a/b/c/SOME_KEY')).toMatchObject({
      path: '/a/b/c',
      name: 'SOME_KEY',
    });
  });

  it('still rejects a handle with no name at all', () => {
    expect(isSecretHandle('secret://eiaaw-all-projects/prod/')).toBe(false);
    expect(isSecretHandle('secret://eiaaw-all-projects/prod')).toBe(false);
  });
});

describe('SecretRef', () => {
  const ref = new SecretRef('ANTHROPIC_API_KEY', 'sk-ant-super-secret-value');

  it('exposes the value only through expose()', () => {
    expect(ref.expose()).toBe('sk-ant-super-secret-value');
  });

  it('does not leak through string interpolation', () => {
    // Interpolating a SecretRef is exactly what this asserts is safe — the
    // lint rule that forbids it elsewhere is the reason the guarantee holds.
    // eslint-disable-next-line @typescript-eslint/restrict-template-expressions
    expect(`${ref}`).toBe('[secret:ANTHROPIC_API_KEY]');
  });

  it('does not leak through JSON.stringify', () => {
    expect(JSON.stringify({ key: ref })).toBe('{"key":"[secret:ANTHROPIC_API_KEY]"}');
  });

  it('does not expose the value as an enumerable property', () => {
    expect(Object.values(ref)).not.toContain('sk-ant-super-secret-value');
    expect(JSON.stringify(Object.entries(ref))).not.toContain('super-secret');
  });
});

// ---------------------------------------------------------------------------
// Phase 0 acceptance P0-7: "No secret is reachable from prompt construction;
// the canary never appears."
// ---------------------------------------------------------------------------
describe('redaction (P0-7 canary sweep)', () => {
  const CANARY = 'EIAAW-CANARY-3f8b2d91c4a7';

  it('scrubs a registered value from a string', () => {
    registerForRedaction(CANARY);
    expect(redact(`the value is ${CANARY} here`)).toBe('the value is [REDACTED] here');
  });

  it('scrubs every occurrence', () => {
    registerForRedaction(CANARY);
    expect(redact(`${CANARY} and ${CANARY}`)).toBe('[REDACTED] and [REDACTED]');
  });

  it('leaves unrelated text untouched', () => {
    registerForRedaction(CANARY);
    expect(redact('nothing sensitive here')).toBe('nothing sensitive here');
  });

  it('does not register values too short to be a secret', () => {
    registerForRedaction('abc');
    expect(redact('abc')).toBe('abc');
  });

  it('scrubs recursively through an object graph before it is logged', () => {
    registerForRedaction(CANARY);
    const payload = {
      prompt: `system: ${CANARY}`,
      nested: { list: [`${CANARY}`, 'clean'] },
      ref: new SecretRef('X', 'another-secret-value'),
      count: 3,
    };
    const scrubbed = redactDeep(payload);
    expect(JSON.stringify(scrubbed)).not.toContain(CANARY);
    expect(JSON.stringify(scrubbed)).not.toContain('another-secret-value');
    expect(scrubbed.count).toBe(3);
    expect(scrubbed.nested.list[1]).toBe('clean');
  });

  it('registers a value automatically when the resolver resolves it', async () => {
    const provider = new EnvSecretProvider({ ANTHROPIC_API_KEY: CANARY });
    const resolver = new SecretResolver(provider);
    await resolver.resolve('secret://eiaaw-fdw/dev/llm/ANTHROPIC_API_KEY');
    expect(redact(`prompt contains ${CANARY}`)).toBe('prompt contains [REDACTED]');
  });
});

describe('EnvSecretProvider', () => {
  it('refuses to start in a prod deployment', () => {
    expect(() => new EnvSecretProvider({ DEPLOY_ENVIRONMENT: 'prod' })).toThrow(
      /refusing to start in a prod deployment/,
    );
  });

  it('fails closed on an absent secret rather than returning empty', async () => {
    const resolver = new SecretResolver(new EnvSecretProvider({}));
    await expect(resolver.resolve('secret://eiaaw-fdw/dev/llm/MISSING_KEY')).rejects.toThrow(
      /is not set/,
    );
  });

  it('caches so a handle resolves once', async () => {
    let calls = 0;
    const resolver = new SecretResolver({
      // eslint-disable-next-line @typescript-eslint/require-await
      resolve: async () => {
        calls += 1;
        return 'a-resolved-secret-value';
      },
    });
    await resolver.resolve('secret://p/dev/path/KEY');
    await resolver.resolve('secret://p/dev/path/KEY');
    expect(calls).toBe(1);
  });
});
