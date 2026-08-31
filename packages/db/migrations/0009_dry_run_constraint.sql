-- =============================================================================
-- Relax the dry-run constraint for irreversible tools.
--
-- 0005 required every state-changing tool to support dry-run. That is right for
-- almost all of them, and it is what makes s.14.3 ("dry-run forced on in dev,
-- test and staging") enforceable.
--
-- But file 05 s.10.6 lists `TL-DOCS-04 evidence.bundle.write` with Dry-run =
-- "No", and correctly: the WORM store is append-only by construction, so a
-- "dry-run append" is not a rehearsal of the write — it is a different
-- operation that proves nothing. The same holds for any tool whose effect is
-- irreversible: there is no state to roll back after a rehearsal, so the
-- rehearsal cannot exercise the path that matters.
--
-- The constraint therefore becomes: a state-changing tool must support dry-run
-- UNLESS it is irreversible. Irreversible tools are already the most tightly
-- controlled — dual control, last-position sequencing, and never reachable at
-- Execute autonomy (file 05 s.13, file 01 s.5.5) — so this narrows the dry-run
-- requirement without widening what the worker may do.
-- =============================================================================

ALTER TABLE tool_registry
  DROP CONSTRAINT tool_registry_state_changing_has_dry_run;

ALTER TABLE tool_registry
  ADD CONSTRAINT tool_registry_state_changing_has_dry_run CHECK (
    NOT state_changing OR dry_run_support OR irreversible
  );

COMMENT ON CONSTRAINT tool_registry_state_changing_has_dry_run ON tool_registry IS
  'A state-changing tool supports dry-run unless it is irreversible, where a '
  'rehearsal cannot exercise the path that matters (file 05 s.10.6).';
