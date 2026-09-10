/**
 * Value validation for the AS- catalogue.
 *
 * Separated from the write path so it is a pure function over a field and a
 * value: enrolment is where a typo becomes a governance failure six months
 * later, and this is the cheapest place to catch one.
 *
 * The refusal text follows DWD-06 s.13.3 — it names the field, what the field
 * is for in business terms, and what was expected. An enrolment refusal that
 * says "invalid value" makes the operator go and find the catalogue; one that
 * says what the field decides lets them answer it.
 */
import type { CatalogueField } from './catalogue.js';

export type ValidationResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: string };

const ok: ValidationResult = { ok: true };

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ISO_CURRENCY = /^[A-Z]{3}$/;
/** Optionally signed, digits, optional fractional part. No exponent. */
const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A real calendar date, not merely the right shape — 2026-13-01 is neither. */
function isCalendarDate(value: string): boolean {
  if (!ISO_DATE.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function expectation(field: CatalogueField): string {
  switch (field.value_type) {
    case 'string':
      return 'a non-empty string';
    case 'integer':
      return 'a whole number';
    case 'decimal':
      return 'a decimal as a string, e.g. "0.075" — decimals travel as strings so a rate or a tolerance never picks up a floating-point rounding error';
    case 'money':
      return 'an object of the form { amount_minor: <whole number>, currency: "MYR", scale: 2 } — an amount without a currency cannot be compared or converted';
    case 'boolean':
      return 'true or false';
    case 'date':
      return 'a calendar date as YYYY-MM-DD';
    case 'enum':
      return field.enum_values?.length
        ? `one of: ${field.enum_values.join(', ')}`
        : 'a value from a declared enumeration — but this field declares none, which is a catalogue defect, not an entry error';
    case 'reference':
      return 'a non-empty identifier referring to another registered record';
    case 'list':
      return 'a non-empty array — an empty list reads as answered while meaning nothing was chosen, which is the gap enrolment health exists to show';
    case 'json':
      return 'a JSON object';
  }
}

function matches(field: CatalogueField, value: unknown): boolean {
  switch (field.value_type) {
    case 'string':
    case 'reference':
      return typeof value === 'string' && value.trim().length > 0;
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    case 'decimal':
      return typeof value === 'string' && DECIMAL_STRING.test(value);
    case 'money':
      return (
        isPlainObject(value) &&
        typeof value['amount_minor'] === 'number' &&
        Number.isInteger(value['amount_minor']) &&
        typeof value['currency'] === 'string' &&
        ISO_CURRENCY.test(value['currency']) &&
        typeof value['scale'] === 'number' &&
        Number.isInteger(value['scale']) &&
        value['scale'] >= 0
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      return typeof value === 'string' && isCalendarDate(value);
    case 'enum':
      return (
        typeof value === 'string' &&
        (field.enum_values?.length ?? 0) > 0 &&
        (field.enum_values as readonly string[]).includes(value)
      );
    case 'list':
      return Array.isArray(value) && value.length > 0;
    case 'json':
      return isPlainObject(value);
  }
}

/**
 * Check one value against its catalogue field.
 *
 * Absence is not validated here — a field with no answer yet is `is_tbc`, which
 * carries no value at all. Null reaching this function means a value was
 * offered and is unusable, which is a different thing from not having answered.
 */
export function validateSettingValue(field: CatalogueField, value: unknown): ValidationResult {
  if (value === null || value === undefined) {
    return {
      ok: false,
      reason:
        `${field.field_id} ("${field.label}") was given no value. The field exists to ` +
        `${field.purpose}. To record that it is not yet decided, mark it TBC — that is ` +
        'visible in enrolment health, whereas an empty value is not.',
    };
  }

  if (matches(field, value)) return ok;

  return {
    ok: false,
    reason:
      `${field.field_id} ("${field.label}") expects ${expectation(field)}. The field exists ` +
      `to ${field.purpose}, and a value of the wrong shape would be read by the runtime as ` +
      'though it were correct.',
  };
}
