# EIAAW Finance Expert — digital worker

A governed accounting and finance digital worker. It answers questions from a
cited knowledge corpus, prepares work for a named human to sign, and executes
procedural steps inside limits you set — across email, in-app chat, Telegram and
WhatsApp.

It is not a chatbot with database access. The difference is the part of the
system that says no, and the part that can prove afterwards what happened.

---

## The two sentences that shape everything else

**CITE OR REFUSE.** A substantive claim without a resolvable citation does not
reach a person. There is no degraded mode, no "based on general knowledge",
no confident paraphrase when retrieval came back thin.

**Absence is a refusal, never a default.** If a threshold, an approval limit, a
statutory rate or a named supervisor is missing, the worker says which field is
missing, what it is for and who owns it — and stops. It never picks a plausible
number.

---

## What it will never do

Eleven rules, listed on the Scope Card and enforced in code. They are not
settings. No administrator can switch one off, and no instruction inside a
message can either — a message asking for one of these is _evidence_, recorded
as an attempt, and refused.

Among them: it never approves or authorises anything; never releases a payment;
never submits a statutory filing; never signs or certifies; never changes its
own permissions, thresholds or Scope Card; never overrides a control; never
deletes or edits an audit record.

A person with the authority to do one of these does it themselves. They cannot
delegate it to the worker, because there is no code path that would accept the
delegation.

---

## How the work moves

```
 channel ─▶ intake ─▶ context ─▶ plan ─▶ [policy] ─▶ execute ─▶ gates ─▶ authorise ─▶ deliver
    C1        C4        C3        C5       C6        C7/C8/C9/C10   C13       —         C14
                                                                                  │
                                                     every step ────────────────▶ C15 audit
```

Three service classes, and the boundary between them is the product:

| Class       | What it is                                                              | What it changes                     |
| ----------- | ----------------------------------------------------------------------- | ----------------------------------- |
| **ANSWER**  | A grounded response, drawn from the corpus and your records             | Nothing                             |
| **PREPARE** | A proposed output plus a full evidence bundle, for a named human        | Nothing, until that person approves |
| **EXECUTE** | A completed procedural action inside a stated limit, sampled afterwards | A system of record                  |

Autonomy — observe / draft / execute — is granted **per SOP row**, never per
module and never globally. A row runs at Observe unless you switched it on,
named an individual supervisor, recorded a dated approval, completed a parallel
run, and set a non-zero post-hoc sampling rate. Missing any one of those, it
falls back to Observe rather than failing open.

---

## Layout

```
packages/
  core          money, ids, time, hashing, secrets, sensitivity, config loading
  contracts     the 16 canonical data contracts, as JSON Schema + Ajv validators
  telemetry     span taxonomy, metrics, structured logging, redaction
  db            migrations, tenant-scoped client, RLS, object store
  audit         C15  hash-chained WORM audit log and evidence bundles
  config        C16  the settings register, snapshots and staleness
  context       C3   L0 context resolution — 7 axes, refuse on unresolved
  knowledge     C11  ingestion, pgvector retrieval, effective-date filtering
  registry      C10  the tool registry, skill registry, output-class register
  policy        C6   the eleven immutable rules, autonomy computation
  workflow      C7   the Postgres-native durable executor
  connectors    C10  the tool invoker and its adapters
  llm           C9   prompt assembly, the model gateway, budgets, injection
  skills        C8   the skill runtime — ground, assemble, call, gate, record
  planner       C5   task graph construction
  intake        C4   classification, duplicate detection, admission
  assurance     C13  the L8 evaluation gate and its harness
  channels      C1   email, chat, Telegram, WhatsApp ports
  delivery      C14  the response contract and outbound delivery
  authorisation      hand-offs, reviewer moves, Scope Card generation

apps/
  api           the HTTP surface
  worker        the durable executor and the governance jobs
  console       the operator and reviewer UI
```

The direction of dependency is enforced by ESLint, not by convention: a commit
that lets the channel gateway reach the workflow executor, or lets a skill ask
the policy engine for its own permission, fails CI.

---

## Running it locally

```powershell
pnpm install
. .\scripts\dev-env.ps1        # dev-only values; forces dry-run
pnpm db:migrate
pnpm db:seed
pnpm dev                       # api :3000, worker, console :3001
```

`dev-env.ps1` sets `DEPLOY_ENVIRONMENT=dev`, and in anything but `prod` every
state-changing tool is dry-run **at the runtime** — not by a configuration flag
a developer can flip. `GET /v1/health` reports `force_dry_run` so you never have
to guess which mode you are looking at.

### Verifying

```powershell
pnpm verify        # format:check, lint, typecheck, test, assurance gate
```

| Check                            | What it covers                                                |
| -------------------------------- | ------------------------------------------------------------- |
| `pnpm test`                      | 572 tests — 471 unit, 101 integration against a real Postgres |
| `pnpm assurance:gate`            | 33 evaluation cases; exits non-zero on a regression           |
| `pnpm conformance:observability` | 18 spans, 21 metrics, required attributes present             |

Integration tests skip themselves when `DATABASE_URL` is unset, so
`pnpm test` is still meaningful without a database — it just proves less.

---

## Secrets

This repository follows the **EIAAW Deploy Contract**. The only raw secret
values that ever appear in an environment are the three Infisical bootstrap
credentials. Everything else is a `secret://…` handle resolved at boot.

`.env.example` is the reference. If a change to it adds a raw value for
anything other than `INFISICAL_APP_CLIENT_ID`, `INFISICAL_APP_CLIENT_SECRET` or
`INFISICAL_PROJECT_ID`, that change is wrong. `scripts/scan-secrets.ts` runs
pre-commit and in CI to keep it that way.

---

## Deploying

Railway, three services from one image: `migrate`, `api`, `worker`.
See [docs/DEPLOY.md](docs/DEPLOY.md) for the full runbook, and
[docs/RUNBOOK.md](docs/RUNBOOK.md) for what to do when something is wrong.

Architecture and the reasoning behind the load-bearing decisions:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

---

## Before it does anything useful

Two things must be true, and both are deliberate blockers:

1. **Enrolment is complete** — every mandatory setting entered, every approver
   and supervisor reference resolving to a named, active individual. Until then
   `ready_for_execution` is false and the SOPs that depend on those fields
   refuse.
2. **A Scope Card is generated and published by a human.** The generator refuses
   to attribute a card to the worker itself, and fails closed on any unresolved
   reference rather than emitting one with a placeholder in it.

The platform ships no client value and no statutory rate. Every threshold,
tolerance, materiality figure, approval limit and contribution rate is yours to
enter and yours to keep current — which is also why the worker can name exactly
which one is missing when it refuses.
