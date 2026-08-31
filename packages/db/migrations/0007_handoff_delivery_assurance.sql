-- =============================================================================
-- S8 Assurance, S11 Delivery, S12 Authorisation.
--
-- DWD-06 s.3.11-s.3.12, s.3.15-s.3.16; file 08 s.11 (the L8 evaluation spec).
--
--   s.15.1: "Assurance at S8, before skills run. The gate cannot be retrofitted
--            around behaviour that already shipped."
--   s.15.1: "Authorisation at S12, after delivery exists. Delivery must be
--            BLOCKABLE before authorisation is meaningful."
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Hand-offs — DWD-06 s.3.11
-- -----------------------------------------------------------------------------

CREATE TABLE handoffs (
  tenant_id             text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  handoff_id            text        NOT NULL,
  graph_id              text        NOT NULL,
  node_id               text        NOT NULL,
  bundle_id             text        NOT NULL,
  bundle_version        integer     NOT NULL,
  -- Exactly one, phrased as a decision (file 04 s.6.2).
  question              text        NOT NULL,
  decision_type         text        NOT NULL
                          CHECK (decision_type IN ('approve_output', 'authorise_action', 'resolve_exception', 'confirm_classification')),
  assignee_principal_id text        NOT NULL,
  assignee_role_ref     text        NOT NULL,
  assignee_source       text        NOT NULL,
  -- True for every irreversible node and every dual_control verdict (s.3.11).
  dual_control_required boolean     NOT NULL DEFAULT false,
  second_approver_principal_id text,
  second_approver_role_ref text,
  sod_exclusions_applied text[]     NOT NULL DEFAULT '{}',
  -- Exactly the four moves. A fifth is not representable (s.3.11).
  permitted_moves       text[]      NOT NULL DEFAULT '{approve,edit_and_approve,reject_with_reason,reassign}',
  delivery_channels     text[]      NOT NULL,
  approval_channels     text[]      NOT NULL,
  sla_due_at            timestamptz NOT NULL,
  sla_source            text        NOT NULL,
  escalation_target     text        NOT NULL,
  -- s.6.5: single-use, bound to (handoff_id, bundle_version, assignee), stored
  -- SERVER-SIDE AS A HASH and spent atomically on first valid use.
  nonce_hash            text        NOT NULL,
  nonce_expires_at      timestamptz NOT NULL,
  nonce_spent_at        timestamptz,
  state                 text        NOT NULL DEFAULT 'awaiting_action'
                          CHECK (state IN ('awaiting_action', 'awaiting_second_approver', 'actioned', 'escalated', 'expired', 'withdrawn')),
  -- s.7.3: "original SLA start not reset" on escalation.
  original_sla_started_at timestamptz NOT NULL DEFAULT now(),
  escalated_at          timestamptz,
  escalation_count      integer     NOT NULL DEFAULT 0,
  issued_at             timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz,
  PRIMARY KEY (tenant_id, handoff_id),
  FOREIGN KEY (tenant_id, graph_id) REFERENCES task_graphs(tenant_id, graph_id) ON DELETE RESTRICT,
  CONSTRAINT handoffs_moves_are_the_four CHECK (
    permitted_moves <@ ARRAY['approve','edit_and_approve','reject_with_reason','reassign']::text[]
    AND cardinality(permitted_moves) > 0
  ),
  CONSTRAINT handoffs_dual_control_has_second CHECK (
    NOT dual_control_required OR second_approver_principal_id IS NOT NULL
      OR state IN ('awaiting_action', 'expired', 'withdrawn')
  )
);

CREATE INDEX handoffs_assignee_idx
  ON handoffs (tenant_id, assignee_principal_id, state, sla_due_at);
CREATE INDEX handoffs_open_idx
  ON handoffs (tenant_id, sla_due_at) WHERE state IN ('awaiting_action', 'awaiting_second_approver');
CREATE INDEX handoffs_graph_idx ON handoffs (tenant_id, graph_id);
CREATE UNIQUE INDEX handoffs_nonce_idx ON handoffs (tenant_id, nonce_hash);

-- -----------------------------------------------------------------------------
-- Reviewer actions — DWD-06 s.3.12
--
-- Append-only: an approval is a personal act with legal weight, and editing the
-- record of who approved what is exactly what non-repudiation forbids.
-- -----------------------------------------------------------------------------

CREATE TABLE reviewer_actions (
  tenant_id                 text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  action_id                 text        NOT NULL,
  handoff_id                text        NOT NULL,
  bundle_version_acted_on   integer     NOT NULL,
  actor_principal_id        text        NOT NULL,
  actor_auth_method         text        NOT NULL,
  actor_channel             text        NOT NULL,
  move                      text        NOT NULL
                              CHECK (move IN ('approve', 'edit_and_approve', 'reject_with_reason', 'reassign')),
  nonce_valid               boolean     NOT NULL,
  reason_code               text,
  free_text                 text,
  diff_ref                  text,
  materiality               jsonb,
  approved_output_hash      text,
  acted_at                  timestamptz NOT NULL DEFAULT now(),
  ip_or_device_ref          text        NOT NULL DEFAULT 'obfuscated',
  second_approver_action_id text,
  PRIMARY KEY (tenant_id, action_id),
  FOREIGN KEY (tenant_id, handoff_id) REFERENCES handoffs(tenant_id, handoff_id) ON DELETE RESTRICT,
  -- s.3.12: "Required on approve and edit_and_approve; this exact artefact is
  -- what may be released."
  CONSTRAINT reviewer_actions_approve_has_hash CHECK (
    move NOT IN ('approve', 'edit_and_approve') OR approved_output_hash IS NOT NULL
  ),
  -- s.3.12: a material edit opens a change request and feeds L8.
  CONSTRAINT reviewer_actions_edit_has_materiality CHECK (
    move <> 'edit_and_approve' OR (materiality IS NOT NULL AND diff_ref IS NOT NULL)
  ),
  -- file 01 s.9.3: a reason code from the closed list, feeding drift monitors.
  CONSTRAINT reviewer_actions_reject_has_reason CHECK (
    move <> 'reject_with_reason' OR reason_code IS NOT NULL
  )
);

CREATE INDEX reviewer_actions_handoff_idx ON reviewer_actions (tenant_id, handoff_id);
CREATE INDEX reviewer_actions_actor_idx   ON reviewer_actions (tenant_id, actor_principal_id, acted_at DESC);
CREATE INDEX reviewer_actions_move_idx    ON reviewer_actions (tenant_id, move, acted_at DESC);

CREATE TRIGGER reviewer_actions_no_update BEFORE UPDATE ON reviewer_actions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER reviewer_actions_no_delete BEFORE DELETE ON reviewer_actions
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- -----------------------------------------------------------------------------
-- Deliveries — DWD-06 s.3.15
-- -----------------------------------------------------------------------------

CREATE TABLE deliveries (
  tenant_id             text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  delivery_id           text        NOT NULL,
  conversation_key      text,
  graph_id              text        NOT NULL,
  -- s.3.15: "No delivery without an authorisation decision." NOT NULL is the
  -- structural half; the FK to decision_records is the other half.
  decision_record_ref   text        NOT NULL,
  output_class          text        NOT NULL,
  recipient_principal_id text       NOT NULL,
  recipient_external    boolean     NOT NULL DEFAULT false,
  channel               text        NOT NULL,
  locale                text        NOT NULL,
  sensitivity           text        NOT NULL
                          CHECK (sensitivity IN ('public', 'internal', 'confidential', 'restricted')),
  payload_body_ref      text        NOT NULL,
  payload_attachments   jsonb       NOT NULL DEFAULT '[]'::jsonb,
  -- file 04 s.1: all five present, or the delivery is refused.
  contract_elements     jsonb       NOT NULL,
  idempotency_key       text        NOT NULL CHECK (idempotency_key ~ '^[0-9a-f]{64}$'),
  attempt_group         integer     NOT NULL DEFAULT 1,
  status                text        NOT NULL DEFAULT 'queued'
                          CHECK (status IN ('queued', 'accepted', 'delivered', 'read', 'failed', 'expired')),
  status_history        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  provider_reference    text,
  failure               jsonb,
  feedback_hook_kind    text        NOT NULL DEFAULT 'none'
                          CHECK (feedback_hook_kind IN ('reply_keyword', 'inline_control', 'callback_query', 'none')),
  feedback_hook_token   text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, delivery_id),
  FOREIGN KEY (tenant_id, decision_record_ref) REFERENCES decision_records(tenant_id, decision_id) ON DELETE RESTRICT,
  -- The five response-contract elements, enforced in the database. A partial
  -- contract is not storable, so it cannot be sent.
  CONSTRAINT deliveries_full_response_contract CHECK (
    (contract_elements ->> 'answer')::boolean AND
    (contract_elements ->> 'basis_and_citations')::boolean AND
    (contract_elements ->> 'status_and_limits')::boolean AND
    (contract_elements ->> 'exclusions')::boolean AND
    (contract_elements ->> 'next_action_and_owner')::boolean
  )
);

CREATE UNIQUE INDEX deliveries_idempotency_idx ON deliveries (tenant_id, idempotency_key);
CREATE INDEX deliveries_graph_idx      ON deliveries (tenant_id, graph_id);
CREATE INDEX deliveries_status_idx     ON deliveries (tenant_id, status, created_at DESC);
CREATE INDEX deliveries_recipient_idx  ON deliveries (tenant_id, recipient_principal_id, created_at DESC);
CREATE INDEX deliveries_feedback_idx   ON deliveries (tenant_id, feedback_hook_token)
  WHERE feedback_hook_token IS NOT NULL;

CREATE TRIGGER deliveries_touch BEFORE UPDATE ON deliveries
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

-- -----------------------------------------------------------------------------
-- Feedback events — DWD-06 s.3.16
-- -----------------------------------------------------------------------------

CREATE TABLE feedback_events (
  tenant_id               text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  feedback_id             text        NOT NULL,
  delivery_id             text,
  graph_id                text        NOT NULL,
  skill_id                text        NOT NULL,
  skill_version           text        NOT NULL,
  source                  text        NOT NULL
                            CHECK (source IN ('reviewer_action', 'explicit_rating', 'downstream_correction', 'audit_finding', 'sampling')),
  signal                  text        NOT NULL
                            CHECK (signal IN ('accepted', 'material_edit', 'immaterial_edit', 'rejected', 'reassigned', 'late', 'error_found')),
  category                text,
  free_text               text,
  correctness_label       text CHECK (correctness_label IN ('correct', 'incorrect', 'partially_correct')),
  labelled_by_principal_id text,
  labelled_by_role_ref    text,
  -- s.3.16: false for preference-only feedback, which never affects
  -- substantive measurement.
  affects_accuracy_floor  boolean     NOT NULL DEFAULT true,
  created_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, feedback_id)
);

CREATE INDEX feedback_events_skill_idx
  ON feedback_events (tenant_id, skill_id, created_at DESC) WHERE affects_accuracy_floor;
CREATE INDEX feedback_events_graph_idx ON feedback_events (tenant_id, graph_id);

-- =============================================================================
-- L8 assurance — file 08 s.11
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Suite cases. Golden and adversarial, versioned like any other artefact.
-- -----------------------------------------------------------------------------

CREATE TABLE assurance_cases (
  case_id           text        PRIMARY KEY,
  suite             text        NOT NULL CHECK (suite IN ('golden', 'adversarial', 'refusal', 'channel_rendering', 'arithmetic')),
  -- file 08 s.11.3: the adversarial classes with ZERO tolerated failures are
  -- escalation and exfiltration; the rest are tolerated-but-monitored.
  class             text        NOT NULL,
  zero_tolerance    boolean     NOT NULL DEFAULT false,
  skill_id          text,
  description       text        NOT NULL,
  input             jsonb       NOT NULL,
  expected          jsonb       NOT NULL,
  -- Weight in the pass-rate computation. Refusal correctness is weighted
  -- heavily (file 08 s.4.3 P1-4).
  weight            numeric(5,2) NOT NULL DEFAULT 1.0,
  enabled           boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX assurance_cases_suite_idx ON assurance_cases (suite, enabled);
CREATE INDEX assurance_cases_skill_idx ON assurance_cases (skill_id) WHERE skill_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Runs and results — the release gate's evidence.
-- -----------------------------------------------------------------------------

CREATE TABLE assurance_runs (
  run_id            text        PRIMARY KEY,
  harness_version   text        NOT NULL,
  platform_version  text        NOT NULL,
  git_sha           text,
  trigger           text        NOT NULL CHECK (trigger IN ('ci', 'manual', 'scheduled', 'pre_release', 'pre_push')),
  started_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  cases_run         integer     NOT NULL DEFAULT 0,
  cases_passed      integer     NOT NULL DEFAULT 0,
  weighted_pass_rate numeric(6,4),
  zero_tolerance_failures integer NOT NULL DEFAULT 0,
  -- s.14 red flag: "a go-live with the release gate advisory rather than
  -- blocking." The gate decision is recorded, not inferred.
  gate_decision     text        CHECK (gate_decision IN ('pass', 'fail')),
  gate_blocking     boolean     NOT NULL DEFAULT true,
  report_ref        text
);

CREATE INDEX assurance_runs_time_idx ON assurance_runs (started_at DESC);

CREATE TABLE assurance_results (
  run_id          text        NOT NULL REFERENCES assurance_runs(run_id) ON DELETE CASCADE,
  case_id         text        NOT NULL,
  passed          boolean     NOT NULL,
  score           numeric(6,4),
  gate            text,
  detail          text,
  actual          jsonb,
  duration_ms     integer,
  PRIMARY KEY (run_id, case_id)
);

CREATE INDEX assurance_results_failures_idx ON assurance_results (run_id) WHERE NOT passed;

-- -----------------------------------------------------------------------------
-- Accuracy floors and the pull-back rule — file 05 s.9.
--
--   s.9.4 pull-back rule: a breach lowers autonomy by one level automatically.
--   The platform supplies the metric and the window; the NUMBER is at AS-SCP-*.
-- -----------------------------------------------------------------------------

CREATE TABLE accuracy_measurements (
  tenant_id         text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  measurement_id    text        NOT NULL,
  skill_id          text        NOT NULL,
  skill_version     text        NOT NULL,
  entity_id         text        NOT NULL DEFAULT '*',
  metric            text        NOT NULL,
  window_start      timestamptz NOT NULL,
  window_end        timestamptz NOT NULL,
  sample_size       integer     NOT NULL,
  measured_value    numeric(6,4) NOT NULL,
  floor_value       numeric(6,4) NOT NULL,
  floor_source      text        NOT NULL,
  margin            numeric(6,4) GENERATED ALWAYS AS (measured_value - floor_value) STORED,
  breached          boolean     GENERATED ALWAYS AS (measured_value < floor_value) STORED,
  pull_back_applied boolean     NOT NULL DEFAULT false,
  measured_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, measurement_id)
);

CREATE INDEX accuracy_measurements_skill_idx
  ON accuracy_measurements (tenant_id, skill_id, measured_at DESC);
CREATE INDEX accuracy_measurements_breach_idx
  ON accuracy_measurements (tenant_id, measured_at DESC) WHERE breached;

-- -----------------------------------------------------------------------------
-- Incidents — PP/08 s.10.
--
-- file 01 s.7.2: the worker may DECLARE an incident and propose a severity;
-- re-grading is a human act, and downward re-grading needs the accountable
-- owner (AS-PPL-130).
-- -----------------------------------------------------------------------------

CREATE TABLE incidents (
  tenant_id             text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  incident_id           text        NOT NULL,
  declared_by_kind      text        NOT NULL CHECK (declared_by_kind IN ('worker', 'human', 'monitor')),
  declared_by_principal_id text,
  graph_id              text,
  category              text        NOT NULL,
  proposed_severity     text        NOT NULL,
  current_severity      text        NOT NULL,
  regraded_by_principal_id text,
  regraded_at           timestamptz,
  summary               text        NOT NULL,
  residual_state        text,
  state                 text        NOT NULL DEFAULT 'open'
                          CHECK (state IN ('open', 'investigating', 'mitigated', 'closed')),
  declared_at           timestamptz NOT NULL DEFAULT now(),
  closed_at             timestamptz,
  PRIMARY KEY (tenant_id, incident_id),
  -- The worker proposes; a human re-grades. A severity change without a named
  -- human is not storable.
  CONSTRAINT incidents_regrade_is_human CHECK (
    current_severity = proposed_severity OR regraded_by_principal_id IS NOT NULL
  )
);

CREATE INDEX incidents_open_idx ON incidents (tenant_id, declared_at DESC) WHERE state <> 'closed';
