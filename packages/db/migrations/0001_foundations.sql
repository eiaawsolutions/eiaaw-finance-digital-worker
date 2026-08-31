-- =============================================================================
-- S1 Foundations — DWD-06 s.15 build order, stage 1.
--
--   "tenancy, identity (IdP + workload identity), KMS, secrets vault,
--    relational store, object store, OpenTelemetry baseline"
--
-- Two invariants are set up here and relied on by every later migration:
--
--   1. Tenant isolation lives in the database, not only in the application
--      (s.10.6). `app.tenant_id` is the session GUC every RLS policy reads.
--
--   2. `tenant_id` is the leading column of every primary key and every index
--      on a tenant-scoped table. This is not a style preference: it makes a
--      cross-tenant index scan impossible rather than merely unlikely.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- -----------------------------------------------------------------------------
-- Session helpers
--
-- Every tenant-scoped query runs inside a transaction that has SET LOCAL
-- app.tenant_id. `current_tenant()` returns NULL when unset, and every RLS
-- policy compares against it — so a query issued without a tenant predicate
-- returns zero rows rather than every row.
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION current_tenant() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.tenant_id', true), '')
$$;

CREATE OR REPLACE FUNCTION current_residency_zone() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT NULLIF(current_setting('app.residency_zone', true), '')
$$;

-- -----------------------------------------------------------------------------
-- Tenants
--
-- The one table that is NOT tenant-scoped, because it defines the scope.
-- Access is restricted to the platform role.
-- -----------------------------------------------------------------------------

CREATE TABLE tenants (
  tenant_id           text PRIMARY KEY
                        CHECK (tenant_id ~ '^tnt_[a-z0-9][a-z0-9_-]{1,62}$'),
  display_name        text        NOT NULL,
  -- s.10.6: residency zone on the context and on every store. A cross-zone
  -- read or write refuses with 451.
  residency_zone      text        NOT NULL,
  status              text        NOT NULL DEFAULT 'active'
                        CHECK (status IN ('provisioning', 'active', 'suspended', 'offboarding', 'closed')),
  -- s.10.7: retention is client-entered at AS-SYS-*, with a statutory floor.
  retention_profile   jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- file 07: a legal hold suspends ALL expiry, including audit retention.
  legal_hold          boolean     NOT NULL DEFAULT false,
  legal_hold_reason   text,
  legal_hold_applied_at timestamptz,
  onboarded_at        timestamptz NOT NULL DEFAULT now(),
  suspended_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE tenants IS
  'Tenant register. Not tenant-scoped because it defines the scope; platform role only.';

-- -----------------------------------------------------------------------------
-- Principals
--
-- The people the worker addresses, approves through and escalates to.
-- Resolved from the IdP; AS-PPL-* supplies the role mapping.
--
-- file 01 s.6.2 rule 8: "Autonomy above Observe requires a named individual
-- supervisor, not a role." `is_individual` exists so a shared mailbox or a
-- distribution list can never be recorded as a supervisor.
-- -----------------------------------------------------------------------------

CREATE TABLE principals (
  tenant_id         text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  principal_id      text        NOT NULL,
  display_name      text        NOT NULL,
  primary_email     text,
  idp_subject       text,
  is_individual     boolean     NOT NULL DEFAULT true,
  status            text        NOT NULL DEFAULT 'active'
                      CHECK (status IN ('active', 'inactive', 'leaver', 'suspended')),
  -- Role references resolve into AS-PPL-* / AS-DOA-*; stored denormalised for
  -- the hot path, re-derived on every settings publish.
  role_refs         text[]      NOT NULL DEFAULT '{}',
  clearance         text        NOT NULL DEFAULT 'internal'
                      CHECK (clearance IN ('public', 'internal', 'confidential', 'restricted')),
  entity_scope      text[]      NOT NULL DEFAULT '{}',
  locale            text        NOT NULL DEFAULT 'en-MY',
  timezone          text        NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
  quiet_hours       jsonb,
  deactivated_at    timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, principal_id)
);

CREATE INDEX principals_email_idx     ON principals (tenant_id, lower(primary_email));
CREATE INDEX principals_idp_idx       ON principals (tenant_id, idp_subject);
CREATE INDEX principals_status_idx    ON principals (tenant_id, status);

COMMENT ON COLUMN principals.is_individual IS
  'False for shared mailboxes and lists. Immutable rule 8 forbids a non-individual supervisor.';

-- -----------------------------------------------------------------------------
-- Channel bindings — DWD-06 s.3.1, file 02 s.7
--
-- A transport identity (an email address, a Telegram chat id, a WhatsApp
-- number) bound to a principal through a verification ceremony. An unbound
-- sender is treated as external.
-- -----------------------------------------------------------------------------

CREATE TABLE channel_bindings (
  tenant_id           text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  binding_id          text        NOT NULL,
  principal_id        text        NOT NULL,
  channel             text        NOT NULL
                        CHECK (channel IN ('email', 'chat', 'telegram', 'whatsapp')),
  -- Hashed, not stored raw: a phone number is D17 personal data (file 07 s.3.2)
  -- and the binding lookup only ever needs equality.
  transport_identity_hash text    NOT NULL,
  transport_identity_hint text,
  -- file 02 s.7: identity strength feeds the authority pre-check.
  identity_strength   text        NOT NULL
                        CHECK (identity_strength IN ('high', 'medium', 'low')),
  verified_at         timestamptz,
  verification_method text,
  revoked_at          timestamptz,
  revocation_reason   text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, binding_id),
  FOREIGN KEY (tenant_id, principal_id) REFERENCES principals(tenant_id, principal_id) ON DELETE RESTRICT
);

-- One live binding per (channel, transport identity). A revoked binding does
-- not block a later re-binding, which is why the index is partial.
CREATE UNIQUE INDEX channel_bindings_live_idx
  ON channel_bindings (tenant_id, channel, transport_identity_hash)
  WHERE revoked_at IS NULL;

CREATE INDEX channel_bindings_principal_idx
  ON channel_bindings (tenant_id, principal_id, channel);

-- -----------------------------------------------------------------------------
-- Object store index
--
-- The blobs live in the object store (s.10.4); this table is the metadata
-- Postgres needs to enforce retention and to refuse deleting an object an
-- audit event still references.
-- -----------------------------------------------------------------------------

CREATE TABLE stored_objects (
  tenant_id       text        NOT NULL REFERENCES tenants(tenant_id) ON DELETE RESTRICT,
  storage_ref     text        NOT NULL,
  content_hash    text        NOT NULL CHECK (content_hash ~ '^sha256:[0-9a-f]{64}$'),
  media_type      text        NOT NULL,
  size_bytes      bigint      NOT NULL CHECK (size_bytes >= 0),
  object_class    text        NOT NULL
                    CHECK (object_class IN (
                      'raw_inbound', 'attachment', 'extracted_text', 'rendered_output',
                      'working_paper', 'diff', 'audit_payload', 'skill_input', 'skill_output'
                    )),
  -- s.3.2 of file 07: an untagged field is Restricted. Same default here.
  data_classes    text[]      NOT NULL DEFAULT '{}',
  residency_zone  text        NOT NULL,
  -- s.10.4: no object is deleted while an audit event references it and its
  -- retention has not expired.
  referenced_by_audit boolean NOT NULL DEFAULT false,
  retention_until timestamptz,
  redacted_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, storage_ref)
);

CREATE INDEX stored_objects_hash_idx      ON stored_objects (tenant_id, content_hash);
CREATE INDEX stored_objects_retention_idx ON stored_objects (tenant_id, retention_until)
  WHERE redacted_at IS NULL;

-- -----------------------------------------------------------------------------
-- updated_at maintenance
-- -----------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION touch_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER tenants_touch    BEFORE UPDATE ON tenants    FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
CREATE TRIGGER principals_touch BEFORE UPDATE ON principals FOR EACH ROW EXECUTE FUNCTION touch_updated_at();
