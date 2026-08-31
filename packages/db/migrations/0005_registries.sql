-- =============================================================================
-- S6 Registries — skill (L4), tool (L6), policy rules (L5), output classes (L9),
-- plus the dependency reverse index.
--
--   file 05 s.10: "nothing outside the registry is callable."
--   file 01 s.7.3: "If an output class is not in the register, it is reserved
--                   by default until the register is extended through change
--                   control."
--
-- Registries are platform-owned (a skill is the same skill for every tenant);
-- what differs per tenant is the AS-SCP- grant, which lives in settings.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Output-class register — file 01 s.7.2, the L9 reserved-acts register.
--
-- This is the table that makes "the worker is never an approver" structural.
-- A class with reserved_act = true has an autonomy ceiling that no tenant
-- configuration can raise, because raising it is a platform change, not a
-- configuration change (s.7.3).
-- -----------------------------------------------------------------------------

CREATE TABLE output_class_register (
  output_class            text        PRIMARY KEY,
  label                   text        NOT NULL,
  reserved_act            boolean     NOT NULL,
  worker_maximum_contribution text    NOT NULL,
  accountable_role_ref    text        NOT NULL,
  minimum_competency_level text       NOT NULL,
  gate_behaviour          text        NOT NULL
                            CHECK (gate_behaviour IN (
                              'hard_stop', 'degrade_to_prepare', 'route_to_supervisor',
                              'field_level_write_denial', 'class_check_at_send', 'grounding_gate'
                            )),
  -- 'none' encodes "Not applicable" in the register: the worker may not
  -- produce this class at any autonomy level.
  autonomy_ceiling        text        NOT NULL
                            CHECK (autonomy_ceiling IN ('none', 'observe', 'draft', 'execute')),
  immutable_rule_ref      integer     CHECK (immutable_rule_ref BETWEEN 1 AND 11),
  notes                   text,
  created_at              timestamptz NOT NULL DEFAULT now(),
  -- A reserved act can never be completed unattended.
  CONSTRAINT output_class_reserved_not_execute CHECK (
    NOT reserved_act OR autonomy_ceiling IN ('none', 'observe', 'draft')
  )
);

COMMENT ON TABLE output_class_register IS
  'The L9 reserved-acts register (file 01 s.7.2). Platform-owned. Moving a Yes '
  'to a No is a platform change and is refused as a configuration change.';

-- -----------------------------------------------------------------------------
-- Skill registry — file 05 s.2.1, the L4 minimum schema plus five extensions.
-- -----------------------------------------------------------------------------

CREATE TABLE skill_registry (
  skill_id            text        NOT NULL CHECK (skill_id ~ '^SK-[A-Z0-9]+-[0-9]{2}$'),
  semantic_version    text        NOT NULL CHECK (semantic_version ~ '^\d+\.\d+\.\d+$'),
  purpose             text        NOT NULL,
  role_level          text        NOT NULL,
  role_ref            text        NOT NULL,

  -- The SOP this skill was compiled from, plus the content hash that is the
  -- tripwire for `sop_content_hash_mismatch` revalidation (file 05 s.2.2).
  source_sop          jsonb       NOT NULL,
  sop_content_hash    text        NOT NULL,

  required_knowledge  jsonb       NOT NULL,
  required_tools      jsonb       NOT NULL,
  input_schema        jsonb       NOT NULL,
  output_schema       jsonb       NOT NULL,
  quality_criteria    text[]      NOT NULL,

  -- file 05 s.2.2: the platform supplies the metric definition and the
  -- measurement window, NEVER the number. The floor itself is at AS-SCP-*.
  accuracy_metric     text        NOT NULL,
  accuracy_floor_ref  text        NOT NULL,
  accuracy_measurement text       NOT NULL,
  breach_action       text        NOT NULL DEFAULT 'pull_back_one_level'
                        CHECK (breach_action IN ('pull_back_one_level', 'suspend')),

  revalidation_triggers text[]    NOT NULL,

  max_autonomy        text        NOT NULL CHECK (max_autonomy IN ('observe', 'draft', 'execute')),
  state_changing      boolean     NOT NULL,
  output_class        text        NOT NULL REFERENCES output_class_register(output_class) ON DELETE RESTRICT,
  accountable_human_ref text      NOT NULL,
  compensation        text,
  irreversible        boolean     NOT NULL DEFAULT false,
  channel_suitability text[]      NOT NULL,
  cost_envelope_ref   text        NOT NULL,

  status              text        NOT NULL DEFAULT 'draft'
                        CHECK (status IN ('draft', 'active', 'restricted', 'suspended', 'retired')),
  status_reason       text,
  published_at        timestamptz,
  retired_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, semantic_version),

  -- file 05 s.2.2: "A skill whose state change has no compensation sets
  -- irreversible: true." Encoded so the inconsistent pair cannot be stored.
  CONSTRAINT skill_registry_compensation_or_irreversible CHECK (
    NOT state_changing OR (compensation IS NOT NULL) = (NOT irreversible)
  )
);

CREATE INDEX skill_registry_status_idx ON skill_registry (status, skill_id);
CREATE INDEX skill_registry_class_idx  ON skill_registry (output_class);
-- One active version per skill: a superseded version stays resolvable for
-- pinned in-flight graphs (file 05 s.8.4), but only one is invocable.
CREATE UNIQUE INDEX skill_registry_one_active_idx
  ON skill_registry (skill_id) WHERE status IN ('active', 'restricted');

-- -----------------------------------------------------------------------------
-- Tool registry — file 05 s.10.1, the L6 registration schema.
-- -----------------------------------------------------------------------------

CREATE TABLE tool_registry (
  tool_id             text        PRIMARY KEY CHECK (tool_id ~ '^TL-[A-Z]+-[0-9]{2}$'),
  name                text        NOT NULL,
  class               text        NOT NULL,
  capability_schema   jsonb       NOT NULL,
  capability_schema_version text   NOT NULL,
  permission_scope    text        NOT NULL,
  scope_qualifiers    text[]      NOT NULL DEFAULT '{}',

  -- file 05 s.10: rate limits and costs are ALWAYS client-entered, because both
  -- are contractual facts about the client's licence and infrastructure.
  rate_limit_ref      text        NOT NULL,
  cost_per_call_ref   text        NOT NULL,
  timeout_ref         text        NOT NULL,

  state_changing      boolean     NOT NULL,
  dry_run_support     boolean     NOT NULL,
  dry_run_default     boolean     NOT NULL DEFAULT true,
  idempotency_key_required boolean NOT NULL,
  idempotency_key_derivation text,
  compensation_tool_id text,
  irreversible        boolean     NOT NULL DEFAULT false,

  retry_policy        text        NOT NULL DEFAULT 'transient_only_exponential_backoff_jitter',
  credential_ref      text        NOT NULL,
  residency_zone_ref  text        NOT NULL,
  sandbox_profile     text        NOT NULL DEFAULT 'connector_runtime_default',
  owner_ref           text        NOT NULL,

  -- file 05 s.11.2: graduation is per connector and per tool, never per system.
  --   1 stub → 2 sandbox → 3 live read-only / live dry-run → 4 live write
  graduation_stage    smallint    NOT NULL DEFAULT 1 CHECK (graduation_stage BETWEEN 1 AND 4),
  status              text        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active', 'suspended', 'retired')),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),

  -- A state-changing tool must support dry-run; that is how staging can force
  -- it on at the runtime (s.14.3).
  CONSTRAINT tool_registry_state_changing_has_dry_run CHECK (
    NOT state_changing OR dry_run_support
  ),
  -- A state-changing tool must require an idempotency key. This is the
  -- mechanism behind "a retry can never double-post" (s.8.2).
  CONSTRAINT tool_registry_state_changing_needs_key CHECK (
    NOT state_changing OR idempotency_key_required
  ),
  -- Reversible means there is something to reverse it with.
  CONSTRAINT tool_registry_compensation_or_irreversible CHECK (
    NOT state_changing OR (compensation_tool_id IS NOT NULL) = (NOT irreversible)
  )
);

CREATE INDEX tool_registry_class_idx ON tool_registry (class, status);
CREATE TRIGGER tool_registry_touch BEFORE UPDATE ON tool_registry
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- Per-tenant graduation. A tool live for one client is a stub for another.
CREATE TABLE tool_grants (
  tenant_id         text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  tool_id           text        NOT NULL REFERENCES tool_registry(tool_id) ON DELETE RESTRICT,
  graduation_stage  smallint    NOT NULL DEFAULT 1 CHECK (graduation_stage BETWEEN 1 AND 4),
  dry_run_forced    boolean     NOT NULL DEFAULT true,
  granted_scopes    text[]      NOT NULL DEFAULT '{}',
  scope_qualifiers  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  credential_handle text,
  enabled           boolean     NOT NULL DEFAULT false,
  graduated_at      timestamptz,
  graduated_by      text,
  demoted_at        timestamptz,
  demotion_reason   text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, tool_id)
);

CREATE TRIGGER tool_grants_touch BEFORE UPDATE ON tool_grants
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- -----------------------------------------------------------------------------
-- Policy rules — DWD-06 s.3.7, the L5 policy rule minimum schema.
-- -----------------------------------------------------------------------------

CREATE TABLE policy_rules (
  rule_id           text        NOT NULL,
  rule_version      text        NOT NULL CHECK (rule_version ~ '^\d+\.\d+\.\d+$'),
  description       text        NOT NULL,
  -- Which contexts this rule applies to: jurisdiction, entity, process, class.
  context_selector  jsonb       NOT NULL,
  -- The condition, expressed against threshold REFERENCES rather than values.
  condition_expression text     NOT NULL,
  threshold_refs    text[]      NOT NULL DEFAULT '{}',
  verdict_on_pass   text        NOT NULL CHECK (verdict_on_pass IN ('allow', 'dual_control', 'escalate', 'refuse')),
  verdict_on_fail   text        NOT NULL CHECK (verdict_on_fail IN ('allow', 'dual_control', 'escalate', 'refuse')),
  precedence_rank   integer     NOT NULL,
  owner_ref         text        NOT NULL,
  effective_from    date        NOT NULL,
  effective_to      date,
  status            text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retired')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (rule_id, rule_version)
);

CREATE INDEX policy_rules_precedence_idx
  ON policy_rules (precedence_rank DESC, effective_from DESC) WHERE status = 'active';
CREATE INDEX policy_rules_selector_idx ON policy_rules USING gin (context_selector);

-- -----------------------------------------------------------------------------
-- Dependency reverse index — file 05 s.7.1.
--
-- "Reverse-index queries in one hop." The graph store is deferrable (s.14.2);
-- until it lands, this relational edge table answers "which skills does this
-- chunk version change affect?" — which is what drives revalidation.
-- -----------------------------------------------------------------------------

CREATE TABLE skill_dependencies (
  skill_id        text        NOT NULL,
  skill_version   text        NOT NULL,
  dependency_kind text        NOT NULL
                    CHECK (dependency_kind IN ('knowledge_chunk', 'knowledge_module', 'tool', 'setting', 'sop', 'model_route', 'axis')),
  dependency_ref  text        NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (skill_id, skill_version, dependency_kind, dependency_ref),
  FOREIGN KEY (skill_id, skill_version) REFERENCES skill_registry(skill_id, semantic_version) ON DELETE CASCADE
);

-- The reverse direction is the one that matters: given a changed dependency,
-- which skills must be revalidated?
CREATE INDEX skill_dependencies_reverse_idx ON skill_dependencies (dependency_kind, dependency_ref);

-- -----------------------------------------------------------------------------
-- Revalidation queue — file 05 s.7.3, s.7.4.
--
-- "Autonomy behaviour while pending": a skill awaiting revalidation drops to a
-- lower ceiling rather than continuing at its granted level.
-- -----------------------------------------------------------------------------

CREATE TABLE skill_revalidations (
  tenant_id       text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  revalidation_id text        NOT NULL,
  skill_id        text        NOT NULL,
  skill_version   text        NOT NULL,
  trigger         text        NOT NULL
                    CHECK (trigger IN (
                      'l2_chunk_version_change_in_required_knowledge',
                      'l6_tool_capability_schema_change_in_required_tools',
                      'as_rul_threshold_change_referenced_by_this_skill',
                      'sop_content_hash_mismatch',
                      'accuracy_floor_breach',
                      'model_route_change_for_this_skill',
                      'jurisdiction_or_framework_axis_change_in_L0'
                    )),
  trigger_detail  text,
  -- The ceiling to apply while pending.
  interim_autonomy text       NOT NULL DEFAULT 'observe'
                    CHECK (interim_autonomy IN ('observe', 'draft')),
  status          text        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'in_progress', 'passed', 'failed')),
  raised_at       timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolved_by     text,
  PRIMARY KEY (tenant_id, revalidation_id)
);

CREATE INDEX skill_revalidations_pending_idx
  ON skill_revalidations (tenant_id, skill_id) WHERE status IN ('pending', 'in_progress');

-- -----------------------------------------------------------------------------
-- Scope cards — file 01 s.3.
--
--   "The Scope Card is a build artefact. It is generated, not authored. It has
--    no editable fields."
--   "The generator fails closed. Any unresolved reference aborts generation and
--    the previous card remains published with a staleness banner."
--   "The worker itself cannot generate, edit, approve or publish its own Scope
--    Card (AS-SCP-014)."
-- -----------------------------------------------------------------------------

CREATE TABLE scope_cards (
  tenant_id         text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  card_id           text        NOT NULL,
  card_version      text        NOT NULL CHECK (card_version ~ '^\d+\.\d+\.\d+$'),
  -- Byte-identical for identical inputs at identical versions (s.3.1 rule 1).
  content           jsonb       NOT NULL,
  content_hash      text        NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  -- Every generating input and its version, so a historical card is explicable.
  input_version_set jsonb       NOT NULL,
  effective_from    date        NOT NULL,
  effective_to      date,
  supersedes_version text,
  generated_at      timestamptz NOT NULL DEFAULT now(),
  published_at      timestamptz,
  -- Set when regeneration aborted on an unresolved reference; the previous
  -- card stays published and carries this banner.
  staleness_reason  text,
  PRIMARY KEY (tenant_id, card_id),
  -- s.3.4: "Backdating is prohibited. A card can never take effect before its
  -- approval record."
  CONSTRAINT scope_cards_no_backdating CHECK (effective_from >= generated_at::date)
);

CREATE UNIQUE INDEX scope_cards_version_idx ON scope_cards (tenant_id, card_version);
CREATE INDEX scope_cards_current_idx
  ON scope_cards (tenant_id, effective_from DESC) WHERE effective_to IS NULL;

-- A published card is the historical record of what the worker was permitted
-- to do on a given date. It is never edited or removed.
CREATE TRIGGER scope_cards_no_delete BEFORE DELETE ON scope_cards
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
