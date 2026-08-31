/**
 * C3 — the L0 Context Resolver.
 *
 *   s.1.3 D4: "C3 is on the critical path of EVERY request, including answers
 *              and including scheduled and event triggers."
 *   s.3.2:    "`resolution_status: refused` terminates the pipeline. There is no
 *              downstream component permitted to proceed on a refused context,
 *              and none that can construct one itself."
 *   s.7.3:    "a graph never resumes on an expired context."
 *
 * Five axes, all required: jurisdiction, reporting_framework, legal_entity,
 * currency, as_of_date. Each resolves with a coverage tier, and any axis that
 * cannot be resolved to exactly one value produces a refusal that names it.
 *
 * The as-of date is the axis most often got wrong. file 01 s.5.3: an answer is
 * stated *as at a date*, and DWD-06 s.2.2 says as-of is "always explicit, never
 * implied by 'now'". So a scheduled trigger carries a *rule* ("period_end"),
 * never a literal, and this resolver evaluates it against the fiscal calendar.
 */
import {
  type DateOnly,
  type Result,
  type Timestamp,
  contextUnresolved,
  contextTokenHash,
  durationToMs,
  err,
  now,
  ok,
  parseDateOnly,
  periodBounds,
  toDateOnly,
  toTimestamp,
} from '@eiaaw/core';
import {
  type AxisResolution,
  type ContextAxis,
  type ResolvedContext,
  buildRefusedContext,
  buildResolvedContext,
} from '@eiaaw/contracts';
import type { ConfigService } from '@eiaaw/config';
import { type Database, type TenantScope, withPlatformScope, withTenant } from '@eiaaw/db';
import { recordContextResolution } from '@eiaaw/telemetry';

export interface ResolveRequest {
  readonly tenant_id: string;
  readonly request_id: string;
  /** What intake extracted from the message, if anything. */
  readonly hints?: {
    readonly entity?: string;
    readonly jurisdiction?: string;
    readonly framework?: string;
    readonly currency?: string;
    readonly as_of_date?: DateOnly;
    readonly period?: string;
    readonly locale?: string;
  };
  /** For schedule/watch triggers: a rule, never a literal date. */
  readonly as_of_date_rule?: string;
  /** The principal's entity scope, which narrows a multi-entity tenant. */
  readonly principal_entity_scope?: readonly string[];
  readonly settings_snapshot_id?: string;
}

export interface ContextResolverOptions {
  readonly db: Database;
  readonly config: ConfigService;
  readonly residencyZone: string;
  /** Default TTL when AS-RUL-CTX-001 is unset — used for read-only work only. */
  readonly defaultTtlMs?: number;
}

export class ContextResolver {
  readonly #db: Database;
  readonly #config: ConfigService;
  readonly #residencyZone: string;
  readonly #defaultTtlMs: number;

  constructor(options: ContextResolverOptions) {
    this.#db = options.db;
    this.#config = options.config;
    this.#residencyZone = options.residencyZone;
    this.#defaultTtlMs = options.defaultTtlMs ?? 4 * 60 * 60 * 1000;
  }

  /**
   * Resolve, or refuse.
   *
   * Returns a `ResolvedContext` in both cases: a refusal is a governed outcome
   * that must be recorded and explained, not an exception. The caller checks
   * `resolution_status` and stops on `refused`.
   */
  async resolve(request: ResolveRequest, scope?: TenantScope): Promise<ResolvedContext> {
    const partial: Partial<Record<ContextAxis, AxisResolution>> = {};

    // --- residency ---------------------------------------------------------
    const tenant = await this.#loadTenant(request.tenant_id);
    if (!tenant) {
      return this.#persist(
        buildRefusedContext({
          request_id: request.request_id,
          tenant_id: request.tenant_id,
          residency_zone: this.#residencyZone,
          resolved_locale: 'en-MY',
          unresolved_axis: 'legal_entity',
          reason: 'the tenant is not provisioned',
        }),
        request,
        scope,
      );
    }

    if (tenant.residency_zone !== this.#residencyZone) {
      // s.10.6: a cross-zone read or write refuses. Refusing here, before any
      // store is touched, is cheaper and clearer than a 451 from the database.
      return this.#persist(
        buildRefusedContext({
          request_id: request.request_id,
          tenant_id: request.tenant_id,
          residency_zone: this.#residencyZone,
          resolved_locale: 'en-MY',
          unresolved_axis: 'jurisdiction',
          reason:
            `this tenant is provisioned in residency zone "${tenant.residency_zone}" but this ` +
            `process runs in "${this.#residencyZone}". Cross-zone access is refused, not proxied`,
        }),
        request,
        scope,
      );
    }

    // --- legal entity ------------------------------------------------------
    const entityResult = await this.#resolveEntity(request);
    if (!entityResult.ok) {
      return this.#persist(
        buildRefusedContext({
          request_id: request.request_id,
          tenant_id: request.tenant_id,
          residency_zone: this.#residencyZone,
          resolved_locale: 'en-MY',
          unresolved_axis: 'legal_entity',
          reason: entityResult.error.message,
          partial_axes: partial,
        }),
        request,
        scope,
      );
    }
    partial.legal_entity = entityResult.value;
    const entity = entityResult.value.value;

    // --- jurisdiction, framework, currency, locale -------------------------
    const scopedSettings = {
      entity,
      ...(request.hints?.as_of_date === undefined ? {} : { asOf: request.hints.as_of_date }),
    };

    const axes: readonly { axis: ContextAxis; field: string; hint: string | undefined }[] = [
      { axis: 'jurisdiction', field: 'AS-ORG-002', hint: request.hints?.jurisdiction },
      { axis: 'reporting_framework', field: 'AS-ORG-003', hint: request.hints?.framework },
      { axis: 'currency', field: 'AS-ORG-004', hint: request.hints?.currency },
    ];

    for (const { axis, field, hint } of axes) {
      const resolved = await this.#config.resolve<string>(request.tenant_id, field, scopedSettings);
      if (!resolved.ok) {
        return this.#persist(
          buildRefusedContext({
            request_id: request.request_id,
            tenant_id: request.tenant_id,
            residency_zone: this.#residencyZone,
            resolved_locale: 'en-MY',
            unresolved_axis: axis,
            reason: resolved.error.message,
            partial_axes: partial,
          }),
          request,
          scope,
        );
      }

      const configured = String(resolved.value.value);
      // A hint that contradicts configuration is not a tie to break silently.
      // file 01 s.5.3: "A question that does not resolve to one jurisdiction and
      // framework is returned with a clarifying question, not answered generically."
      if (hint !== undefined && hint !== configured) {
        return this.#persist(
          buildRefusedContext({
            request_id: request.request_id,
            tenant_id: request.tenant_id,
            residency_zone: this.#residencyZone,
            resolved_locale: 'en-MY',
            unresolved_axis: axis,
            reason:
              `the request implies "${hint}" but entity ${entity} is configured as ` +
              `"${configured}" at ${field}. I will not choose between them`,
            partial_axes: partial,
          }),
          request,
          scope,
        );
      }

      partial[axis] = { value: configured, source: field, coverage_tier: 'full' };
    }

    const localeResult = await this.#config.resolve<string>(
      request.tenant_id,
      'AS-ORG-006',
      scopedSettings,
    );
    const locale = localeResult.ok
      ? String(localeResult.value.value)
      : (request.hints?.locale ?? 'en-MY');

    // --- as-of date and fiscal period --------------------------------------
    const asOfResult = await this.#resolveAsOfDate(request, entity);
    if (!asOfResult.ok) {
      return this.#persist(
        buildRefusedContext({
          request_id: request.request_id,
          tenant_id: request.tenant_id,
          residency_zone: this.#residencyZone,
          resolved_locale: locale,
          unresolved_axis: 'as_of_date',
          reason: asOfResult.error.message,
          partial_axes: partial,
        }),
        request,
        scope,
      );
    }
    partial.as_of_date = asOfResult.value.axis;

    // --- pack selection ----------------------------------------------------
    const jurisdiction = partial.jurisdiction?.value as string;
    const framework = partial.reporting_framework?.value as string;
    const pack = await this.#selectPack(jurisdiction, framework, asOfResult.value.axis.value);

    if (!pack) {
      return this.#persist(
        buildRefusedContext({
          request_id: request.request_id,
          tenant_id: request.tenant_id,
          residency_zone: this.#residencyZone,
          resolved_locale: locale,
          unresolved_axis: 'reporting_framework',
          reason:
            `no published knowledge pack covers ${jurisdiction}/${framework} as at ` +
            `${asOfResult.value.axis.value}. I will not answer from general knowledge`,
          partial_axes: partial,
        }),
        request,
        scope,
      );
    }

    // --- knowledge pin -----------------------------------------------------
    const modules = await this.#pinModules(
      pack.pack_id,
      pack.pack_version,
      asOfResult.value.axis.value,
    );

    const ttlMs = await this.#resolveTtl(request.tenant_id, entity);

    const context = buildResolvedContext({
      request_id: request.request_id,
      tenant_id: request.tenant_id,
      axes: partial as Record<ContextAxis, AxisResolution>,
      pack: { pack_id: pack.pack_id, pack_version: pack.pack_version },
      residency_zone: this.#residencyZone,
      resolved_locale: locale,
      knowledge_pin: { pinned_at: now(), modules },
      ttlMs,
      ...(asOfResult.value.fiscal_period === undefined
        ? {}
        : { fiscal_period: asOfResult.value.fiscal_period }),
    });

    return this.#persist(context, request, scope);
  }

  /**
   * s.7.3: "a graph suspended overnight for approval must re-resolve its
   * context before it resumes, because the as-of date, the period status or a
   * statutory rate may have moved."
   *
   * This is the check that enforces it, and it is deliberately a hard boolean
   * rather than a grace period.
   */
  isExpired(context: ResolvedContext, at: Timestamp = now()): boolean {
    return Date.parse(at) >= Date.parse(context.expires_at);
  }

  async #loadTenant(tenantId: string): Promise<{ residency_zone: string } | null> {
    const rows = await withPlatformScope(
      this.#db,
      async (sql) =>
        sql<{ residency_zone: string }[]>`
        SELECT residency_zone FROM tenants WHERE tenant_id = ${tenantId} AND status = 'active'
      `,
    );
    return rows[0] ?? null;
  }

  async #resolveEntity(request: ResolveRequest): Promise<Result<AxisResolution>> {
    const entities = await this.#config.resolve<string[]>(request.tenant_id, 'AS-ORG-001', {});
    if (!entities.ok) return err(entities.error);

    const registered = Array.isArray(entities.value.value) ? entities.value.value : [];
    if (registered.length === 0) {
      return err(
        contextUnresolved(
          'legal_entity',
          'the entity register at AS-ORG-001 is empty, so there is no entity to act for.',
        ),
      );
    }

    // A hint must name a registered entity.
    if (request.hints?.entity !== undefined) {
      if (!registered.includes(request.hints.entity)) {
        return err(
          contextUnresolved(
            'legal_entity',
            `"${request.hints.entity}" is not in this tenant's entity register.`,
          ),
        );
      }
      return ok({ value: request.hints.entity, source: 'request', coverage_tier: 'full' });
    }

    // No hint: the principal's scope must narrow it to exactly one.
    const inScope =
      request.principal_entity_scope === undefined || request.principal_entity_scope.length === 0
        ? registered
        : registered.filter((e) => request.principal_entity_scope?.includes(e));

    if (inScope.length === 1) {
      return ok({
        value: inScope[0] as string,
        source: 'AS-ORG-001 (single entity in scope)',
        coverage_tier: 'full',
      });
    }

    // Ambiguity is a clarifying question, never a guess.
    return err(
      contextUnresolved(
        'legal_entity',
        inScope.length === 0
          ? 'no entity in the register is within this principal’s scope.'
          : `the request does not name an entity and ${inScope.length} are in scope ` +
              `(${inScope.slice(0, 5).join(', ')}${inScope.length > 5 ? ', …' : ''}). ` +
              'Name the entity and I will proceed.',
        { candidates: inScope.slice(0, 20) },
      ),
    );
  }

  /**
   * Resolve the as-of date.
   *
   * Precedence: an explicit date on the request, then a period, then a
   * schedule rule evaluated against the fiscal calendar. There is deliberately
   * no "default to today" branch — DWD-06 s.1 lists "a scheduled job with a
   * hard-coded entity or as-of date" as a red flag, and an implied `now` is the
   * same defect wearing a different hat.
   */
  async #resolveAsOfDate(
    request: ResolveRequest,
    entity: string,
  ): Promise<
    Result<{
      axis: AxisResolution;
      fiscal_period?: ResolvedContext['fiscal_period'];
    }>
  > {
    let asOf: DateOnly | null = null;
    let source = '';

    if (request.hints?.as_of_date !== undefined) {
      asOf = request.hints.as_of_date;
      source = 'request';
    } else if (request.hints?.period !== undefined) {
      try {
        asOf = periodBounds(request.hints.period).end_date;
        source = `request period ${request.hints.period}`;
      } catch {
        return err(
          contextUnresolved(
            'as_of_date',
            `"${request.hints.period}" is not a recognisable period (expected YYYY-MM).`,
          ),
        );
      }
    } else if (request.as_of_date_rule !== undefined) {
      const evaluated = this.#evaluateAsOfRule(request.as_of_date_rule);
      if (!evaluated) {
        return err(
          contextUnresolved(
            'as_of_date',
            `the trigger's as-of rule "${request.as_of_date_rule}" is not a rule I recognise. ` +
              'A schedule carries a rule, never a literal date.',
          ),
        );
      }
      asOf = evaluated;
      source = `rule:${request.as_of_date_rule}`;
    }

    if (asOf === null) {
      return err(
        contextUnresolved(
          'as_of_date',
          'the request states no date or period, and none can be inferred. An answer is ' +
            'stated as at a date, so tell me which date or period applies.',
        ),
      );
    }

    try {
      parseDateOnly(asOf);
    } catch {
      return err(contextUnresolved('as_of_date', `"${asOf}" is not a valid date.`));
    }

    const fiscalPeriod = await this.#resolveFiscalPeriod(request.tenant_id, entity, asOf);

    return ok({
      axis: { value: asOf, source, coverage_tier: 'full' },
      ...(fiscalPeriod === null ? {} : { fiscal_period: fiscalPeriod }),
    });
  }

  /** The rules a schedule or watch trigger may carry. Closed set. */
  #evaluateAsOfRule(rule: string, today: Date = new Date()): DateOnly | null {
    const asDate = toDateOnly(today);
    switch (rule) {
      case 'today':
        return asDate;
      case 'today_minus_1': {
        const d = new Date(today);
        d.setUTCDate(d.getUTCDate() - 1);
        return toDateOnly(d);
      }
      case 'period_end': {
        const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 0));
        return toDateOnly(d);
      }
      case 'prior_period_end': {
        const d = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 0));
        return toDateOnly(d);
      }
      default:
        return null;
    }
  }

  async #resolveFiscalPeriod(
    tenantId: string,
    entity: string,
    asOf: DateOnly,
  ): Promise<ResolvedContext['fiscal_period'] | null> {
    const yearEnd = await this.#config.resolve<string>(tenantId, 'AS-ORG-005', { entity });
    if (!yearEnd.ok) return null;

    const bounds = periodBounds(asOf.slice(0, 7));
    // The period status source is client-configured; until a connector reads
    // it, a period is reported open and the policy engine gates the write.
    return {
      period_id: `FY-${asOf.slice(0, 7)}`,
      start_date: bounds.start_date,
      end_date: bounds.end_date,
      status: 'open',
    };
  }

  async #selectPack(
    jurisdiction: string,
    framework: string,
    asOf: DateOnly,
  ): Promise<{ pack_id: string; pack_version: string } | null> {
    const rows = await withPlatformScope(
      this.#db,
      async (sql) =>
        sql<{ pack_id: string; pack_version: string }[]>`
        SELECT pack_id, pack_version FROM packs
         WHERE status = 'published'
           AND jurisdiction = ${jurisdiction}
           AND reporting_framework = ${framework}
           AND effective_from <= ${asOf}::date
           AND (effective_to IS NULL OR effective_to >= ${asOf}::date)
         ORDER BY effective_from DESC, pack_version DESC
         LIMIT 1
      `,
    );
    return rows[0] ?? null;
  }

  /**
   * Pin the module versions in force for this as-of date.
   *
   * s.3.2: the pin lasts for the context's lifetime, so a knowledge publish
   * mid-graph cannot change what a citation points at.
   */
  async #pinModules(
    packId: string,
    packVersion: string,
    asOf: DateOnly,
  ): Promise<ResolvedContext['knowledge_pin']['modules']> {
    return withPlatformScope(
      this.#db,
      async (sql) =>
        sql<
          {
            module_id: string;
            version: string;
            effective_from: DateOnly;
            effective_to: DateOnly | null;
          }[]
        >`
        SELECT DISTINCT ON (module_id)
               module_id, version, effective_from, effective_to
          FROM knowledge_chunks
         WHERE pack_id = ${packId} AND pack_version = ${packVersion}
           AND retired_at IS NULL
           AND effective_from <= ${asOf}::date
           AND (effective_to IS NULL OR effective_to >= ${asOf}::date)
         ORDER BY module_id, effective_from DESC
      `,
    );
  }

  async #resolveTtl(tenantId: string, entity: string): Promise<number> {
    const ttl = await this.#config.resolve<string>(tenantId, 'AS-RUL-CTX-001', { entity });
    if (!ttl.ok) return this.#defaultTtlMs;
    try {
      return durationToMs(String(ttl.value.value));
    } catch {
      return this.#defaultTtlMs;
    }
  }

  async #persist(
    context: ResolvedContext,
    request: ResolveRequest,
    scope?: TenantScope,
  ): Promise<ResolvedContext> {
    const tokenHash = contextTokenHash({
      jurisdiction: context.axes.jurisdiction.value,
      reporting_framework: context.axes.reporting_framework.value,
      legal_entity: context.axes.legal_entity.value,
      currency: context.axes.currency.value,
      as_of_date: context.axes.as_of_date.value,
      pack_version: context.pack.pack_version,
    });

    const write = async (s: TenantScope): Promise<void> => {
      await s.sql`
        INSERT INTO contexts (
          tenant_id, context_id, request_id, resolution_status, resolution_reason,
          axes, pack_id, pack_version, residency_zone, resolved_locale,
          fiscal_period, knowledge_pin, settings_snapshot_id, context_token_hash,
          resolved_at, expires_at
        ) VALUES (
          ${context.tenant_id}, ${context.context_id}, ${context.request_id},
          ${context.resolution_status}, ${context.resolution_reason},
          ${s.sql.json(context.axes as never)},
          ${context.pack.pack_id}, ${context.pack.pack_version},
          ${context.residency_zone}, ${context.resolved_locale},
          ${context.fiscal_period === undefined ? null : s.sql.json(context.fiscal_period)},
          ${s.sql.json(context.knowledge_pin as never)},
          ${request.settings_snapshot_id ?? null},
          ${tokenHash},
          ${context.resolved_at}::timestamptz, ${context.expires_at}::timestamptz
        )
      `;
    };

    if (scope) await write(scope);
    else
      await withTenant(
        this.#db,
        { tenantId: context.tenant_id, residencyZone: this.#residencyZone },
        write,
      );

    recordContextResolution({
      status: context.resolution_status,
      jurisdiction: context.axes.jurisdiction.value,
      framework: context.axes.reporting_framework.value,
      coverage_tier: context.axes.jurisdiction.coverage_tier,
    });

    return context;
  }

  /** The token hash that feeds tool-call idempotency derivation (s.8.1). */
  static tokenHashOf(context: ResolvedContext): string {
    return contextTokenHash({
      jurisdiction: context.axes.jurisdiction.value,
      reporting_framework: context.axes.reporting_framework.value,
      legal_entity: context.axes.legal_entity.value,
      currency: context.axes.currency.value,
      as_of_date: context.axes.as_of_date.value,
      pack_version: context.pack.pack_version,
    });
  }
}

export const isRefused = (context: ResolvedContext): boolean =>
  context.resolution_status === 'refused';

/** A refusal message a human can act on, built from the recorded reason. */
export function refusalMessage(context: ResolvedContext): string {
  const [axis, ...rest] = (context.resolution_reason ?? '').split(': ');
  const reason = rest.join(': ');
  return (
    `I cannot start this without resolving the ${String(axis).replace(/_/g, ' ')}. ` +
    `${reason}\n` +
    'No work proceeds on an unresolved context, because every figure and every citation ' +
    'depends on which entity, framework and date apply.'
  );
}

export const contextExpiresAt = (context: ResolvedContext): Timestamp =>
  toTimestamp(context.expires_at);
