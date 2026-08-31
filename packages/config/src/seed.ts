/**
 * Publish the AS- catalogue into the database.
 *
 * The catalogue is platform-owned: it describes the *shape* of every field the
 * runtime reads. It ships no values — the `settings_values` table stays empty
 * until a human completes enrolment through the console.
 */
import { withPlatformScope, type Database } from '@eiaaw/db';
import { SETTINGS_CATALOGUE, type CatalogueField } from './catalogue.js';

export interface SeedResult {
  readonly inserted: number;
  readonly updated: number;
  readonly total: number;
  /**
   * Rows present in the table that the shipped catalogue no longer defines.
   *
   * Reported, never deleted. A stale row is not harmless — settings-health
   * counts it toward readiness, so a tenant can be held "not ready" by a
   * mandatory field the platform stopped defining. But it may also hold a value
   * a client entered, and dropping that silently would be worse than the
   * confusion. Someone decides.
   */
  readonly unrecognised: readonly string[];
}

export async function seedCatalogue(
  db: Database,
  fields: readonly CatalogueField[] = SETTINGS_CATALOGUE,
): Promise<SeedResult> {
  return withPlatformScope(db, async (sql) => {
    const before = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM settings_catalogue
    `;

    for (const field of fields) {
      await sql`
        INSERT INTO settings_catalogue (
          field_id, family, label, purpose, value_type, enum_values,
          requirement, requirement_condition, scopable_by, who_defines,
          approval_needed, consumed_by, owner_role_ref, enrolment_stage,
          requires_reverification
        ) VALUES (
          ${field.field_id}, ${field.family}, ${field.label}, ${field.purpose},
          ${field.value_type},
          ${field.enum_values ?? null},
          ${field.requirement}, ${field.requirement_condition ?? null},
          ${field.scopable_by ?? []},
          ${field.who_defines}, ${field.approval_needed ?? null},
          ${field.consumed_by ?? []},
          ${field.owner_role_ref}, ${field.enrolment_stage},
          ${field.requires_reverification ?? false}
        )
        ON CONFLICT (field_id) DO UPDATE SET
          label = EXCLUDED.label,
          purpose = EXCLUDED.purpose,
          value_type = EXCLUDED.value_type,
          enum_values = EXCLUDED.enum_values,
          requirement = EXCLUDED.requirement,
          requirement_condition = EXCLUDED.requirement_condition,
          scopable_by = EXCLUDED.scopable_by,
          who_defines = EXCLUDED.who_defines,
          approval_needed = EXCLUDED.approval_needed,
          consumed_by = EXCLUDED.consumed_by,
          owner_role_ref = EXCLUDED.owner_role_ref,
          enrolment_stage = EXCLUDED.enrolment_stage,
          requires_reverification = EXCLUDED.requires_reverification
      `;
    }

    const after = await sql<{ count: string }[]>`
      SELECT count(*)::text AS count FROM settings_catalogue
    `;

    const present = await sql<{ field_id: string }[]>`
      SELECT field_id FROM settings_catalogue ORDER BY field_id
    `;
    const shipped = new Set(fields.map((f) => f.field_id));
    const unrecognised = present.map((r) => r.field_id).filter((id) => !shipped.has(id));

    const beforeCount = Number(before[0]?.count ?? 0);
    const afterCount = Number(after[0]?.count ?? 0);

    return {
      inserted: afterCount - beforeCount,
      updated: fields.length - (afterCount - beforeCount),
      total: afterCount,
      unrecognised,
    };
  });
}
