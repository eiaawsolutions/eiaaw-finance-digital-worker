/**
 * Seed the platform-owned registries.
 *
 * The output-class register and the tool registry are code, not configuration
 * (file 01 s.7.3, file 05 s.10). This publishes them into tables the worker's
 * database role can read but not write.
 */
import { withPlatformScope, type Database } from '@eiaaw/db';
import { OUTPUT_CLASS_REGISTER } from './output-classes.js';
import { TOOL_REGISTRY, validateRegistry } from './tools.js';
import { type SkillDefinition, validateSkillDefinition } from './skills.js';

export interface RegistrySeedResult {
  readonly output_classes: number;
  readonly tools: number;
  readonly skills: number;
}

export async function seedRegistries(
  db: Database,
  skills: readonly SkillDefinition[] = [],
): Promise<RegistrySeedResult> {
  // Refuse to publish a registry that violates its own invariants. A registry
  // that cannot enforce compensation and irreversibility is worse than none,
  // because everything downstream trusts it.
  const registryProblems = validateRegistry();
  if (registryProblems.length > 0) {
    throw new Error(
      `The tool registry violates its invariants and will not be published:\n  ` +
        registryProblems.join('\n  '),
    );
  }

  for (const skill of skills) {
    const problems = validateSkillDefinition(skill);
    if (problems.length > 0) {
      throw new Error(
        `Skill ${skill.skill_id} ${skill.semantic_version} is invalid:\n  ` +
          problems.map((p) => `${p.field}: ${p.problem}`).join('\n  '),
      );
    }
  }

  return withPlatformScope(db, async (sql) => {
    for (const entry of OUTPUT_CLASS_REGISTER) {
      await sql`
        INSERT INTO output_class_register (
          output_class, label, reserved_act, worker_maximum_contribution,
          accountable_role_ref, minimum_competency_level, gate_behaviour,
          autonomy_ceiling, immutable_rule_ref, notes
        ) VALUES (
          ${entry.output_class}, ${entry.label}, ${entry.reserved_act},
          ${entry.worker_maximum_contribution}, ${entry.accountable_role_ref},
          ${entry.minimum_competency_level}, ${entry.gate_behaviour},
          ${entry.autonomy_ceiling}, ${entry.immutable_rule_ref ?? null},
          ${entry.notes ?? null}
        )
        ON CONFLICT (output_class) DO UPDATE SET
          label = EXCLUDED.label,
          reserved_act = EXCLUDED.reserved_act,
          worker_maximum_contribution = EXCLUDED.worker_maximum_contribution,
          accountable_role_ref = EXCLUDED.accountable_role_ref,
          minimum_competency_level = EXCLUDED.minimum_competency_level,
          gate_behaviour = EXCLUDED.gate_behaviour,
          autonomy_ceiling = EXCLUDED.autonomy_ceiling,
          immutable_rule_ref = EXCLUDED.immutable_rule_ref,
          notes = EXCLUDED.notes
      `;
    }

    // One pass. `compensation_tool_id` is a plain column, not a foreign key, so
    // it is written with the row — and it must be, because the CHECK constraint
    // requires a reversible state-changing tool to declare its compensation at
    // insert time.
    for (const tool of TOOL_REGISTRY) {
      await sql`
        INSERT INTO tool_registry (
          tool_id, name, class, capability_schema, capability_schema_version,
          permission_scope, scope_qualifiers, rate_limit_ref, cost_per_call_ref,
          timeout_ref, state_changing, dry_run_support, dry_run_default,
          idempotency_key_required, idempotency_key_derivation, irreversible,
          compensation_tool_id,
          credential_ref, residency_zone_ref, owner_ref, graduation_stage, status
        ) VALUES (
          ${tool.tool_id}, ${tool.name}, ${tool.class},
          ${sql.json({ input_schema_ref: `contracts/tools/${tool.tool_id}.input.schema.json`, output_schema_ref: `contracts/tools/${tool.tool_id}.output.schema.json` })},
          '1.0.0',
          ${tool.permission_scope},
          ${tool.scope_qualifiers ?? []},
          'AS-SYS-020', 'AS-SYS-BGT-001', 'AS-SYS-021',
          ${tool.state_changing}, ${tool.dry_run_support}, true,
          ${tool.idempotency_key_required},
          ${tool.state_changing ? 'sha256(tenant|entity|sop_id|business_key|context_token_hash)' : null},
          ${tool.irreversible ?? false},
          ${tool.compensation_tool_id ?? null},
          'vault://connector-credentials', 'AS-ORG-121', 'AS-PPL-003',
          1, 'active'
        )
        ON CONFLICT (tool_id) DO UPDATE SET
          name = EXCLUDED.name,
          class = EXCLUDED.class,
          permission_scope = EXCLUDED.permission_scope,
          scope_qualifiers = EXCLUDED.scope_qualifiers,
          state_changing = EXCLUDED.state_changing,
          dry_run_support = EXCLUDED.dry_run_support,
          idempotency_key_required = EXCLUDED.idempotency_key_required,
          irreversible = EXCLUDED.irreversible,
          compensation_tool_id = EXCLUDED.compensation_tool_id
      `;
    }

    for (const skill of skills) {
      await sql`
        INSERT INTO skill_registry (
          skill_id, semantic_version, purpose, role_level, role_ref, source_sop,
          sop_content_hash, required_knowledge, required_tools, input_schema,
          output_schema, quality_criteria, accuracy_metric, accuracy_floor_ref,
          accuracy_measurement, breach_action, revalidation_triggers, max_autonomy,
          state_changing, output_class, accountable_human_ref, compensation,
          irreversible, channel_suitability, cost_envelope_ref, status, published_at
        ) VALUES (
          ${skill.skill_id}, ${skill.semantic_version}, ${skill.purpose},
          ${skill.role_level}, ${skill.role_ref},
          ${sql.json(skill.source_sop)}, ${skill.source_sop.sop_content_hash},
          ${sql.json(skill.required_knowledge as never)},
          ${sql.json(skill.required_tools as never)},
          ${sql.json(skill.input_schema as never)},
          ${sql.json(skill.output_schema as never)},
          ${skill.quality_criteria},
          ${skill.accuracy_metric}, ${skill.accuracy_floor_ref}, ${skill.accuracy_measurement},
          ${skill.breach_action},
          ${skill.revalidation_triggers},
          ${skill.max_autonomy}, ${skill.state_changing}, ${skill.output_class},
          ${skill.accountable_human_ref}, ${skill.compensation}, ${skill.irreversible},
          ${skill.channel_suitability},
          ${skill.cost_envelope_ref}, ${skill.status},
          ${skill.status === 'active' ? new Date().toISOString() : null}::timestamptz
        )
        ON CONFLICT (skill_id, semantic_version) DO UPDATE SET
          purpose = EXCLUDED.purpose,
          required_knowledge = EXCLUDED.required_knowledge,
          required_tools = EXCLUDED.required_tools,
          quality_criteria = EXCLUDED.quality_criteria,
          status = EXCLUDED.status
      `;

      // Rebuild the reverse index for this version.
      await sql`
        DELETE FROM skill_dependencies
         WHERE skill_id = ${skill.skill_id} AND skill_version = ${skill.semantic_version}
      `;

      const edges: [string, string][] = [
        ...skill.required_knowledge.flatMap((k) =>
          k.l2_modules.map((m) => ['knowledge_module', m] as [string, string]),
        ),
        ...skill.required_tools.map((tool) => ['tool', tool.tool_id] as [string, string]),
        ['sop', `${skill.source_sop.module}#${skill.source_sop.sections.join(',')}`],
        ['setting', skill.accuracy_floor_ref],
        ['setting', skill.cost_envelope_ref],
        ['setting', skill.accountable_human_ref],
      ];

      for (const [kind, ref] of edges) {
        await sql`
          INSERT INTO skill_dependencies (skill_id, skill_version, dependency_kind, dependency_ref)
          VALUES (${skill.skill_id}, ${skill.semantic_version}, ${kind}, ${ref})
          ON CONFLICT DO NOTHING
        `;
      }
    }

    return {
      output_classes: OUTPUT_CLASS_REGISTER.length,
      tools: TOOL_REGISTRY.length,
      skills: skills.length,
    };
  });
}
