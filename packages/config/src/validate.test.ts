import { describe, expect, it } from 'vitest';
import type { CatalogueField } from './catalogue.js';
import { validateSettingValue } from './validate.js';

const field = (over: Partial<CatalogueField>): CatalogueField => ({
  field_id: 'AS-TST-001',
  family: 'AS-ORG',
  label: 'Test field',
  purpose: 'exercise the validator',
  value_type: 'string',
  requirement: 'mandatory',
  who_defines: 'Client admin',
  owner_role_ref: 'ROLE-TEST',
  enrolment_stage: 1,
  ...over,
});

const accepts = (f: CatalogueField, v: unknown) => validateSettingValue(f, v).ok;
const reason = (f: CatalogueField, v: unknown) => {
  const r = validateSettingValue(f, v);
  return r.ok ? '' : r.reason;
};

describe('validateSettingValue', () => {
  it('accepts a non-empty string and refuses a blank one', () => {
    const f = field({ value_type: 'string' });
    expect(accepts(f, 'Acme Sdn Bhd')).toBe(true);
    expect(accepts(f, '   ')).toBe(false);
    expect(accepts(f, 42)).toBe(false);
  });

  it('accepts only whole numbers for integer', () => {
    const f = field({ value_type: 'integer' });
    expect(accepts(f, 30)).toBe(true);
    expect(accepts(f, 30.5)).toBe(false);
    expect(accepts(f, '30')).toBe(false);
  });

  /**
   * Finance values must not arrive as floats. 0.1 + 0.2 is the reason: a
   * tolerance or a rate stored as a float is a rounding error waiting for a
   * reconciliation to fail, so decimals travel as strings.
   */
  it('requires a decimal to be a string, not a float', () => {
    const f = field({ value_type: 'decimal' });
    expect(accepts(f, '0.075')).toBe(true);
    expect(accepts(f, 0.075)).toBe(false);
    expect(reason(f, 0.075)).toMatch(/string/i);
    expect(accepts(f, 'seven percent')).toBe(false);
  });

  it('requires money to carry an amount, a currency and a scale', () => {
    const f = field({ value_type: 'money' });
    expect(accepts(f, { amount_minor: 500000, currency: 'MYR', scale: 2 })).toBe(true);
    expect(accepts(f, { amount_minor: 500000, currency: 'MYR' })).toBe(false);
    expect(accepts(f, { amount_minor: 5000.5, currency: 'MYR', scale: 2 })).toBe(false);
    // A bare number cannot say which currency it is in.
    expect(accepts(f, 500000)).toBe(false);
    expect(accepts(f, { amount_minor: 500000, currency: 'ringgit', scale: 2 })).toBe(false);
  });

  it('accepts booleans only as booleans', () => {
    const f = field({ value_type: 'boolean' });
    expect(accepts(f, false)).toBe(true);
    expect(accepts(f, 'true')).toBe(false);
  });

  it('requires an ISO date for date', () => {
    const f = field({ value_type: 'date' });
    expect(accepts(f, '2026-01-01')).toBe(true);
    expect(accepts(f, '01/01/2026')).toBe(false);
    expect(accepts(f, '2026-13-01')).toBe(false);
  });

  it('restricts an enum to its declared values and says which they are', () => {
    const f = field({ value_type: 'enum', enum_values: ['MFRS', 'IFRS'] });
    expect(accepts(f, 'MFRS')).toBe(true);
    expect(accepts(f, 'GAAP')).toBe(false);
    expect(reason(f, 'GAAP')).toContain('MFRS');
  });

  it('refuses an enum field whose catalogue entry declares no values', () => {
    const f = field({ value_type: 'enum' });
    expect(accepts(f, 'anything')).toBe(false);
  });

  it('accepts a non-empty list and refuses an empty one', () => {
    const f = field({ value_type: 'list' });
    expect(accepts(f, ['ENT-01', 'ENT-02'])).toBe(true);
    // An empty list reads as "answered" while meaning "none", which for a
    // mandatory field is the gap the health endpoint exists to surface.
    expect(accepts(f, [])).toBe(false);
    expect(accepts(f, 'ENT-01')).toBe(false);
  });

  it('accepts an object for json and refuses a bare scalar', () => {
    const f = field({ value_type: 'json' });
    expect(accepts(f, { threshold: 1000 })).toBe(true);
    expect(accepts(f, 'nope')).toBe(false);
    expect(accepts(f, null)).toBe(false);
  });

  it('accepts a reference as a non-empty string', () => {
    const f = field({ value_type: 'reference' });
    expect(accepts(f, 'ROLE-CFO')).toBe(true);
    expect(accepts(f, '')).toBe(false);
  });

  /**
   * Null is how a field is cleared, and clearing is what `is_tbc` is for. The
   * table constraint enforces the same thing; catching it here names the field.
   */
  it('refuses null and undefined for every type', () => {
    for (const t of ['string', 'integer', 'boolean', 'json', 'list'] as const) {
      expect(accepts(field({ value_type: t }), null)).toBe(false);
      expect(accepts(field({ value_type: t }), undefined)).toBe(false);
    }
  });

  it('names the field and its purpose when it refuses', () => {
    const f = field({
      value_type: 'integer',
      field_id: 'AS-REC-004',
      purpose: 'set how many days a reconciliation may remain open',
    });
    const r = reason(f, 'thirty');
    expect(r).toContain('AS-REC-004');
    expect(r).toContain('reconciliation may remain open');
  });
});
