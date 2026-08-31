-- =============================================================================
-- S3 Configuration service — DWD-06 s.13.
--
--   s.15.1: "Configuration at S3, before context. Context resolution reads
--            settings; a resolver built against hard-coded values will keep them."
--   s.13.3: "Absence is refusal, not a default."
--   s.13.2: precedence is
--             entity-and-process > entity > process > tenant-wide
--           and "There is no platform default layer beneath these. Absence at
--           every level is absence."
--
-- The AS- registers hold ~2,533 fields across eight families. Nothing here
-- ships a value: `settings_catalogue` describes the *shape* of each field
-- (which family, whether mandatory, who owns it, what reads it) and
-- `settings_values` holds what a client actually entered.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The catalogue — platform-owned, not tenant-scoped.
--
-- One row per AS- field. `default_value` is deliberately absent as a column:
-- admin-settings 00-INDEX s.7 states that `Default` reads "none (client-entered)"
-- for every threshold, rate, limit and amount, and that the platform ships no
-- client value and no statutory rate. A column would invite one.
-- -----------------------------------------------------------------------------

CREATE TABLE settings_catalogue (
  field_id          text        PRIMARY KEY
                      CHECK (field_id ~ '^AS-[A-Z]{3}-[A-Z0-9-]*[0-9]{3}$' OR field_id ~ '^AS-[A-Z]{3}-[A-Z]+-[0-9]{3}$'),
  family            text        NOT NULL
                      CHECK (family IN ('AS-ORG', 'AS-SYS', 'AS-COA', 'AS-DOA', 'AS-REG', 'AS-RUL', 'AS-SCP', 'AS-PPL')),
  label             text        NOT NULL,
  -- In business terms. Surfaced verbatim in a refusal message (s.13.3).
  purpose           text        NOT NULL,
  value_type        text        NOT NULL
                      CHECK (value_type IN ('string', 'integer', 'money', 'decimal', 'boolean', 'date', 'enum', 'reference', 'list', 'json')),
  enum_values       text[],
  requirement       text        NOT NULL
                      CHECK (requirement IN ('mandatory', 'conditional', 'optional')),
  requirement_condition text,
  -- Which scopes this field may be set at. A field scoped only tenant-wide
  -- cannot be overridden per entity, and the resolver enforces that.
  scopable_by       text[]      NOT NULL DEFAULT '{}',
  who_defines       text        NOT NULL,
  approval_needed   text,
  -- The SOP or module that reads this value, so a wrong setting is traceable.
  consumed_by       text[]      NOT NULL DEFAULT '{}',
  owner_role_ref    text        NOT NULL,
  enrolment_stage   integer     NOT NULL CHECK (enrolment_stage BETWEEN 1 AND 9),
  -- s.5 of admin-settings 00-INDEX: statutory particulars marked UNVERIFIED
  -- must be confirmed against the authority before go-live.
  requires_reverification boolean NOT NULL DEFAULT false,
  retired_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX settings_catalogue_family_idx ON settings_catalogue (family, enrolment_stage);
CREATE INDEX settings_catalogue_stage_idx  ON settings_catalogue (enrolment_stage)
  WHERE retired_at IS NULL;

COMMENT ON TABLE settings_catalogue IS
  'Shape of every AS- field. Ships no values: the platform holds no client value '
  'and no statutory rate (admin-settings 00-INDEX s.7).';

-- -----------------------------------------------------------------------------
-- Values — what a client actually entered.
--
-- `specificity` is generated, not supplied, so the precedence order in s.13.2
-- cannot be got wrong at a call site. Higher wins.
-- -----------------------------------------------------------------------------

CREATE TABLE settings_values (
  tenant_id       text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  field_id        text        NOT NULL REFERENCES settings_catalogue(field_id) ON DELETE RESTRICT,
  scope_entity    text        NOT NULL DEFAULT '*',
  scope_process   text        NOT NULL DEFAULT '*',
  scope_channel   text        NOT NULL DEFAULT '*',
  scope_role      text        NOT NULL DEFAULT '*',

  value           jsonb,
  -- A value the client has flagged as not yet decided. Treated as ABSENT by
  -- the resolver — the settings-health endpoint reports it separately so an
  -- enrolment gap is visible rather than silently failing closed later.
  is_tbc          boolean     NOT NULL DEFAULT false,
  value_hash      text        NOT NULL CHECK (value_hash ~ '^sha256:[0-9a-f]{64}$'),

  -- s.7 of admin-settings 00-INDEX: changes are effective-dated and never
  -- retrospective without explicit approval.
  effective_from  date        NOT NULL,
  effective_to    date,

  set_by          text        NOT NULL,
  approved_by     text,
  approved_at     timestamptz,
  source_note     text,

  specificity     smallint    GENERATED ALWAYS AS (
                    (CASE WHEN scope_entity  <> '*' THEN 8 ELSE 0 END) +
                    (CASE WHEN scope_process <> '*' THEN 4 ELSE 0 END) +
                    (CASE WHEN scope_channel <> '*' THEN 2 ELSE 0 END) +
                    (CASE WHEN scope_role    <> '*' THEN 1 ELSE 0 END)
                  ) STORED,

  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, field_id, scope_entity, scope_process, scope_channel, scope_role, effective_from),
  CONSTRAINT settings_values_effective_order CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- A TBC row carries no value; a live row does. Prevents the state where a
  -- field looks set but resolves to null.
  CONSTRAINT settings_values_tbc_has_no_value CHECK ((is_tbc AND value IS NULL) OR (NOT is_tbc AND value IS NOT NULL))
);

CREATE INDEX settings_values_lookup_idx
  ON settings_values (tenant_id, field_id, specificity DESC, effective_from DESC);
CREATE INDEX settings_values_entity_idx  ON settings_values (tenant_id, scope_entity);
CREATE INDEX settings_values_tbc_idx     ON settings_values (tenant_id, field_id) WHERE is_tbc;

-- -----------------------------------------------------------------------------
-- Snapshots — s.13.1
--
--   "A graph pins a settings snapshot version at plan time, exactly as it pins
--    knowledge versions, so a mid-run change cannot alter a decision halfway."
-- -----------------------------------------------------------------------------

CREATE TABLE settings_snapshots (
  tenant_id       text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  snapshot_id     text        NOT NULL,
  snapshot_version bigint     NOT NULL,
  -- Full materialised resolution at publish time. A pinned graph reads from
  -- here, never from settings_values, so a later publish cannot reach it.
  resolved        jsonb       NOT NULL,
  -- Per-field value hashes, recorded on every PolicyVerdict that reads one.
  value_hashes    jsonb       NOT NULL,
  field_count     integer     NOT NULL,
  populated_count integer     NOT NULL,
  tbc_count       integer     NOT NULL,
  published_at    timestamptz NOT NULL DEFAULT now(),
  published_by    text        NOT NULL,
  superseded_at   timestamptz,
  PRIMARY KEY (tenant_id, snapshot_id)
);

CREATE UNIQUE INDEX settings_snapshots_version_idx
  ON settings_snapshots (tenant_id, snapshot_version DESC);
CREATE INDEX settings_snapshots_current_idx
  ON settings_snapshots (tenant_id, published_at DESC) WHERE superseded_at IS NULL;

-- A snapshot is a historical fact once published.
CREATE TRIGGER settings_snapshots_no_delete BEFORE DELETE ON settings_snapshots
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- -----------------------------------------------------------------------------
-- Resolution with precedence — s.13.2
--
-- Returns at most one row: the most specific value in force on the as-of date.
-- Rows flagged TBC are excluded, because "a value the client has not decided"
-- and "no value" must behave identically at the point of use.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION resolve_setting(
  p_tenant_id     text,
  p_field_id      text,
  p_entity        text DEFAULT '*',
  p_process       text DEFAULT '*',
  p_channel       text DEFAULT '*',
  p_role          text DEFAULT '*',
  p_as_of         date DEFAULT CURRENT_DATE
) RETURNS TABLE (value jsonb, value_hash text, specificity smallint, effective_from date)
LANGUAGE sql STABLE AS $$
  SELECT sv.value, sv.value_hash, sv.specificity, sv.effective_from
    FROM settings_values sv
   WHERE sv.tenant_id = p_tenant_id
     AND sv.field_id  = p_field_id
     AND NOT sv.is_tbc
     AND sv.effective_from <= p_as_of
     AND (sv.effective_to IS NULL OR sv.effective_to >= p_as_of)
     -- A row scoped to a value must match it; a row scoped '*' matches anything.
     AND (sv.scope_entity  = '*' OR sv.scope_entity  = p_entity)
     AND (sv.scope_process = '*' OR sv.scope_process = p_process)
     AND (sv.scope_channel = '*' OR sv.scope_channel = p_channel)
     AND (sv.scope_role    = '*' OR sv.scope_role    = p_role)
   ORDER BY sv.specificity DESC, sv.effective_from DESC
   LIMIT 1
$$;

COMMENT ON FUNCTION resolve_setting IS
  'Precedence per DWD-06 s.13.2. Returns zero rows when absent — absence is a '
  'refusal upstream, never a default here.';

-- -----------------------------------------------------------------------------
-- Settings health — s.13.4
--
--   "GET /v1/config/settings/health returns, per family: field count, populated
--    count, blank required fields, fields whose value is TBC, snapshot version
--    and age."
--
-- PP/08 s.13 requires a complete configuration before any SOP runs; this view
-- is how that requirement becomes checkable rather than declared.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE VIEW settings_health AS
SELECT
  t.tenant_id,
  c.family,
  count(*)                                                          AS field_count,
  count(*) FILTER (WHERE v.value IS NOT NULL AND NOT v.is_tbc)       AS populated_count,
  count(*) FILTER (WHERE c.requirement = 'mandatory'
                     AND (v.value IS NULL OR v.is_tbc))              AS blank_mandatory_count,
  count(*) FILTER (WHERE v.is_tbc)                                   AS tbc_count,
  count(*) FILTER (WHERE c.requires_reverification)                  AS requires_reverification_count
FROM tenants t
CROSS JOIN settings_catalogue c
LEFT JOIN LATERAL (
  SELECT sv.value, sv.is_tbc
    FROM settings_values sv
   WHERE sv.tenant_id = t.tenant_id
     AND sv.field_id = c.field_id
     AND sv.effective_from <= CURRENT_DATE
     AND (sv.effective_to IS NULL OR sv.effective_to >= CURRENT_DATE)
   ORDER BY sv.specificity DESC, sv.effective_from DESC
   LIMIT 1
) v ON true
WHERE c.retired_at IS NULL
GROUP BY t.tenant_id, c.family;
