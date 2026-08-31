/**
 * Contract validation — the boundary guard.
 *
 * DWD-06 s.2.3 defines a precise evolution policy, and this module is where it
 * is enforced rather than described:
 *
 *   - Every contract carries a semver `schema_version`.
 *   - Consumers **reject an unknown MAJOR**. A peer speaking 2.x is not a peer.
 *   - Additive optional fields are MINOR; consumers **ignore unknown fields
 *     within the same MAJOR**. So a payload from a newer MINOR is accepted
 *     after its unknown keys are stripped — strict at the boundary, tolerant on
 *     the wire.
 *   - Enumerations are closed. An unknown member is a refusal, not a fallback.
 */
import { createRequire } from 'node:module';
import type { ErrorObject, ValidateFunction } from 'ajv';

/**
 * Ajv ships CommonJS with `module.exports = Ajv` plus an `exports.default`.
 * Under `module: NodeNext` TypeScript resolves the bare specifier to a
 * namespace, which has no construct signature — so the constructor is reached
 * through `createRequire` and typed explicitly. Narrower and more honest than
 * loosening the module settings for the whole workspace.
 */
interface AjvInstance {
  addSchema(schema: unknown): void;
  compile(schema: unknown): ValidateFunction;
}

type AjvConstructor = new (options: Record<string, unknown>) => AjvInstance;

const nodeRequire = createRequire(import.meta.url);

const ajvExport = nodeRequire('ajv/dist/2020.js') as AjvConstructor | { default: AjvConstructor };
const Ajv2020: AjvConstructor = typeof ajvExport === 'function' ? ajvExport : ajvExport.default;

const formatsExport = nodeRequire('ajv-formats') as
  ((ajv: AjvInstance) => void) | { default: (ajv: AjvInstance) => void };
const addFormats = typeof formatsExport === 'function' ? formatsExport : formatsExport.default;
import { WorkerError, type Result, err, ok } from '@eiaaw/core';
import { CONTRACT_SCHEMAS, type JsonSchema, commonSchema } from './schemas.js';
import { CURRENT_SCHEMA_VERSION, type ContractMap, type ContractName } from './types.js';

export interface ContractViolation {
  readonly path: string;
  readonly message: string;
  readonly keyword: string;
  readonly params: Readonly<Record<string, unknown>>;
}

export class ContractValidationError extends WorkerError {
  readonly contract: ContractName;
  readonly violations: readonly ContractViolation[];

  constructor(contract: ContractName, violations: readonly ContractViolation[]) {
    const summary = violations
      .slice(0, 5)
      .map((v) => `${v.path || '(root)'}: ${v.message}`)
      .join('; ');
    super('contract_invalid', {
      detail:
        `${contract} failed schema validation. ${summary}` +
        (violations.length > 5 ? ` (+${violations.length - 5} more)` : ''),
      failureClass: 'contract',
      retryable: false,
      context: { contract, violations },
    });
    this.name = 'ContractValidationError';
    this.contract = contract;
    this.violations = violations;
  }
}

function parseSemver(version: string): { major: number; minor: number; patch: number } | null {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function requireSemver(version: string): { major: number; minor: number; patch: number } {
  const parsed = parseSemver(version);
  if (!parsed) throw new Error(`"${version}" is not a valid semver.`);
  return parsed;
}

const CURRENT = requireSemver(CURRENT_SCHEMA_VERSION);

function buildAjv(): AjvInstance {
  const ajv = new Ajv2020({
    strict: true,
    // `strictRequired` demands that a `required` name be declared in
    // `properties` of the *same* subschema. The spec's conditional-required
    // rules live in `if/then` branches, whose `then` cannot see the parent's
    // `properties`, so satisfying it would mean duplicating every property
    // definition into every branch.
    //
    // Turning it off is safe here because the parent schema declares every
    // property with `additionalProperties: false`: a mistyped name in a `then`
    // makes that branch unsatisfiable, and the canonical-fixture test — which
    // validates one real instance per contract — fails immediately.
    strictRequired: false,
    // Every violation, not just the first — a refusal should tell the caller
    // everything that is wrong in one pass.
    allErrors: true,
    // `if/then` is used extensively to encode the spec's conditional-required
    // rules; discriminator inference would fight it.
    discriminator: false,
    allowUnionTypes: true,
    // We never mutate the caller's object during validation. Coercion would
    // silently turn "12" into 12 for an amount_minor, which is exactly the
    // class of defect the money contract exists to prevent.
    coerceTypes: false,
    useDefaults: false,
  });
  addFormats(ajv);
  ajv.addSchema(commonSchema);
  for (const schema of Object.values(CONTRACT_SCHEMAS)) ajv.addSchema(schema);
  return ajv;
}

const ajv = buildAjv();
const compiled = new Map<ContractName, ValidateFunction>();

function validatorFor(contract: ContractName): ValidateFunction {
  const cached = compiled.get(contract);
  if (cached) return cached;
  const fn = ajv.compile(CONTRACT_SCHEMAS[contract]);
  compiled.set(contract, fn);
  return fn;
}

function toViolations(errors: readonly ErrorObject[] | null | undefined): ContractViolation[] {
  return (errors ?? []).map((e) => ({
    path: e.instancePath,
    message: e.message ?? 'failed validation',
    keyword: e.keyword,
    params: e.params as Record<string, unknown>,
  }));
}

/**
 * Strip keys the schema does not declare, one level of nesting at a time.
 *
 * Applied only when the payload's MINOR is *ahead* of ours — the "consumers
 * ignore unknown fields within the same MAJOR" half of s.2.3. Applying it
 * unconditionally would hide genuine defects in our own emitters, so it is
 * deliberately narrow.
 */
function stripUnknown(value: unknown, schema: JsonSchema): unknown {
  if (value === null || typeof value !== 'object') return value;

  const resolved = resolveSchema(schema);
  if (Array.isArray(value)) {
    const itemSchema = resolved['items'] as JsonSchema | undefined;
    return itemSchema ? value.map((item) => stripUnknown(item, itemSchema)) : value;
  }

  const properties = resolved['properties'] as Record<string, JsonSchema> | undefined;
  if (!properties) return value;

  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const childSchema = properties[key];
    if (childSchema === undefined) continue; // unknown in this MAJOR — ignore it
    out[key] = stripUnknown(child, childSchema);
  }
  return out;
}

/** Follow a local `$ref` into the common schema so stripping can recurse. */
function resolveSchema(schema: JsonSchema): JsonSchema {
  const refValue = schema['$ref'];
  if (typeof refValue !== 'string') return schema;
  const [, pointer] = refValue.split('#');
  if (!pointer) return schema;

  let node: unknown = commonSchema;
  for (const segment of pointer.split('/').filter(Boolean)) {
    if (node === null || typeof node !== 'object') return schema;
    node = (node as Record<string, unknown>)[segment];
  }
  return (node as JsonSchema | undefined) ?? schema;
}

export interface ValidateOptions {
  /** Include the contract name in thrown errors; defaults to the contract key. */
  readonly source?: string;
}

/**
 * Validate a payload against one of the sixteen contracts.
 *
 * Returns a `Result` rather than throwing, because a contract violation at an
 * ingress boundary is a refusal to record and report, not a crash.
 */
export function validateContract<K extends ContractName>(
  contract: K,
  payload: unknown,
  _options: ValidateOptions = {},
): Result<ContractMap[K], ContractValidationError> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    return err(
      new ContractValidationError(contract, [
        { path: '', message: 'payload must be a JSON object', keyword: 'type', params: {} },
      ]),
    );
  }

  const record = payload as Record<string, unknown>;
  const rawVersion = record['schema_version'];

  if (typeof rawVersion !== 'string') {
    return err(
      new ContractValidationError(contract, [
        {
          path: '/schema_version',
          message: 'schema_version is required on every contract instance',
          keyword: 'required',
          params: {},
        },
      ]),
    );
  }

  const version = parseSemver(rawVersion);
  if (!version) {
    return err(
      new ContractValidationError(contract, [
        {
          path: '/schema_version',
          message: `schema_version must be semver, received "${rawVersion}"`,
          keyword: 'pattern',
          params: {},
        },
      ]),
    );
  }

  // s.2.3: "Consumers reject an unknown MAJOR."
  if (version.major !== CURRENT.major) {
    return err(
      new ContractValidationError(contract, [
        {
          path: '/schema_version',
          message:
            `unknown MAJOR ${version.major}: this build speaks ${contract} ` +
            `${CURRENT.major}.x and refuses ${rawVersion}. A MAJOR change requires a ` +
            'coordinated release and a dual-read window.',
          keyword: 'major_version',
          params: { received: version.major, expected: CURRENT.major },
        },
      ]),
    );
  }

  // s.2.3: additive optional fields are MINOR, and consumers ignore unknown
  // fields within the same MAJOR. Only a *newer* MINOR earns that tolerance.
  const candidate =
    version.minor > CURRENT.minor ? stripUnknown(record, CONTRACT_SCHEMAS[contract]) : record;

  const validate = validatorFor(contract);
  if (!validate(candidate)) {
    return err(new ContractValidationError(contract, toViolations(validate.errors)));
  }

  return ok(candidate as ContractMap[K]);
}

/** Throwing form, for internal emitters where a violation is a defect. */
export function assertContract<K extends ContractName>(
  contract: K,
  payload: unknown,
): ContractMap[K] {
  const result = validateContract(contract, payload);
  if (!result.ok) throw result.error;
  return result.value;
}

export const isValidContract = <K extends ContractName>(contract: K, payload: unknown): boolean =>
  validateContract(contract, payload).ok;

/** Every compiled schema, for the emit-schemas script and external consumers. */
export const allSchemas = (): readonly JsonSchema[] => [
  commonSchema,
  ...Object.values(CONTRACT_SCHEMAS),
];
