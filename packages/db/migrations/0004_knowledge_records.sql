-- =============================================================================
-- S5 Knowledge (L2) and Records (L1) — DWD-06 s.15, s.10.3.
--
--   s.15.1: "Knowledge and records at S5, before registries. A skill
--            definition's required_knowledge is meaningless without a service
--            that can answer it with versions and effective dates."
--
--   s.10.3: "Filters are applied BEFORE similarity, not after ... A chunk whose
--            effective range does not cover the as-of date is not a
--            lower-ranked result; IT IS NOT A CANDIDATE."
--
-- That last sentence is the whole design. An effective-date filter applied as a
-- re-rank would let a superseded 2024 tax rate surface for a 2026 question with
-- a slightly better cosine score. Here it is a WHERE clause.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Packs — the versioned unit of knowledge publication.
--
-- Architecture s.5: authoring, validation, certification, publication,
-- monitoring, deprecation; semantic versioning; rollback re-points resolution.
-- Phase 0 acceptance P0-8 requires publish → supersede → query-at-prior-version
-- → rollback, with in-flight graphs pinned.
-- -----------------------------------------------------------------------------

CREATE TABLE packs (
  pack_id         text        NOT NULL,
  pack_version    text        NOT NULL CHECK (pack_version ~ '^[0-9]{4}\.[0-9]{2}\.[0-9]+$|^\d+\.\d+\.\d+$'),
  -- The axes this pack claims to cover. The context resolver matches against
  -- these to choose a pack, and records the coverage tier it got.
  jurisdiction    text        NOT NULL,
  reporting_framework text    NOT NULL,
  status          text        NOT NULL DEFAULT 'draft'
                    CHECK (status IN ('draft', 'validated', 'certified', 'published', 'deprecated', 'rolled_back')),
  effective_from  date        NOT NULL,
  effective_to    date,
  supersedes      text,
  published_at    timestamptz,
  published_by    text,
  certified_by    text,
  change_note     text,
  module_count    integer     NOT NULL DEFAULT 0,
  chunk_count     integer     NOT NULL DEFAULT 0,
  content_hash    text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (pack_id, pack_version)
);

CREATE INDEX packs_resolution_idx
  ON packs (jurisdiction, reporting_framework, effective_from DESC)
  WHERE status = 'published';

COMMENT ON TABLE packs IS
  'Versioned knowledge packs. A rollback re-points resolution; it never deletes '
  'a version, because an in-flight graph is pinned to one (architecture s.5).';

-- -----------------------------------------------------------------------------
-- Knowledge chunks — the L2 minimum schema in full (s.10.3).
--
-- Shared corpus rows carry tenant_id = NULL: the 27 accounting-and-finance
-- modules are generic and identical for every client. Tenant-specific knowledge
-- (a client's own tax position papers) carries a tenant_id and is invisible
-- across tenants by RLS.
-- -----------------------------------------------------------------------------

CREATE TABLE knowledge_chunks (
  chunk_id          text        NOT NULL,
  -- NULL = shared corpus. See the RLS policy in 0008.
  tenant_id         text        REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  pack_id           text        NOT NULL,
  pack_version      text        NOT NULL,
  module_id         text        NOT NULL,
  source_id         text        NOT NULL,
  version           text        NOT NULL,

  -- s.10.3: "citation locator" — what a reader is pointed at.
  citation_locator  text        NOT NULL,
  heading_path      text[]      NOT NULL DEFAULT '{}',
  content           text        NOT NULL,
  content_hash      text        NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  token_count       integer     NOT NULL DEFAULT 0,

  -- Effective dating. `effective_to IS NULL` means still in force.
  effective_from    date        NOT NULL,
  effective_to      date,

  -- Axis tags — the hard filters applied before similarity.
  jurisdictions     text[]      NOT NULL DEFAULT '{}',
  frameworks        text[]      NOT NULL DEFAULT '{}',
  licence_class     text        NOT NULL DEFAULT 'internal'
                      CHECK (licence_class IN ('public', 'internal', 'licensed', 'tenant_private')),
  clearance         text        NOT NULL DEFAULT 'internal'
                      CHECK (clearance IN ('public', 'internal', 'confidential', 'restricted')),
  data_classes      text[]      NOT NULL DEFAULT '{}',

  supersedes_chunk_id text,
  -- s.10.3: conflict flags. Two chunks that disagree on the same axis for the
  -- same period are surfaced, never silently resolved by rank.
  conflict_flags    text[]      NOT NULL DEFAULT '{}',

  -- file 01 s.6.2 rule 10: a statutory rate past its verification horizon
  -- makes the worker halt and escalate; it never estimates.
  is_statutory_rate boolean     NOT NULL DEFAULT false,
  verified_at       date,
  verification_horizon_days integer,

  retired_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, version),
  FOREIGN KEY (pack_id, pack_version) REFERENCES packs(pack_id, pack_version) ON DELETE RESTRICT,
  CONSTRAINT knowledge_chunks_effective_order CHECK (effective_to IS NULL OR effective_to >= effective_from),
  -- A rate that can go stale must declare how it is checked.
  CONSTRAINT knowledge_chunks_rate_has_horizon CHECK (
    NOT is_statutory_rate OR (verified_at IS NOT NULL AND verification_horizon_days IS NOT NULL)
  )
);

CREATE INDEX knowledge_chunks_module_idx  ON knowledge_chunks (module_id, effective_from DESC);
CREATE INDEX knowledge_chunks_pack_idx    ON knowledge_chunks (pack_id, pack_version);
CREATE INDEX knowledge_chunks_tenant_idx  ON knowledge_chunks (tenant_id) WHERE tenant_id IS NOT NULL;
CREATE INDEX knowledge_chunks_axes_idx    ON knowledge_chunks USING gin (jurisdictions, frameworks);
CREATE INDEX knowledge_chunks_effective_idx ON knowledge_chunks (effective_from, effective_to);
-- Drives the freshness watchlist: which rates are approaching their horizon.
CREATE INDEX knowledge_chunks_staleness_idx
  ON knowledge_chunks (verified_at) WHERE is_statutory_rate AND retired_at IS NULL;

-- -----------------------------------------------------------------------------
-- Embeddings, kept in a sibling table.
--
-- Separated from the chunk so a re-embedding (a model change) does not rewrite
-- the chunk row, whose content_hash is cited in evidence bundles that must stay
-- reproducible.
-- -----------------------------------------------------------------------------

CREATE TABLE knowledge_embeddings (
  chunk_id      text        NOT NULL,
  version       text        NOT NULL,
  embedding_model text      NOT NULL,
  -- 1536 suits text-embedding-3-small and voyage-3-lite. A different width
  -- means a different model, which means a new row, not an altered one.
  embedding     vector(1536) NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (chunk_id, version, embedding_model),
  FOREIGN KEY (chunk_id, version) REFERENCES knowledge_chunks(chunk_id, version) ON DELETE CASCADE
);

-- HNSW over cosine distance. The hard filters run first (see retrieve_chunks),
-- so this index serves the already-narrowed candidate set.
CREATE INDEX knowledge_embeddings_hnsw_idx
  ON knowledge_embeddings USING hnsw (embedding vector_cosine_ops);

-- -----------------------------------------------------------------------------
-- Retrieval — filters BEFORE similarity (s.10.3)
--
-- The CTE ordering is load-bearing and not an optimisation detail: `candidates`
-- applies every hard filter, and only then does the outer query rank by cosine
-- distance. Written as a re-rank, this function would surface a superseded
-- statutory rate whenever its embedding happened to be closer.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION retrieve_chunks(
  p_tenant_id       text,
  p_query_embedding vector(1536),
  p_embedding_model text,
  p_as_of_date      date,
  p_jurisdiction    text,
  p_framework       text,
  p_clearance       text,
  p_module_filter   text[]  DEFAULT NULL,
  p_limit           integer DEFAULT 12
) RETURNS TABLE (
  chunk_id text, version text, module_id text, source_id text, citation_locator text,
  content text, content_hash text, effective_from date, effective_to date,
  licence_class text, conflict_flags text[], is_statutory_rate boolean,
  verified_at date, verification_horizon_days integer, distance double precision
)
LANGUAGE sql STABLE AS $$
  WITH clearance_rank AS (
    SELECT CASE p_clearance
             WHEN 'public'       THEN 0
             WHEN 'internal'     THEN 1
             WHEN 'confidential' THEN 2
             WHEN 'restricted'   THEN 3
             ELSE 0
           END AS max_rank
  ),
  candidates AS (
    SELECT k.*
      FROM knowledge_chunks k, clearance_rank cr
     WHERE k.retired_at IS NULL
       -- Shared corpus, or this tenant's own private knowledge. Never another's.
       AND (k.tenant_id IS NULL OR k.tenant_id = p_tenant_id)
       -- Effective range must COVER the as-of date. Not "prefer"; cover.
       AND k.effective_from <= p_as_of_date
       AND (k.effective_to IS NULL OR k.effective_to >= p_as_of_date)
       AND (cardinality(k.jurisdictions) = 0 OR p_jurisdiction = ANY (k.jurisdictions))
       AND (cardinality(k.frameworks)    = 0 OR p_framework    = ANY (k.frameworks))
       AND CASE k.clearance
             WHEN 'public'       THEN 0
             WHEN 'internal'     THEN 1
             WHEN 'confidential' THEN 2
             WHEN 'restricted'   THEN 3
           END <= cr.max_rank
       AND (p_module_filter IS NULL OR k.module_id = ANY (p_module_filter))
  )
  SELECT c.chunk_id, c.version, c.module_id, c.source_id, c.citation_locator,
         c.content, c.content_hash, c.effective_from, c.effective_to,
         c.licence_class, c.conflict_flags, c.is_statutory_rate,
         c.verified_at, c.verification_horizon_days,
         (e.embedding <=> p_query_embedding)::double precision AS distance
    FROM candidates c
    JOIN knowledge_embeddings e
      ON e.chunk_id = c.chunk_id
     AND e.version  = c.version
     AND e.embedding_model = p_embedding_model
   ORDER BY e.embedding <=> p_query_embedding
   LIMIT p_limit
$$;

COMMENT ON FUNCTION retrieve_chunks IS
  'Hard filters first, similarity second (DWD-06 s.10.3). A chunk outside the '
  'effective range is not a candidate, not a lower-ranked result.';

-- -----------------------------------------------------------------------------
-- Coverage gaps — recorded, not swallowed.
--
-- Roadmap s.4.5: "a recorded gap is a Research and Freshness input, not a
-- defect in the answer." A refusal for want of coverage writes a row here.
-- -----------------------------------------------------------------------------

CREATE TABLE knowledge_coverage_gaps (
  tenant_id       text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  gap_id          text        NOT NULL,
  graph_id        text,
  query_text      text        NOT NULL,
  jurisdiction    text        NOT NULL,
  framework       text        NOT NULL,
  as_of_date      date        NOT NULL,
  modules_searched text[]     NOT NULL DEFAULT '{}',
  gap_kind        text        NOT NULL
                    CHECK (gap_kind IN ('no_coverage', 'effective_date_gap', 'stale_statutory_rate', 'conflicting_sources')),
  detail          text,
  occurrences     integer     NOT NULL DEFAULT 1,
  first_seen_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  resolved_at     timestamptz,
  resolved_by_pack_version text,
  PRIMARY KEY (tenant_id, gap_id)
);

CREATE INDEX knowledge_coverage_gaps_open_idx
  ON knowledge_coverage_gaps (tenant_id, gap_kind, last_seen_at DESC) WHERE resolved_at IS NULL;

-- -----------------------------------------------------------------------------
-- L1 records provenance — DWD-06 s.3.8 `records_used`.
--
-- The worker does not warehouse the client's ledger. It records WHAT it read,
-- FROM WHERE, WHEN and WITH WHICH CONNECTOR VERSION, plus a content hash — so
-- an evidence bundle can be re-checked against the source system years later
-- without the worker having kept the data.
-- -----------------------------------------------------------------------------

CREATE TABLE record_reads (
  tenant_id         text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  record_read_id    text        NOT NULL,
  graph_id          text,
  tool_call_id      text,
  source_system_id  text        NOT NULL,
  record_type       text        NOT NULL,
  entity_id         text        NOT NULL,
  period            text        NOT NULL,
  business_key      text,
  content_hash      text        NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  -- Lineage, per the L1 minimum schema.
  connector_version text        NOT NULL,
  extracted_at      timestamptz NOT NULL,
  row_count         integer,
  -- The payload itself lives in the object store under the shortest retention
  -- consistent with audit; the hash outlives the content (s.10.7).
  payload_ref       text,
  data_classes      text[]      NOT NULL DEFAULT '{}',
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, record_read_id)
);

CREATE INDEX record_reads_graph_idx  ON record_reads (tenant_id, graph_id) WHERE graph_id IS NOT NULL;
CREATE INDEX record_reads_source_idx ON record_reads (tenant_id, source_system_id, extracted_at DESC);
CREATE INDEX record_reads_entity_idx ON record_reads (tenant_id, entity_id, period);
CREATE INDEX record_reads_hash_idx   ON record_reads (tenant_id, content_hash);
