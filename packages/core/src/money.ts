/**
 * Money — DWD-06 s.2.2.
 *
 *   "Money is an object { amount_minor: integer, currency: "MYR", scale: 2 }.
 *    Never a float, never a formatted string."
 *
 * This is a gate requirement, not a preference (DWD-06 s.2.2, L8 note): the
 * arithmetic gate in the assurance harness cannot certify floating-point
 * currency, so no float ever represents a monetary value anywhere in the system.
 *
 * All arithmetic here is on `bigint`. `number` appears only at the JSON
 * boundary, where `amount_minor` must stay within Number.MAX_SAFE_INTEGER —
 * which `assertSafeMinor` enforces on every construction.
 */

export interface Money {
  readonly amount_minor: number;
  readonly currency: string;
  readonly scale: number;
}

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MoneyError';
  }
}

const CURRENCY_PATTERN = /^[A-Z]{3}$/; // ISO 4217
const MAX_SCALE = 6;

function assertSafeMinor(value: bigint, context: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(-Number.MAX_SAFE_INTEGER)) {
    throw new MoneyError(
      `${context}: amount_minor ${value.toString()} exceeds the safe integer range. ` +
        'A value this large indicates a units error (minor vs major), not a genuine amount.',
    );
  }
  return Number(value);
}

export function money(amountMinor: number | bigint, currency: string, scale = 2): Money {
  if (!CURRENCY_PATTERN.test(currency)) {
    throw new MoneyError(`Currency must be an ISO 4217 alphabetic code, received "${currency}".`);
  }
  if (!Number.isInteger(scale) || scale < 0 || scale > MAX_SCALE) {
    throw new MoneyError(`Scale must be an integer between 0 and ${MAX_SCALE}, received ${scale}.`);
  }
  // Checked before the BigInt conversion, which would otherwise throw a bare
  // RangeError and lose the explanation of *why* a fraction is rejected.
  if (typeof amountMinor === 'number' && !Number.isInteger(amountMinor)) {
    throw new MoneyError(
      `amount_minor must be an integer number of minor units, received ${amountMinor}. ` +
        'A fractional minor unit means a float leaked into a monetary path.',
    );
  }
  const asBig = typeof amountMinor === 'bigint' ? amountMinor : BigInt(amountMinor);
  return Object.freeze({
    amount_minor: assertSafeMinor(asBig, 'money()'),
    currency,
    scale,
  });
}

export function isMoney(value: unknown): value is Money {
  if (typeof value !== 'object' || value === null) return false;
  const m = value as Record<string, unknown>;
  return (
    typeof m['amount_minor'] === 'number' &&
    Number.isInteger(m['amount_minor']) &&
    typeof m['currency'] === 'string' &&
    typeof m['scale'] === 'number'
  );
}

function assertCompatible(a: Money, b: Money, operation: string): void {
  if (a.currency !== b.currency) {
    throw new MoneyError(
      `${operation}: cannot combine ${a.currency} with ${b.currency}. ` +
        'Cross-currency arithmetic requires an explicit, dated conversion, never an implicit one.',
    );
  }
  if (a.scale !== b.scale) {
    throw new MoneyError(
      `${operation}: cannot combine ${a.currency} at scale ${a.scale} with scale ${b.scale}. ` +
        'Rescale explicitly so the rounding decision is visible.',
    );
  }
}

export function add(a: Money, b: Money): Money {
  assertCompatible(a, b, 'add');
  return money(BigInt(a.amount_minor) + BigInt(b.amount_minor), a.currency, a.scale);
}

export function subtract(a: Money, b: Money): Money {
  assertCompatible(a, b, 'subtract');
  return money(BigInt(a.amount_minor) - BigInt(b.amount_minor), a.currency, a.scale);
}

export function sum(values: readonly Money[], currency: string, scale = 2): Money {
  return values.reduce<Money>((acc, next) => add(acc, next), money(0, currency, scale));
}

export function negate(a: Money): Money {
  return money(-BigInt(a.amount_minor), a.currency, a.scale);
}

export function absolute(a: Money): Money {
  const v = BigInt(a.amount_minor);
  return money(v < 0n ? -v : v, a.currency, a.scale);
}

export function compare(a: Money, b: Money): -1 | 0 | 1 {
  assertCompatible(a, b, 'compare');
  if (a.amount_minor < b.amount_minor) return -1;
  if (a.amount_minor > b.amount_minor) return 1;
  return 0;
}

export const equals = (a: Money, b: Money): boolean => compare(a, b) === 0;
export const lessThan = (a: Money, b: Money): boolean => compare(a, b) === -1;
export const lessThanOrEqual = (a: Money, b: Money): boolean => compare(a, b) <= 0;
export const greaterThan = (a: Money, b: Money): boolean => compare(a, b) === 1;
export const greaterThanOrEqual = (a: Money, b: Money): boolean => compare(a, b) >= 0;
export const isZero = (a: Money): boolean => a.amount_minor === 0;
export const isNegative = (a: Money): boolean => a.amount_minor < 0;

export type RoundingMode = 'half_up' | 'half_even' | 'down' | 'up';

/**
 * Multiply by a rate expressed as a decimal *string*.
 *
 * DWD-06 s.2.2: "Rates and ratios: decimal string with explicit precision,
 * never a float." A tax rate of 0.06 is `"0.06"`, not `0.06` — because the
 * latter is not exactly six percent in IEEE 754 and the arithmetic gate will
 * eventually notice.
 */
export function multiplyByRate(
  value: Money,
  rate: string,
  rounding: RoundingMode = 'half_up',
): Money {
  const parsed = parseDecimalString(rate);
  const scaled = BigInt(value.amount_minor) * parsed.digits;
  const divisor = 10n ** BigInt(parsed.exponent);
  return money(divideRounded(scaled, divisor, rounding), value.currency, value.scale);
}

/** Split an amount into `parts` shares, distributing the remainder deterministically. */
export function allocate(value: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts <= 0) {
    throw new MoneyError(`allocate: parts must be a positive integer, received ${parts}.`);
  }
  const total = BigInt(value.amount_minor);
  const partsBig = BigInt(parts);
  const base = total / partsBig;
  // Remainder is distributed one minor unit at a time from the first share, so
  // the result is stable across runs — a requirement for reproducible evidence.
  let remainder = total - base * partsBig;
  const step = remainder < 0n ? -1n : 1n;
  if (remainder < 0n) remainder = -remainder;

  return Array.from({ length: parts }, (_unused, index) => {
    const extra = BigInt(index) < remainder ? step : 0n;
    return money(base + extra, value.currency, value.scale);
  });
}

interface ParsedDecimal {
  readonly digits: bigint;
  readonly exponent: number;
}

/** Parse `"-12.3450"` into `{ digits: -123450n, exponent: 4 }`. */
export function parseDecimalString(input: string): ParsedDecimal {
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(input.trim());
  if (!match) {
    throw new MoneyError(
      `Rate must be a plain decimal string such as "0.06" or "-1.5", received "${input}". ` +
        'Exponent notation and floats are rejected so precision stays explicit.',
    );
  }
  const [, sign, whole = '0', fraction = ''] = match;
  const digits = BigInt(`${sign === '-' ? '-' : ''}${whole}${fraction}`);
  return { digits, exponent: fraction.length };
}

function divideRounded(numerator: bigint, denominator: bigint, mode: RoundingMode): bigint {
  if (denominator === 0n) throw new MoneyError('Division by zero in monetary arithmetic.');

  const negative = numerator < 0n !== denominator < 0n;
  const absNumerator = numerator < 0n ? -numerator : numerator;
  const absDenominator = denominator < 0n ? -denominator : denominator;

  const quotient = absNumerator / absDenominator;
  const remainder = absNumerator % absDenominator;
  if (remainder === 0n) return negative ? -quotient : quotient;

  const twice = remainder * 2n;
  let rounded: bigint;
  switch (mode) {
    case 'down':
      rounded = quotient;
      break;
    case 'up':
      rounded = quotient + 1n;
      break;
    case 'half_even':
      if (twice > absDenominator) rounded = quotient + 1n;
      else if (twice < absDenominator) rounded = quotient;
      else rounded = quotient % 2n === 0n ? quotient : quotient + 1n;
      break;
    case 'half_up':
    default:
      rounded = twice >= absDenominator ? quotient + 1n : quotient;
      break;
  }
  return negative ? -rounded : rounded;
}

/**
 * Render for display only. Never parse this back — the canonical form is the
 * object, and a formatted string crossing a component boundary is a defect
 * (DWD-06 s.2.2, red flags).
 */
export function formatMoney(value: Money, locale = 'en-MY'): string {
  const divisor = 10 ** value.scale;
  const major = value.amount_minor / divisor;
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: value.currency,
    minimumFractionDigits: value.scale,
    maximumFractionDigits: value.scale,
  }).format(major);
}

/** Exact decimal string, e.g. `-1234` at scale 2 → `"-12.34"`. For hashing and evidence. */
export function toDecimalString(value: Money): string {
  const negative = value.amount_minor < 0;
  const digits = Math.abs(value.amount_minor)
    .toString()
    .padStart(value.scale + 1, '0');
  const cut = digits.length - value.scale;
  const whole = digits.slice(0, cut);
  const fraction = digits.slice(cut);
  const body = value.scale === 0 ? whole : `${whole}.${fraction}`;
  return negative ? `-${body}` : body;
}
