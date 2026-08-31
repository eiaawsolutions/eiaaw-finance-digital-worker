# Runbook

What to do when something is wrong. Ordered by how bad it is, not by how often
it happens.

For standing the system up in the first place, see [DEPLOY.md](DEPLOY.md).

---

## P1 — the audit chain is broken

**Signal**: `audit_chain_verification_failures_total > 0`, a log line reading
`AUDIT CHAIN BROKEN`, an `audit.chain_broken` event, or a red banner on the
console's audit page.

This is an incident, never a warning. The audit log is the record every other
control depends on; a break invalidates the evidence behind every decision
after it.

1. **Do not restart anything.** A restart changes nothing here and destroys
   timing evidence.
2. Get the break point:
   ```bash
   curl -H "x-admin: true" https://<api>/v1/audit/verify
   ```
   `brokenAt` gives the sequence, the event id and the reason.
3. Classify it from the reason:
   - **`hash mismatch`** — an event body differs from what its hash covers.
     Something wrote to `audit_events` outside `append_audit_event()`, or the
     row was altered in the database directly.
   - **`sequence gap`** — an event was deleted.
   - **`previous hash mismatch`** — events were reordered, or two appends raced
     and both claimed the same predecessor. If this appears under load and the
     surrounding events are microseconds apart, suspect the tip lock, not
     tampering.
4. Check the anchors. They are HMAC-signed and separately undeletable:
   ```sql
   SELECT anchored_at, head_sequence, head_event_hash, key_epoch, signature
     FROM audit_chain_anchors WHERE tenant_id = $1 ORDER BY head_sequence DESC LIMIT 5;
   ```
   An anchor that still verifies bounds the damage: everything up to its
   `head_sequence` is intact and provable. Old verification material is retained
   across key rotations (`key_epoch`), so historical segments stay checkable.
5. Preserve, then escalate. Do not "repair" the chain — a rewritten chain that
   verifies is worse than a broken one that does not, because it destroys the
   evidence that anything happened.

The append-only triggers make step 3's first two causes very hard, and the
integration suite proves they hold even as the schema owner. If one of them has
happened anyway, the question is who has direct database access.

---

## P1 — the release gate is failing

**Signal**: `pnpm assurance:gate` exits non-zero; CI's `assurance-gate` job is
red.

The gate blocks the release. That is the design, and it is not a step to skip.

```powershell
pnpm assurance:run            # full report, per-case
```

The report names the case, the suite (`golden` / `arithmetic` / `refusal` /
`adversarial`) and the gate that failed.

- **A zero-tolerance failure** — an adversarial case that got through, or a
  refusal that should have happened and did not. Fix the behaviour. Do not
  adjust the case.
- **A weighted pass-rate drop** — usually a golden case whose expected output
  drifted. Read the diff before touching the fixture: a fixture edited to match
  new behaviour is how a regression gets ratified.

To confirm the gate itself still works:

```powershell
pnpm --filter @eiaaw/assurance run harness -- --prove-gate
```

That injects a deliberate failure and inverts the assertion. If `--prove-gate`
passes and the real run fails, the gate is fine and the change is not.

---

## P2 — "settings not found" / everything is refusing

**Signal**: refusals naming a settings field; `ready_for_execution` false;
`/v1/config/settings/health` showing blank mandatory fields.

This is the system working. Absence is a refusal, never a default — the worker
is telling you which field is missing, what it is for and who owns it.

```bash
curl -H "x-tenant-id: tnt_x" https://<api>/v1/config/settings/health
```

Read `blank_mandatory_count` per family and finish enrolment. Nothing here needs
an engineer.

**If the snapshot is stale instead**: read-only work continues with the
staleness stated on the answer; state-changing work is refused. Publish a new
snapshot. If snapshots are not being published at all, check the
`settings-staleness-check` job on the worker (30-minute interval).

---

## P2 — a secret handle will not resolve

**Signal**: boot failure naming a `secret://…` handle, or
`dependency_unavailable` from a component that needs one.

In order, cheapest first:

1. Is `INFISICAL_RESOLVER_ENABLED=true` in the target environment?
2. Are all three bootstrap credentials set — `INFISICAL_APP_CLIENT_ID`,
   `INFISICAL_APP_CLIENT_SECRET`, `INFISICAL_PROJECT_ID`?
3. Does the handle match a real Infisical secret — project segment, environment,
   path and name, all four?
4. Is the variable actually resolved? `loadConfig` in `packages/core/src/env.ts`
   passes a fixed set of names through `SecretResolver`; a handle in a variable
   that is not in that set is read as a literal string.
5. Is the machine identity scoped to the right workspace? It must be
   `eiaaw-fdw-app` (holds `secrets:read`), **not** `mcp-reader` (`secrets:list`
   only, by design).

**Never** fix this by putting a raw value in the environment. If you cannot get
the handle to resolve, escalate — a deployment running on pasted secrets is a
worse outcome than a deployment that is down.

---

## P2 — the worker is not making progress

**Signal**: `handoff_open_age_seconds` climbing across the board, workflow runs
stuck in `running`, timers past due.

1. Is the worker process alive at all? It is a separate service and it is not
   optional — it runs the executor _and_ the governance jobs.
2. Are runs leased and abandoned?
   ```sql
   SELECT workflow_run_id, state, leased_by, leased_until
     FROM workflow_runs
    WHERE state = 'running' AND leased_until < now();
   ```
   Expired leases are reclaimed by the sweeper. If they are not being reclaimed,
   the sweeper loop is not running.
3. Is one run failing repeatedly? Check `workflow_events` for the run: an
   activity retrying under the `connector` retry class will back off and
   eventually stop; a permanent failure does not retry at all.
4. Multiple replicas are safe. Leasing is `FOR UPDATE SKIP LOCKED`, and the
   integration suite proves six concurrent pollers produce one execution. Raise
   `WORKFLOW_WORKER_CONCURRENCY` before raising replica count.

If `handoff_open_age_seconds` is climbing but workflows are fine, the bottleneck
is people, not the system. That metric is on the governance dashboard precisely
so the difference is visible.

---

## P3 — a skill is drifting

**Signal**: `accuracy_floor_margin` narrowing; `revalidation_pending_total`
above zero.

`revalidation_pending_total > 0` means skills are running at a _reduced_ ceiling
after a dependency changed — a knowledge pack version, a tool contract, a
settings family. That is the safe state, not the broken one. Revalidate the
affected skills; do not raise the ceiling to clear the metric.

`accuracy_floor_margin` narrowing toward zero means a skill is approaching its
pull-back threshold. When it crosses, the skill's autonomy drops automatically.

---

## Reading a refusal

Every refusal is an RFC 7807 problem document, and `detail` is written to be
shown to a person: it names what is missing, why it is needed and who owns it.
Do not paraphrase it in a UI.

The `error_code` is a closed list. The ones that mean something specific:

| Code                     | Status | What it actually means                                                                         |
| ------------------------ | ------ | ---------------------------------------------------------------------------------------------- |
| `context_unresolved`     | 412    | An L0 axis could not be resolved. The answer would have been about the wrong entity or period. |
| `authority_insufficient` | 403    | The reviewer does not hold the authority for this decision.                                    |
| `sod_excluded`           | 403    | Segregation of duties. Often the _same_ person who prepared it.                                |
| `sensitivity_ceiling`    | 403    | The content is above what this channel may carry. Not a permissions bug.                       |
| `nonce_invalid`          | 401    | An approval nonce was replayed or is unknown.                                                  |
| `stale_bundle_version`   | 409    | The evidence changed under the reviewer. They must re-read before deciding.                    |
| `period_locked`          | 423    | The accounting period is closed.                                                               |
| `skill_suspended`        | 423    | The skill was pulled back — check `revalidation_pending_total`.                                |
| `residency_violation`    | 451    | Data would have left its residency zone.                                                       |

`duplicate_request` (409) is usually correct behaviour, not a fault: the intake
layer deduplicates by transport message id within a 24-hour window.

---

## Rollback

```bash
railway rollback --service api
```

Safe by construction: migrations are expand-then-contract and forward-only;
in-flight workflow runs continue on their pinned definition version; audit
events, decision records and evidence bundles are append-only.

A rollback restores the previous platform version. It does not, and cannot,
un-write history.

---

## Periodic jobs and their intervals

Running on the `worker` service. If one stops, the symptom is listed above.

| Job                        | Interval | If it stops                                 |
| -------------------------- | -------- | ------------------------------------------- |
| `audit-chain-verification` | 15 min   | Tampering goes undetected                   |
| `audit-chain-anchoring`    | 60 min   | The chain has no independently signed bound |
| `handoff-sla-escalation`   | 1 min    | Breached hand-offs are not escalated        |
| `conversation-idle-close`  | 5 min    | Conversations stay open indefinitely        |
| `settings-staleness-check` | 30 min   | Stale snapshots are not flagged             |

---

## What never to do

- Never repair the audit chain.
- Never edit an assurance fixture to make a failing gate pass.
- Never put a raw secret value in an environment to work around a resolver
  problem.
- Never set `DEPLOY_ENVIRONMENT=prod` in a non-production environment to "test
  the real path". It is the only thing that lifts forced dry-run.
- Never grant the worker's service account approve or admin scope in any system
  of record. Three independent layers block reserved acts; that is one of them.
