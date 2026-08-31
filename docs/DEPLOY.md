# Deploying to Railway

The runbook for standing this up. Follow it in order — the ordering matters,
and the reasons are stated rather than left implicit.

---

## 0. Before you start

This build follows the **EIAAW Deploy Contract**. The consequence for you is
short and non-negotiable:

> The only raw secret values that ever enter Railway's environment are the three
> Infisical machine-identity bootstrap credentials. Everything else — Anthropic,
> SMTP, Telegram, WhatsApp, R2, KMS, signing keys — lives in Infisical and is
> referenced by a `secret://…` handle.

If a step below ever seems to be asking you to paste an `sk-ant-…` into Railway,
stop: that is not this runbook.

**What I need from you before a production deploy:**

| Item                                                                                                 | Why                                               |
| ---------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| Infisical project ID for `eiaaw-fdw-prod`                                                            | The resolver dereferences every handle against it |
| Confirmation the `eiaaw-fdw-app` machine identity exists, scoped to that project with `secrets:read` | The app reads values with it                      |
| Its `clientId` and `clientSecret`                                                                    | The only raw credentials that go into Railway     |

Do **not** use the `mcp-reader` identity here. It holds `secrets:list` only, by
design, and the app needs to read values.

---

## 1. Provision

```bash
railway login                 # already done for eiaawsolutions@gmail.com
railway init                  # creates the project
railway link                  # link this working directory to it
```

Then add the one stateful dependency:

```bash
railway add --database postgres
```

Railway injects `DATABASE_URL` into every service in the project. That variable
is the single documented exception to the handle rule, because Railway owns the
credential and rotates it itself.

### pgvector

The knowledge service needs the `vector` extension. Railway's Postgres image
includes it; migration `0001` runs `CREATE EXTENSION IF NOT EXISTS "vector"`.
If the extension is unavailable on your plan, migration 0001 fails loudly rather
than silently disabling retrieval — that is deliberate.

---

## 2. Services

Four services, one image. Keeping them in one image guarantees the API and the
worker always run the same `PLATFORM_VERSION`, which the decision record and the
evidence bundle both reference — two processes on different versions would
produce evidence that disagrees with itself.

| Service   | Start command                        | Replicas    | Config                        |
| --------- | ------------------------------------ | ----------- | ----------------------------- |
| `migrate` | `pnpm db:migrate && pnpm db:seed`    | 1, run-once | `deploy/railway/migrate.json` |
| `api`     | `node apps/api/dist/main.js`         | 2+          | `deploy/railway/api.json`     |
| `worker`  | `node apps/worker/dist/main.js`      | 1           | `deploy/railway/worker.json`  |
| `console` | `pnpm --filter @eiaaw/console start` | 1           | `deploy/railway/console.json` |

Create each in the dashboard from this repo, and point its **Config-as-code
path** at the file above.

The console is the reviewer's workspace and the operator's view. It calls the
API server-side only, so set `PUBLIC_API_URL` on it to the API's private Railway
address — the session credential then never reaches a browser, and the API does
not need a public origin allowance for it.

### Why the worker is separate, and why it is not optional

The worker runs the durable workflow executor **and** the governance jobs: audit
chain verification, chain anchoring, hand-off SLA escalation, conversation idle
close, settings staleness checks.

If you scale the API to zero to save money and forget the worker, the audit
chain stops being verified. Run the worker.

### Why `worker` has one replica

The executor leases work with `FOR UPDATE SKIP LOCKED`, so N replicas are safe
and will not double-execute. One is the starting point; raise
`WORKFLOW_WORKER_CONCURRENCY` before you raise replica count, because the
in-process loops are cheaper than another container.

---

## 3. Environment

Set these on **every** service (Railway shared variables are the easy way):

```bash
# The three bootstrap credentials — the only raw secrets anywhere.
railway variables --set INFISICAL_APP_CLIENT_ID=...
railway variables --set INFISICAL_APP_CLIENT_SECRET=...
railway variables --set INFISICAL_PROJECT_ID=...
railway variables --set INFISICAL_ENVIRONMENT=prod
railway variables --set INFISICAL_RESOLVER_ENABLED=true

# Runtime identity.
railway variables --set DEPLOY_ENVIRONMENT=prod
railway variables --set RESIDENCY_ZONE=my-central
railway variables --set PLATFORM_VERSION=0.1.0
railway variables --set DATABASE_SSL=true

# Everything else is a HANDLE, not a value.
railway variables --set AUDIT_CHAIN_ANCHOR_KEY=secret://eiaaw-fdw/prod/crypto/AUDIT_CHAIN_ANCHOR_KEY
railway variables --set KMS_MASTER_KEY=secret://eiaaw-fdw/prod/crypto/KMS_MASTER_KEY
railway variables --set NONCE_SIGNING_KEY=secret://eiaaw-fdw/prod/crypto/NONCE_SIGNING_KEY
railway variables --set SESSION_SIGNING_KEY=secret://eiaaw-fdw/prod/crypto/SESSION_SIGNING_KEY
railway variables --set SECRET_CANARY=secret://eiaaw-fdw/prod/crypto/SECRET_CANARY
railway variables --set ANTHROPIC_API_KEY=secret://eiaaw-fdw/prod/llm/ANTHROPIC_API_KEY
```

See `.env.example` for the complete list. Every variable there is either a
bootstrap credential, a non-secret setting, or a handle.

### `DEPLOY_ENVIRONMENT=prod` is load-bearing

It is the **only** thing that lifts forced dry-run. In `dev`, `test` and
`staging` every state-changing tool is dry-run at the runtime, not by
configuration a developer can flip.

`GET /v1/health` reports `force_dry_run` so you never have to guess which mode a
deployment is in.

Setting it to `prod` does **not** by itself let the worker write anything: a
tool still needs graduation stage 4, an Execute grant on the SOP row, a named
supervisor, and a policy verdict. `prod` removes one of five locks.

---

## 4. Deploy

```bash
railway up --service migrate     # wait for it to exit 0
railway up --service api
railway up --service worker
railway up --service console
```

The `migrate` service is run-once. Its migration runner takes a Postgres
advisory lock, so running it concurrently with a rolling API deploy is safe —
but running it first means the API never boots against a schema it does not
expect.

---

## 5. Verify

```bash
curl https://<api-domain>/v1/health
```

Expect:

```json
{
  "status": "ok",
  "environment": "prod",
  "residency_zone": "my-central",
  "force_dry_run": false,
  "checks": { "database": { "ok": true } }
}
```

Then verify the two undeferrable components are live:

```bash
# The audit chain verifies.
curl -H "x-admin: true" https://<api-domain>/v1/audit/verify

# The evaluation gate blocks a broken change.
pnpm --filter @eiaaw/assurance run harness --prove-gate
```

If either fails, you do not have a deployment — you have a process that is
running. Both are declared undeferrable in the architecture for the same reason:
everything else is only as trustworthy as they are.

---

## 6. Enrol a tenant

**The worker will not do anything useful until this is done, and that is by
design.** DWD-06 s.13.3: absence is a refusal, never a default.

```bash
curl -H "x-tenant-id: tnt_yourclient" https://<api-domain>/v1/config/settings/health
```

Until `ready_for_execution` is `true`:

- no SOP will run,
- every request that needs a missing setting is refused with a message naming
  the field, its purpose in business terms, and its owner.

The enrolment sequence is the ten stages in
`admin-settings/00-INDEX.md`. The runtime reads the ~62 fields in
`packages/config/src/catalogue.ts`; the rest of the register is client-facing
detail entered through the console.

**A Scope Card must be generated and published by a human before the worker
operates.** The generator refuses to attribute a card to the worker itself
(AS-SCP-014), and fails closed on any unresolved reference rather than emitting
a placeholder.

---

## 7. Ingest the corpus

```bash
railway run pnpm --filter @eiaaw/knowledge ingest \
  --dir "<path to knowledgebase/accounting and finance>" \
  --pack pack-my-mfrs --version 2026.08.1 \
  --jurisdiction MY --framework MFRS --effective-from 2026-01-01 --publish
```

Re-running is idempotent by content hash: unchanged text is a no-op, and changed
text **supersedes** rather than overwrites, so "what did the rule say in July
2024" stays answerable.

---

## 8. Rollback

```bash
railway rollback --service api
```

Safe by construction:

- migrations are expand-then-contract and forward-only;
- workflow definitions are versioned, and in-flight graphs continue on the
  version they pinned;
- audit events, decision records and evidence bundles are append-only, so a
  rollback leaves them untouched.

A rollback restores the previous platform version. It does not and cannot
un-write history.

---

## 9. What to watch

Four metrics are the operational face of governance (DWD-06 s.12.4). Put them on
the first dashboard anyone opens:

| Metric                       | What a bad reading means                                          |
| ---------------------------- | ----------------------------------------------------------------- |
| `autonomy_level_current`     | A row is running at a level nobody expected                       |
| `accuracy_floor_margin`      | A skill is drifting toward its pull-back threshold                |
| `revalidation_pending_total` | Skills are running at a reduced ceiling after a dependency change |
| `handoff_open_age_seconds`   | Humans, not the worker, are the bottleneck                        |

And one alert that is always an incident, never a warning:

| Metric                                    | Threshold |
| ----------------------------------------- | --------- |
| `audit_chain_verification_failures_total` | `> 0`     |

---

## 10. Costs

| Service  | Shape                                                                                            |
| -------- | ------------------------------------------------------------------------------------------------ |
| Postgres | The only stateful dependency. Size it for the audit log, which is append-only and never shrinks. |
| `api`    | Scales with request volume.                                                                      |
| `worker` | Steady. Scale `WORKFLOW_WORKER_CONCURRENCY` before replicas.                                     |

Model spend is bounded per graph by `AS-SYS-BGT-001` and per call by
`AS-SYS-BGT-003`, both client-entered. The gateway **refuses** a call that would
exceed a ceiling rather than making it and reporting the overrun afterwards, so
a runaway graph halts with partial results instead of a surprise invoice.
