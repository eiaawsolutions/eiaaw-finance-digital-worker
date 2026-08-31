/**
 * C6 — the Policy Engine. DWD-06 s.3.7.
 *
 *   s.1.3 D5: "C6 is consulted by C7, never by C8; a skill cannot ask for its
 *              own permission."
 *   s.3.7:    "A `dual_control` verdict does not proceed on approval by one
 *              person, and an `escalate` verdict does not silently become
 *              `allow` when the escalation target is unavailable; it waits or
 *              it times out into a hand-off."
 *   s.7.4:    "never retry a policy refusal."
 *
 * The engine emits a `PolicyVerdict` for every gate node. The verdict records
 * threshold values as *references plus hashes*, never inline — so a verdict is
 * re-derivable during an audit without the settings having been copied into it.
 */
import { hashObject, newId, now, type DateOnly } from '@eiaaw/core';
import type {
  AutonomyLevel,
  ImmutableRuleNumber,
  OutputClass,
  PolicyVerdict,
  PolicyVerdictValue,
  ThresholdValueRef,
} from '@eiaaw/contracts';
import { type ConfigService, type SettingScope } from '@eiaaw/config';
import { type Database, type TenantScope, withPlatformScope, withTenant } from '@eiaaw/db';
import { recordPolicyVerdict } from '@eiaaw/telemetry';
import {
  evaluateImmutableRules,
  renderRefusal,
  type RuleContext,
  type RuleEngagement,
  type RuleSubject,
} from './immutable-rules.js';

export interface PolicyRule {
  readonly rule_id: string;
  readonly rule_version: string;
  readonly description: string;
  readonly context_selector: Readonly<Record<string, string>>;
  readonly condition_expression: string;
  readonly threshold_refs: readonly string[];
  readonly verdict_on_pass: PolicyVerdictValue;
  readonly verdict_on_fail: PolicyVerdictValue;
  readonly precedence_rank: number;
  readonly owner_ref: string;
  readonly effective_from: DateOnly;
  readonly effective_to: DateOnly | null;
}

export interface GateRequest {
  readonly tenant_id: string;
  readonly graph_id: string;
  readonly node_id: string;
  readonly subject: RuleSubject;
  readonly context: RuleContext;
  /** Axes for rule selection and for the settings scope. */
  readonly selector: {
    readonly jurisdiction: string;
    readonly entity: string;
    readonly process: string;
    readonly as_of_date: DateOnly;
  };
  /** Values the condition expression is evaluated against. */
  readonly facts: Readonly<Record<string, unknown>>;
  readonly settings_snapshot_id?: string;
}

export interface GateResult {
  readonly verdict: PolicyVerdict;
  /** Present when an immutable rule engaged; carries the refusal wording. */
  readonly refusal: { readonly message: string; readonly engagement: RuleEngagement } | null;
}

export interface PolicyEngineOptions {
  readonly db: Database;
  readonly config: ConfigService;
  readonly residencyZone: string;
}

export class PolicyEngine {
  readonly #db: Database;
  readonly #config: ConfigService;
  readonly #residencyZone: string;

  constructor(options: PolicyEngineOptions) {
    this.#db = options.db;
    this.#config = options.config;
    this.#residencyZone = options.residencyZone;
  }

  /**
   * Evaluate one gate.
   *
   * Order matters and is not negotiable: the immutable rules run FIRST, and a
   * non-null engagement forces `refuse` regardless of what any configured rule
   * would have said. file 01 s.6.1: "Stop before any state change. No partial
   * execution, no 'prepare and hold'."
   */
  async evaluate(request: GateRequest, scope?: TenantScope): Promise<GateResult> {
    const { engaged, evaluated } = evaluateImmutableRules(request.subject, request.context);

    if (engaged) {
      const verdict = await this.#emit(
        request,
        {
          rule_id: `IMMUTABLE-${engaged.rule}`,
          rule_version: '1.0.0',
          condition_evaluated: engaged.statement,
          verdict: 'refuse',
          threshold_values: [],
          precedence_rank: 1000, // above every configurable rule
          owner: 'Platform (not configurable)',
          effective_from: '2000-01-01',
          effective_to: null,
          immutable_rules_evaluated: evaluated,
          immutable_rule_engaged: engaged.rule,
        },
        scope,
      );

      return {
        verdict,
        refusal: {
          message: renderRefusal(engaged, request.context.scope_card_version),
          engagement: engaged,
        },
      };
    }

    // No immutable rule engaged: evaluate the configured rules by precedence.
    const rules = await this.#selectRules(request);

    for (const rule of rules) {
      const thresholds = await this.#resolveThresholds(request, rule);
      if (!thresholds.ok) {
        // s.13.3: a missing threshold is a refusal, never a default. The
        // verdict records which setting was absent.
        const verdict = await this.#emit(
          request,
          {
            rule_id: rule.rule_id,
            rule_version: rule.rule_version,
            condition_evaluated: `${rule.condition_expression} [unresolved: ${thresholds.missing}]`,
            verdict: 'refuse',
            threshold_values: [],
            precedence_rank: rule.precedence_rank,
            owner: rule.owner_ref,
            effective_from: rule.effective_from,
            effective_to: rule.effective_to,
            immutable_rules_evaluated: evaluated,
            immutable_rule_engaged: null,
          },
          scope,
        );
        return { verdict, refusal: null };
      }

      const passed = evaluateCondition(rule.condition_expression, {
        ...request.facts,
        ...thresholds.values,
      });
      const outcome = passed ? rule.verdict_on_pass : rule.verdict_on_fail;

      // The first rule by precedence that produces anything other than `allow`
      // decides. An `allow` lets the next rule have its say.
      if (outcome !== 'allow') {
        const verdict = await this.#emit(
          request,
          {
            rule_id: rule.rule_id,
            rule_version: rule.rule_version,
            condition_evaluated: rule.condition_expression,
            verdict: outcome,
            threshold_values: thresholds.refs,
            precedence_rank: rule.precedence_rank,
            owner: rule.owner_ref,
            effective_from: rule.effective_from,
            effective_to: rule.effective_to,
            immutable_rules_evaluated: evaluated,
            immutable_rule_engaged: null,
          },
          scope,
        );
        return { verdict, refusal: null };
      }
    }

    const verdict = await this.#emit(
      request,
      {
        rule_id: rules.length > 0 ? (rules[rules.length - 1]?.rule_id ?? 'NO-RULE') : 'NO-RULE',
        rule_version: '1.0.0',
        condition_evaluated:
          rules.length > 0
            ? 'every applicable rule allowed'
            : 'no rule selects this context; no rule means no additional constraint',
        verdict: 'allow',
        threshold_values: [],
        precedence_rank: 0,
        owner: 'Platform',
        effective_from: '2000-01-01',
        effective_to: null,
        immutable_rules_evaluated: evaluated,
        immutable_rule_engaged: null,
      },
      scope,
    );

    return { verdict, refusal: null };
  }

  async #selectRules(request: GateRequest): Promise<PolicyRule[]> {
    const rows = await withPlatformScope(
      this.#db,
      async (sql) =>
        sql<PolicyRuleRow[]>`
        SELECT rule_id, rule_version, description, context_selector, condition_expression,
               threshold_refs, verdict_on_pass, verdict_on_fail, precedence_rank,
               owner_ref, effective_from, effective_to
          FROM policy_rules
         WHERE status = 'active'
           AND effective_from <= ${request.selector.as_of_date}::date
           AND (effective_to IS NULL OR effective_to >= ${request.selector.as_of_date}::date)
         ORDER BY precedence_rank DESC
      `,
    );

    // A selector key the request does not carry is treated as non-matching:
    // a rule must select the context, not merely fail to exclude it.
    return rows
      .filter((row) => {
        const selector = row.context_selector;
        return Object.entries(selector).every(([key, value]) => {
          if (value === '*') return true;
          const actual = (request.selector as unknown as Record<string, string>)[key];
          return actual === value;
        });
      })
      .map((row) => ({
        ...row,
        threshold_refs: row.threshold_refs,
        effective_to: row.effective_to,
      }));
  }

  async #resolveThresholds(
    request: GateRequest,
    rule: PolicyRule,
  ): Promise<
    | { ok: true; values: Record<string, unknown>; refs: ThresholdValueRef[] }
    | { ok: false; missing: string }
  > {
    const values: Record<string, unknown> = {};
    const refs: ThresholdValueRef[] = [];
    const settingScope: SettingScope = {
      entity: request.selector.entity,
      process: request.selector.process,
      asOf: request.selector.as_of_date,
    };

    for (const fieldId of rule.threshold_refs) {
      const result = request.settings_snapshot_id
        ? await this.#config.resolveFromSnapshot(
            request.tenant_id,
            request.settings_snapshot_id,
            fieldId,
          )
        : await this.#config.resolve(request.tenant_id, fieldId, settingScope);

      if (!result.ok) return { ok: false, missing: fieldId };

      values[fieldId] = result.value.value;
      refs.push({
        setting_id: fieldId,
        value_ref: `resolved at ${now()}`,
        value_hash: result.value.value_hash,
      });
    }

    return { ok: true, values, refs };
  }

  async #emit(
    request: GateRequest,
    parts: {
      rule_id: string;
      rule_version: string;
      condition_evaluated: string;
      verdict: PolicyVerdictValue;
      threshold_values: readonly ThresholdValueRef[];
      precedence_rank: number;
      owner: string;
      effective_from: DateOnly;
      effective_to: DateOnly | null;
      immutable_rules_evaluated: readonly ImmutableRuleNumber[];
      immutable_rule_engaged: ImmutableRuleNumber | null;
    },
    scope?: TenantScope,
  ): Promise<PolicyVerdict> {
    const verdict: PolicyVerdict = {
      schema_version: '1.0.0',
      verdict_id: newId('policyVerdict'),
      graph_id: request.graph_id,
      node_id: request.node_id,
      rule_id: parts.rule_id,
      rule_version: parts.rule_version,
      context_selector: request.selector,
      condition_evaluated: parts.condition_evaluated,
      // Makes the verdict re-derivable during an audit.
      inputs_hash: hashObject({
        subject: request.subject,
        facts: request.facts,
        selector: request.selector,
      }),
      verdict: parts.verdict,
      threshold_values: parts.threshold_values,
      precedence_rank: parts.precedence_rank,
      effective_from: parts.effective_from,
      effective_to: parts.effective_to,
      owner: parts.owner,
      immutable_rules_evaluated: parts.immutable_rules_evaluated,
      immutable_rule_engaged: parts.immutable_rule_engaged,
      decided_at: now(),
    };

    const write = async (s: TenantScope): Promise<void> => {
      await s.sql`
        INSERT INTO policy_verdicts (
          tenant_id, verdict_id, graph_id, node_id, rule_id, rule_version,
          context_selector, condition_evaluated, inputs_hash, verdict,
          threshold_values, precedence_rank, effective_from, effective_to,
          owner_ref, immutable_rules_evaluated, immutable_rule_engaged, decided_at
        ) VALUES (
          ${request.tenant_id}, ${verdict.verdict_id}, ${verdict.graph_id}, ${verdict.node_id},
          ${verdict.rule_id}, ${verdict.rule_version},
          ${s.sql.json(verdict.context_selector)},
          ${verdict.condition_evaluated}, ${verdict.inputs_hash}, ${verdict.verdict},
          ${s.sql.json(verdict.threshold_values as never)},
          ${verdict.precedence_rank}, ${verdict.effective_from}::date,
          ${verdict.effective_to}::date, ${verdict.owner},
          ${verdict.immutable_rules_evaluated},
          ${verdict.immutable_rule_engaged},
          ${verdict.decided_at}::timestamptz
        )
      `;
    };

    if (scope) await write(scope);
    else
      await withTenant(
        this.#db,
        { tenantId: request.tenant_id, residencyZone: this.#residencyZone },
        write,
      );

    recordPolicyVerdict(verdict.rule_id, verdict.verdict, verdict.immutable_rule_engaged);
    return verdict;
  }
}

interface PolicyRuleRow {
  rule_id: string;
  rule_version: string;
  description: string;
  context_selector: Record<string, string>;
  condition_expression: string;
  threshold_refs: string[];
  verdict_on_pass: PolicyVerdictValue;
  verdict_on_fail: PolicyVerdictValue;
  precedence_rank: number;
  owner_ref: string;
  effective_from: string;
  effective_to: string | null;
}

/**
 * Evaluate a rule condition.
 *
 * Deliberately a tiny, total expression language rather than anything that can
 * execute arbitrary code. A policy rule is client-authored configuration; if it
 * could evaluate arbitrary expressions, a rule edit would be a remote code
 * execution primitive with the worker's privileges.
 *
 * Supported forms:
 *   `<fact> <op> <fact|literal>`   with op in <= < >= > == !=
 *   `abs(<fact> - <fact>) <op> <fact|literal>`
 *   `<fact> in [<literal>, ...]`
 *   `true` / `false`
 */
export function evaluateCondition(
  expression: string,
  facts: Readonly<Record<string, unknown>>,
): boolean {
  const expr = expression.trim();
  if (expr === 'true') return true;
  if (expr === 'false') return false;

  const inMatch = /^(\S+)\s+in\s+\[(.*)\]$/.exec(expr);
  if (inMatch) {
    const value = resolveOperand(inMatch[1] as string, facts);
    const members = (inMatch[2] as string)
      .split(',')
      .map((m) => m.trim().replace(/^['"]|['"]$/g, ''));
    return members.includes(String(value));
  }

  const absMatch = /^abs\(\s*(\S+)\s*-\s*(\S+)\s*\)\s*(<=|<|>=|>|==|!=)\s*(\S+)$/.exec(expr);
  if (absMatch) {
    const left = toNumber(resolveOperand(absMatch[1] as string, facts));
    const right = toNumber(resolveOperand(absMatch[2] as string, facts));
    const bound = toNumber(resolveOperand(absMatch[4] as string, facts));
    if (left === null || right === null || bound === null) return false;
    return compare(Math.abs(left - right), absMatch[3] as string, bound);
  }

  const binary = /^(\S+)\s*(<=|<|>=|>|==|!=)\s*(\S+)$/.exec(expr);
  if (binary) {
    const left = resolveOperand(binary[1] as string, facts);
    const right = resolveOperand(binary[3] as string, facts);
    const op = binary[2] as string;

    if (op === '==') return String(left) === String(right);
    if (op === '!=') return String(left) !== String(right);

    const l = toNumber(left);
    const r = toNumber(right);
    if (l === null || r === null) return false;
    return compare(l, op, r);
  }

  // An unparseable condition is a defect in the rule, and a defect in a rule
  // must not read as "allow".
  return false;
}

function resolveOperand(token: string, facts: Readonly<Record<string, unknown>>): unknown {
  if (token in facts) return facts[token];
  const unquoted = token.replace(/^['"]|['"]$/g, '');
  if (unquoted !== token) return unquoted;
  const numeric = Number(token);
  return Number.isNaN(numeric) ? token : numeric;
}

/** Money is `{ amount_minor }`; comparisons are on minor units, never on floats. */
function toNumber(value: unknown): number | null {
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isNaN(parsed) ? null : parsed;
  }
  if (value !== null && typeof value === 'object' && 'amount_minor' in value) {
    const minor = value.amount_minor;
    return typeof minor === 'number' ? minor : null;
  }
  return null;
}

function compare(left: number, op: string, right: number): boolean {
  switch (op) {
    case '<=':
      return left <= right;
    case '<':
      return left < right;
    case '>=':
      return left >= right;
    case '>':
      return left > right;
    case '==':
      return left === right;
    case '!=':
      return left !== right;
    default:
      return false;
  }
}

/** The output classes a given autonomy level may produce, for admission checks. */
export function autonomyPermitsClass(
  autonomy: AutonomyLevel,
  classCeiling: AutonomyLevel | 'none',
): boolean {
  if (classCeiling === 'none') return false;
  const rank = { observe: 0, draft: 1, execute: 2 } as const;
  return rank[autonomy] <= rank[classCeiling];
}

export type { OutputClass };
