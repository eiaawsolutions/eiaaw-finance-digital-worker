import { describe, expect, it } from 'vitest';
import {
  MoneyError,
  add,
  allocate,
  compare,
  formatMoney,
  money,
  multiplyByRate,
  parseDecimalString,
  subtract,
  sum,
  toDecimalString,
} from './money.js';

describe('money', () => {
  it('constructs from integer minor units', () => {
    const m = money(123_45, 'MYR', 2);
    expect(m).toEqual({ amount_minor: 12345, currency: 'MYR', scale: 2 });
  });

  it('refuses a fractional minor unit — a float leaked into a monetary path', () => {
    expect(() => money(12.5, 'MYR')).toThrow(MoneyError);
  });

  it('refuses a non-ISO-4217 currency', () => {
    expect(() => money(100, 'ringgit')).toThrow(MoneyError);
    expect(() => money(100, 'my')).toThrow(MoneyError);
  });

  it('refuses cross-currency arithmetic rather than converting implicitly', () => {
    expect(() => add(money(100, 'MYR'), money(100, 'SGD'))).toThrow(/cannot combine MYR with SGD/);
  });

  it('refuses cross-scale arithmetic so the rounding decision stays visible', () => {
    expect(() => add(money(100, 'MYR', 2), money(100, 'MYR', 3))).toThrow(/scale 2 with scale 3/);
  });

  it('adds and subtracts exactly at the minor unit', () => {
    expect(add(money(1999, 'MYR'), money(1, 'MYR')).amount_minor).toBe(2000);
    expect(subtract(money(1000, 'MYR'), money(1, 'MYR')).amount_minor).toBe(999);
  });

  it('sums an empty set to zero in the stated currency', () => {
    expect(sum([], 'MYR')).toEqual({ amount_minor: 0, currency: 'MYR', scale: 2 });
  });

  it('orders by amount', () => {
    expect(compare(money(100, 'MYR'), money(200, 'MYR'))).toBe(-1);
    expect(compare(money(200, 'MYR'), money(100, 'MYR'))).toBe(1);
    expect(compare(money(100, 'MYR'), money(100, 'MYR'))).toBe(0);
  });
});

describe('multiplyByRate', () => {
  it('applies a decimal-string rate exactly', () => {
    // 6% SST on RM 1,000.00 is exactly RM 60.00, not 60.000000000000004.
    expect(multiplyByRate(money(100_000, 'MYR'), '0.06').amount_minor).toBe(6000);
  });

  it('rounds half up by default', () => {
    // 1 minor unit × 0.5 = 0.5 → 1
    expect(multiplyByRate(money(1, 'MYR'), '0.5').amount_minor).toBe(1);
    expect(multiplyByRate(money(1, 'MYR'), '0.4').amount_minor).toBe(0);
  });

  it('supports banker’s rounding when asked', () => {
    expect(multiplyByRate(money(1, 'MYR'), '0.5', 'half_even').amount_minor).toBe(0);
    expect(multiplyByRate(money(3, 'MYR'), '0.5', 'half_even').amount_minor).toBe(2);
  });

  it('rejects a float-shaped or exponent-notation rate', () => {
    expect(() => multiplyByRate(money(100, 'MYR'), '6e-2')).toThrow(MoneyError);
    expect(() => multiplyByRate(money(100, 'MYR'), '')).toThrow(MoneyError);
  });

  it('handles the case IEEE 754 gets wrong', () => {
    // 0.1 + 0.2 !== 0.3 in floating point. In minor units it is exact.
    const total = add(
      multiplyByRate(money(100, 'MYR'), '0.1'),
      multiplyByRate(money(100, 'MYR'), '0.2'),
    );
    expect(total.amount_minor).toBe(30);
  });
});

describe('parseDecimalString', () => {
  it('splits digits and exponent', () => {
    expect(parseDecimalString('12.345')).toEqual({ digits: 12345n, exponent: 3 });
    expect(parseDecimalString('-0.5')).toEqual({ digits: -5n, exponent: 1 });
    expect(parseDecimalString('7')).toEqual({ digits: 7n, exponent: 0 });
  });
});

describe('allocate', () => {
  it('distributes the remainder deterministically and conserves the total', () => {
    const parts = allocate(money(10_00, 'MYR'), 3);
    expect(parts.map((p) => p.amount_minor)).toEqual([334, 333, 333]);
    expect(parts.reduce((acc, p) => acc + p.amount_minor, 0)).toBe(1000);
  });

  it('conserves a negative total', () => {
    const parts = allocate(money(-10_00, 'MYR'), 3);
    expect(parts.reduce((acc, p) => acc + p.amount_minor, 0)).toBe(-1000);
  });

  it('is stable across runs — evidence bundles must reproduce', () => {
    const a = allocate(money(9_99, 'MYR'), 7).map((p) => p.amount_minor);
    const b = allocate(money(9_99, 'MYR'), 7).map((p) => p.amount_minor);
    expect(a).toEqual(b);
  });
});

describe('rendering', () => {
  it('produces an exact decimal string for hashing', () => {
    expect(toDecimalString(money(-1234, 'MYR', 2))).toBe('-12.34');
    expect(toDecimalString(money(5, 'MYR', 2))).toBe('0.05');
    expect(toDecimalString(money(1234, 'JPY', 0))).toBe('1234');
  });

  it('formats for display', () => {
    expect(formatMoney(money(123_45, 'MYR'), 'en-MY')).toContain('123.45');
  });
});
