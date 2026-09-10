-- -----------------------------------------------------------------------------
-- 0010 — narrow the embedding width from 1536 to 1024
--
-- 0004 chose 1536 to suit text-embedding-3-small and voyage-3-lite. The
-- deployment standardised instead on Voyage's finance-domain embeddings, and no
-- current Voyage model emits 1536: the family offers 256, 512, 1024 (default)
-- and 2048, and only the retired voyage-large-2 ever produced 1536.
--
-- 1024 is Voyage's default width and the one the finance-domain models are
-- trained to emit.
--
-- WHY THIS IS SAFE TO RUN AS A REWRITE RATHER THAN AN EXPAND-THEN-CONTRACT:
-- no corpus has been ingested in any environment yet, so knowledge_embeddings
-- is empty and there are no vectors to re-embed or dual-write. The migration
-- asserts that rather than assuming it — if rows exist, it aborts rather than
-- silently destroying embeddings that evidence bundles may cite.
--
-- Once a corpus exists this becomes a genuine re-embedding exercise: a width
-- change means a different model, and the (chunk_id, version, embedding_model)
-- primary key is deliberately shaped so a new model arrives as new rows beside
-- the old ones, not as an ALTER.
-- -----------------------------------------------------------------------------

DO $$
DECLARE
  existing bigint;
BEGIN
  SELECT count(*) INTO existing FROM knowledge_embeddings;
  IF existing > 0 THEN
    RAISE EXCEPTION
      'knowledge_embeddings holds % row(s). Narrowing the vector width would '
      'discard embeddings that evidence bundles may cite. Re-embed the corpus '
      'under the new model as new rows (the primary key includes '
      'embedding_model for exactly this reason), then retire the old rows.',
      existing;
  END IF;
END $$;

-- The HNSW index is bound to the column's width, so it goes and comes back.
DROP INDEX IF EXISTS knowledge_embeddings_hnsw_idx;

ALTER TABLE knowledge_embeddings
  ALTER COLUMN embedding TYPE vector(1024);

COMMENT ON COLUMN knowledge_embeddings.embedding IS
  '1024 is the Voyage default width and what the finance-domain models emit. A '
  'different width means a different model, which means a new row, not an '
  'altered one.';

CREATE INDEX knowledge_embeddings_hnsw_idx
  ON knowledge_embeddings USING hnsw (embedding vector_cosine_ops);

-- -----------------------------------------------------------------------------
-- retrieve_chunks takes the query vector as a parameter, so its signature
-- carries the width too. A parameter type cannot be changed by CREATE OR
-- REPLACE; the old signature is dropped and the function recreated unchanged
-- apart from that width.
-- -----------------------------------------------------------------------------

DROP FUNCTION IF EXISTS retrieve_chunks(
  text, vector(1536), text, date, text, text, text, text[], integer
);

CREATE FUNCTION retrieve_chunks(
  p_tenant_id       text,
  p_query_embedding vector(1024),
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
