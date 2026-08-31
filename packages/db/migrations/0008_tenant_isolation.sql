-- =============================================================================
-- Tenant isolation — DWD-06 s.10.6.
--
--   "tenant_id as the leading column of every primary key and every index;
--    ROW-LEVEL SECURITY ENFORCED IN THE DATABASE, NOT ONLY IN THE APPLICATION."
--
--   file 07 C14, and Phase 0 acceptance P0-6: "Tenant isolation holds below the
--   application on every store" — proven by the predicate-removal and
--   foreign-collection tests.
--
-- The predicate-removal test is the one this migration exists to survive: take
-- a correct query, delete its `WHERE tenant_id = ...`, and assert it returns
-- ZERO rows rather than every row. That only holds if isolation lives here.
--
-- Mechanism: every tenant-scoped table gets RLS with a policy comparing
-- `tenant_id` to `current_tenant()`, which reads the `app.tenant_id` GUC set
-- per transaction. Unset means NULL means no rows.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Roles
--
--   app_worker   — the application. Reads and writes tenant data. Cannot
--                  UPDATE or DELETE anything append-only, and cannot bypass RLS.
--   app_migrator — owns the schema; used only by the migration runner.
--   app_auditor  — read-only across the audit surface, for the audit query API.
-- -----------------------------------------------------------------------------

-- A managed Postgres (Railway, RDS) hands the application a role that owns the
-- schema and, on many providers, carries BYPASSRLS. A connection made as that
-- role would ignore every policy below, making this whole migration decorative.
--
-- So `app_worker` is NOLOGIN and the connecting role is granted MEMBERSHIP of
-- it. Every tenant-scoped transaction does `SET LOCAL ROLE app_worker` before
-- touching data (see withTenant), which drops the superuser attributes for the
-- life of that transaction and puts the policies back in force.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_worker') THEN
    CREATE ROLE app_worker NOLOGIN NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_auditor') THEN
    CREATE ROLE app_auditor NOLOGIN NOBYPASSRLS;
  END IF;
END
$$;

-- The role running this migration is the one the application will connect as.
DO $$
BEGIN
  EXECUTE format('GRANT app_worker TO %I', current_user);
  EXECUTE format('GRANT app_auditor TO %I', current_user);
END
$$;

-- -----------------------------------------------------------------------------
-- Apply RLS to every tenant-scoped table.
--
-- Driven by a loop over a list rather than written out per table, so adding a
-- table without adding its policy is a visible omission from ONE list rather
-- than a missing statement nobody notices.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  t text;
  tenant_scoped text[] := ARRAY[
    'principals', 'channel_bindings', 'stored_objects',
    'audit_events', 'audit_chain_tips', 'audit_chain_anchors', 'audit_chain_verifications',
    'evidence_bundles', 'decision_records',
    'settings_values', 'settings_snapshots',
    'knowledge_coverage_gaps', 'record_reads',
    'tool_grants', 'skill_revalidations', 'scope_cards',
    'conversations', 'messages', 'contexts', 'task_graphs', 'task_nodes',
    'policy_verdicts', 'skill_invocations', 'tool_calls', 'idempotency_records',
    'workflow_runs', 'workflow_events', 'workflow_timers', 'workflow_signals',
    'compensation_stack', 'trigger_definitions',
    'handoffs', 'reviewer_actions', 'deliveries', 'feedback_events',
    'accuracy_measurements', 'incidents'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_scoped LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    -- FORCE applies the policy to the table owner too. Without it, the role
    -- that owns the table silently bypasses every policy — which is precisely
    -- the "isolation in the application only" failure this migration prevents.
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);

    EXECUTE format($f$
      CREATE POLICY %I ON %I
        USING (tenant_id = current_tenant())
        WITH CHECK (tenant_id = current_tenant())
    $f$, t || '_tenant_isolation', t);
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- Knowledge chunks: shared corpus plus tenant-private knowledge.
--
-- The 27 accounting-and-finance modules are generic and identical for every
-- client (tenant_id IS NULL). A client's own tax position papers are not.
-- One policy covers both without letting a tenant see another's.
-- -----------------------------------------------------------------------------

ALTER TABLE knowledge_chunks ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_chunks FORCE ROW LEVEL SECURITY;

CREATE POLICY knowledge_chunks_tenant_isolation ON knowledge_chunks
  USING (tenant_id IS NULL OR tenant_id = current_tenant())
  -- A write must name a tenant: nothing may add to the shared corpus through
  -- the application role. Shared-corpus ingestion runs as the migrator.
  WITH CHECK (tenant_id = current_tenant());

-- Embeddings inherit their chunk's visibility.
ALTER TABLE knowledge_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE knowledge_embeddings FORCE ROW LEVEL SECURITY;

CREATE POLICY knowledge_embeddings_tenant_isolation ON knowledge_embeddings
  USING (EXISTS (
    SELECT 1 FROM knowledge_chunks k
     WHERE k.chunk_id = knowledge_embeddings.chunk_id
       AND k.version  = knowledge_embeddings.version
  ));

-- -----------------------------------------------------------------------------
-- Grants
--
--   s.10.5: "no delete path in any role, including platform administration."
--   The triggers already refuse; revoking the privilege means the attempt fails
--   before it reaches them, and shows up in a permission audit.
-- -----------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO app_worker, app_auditor;

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_worker;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO app_worker;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO app_worker;

-- Append-only surfaces: INSERT and SELECT only, for every role.
REVOKE UPDATE, DELETE, TRUNCATE ON
  audit_events, audit_chain_anchors,
  evidence_bundles, decision_records,
  reviewer_actions, workflow_events,
  scope_cards, settings_snapshots
FROM app_worker;

-- The registries and the output-class register are platform-owned. The worker
-- reads them; it never writes them. file 01 s.6.4: "Does not change its own
-- scope, autonomy, supervisor, thresholds or review basis" (AS-SCP-014).
REVOKE INSERT, UPDATE, DELETE ON
  output_class_register, skill_registry, tool_registry, policy_rules,
  settings_catalogue, assurance_cases, packs
FROM app_worker;

-- The audit query API is read-only by construction (s.5.5): "There is no
-- endpoint that writes, edits or deletes an audit event, in any auth model."
GRANT SELECT ON
  audit_events, audit_chain_anchors, audit_chain_verifications,
  evidence_bundles, decision_records, reviewer_actions
TO app_auditor;

ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE ON TABLES TO app_worker;

-- -----------------------------------------------------------------------------
-- Residency guard — s.10.6, and the 451 in s.5.6.
--
-- A tenant provisioned in `my-central` must not be written from a process
-- running in another zone. The application refuses first; this is the backstop
-- for the case where it does not.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION assert_residency() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  v_tenant_zone  text;
  v_session_zone text := current_residency_zone();
BEGIN
  IF v_session_zone IS NULL THEN
    RETURN NEW; -- migrations and maintenance run without a session zone
  END IF;

  SELECT residency_zone INTO v_tenant_zone FROM tenants WHERE tenant_id = NEW.tenant_id;

  IF v_tenant_zone IS NOT NULL AND v_tenant_zone <> v_session_zone THEN
    RAISE EXCEPTION
      'Residency violation: tenant % is provisioned in zone %, but this session '
      'runs in zone %. Cross-zone access is refused, not proxied (DWD-06 s.10.6).',
      NEW.tenant_id, v_tenant_zone, v_session_zone
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  RETURN NEW;
END;
$$;

-- Applied to the tables that carry the most sensitive payloads. Extending it to
-- every table would double the write cost for no additional protection: the
-- session zone is set once per connection and cannot vary within a request.
CREATE TRIGGER audit_events_residency BEFORE INSERT ON audit_events
  FOR EACH ROW EXECUTE FUNCTION assert_residency();
CREATE TRIGGER evidence_bundles_residency BEFORE INSERT ON evidence_bundles
  FOR EACH ROW EXECUTE FUNCTION assert_residency();
CREATE TRIGGER decision_records_residency BEFORE INSERT ON decision_records
  FOR EACH ROW EXECUTE FUNCTION assert_residency();
CREATE TRIGGER record_reads_residency BEFORE INSERT ON record_reads
  FOR EACH ROW EXECUTE FUNCTION assert_residency();
