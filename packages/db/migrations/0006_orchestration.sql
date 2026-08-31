-- =============================================================================
-- S9 Orchestration — conversations, contexts, task graphs, and the durable
-- workflow executor. DWD-06 s.3.3-s.3.9, s.7, s.8, s.9.
--
-- The workflow tables implement s.9 without a Temporal deployment:
--
--   s.9.1 "Workflow code must be deterministic: no clock reads, no random
--          values, no direct I/O, no model calls. Every non-deterministic input
--          arrives as an activity result recorded in history. This is what
--          makes replay safe."
--   s.9.2 "A crash between two boundaries replays from the earlier one, and any
--          activity that already completed is served from history rather than
--          re-executed."
--   s.9.5 "Versioned workflow definitions; in-flight graphs continue on their
--          pinned definition version."
--
-- `workflow_events` is that history. It is append-only for the same reason the
-- audit log is: a rewritten history produces a different replay, and a replay
-- that differs from what actually happened is worse than no history at all.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Conversations — DWD-06 s.3.3, s.7.1
-- -----------------------------------------------------------------------------

CREATE TABLE conversations (
  tenant_id           text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  conversation_key    text        NOT NULL,
  principal_id        text,
  channels_seen       text[]      NOT NULL,
  primary_channel     text        NOT NULL,
  state               text        NOT NULL DEFAULT 'active'
                        CHECK (state IN ('active', 'awaiting_human', 'escalated', 'closed', 'terminated', 'suspended', 'purged')),
  opened_at           timestamptz NOT NULL DEFAULT now(),
  last_activity_at    timestamptz NOT NULL DEFAULT now(),
  -- Idle expiry from AS-PPL-*. Closing DESTROYS working memory (s.3.3).
  closes_at           timestamptz NOT NULL,
  context_ref         text,
  working_memory_ref  text,
  preference_snapshot jsonb,
  -- Minimum of the ceilings of channels_seen. A conversation that has touched
  -- WhatsApp can never carry confidential content afterwards.
  sensitivity_ceiling text        NOT NULL
                        CHECK (sensitivity_ceiling IN ('public', 'internal', 'confidential', 'restricted')),
  handoff_open        boolean     NOT NULL DEFAULT false,
  purged_at           timestamptz,
  PRIMARY KEY (tenant_id, conversation_key)
);

CREATE INDEX conversations_principal_idx ON conversations (tenant_id, principal_id, last_activity_at DESC);
CREATE INDEX conversations_state_idx     ON conversations (tenant_id, state);
-- Drives the idle-close sweeper.
CREATE INDEX conversations_expiry_idx    ON conversations (tenant_id, closes_at)
  WHERE state = 'active';

-- -----------------------------------------------------------------------------
-- Messages — DWD-06 s.3.4
-- -----------------------------------------------------------------------------

CREATE TABLE messages (
  tenant_id             text        NOT NULL,
  message_id            text        NOT NULL,
  conversation_key      text        NOT NULL,
  direction             text        NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  channel               text        NOT NULL,
  transport_message_id  text,
  author_kind           text        NOT NULL CHECK (author_kind IN ('human', 'worker', 'system')),
  author_principal_id   text,
  sent_at               timestamptz NOT NULL,
  -- Content lives in the object store under the shortest retention consistent
  -- with audit; this column holds it only until that retention bites (s.10.7).
  content_text          text,
  content_ref           text,
  content_blocks        jsonb,
  attachment_ids        text[]      NOT NULL DEFAULT '{}',
  trust_class           text        NOT NULL
                          CHECK (trust_class IN ('untrusted_content', 'reference_data', 'system_instruction')),
  related_request_id    text,
  related_delivery_id   text,
  redaction_state       text        NOT NULL DEFAULT 'none'
                          CHECK (redaction_state IN ('none', 'partial', 'full')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, message_id),
  FOREIGN KEY (tenant_id, conversation_key) REFERENCES conversations(tenant_id, conversation_key) ON DELETE RESTRICT,
  -- DWD-06 s.3.4: "Inbound is always untrusted." A database-level guarantee, so
  -- an injected message cannot be promoted by any code path.
  CONSTRAINT messages_inbound_is_untrusted CHECK (
    direction <> 'inbound' OR trust_class = 'untrusted_content'
  )
);

CREATE INDEX messages_conversation_idx ON messages (tenant_id, conversation_key, sent_at DESC);
CREATE INDEX messages_request_idx      ON messages (tenant_id, related_request_id)
  WHERE related_request_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Resolved contexts — DWD-06 s.3.2
-- -----------------------------------------------------------------------------

CREATE TABLE contexts (
  tenant_id         text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  context_id        text        NOT NULL,
  request_id        text        NOT NULL,
  resolution_status text        NOT NULL CHECK (resolution_status IN ('resolved', 'partial', 'refused')),
  resolution_reason text,
  axes              jsonb       NOT NULL,
  pack_id           text        NOT NULL,
  pack_version      text        NOT NULL,
  residency_zone    text        NOT NULL,
  resolved_locale   text        NOT NULL,
  fiscal_period     jsonb,
  knowledge_pin     jsonb       NOT NULL,
  settings_snapshot_id text,
  -- The hash that feeds tool-call idempotency derivation (s.8.1).
  context_token_hash text       NOT NULL,
  resolved_at       timestamptz NOT NULL DEFAULT now(),
  -- s.7.3: "a graph never resumes on an expired context."
  expires_at        timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, context_id),
  CONSTRAINT contexts_reason_when_not_resolved CHECK (
    resolution_status = 'resolved' OR resolution_reason IS NOT NULL
  )
);

CREATE INDEX contexts_request_idx ON contexts (tenant_id, request_id);
CREATE INDEX contexts_expiry_idx  ON contexts (tenant_id, expires_at);

-- -----------------------------------------------------------------------------
-- Task graphs — DWD-06 s.3.5, s.7.2
-- -----------------------------------------------------------------------------

CREATE TABLE task_graphs (
  tenant_id           text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  graph_id            text        NOT NULL,
  request_id          text        NOT NULL,
  conversation_key    text,
  context_ref         text        NOT NULL,
  trigger_class       text        NOT NULL CHECK (trigger_class IN ('request', 'schedule', 'event', 'watch')),
  intent              text        NOT NULL,
  root_skill_id       text        NOT NULL,
  skill_version       text        NOT NULL,
  effective_autonomy  text        NOT NULL CHECK (effective_autonomy IN ('observe', 'draft', 'execute')),
  autonomy_basis      jsonb       NOT NULL,
  edges               jsonb       NOT NULL DEFAULT '[]'::jsonb,
  sequence_ranks      jsonb       NOT NULL DEFAULT '{}'::jsonb,
  admission           jsonb       NOT NULL,
  budget              jsonb       NOT NULL,
  -- Running total, checked before every model and tool call (s.11.4).
  spend_minor         bigint      NOT NULL DEFAULT 0,
  tokens_used         bigint      NOT NULL DEFAULT 0,
  state               text        NOT NULL DEFAULT 'compiled'
                        CHECK (state IN (
                          'compiled', 'admitted', 'refused', 'running', 'retrying',
                          'awaiting_approval', 'escalated', 'halted', 'compensating',
                          'compensated', 'authorising', 'delivering', 'completed',
                          'cancelled', 'failed', 'manual_intervention', 'suspended'
                        )),
  state_reason        text,
  workflow_run_id     text        NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  PRIMARY KEY (tenant_id, graph_id),
  FOREIGN KEY (tenant_id, context_ref) REFERENCES contexts(tenant_id, context_id) ON DELETE RESTRICT
);

CREATE INDEX task_graphs_request_idx ON task_graphs (tenant_id, request_id);
CREATE INDEX task_graphs_state_idx   ON task_graphs (tenant_id, state, created_at DESC);
CREATE INDEX task_graphs_skill_idx   ON task_graphs (tenant_id, root_skill_id, created_at DESC);
CREATE INDEX task_graphs_conv_idx    ON task_graphs (tenant_id, conversation_key)
  WHERE conversation_key IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Task nodes — DWD-06 s.3.6
-- -----------------------------------------------------------------------------

CREATE TABLE task_nodes (
  tenant_id       text        NOT NULL,
  graph_id        text        NOT NULL,
  node_id         text        NOT NULL,
  kind            text        NOT NULL
                    CHECK (kind IN ('grounding', 'skill', 'gate', 'tool_call', 'handoff', 'assurance', 'authorisation', 'delivery', 'compensation')),
  label           text        NOT NULL,
  owner_kind      text        NOT NULL CHECK (owner_kind IN ('skill', 'tool', 'human', 'platform')),
  owner_ref       text        NOT NULL,
  sop_step_ref    text,
  depends_on      text[]      NOT NULL DEFAULT '{}',
  -- s.9.6: irreversible nodes hold the highest rank. The ordering constraint is
  -- asserted before any irreversible node runs.
  sequence_rank   integer     NOT NULL,
  state           text        NOT NULL DEFAULT 'pending'
                    CHECK (state IN ('pending', 'ready', 'running', 'retrying', 'completed', 'failed', 'skipped', 'compensated', 'refused')),
  state_changing  boolean     NOT NULL DEFAULT false,
  irreversible    boolean     NOT NULL DEFAULT false,
  idempotency_key text        CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[0-9a-f]{64}$'),
  compensation    jsonb,
  dry_run         boolean     NOT NULL DEFAULT true,
  attempt         integer     NOT NULL DEFAULT 0,
  max_attempts    integer     NOT NULL DEFAULT 3,
  started_at      timestamptz,
  ended_at        timestamptz,
  confidence      numeric(5,4),
  cost_minor      bigint      NOT NULL DEFAULT 0,
  cost_currency   text,
  failure         jsonb,
  PRIMARY KEY (tenant_id, graph_id, node_id),
  FOREIGN KEY (tenant_id, graph_id) REFERENCES task_graphs(tenant_id, graph_id) ON DELETE RESTRICT,
  -- s.3.6: a state-changing node carries an idempotency key, without exception.
  CONSTRAINT task_nodes_state_changing_has_key CHECK (
    NOT state_changing OR idempotency_key IS NOT NULL
  ),
  -- s.3.6: reversible state change declares its compensation.
  CONSTRAINT task_nodes_reversible_has_compensation CHECK (
    NOT state_changing OR irreversible OR compensation IS NOT NULL
  )
);

CREATE INDEX task_nodes_graph_rank_idx ON task_nodes (tenant_id, graph_id, sequence_rank);
CREATE INDEX task_nodes_state_idx      ON task_nodes (tenant_id, state)
  WHERE state IN ('ready', 'running', 'retrying');

-- -----------------------------------------------------------------------------
-- Policy verdicts — DWD-06 s.3.7
-- -----------------------------------------------------------------------------

CREATE TABLE policy_verdicts (
  tenant_id                 text        NOT NULL,
  verdict_id                text        NOT NULL,
  graph_id                  text        NOT NULL,
  node_id                   text        NOT NULL,
  rule_id                   text        NOT NULL,
  rule_version              text        NOT NULL,
  context_selector          jsonb       NOT NULL,
  condition_evaluated       text        NOT NULL,
  inputs_hash               text        NOT NULL,
  verdict                   text        NOT NULL CHECK (verdict IN ('allow', 'dual_control', 'escalate', 'refuse')),
  -- References plus hashes, never inline client values (s.3.7).
  threshold_values          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  precedence_rank           integer     NOT NULL,
  effective_from            date        NOT NULL,
  effective_to              date,
  owner_ref                 text        NOT NULL,
  immutable_rules_evaluated smallint[]  NOT NULL DEFAULT '{}',
  immutable_rule_engaged    smallint    CHECK (immutable_rule_engaged BETWEEN 1 AND 11),
  decided_at                timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, verdict_id),
  FOREIGN KEY (tenant_id, graph_id) REFERENCES task_graphs(tenant_id, graph_id) ON DELETE RESTRICT,
  -- s.3.7: an engaged immutable rule forces refuse, regardless of the rule
  -- verdict. Stored as a constraint so the contradiction cannot be persisted.
  CONSTRAINT policy_verdicts_immutable_forces_refuse CHECK (
    immutable_rule_engaged IS NULL OR verdict = 'refuse'
  )
);

CREATE INDEX policy_verdicts_graph_idx ON policy_verdicts (tenant_id, graph_id);
CREATE INDEX policy_verdicts_rule_idx  ON policy_verdicts (tenant_id, rule_id, decided_at DESC);
CREATE INDEX policy_verdicts_immutable_idx
  ON policy_verdicts (tenant_id, immutable_rule_engaged, decided_at DESC)
  WHERE immutable_rule_engaged IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Skill invocations — DWD-06 s.3.8
-- -----------------------------------------------------------------------------

CREATE TABLE skill_invocations (
  tenant_id         text        NOT NULL,
  invocation_id     text        NOT NULL,
  graph_id          text        NOT NULL,
  node_id           text        NOT NULL,
  skill_id          text        NOT NULL,
  skill_version     text        NOT NULL,
  mode              text        NOT NULL CHECK (mode IN ('analyse', 'draft', 'execute')),
  context_ref       text        NOT NULL,
  inputs_ref        text        NOT NULL,
  inputs_hash       text        NOT NULL,
  knowledge_used    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  records_used      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  tool_call_ids     text[]      NOT NULL DEFAULT '{}',
  model_route       jsonb       NOT NULL,
  output_ref        text,
  output_hash       text,
  citations         jsonb       NOT NULL DEFAULT '[]'::jsonb,
  confidence        numeric(5,4),
  quality_criteria_results jsonb NOT NULL DEFAULT '[]'::jsonb,
  tokens_input      integer     NOT NULL DEFAULT 0,
  tokens_output     integer     NOT NULL DEFAULT 0,
  cost_minor        bigint      NOT NULL DEFAULT 0,
  cost_currency     text        NOT NULL DEFAULT 'MYR',
  duration_ms       integer     NOT NULL DEFAULT 0,
  status            text        NOT NULL CHECK (status IN ('succeeded', 'refused', 'failed', 'halted')),
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, invocation_id),
  FOREIGN KEY (tenant_id, graph_id) REFERENCES task_graphs(tenant_id, graph_id) ON DELETE RESTRICT
);

CREATE INDEX skill_invocations_graph_idx ON skill_invocations (tenant_id, graph_id);
CREATE INDEX skill_invocations_skill_idx ON skill_invocations (tenant_id, skill_id, created_at DESC);

-- -----------------------------------------------------------------------------
-- Tool calls — DWD-06 s.3.9
-- -----------------------------------------------------------------------------

CREATE TABLE tool_calls (
  tenant_id                 text        NOT NULL,
  tool_call_id              text        NOT NULL,
  graph_id                  text        NOT NULL,
  node_id                   text        NOT NULL,
  invocation_id             text,
  tool_id                   text        NOT NULL,
  capability_schema_version text        NOT NULL,
  permission_scope_requested text       NOT NULL,
  -- s.3.9: "a difference is a refusal, never a downgrade-and-proceed."
  permission_scope_granted  text,
  scope_qualifiers          jsonb       NOT NULL DEFAULT '{}'::jsonb,
  authority_ref             jsonb       NOT NULL,
  state_changing            boolean     NOT NULL,
  dry_run                   boolean     NOT NULL,
  idempotency_key           text        CHECK (idempotency_key IS NULL OR idempotency_key ~ '^[0-9a-f]{64}$'),
  request_hash              text        NOT NULL,
  attempt                   integer     NOT NULL DEFAULT 1,
  started_at                timestamptz NOT NULL DEFAULT now(),
  ended_at                  timestamptz,
  outcome                   text        NOT NULL DEFAULT 'dry_run'
                              CHECK (outcome IN ('success', 'failure', 'refused', 'dry_run')),
  provider_reference        text,
  business_key              text,
  rate_limit_remaining      integer,
  cost_minor                bigint      NOT NULL DEFAULT 0,
  cost_currency             text        NOT NULL DEFAULT 'MYR',
  error                     jsonb,
  compensated_by            text,
  PRIMARY KEY (tenant_id, tool_call_id),
  FOREIGN KEY (tenant_id, graph_id) REFERENCES task_graphs(tenant_id, graph_id) ON DELETE RESTRICT,
  CONSTRAINT tool_calls_state_changing_has_key CHECK (
    NOT state_changing OR idempotency_key IS NOT NULL
  )
);

CREATE INDEX tool_calls_graph_idx    ON tool_calls (tenant_id, graph_id);
CREATE INDEX tool_calls_tool_idx     ON tool_calls (tenant_id, tool_id, started_at DESC);
CREATE INDEX tool_calls_business_idx ON tool_calls (tenant_id, business_key)
  WHERE business_key IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Idempotency ledger — DWD-06 s.8.2
--
--   "Reservation is atomic (a conditional insert), so two concurrent workers
--    cannot both proceed. This is the mechanism that makes 'a retry can never
--    double-post' true rather than aspirational."
-- -----------------------------------------------------------------------------

CREATE TABLE idempotency_records (
  tenant_id     text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  key           text        NOT NULL CHECK (key ~ '^[0-9a-f]{64}$'),
  family        text        NOT NULL
                  CHECK (family IN ('inbound_dedupe', 'api_request', 'tool_call', 'outbound_delivery')),
  state         text        NOT NULL DEFAULT 'in_flight'
                  CHECK (state IN ('in_flight', 'completed', 'failed_permanent')),
  request_hash  text        NOT NULL,
  outcome_ref   text,
  provider_reference text,
  outcome_body  jsonb,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  -- s.8.1: expiry windows are set longer than any possible provider retry.
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

CREATE INDEX idempotency_records_expiry_idx ON idempotency_records (expires_at);
CREATE INDEX idempotency_records_family_idx ON idempotency_records (tenant_id, family, first_seen_at DESC);

-- =============================================================================
-- The durable workflow executor
-- =============================================================================

CREATE TABLE workflow_runs (
  tenant_id           text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  workflow_run_id     text        NOT NULL,
  graph_id            text,
  workflow_type       text        NOT NULL,
  -- s.9.5: in-flight graphs continue on their PINNED definition version, so a
  -- deploy mid-run cannot change the branch a replay takes.
  definition_version  text        NOT NULL,
  state               text        NOT NULL DEFAULT 'running'
                        CHECK (state IN ('running', 'awaiting_signal', 'awaiting_timer', 'completed', 'failed', 'cancelled', 'suspended')),
  input               jsonb       NOT NULL,
  result              jsonb,
  failure             jsonb,
  -- Monotonic; every history event takes the next value.
  next_sequence       bigint      NOT NULL DEFAULT 1,
  -- Lease-based dispatch: a worker claims a run for lease_seconds, and the
  -- sweeper reclaims an expired lease. A crashed worker therefore costs one
  -- lease period, not a stuck workflow.
  leased_by           text,
  leased_until        timestamptz,
  -- When the run becomes eligible again (timer due, retry backoff elapsed).
  runnable_at         timestamptz NOT NULL DEFAULT now(),
  started_at          timestamptz NOT NULL DEFAULT now(),
  completed_at        timestamptz,
  PRIMARY KEY (tenant_id, workflow_run_id)
);

-- The dispatch query. The partial predicate keeps the index small however much
-- history accumulates; `leased_until` is a leading column rather than part of
-- the predicate because `now()` is not IMMUTABLE and cannot appear in one, so
-- the lease comparison happens at query time against this index.
CREATE INDEX workflow_runs_dispatch_idx
  ON workflow_runs (leased_until NULLS FIRST, runnable_at, tenant_id)
  WHERE state IN ('running', 'awaiting_timer');
CREATE INDEX workflow_runs_graph_idx ON workflow_runs (tenant_id, graph_id) WHERE graph_id IS NOT NULL;
CREATE INDEX workflow_runs_state_idx ON workflow_runs (tenant_id, state);

-- -----------------------------------------------------------------------------
-- Event history — the replay log.
--
-- Append-only. A completed activity is served from here on replay rather than
-- re-executed (s.9.2), which is what makes a crash mid-graph safe.
-- -----------------------------------------------------------------------------

CREATE TABLE workflow_events (
  tenant_id       text        NOT NULL,
  workflow_run_id text        NOT NULL,
  sequence_number bigint      NOT NULL,
  event_type      text        NOT NULL
                    CHECK (event_type IN (
                      'workflow_started', 'workflow_completed', 'workflow_failed',
                      'workflow_cancelled', 'workflow_suspended', 'workflow_resumed',
                      'activity_scheduled', 'activity_completed', 'activity_failed',
                      'timer_started', 'timer_fired', 'timer_cancelled',
                      'signal_received', 'marker_recorded',
                      'compensation_scheduled', 'compensation_completed', 'compensation_failed'
                    )),
  -- The deterministic call-site identity. On replay the executor matches an
  -- activity request to its recorded result by this, NOT by wall-clock order.
  activity_id     text,
  activity_type   text,
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  attempt         integer     NOT NULL DEFAULT 1,
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, workflow_run_id, sequence_number)
);

CREATE INDEX workflow_events_activity_idx
  ON workflow_events (tenant_id, workflow_run_id, activity_id) WHERE activity_id IS NOT NULL;

CREATE TRIGGER workflow_events_no_update BEFORE UPDATE ON workflow_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER workflow_events_no_delete BEFORE DELETE ON workflow_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

COMMENT ON TABLE workflow_events IS
  'Durable replay history. Append-only: a rewritten history produces a replay '
  'that differs from what happened, which is worse than no history (s.9.1).';

-- -----------------------------------------------------------------------------
-- Timers — s.7.3
--
-- Every wait is durable and every timeout has a governed outcome. An
-- `awaiting_approval` implemented as an in-memory timer is a red flag (s.7.4);
-- these rows are that timer.
-- -----------------------------------------------------------------------------

CREATE TABLE workflow_timers (
  tenant_id       text        NOT NULL,
  timer_id        text        NOT NULL,
  workflow_run_id text        NOT NULL,
  timer_kind      text        NOT NULL
                    CHECK (timer_kind IN ('node_timeout', 'graph_latency_ceiling', 'handoff_sla', 'escalation_sla', 'nonce_expiry', 'context_ttl', 'conversation_idle', 'retry_backoff', 'schedule_tick', 'watch_poll')),
  due_at          timestamptz NOT NULL,
  fired_at        timestamptz,
  cancelled_at    timestamptz,
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, timer_id)
);

CREATE INDEX workflow_timers_due_idx
  ON workflow_timers (due_at) WHERE fired_at IS NULL AND cancelled_at IS NULL;
CREATE INDEX workflow_timers_run_idx ON workflow_timers (tenant_id, workflow_run_id);

-- -----------------------------------------------------------------------------
-- Signals — the durable wait behind a hand-off (s.9.1).
--
--   "Hand-off wait: workflow signal wait. Durable; no thread is held."
-- -----------------------------------------------------------------------------

CREATE TABLE workflow_signals (
  tenant_id       text        NOT NULL,
  signal_id       text        NOT NULL,
  workflow_run_id text        NOT NULL,
  signal_name     text        NOT NULL,
  payload         jsonb       NOT NULL DEFAULT '{}'::jsonb,
  received_at     timestamptz NOT NULL DEFAULT now(),
  consumed_at     timestamptz,
  PRIMARY KEY (tenant_id, signal_id)
);

CREATE INDEX workflow_signals_pending_idx
  ON workflow_signals (tenant_id, workflow_run_id, signal_name) WHERE consumed_at IS NULL;

-- -----------------------------------------------------------------------------
-- Compensation stack — s.9.4
--
--   "Every successful state-changing activity pushes an entry. On a failure
--    that cannot be retried: stop admitting nodes, determine the last
--    consistent boundary, pop and invoke compensations in REVERSE order."
-- -----------------------------------------------------------------------------

CREATE TABLE compensation_stack (
  tenant_id             text        NOT NULL,
  graph_id              text        NOT NULL,
  stack_position        integer     NOT NULL,
  node_id               text        NOT NULL,
  compensation_tool_id  text        NOT NULL,
  compensation_key      text        NOT NULL CHECK (compensation_key ~ '^[0-9a-f]{64}$'),
  business_key          text,
  provider_reference    text,
  original_tool_call_id text        NOT NULL,
  state                 text        NOT NULL DEFAULT 'pending'
                          CHECK (state IN ('pending', 'running', 'completed', 'failed', 'abandoned')),
  attempt               integer     NOT NULL DEFAULT 0,
  pushed_at             timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  failure               jsonb,
  PRIMARY KEY (tenant_id, graph_id, stack_position),
  FOREIGN KEY (tenant_id, graph_id) REFERENCES task_graphs(tenant_id, graph_id) ON DELETE RESTRICT
);

-- Popped in reverse order.
CREATE INDEX compensation_stack_pending_idx
  ON compensation_stack (tenant_id, graph_id, stack_position DESC) WHERE state = 'pending';

-- -----------------------------------------------------------------------------
-- Scheduled and watch triggers — DWD-06 s.1.4, roadmap Phase 6.
--
-- s.1: red flag — "A scheduled job with a hard-coded entity or as-of date."
-- The as-of date is therefore a RULE evaluated at fire time, never a literal.
-- -----------------------------------------------------------------------------

CREATE TABLE trigger_definitions (
  tenant_id         text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  trigger_id        text        NOT NULL,
  trigger_class     text        NOT NULL CHECK (trigger_class IN ('schedule', 'event', 'watch')),
  skill_id          text        NOT NULL,
  entity_id         text        NOT NULL,
  -- e.g. 'period_end', 'today_minus_1', 'last_closed_period'. Resolved by the
  -- context resolver at fire time against the tenant's fiscal calendar.
  as_of_date_rule   text        NOT NULL,
  cron_expression   text,
  timezone          text        NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
  event_source      text,
  event_filter      jsonb,
  watch_query       jsonb,
  watch_last_hash   text,
  poll_interval_seconds integer,
  enabled           boolean     NOT NULL DEFAULT false,
  last_fired_at     timestamptz,
  next_fire_at      timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, trigger_id),
  CONSTRAINT trigger_definitions_schedule_has_cron CHECK (
    trigger_class <> 'schedule' OR cron_expression IS NOT NULL
  ),
  CONSTRAINT trigger_definitions_watch_has_query CHECK (
    trigger_class <> 'watch' OR (watch_query IS NOT NULL AND poll_interval_seconds IS NOT NULL)
  )
);

CREATE INDEX trigger_definitions_due_idx
  ON trigger_definitions (next_fire_at) WHERE enabled AND next_fire_at IS NOT NULL;

CREATE TRIGGER trigger_definitions_touch BEFORE UPDATE ON trigger_definitions
  FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
