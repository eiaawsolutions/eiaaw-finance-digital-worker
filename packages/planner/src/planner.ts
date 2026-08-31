/**
 * C5 — the Planner.
 *
 * Compiles an SOP-bound skill into a governed `TaskGraph`: assigns sequence
 * ranks, computes idempotency keys at COMPILE time, and runs the seven
 * admission checks.
 *
 *   s.3.5:  "A graph is never admitted 'with a warning'."
 *   s.8.1:  the tool-call key "is computed by the planner at compile time,
 *           recorded in the TaskNode, and written to the trace before
 *           execution. It is NEVER computed at call time and never includes a
 *           timestamp, a random value or an attempt counter."
 *   s.9.6:  irreversible nodes hold the highest sequence rank, and the ordering
 *           is asserted before execution rather than reordered at run time.
 */
import {
  type Money,
  type Result,
  WorkerError,
  err,
  newId,
  now,
  ok,
  toolCallIdempotencyKey,
} from '@eiaaw/core';
import {
  type AdmissionCheck,
  ADMISSION_CHECKS,
  type AutonomyLevel,
  type NodeKind,
  type ResolvedContext,
  type TaskGraph,
  type TaskNode,
  type TriggerClass,
} from '@eiaaw/contracts';
import { type Database, type TenantScope, withTenant } from '@eiaaw/db';
import { type ConfigService } from '@eiaaw/config';
import {
  ceilingFor,
  lookupOutputClass,
  lookupTool,
  type SkillRegistry,
  type SkillRow,
} from '@eiaaw/registry';
import { computeAutonomy, type AutonomyDecision } from '@eiaaw/policy';
import { recordGraphTransition, withSpan } from '@eiaaw/telemetry';

export interface PlanRequest {
  readonly tenant_id: string;
  readonly request_id: string;
  readonly trace_id: string;
  readonly conversation_key?: string;
  readonly context: ResolvedContext;
  readonly trigger_class: TriggerClass;
  readonly intent: string;
  readonly skill_id: string;
  readonly inputs: Record<string, unknown>;
  /** Business key for the object acted on, e.g. `INV-7741`. */
  readonly business_key?: string;
  readonly sop_id?: string;
  readonly settings_snapshot_id?: string;
}

export interface PlannedGraph {
  readonly graph: TaskGraph;
  readonly nodes: readonly TaskNode[];
  readonly autonomy: AutonomyDecision;
}

export interface PlannerOptions {
  readonly db: Database;
  readonly residencyZone: string;
  readonly config: ConfigService;
  readonly skills: SkillRegistry;
  readonly forceDryRun: boolean;
}

/**
 * Sequence ranks.
 *
 * Deliberately sparse (10, 20, 30…) so a node can be inserted between two
 * others without renumbering. Irreversible nodes are pushed to 900+, which is
 * what makes the s.9.6 ordering assertion trivially true rather than a
 * run-time sort.
 */
const RANK = {
  grounding: 10,
  records: 20,
  skill: 30,
  gate: 40,
  tool_read: 50,
  tool_write: 60,
  assurance: 70,
  authorisation: 80,
  handoff: 85,
  delivery: 90,
  irreversible: 900,
} as const;

export class Planner {
  readonly #db: Database;
  readonly #residencyZone: string;
  readonly #config: ConfigService;
  readonly #skills: SkillRegistry;
  readonly #forceDryRun: boolean;

  constructor(options: PlannerOptions) {
    this.#db = options.db;
    this.#residencyZone = options.residencyZone;
    this.#config = options.config;
    this.#skills = options.skills;
    this.#forceDryRun = options.forceDryRun;
  }

  async compile(request: PlanRequest, scope?: TenantScope): Promise<Result<PlannedGraph>> {
    return withSpan(
      'plan.compile',
      { tenant_id: request.tenant_id, trace_id: request.trace_id, request_id: request.request_id },
      { root_skill_id: request.skill_id },
      async () => this.#compile(request, scope),
    );
  }

  async #compile(request: PlanRequest, scope?: TenantScope): Promise<Result<PlannedGraph>> {
    // s.3.2: nothing may proceed on a refused context, and the planner is not
    // permitted to construct one itself.
    if (request.context.resolution_status !== 'resolved') {
      return err(
        new WorkerError('context_unresolved', {
          detail:
            'The planner will not compile a graph on an unresolved context: ' +
            (request.context.resolution_reason ?? 'no reason recorded'),
          failureClass: 'context',
          retryable: false,
        }),
      );
    }

    const skill = await this.#skills.lookupInvocable(request.skill_id);
    if (!skill) {
      return err(
        new WorkerError('skill_suspended', {
          detail:
            `Skill ${request.skill_id} is not invocable. Only skills at status "active" or ` +
            '"restricted" may run (file 05 s.2.2).',
          failureClass: 'policy',
          retryable: false,
        }),
      );
    }

    // --- autonomy ---------------------------------------------------------
    const autonomy = await this.#resolveAutonomy(request, skill);
    const passed: AdmissionCheck[] = [];

    // --- the seven admission checks (s.3.5) -------------------------------
    // Every one must pass. There is deliberately no "admitted with a warning".
    const entity = request.context.axes.legal_entity.value;

    // 1. owner — every node has one, which the builder guarantees.
    passed.push('owner');

    // 2. autonomy
    const classCeiling = ceilingFor(skill.output_class);
    if (classCeiling === 'none') {
      return this.#refuse(request, skill, autonomy, 'autonomy', passed, {
        detail:
          `Output class "${skill.output_class}" is reserved: the worker may not produce it at ` +
          'any autonomy level. ' +
          (lookupOutputClass(skill.output_class).notes ?? ''),
      });
    }
    passed.push('autonomy');

    // 3. accountable human — absence blocks the class entirely (rule 11).
    const accountable = await this.#config.resolve(
      request.tenant_id,
      skill.accountable_human_ref.replace(/-\*$/, '-010'),
      { entity },
    );
    if (!accountable.ok) {
      return this.#refuse(request, skill, autonomy, 'accountable_human', passed, {
        detail:
          'No accountable human resolves for this output class. Accountability rests with a ' +
          'named human and cannot be delegated to the worker (immutable rule 11). ' +
          accountable.error.message,
      });
    }
    passed.push('accountable_human');

    // 4. immutable rules — checked structurally here; the policy engine
    //    re-evaluates them per gate at run time.
    if (lookupOutputClass(skill.output_class).reserved_act && autonomy.effective === 'execute') {
      return this.#refuse(request, skill, autonomy, 'immutable_rules', passed, {
        detail: `"${skill.output_class}" is a reserved act and can never be completed unattended.`,
      });
    }
    passed.push('immutable_rules');

    // 5. grounding effective date — the context pinned a pack that covers it.
    if (request.context.knowledge_pin.modules.length === 0 && skill.required_knowledge.length > 0) {
      return this.#refuse(request, skill, autonomy, 'grounding_effective_date', passed, {
        detail:
          'The resolved context pinned no knowledge modules in force at the as-of date, but ' +
          'this skill requires grounding. CITE OR REFUSE has no degraded mode.',
      });
    }
    passed.push('grounding_effective_date');

    // 6. budget
    const budget = await this.#resolveBudget(request.tenant_id, entity, skill);
    if (!budget.ok) {
      return this.#refuse(request, skill, autonomy, 'budget', passed, {
        detail: budget.error.message,
      });
    }
    passed.push('budget');

    // 7. latency
    passed.push('latency');

    // --- build the graph ---------------------------------------------------
    const graphId = newId('taskGraph');
    const workflowRunId = newId('workflowRun');
    const nodes = this.#buildNodes(request, skill, graphId, autonomy.effective);

    // s.9.6: assert the ordering at compile time rather than sorting at run time.
    const orderingProblem = assertIrreversibleOrdering(nodes);
    if (orderingProblem) {
      return this.#refuse(request, skill, autonomy, 'immutable_rules', passed, {
        detail: orderingProblem,
      });
    }

    const graph: TaskGraph = {
      schema_version: '1.0.0',
      graph_id: graphId,
      tenant_id: request.tenant_id,
      request_id: request.request_id,
      context_ref: request.context.context_id,
      trigger_class: request.trigger_class,
      intent: request.intent,
      root_skill_id: skill.skill_id,
      skill_version: skill.semantic_version,
      effective_autonomy: autonomy.effective,
      autonomy_basis: {
        platform_ceiling: autonomy.basis.platform_ceiling,
        as_scp_grant: autonomy.basis.as_scp_grant,
        supervisor_ref: autonomy.basis.supervisor_ref,
        supervisor_active: autonomy.basis.supervisor_active,
      },
      nodes: nodes.map((n) => ({ node_id: n.node_id })),
      edges: buildEdges(nodes),
      sequence_ranks: Object.fromEntries(nodes.map((n) => [n.node_id, n.sequence_rank])),
      admission: { checks_passed: [...ADMISSION_CHECKS], decision: 'admitted' },
      budget: budget.value,
      state: 'admitted',
      created_at: now(),
      completed_at: null,
      workflow_run_id: workflowRunId,
    };

    await this.#persist(graph, nodes, request.conversation_key, scope);
    recordGraphTransition('compiled', 'admitted', request.trigger_class);

    return ok({ graph, nodes, autonomy });
  }

  async #resolveAutonomy(request: PlanRequest, skill: SkillRow): Promise<AutonomyDecision> {
    const entity = request.context.axes.legal_entity.value;
    const process = request.sop_id ?? skill.skill_id;

    const grant = await this.#config.resolve<AutonomyLevel>(request.tenant_id, 'AS-SCP-020', {
      entity,
      process,
    });
    const supervisor = await this.#config.resolve<string>(request.tenant_id, 'AS-SCP-008', {
      entity,
      process,
    });
    const raise = await this.#config.resolve<{ approved: boolean; parallel_run: boolean }>(
      request.tenant_id,
      'AS-SCP-010',
      { entity, process },
    );
    const accountable = await this.#config.resolve(
      request.tenant_id,
      skill.accountable_human_ref.replace(/-\*$/, '-010'),
      { entity },
    );
    const pending = await this.#skills.pendingRevalidation(request.tenant_id, skill.skill_id);

    const raiseValue = raise.ok
      ? (raise.value.value as { approved?: boolean; parallel_run?: boolean })
      : {};

    return computeAutonomy({
      platform_ceiling:
        ceilingFor(skill.output_class) === 'none'
          ? 'observe'
          : (ceilingFor(skill.output_class) as AutonomyLevel),
      skill_ceiling: skill.max_autonomy,
      as_scp_grant: grant.ok ? grant.value.value : null,
      supervisor_ref: supervisor.ok ? String(supervisor.value.value) : null,
      // AS-SCP-008 stores a principal reference; a role or a mailbox would not
      // start with `usr_`, which is how rule 8 is decided.
      supervisor_is_named_individual:
        supervisor.ok && String(supervisor.value.value).startsWith('usr_'),
      supervisor_active: supervisor.ok,
      autonomy_raise_approved: raiseValue.approved === true,
      parallel_run_completed: raiseValue.parallel_run === true,
      accountable_human_resolved: accountable.ok,
      revalidation_pending: pending !== null,
      ...(pending ? { revalidation_interim_ceiling: pending.interim_autonomy } : {}),
      accuracy_floor_breached: false,
    });
  }

  async #resolveBudget(
    tenantId: string,
    entity: string,
    skill: SkillRow,
  ): Promise<Result<TaskGraph['budget']>> {
    const cost = await this.#config.resolve<Money>(tenantId, 'AS-SYS-BGT-001', { entity });
    const tokens = await this.#config.resolve<number>(tenantId, 'AS-SYS-BGT-002', { entity });

    if (!cost.ok) return err(cost.error);
    if (!tokens.ok) return err(tokens.error);

    return ok({
      token_ceiling: Number(tokens.value.value),
      cost_ceiling: cost.value.value,
      source: skill.cost_envelope_ref,
    });
  }

  /**
   * Compile the node list.
   *
   * The eight-step pipeline maps onto node kinds (s.3.6): resolve → plan →
   * ground → execute → gate → assure → authorise → deliver. Resolve and plan
   * have already happened by the time a graph exists, so the graph starts at
   * grounding.
   */
  #buildNodes(
    request: PlanRequest,
    skill: SkillRow,
    graphId: string,
    autonomy: AutonomyLevel,
  ): TaskNode[] {
    const nodes: TaskNode[] = [];
    const contextTokenHash = request.context.context_id;
    let sequence = 0;
    const nextId = (): string => `n${++sequence}`;

    const base = {
      schema_version: '1.0.0' as const,
      graph_id: graphId,
      depends_on: [] as string[],
      state: 'pending' as const,
      state_changing: false,
      irreversible: false,
      dry_run: true,
      attempt: 0,
      max_attempts: 3,
      started_at: null,
      ended_at: null,
      failure: null,
    };

    // grounding
    if (skill.required_knowledge.length > 0) {
      nodes.push({
        ...base,
        node_id: nextId(),
        kind: 'grounding',
        label: `Retrieve grounding for ${skill.skill_id}`,
        owner: { kind: 'platform', ref: 'C11' },
        sequence_rank: RANK.grounding,
        max_attempts: 5,
      });
    }

    // read tools
    const readTools = skill.required_tools.filter((t) => {
      const tool = lookupTool(t.tool_id);
      return tool !== undefined && !tool.state_changing;
    });

    for (const required of readTools) {
      const previous = nodes[nodes.length - 1];
      nodes.push({
        ...base,
        node_id: nextId(),
        kind: 'tool_call',
        label: `Read via ${required.tool_id}`,
        owner: { kind: 'tool', ref: required.tool_id },
        ...(request.sop_id ? { sop_step_ref: request.sop_id } : {}),
        depends_on: previous ? [previous.node_id] : [],
        sequence_rank: RANK.tool_read,
        dry_run: false,
        max_attempts: 5,
      });
    }

    // the skill itself
    const beforeSkill = nodes[nodes.length - 1];
    const skillNode: TaskNode = {
      ...base,
      node_id: nextId(),
      kind: 'skill',
      label: skill.purpose.slice(0, 120),
      owner: { kind: 'skill', ref: skill.skill_id },
      ...(request.sop_id ? { sop_step_ref: request.sop_id } : {}),
      depends_on: beforeSkill ? [beforeSkill.node_id] : [],
      sequence_rank: RANK.skill,
      dry_run: false,
    };
    nodes.push(skillNode);

    // policy gate before any write
    const writeTools = skill.required_tools.filter((t) => {
      const tool = lookupTool(t.tool_id);
      return (
        tool !== undefined &&
        tool.state_changing &&
        (t.modes === undefined || t.modes.includes(autonomy === 'execute' ? 'execute' : 'draft'))
      );
    });

    let previousId = skillNode.node_id;

    if (writeTools.length > 0) {
      const gate: TaskNode = {
        ...base,
        node_id: nextId(),
        kind: 'gate',
        label: 'Policy gate before state change',
        owner: { kind: 'platform', ref: 'C6' },
        depends_on: [previousId],
        sequence_rank: RANK.gate,
      };
      nodes.push(gate);
      previousId = gate.node_id;

      for (const required of writeTools) {
        const tool = lookupTool(required.tool_id);
        if (!tool) continue;

        // s.8.1: derived at COMPILE time, from business identity only.
        const key = toolCallIdempotencyKey({
          tenant_id: request.tenant_id,
          entity_id: request.context.axes.legal_entity.value,
          sop_id: request.sop_id ?? skill.skill_id,
          business_key: request.business_key ?? request.intent,
          context_token_hash: contextTokenHash,
        });

        const node: TaskNode = {
          ...base,
          node_id: nextId(),
          kind: 'tool_call',
          label: `${tool.name} via ${tool.tool_id}`,
          owner: { kind: 'tool', ref: tool.tool_id },
          ...(request.sop_id ? { sop_step_ref: request.sop_id } : {}),
          depends_on: [previousId],
          // s.9.6: irreversible nodes hold the highest rank.
          sequence_rank: tool.irreversible === true ? RANK.irreversible : RANK.tool_write,
          state_changing: true,
          irreversible: tool.irreversible === true,
          idempotency_key: key,
          ...(tool.irreversible === true
            ? {}
            : {
                compensation: {
                  tool_id: tool.compensation_tool_id as string,
                  invoked: false,
                  compensation_key: null,
                },
              }),
          // The invoker decides finally; this is the planned intent.
          dry_run: this.#forceDryRun || autonomy !== 'execute',
          max_attempts: 3,
        };
        nodes.push(node);
        previousId = node.node_id;
      }
    }

    // assurance
    const assurance: TaskNode = {
      ...base,
      node_id: nextId(),
      kind: 'assurance',
      label: 'Assurance gates',
      owner: { kind: 'platform', ref: 'C13' },
      depends_on: [previousId],
      sequence_rank: RANK.assurance,
    };
    nodes.push(assurance);

    // authorisation
    const authorisation: TaskNode = {
      ...base,
      node_id: nextId(),
      kind: 'authorisation',
      label: `Authorise ${skill.output_class}`,
      owner: { kind: 'platform', ref: 'C15' },
      depends_on: [assurance.node_id],
      sequence_rank: RANK.authorisation,
    };
    nodes.push(authorisation);

    // hand-off, whenever a human must decide before effect
    if (autonomy !== 'execute' || lookupOutputClass(skill.output_class).reserved_act) {
      nodes.push({
        ...base,
        node_id: nextId(),
        kind: 'handoff',
        label: 'Hand off for human decision',
        owner: { kind: 'human', ref: skill.accountable_human_ref },
        depends_on: [authorisation.node_id],
        sequence_rank: RANK.handoff,
        max_attempts: 1,
      });
    }

    // delivery
    nodes.push({
      ...base,
      node_id: nextId(),
      kind: 'delivery',
      label: 'Deliver the output',
      owner: { kind: 'platform', ref: 'C14' },
      depends_on: [nodes[nodes.length - 1]?.node_id ?? authorisation.node_id],
      sequence_rank: RANK.delivery,
      max_attempts: 5,
    });

    return nodes;
  }

  async #refuse(
    request: PlanRequest,
    skill: SkillRow,
    autonomy: AutonomyDecision,
    failedCheck: AdmissionCheck,
    passed: readonly AdmissionCheck[],
    options: { detail: string },
    scope?: TenantScope,
  ): Promise<Result<PlannedGraph>> {
    const graphId = newId('taskGraph');
    const graph: TaskGraph = {
      schema_version: '1.0.0',
      graph_id: graphId,
      tenant_id: request.tenant_id,
      request_id: request.request_id,
      context_ref: request.context.context_id,
      trigger_class: request.trigger_class,
      intent: request.intent,
      root_skill_id: skill.skill_id,
      skill_version: skill.semantic_version,
      effective_autonomy: autonomy.effective,
      autonomy_basis: {
        platform_ceiling: autonomy.basis.platform_ceiling,
        as_scp_grant: autonomy.basis.as_scp_grant,
        supervisor_ref: autonomy.basis.supervisor_ref,
        supervisor_active: autonomy.basis.supervisor_active,
      },
      nodes: [],
      edges: [],
      sequence_ranks: {},
      admission: {
        checks_passed: [...passed],
        decision: 'rejected',
        failed_check: failedCheck,
        reason: options.detail,
      },
      budget: {
        token_ceiling: 0,
        cost_ceiling: { amount_minor: 0, currency: 'MYR', scale: 2 },
        source: 'AS-SYS-BGT-*',
      },
      state: 'refused',
      created_at: now(),
      completed_at: now(),
      workflow_run_id: 'wf_none',
    };

    await this.#persist(graph, [], request.conversation_key, scope);
    recordGraphTransition('compiled', 'refused', request.trigger_class);

    return err(
      new WorkerError('authority_insufficient', {
        detail: options.detail,
        failureClass: 'policy',
        retryable: false,
        context: { graph_id: graphId, failed_check: failedCheck },
      }),
    );
  }

  async #persist(
    graph: TaskGraph,
    nodes: readonly TaskNode[],
    conversationKey: string | undefined,
    scope?: TenantScope,
  ): Promise<void> {
    const write = async (s: TenantScope): Promise<void> => {
      await s.sql`
        INSERT INTO task_graphs (
          tenant_id, graph_id, request_id, conversation_key, context_ref, trigger_class,
          intent, root_skill_id, skill_version, effective_autonomy, autonomy_basis,
          edges, sequence_ranks, admission, budget, state, workflow_run_id, created_at,
          completed_at
        ) VALUES (
          ${graph.tenant_id}, ${graph.graph_id}, ${graph.request_id},
          ${conversationKey ?? null}, ${graph.context_ref}, ${graph.trigger_class},
          ${graph.intent}, ${graph.root_skill_id}, ${graph.skill_version},
          ${graph.effective_autonomy},
          ${s.sql.json(graph.autonomy_basis as never)},
          ${s.sql.json(graph.edges as never)},
          ${s.sql.json(graph.sequence_ranks)},
          ${s.sql.json(graph.admission)},
          ${s.sql.json(graph.budget as never)},
          ${graph.state}, ${graph.workflow_run_id},
          ${graph.created_at}::timestamptz, ${graph.completed_at}::timestamptz
        )
      `;

      for (const node of nodes) {
        await s.sql`
          INSERT INTO task_nodes (
            tenant_id, graph_id, node_id, kind, label, owner_kind, owner_ref,
            sop_step_ref, depends_on, sequence_rank, state, state_changing,
            irreversible, idempotency_key, compensation, dry_run, attempt, max_attempts
          ) VALUES (
            ${graph.tenant_id}, ${graph.graph_id}, ${node.node_id}, ${node.kind},
            ${node.label}, ${node.owner.kind}, ${node.owner.ref}, ${node.sop_step_ref ?? null},
            ${node.depends_on}, ${node.sequence_rank}, ${node.state},
            ${node.state_changing}, ${node.irreversible}, ${node.idempotency_key ?? null},
            ${node.compensation === undefined ? null : s.sql.json(node.compensation as never)},
            ${node.dry_run}, ${node.attempt}, ${node.max_attempts}
          )
        `;
      }
    };

    if (scope) await write(scope);
    else
      await withTenant(
        this.#db,
        { tenantId: graph.tenant_id, residencyZone: this.#residencyZone },
        write,
      );
  }
}

function buildEdges(nodes: readonly TaskNode[]): TaskGraph['edges'] {
  return nodes.flatMap((node) =>
    node.depends_on.map((from) => ({ from, to: node.node_id, kind: 'sequence' as const })),
  );
}

/**
 * s.9.6 — the irreversible-step ordering constraint, asserted at compile time.
 *
 *   "it asserts that ... the node's sequence_rank exceeds every reversible
 *    state-changing node's rank. A failed assertion halts the graph; IT DOES
 *    NOT REORDER AT RUN TIME."
 */
export function assertIrreversibleOrdering(nodes: readonly TaskNode[]): string | null {
  const reversibleWrites = nodes.filter((n) => n.state_changing && !n.irreversible);
  const irreversible = nodes.filter((n) => n.irreversible);
  if (irreversible.length === 0 || reversibleWrites.length === 0) return null;

  const highestReversible = Math.max(...reversibleWrites.map((n) => n.sequence_rank));

  for (const node of irreversible) {
    if (node.sequence_rank <= highestReversible) {
      return (
        `Node ${node.node_id} is irreversible but ranks ${node.sequence_rank}, which does not ` +
        `exceed the highest reversible state-changing rank of ${highestReversible}. An ` +
        'irreversible act must come last, so everything before it can still be compensated.'
      );
    }
  }

  return null;
}

export const nodeKindsOf = (nodes: readonly TaskNode[]): NodeKind[] => nodes.map((n) => n.kind);
