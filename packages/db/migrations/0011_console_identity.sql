-- =============================================================================
-- 0011 — console identity: passwords, second factor, enrolment, sessions
--
-- Replaces the console's environment-configured session. Before this,
-- `currentSession()` returned `CONSOLE_PRINCIPAL_ID ?? 'usr_console'` with
-- admin defaulting to true, which meant the API's attribution warning
-- (apps/api/src/authenticate.ts) was literally true: an approval named a
-- principal without proving one was present.
--
-- THE ORDERING PROBLEM, AND WHY THE SCHEMA LOOKS LIKE THIS
--
-- Every other table in this database is protected by RLS comparing tenant_id
-- to current_tenant(), which reads a GUC set per transaction. Authentication
-- cannot work that way, because authentication is what DECIDES the tenant. A
-- naive credentials table would be unreadable at the only moment it matters.
--
-- The usual answer is to make the auth tables global and accept that RLS does
-- not cover the most sensitive rows in the system. This migration does not do
-- that. Instead the tenant travels inside the credential itself:
--
--   session cookie   tnt_eiaaw.<32 random bytes>
--   invite link      tnt_eiaaw.<32 random bytes>
--
-- The prefix is read first, the tenant context is set from it, and the lookup
-- then happens under RLS like every other query. Tampering with the prefix does
-- not widen access — it sets a context in which the row simply does not exist.
--
-- That leaves exactly one table outside tenant scope: console_directory, which
-- answers "which tenant owns this email address" and is the one question that
-- genuinely has no tenant to ask it in. It holds a hash and a routing pair. No
-- password, no secret, no business data.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- console_directory — the only deliberately global table here.
--
-- Keyed by a hash rather than the address so a dump of this table is not a
-- mailing list, and so the sign-in form cannot be used to enumerate who holds
-- an account: the lookup is by digest, and a miss and a hit cost the same.
--
-- The address itself already lives in principals.primary_email, under RLS,
-- which is where it is read from once the tenant is known.
-- -----------------------------------------------------------------------------
CREATE TABLE console_directory (
  email_hash    text        PRIMARY KEY CHECK (email_hash ~ '^[0-9a-f]{64}$'),
  tenant_id     text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  principal_id  text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES principals(tenant_id, principal_id) ON DELETE CASCADE
);

COMMENT ON TABLE console_directory IS
  'Email-hash to (tenant, principal) routing for console sign-in. Deliberately '
  'outside tenant scope: it answers the question asked before a tenant is known. '
  'Holds no secrets.';

-- -----------------------------------------------------------------------------
-- console_credentials — one row per principal who may sign in.
--
-- A row existing is what grants console access. Revoking it is a DELETE, which
-- is why sessions reference it: revoking access kills live sessions too.
--
-- Both secret columns are nullable, and the states are meaningful:
--   password_hash NULL          — invited, has not set a password yet
--   totp_confirmed_at NULL      — password set, second factor not yet proven
--   both present                — fully enrolled
--
-- A half-enrolled account cannot sign in. That is enforced in the API rather
-- than by a CHECK, because the intermediate states are legitimate rows that
-- exist for as long as enrolment takes.
-- -----------------------------------------------------------------------------
CREATE TABLE console_credentials (
  tenant_id          text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  principal_id       text        NOT NULL,

  -- scrypt$N$r$p$salt$hash. Parameters travel with the value so they can be
  -- raised without invalidating credentials made under the old ones.
  password_hash      text,
  password_set_at    timestamptz,

  -- AES-256-GCM under a key derived from KMS_MASTER_KEY, not the base32 secret.
  -- A TOTP secret at rest in plaintext makes a database read equivalent to
  -- holding the phone, which would reduce two factors to one.
  totp_secret_sealed text,
  totp_confirmed_at  timestamptz,

  -- Throttling state. Kept on the row rather than in Redis because a lockout
  -- that evaporates when the cache restarts is not a lockout.
  failed_attempts    integer     NOT NULL DEFAULT 0 CHECK (failed_attempts >= 0),
  locked_until       timestamptz,

  last_sign_in_at    timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, principal_id),
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES principals(tenant_id, principal_id) ON DELETE CASCADE
);

-- -----------------------------------------------------------------------------
-- console_invites — single-use links for first-time enrolment and reset.
--
-- Only the hash is stored. The token travels by email, so assume the transport
-- is quotable and the mailbox is not ours: a database reader must not be able
-- to complete somebody's enrolment, and neither must anyone who later reads
-- the mail server's logs.
--
-- consumed_at rather than DELETE: "this link was already used" is a different
-- answer from "this link never existed", and support needs to tell them apart.
-- -----------------------------------------------------------------------------
CREATE TABLE console_invites (
  tenant_id     text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  token_hash    text        NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  principal_id  text        NOT NULL,
  purpose       text        NOT NULL CHECK (purpose IN ('enrolment', 'password_reset')),
  expires_at    timestamptz NOT NULL,
  consumed_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),

  PRIMARY KEY (tenant_id, token_hash),
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES principals(tenant_id, principal_id) ON DELETE CASCADE
);

-- Issuing a new invite supersedes any outstanding one for that principal, so
-- the common lookup is "the live invite for this person".
CREATE INDEX console_invites_principal_idx
  ON console_invites (tenant_id, principal_id, expires_at DESC)
  WHERE consumed_at IS NULL;

-- -----------------------------------------------------------------------------
-- console_sessions — server-side, and therefore revocable.
--
-- A signed stateless cookie would avoid this table and cannot be revoked before
-- it expires. For a console that approves financial decisions, "sign this
-- person out now" has to be an operation that works, so the session is a row
-- and signing out deletes it.
--
-- The user agent and IP are stored as digests: they exist to show a reviewer
-- their own sessions and to make a stolen cookie visible, not to profile
-- anybody, and a digest serves both without retaining the identifiers.
-- -----------------------------------------------------------------------------
CREATE TABLE console_sessions (
  tenant_id       text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  session_hash    text        NOT NULL CHECK (session_hash ~ '^[0-9a-f]{64}$'),
  principal_id    text        NOT NULL,

  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL,
  last_seen_at    timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  revoked_reason  text,

  user_agent_hash text,
  ip_hash         text,

  PRIMARY KEY (tenant_id, session_hash),
  FOREIGN KEY (tenant_id, principal_id)
    REFERENCES principals(tenant_id, principal_id) ON DELETE CASCADE
);

CREATE INDEX console_sessions_principal_idx
  ON console_sessions (tenant_id, principal_id, expires_at DESC)
  WHERE revoked_at IS NULL;

-- -----------------------------------------------------------------------------
-- Row-level security.
--
-- The same treatment every other tenant-scoped table gets in 0008, including
-- FORCE so the owning role does not silently bypass it. console_directory is
-- excluded by design, documented above.
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  t text;
  tenant_scoped text[] := ARRAY[
    'console_credentials', 'console_invites', 'console_sessions'
  ];
BEGIN
  FOREACH t IN ARRAY tenant_scoped LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
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
-- Grants.
--
-- The application needs to write all four: it creates invites, sets passwords,
-- opens and revokes sessions. Unlike the audit surface these are not
-- append-only — a password changes, a session ends — so UPDATE and DELETE are
-- granted here where 0008 withholds them elsewhere.
-- -----------------------------------------------------------------------------
GRANT SELECT, INSERT, UPDATE, DELETE ON console_directory   TO app_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON console_credentials TO app_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON console_invites     TO app_worker;
GRANT SELECT, INSERT, UPDATE, DELETE ON console_sessions    TO app_worker;

-- -----------------------------------------------------------------------------
-- The operator tenant.
--
-- EIAAW Solutions' own tenant, distinct from any client's. The first console
-- administrator lives here and enrols client tenants from the admin page;
-- keeping them separate means operator actions are never attributed to a
-- client's data, and the seeded demo fixtures stay out of production.
--
-- The residency zone matches what the deployment already reports at
-- GET /v1/health, so an operator session cannot straddle two zones.
--
-- No principal is created here. The first administrator is enrolled by
-- `pnpm db:bootstrap-admin`, which takes the address as an argument — a
-- personal email address does not belong in the migration history of a public
-- repository.
-- -----------------------------------------------------------------------------
INSERT INTO tenants (tenant_id, display_name, residency_zone, status)
VALUES ('tnt_eiaaw', 'EIAAW Solutions', 'my-central', 'active')
ON CONFLICT (tenant_id) DO NOTHING;
