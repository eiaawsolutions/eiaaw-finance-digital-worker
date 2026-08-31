/**
 * Class N — calculation and spreadsheet. file 05 s.10.15.
 *
 * These are NOT stubs. They are local compute with no credential, no network
 * and no state, and they are the tools the arithmetic gate depends on:
 * `TL-CALC-05 arithmetic.verify` is the independent recomputation that certifies
 * a figure, so it must never share code with whatever produced that figure.
 *
 * Everything here is integer minor units. s.2.2: the arithmetic gate cannot
 * certify floating-point currency, so no function in this file accepts a float.
 */
import {
  type Money,
  WorkerError,
  add,
  asText,
  compare,
  firstText,
  money,
  multiplyByRate,
  subtract,
  sum,
  toDecimalString,
} from '@eiaaw/core';
import type { Connector, ConnectorInvocation, ConnectorResult } from '../invoker.js';

interface MoneyLike {
  amount_minor: number;
  currency: string;
  scale?: number;
}

const toMoney = (value: MoneyLike): Money =>
  money(value.amount_minor, value.currency, value.scale ?? 2);

export class CalculationConnector implements Connector {
  readonly id = 'calc';
  readonly version = '1.0.0';
  readonly tools = ['TL-CALC-01', 'TL-CALC-02', 'TL-CALC-03', 'TL-CALC-04', 'TL-CALC-05'];

  // eslint-disable-next-line @typescript-eslint/require-await
  async invoke(input: ConnectorInvocation): Promise<ConnectorResult> {
    switch (input.tool_id) {
      case 'TL-CALC-01':
        return { output: this.#deterministic(input.args) };
      case 'TL-CALC-02':
        return { output: this.#render(input.args) };
      case 'TL-CALC-03':
        return { output: this.#reconcile(input.args) };
      case 'TL-CALC-04':
        return { output: this.#translate(input.args) };
      case 'TL-CALC-05':
        return { output: this.#verify(input.args) };
      default:
        throw new WorkerError('contract_invalid', {
          detail: `${input.tool_id} is not served by the calculation connector.`,
          failureClass: 'tool',
          retryable: false,
        });
    }
  }

  /** Typed, unit-aware, currency-aware arithmetic. */
  #deterministic(args: Record<string, unknown>): unknown {
    const operation = String(args['operation']);
    const values = (args['values'] as MoneyLike[] | undefined) ?? [];

    switch (operation) {
      case 'sum': {
        const currency = firstText([args['currency'], values[0]?.currency], 'MYR');
        const total = sum(values.map(toMoney), currency, values[0]?.scale ?? 2);
        return { result: total, formatted: toDecimalString(total) };
      }
      case 'subtract': {
        const [a, b] = values;
        if (!a || !b)
          throw new WorkerError('contract_invalid', {
            detail: 'subtract needs two values',
            retryable: false,
          });
        const result = subtract(toMoney(a), toMoney(b));
        return { result, formatted: toDecimalString(result) };
      }
      case 'apply_rate': {
        const [base] = values;
        const rate = String(args['rate']);
        if (!base)
          throw new WorkerError('contract_invalid', {
            detail: 'apply_rate needs a base',
            retryable: false,
          });
        const result = multiplyByRate(toMoney(base), rate);
        return { result, formatted: toDecimalString(result), rate_applied: rate };
      }
      default:
        throw new WorkerError('contract_invalid', {
          detail: `Unknown calculation operation "${operation}".`,
          failureClass: 'tool',
          retryable: false,
        });
    }
  }

  #render(args: Record<string, unknown>): unknown {
    const rows = (args['rows'] as Record<string, unknown>[] | undefined) ?? [];
    const columns = (args['columns'] as string[] | undefined) ?? Object.keys(rows[0] ?? {});
    return {
      format: 'tsv',
      // Tab-separated so a figure containing a comma cannot shift a column.
      content: [
        columns.join('\t'),
        ...rows.map((row) => columns.map((c) => asText(row[c], '')).join('\t')),
      ].join('\n'),
      row_count: rows.length,
    };
  }

  /**
   * Matching with tolerance read from AS-RUL-*.
   *
   * The tolerance is passed in by the caller, which resolved it from settings.
   * This tool never reads configuration itself — D7: C16 answers presence and
   * value; a calculation tool is not entitled to interpret one.
   */
  #reconcile(args: Record<string, unknown>): unknown {
    const left = (args['left'] as { key: string; amount: MoneyLike }[] | undefined) ?? [];
    const right = (args['right'] as { key: string; amount: MoneyLike }[] | undefined) ?? [];
    const tolerance = args['tolerance'] as MoneyLike | undefined;

    const rightByKey = new Map(right.map((item) => [item.key, item]));
    const matched: unknown[] = [];
    const variances: unknown[] = [];
    const unmatchedLeft: unknown[] = [];

    for (const item of left) {
      const counterpart = rightByKey.get(item.key);
      if (!counterpart) {
        unmatchedLeft.push(item);
        continue;
      }
      rightByKey.delete(item.key);

      const difference = subtract(toMoney(item.amount), toMoney(counterpart.amount));
      const withinTolerance =
        tolerance === undefined
          ? difference.amount_minor === 0
          : Math.abs(difference.amount_minor) <= Math.abs(tolerance.amount_minor);

      if (difference.amount_minor === 0) {
        matched.push({ key: item.key, amount: item.amount });
      } else {
        variances.push({
          key: item.key,
          left: item.amount,
          right: counterpart.amount,
          difference,
          within_tolerance: withinTolerance,
        });
      }
    }

    return {
      matched,
      variances,
      unmatched_left: unmatchedLeft,
      unmatched_right: [...rightByKey.values()],
      // Reported, never applied: a break is a proposal for a human, and
      // certification is immutable rule 5.
      summary: {
        matched_count: matched.length,
        variance_count: variances.length,
        unmatched_count: unmatchedLeft.length + rightByKey.size,
      },
    };
  }

  #translate(args: Record<string, unknown>): unknown {
    const amount = args['amount'] as MoneyLike;
    const rate = String(args['rate']);
    const toCurrency = String(args['to_currency']);
    const rateDate = String(args['rate_date']);
    const rateSource = String(args['rate_source']);

    const base = toMoney(amount);
    const converted = multiplyByRate(base, rate);

    return {
      // The rate, its source and its date travel with the result: a translated
      // figure with no stated rate is not auditable.
      result: money(converted.amount_minor, toCurrency, base.scale),
      rate_applied: rate,
      rate_date: rateDate,
      rate_source: rateSource,
      from: base,
    };
  }

  /**
   * TL-CALC-05 — the independent recomputation behind the arithmetic gate.
   *
   * Deliberately simple and deliberately separate: if this shared an
   * implementation with whatever produced the figure, it would certify its own
   * mistakes.
   */
  #verify(args: Record<string, unknown>): unknown {
    const assertions =
      (args['assertions'] as
        { label: string; components: MoneyLike[]; stated_total: MoneyLike }[] | undefined) ?? [];

    const results = assertions.map((assertion) => {
      const currency = assertion.stated_total.currency;
      const scale = assertion.stated_total.scale ?? 2;
      const recomputed = sum(assertion.components.map(toMoney), currency, scale);
      const stated = toMoney(assertion.stated_total);
      const agrees = compare(recomputed, stated) === 0;

      return {
        label: assertion.label,
        stated: toDecimalString(stated),
        recomputed: toDecimalString(recomputed),
        agrees,
        ...(agrees ? {} : { difference: toDecimalString(subtract(stated, recomputed)) }),
      };
    });

    return {
      all_agree: results.every((r) => r.agrees),
      results,
    };
  }
}

/** Sum a set of money values. Exposed for the skill runtime's own checks. */
export const totalOf = (values: readonly Money[], currency: string): Money =>
  values.reduce<Money>((acc, next) => add(acc, next), money(0, currency));
