import { describe, expect, it } from 'vitest';
import { COMPONENTS, LAYERS } from '@eiaaw/contracts';
import {
  FORBIDDEN_SPAN_ATTRIBUTES,
  REQUIRED_SPAN_ATTRIBUTES,
  SPAN_NAMES,
  SPAN_TAXONOMY,
  SpanConformanceError,
  assertSpanConformance,
  checkSpanConformance,
  isKnownSpanName,
} from './spans.js';

const conformantAttributes = {
  tenant_id: 'tnt_acme',
  trace_id: '4bf92f3577b34da6a3ce929d0e0e4736',
  layer: 'L6',
  component: 'C10',
  environment: 'test',
  platform_version: '0.1.0',
  residency_zone: 'my-central',
};

describe('span taxonomy (DWD-06 s.12.2)', () => {
  it('declares the eighteen spans the spec names', () => {
    expect(SPAN_NAMES).toHaveLength(18);
  });

  it.each(SPAN_NAMES)('%s declares a valid layer and component', (name) => {
    const definition = SPAN_TAXONOMY[name];
    expect(LAYERS).toContain(definition.layer);
    expect(COMPONENTS).toContain(definition.component);
  });

  it.each(SPAN_NAMES)('%s declares a parent that exists in the taxonomy', (name) => {
    const parent = SPAN_TAXONOMY[name].parent;
    if (parent !== null) expect(SPAN_NAMES).toContain(parent);
  });

  it('places llm.call under skill.invoke — D2 made visible in the trace', () => {
    expect(SPAN_TAXONOMY['llm.call'].parent).toBe('skill.invoke');
    expect(SPAN_TAXONOMY['llm.call'].component).toBe('C9');
  });

  it('places tool.invoke under node.execute, never under skill.invoke', () => {
    // D1/D5: the executor calls the tool invoker; a skill never does.
    expect(SPAN_TAXONOMY['tool.invoke'].parent).toBe('node.execute');
  });

  it('recognises known names and rejects invented ones', () => {
    expect(isKnownSpanName('policy.evaluate')).toBe(true);
    expect(isKnownSpanName('something.custom')).toBe(false);
  });
});

describe('required attributes (DWD-06 s.12.3)', () => {
  it('passes a conformant span', () => {
    expect(checkSpanConformance('tool.invoke', conformantAttributes)).toBeNull();
  });

  it.each(REQUIRED_SPAN_ATTRIBUTES)('fails a span missing %s', (attribute) => {
    const attributes = { ...conformantAttributes, [attribute]: undefined };
    const violation = checkSpanConformance('tool.invoke', attributes);
    expect(violation).not.toBeNull();
    expect(violation?.missing).toContain(attribute);
  });

  it('treats an empty string as missing — a blank tenant is not a tenant', () => {
    const violation = checkSpanConformance('tool.invoke', {
      ...conformantAttributes,
      tenant_id: '',
    });
    expect(violation?.missing).toContain('tenant_id');
  });

  it('reports every missing attribute at once', () => {
    const violation = checkSpanConformance('tool.invoke', { tenant_id: 'tnt_acme' });
    expect(violation?.missing).toHaveLength(REQUIRED_SPAN_ATTRIBUTES.length - 1);
  });
});

describe('forbidden attributes (DWD-06 s.12, red flags)', () => {
  it.each(FORBIDDEN_SPAN_ATTRIBUTES)('rejects a span carrying %s', (attribute) => {
    const violation = checkSpanConformance('llm.call', {
      ...conformantAttributes,
      [attribute]: 'anything at all',
    });
    expect(violation).not.toBeNull();
    expect(violation?.forbidden).toContain(attribute);
  });

  it('names model reasoning explicitly in the error', () => {
    expect(() =>
      assertSpanConformance('llm.call', { ...conformantAttributes, reasoning: '...' }, true),
    ).toThrow(/model reasoning text and secrets never enter a span/);
  });
});

describe('assertSpanConformance', () => {
  it('throws in strict mode so the defect surfaces at authoring time', () => {
    expect(() => assertSpanConformance('tool.invoke', {}, true)).toThrow(SpanConformanceError);
  });

  it('returns the violation in non-strict mode so prod traffic is not dropped', () => {
    const violation = assertSpanConformance('tool.invoke', {}, false);
    expect(violation).not.toBeNull();
    expect(violation?.span).toBe('tool.invoke');
  });

  it('returns null when conformant', () => {
    expect(assertSpanConformance('tool.invoke', conformantAttributes, true)).toBeNull();
  });
});
