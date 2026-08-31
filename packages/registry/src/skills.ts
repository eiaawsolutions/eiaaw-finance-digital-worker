/**
 * The L4 skill registry — file 05 s.2.
 *
 * A skill definition carries all eleven fields of the architecture's L4 minimum
 * schema plus this build's five extensions. Two rules shape the type:
 *
 *   s.2.2: "The numeric floor is ALWAYS client-entered at AS-SCP-*; the platform
 *           supplies the metric definition and the measurement window, never the
 *           number." Hence `accuracy_floor_ref`, not `accuracy_floor`.
 *
 *   s.2.3: a definition may never contain a threshold value, a person's name, a
 *          system name or endpoint, a statutory rate, a channel-specific branch,
 *          or a fallback that lowers grounding. `validateSkillDefinition`
 *          enforces that, because a definition is authored by humans and the
 *          prohibited shapes are the convenient ones.
 */
import type { AutonomyLevel, ChannelName, OutputClass, SkillStatus } from '@eiaaw/contracts';
import { type Database, type TenantScope, withPlatformScope, withTenant } from '@eiaaw/db';

export interface RequiredKnowledge {
  /** Written with `{}` placeholders bound from the L0 context. */
  readonly query_template: string;
  readonly l2_modules: readonly string[];
  /** The literal `'as_of_date'`, or an ISO date the pack pins explicitly. */
  readonly min_effective_from: string;
  readonly pin_policy: 'pin_version_for_graph_lifetime';
  /** Always `refuse`. CITE OR REFUSE has no degraded mode (s.2.3). */
  readonly on_missing: 'refuse';
}

export interface RequiredTool {
  readonly tool_id: string;
  readonly permission_scope: string;
  readonly required: boolean;
  readonly modes?: readonly ('analyse' | 'draft' | 'execute')[];
}

export interface SkillDefinition {
  readonly skill_id: string;
  readonly semantic_version: string;
  readonly purpose: string;
  readonly role_level: string;
  readonly role_ref: string;
  readonly source_sop: {
    readonly module: string;
    readonly sections: readonly string[];
    readonly steps_covered: readonly string[];
    readonly sop_content_hash: string;
  };
  readonly required_knowledge: readonly RequiredKnowledge[];
  readonly required_tools: readonly RequiredTool[];
  readonly input_schema: Record<string, unknown>;
  readonly output_schema: Record<string, unknown>;
  readonly quality_criteria: readonly string[];
  readonly accuracy_metric: string;
  /** A pointer to AS-SCP-*, never a number. */
  readonly accuracy_floor_ref: string;
  readonly accuracy_measurement: string;
  readonly breach_action: 'pull_back_one_level' | 'suspend';
  readonly revalidation_triggers: readonly string[];
  readonly max_autonomy: AutonomyLevel;
  readonly state_changing: boolean;
  readonly output_class: OutputClass;
  /** A pointer to AS-PPL-*, never a name (s.2.3). */
  readonly accountable_human_ref: string;
  readonly compensation: string | null;
  readonly irreversible: boolean;
  readonly channel_suitability: readonly ChannelName[];
  readonly cost_envelope_ref: string;
  readonly status: SkillStatus;
}

/** The seven standard revalidation triggers (file 05 s.7.3). */
export const STANDARD_REVALIDATION_TRIGGERS: readonly string[] = [
  'l2_chunk_version_change_in_required_knowledge',
  'l6_tool_capability_schema_change_in_required_tools',
  'as_rul_threshold_change_referenced_by_this_skill',
  'sop_content_hash_mismatch',
  'accuracy_floor_breach',
  'model_route_change_for_this_skill',
  'jurisdiction_or_framework_axis_change_in_L0',
];

/** The two universal quality criteria every skill carries (file 05 s.2.2). */
export const UNIVERSAL_QUALITY_CRITERIA: readonly string[] = [
  'Every substantive claim carries a citation to an L2 chunk with its version and effective date',
  'Arithmetic gate passes: every total is independently recomputed and agrees to the minor unit',
];

/**
 * Shapes a skill definition may never contain (file 05 s.2.3).
 *
 * Detected by pattern rather than by review, because each of these is the
 * *convenient* thing to write and will otherwise appear the first time someone
 * is in a hurry.
 */
const PROHIBITED_PATTERNS: readonly { pattern: RegExp; reason: string }[] = [
  {
    // A bare number where a threshold belongs. Matches "tolerance: 500" but not
    // a section reference like "s.5.4" or a version like "1.4.0".
    pattern: /\b(tolerance|threshold|limit|ceiling|materiality)\s*[:=]\s*[0-9]/i,
    reason:
      'a threshold value literal. Thresholds are client-entered at AS-RUL-/AS-DOA- and read ' +
      'at run time, so a literal here would silently outrank the client’s own configuration',
  },
  {
    pattern: /\b(?:MYR|SGD|USD|RM|\$)\s?[0-9]/,
    reason: 'a monetary literal. The same rule as thresholds',
  },
  {
    pattern: /\b\d+(?:\.\d+)?\s?(?:per ?cent|%)/i,
    reason:
      'a statutory rate. Rates are L2 chunks with effective dates, so a literal cannot go ' +
      'stale visibly and immutable rule 10 could never fire on it',
  },
  {
    pattern: /\bif\s+channel\s*(?:==|is|===)/i,
    reason:
      'a channel-specific branch. Channel behaviour belongs to the L7 adapters (file 02 s.6.2)',
  },
  {
    pattern: /\b(?:fall\s?back|degrade|best[- ]effort)\b.*\b(?:citation|grounding|uncited)\b/i,
    reason: 'a fallback that lowers grounding. CITE OR REFUSE has no degraded mode',
  },
];

/** Recognisably a person's name rather than a role or an AS- pointer. */
const NAME_LIKE =
  /\b(?:Mr|Ms|Mrs|Dr|Encik|Puan|Datuk|Dato)\b|\b[A-Z][a-z]+ (?:bin|binti|a\/l|a\/p) /;

export interface SkillValidationProblem {
  readonly field: string;
  readonly problem: string;
}

export function validateSkillDefinition(skill: SkillDefinition): SkillValidationProblem[] {
  const problems: SkillValidationProblem[] = [];

  // Prohibited content, scanned across every free-text surface.
  const textFields: readonly [string, string][] = [
    ['purpose', skill.purpose],
    ...skill.quality_criteria.map((c, i) => [`quality_criteria[${i}]`, c] as [string, string]),
    ...skill.required_knowledge.map(
      (k, i) => [`required_knowledge[${i}].query_template`, k.query_template] as [string, string],
    ),
  ];

  for (const [field, text] of textFields) {
    for (const { pattern, reason } of PROHIBITED_PATTERNS) {
      if (pattern.test(text)) problems.push({ field, problem: `contains ${reason}` });
    }
    if (NAME_LIKE.test(text)) {
      problems.push({
        field,
        problem:
          "contains what looks like a person's name. Accountability resolves through " +
          'AS-PPL-* so that leaver handling is automatic',
      });
    }
  }

  // s.2.2: on_missing is always refuse.
  skill.required_knowledge.forEach((k, i) => {
    if (k.on_missing !== 'refuse') {
      problems.push({
        field: `required_knowledge[${i}].on_missing`,
        problem: 'must be "refuse". CITE OR REFUSE has no degraded mode',
      });
    }
    if (k.l2_modules.length === 0) {
      problems.push({
        field: `required_knowledge[${i}].l2_modules`,
        problem:
          'names no permitted answer sources. A free-text description is not a query template',
      });
    }
  });

  // s.2.2: the accuracy floor is a pointer, never a number.
  if (/^[\d.]+$/.test(skill.accuracy_floor_ref)) {
    problems.push({
      field: 'accuracy_floor_ref',
      problem:
        'is a number. The floor is client-entered at AS-SCP-*; the platform supplies the ' +
        'metric and the window, never the number',
    });
  }
  if (!skill.accountable_human_ref.startsWith('AS-PPL-')) {
    problems.push({
      field: 'accountable_human_ref',
      problem: 'must point at AS-PPL-*, never name a person',
    });
  }

  // s.2.2: compensation absent means irreversible true. The pair cannot disagree.
  if (skill.state_changing) {
    const hasCompensation = skill.compensation !== null && skill.compensation !== '';
    if (hasCompensation === skill.irreversible) {
      problems.push({
        field: 'compensation',
        problem: skill.irreversible
          ? 'declares a compensation while marked irreversible'
          : 'is absent, so the skill must set irreversible: true, which forces dual control ' +
            'and last-position sequencing',
      });
    }
  }

  // The seven standard triggers are a floor, not a menu.
  const missing = STANDARD_REVALIDATION_TRIGGERS.filter(
    (trigger) => !skill.revalidation_triggers.includes(trigger),
  );
  if (missing.length > 0) {
    problems.push({
      field: 'revalidation_triggers',
      problem: `omits standard trigger(s): ${missing.join(', ')}`,
    });
  }

  // s.2.2: a skill with any unpopulated mandatory field cannot reach `active`.
  if (skill.status === 'active') {
    if (skill.source_sop.sop_content_hash === '') {
      problems.push({
        field: 'source_sop.sop_content_hash',
        problem: 'is empty, so SOP text drift could never be detected',
      });
    }
    if (skill.channel_suitability.length === 0) {
      problems.push({ field: 'channel_suitability', problem: 'names no channel' });
    }
  }

  return problems;
}

export class SkillRegistry {
  constructor(
    private readonly db: Database,
    private readonly residencyZone: string,
  ) {}

  /** Only `active` and `restricted` are invocable (file 05 s.2.2). */
  async lookupInvocable(skillId: string): Promise<SkillRow | null> {
    const rows = await withPlatformScope(
      this.db,
      async (sql) =>
        sql<SkillRow[]>`
        SELECT * FROM skill_registry
         WHERE skill_id = ${skillId} AND status IN ('active', 'restricted')
         ORDER BY semantic_version DESC LIMIT 1
      `,
    );
    return rows[0] ?? null;
  }

  /**
   * A pinned version stays resolvable after supersession.
   *
   * file 05 s.8.4: a graph keeps its pinned skill version, and "a superseded
   * version remains resolvable for exactly this reason".
   */
  async lookupPinned(skillId: string, version: string): Promise<SkillRow | null> {
    const rows = await withPlatformScope(
      this.db,
      async (sql) =>
        sql<SkillRow[]>`
        SELECT * FROM skill_registry
         WHERE skill_id = ${skillId} AND semantic_version = ${version}
      `,
    );
    return rows[0] ?? null;
  }

  async listActive(): Promise<SkillRow[]> {
    return withPlatformScope(
      this.db,
      async (sql) =>
        sql<SkillRow[]>`
        SELECT * FROM skill_registry WHERE status IN ('active', 'restricted') ORDER BY skill_id
      `,
    );
  }

  /**
   * Which skills does a changed dependency affect?
   *
   * file 05 s.7.1: "reverse-index queries in one hop". Until the graph store
   * lands this is a single indexed lookup on the relational edge table.
   */
  async dependentsOf(
    kind: string,
    ref: string,
  ): Promise<{ skill_id: string; skill_version: string }[]> {
    return withPlatformScope(
      this.db,
      async (sql) =>
        sql<{ skill_id: string; skill_version: string }[]>`
        SELECT skill_id, skill_version FROM skill_dependencies
         WHERE dependency_kind = ${kind} AND dependency_ref = ${ref}
      `,
    );
  }

  /**
   * Raise a revalidation. While pending, the skill runs at its interim ceiling
   * rather than its granted level (file 05 s.7.4).
   */
  async raiseRevalidation(
    tenantId: string,
    input: {
      readonly revalidation_id: string;
      readonly skill_id: string;
      readonly skill_version: string;
      readonly trigger: string;
      readonly trigger_detail?: string;
      readonly interim_autonomy?: 'observe' | 'draft';
    },
    scope?: TenantScope,
  ): Promise<void> {
    const write = async (s: TenantScope): Promise<void> => {
      await s.sql`
        INSERT INTO skill_revalidations (
          tenant_id, revalidation_id, skill_id, skill_version, trigger,
          trigger_detail, interim_autonomy
        ) VALUES (
          ${tenantId}, ${input.revalidation_id}, ${input.skill_id}, ${input.skill_version},
          ${input.trigger}, ${input.trigger_detail ?? null},
          ${input.interim_autonomy ?? 'observe'}
        )
        ON CONFLICT DO NOTHING
      `;
    };
    if (scope) await write(scope);
    else await withTenant(this.db, { tenantId, residencyZone: this.residencyZone }, write);
  }

  async pendingRevalidation(
    tenantId: string,
    skillId: string,
  ): Promise<{ interim_autonomy: 'observe' | 'draft' } | null> {
    const rows = await withTenant(
      this.db,
      { tenantId, residencyZone: this.residencyZone, readOnly: true },
      async (s) =>
        s.sql<{ interim_autonomy: 'observe' | 'draft' }[]>`
          SELECT interim_autonomy FROM skill_revalidations
           WHERE tenant_id = ${tenantId} AND skill_id = ${skillId}
             AND status IN ('pending', 'in_progress')
           ORDER BY CASE interim_autonomy WHEN 'observe' THEN 0 ELSE 1 END
           LIMIT 1
        `,
    );
    return rows[0] ?? null;
  }
}

export interface SkillRow {
  skill_id: string;
  semantic_version: string;
  purpose: string;
  role_level: string;
  role_ref: string;
  source_sop: SkillDefinition['source_sop'];
  sop_content_hash: string;
  required_knowledge: RequiredKnowledge[];
  required_tools: RequiredTool[];
  input_schema: Record<string, unknown>;
  output_schema: Record<string, unknown>;
  quality_criteria: string[];
  accuracy_metric: string;
  accuracy_floor_ref: string;
  accuracy_measurement: string;
  breach_action: 'pull_back_one_level' | 'suspend';
  revalidation_triggers: string[];
  max_autonomy: AutonomyLevel;
  state_changing: boolean;
  output_class: OutputClass;
  accountable_human_ref: string;
  compensation: string | null;
  irreversible: boolean;
  channel_suitability: ChannelName[];
  cost_envelope_ref: string;
  status: SkillStatus;
}
