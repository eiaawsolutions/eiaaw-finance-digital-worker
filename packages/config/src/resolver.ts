/**
 * C16 — Configuration Service. DWD-06 s.13.
 *
 * The whole component turns on one sentence:
 *
 *   s.13.3: "Absence is refusal, not a default."
 *
 * and its corollary, which is the one that actually gets violated in practice:
 *
 *   "A threshold is absent → Refuse. The worker never substitutes an
 *    illustrative default from an SOP; SOP values are illustrative by
 *    construction."
 *
 * So this module has no fallback path. `resolve()` returns a `Result`, and the
 * refusal it returns names the family, the purpose in business terms, and the
 * owner — because s.13.3 also says a configuration refusal "is never 'an error
 * occurred'".
 *
 * s.1.3 D7: "C16 answers presence and value; it never answers 'what should
 * happen'." Nothing in this file interprets a value.
 */
import {
  WorkerError,
  type PrefixedHash,
  type Result,
  configurationMissing,
  err,
  hashObject,
  newId,
  now,
  ok,
} from '@eiaaw/core';
import { type Database, type TenantScope, withPlatformScope, withTenant } from '@eiaaw/db';
import { recordSettingsMissing } from '@eiaaw/telemetry';

export type SettingFamily =
  'AS-ORG' | 'AS-SYS' | 'AS-COA' | 'AS-DOA' | 'AS-REG' | 'AS-RUL' | 'AS-SCP' | 'AS-PPL';

export interface SettingScope {
  readonly entity?: string;
  readonly process?: string;
  readonly channel?: string;
  readonly role?: string;
  readonly asOf?: string;
}

export interface ResolvedSetting<T = unknown> {
  readonly field_id: string;
  readonly value: T;
  /** Recorded on every PolicyVerdict that reads this value (s.13.1). */
  readonly value_hash: PrefixedHash;
  readonly specificity: number;
  readonly effective_from: string;
  readonly snapshot_version: number | null;
}

export interface SettingsSnapshot {
  readonly snapshot_id: string;
  readonly snapshot_version: number;
  readonly tenant_id: string;
  readonly published_at: string;
  readonly resolved: Readonly<Record<string, unknown>>;
  readonly value_hashes: Readonly<Record<string, string>>;
  readonly field_count: number;
  readonly populated_count: number;
  readonly tbc_count: number;
}

export interface FamilyHealth {
  readonly family: SettingFamily;
  readonly field_count: number;
  readonly populated_count: number;
  readonly blank_mandatory_count: number;
  readonly tbc_count: number;
  readonly requires_reverification_count: number;
  readonly complete: boolean;
}

export interface SettingsHealth {
  readonly tenant_id: string;
  readonly families: readonly FamilyHealth[];
  readonly snapshot_version: number | null;
  readonly snapshot_age_seconds: number | null;
  readonly stale: boolean;
  /** PP/08 s.13: a complete configuration is required before any SOP runs. */
  readonly ready_for_execution: boolean;
}

interface CatalogueEntry {
  field_id: string;
  family: SettingFamily;
  label: string;
  purpose: string;
  value_type: string;
  requirement: 'mandatory' | 'conditional' | 'optional';
  owner_role_ref: string;
  scopable_by: string[];
}

export interface ConfigServiceOptions {
  readonly db: Database;
  readonly residencyZone: string;
  /** Cache TTL. The cache is never a source of truth (s.10.1). */
  readonly cacheTtlMs?: number;
  /** s.13.3: a snapshot older than this refuses state-changing work. */
  readonly stalenessBoundSeconds?: number;
}

interface CacheEntry {
  readonly value: ResolvedSetting | null;
  readonly expiresAt: number;
}

export class ConfigService {
  readonly #db: Database;
  readonly #residencyZone: string;
  readonly #cacheTtlMs: number;
  readonly #stalenessBoundSeconds: number;
  readonly #cache = new Map<string, CacheEntry>();
  #catalogue: Map<string, CatalogueEntry> | null = null;

  constructor(options: ConfigServiceOptions) {
    this.#db = options.db;
    this.#residencyZone = options.residencyZone;
    this.#cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.#stalenessBoundSeconds = options.stalenessBoundSeconds ?? 86_400;
  }

  async #loadCatalogue(): Promise<Map<string, CatalogueEntry>> {
    if (this.#catalogue) return this.#catalogue;
    const rows = await withPlatformScope(
      this.#db,
      async (sql) =>
        sql<CatalogueEntry[]>`
        SELECT field_id, family, label, purpose, value_type, requirement,
               owner_role_ref, scopable_by
          FROM settings_catalogue
         WHERE retired_at IS NULL
      `,
    );
    this.#catalogue = new Map(rows.map((row) => [row.field_id, row]));
    return this.#catalogue;
  }

  /**
   * Resolve one field.
   *
   * Returns a refusal rather than a value when absent — never a default, and
   * never an illustrative SOP figure. The refusal carries what the requester
   * needs to get it fixed.
   */
  async resolve<T = unknown>(
    tenantId: string,
    fieldId: string,
    scope: SettingScope = {},
  ): Promise<Result<ResolvedSetting<T>>> {
    const catalogue = await this.#loadCatalogue();
    const entry = catalogue.get(fieldId);

    if (!entry) {
      return err(
        new WorkerError('contract_invalid', {
          detail:
            `"${fieldId}" is not a registered AS- field. Reads are by field ID, never by ` +
            'position or label (DWD-06 s.13.1). A field the catalogue does not describe ' +
            'cannot be resolved.',
          failureClass: 'configuration',
          retryable: false,
          context: { field_id: fieldId },
        }),
      );
    }

    const cacheKey = this.#cacheKey(tenantId, fieldId, scope);
    const cached = this.#cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value ? ok(cached.value as ResolvedSetting<T>) : err(this.#missing(entry));
    }

    const rows = await withTenant(
      this.#db,
      { tenantId, residencyZone: this.#residencyZone, readOnly: true },
      async (s) =>
        s.sql<{ value: T; value_hash: string; specificity: number; effective_from: string }[]>`
          SELECT * FROM resolve_setting(
            ${tenantId}, ${fieldId},
            ${scope.entity ?? '*'}, ${scope.process ?? '*'},
            ${scope.channel ?? '*'}, ${scope.role ?? '*'},
            ${scope.asOf ?? null}::date
          )
        `,
    );

    const row = rows[0];
    if (!row) {
      this.#cache.set(cacheKey, { value: null, expiresAt: Date.now() + this.#cacheTtlMs });
      recordSettingsMissing(entry.family, fieldId);
      return err(this.#missing(entry));
    }

    const resolved: ResolvedSetting<T> = {
      field_id: fieldId,
      value: row.value,
      value_hash: row.value_hash,
      specificity: row.specificity,
      effective_from: row.effective_from,
      snapshot_version: null,
    };

    this.#cache.set(cacheKey, {
      value: resolved,
      expiresAt: Date.now() + this.#cacheTtlMs,
    });
    return ok(resolved);
  }

  /**
   * Resolve against a pinned snapshot — s.13.1.
   *
   *   "A graph pins a settings snapshot version at plan time, exactly as it
   *    pins knowledge versions, so a mid-run change cannot alter a decision
   *    halfway."
   *
   * Reads go to the materialised snapshot, never to `settings_values`, so a
   * publish during a long-running graph cannot reach it.
   */
  async resolveFromSnapshot<T = unknown>(
    tenantId: string,
    snapshotId: string,
    fieldId: string,
  ): Promise<Result<ResolvedSetting<T>>> {
    const catalogue = await this.#loadCatalogue();
    const entry = catalogue.get(fieldId);
    if (!entry) {
      return err(
        new WorkerError('contract_invalid', {
          detail: `"${fieldId}" is not a registered AS- field.`,
          failureClass: 'configuration',
          retryable: false,
        }),
      );
    }

    const rows = await withTenant(
      this.#db,
      { tenantId, residencyZone: this.#residencyZone, readOnly: true },
      async (s) =>
        s.sql<
          {
            resolved: Record<string, unknown>;
            value_hashes: Record<string, string>;
            snapshot_version: number;
          }[]
        >`
          SELECT resolved, value_hashes, snapshot_version FROM settings_snapshots
           WHERE tenant_id = ${tenantId} AND snapshot_id = ${snapshotId}
        `,
    );

    const snapshot = rows[0];
    if (!snapshot) {
      return err(
        new WorkerError('state_conflict', {
          detail:
            `Settings snapshot ${snapshotId} does not exist for this tenant. A graph pinned ` +
            'to a snapshot cannot proceed without it — proceeding on live settings would ' +
            'let a mid-run change alter a decision halfway (DWD-06 s.13.1).',
          failureClass: 'configuration',
          retryable: false,
        }),
      );
    }

    const value = snapshot.resolved[fieldId];
    if (value === undefined || value === null) {
      recordSettingsMissing(entry.family, fieldId);
      return err(this.#missing(entry));
    }

    return ok({
      field_id: fieldId,
      value: value as T,
      value_hash: snapshot.value_hashes[fieldId] ?? hashObject(value),
      specificity: 0,
      effective_from: '',
      snapshot_version: snapshot.snapshot_version,
    });
  }

  /** Resolve several fields, failing on the first absence. */
  async resolveAll(
    tenantId: string,
    fieldIds: readonly string[],
    scope: SettingScope = {},
  ): Promise<Result<Record<string, ResolvedSetting>>> {
    const out: Record<string, ResolvedSetting> = {};
    for (const fieldId of fieldIds) {
      const result = await this.resolve(tenantId, fieldId, scope);
      if (!result.ok) return result;
      out[fieldId] = result.value;
    }
    return ok(out);
  }

  /**
   * Publish a snapshot: materialise the full resolution at this instant.
   *
   * Everything a graph will read is captured here, so the graph's later reads
   * are answered from a frozen picture rather than a live table.
   */
  async publishSnapshot(
    tenantId: string,
    publishedBy: string,
    scope: SettingScope = {},
  ): Promise<SettingsSnapshot> {
    const catalogue = await this.#loadCatalogue();

    return withTenant(this.#db, { tenantId, residencyZone: this.#residencyZone }, async (s) => {
      const resolved: Record<string, unknown> = {};
      const valueHashes: Record<string, string> = {};
      let populated = 0;
      let tbc = 0;

      for (const fieldId of catalogue.keys()) {
        const rows = await s.sql<{ value: unknown; value_hash: string }[]>`
            SELECT * FROM resolve_setting(
              ${tenantId}, ${fieldId},
              ${scope.entity ?? '*'}, ${scope.process ?? '*'},
              ${scope.channel ?? '*'}, ${scope.role ?? '*'},
              ${scope.asOf ?? null}::date
            )
          `;
        const row = rows[0];
        if (row) {
          resolved[fieldId] = row.value;
          valueHashes[fieldId] = row.value_hash;
          populated += 1;
        }
      }

      const tbcRows = await s.sql<{ count: string }[]>`
          SELECT count(*)::text AS count FROM settings_values
           WHERE tenant_id = ${tenantId} AND is_tbc
        `;
      tbc = Number(tbcRows[0]?.count ?? 0);

      const versionRows = await s.sql<{ next_version: string }[]>`
          SELECT coalesce(max(snapshot_version), 0) + 1 AS next_version
            FROM settings_snapshots WHERE tenant_id = ${tenantId}
        `;
      const snapshotVersion = Number(versionRows[0]?.next_version ?? 1);
      const snapshotId = newId('settingsSnapshot');

      await s.sql`
          UPDATE settings_snapshots SET superseded_at = now()
           WHERE tenant_id = ${tenantId} AND superseded_at IS NULL
        `;

      await s.sql`
          INSERT INTO settings_snapshots (
            tenant_id, snapshot_id, snapshot_version, resolved, value_hashes,
            field_count, populated_count, tbc_count, published_by
          ) VALUES (
            ${tenantId}, ${snapshotId}, ${snapshotVersion},
            ${s.sql.json(resolved as never)}, ${s.sql.json(valueHashes)},
            ${catalogue.size}, ${populated}, ${tbc}, ${publishedBy}
          )
        `;

      // s.13.1: a publish invalidates caches and flags affected skills.
      this.invalidate(tenantId);

      return {
        snapshot_id: snapshotId,
        snapshot_version: snapshotVersion,
        tenant_id: tenantId,
        published_at: now(),
        resolved,
        value_hashes: valueHashes,
        field_count: catalogue.size,
        populated_count: populated,
        tbc_count: tbc,
      };
    });
  }

  async currentSnapshot(tenantId: string): Promise<SettingsSnapshot | null> {
    const rows = await withTenant(
      this.#db,
      { tenantId, residencyZone: this.#residencyZone, readOnly: true },
      async (s) =>
        s.sql<
          {
            snapshot_id: string;
            snapshot_version: number;
            published_at: string;
            resolved: Record<string, unknown>;
            value_hashes: Record<string, string>;
            field_count: number;
            populated_count: number;
            tbc_count: number;
          }[]
        >`
          SELECT snapshot_id, snapshot_version, published_at, resolved, value_hashes,
                 field_count, populated_count, tbc_count
            FROM settings_snapshots
           WHERE tenant_id = ${tenantId} AND superseded_at IS NULL
           ORDER BY snapshot_version DESC LIMIT 1
        `,
    );

    const row = rows[0];
    return row ? { ...row, tenant_id: tenantId } : null;
  }

  /**
   * Settings health — s.13.4.
   *
   * "PP/08 s.13 requires a complete configuration before any SOP runs; this
   *  endpoint is how that requirement becomes checkable rather than declared."
   */
  async health(tenantId: string): Promise<SettingsHealth> {
    const families = await withTenant(
      this.#db,
      { tenantId, residencyZone: this.#residencyZone, readOnly: true },
      async (s) =>
        s.sql<
          {
            family: SettingFamily;
            field_count: string;
            populated_count: string;
            blank_mandatory_count: string;
            tbc_count: string;
            requires_reverification_count: string;
          }[]
        >`
          SELECT family, field_count::text, populated_count::text,
                 blank_mandatory_count::text, tbc_count::text,
                 requires_reverification_count::text
            FROM settings_health WHERE tenant_id = ${tenantId}
           ORDER BY family
        `,
    );

    const snapshot = await this.currentSnapshot(tenantId);
    const ageSeconds =
      snapshot === null
        ? null
        : Math.floor((Date.now() - new Date(snapshot.published_at).getTime()) / 1000);

    const familyHealth: FamilyHealth[] = families.map((row) => ({
      family: row.family,
      field_count: Number(row.field_count),
      populated_count: Number(row.populated_count),
      blank_mandatory_count: Number(row.blank_mandatory_count),
      tbc_count: Number(row.tbc_count),
      requires_reverification_count: Number(row.requires_reverification_count),
      complete: Number(row.blank_mandatory_count) === 0,
    }));

    const stale = ageSeconds !== null && ageSeconds > this.#stalenessBoundSeconds;

    return {
      tenant_id: tenantId,
      families: familyHealth,
      snapshot_version: snapshot?.snapshot_version ?? null,
      snapshot_age_seconds: ageSeconds,
      stale,
      // Every mandatory field populated, a snapshot published, and not stale.
      // Anything less and a state-changing graph is refused admission.
      ready_for_execution: familyHealth.every((f) => f.complete) && snapshot !== null && !stale,
    };
  }

  /**
   * s.13.3: "A snapshot is older than the staleness bound → Refuse for
   * state-changing work; permit Observe work with the staleness stated."
   */
  async assertUsableFor(
    tenantId: string,
    stateChanging: boolean,
  ): Promise<Result<{ readonly stale: boolean; readonly snapshot_version: number | null }>> {
    const health = await this.health(tenantId);

    if (!stateChanging) {
      return ok({ stale: health.stale, snapshot_version: health.snapshot_version });
    }

    if (health.snapshot_version === null) {
      return err(
        new WorkerError('contract_invalid', {
          detail:
            'No settings snapshot has been published for this tenant. State-changing work ' +
            'cannot be admitted against unpinned configuration. Complete enrolment and ' +
            'publish a snapshot first.',
          failureClass: 'configuration',
          retryable: false,
        }),
      );
    }

    if (health.stale) {
      return err(
        new WorkerError('contract_invalid', {
          detail:
            `The settings snapshot is ${health.snapshot_age_seconds}s old, beyond the ` +
            `staleness bound of ${this.#stalenessBoundSeconds}s. State-changing work is ` +
            'refused; read-only work may proceed with the staleness stated (DWD-06 s.13.3).',
          failureClass: 'configuration',
          retryable: false,
          context: { snapshot_age_seconds: health.snapshot_age_seconds },
        }),
      );
    }

    const incomplete = health.families.filter((f) => !f.complete);
    if (incomplete.length > 0) {
      return err(
        new WorkerError('contract_invalid', {
          detail:
            'Mandatory settings are blank in: ' +
            incomplete.map((f) => `${f.family} (${f.blank_mandatory_count} field(s))`).join(', ') +
            '. An SOP executed against blank settings is an incident, not a shortcut.',
          failureClass: 'configuration',
          retryable: false,
          context: { incomplete_families: incomplete.map((f) => f.family) },
        }),
      );
    }

    return ok({ stale: false, snapshot_version: health.snapshot_version });
  }

  /** Explicit invalidation on publish (s.13.1). */
  invalidate(tenantId?: string): void {
    if (tenantId === undefined) {
      this.#cache.clear();
      this.#catalogue = null;
      return;
    }
    for (const key of this.#cache.keys()) {
      if (key.startsWith(`${tenantId}|`)) this.#cache.delete(key);
    }
  }

  #cacheKey(tenantId: string, fieldId: string, scope: SettingScope): string {
    return [
      tenantId,
      fieldId,
      scope.entity ?? '*',
      scope.process ?? '*',
      scope.channel ?? '*',
      scope.role ?? '*',
      scope.asOf ?? '*',
    ].join('|');
  }

  #missing(entry: CatalogueEntry): WorkerError {
    return configurationMissing({
      settingFamily: `${entry.field_id} (${entry.family} — ${entry.label})`,
      fieldPurpose: entry.purpose,
      ownerRef: entry.owner_role_ref,
      meanwhile:
        entry.requirement === 'mandatory'
          ? 'This request cannot proceed until it is set. No default and no illustrative ' +
            'SOP value will be substituted.'
          : 'This request cannot use the behaviour that depends on it.',
    });
  }
}

/** Write a settings value. Used by the admin console, never by the worker. */
export async function setSettingValue(
  db: Database,
  residencyZone: string,
  input: {
    readonly tenantId: string;
    readonly fieldId: string;
    readonly value: unknown;
    readonly effectiveFrom: string;
    readonly setBy: string;
    readonly scope?: SettingScope;
    readonly isTbc?: boolean;
    readonly approvedBy?: string;
    readonly sourceNote?: string;
  },
  scope?: TenantScope,
): Promise<void> {
  const isTbc = input.isTbc === true;
  const write = async (s: TenantScope): Promise<void> => {
    await s.sql`
      INSERT INTO settings_values (
        tenant_id, field_id, scope_entity, scope_process, scope_channel, scope_role,
        value, is_tbc, value_hash, effective_from, set_by, approved_by, approved_at, source_note
      ) VALUES (
        ${input.tenantId}, ${input.fieldId},
        ${input.scope?.entity ?? '*'}, ${input.scope?.process ?? '*'},
        ${input.scope?.channel ?? '*'}, ${input.scope?.role ?? '*'},
        ${isTbc ? null : s.sql.json(input.value as never)}, ${isTbc},
        ${hashObject(isTbc ? null : input.value)},
        ${input.effectiveFrom}::date, ${input.setBy},
        ${input.approvedBy ?? null},
        ${input.approvedBy === undefined ? null : now()}::timestamptz,
        ${input.sourceNote ?? null}
      )
      ON CONFLICT (tenant_id, field_id, scope_entity, scope_process, scope_channel, scope_role, effective_from)
      DO UPDATE SET value = EXCLUDED.value,
                    is_tbc = EXCLUDED.is_tbc,
                    value_hash = EXCLUDED.value_hash,
                    set_by = EXCLUDED.set_by,
                    approved_by = EXCLUDED.approved_by,
                    approved_at = EXCLUDED.approved_at,
                    source_note = EXCLUDED.source_note
    `;
  };

  if (scope) await write(scope);
  else await withTenant(db, { tenantId: input.tenantId, residencyZone }, write);
}
