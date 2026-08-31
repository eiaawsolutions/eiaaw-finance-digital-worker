/**
 * Reading scalars out of untrusted JSON.
 *
 * Webhook bodies, tool arguments and adapter payloads all arrive as
 * `Record<string, unknown>`. Interpolating one of those values straight into a
 * string is a real defect, not a style problem: a provider that sends
 * `{"id": {"value": "..."}}` where the contract says a string would put the
 * literal text `[object Object]` into a message id, a channel identifier or an
 * audit subject — a value that then looks legitimate everywhere downstream and
 * silently collides with every other malformed payload.
 *
 * These helpers convert only what is genuinely scalar and fall back otherwise.
 */

/**
 * The scalar text of `value`, or `fallback` when it is not a scalar.
 *
 * Numbers, bigints and booleans convert because a provider sending `12345`
 * for an id is sending an id. Objects, arrays, `null` and `undefined` do not.
 */
export function asText(value: unknown, fallback: string): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : fallback;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return String(value);
  return fallback;
}

/** The first non-empty scalar among `values`, or `fallback` when there is none. */
export function firstText(values: readonly unknown[], fallback: string): string {
  for (const value of values) {
    const text = asText(value, '');
    if (text !== '') return text;
  }
  return fallback;
}

/** `value` as a plain object, or `undefined` — arrays and `null` are not objects here. */
export function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

/** The text at `path` inside a nested untrusted payload, or `fallback`. */
export function textAt(root: unknown, path: readonly string[], fallback: string): string {
  let current: unknown = root;
  for (const segment of path) {
    const record = asRecord(current);
    if (record === undefined) return fallback;
    current = record[segment];
  }
  return asText(current, fallback);
}
