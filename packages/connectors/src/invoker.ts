/**
 * C10 — the Tool Invoker and Connector Runtime.
 *
 *   D1:      "Nothing calls a system of record except C10, and C10 calls only
 *             what the registry declares."
 *   s.15.1:  "Tool invoker at S7, before orchestration. Orchestration must never
 *             be able to call a system directly, and the only way to guarantee
 *             that is for the invoker to exist first."
 *   s.14.3:  "Dry-run is forced on for every state-changing tool in dev, test and
 *             staging, AT THE RUNTIME, not by configuration a developer can flip."
 *   s.8.2:   reservation is atomic, so "a retry can never double-post" is a
 *             mechanism rather than an aspiration.
 *
 * The order of checks below is deliberate and is the security model:
 *
 *   registry → forbidden scope → grant → dry-run → authority → idempotency
 *
 * Scope is checked before authority because a capability the credential should
 * never hold must be refused even if a policy bug said "allow".
 */
import {
  type Money,
  type Result,
  WorkerError,
  err,
  hashObject,
  money,
  newId,
  now,
  ok,
} from '@eiaaw/core';
import type { AutonomyLevel, ToolCall, ToolOutcome } from '@eiaaw/contracts';
import { type Database, type TenantScope, withTenant } from '@eiaaw/db';
import { isForbiddenScope, lookupTool, type ToolEntry } from '@eiaaw/registry';
import { recordToolCall, recordToolCost, withSpan } from '@eiaaw/telemetry';

/** What a connector must implement. The registry declares; this performs. */
export interface Connector {
  readonly id: string;
  readonly version: string;
  /** Tool ids this connector serves. */
  readonly tools: readonly string[];
  invoke(input: ConnectorInvocation): Promise<ConnectorResult>;
  health?(): Promise<{ ok: boolean; detail?: string }>;
}

export interface ConnectorInvocation {
  readonly tool_id: string;
  readonly args: Record<string, unknown>;
  readonly scope_qualifiers: Record<string, unknown>;
  readonly dry_run: boolean;
  readonly idempotency_key: string | undefined;
  readonly tenant_id: string;
  readonly attempt: number;
}

export interface ConnectorResult {
  readonly output: unknown;
  readonly provider_reference?: string;
  readonly business_key?: string;
  readonly rate_limit_remaining?: number;
  readonly cost?: Money;
}

export interface InvokeInput {
  readonly tenant_id: string;
  readonly graph_id: string;
  readonly node_id: string;
  readonly invocation_id: string | null;
  readonly tool_id: string;
  readonly args: Record<string, unknown>;
  readonly scope_qualifiers: Record<string, unknown>;
  readonly permission_scope_requested: string;
  readonly authority: {
    readonly autonomy: AutonomyLevel;
    readonly policy_verdict_id: string | null;
    readonly approval_ref: string | null;
  };
  readonly idempotency_key?: string;
  readonly business_key?: string;
  readonly trace_id: string;
  readonly attempt?: number;
}

export interface ToolGrant {
  readonly graduation_stage: 1 | 2 | 3 | 4;
  readonly dry_run_forced: boolean;
  readonly granted_scopes: readonly string[];
  readonly enabled: boolean;
}

export interface ToolInvokerOptions {
  readonly db: Database;
  readonly residencyZone: string;
  /** Derived from DEPLOY_ENVIRONMENT, never read from config directly. */
  readonly forceDryRun: boolean;
  readonly connectors: readonly Connector[];
  readonly defaultCurrency?: string;
}

export class ToolInvoker {
  readonly #db: Database;
  readonly #residencyZone: string;
  readonly #forceDryRun: boolean;
  readonly #byTool = new Map<string, Connector>();
  readonly #currency: string;

  constructor(options: ToolInvokerOptions) {
    this.#db = options.db;
    this.#residencyZone = options.residencyZone;
    this.#forceDryRun = options.forceDryRun;
    this.#currency = options.defaultCurrency ?? 'MYR';

    for (const connector of options.connectors) {
      for (const toolId of connector.tools) {
        this.#byTool.set(toolId, connector);
      }
    }
  }

  async invoke(input: InvokeInput): Promise<Result<ToolCall>> {
    const attempt = input.attempt ?? 1;

    // --- 1. registry ------------------------------------------------------
    const tool = lookupTool(input.tool_id);
    if (!tool) {
      return err(
        new WorkerError('scope_denied', {
          detail:
            `"${input.tool_id}" is not in the L6 tool registry. Nothing outside the registry ` +
            'is callable, however it is reached (file 05 s.10).',
          failureClass: 'tool',
          retryable: false,
        }),
      );
    }

    // --- 2. forbidden scope, before anything else -------------------------
    // A capability the worker must never hold is refused even if a policy bug
    // said allow. This is the L6 half of defence in depth (file 01 s.7.3).
    if (isForbiddenScope(input.permission_scope_requested)) {
      return err(
        new WorkerError('scope_denied', {
          detail:
            `Scope "${input.permission_scope_requested}" is on the forbidden list. It ` +
            'corresponds to a reserved act and is denied at the credential, not merely by ' +
            'policy. A reserved act protected by policy alone is treated as unprotected.',
          failureClass: 'policy',
          retryable: false,
        }),
      );
    }

    if (tool.permission_scope !== input.permission_scope_requested) {
      return err(
        new WorkerError('scope_denied', {
          detail:
            `${tool.tool_id} declares scope "${tool.permission_scope}" but "` +
            `${input.permission_scope_requested}" was requested. A difference is a refusal, ` +
            'never a downgrade-and-proceed (DWD-06 s.3.9).',
          failureClass: 'policy',
          retryable: false,
        }),
      );
    }

    // --- 3. tenant grant --------------------------------------------------
    const grant = await this.#loadGrant(input.tenant_id, input.tool_id);
    if (!grant || !grant.enabled) {
      return err(
        new WorkerError('scope_denied', {
          detail:
            `${tool.tool_id} is not enabled for this tenant. A tool is granted per tenant and ` +
            'graduates per connector and per tool, never per system (file 05 s.11.3).',
          failureClass: 'tool',
          retryable: false,
        }),
      );
    }

    if (!grant.granted_scopes.includes(tool.permission_scope)) {
      return err(
        new WorkerError('scope_denied', {
          detail:
            `The credential for this tenant does not hold "${tool.permission_scope}". The ` +
            'prohibition survives a policy misconfiguration because the scope is absent from ' +
            'the credential itself.',
          failureClass: 'policy',
          retryable: false,
        }),
      );
    }

    // --- 4. dry-run, decided by the RUNTIME -------------------------------
    const dryRun = this.#resolveDryRun(tool, grant, input.authority.autonomy);

    // --- 5. authority -----------------------------------------------------
    if (tool.state_changing && !dryRun) {
      if (input.authority.autonomy !== 'execute') {
        return err(
          new WorkerError('authority_insufficient', {
            detail:
              `${tool.tool_id} changes state, but this row is at ` +
              `"${input.authority.autonomy}". A live write requires Execute autonomy.`,
            failureClass: 'policy',
            retryable: false,
          }),
        );
      }
      if (input.authority.policy_verdict_id === null) {
        return err(
          new WorkerError('authority_insufficient', {
            detail:
              'A state-changing call must reference the policy verdict that permitted it. ' +
              'A tool call without an authority reference is a red flag (DWD-06 s.3.9).',
            failureClass: 'policy',
            retryable: false,
          }),
        );
      }
      // An irreversible act is never Execute (file 01 s.5.5).
      if (tool.irreversible === true && input.authority.approval_ref === null) {
        return err(
          new WorkerError('authority_insufficient', {
            detail:
              `${tool.tool_id} is irreversible, so it requires a recorded human approval. ` +
              'An irreversible action is never taken unattended.',
            failureClass: 'policy',
            retryable: false,
          }),
        );
      }
    }

    // --- 6. idempotency ---------------------------------------------------
    if (tool.idempotency_key_required && input.idempotency_key === undefined) {
      return err(
        new WorkerError('contract_invalid', {
          detail:
            `${tool.tool_id} requires an idempotency key, derived at compile time from ` +
            'business identity. A key computed at call time cannot make a retry safe.',
          failureClass: 'tool',
          retryable: false,
        }),
      );
    }

    const requestHash = hashObject({ tool_id: tool.tool_id, args: input.args });

    if (input.idempotency_key !== undefined && !dryRun) {
      const reservation = await this.#reserve(input.tenant_id, input.idempotency_key, requestHash);

      if (reservation.kind === 'replay') {
        // s.8.3: a duplicate returns the ORIGINAL outcome. No provider call.
        return ok(reservation.original);
      }
      if (reservation.kind === 'conflict') {
        return err(
          new WorkerError('state_conflict', {
            detail:
              'This idempotency key has already been used with a different payload. A changed ' +
              'payload under a reused key is a defect, never an update (DWD-06 s.8.2).',
            failureClass: 'tool',
            retryable: false,
          }),
        );
      }
      if (reservation.kind === 'in_flight') {
        return err(
          new WorkerError('duplicate_request', {
            detail: 'An identical call is already in flight. Waiting for the original.',
            failureClass: 'tool',
            retryable: true,
            retryAfterSeconds: 2,
          }),
        );
      }
    }

    // --- perform ----------------------------------------------------------
    const connector = this.#byTool.get(tool.tool_id);
    if (!connector) {
      return err(
        new WorkerError('dependency_unavailable', {
          detail: `No connector is registered to serve ${tool.tool_id}.`,
          failureClass: 'tool',
          retryable: false,
        }),
      );
    }

    const toolCallId = newId('toolCall');
    const startedAt = now();

    try {
      const result = await withSpan(
        'tool.invoke',
        { tenant_id: input.tenant_id, trace_id: input.trace_id, graph_id: input.graph_id },
        {
          tool_id: tool.tool_id,
          scope_granted: tool.permission_scope,
          state_changing: tool.state_changing,
          dry_run: dryRun,
          idempotency_key_hash: input.idempotency_key?.slice(0, 16) ?? '',
        },
        async () =>
          connector.invoke({
            tool_id: tool.tool_id,
            args: input.args,
            scope_qualifiers: input.scope_qualifiers,
            dry_run: dryRun,
            idempotency_key: input.idempotency_key,
            tenant_id: input.tenant_id,
            attempt,
          }),
      );

      const cost = result.cost ?? money(0, this.#currency);
      const call = this.#buildCall({
        input,
        tool,
        toolCallId,
        startedAt,
        dryRun,
        requestHash,
        outcome: dryRun ? 'dry_run' : 'success',
        result,
        cost,
        attempt,
      });

      await this.#persist(input.tenant_id, call);

      if (input.idempotency_key !== undefined && !dryRun) {
        await this.#complete(input.tenant_id, input.idempotency_key, call);
      }

      recordToolCall({
        tool: tool.tool_id,
        outcome: call.outcome,
        dry_run: dryRun,
        state_changing: tool.state_changing,
      });
      recordToolCost(tool.tool_id, input.tenant_id, cost.amount_minor);

      return ok(call);
    } catch (error) {
      const failure = {
        class: 'tool',
        code: error instanceof WorkerError ? error.code : 'connector_error',
        message: error instanceof Error ? error.message : String(error),
        retryable: error instanceof WorkerError ? error.retryable : true,
      };

      const call = this.#buildCall({
        input,
        tool,
        toolCallId,
        startedAt,
        dryRun,
        requestHash,
        outcome: 'failure',
        result: { output: null },
        cost: money(0, this.#currency),
        attempt,
        failure,
      });

      await this.#persist(input.tenant_id, call);

      // A permanent failure closes the key so a later identical call returns
      // the same failure rather than trying again forever.
      if (input.idempotency_key !== undefined && !dryRun && !failure.retryable) {
        await this.#failPermanently(input.tenant_id, input.idempotency_key);
      }

      recordToolCall({
        tool: tool.tool_id,
        outcome: 'failure',
        dry_run: dryRun,
        state_changing: tool.state_changing,
      });

      return err(
        new WorkerError('dependency_unavailable', {
          detail: failure.message,
          failureClass: 'tool',
          retryable: failure.retryable,
          context: { tool_id: tool.tool_id, tool_call_id: toolCallId },
        }),
      );
    }
  }

  /**
   * Decide dry-run.
   *
   * s.14.3: forced on outside prod "at the runtime, not by configuration a
   * developer can flip". `#forceDryRun` is derived from DEPLOY_ENVIRONMENT, and
   * there is no branch here that a tenant setting can widen.
   */
  #resolveDryRun(tool: ToolEntry, grant: ToolGrant, autonomy: AutonomyLevel): boolean {
    if (!tool.state_changing) return false;
    if (this.#forceDryRun) return true;
    if (grant.dry_run_forced) return true;
    // Graduation stage 4 is the only stage at which a live write happens
    // (file 05 s.11.2).
    if (grant.graduation_stage < 4) return true;
    if (autonomy !== 'execute') return true;
    return false;
  }

  async #loadGrant(tenantId: string, toolId: string): Promise<ToolGrant | null> {
    const rows = await withTenant(
      this.#db,
      { tenantId, residencyZone: this.#residencyZone, readOnly: true },
      async (s) =>
        s.sql<
          {
            graduation_stage: number;
            dry_run_forced: boolean;
            granted_scopes: string[];
            enabled: boolean;
          }[]
        >`
          SELECT graduation_stage, dry_run_forced, granted_scopes, enabled
            FROM tool_grants WHERE tenant_id = ${tenantId} AND tool_id = ${toolId}
        `,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      graduation_stage: row.graduation_stage as 1 | 2 | 3 | 4,
      dry_run_forced: row.dry_run_forced,
      granted_scopes: row.granted_scopes,
      enabled: row.enabled,
    };
  }

  /**
   * Atomic reservation — the mechanism behind "a retry can never double-post".
   *
   * A conditional insert. Two concurrent workers cannot both proceed, because
   * exactly one INSERT wins the unique constraint.
   */
  async #reserve(
    tenantId: string,
    key: string,
    requestHash: string,
  ): Promise<
    | { kind: 'reserved' }
    | { kind: 'replay'; original: ToolCall }
    | { kind: 'conflict' }
    | { kind: 'in_flight' }
  > {
    return withTenant(this.#db, { tenantId, residencyZone: this.#residencyZone }, async (s) => {
      // `ON CONFLICT DO NOTHING RETURNING` rather than catching a unique
      // violation: a failed statement poisons the surrounding transaction, so
      // the "already reserved" path could not then read the existing record.
      // Returning zero rows is the same signal without the damage.
      const claimed = await s.sql<{ key: string }[]>`
          INSERT INTO idempotency_records (
            tenant_id, key, family, state, request_hash, expires_at
          ) VALUES (
            ${tenantId}, ${key}, 'tool_call', 'in_flight', ${requestHash},
            now() + interval '1 year'
          )
          ON CONFLICT (tenant_id, key) DO NOTHING
          RETURNING key
        `;

      if (claimed.length === 1) return { kind: 'reserved' as const };

      const rows = await s.sql<
        { state: string; request_hash: string; outcome_body: ToolCall | null }[]
      >`
          SELECT state, request_hash, outcome_body FROM idempotency_records
           WHERE tenant_id = ${tenantId} AND key = ${key}
        `;
      const record = rows[0];
      if (!record) return { kind: 'reserved' as const };

      if (record.request_hash !== requestHash) return { kind: 'conflict' as const };
      if (record.state === 'in_flight') return { kind: 'in_flight' as const };
      if (record.outcome_body) return { kind: 'replay' as const, original: record.outcome_body };
      return { kind: 'in_flight' as const };
    });
  }

  async #complete(tenantId: string, key: string, call: ToolCall): Promise<void> {
    await withTenant(this.#db, { tenantId, residencyZone: this.#residencyZone }, async (s) => {
      await s.sql`
        UPDATE idempotency_records
           SET state = 'completed', completed_at = now(),
               outcome_ref = ${call.tool_call_id},
               provider_reference = ${call.provider_reference ?? null},
               outcome_body = ${s.sql.json(call as never)}
         WHERE tenant_id = ${tenantId} AND key = ${key}
      `;
    });
  }

  async #failPermanently(tenantId: string, key: string): Promise<void> {
    await withTenant(this.#db, { tenantId, residencyZone: this.#residencyZone }, async (s) => {
      await s.sql`
        UPDATE idempotency_records SET state = 'failed_permanent', completed_at = now()
         WHERE tenant_id = ${tenantId} AND key = ${key}
      `;
    });
  }

  #buildCall(parts: {
    input: InvokeInput;
    tool: ToolEntry;
    toolCallId: string;
    startedAt: string;
    dryRun: boolean;
    requestHash: string;
    outcome: ToolOutcome;
    result: Partial<ConnectorResult>;
    cost: Money;
    attempt: number;
    failure?: { class: string; code: string; message: string; retryable: boolean };
  }): ToolCall {
    return {
      schema_version: '1.0.0',
      tool_call_id: parts.toolCallId,
      graph_id: parts.input.graph_id,
      node_id: parts.input.node_id,
      invocation_id: parts.input.invocation_id,
      tool_id: parts.tool.tool_id,
      capability_schema_version: '1.0.0',
      permission_scope_requested: parts.input.permission_scope_requested,
      permission_scope_granted: parts.tool.permission_scope,
      scope_qualifiers: parts.input.scope_qualifiers as ToolCall['scope_qualifiers'],
      authority_ref: parts.input.authority,
      state_changing: parts.tool.state_changing,
      dry_run: parts.dryRun,
      ...(parts.input.idempotency_key === undefined
        ? {}
        : { idempotency_key: parts.input.idempotency_key }),
      request_hash: parts.requestHash,
      attempt: parts.attempt,
      started_at: parts.startedAt,
      ended_at: now(),
      outcome: parts.outcome,
      ...(parts.result.provider_reference === undefined
        ? {}
        : { provider_reference: parts.result.provider_reference }),
      ...(parts.input.business_key === undefined ? {} : { business_key: parts.input.business_key }),
      ...(parts.result.rate_limit_remaining === undefined
        ? {}
        : { rate_limit_remaining: parts.result.rate_limit_remaining }),
      cost: parts.cost,
      error: parts.failure ?? null,
      compensated_by: null,
    };
  }

  /**
   * Persist the call record.
   *
   * The tenant is passed explicitly rather than read from the contract: a
   * `ToolCall` carries no `tenant_id` (it is scoped by the graph), and RLS
   * would reject an insert attributed to the wrong one anyway.
   */
  async #persist(tenantId: string, call: ToolCall, scope?: TenantScope): Promise<void> {
    const write = async (s: TenantScope): Promise<void> => {
      await s.sql`
        INSERT INTO tool_calls (
          tenant_id, tool_call_id, graph_id, node_id, invocation_id, tool_id,
          capability_schema_version, permission_scope_requested, permission_scope_granted,
          scope_qualifiers, authority_ref, state_changing, dry_run, idempotency_key,
          request_hash, attempt, started_at, ended_at, outcome, provider_reference,
          business_key, rate_limit_remaining, cost_minor, cost_currency, error
        ) VALUES (
          ${s.tenantId}, ${call.tool_call_id}, ${call.graph_id}, ${call.node_id},
          ${call.invocation_id}, ${call.tool_id}, ${call.capability_schema_version},
          ${call.permission_scope_requested}, ${call.permission_scope_granted},
          ${s.sql.json(call.scope_qualifiers as never)},
          ${s.sql.json(call.authority_ref)},
          ${call.state_changing}, ${call.dry_run}, ${call.idempotency_key ?? null},
          ${call.request_hash}, ${call.attempt}, ${call.started_at}::timestamptz,
          ${call.ended_at}::timestamptz, ${call.outcome}, ${call.provider_reference ?? null},
          ${call.business_key ?? null}, ${call.rate_limit_remaining ?? null},
          ${call.cost.amount_minor}, ${call.cost.currency},
          ${call.error === null ? null : s.sql.json(call.error as never)}
        )
        ON CONFLICT DO NOTHING
      `;
    };

    if (scope) await write(scope);
    else await withTenant(this.#db, { tenantId, residencyZone: this.#residencyZone }, write);
  }
}
