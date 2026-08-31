/**
 * C8 — the Skill Runtime.
 *
 *   D2: "Nothing calls a model except C9, and C9 is called only by C8."
 *   D5: "C6 is consulted by C7, never by C8; A SKILL CANNOT ASK FOR ITS OWN
 *        PERMISSION." The eslint config forbids this package from importing
 *        @eiaaw/policy at all.
 *   s.3.8: `mode` is "set by C7, never by the skill".
 *
 * One invocation does: ground → assemble → call the model → gate → record.
 * The gates run here, in the live path, not only in CI (roadmap s.4.1) — an
 * answer that fails the grounding gate never reaches the delivery service.
 */
import {
  type Money,
  type Result,
  WorkerError,
  err,
  hashObject,
  money,
  newId,
  ok,
} from '@eiaaw/core';
import type {
  Citation,
  QualityCriterionResult,
  ResolvedContext,
  SkillInvocation,
  SkillMode,
} from '@eiaaw/contracts';
import { type Database, type TenantScope, withTenant } from '@eiaaw/db';
import { type KnowledgeService, type RetrievedChunk } from '@eiaaw/knowledge';
import {
  type GatewayCallResult,
  type LlmGateway,
  type ModelRoute,
  assemblePrompt,
  detectInjection,
  newFenceNonce,
  systemContract,
} from '@eiaaw/llm';
import type { SkillRow } from '@eiaaw/registry';
import {
  arithmeticGate,
  consistencyGate,
  extractCitations,
  groundingGate,
  isSubstantive,
  splitClaims,
  type ArithmeticAssertion,
  type GateFinding,
} from '@eiaaw/assurance';
import { recordGateResult, withSpan } from '@eiaaw/telemetry';

export interface InvokeSkillInput {
  readonly tenant_id: string;
  readonly graph_id: string;
  readonly node_id: string;
  readonly trace_id: string;
  readonly skill: SkillRow;
  /** Set by C7. A skill never chooses its own mode. */
  readonly mode: SkillMode;
  readonly context: ResolvedContext;
  readonly route: ModelRoute;
  readonly inputs: Record<string, unknown>;
  /** Everything a person or a document said. Always segment 5. */
  readonly untrusted: readonly { readonly source: string; readonly text: string }[];
  readonly records?: readonly {
    readonly used: SkillInvocation['records_used'][number];
    readonly summary: string;
  }[];
  readonly budget_remaining: Money;
  readonly tokens_remaining: number;
  readonly effective_autonomy: 'observe' | 'draft' | 'execute';
  readonly state_changing: boolean;
  readonly channel: string;
  readonly scope_card_version: string;
  readonly worker_name: string;
  /** Arithmetic the skill declared, for the gate to recompute independently. */
  readonly arithmetic?: readonly ArithmeticAssertion[];
}

export interface SkillResult {
  readonly invocation: SkillInvocation;
  readonly output: string;
  readonly citations: readonly Citation[];
  readonly gates: {
    readonly grounding_gate: 'pass' | 'fail' | 'not_applicable';
    readonly arithmetic_gate: 'pass' | 'fail' | 'not_applicable';
    readonly consistency_gate: 'pass' | 'fail' | 'not_applicable';
  };
  readonly findings: readonly GateFinding[];
  /** s.11.3 — a fallback ran on a state-changing execute node. */
  readonly downgrade_to_draft: boolean;
  readonly injection_findings: readonly { label: string; source: string }[];
}

export interface SkillRuntimeOptions {
  readonly db: Database;
  readonly residencyZone: string;
  readonly knowledge: KnowledgeService;
  readonly gateway: LlmGateway;
  readonly harnessVersion: string;
}

export class SkillRuntime {
  readonly #db: Database;
  readonly #residencyZone: string;
  readonly #knowledge: KnowledgeService;
  readonly #gateway: LlmGateway;
  readonly #harnessVersion: string;

  constructor(options: SkillRuntimeOptions) {
    this.#db = options.db;
    this.#residencyZone = options.residencyZone;
    this.#knowledge = options.knowledge;
    this.#gateway = options.gateway;
    this.#harnessVersion = options.harnessVersion;
  }

  async invoke(input: InvokeSkillInput, scope?: TenantScope): Promise<Result<SkillResult>> {
    const invocationId = newId('skillInvocation');
    const started = Date.now();

    return withSpan(
      'skill.invoke',
      { tenant_id: input.tenant_id, trace_id: input.trace_id, graph_id: input.graph_id },
      {
        skill_id: input.skill.skill_id,
        skill_version: input.skill.semantic_version,
        mode: input.mode,
      },
      async () => this.#run(input, invocationId, started, scope),
    );
  }

  async #run(
    input: InvokeSkillInput,
    invocationId: string,
    started: number,
    scope?: TenantScope,
  ): Promise<Result<SkillResult>> {
    // --- injection detection (visible, not load-bearing) -------------------
    const injectionFindings = detectInjection(input.untrusted);

    // --- ground ------------------------------------------------------------
    const query = this.#buildQuery(input);
    const grounded = await this.#knowledge.ground(
      input.context,
      query,
      {
        modules: input.skill.required_knowledge.flatMap((k) => k.l2_modules),
        graph_id: input.graph_id,
      },
      scope,
    );

    if (!grounded.ok) {
      // CITE OR REFUSE. A grounding failure is a halt, not a degraded answer.
      const invocation = this.#buildInvocation({
        input,
        invocationId,
        started,
        knowledgeUsed: [],
        output: null,
        citations: [],
        qualityResults: [],
        gateway: null,
        status: 'refused',
      });
      await this.#persist(input.tenant_id, invocation, scope);
      return err(grounded.error);
    }

    // --- assemble ----------------------------------------------------------
    const prompt = assemblePrompt(
      {
        systemContract: systemContract({
          skillPurpose: input.skill.purpose,
          qualityCriteria: input.skill.quality_criteria,
          mode: input.mode,
          workerName: input.worker_name,
          scopeCardVersion: input.scope_card_version,
        }),
        context: input.context,
        grounding: grounded.value.chunks.map((chunk: RetrievedChunk) => ({
          chunk_id: chunk.chunk_id,
          module_id: chunk.module_id,
          version: chunk.version,
          citation_locator: chunk.citation_locator,
          effective_from: chunk.effective_from,
          effective_to: chunk.effective_to,
          content: chunk.content,
        })),
        records: (input.records ?? []).map((r) => ({ used: r.used, summary: r.summary })),
        untrusted: input.untrusted,
      },
      newFenceNonce(),
    );

    // --- call the model ----------------------------------------------------
    const call = await this.#gateway.call({
      tenant_id: input.tenant_id,
      graph_id: input.graph_id,
      node_id: input.node_id,
      skill_id: input.skill.skill_id,
      mode: input.mode,
      route: input.route,
      prompt,
      channel: input.channel,
      entity_id: input.context.axes.legal_entity.value,
      trace_id: input.trace_id,
      budget_remaining: input.budget_remaining,
      tokens_remaining: input.tokens_remaining,
      state_changing: input.state_changing,
      effective_autonomy: input.effective_autonomy,
    });

    if (!call.ok) {
      const invocation = this.#buildInvocation({
        input,
        invocationId,
        started,
        knowledgeUsed: grounded.value.used,
        output: null,
        citations: [],
        qualityResults: [],
        gateway: null,
        status: call.error.failureClass === 'budget' ? 'halted' : 'failed',
      });
      await this.#persist(input.tenant_id, invocation, scope);
      return err(call.error);
    }

    const output = call.value.text;
    const citations = this.#extractCitations(output, grounded.value.chunks);

    // --- gates, in the LIVE path -------------------------------------------
    const isRefusal = /^I cannot /m.test(output);

    const grounding = groundingGate({
      output,
      knowledgeUsed: grounded.value.used,
      asOfDate: input.context.axes.as_of_date.value,
      isRefusal,
    });

    const arithmetic = arithmeticGate(input.arithmetic ?? []);

    const consistency = consistencyGate({
      quantities: this.#extractQuantities(output),
      ...(input.context.fiscal_period
        ? {
            period: {
              start: input.context.fiscal_period.start_date,
              end: input.context.fiscal_period.end_date,
            },
          }
        : {}),
    });

    recordGateResult('grounding', input.skill.skill_id, grounding.result);
    recordGateResult('arithmetic', input.skill.skill_id, arithmetic.result);

    const findings = [...grounding.findings, ...arithmetic.findings, ...consistency.findings];
    const gatesFailed =
      grounding.result === 'fail' || arithmetic.result === 'fail' || consistency.result === 'fail';

    const qualityResults = this.#evaluateQualityCriteria(input.skill, output, citations);

    const invocation = this.#buildInvocation({
      input,
      invocationId,
      started,
      knowledgeUsed: grounded.value.used,
      output,
      citations,
      qualityResults,
      gateway: call.value,
      status: gatesFailed ? 'halted' : 'succeeded',
    });

    await this.#persist(input.tenant_id, invocation, scope);

    if (gatesFailed) {
      // s.7.4: a gate failure is a HALT. It is not retried and it is not
      // downgraded into a caveated answer.
      return err(
        new WorkerError('unprocessable_content', {
          detail:
            'The output did not pass the assurance gates and will not be delivered.\n' +
            findings.map((f) => `  ${f.gate}: ${f.detail}`).join('\n'),
          failureClass: 'grounding',
          retryable: false,
          context: {
            grounding_gate: grounding.result,
            arithmetic_gate: arithmetic.result,
            consistency_gate: consistency.result,
            findings,
          },
        }),
      );
    }

    return ok({
      invocation,
      output,
      citations,
      gates: {
        grounding_gate: grounding.result,
        arithmetic_gate: arithmetic.result,
        consistency_gate: consistency.result,
      },
      findings,
      downgrade_to_draft: call.value.downgrade_to_draft,
      injection_findings: injectionFindings.map((f) => ({ label: f.label, source: f.source })),
    });
  }

  /**
   * Bind the skill's query template to the resolved context.
   *
   * file 05 s.2.2: the template is written with `{}` placeholders "bound from
   * the L0 context" — never from user text, which would let untrusted content
   * steer retrieval.
   */
  #buildQuery(input: InvokeSkillInput): string {
    const axes = input.context.axes;
    const bindings: Record<string, string> = {
      entity: axes.legal_entity.value,
      framework: axes.reporting_framework.value,
      jurisdiction: axes.jurisdiction.value,
      currency: axes.currency.value,
      as_of_date: axes.as_of_date.value,
    };

    const templates = input.skill.required_knowledge.map((k) =>
      k.query_template.replace(/\{(\w+)\}/g, (whole, key: string) => bindings[key] ?? whole),
    );

    // The user's own words are appended as retrieval *signal*, but the
    // template — which is platform-controlled — leads.
    const userSignal = input.untrusted
      .map((u) => u.text)
      .join(' ')
      .slice(0, 500);

    return [...templates, userSignal].filter(Boolean).join(' ');
  }

  #extractCitations(output: string, chunks: readonly RetrievedChunk[]): Citation[] {
    const byId = new Map(chunks.map((c) => [c.chunk_id, c]));
    const citations: Citation[] = [];

    for (const claim of splitClaims(output)) {
      if (!isSubstantive(claim.text)) continue;
      for (const chunkId of extractCitations(claim.text)) {
        const chunk = byId.get(chunkId);
        if (!chunk) continue;
        citations.push({
          claim_ref: claim.ref,
          chunk_id: chunk.chunk_id,
          version: chunk.version,
          effective_from: chunk.effective_from,
          locator: chunk.citation_locator,
        });
      }
    }

    return citations;
  }

  /**
   * Pull named quantities out of the output for the consistency gate.
   *
   * Matches "<label>: RM 1,234.56" and "<label> is 1,234.56", which is how the
   * response contract asks for figures to be presented.
   */
  #extractQuantities(output: string): { name: string; value: string; where: string }[] {
    const found: { name: string; value: string; where: string }[] = [];
    const pattern = /([A-Za-z][A-Za-z -]{2,40}?)\s*(?::|\bis\b)\s*(?:RM\s?)?([\d,]+\.\d{2})\b/g;

    for (const match of output.matchAll(pattern)) {
      found.push({
        name: (match[1] as string).trim().toLowerCase(),
        value: (match[2] as string).replace(/,/g, ''),
        where: `offset ${match.index ?? 0}`,
      });
    }
    return found;
  }

  /**
   * Evaluate the skill's quality criteria.
   *
   * Two are universal and machine-checkable (file 05 s.2.2): full citation
   * coverage, and arithmetic consistency. The rest are SOP-derived assertions
   * that are recorded for the evidence bundle and for human review — the
   * runtime does not pretend to have verified a criterion it cannot test.
   */
  #evaluateQualityCriteria(
    skill: SkillRow,
    output: string,
    citations: readonly Citation[],
  ): { criterion: string; result: QualityCriterionResult; detail?: string }[] {
    const substantive = splitClaims(output).filter((c) => isSubstantive(c.text));
    const cited = substantive.filter((c) => extractCitations(c.text).length > 0);

    const universal: { criterion: string; result: QualityCriterionResult; detail?: string }[] = [
      {
        criterion: 'Every substantive claim carries a citation',
        result:
          substantive.length === 0
            ? 'not_applicable'
            : cited.length === substantive.length
              ? 'pass'
              : 'fail',
        detail: `${cited.length}/${substantive.length} substantive claims cited`,
      },
      {
        criterion: 'Every citation resolves to a retrieved chunk',
        result: citations.length > 0 ? 'pass' : 'not_applicable',
      },
    ];

    const declared: typeof universal = skill.quality_criteria.map((criterion) => ({
      criterion,
      // Recorded as untested rather than asserted as passed: claiming a pass
      // for a criterion nothing evaluated is how an evidence bundle becomes
      // misleading.
      result: 'not_applicable',
      detail: 'recorded for human review; not machine-checkable',
    }));

    return [...universal, ...declared];
  }

  #buildInvocation(parts: {
    input: InvokeSkillInput;
    invocationId: string;
    started: number;
    knowledgeUsed: SkillInvocation['knowledge_used'];
    output: string | null;
    citations: readonly Citation[];
    qualityResults: SkillInvocation['quality_criteria_results'];
    gateway: GatewayCallResult | null;
    status: SkillInvocation['status'];
  }): SkillInvocation {
    const { input } = parts;
    return {
      schema_version: '1.0.0',
      invocation_id: parts.invocationId,
      graph_id: input.graph_id,
      node_id: input.node_id,
      skill_id: input.skill.skill_id,
      skill_version: input.skill.semantic_version,
      mode: input.mode,
      context_ref: input.context.context_id,
      inputs_ref: `obj://inputs/${parts.invocationId}`,
      inputs_hash: hashObject(input.inputs),
      knowledge_used: parts.knowledgeUsed,
      records_used: (input.records ?? []).map((r) => r.used),
      tool_call_ids: [],
      model_route: {
        route_id: input.route.route_id,
        model: parts.gateway?.model ?? input.route.primary.model,
        fallback_used: parts.gateway?.fallback_used ?? false,
      },
      output_ref: parts.output === null ? null : `obj://outputs/${parts.invocationId}`,
      output_hash: parts.output === null ? null : hashObject(parts.output),
      citations: parts.citations,
      quality_criteria_results: parts.qualityResults,
      tokens: parts.gateway?.tokens ?? { input: 0, output: 0 },
      cost: parts.gateway?.cost ?? money(0, input.budget_remaining.currency),
      duration_ms: Date.now() - parts.started,
      status: parts.status,
    };
  }

  async #persist(
    tenantId: string,
    invocation: SkillInvocation,
    scope?: TenantScope,
  ): Promise<void> {
    const write = async (s: TenantScope): Promise<void> => {
      await s.sql`
        INSERT INTO skill_invocations (
          tenant_id, invocation_id, graph_id, node_id, skill_id, skill_version, mode,
          context_ref, inputs_ref, inputs_hash, knowledge_used, records_used,
          tool_call_ids, model_route, output_ref, output_hash, citations,
          quality_criteria_results, tokens_input, tokens_output, cost_minor,
          cost_currency, duration_ms, status
        ) VALUES (
          ${s.tenantId}, ${invocation.invocation_id}, ${invocation.graph_id},
          ${invocation.node_id}, ${invocation.skill_id}, ${invocation.skill_version},
          ${invocation.mode}, ${invocation.context_ref}, ${invocation.inputs_ref},
          ${invocation.inputs_hash},
          ${s.sql.json(invocation.knowledge_used as never)},
          ${s.sql.json(invocation.records_used as never)},
          ${invocation.tool_call_ids},
          ${s.sql.json(invocation.model_route)},
          ${invocation.output_ref}, ${invocation.output_hash},
          ${s.sql.json(invocation.citations as never)},
          ${s.sql.json(invocation.quality_criteria_results)},
          ${invocation.tokens.input}, ${invocation.tokens.output},
          ${invocation.cost.amount_minor}, ${invocation.cost.currency},
          ${invocation.duration_ms}, ${invocation.status}
        )
        ON CONFLICT DO NOTHING
      `;
    };

    if (scope) await write(scope);
    else await withTenant(this.#db, { tenantId, residencyZone: this.#residencyZone }, write);
  }

  get harnessVersion(): string {
    return this.#harnessVersion;
  }
}
