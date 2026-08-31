# Architecture

What this system is, and why the load-bearing parts are shaped the way they
are. Where a decision has an obvious cheaper alternative, the reason it was not
taken is stated — those are the notes that are worth having in a year.

---

## 1. The shape

Sixteen components, each owning one decision, arranged in layers L0–L9 with four
rails (identity, audit, configuration, observability) crossing all of them.

| #   | Component             | Package         | Owns                                                             |
| --- | --------------------- | --------------- | ---------------------------------------------------------------- |
| C1  | Channel Gateway       | `channels`      | Transport in and out. Verification, normalisation, nothing else. |
| C2  | Identity and Binding  | `authorisation` | Which human a channel handle is                                  |
| C3  | Context Resolver      | `context`       | The seven L0 axes, or a refusal                                  |
| C4  | Intake and Classifier | `intake`        | Intent, duplicates, admission                                    |
| C5  | Planner               | `planner`       | The task graph                                                   |
| C6  | Policy Engine         | `policy`        | The eleven rules, autonomy, verdicts                             |
| C7  | Workflow Executor     | `workflow`      | Durable execution and compensation                               |
| C8  | Skill Runtime         | `skills`        | One skill invocation, end to end                                 |
| C9  | LLM Gateway           | `llm`           | Prompt assembly, model calls, budgets                            |
| C10 | Tool Invoker          | `connectors`    | Every reach into a system of record                              |
| C11 | Knowledge Service     | `knowledge`     | Retrieval with citations                                         |
| C12 | Records Service       | `connectors`    | Client data reads                                                |
| C13 | Assurance Harness     | `assurance`     | The L8 gate                                                      |
| C14 | Delivery Service      | `delivery`      | The response contract                                            |
| C15 | Audit and Evidence    | `audit`         | The record that everything else rests on                         |
| C16 | Configuration         | `config`        | Settings, snapshots, staleness                                   |

### The directional rules

Eight of them; five are enforceable as import restrictions and are enforced in
`eslint.config.js`, so a violating commit fails CI rather than a review:

- **D1** — nothing reaches a system of record except C10. Adapters are
  unimportable outside `packages/connectors`.
- **D2** — nothing calls a model except C9, and C9 is called only by C8. No
  package outside `packages/llm` may import a provider SDK.
- **D3** — C1 is a leaf. It emits an `InboundRequest` and receives an
  `OutboundDelivery`; it cannot import C5, C6, C7, C10, C11 or C12.
- **D5** — C6 is consulted by C7, never by C8. `packages/skills` cannot import
  `@eiaaw/policy`. **A skill cannot ask for its own permission.**
- **D6** — C15 is write-only from every component. There is no update or delete
  path in any authorisation model, and the database enforces it below the
  application.

---

## 2. The two undeferrable components

Everything else in the system is only as trustworthy as these two. They were
built first, and they are the two things to check after any deploy.

### C15 — the audit log

Append-only, hash-chained per tenant, with signed anchors.

Each event carries `previous_event_hash`; the chain hash covers the canonical
JSON of the event body. Verification walks the chain and reports the first
sequence where it breaks.

The subtle part is contention. An earlier version read the chain tip and then
took a lock, which under concurrent appends produced two events claiming the
same predecessor. The fix is that `#lockAndReadTip` takes `FOR UPDATE` **before**
computing the hash — the lock and the read are one operation, and the chain is
serialised by the database rather than by hope.

Append-only is enforced by `forbid_mutation()` triggers on five tables, and the
integration suite proves it holds _even when connected as the schema owner_.
That is the interesting assertion: a control that only an application respects
is not a control.

### C13 — the L8 evaluation gate

Four gates run in the live path, not only in CI:

- **grounding** — every substantive claim carries a citation that resolves to a
  chunk actually retrieved for this answer. A citation to a chunk that does not
  exist at that version is worse than no citation, because it reads as verified.
- **arithmetic** — every declared figure is recomputed independently in integer
  minor units. The gate cannot certify a float, which is why money is never one.
- **consistency** — the answer does not contradict itself or its own citations.
- **refusal scoring** — a refusal is scored for whether it names the missing
  thing, its purpose and its owner, rather than merely declining.

`pnpm assurance:gate` exits non-zero on a regression and blocks the release.
`--prove-gate` injects a deliberate failure and inverts the assertion, so the
gate's ability to _block_ is itself tested — a gate that has never failed is not
evidence that it works.

---

## 3. Decisions worth the note

### Money is an integer, always

`{ amount_minor, currency, scale }`, arithmetic in `bigint`. Not because floats
are inelegant, but because the arithmetic gate has to recompute every published
figure and get a bit-identical answer. A float makes that check meaningless, so
a float is unrepresentable: `money(12.5)` throws, and ESLint rejects a decimal
literal assigned to something named `amount`.

### Idempotency keys are derived at compile time from business identity

Four key families, each derived from what the action _is_ — entity, document,
period, line — never from a timestamp or a random value. A key derived at call
time would be a different key on retry, which is precisely when it matters. This
is what makes "crash and resume" produce one journal posting rather than two.

### The workflow executor is Postgres, not Temporal

Replay-from-history with activity memoisation, `FOR UPDATE SKIP LOCKED` leasing,
durable timers and signals, and a compensation stack.

Re-running the workflow function from the top on every step is more work than
resuming a coroutine, and for graphs of thousands of nodes it would be the wrong
trade. It is chosen because it makes a crash at _any_ point safe: the only
durable state is the history, and the only way to interpret the history is to
replay it. A task graph here is tens of nodes.

Choosing Postgres over Temporal costs some features and removes an entire
operational dependency, a second data store, and a second place where tenant
isolation has to be got right. For a system whose central claim is auditability,
having one durable store that is also the audit store is worth more than the
features.

### Prompt boundaries are structural, not textual

Five segments: system contract, resolved context, grounding, records, untrusted
content. Segments 1–2 are the system role; 3–5 are the user role. The boundary
between trusted and untrusted is a _message role_, not a delimiter line, because
a delimiter can be typed by an attacker and a message role cannot.

The fence token is derived from the content plus a nonce, and any token-shaped
run in the payload is defused with a zero-width space before the fence is
chosen. Injection detection exists and is recorded, but it is not load-bearing —
the structure is.

### Retrieval filters before it ranks

Effective date, jurisdiction, framework and entity are _candidate filters_, not
re-ranking signals. A superseded rate with a high similarity score is not a
slightly worse answer; it is a wrong one. The integration suite proves this by
giving a non-covering chunk an identical embedding and asserting it is excluded.

Ingestion supersedes rather than overwrites, so "what did the rule say in July
2024" stays answerable. Chunk ids are `sha256(module|locator)`, so re-ingesting
unchanged text is a no-op.

### Tenant isolation is enforced below the application

Row-level security on every tenant-scoped table, with two details that make the
difference between a real control and a decorative one:

- `SET LOCAL ROLE app_worker` on every scoped transaction. Without it the
  connection runs as a superuser, and **a superuser bypasses RLS entirely** —
  the policies would exist, pass review, and protect nothing.
- `FORCE ROW LEVEL SECURITY`, so the policy applies to the table owner too.

The isolation suite deletes a policy predicate and asserts the test then fails,
which is the only way to know the test was ever testing anything.

### Secrets never enter a log or a prompt

`SecretRef` holds its value in a closure. `toJSON`, `toString` and the Node
inspect hook all return `[secret:NAME]`, so the three usual accidents —
interpolation, `JSON.stringify`, a debug dump — are structurally safe rather
than reviewed for.

A canary value is planted in the environment, and the assurance harness sweeps
logs and assembled prompts for it. It has never appeared, and the sweep is what
makes that a fact rather than a belief.

---

## 4. Configuration

The settings register is eight families (AS-ORG, AS-SYS, AS-COA, AS-DOA, AS-REG,
AS-RUL, AS-SCP, AS-PPL) entered across a ten-stage enrolment.

State-changing work runs against a **pinned snapshot**, not against live
settings. A mid-run change to an approval limit must not alter a decision
halfway through the run that was admitted under the old one. Snapshots have a
staleness bound: past it, read-only work continues with the staleness stated on
the answer, and state-changing work is refused.

The Scope Card is generated from the role profile, the reserved-acts register
and your scope settings. It has no editable field anywhere in the system. If any
reference does not resolve, generation aborts and the previous card stays
published with a staleness banner — a card with a placeholder in it would be
worse than a stale one, because it would read as current.

---

## 5. Deployment shape

One image, three entrypoints: `migrate` (run-once), `api`, `worker`.

One image rather than three guarantees the API and the worker report the same
`PLATFORM_VERSION` — and both the decision record and the evidence bundle cite
it. Two processes on different versions produce evidence that disagrees with
itself.

The worker is not optional. It runs the durable executor _and_ the governance
jobs: audit chain verification, chain anchoring, hand-off SLA escalation,
conversation idle close, settings staleness checks. Scaling the API and
forgetting the worker leaves the audit chain unverified.

Migrations are expand-then-contract and forward-only, under an advisory lock. A
rollback restores the previous platform version; it does not and cannot un-write
history, because audit events, decision records and evidence bundles are all
append-only.

---

## 6. What is deliberately absent

- **No tool that releases a payment, transmits a filing, approves a payroll run
  or certifies a reconciliation.** The capability does not exist in the
  registry, so it cannot be reached by a misconfiguration. This is stronger than
  a permission check, and it is why the reserved-acts table is published to the
  whole tenant rather than kept in a contract.
- **No degraded answer mode.** There is no configuration that turns CITE OR
  REFUSE into "cite if convenient".
- **No write path to the audit log** in any authorisation model. Purging content
  redacts it and keeps the record that it existed.
- **No fifth reviewer move.** Approve, edit-and-approve, reject-with-reason,
  reassign. A fifth control is how "approved because the queue was long" gets
  encoded, so there isn't one.
