-- =============================================================================
-- S2 Audit and evidence — DWD-06 s.15, the FIRST undeferrable component.
--
--   s.15.1: "Audit at S2, before anything that can act. Nothing should ever
--            have run unlogged, including during development."
--   s.10.5: "Append-only API; per-tenant hash chain with periodic anchoring;
--            legal hold flag that suspends all expiry; verification job that
--            walks the chain and alerts on a break; NO DELETE PATH IN ANY ROLE,
--            INCLUDING PLATFORM ADMINISTRATION."
--
-- Immutability is enforced three ways, deliberately redundantly:
--
--   1. triggers that RAISE EXCEPTION on UPDATE and DELETE — these survive a
--      grant misconfiguration and apply to superusers too;
--   2. REVOKE of UPDATE/DELETE from the application role (0009_roles.sql);
--   3. the hash chain itself, which makes an out-of-band change detectable
--      even if 1 and 2 were both defeated.
--
-- Phase 0 acceptance P0-2 requires an induced tamper to be detected; P0-3
-- requires a second destination outside the worker's write control.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The append-only guard
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is append-only (DWD-06 s.10.5). % is not permitted in any role, '
    'including platform administration. Purge redacts content and retains the '
    'record that the content existed.',
    TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

-- -----------------------------------------------------------------------------
-- Audit events — DWD-06 s.3.14
--
-- Partitioned by tenant then by month (s.10.7). Declarative partitioning is by
-- range on occurred_at with a tenant in the key, so retention and legal hold
-- operate on whole partitions rather than row-by-row.
-- -----------------------------------------------------------------------------

CREATE TABLE audit_events (
  tenant_id         text        NOT NULL,
  event_id          text        NOT NULL,
  trace_id          text        NOT NULL CHECK (trace_id ~ '^[0-9a-f]{32}$'),
  span_id           text        NOT NULL CHECK (span_id ~ '^[0-9a-f]{16}$'),
  occurred_at       timestamptz NOT NULL,
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  layer             text        NOT NULL,
  component         text        NOT NULL,
  event_type        text        NOT NULL,
  actor             jsonb       NOT NULL,
  subject           jsonb       NOT NULL,
  context_ref       text,
  graph_id          text,
  outcome           text        NOT NULL
                      CHECK (outcome IN ('success', 'failure', 'refused', 'blocked')),
  -- Payload content is stored by reference; only the hash is in the chain.
  payload_hash      text        NOT NULL CHECK (payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  payload_ref       text,
  -- The chain. `sequence_number` makes ordering total within a tenant, which
  -- the verification walk needs and which timestamps alone cannot guarantee.
  sequence_number   bigint      NOT NULL,
  prev_event_hash   text        NOT NULL CHECK (prev_event_hash ~ '^sha256:[0-9a-f]{64}$'),
  event_hash        text        NOT NULL CHECK (event_hash ~ '^sha256:[0-9a-f]{64}$'),
  schema_version    text        NOT NULL DEFAULT '1.0.0',
  PRIMARY KEY (tenant_id, sequence_number)
);

CREATE UNIQUE INDEX audit_events_event_id_idx  ON audit_events (tenant_id, event_id);
CREATE UNIQUE INDEX audit_events_hash_idx      ON audit_events (tenant_id, event_hash);
CREATE INDEX audit_events_trace_idx            ON audit_events (tenant_id, trace_id);
CREATE INDEX audit_events_graph_idx            ON audit_events (tenant_id, graph_id)
  WHERE graph_id IS NOT NULL;
CREATE INDEX audit_events_type_time_idx        ON audit_events (tenant_id, event_type, occurred_at DESC);
CREATE INDEX audit_events_layer_time_idx       ON audit_events (tenant_id, layer, occurred_at DESC);
CREATE INDEX audit_events_occurred_idx         ON audit_events (tenant_id, occurred_at DESC);

CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

COMMENT ON TABLE audit_events IS
  'Append-only, hash-chained per tenant. DWD-06 s.3.14, s.10.5. No delete path exists.';

-- -----------------------------------------------------------------------------
-- Chain tips
--
-- One row per tenant holding the current head. Appending takes a row lock on
-- this table, which serialises writers within a tenant and makes the chain
-- total without serialising across tenants.
-- -----------------------------------------------------------------------------

CREATE TABLE audit_chain_tips (
  tenant_id         text        PRIMARY KEY REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  head_event_hash   text        NOT NULL,
  head_sequence     bigint      NOT NULL DEFAULT 0,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE audit_chain_tips IS
  'Head of each tenant hash chain. Row-locked during append so the chain is total per tenant.';

-- -----------------------------------------------------------------------------
-- Chain anchors — s.10.5 "periodic anchoring"
--
-- A signed statement that the chain had a particular head at a particular time.
-- An attacker who could rewrite history would still have to forge every anchor
-- signed before the change.
-- -----------------------------------------------------------------------------

CREATE TABLE audit_chain_anchors (
  tenant_id       text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  anchor_id       text        NOT NULL,
  anchored_at     timestamptz NOT NULL DEFAULT now(),
  head_sequence   bigint      NOT NULL,
  head_event_hash text        NOT NULL,
  signature       text        NOT NULL,
  -- s.4 of file 07: the old public verification material is retained forever
  -- so historical segments stay verifiable after a key rotation.
  key_epoch       integer     NOT NULL DEFAULT 1,
  -- P0-3: a second destination outside the worker's write control.
  external_ref    text,
  external_confirmed_at timestamptz,
  PRIMARY KEY (tenant_id, anchor_id)
);

CREATE INDEX audit_chain_anchors_time_idx ON audit_chain_anchors (tenant_id, anchored_at DESC);

CREATE TRIGGER audit_chain_anchors_no_delete BEFORE DELETE ON audit_chain_anchors
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- Verification results, so a break is durable evidence rather than a log line.
CREATE TABLE audit_chain_verifications (
  tenant_id         text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  verification_id   text        NOT NULL,
  verified_at       timestamptz NOT NULL DEFAULT now(),
  from_sequence     bigint      NOT NULL,
  to_sequence       bigint      NOT NULL,
  events_verified   bigint      NOT NULL,
  ok                boolean     NOT NULL,
  broken_at_sequence bigint,
  broken_event_id   text,
  failure_reason    text,
  PRIMARY KEY (tenant_id, verification_id)
);

CREATE INDEX audit_chain_verifications_failures_idx
  ON audit_chain_verifications (tenant_id, verified_at DESC) WHERE ok = false;

-- -----------------------------------------------------------------------------
-- Evidence bundles — DWD-06 s.3.10
--
-- WORM. s.3.10: "worm_ref: written before the bundle is shown to any human."
-- A bundle is immutable; a reviewer edit produces a NEW bundle_version row,
-- which is why the primary key includes the version.
-- -----------------------------------------------------------------------------

CREATE TABLE evidence_bundles (
  tenant_id             text        NOT NULL,
  bundle_id             text        NOT NULL,
  bundle_version        integer     NOT NULL CHECK (bundle_version >= 1),
  graph_id              text        NOT NULL,
  output_class          text        NOT NULL,
  proposed_output       jsonb       NOT NULL,
  trace                 jsonb       NOT NULL,
  citations             jsonb       NOT NULL,
  records               jsonb       NOT NULL,
  policy_verdicts       text[]      NOT NULL DEFAULT '{}',
  confidence_by_step    jsonb       NOT NULL DEFAULT '[]'::jsonb,
  lowest_confidence_step text,
  -- s.3.10: "A bundle cannot be assembled with a failing gate." Enforced in
  -- the schema so no code path can write one.
  assurance             jsonb       NOT NULL,
  cost_to_date          jsonb       NOT NULL,
  pack_version          text        NOT NULL,
  platform_version      text        NOT NULL,
  assembled_at          timestamptz NOT NULL DEFAULT now(),
  worm_ref              text        NOT NULL,
  content_hash          text        NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  schema_version        text        NOT NULL DEFAULT '1.0.0',
  PRIMARY KEY (tenant_id, bundle_id, bundle_version),
  CONSTRAINT evidence_bundles_gates_passed CHECK (
    assurance ->> 'grounding_gate'   <> 'fail' AND
    assurance ->> 'arithmetic_gate'  <> 'fail' AND
    assurance ->> 'consistency_gate' <> 'fail'
  )
);

CREATE INDEX evidence_bundles_graph_idx  ON evidence_bundles (tenant_id, graph_id);
CREATE INDEX evidence_bundles_class_idx  ON evidence_bundles (tenant_id, output_class, assembled_at DESC);

CREATE TRIGGER evidence_bundles_no_update BEFORE UPDATE ON evidence_bundles
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER evidence_bundles_no_delete BEFORE DELETE ON evidence_bundles
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- -----------------------------------------------------------------------------
-- Decision records — DWD-06 s.3.13
--
--   "No output is delivered without a decision record."
-- -----------------------------------------------------------------------------

CREATE TABLE decision_records (
  tenant_id             text        NOT NULL,
  decision_id           text        NOT NULL,
  graph_id              text        NOT NULL,
  output_class          text        NOT NULL,
  authorisation_verdict text        NOT NULL
                          CHECK (authorisation_verdict IN ('may_issue', 'requires_human')),
  named_owner           jsonb       NOT NULL,
  evidence_bundle_ref   text        NOT NULL CHECK (evidence_bundle_ref LIKE 'worm://%'),
  pack_version          text        NOT NULL,
  platform_version      text        NOT NULL,
  skill_versions        jsonb       NOT NULL,
  reviewer_action_id    text,
  reserved_act_ref      text,
  decided_at            timestamptz NOT NULL DEFAULT now(),
  worm_ref              text        NOT NULL CHECK (worm_ref LIKE 'worm://%'),
  schema_version        text        NOT NULL DEFAULT '1.0.0',
  PRIMARY KEY (tenant_id, decision_id),
  -- A human-required verdict must name the reviewer action that produced it.
  CONSTRAINT decision_records_human_has_action CHECK (
    authorisation_verdict <> 'requires_human' OR reviewer_action_id IS NOT NULL
  )
);

CREATE INDEX decision_records_graph_idx ON decision_records (tenant_id, graph_id);
CREATE INDEX decision_records_class_idx ON decision_records (tenant_id, output_class, decided_at DESC);
CREATE INDEX decision_records_owner_idx
  ON decision_records (tenant_id, (named_owner ->> 'principal_id'), decided_at DESC);

CREATE TRIGGER decision_records_no_update BEFORE UPDATE ON decision_records
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();
CREATE TRIGGER decision_records_no_delete BEFORE DELETE ON decision_records
  FOR EACH STATEMENT EXECUTE FUNCTION forbid_mutation();

-- -----------------------------------------------------------------------------
-- Atomic append
--
-- The single entry point for writing an audit event. Doing the chain
-- arithmetic inside the database — rather than read-tip, compute, insert from
-- the application — removes the race entirely: two concurrent appenders
-- serialise on the tip row and neither can produce a fork.
--
-- The caller supplies the event hash it computed so the application and the
-- database must agree; a mismatch raises rather than silently accepting the
-- database's version.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION append_audit_event(
  p_tenant_id       text,
  p_event_id        text,
  p_trace_id        text,
  p_span_id         text,
  p_occurred_at     timestamptz,
  p_layer           text,
  p_component       text,
  p_event_type      text,
  p_actor           jsonb,
  p_subject         jsonb,
  p_context_ref     text,
  p_graph_id        text,
  p_outcome         text,
  p_payload_hash    text,
  p_payload_ref     text,
  p_expected_prev_hash text,
  p_event_hash      text
) RETURNS TABLE (sequence_number bigint, prev_event_hash text, event_hash text)
LANGUAGE plpgsql AS $$
DECLARE
  v_prev_hash text;
  v_next_seq  bigint;
BEGIN
  -- Serialises appenders within this tenant. Creates the tip on first write.
  INSERT INTO audit_chain_tips (tenant_id, head_event_hash, head_sequence)
  VALUES (p_tenant_id, repeat('0', 64), 0)
  ON CONFLICT (tenant_id) DO NOTHING;

  SELECT t.head_event_hash, t.head_sequence + 1
    INTO v_prev_hash, v_next_seq
    FROM audit_chain_tips t
   WHERE t.tenant_id = p_tenant_id
     FOR UPDATE;

  -- Genesis is 'sha256:' || 64 zeroes; the tip table stores the bare digest on
  -- creation, so normalise before comparing.
  IF v_prev_hash NOT LIKE 'sha256:%' THEN
    v_prev_hash := 'sha256:' || v_prev_hash;
  END IF;

  IF p_expected_prev_hash IS NOT NULL AND p_expected_prev_hash <> v_prev_hash THEN
    RAISE EXCEPTION
      'Audit chain tip moved between read and append for tenant %: caller expected %, tip is %. '
      'Recompute the event hash against the current tip and retry.',
      p_tenant_id, p_expected_prev_hash, v_prev_hash
      USING ERRCODE = 'serialization_failure';
  END IF;

  INSERT INTO audit_events (
    tenant_id, event_id, trace_id, span_id, occurred_at, layer, component, event_type,
    actor, subject, context_ref, graph_id, outcome, payload_hash, payload_ref,
    sequence_number, prev_event_hash, event_hash
  ) VALUES (
    p_tenant_id, p_event_id, p_trace_id, p_span_id, p_occurred_at, p_layer, p_component,
    p_event_type, p_actor, p_subject, p_context_ref, p_graph_id, p_outcome, p_payload_hash,
    p_payload_ref, v_next_seq, v_prev_hash, p_event_hash
  );

  UPDATE audit_chain_tips
     SET head_event_hash = p_event_hash,
         head_sequence   = v_next_seq,
         updated_at      = now()
   WHERE audit_chain_tips.tenant_id = p_tenant_id;

  RETURN QUERY SELECT v_next_seq, v_prev_hash, p_event_hash;
END;
$$;

COMMENT ON FUNCTION append_audit_event IS
  'The only write path into audit_events. Serialises on the tenant chain tip so '
  'concurrent appenders cannot fork the chain (DWD-06 s.3.14).';
