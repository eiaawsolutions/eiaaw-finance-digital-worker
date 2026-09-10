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

**Where this deployment's secrets live.**

This worker follows the EIAAW house convention: the shared
**`eiaaw-all-projects`** Infisical workspace, environment **`prod`**, every
secret **flat at the workspace root** — no per-domain folders. It reads them
with the shared EIAAW machine identity that already serves opspilot, eiaaw-smt
and the proposal generator.

That is the same layout every other EIAAW service uses, which is the point: an
operator learns one arrangement and it holds across the estate.

The cost is blast-radius separation. The audit-chain anchor key and the KMS
master key sit in the same workspace as every other EIAAW app's secrets, read
by an identity already spread across six services. Compromise of that identity
reaches this worker's integrity keys. If a client contract ever requires
segregated key custody, create a dedicated workspace, move these eleven secrets
into it, issue a dedicated machine identity, and repoint
`INFISICAL_PROJECT_ID` — the handles keep working unchanged.

Do **not** use the `mcp-reader` identity here. It holds `secrets:list` only, by
design, and the app needs to read values.

### The eleven secrets this deployment reads

The resolver dereferences a handle by its **environment, path and name** against
`INFISICAL_PROJECT_ID` — the project segment in the handle is documentation.
All eleven must exist at the root of `eiaaw-all-projects`, environment `prod`, or
the service boots and then fails closed on the first resolution.

The list below is the one in [`.railway/railway.ts`](../.railway/railway.ts).
When a handle is added there, add it here — an undocumented eleventh secret is
how the previous version of this table came to say "nine" and omit
`VOYAGE_API_KEY` entirely.

| Secret                                                                                                  | Purpose                                   |
| ------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `ANTHROPIC_API_KEY`                                                                                     | Model access                              |
| `VOYAGE_API_KEY`                                                                                        | Retrieval embeddings (`voyage-finance-2`) |
| `R2_ENDPOINT`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`                                               | Object store — see "The R2 bucket"        |
| `AUDIT_CHAIN_ANCHOR_KEY`, `KMS_MASTER_KEY`, `NONCE_SIGNING_KEY`, `SESSION_SIGNING_KEY`, `SECRET_CANARY` | Integrity and encryption key material     |
| `API_SERVICE_TOKEN`                                                                                     | Authenticates the console to the API      |

**All eleven are present in `prod` as of 2026-09-11.** Nothing to provision
before the first deploy.

The five signing and encryption keys are random material generated for this
service, not third-party credentials. To mint replacements when rotating:

```bash
node scripts/generate-crypto-keys.mjs
```

It prints each value to your terminal, labelled, and writes nothing to disk.

### The R2 bucket

The bucket exists. It was created 2026-09-10 in the APAC location hint, matching
the `residency_zone` this deployment stamps on every stored object:

```text
name:                   eiaaw-fdw-artifacts
location:               APAC
default_storage_class:  Standard
```

`OBJECT_STORE_BUCKET` in `.env.example` already names it, so nothing changes
there. `R2_ENDPOINT` is that bucket's S3 API address — the Cloudflare account ID
followed by a fixed suffix:

```text
https://<R2_ACCOUNT_ID>.r2.cloudflarestorage.com
```

**This is already set** in `eiaaw-all-projects`, environments `prod` and `dev`,
at the root. Nothing to do. If you ever need to reconstruct it, `wrangler whoami`
prints the account ID.

The account ID is not a credential — it rides on every R2 request — but it is
not written out here either, because this repository is public and an account
identifier is free reconnaissance for anyone enumerating targets. It lives in
Infisical beside the key pair, which also keeps the resolver to one path instead
of two.

**Token bucket scope — checked 2026-09-10, no action needed.** Both account API
tokens are scoped to _All buckets_ (`EIAAW ORG`, Object Read & Write; `R2 Account
Token`, Admin Read & Write), so whichever one backs `R2_ACCESS_KEY_ID` reaches
the new bucket.

Re-check this whenever an R2 token is rotated or minted, because the account also
carries `eiaaw-smt-prod` from another project. A token scoped to that bucket alone
authenticates here and then denies every write, and it is indistinguishable from
a working one until the first artefact is stored — nothing in boot, settings
validation or the health checks touches it. In the dashboard: R2 → Manage R2 API
Tokens → the **Applied to** column.

`S3ObjectStoreDriver` in `packages/db/src/objects.ts` now refuses that case by
name instead of surfacing a raw SDK trace, so the failure is legible rather than
mysterious. It is still a failed deploy.

### Authentication, and what it currently evidences

`API_SERVICE_TOKEN` is what lets the console reach the API at all. In prod the
header-only session is refused, and the API **refuses to start** without the
token rather than serving endpoints nothing can call.

Understand what it proves. The token says a request came from the console. It
does not say which human is acting — the console names a principal and the API
takes its word for it. Until OIDC lands, the console's own session is
environment-configured rather than established by someone signing in, so an
approval recorded through this path names a principal without proving one was
present. Fine for enrolment and testing on a private network; not sufficient to
evidence a dual-control decision to a regulator. Anyone holding the token can
name any principal, so treat it as the console's own credentials.

`SECRET_CANARY` is a sentinel: assurance case P0-7 asserts it never appears in a
prompt or a log line. Give it a value you can grep for unambiguously.

> **Do not substitute a near-miss.** The workspace already holds `AUDIT_HMAC_KEY`
> and `SESSION_SECRET`. They are **not** `AUDIT_CHAIN_ANCHOR_KEY` and
> `SESSION_SIGNING_KEY` — they belong to other services and have other
> lifetimes. Reusing one because the name looks close is the same class of
> mistake as passing the KMS master key to the Anthropic client, which this
> repo has already had to fix once. Create the five keys fresh.

Create all of them **in the Infisical UI**. Secret creation is a human action by
design — the MCP server has no `set` capability and no agent session writes
secret values.

---

## 1. Provision

The whole project is declared in [`.railway/railway.ts`](../.railway/railway.ts)
— services, regions, replicas, health checks, and every non-secret variable.
There is no click-path to reproduce and no dashboard state that source does not
describe.

```bash
railway login                 # already done for eiaawsolutions@gmail.com
railway init --name eiaaw-finance-digital-worker
railway add --database postgres
railway config plan           # read this before applying
railway config apply
```

`railway config plan` prints exactly what will change. Read it. `apply` is the
deploy.

> **Windows note.** The `railway` npm SDK checks the CLI version by executing
> `process.env._`, which POSIX shells set and PowerShell does not, so it reports
> "CLI too old" regardless of the CLI version. Set it to the real binary first:
>
> ```powershell
> $env:_ = "$env:APPDATA\npm\node_modules\@railway\cli\bin\railway.exe"
> ```

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

| Service   | Start command                        | Replicas    | Restart    |
| --------- | ------------------------------------ | ----------- | ---------- |
| `migrate` | `pnpm db:release`                    | 1, run-once | NEVER      |
| `api`     | `node apps/api/dist/main.js`         | 2           | ON_FAILURE |
| `worker`  | `node apps/worker/dist/main.js`      | 1           | ON_FAILURE |
| `console` | `pnpm --filter @eiaaw/console start` | 1           | ON_FAILURE |

All four are declared in `.railway/railway.ts` and created by
`railway config apply`. Do not edit them in the dashboard — the next `apply`
would revert the change, and the reason for it would be lost.

The console is the reviewer's workspace and the operator's view. It calls the
API server-side only, over `RAILWAY_PRIVATE_DOMAIN`, so the session credential
never reaches a browser and the API needs no public origin allowance for it.

`migrate` restarts **NEVER**. A failed migration is a signal to look at
something, not to retry in a loop against a half-applied schema.

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

Every non-secret variable and every `secret://` handle is already declared in
`.railway/railway.ts` and applied by `railway config apply`. There is nothing to
type for those.

**Exactly three variables are set by a human, and only in the Railway
dashboard.** They are declared in the IaC with `preserve()`, which means the
config requires them and never writes them — so they never pass through a
commit, a chat message, a screenshot, or an agent session.

On **api** and **worker** (Railway shared variables set both at once):

| Variable                      | Where it comes from                       |
| ----------------------------- | ----------------------------------------- |
| `INFISICAL_APP_CLIENT_ID`     | the shared EIAAW machine identity         |
| `INFISICAL_APP_CLIENT_SECRET` | the same identity                         |
| `INFISICAL_PROJECT_ID`        | the workspace id for `eiaaw-all-projects` |

The same three values are already set on opspilot, eiaaw-smt and the proposal
generator, so the authoritative copy is whichever of those you trust most. Use
an identity holding `secrets:read`. **Not** `mcp-reader` — that one holds
`secrets:list` only, by design, and the app needs to read values.

Until all three are set, the API and worker refuse to start with:

> Infisical resolution is enabled but the bootstrap credentials are incomplete
> … do not work around this by setting raw values for the secrets they unlock.

That is the system working. The alternative — a process that boots and then
discovers mid-request that it cannot decrypt an audit payload — is worse.

See `.env.example` for the complete variable list. Every entry there is either a
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

All four services build from GitHub, so the deploy is:

```bash
git push                         # code changes
railway config apply             # infrastructure changes
```

A push rebuilds and redeploys every service. `railway up` uploads the working
directory instead and is for debugging a change you have not committed — what it
deploys is not in history, so never leave a service on one.

Watch it land:

```bash
railway service list             # per-service status
railway logs --service migrate --deployment
```

The `migrate` service is run-once and its output is worth reading rather than
just its exit code — the field, class and tool counts it prints are how you
notice a registry that did not publish. Its migration runner takes a Postgres
advisory lock, so overlapping it with a rolling API deploy is safe.

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

In prod the header-only session is refused — that path is dev-only by design.
Every endpoint needing a caller wants the service token as well, and the API
will not start without it:

```bash
# The audit chain verifies. TOKEN is the value behind
# secret://eiaaw-all-projects/prod/API_SERVICE_TOKEN.
curl -H "authorization: Bearer $TOKEN"      -H "x-tenant-id: tnt_yourclient"      -H "x-principal-id: usr_you"      -H "x-admin: true"      https://<api-domain>/v1/audit/verify

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
curl -H "authorization: Bearer $TOKEN"      -H "x-tenant-id: tnt_yourclient"      -H "x-principal-id: usr_you"      https://<api-domain>/v1/config/settings/health
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
