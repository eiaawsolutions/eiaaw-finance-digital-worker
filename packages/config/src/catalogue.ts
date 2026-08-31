/**
 * The AS- field catalogue.
 *
 * The full registers hold ~2,533 fields across eight families (admin-settings
 * 00-INDEX s.1). This file declares the subset the *runtime* reads — every
 * field referenced by DWD-06, file 01, file 05 or the build roadmap, plus the
 * platform constants Phase 0 requires complete before anything runs.
 *
 * The remainder of the register is client-facing enrolment detail: it is
 * entered through the admin console against the same catalogue table, and a
 * field the runtime never reads needs no entry here.
 *
 * admin-settings 00-INDEX s.7 is the rule this file obeys:
 *
 *   "`Default` reads 'none (client-entered)' for every threshold, rate, limit
 *    and amount. The platform ships no client value and no statutory rate."
 *
 * So there is no `default` property anywhere below. Only shape, purpose,
 * ownership, and which SOP consumes it.
 */
import type { SettingFamily } from './resolver.js';

export interface CatalogueField {
  readonly field_id: string;
  readonly family: SettingFamily;
  readonly label: string;
  /** In business terms — surfaced verbatim in a refusal (DWD-06 s.13.3). */
  readonly purpose: string;
  readonly value_type:
    | 'string'
    | 'integer'
    | 'money'
    | 'decimal'
    | 'boolean'
    | 'date'
    | 'enum'
    | 'reference'
    | 'list'
    | 'json';
  readonly enum_values?: readonly string[];
  readonly requirement: 'mandatory' | 'conditional' | 'optional';
  readonly requirement_condition?: string;
  readonly scopable_by?: readonly ('entity' | 'process' | 'channel' | 'role')[];
  readonly who_defines: string;
  readonly approval_needed?: string;
  readonly consumed_by?: readonly string[];
  readonly owner_role_ref: string;
  readonly enrolment_stage: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9;
  /** Statutory particulars must be re-verified against the authority. */
  readonly requires_reverification?: boolean;
}

const f = (field: CatalogueField): CatalogueField => field;

// ---------------------------------------------------------------------------
// Stage 1 — AS-ORG: organisation identity, fiscal calendar, residency.
// Phase 0 requires these: "The audit log cannot set retention or residency
// without them."
// ---------------------------------------------------------------------------

const ORG: readonly CatalogueField[] = [
  f({
    field_id: 'AS-ORG-001',
    family: 'AS-ORG',
    label: 'Legal entity register',
    purpose:
      'name every legal entity the worker may act for, so the L0 resolver can bind a ' +
      'request to exactly one entity',
    value_type: 'list',
    requirement: 'mandatory',
    who_defines: 'Client admin',
    approval_needed: 'Financial controller',
    consumed_by: ['L0 context resolver', 'every SOP'],
    owner_role_ref: 'AS-PPL-001 (client admin)',
    enrolment_stage: 1,
  }),
  f({
    field_id: 'AS-ORG-002',
    family: 'AS-ORG',
    label: 'Primary jurisdiction',
    purpose: 'resolve which body of law and which statutory calendar applies',
    value_type: 'string',
    requirement: 'mandatory',
    scopable_by: ['entity'],
    who_defines: 'Client admin',
    consumed_by: ['L0 context resolver', 'L2 retrieval filter'],
    owner_role_ref: 'AS-PPL-001',
    enrolment_stage: 1,
  }),
  f({
    field_id: 'AS-ORG-003',
    family: 'AS-ORG',
    label: 'Reporting framework',
    purpose: 'select the accounting framework an answer or working paper is prepared under',
    value_type: 'enum',
    enum_values: ['MFRS', 'MPERS', 'IFRS', 'US-GAAP', 'SFRS', 'OTHER'],
    requirement: 'mandatory',
    scopable_by: ['entity'],
    who_defines: 'Financial controller',
    consumed_by: ['L0 context resolver', 'L2 retrieval filter'],
    owner_role_ref: 'AS-PPL-002 (financial controller)',
    enrolment_stage: 1,
  }),
  f({
    field_id: 'AS-ORG-004',
    family: 'AS-ORG',
    label: 'Functional currency',
    purpose: 'denominate every monetary figure the worker produces',
    value_type: 'string',
    requirement: 'mandatory',
    scopable_by: ['entity'],
    who_defines: 'Financial controller',
    consumed_by: ['every SOP producing a figure'],
    owner_role_ref: 'AS-PPL-002',
    enrolment_stage: 1,
  }),
  f({
    field_id: 'AS-ORG-005',
    family: 'AS-ORG',
    label: 'Fiscal year end',
    purpose: 'derive fiscal periods, so an as-of date resolves to a named period',
    value_type: 'string',
    requirement: 'mandatory',
    scopable_by: ['entity'],
    who_defines: 'Financial controller',
    consumed_by: ['L0 context resolver', 'PP/03 close'],
    owner_role_ref: 'AS-PPL-002',
    enrolment_stage: 1,
  }),
  f({
    field_id: 'AS-ORG-006',
    family: 'AS-ORG',
    label: 'Default locale',
    purpose: 'render dates, numbers and language in the form the reader expects',
    value_type: 'string',
    requirement: 'mandatory',
    who_defines: 'Client admin',
    consumed_by: ['L7 rendering'],
    owner_role_ref: 'AS-PPL-001',
    enrolment_stage: 1,
  }),
  f({
    field_id: 'AS-ORG-121',
    family: 'AS-ORG',
    label: 'Residency jurisdiction',
    purpose:
      'stamp every context and every store with a residency zone, so a cross-zone read ' +
      'or write is refused rather than proxied',
    value_type: 'string',
    requirement: 'mandatory',
    who_defines: 'Client admin',
    approval_needed: 'Financial controller',
    consumed_by: ['audit log', 'every store', 'LLM gateway routing'],
    owner_role_ref: 'AS-PPL-001',
    enrolment_stage: 1,
  }),
  f({
    field_id: 'AS-ORG-130',
    family: 'AS-ORG',
    label: 'Audit retention period',
    purpose:
      'set how long audit events, decision records and evidence bundles are retained, ' +
      'subject to the statutory floor in PP/08 s.8',
    value_type: 'integer',
    requirement: 'mandatory',
    who_defines: 'Client admin',
    approval_needed: 'Financial controller',
    consumed_by: ['retention job'],
    owner_role_ref: 'AS-PPL-001',
    enrolment_stage: 1,
  }),
  f({
    field_id: 'AS-ORG-138',
    family: 'AS-ORG',
    label: 'Legal hold flag',
    purpose: 'suspend all retention expiry while a matter is under legal hold',
    value_type: 'boolean',
    requirement: 'optional',
    who_defines: 'Client admin',
    consumed_by: ['retention job'],
    owner_role_ref: 'AS-PPL-001',
    enrolment_stage: 1,
  }),
];

// ---------------------------------------------------------------------------
// Stage 2 — AS-SYS: systems, connectors, agent access, logging, budgets.
// ---------------------------------------------------------------------------

const SYS: readonly CatalogueField[] = [
  f({
    field_id: 'AS-SYS-001',
    family: 'AS-SYS',
    label: 'Systems inventory',
    purpose: 'name every system the worker may reach, and through which connector',
    value_type: 'list',
    requirement: 'mandatory',
    who_defines: 'IT / systems owner',
    approval_needed: 'Financial controller + IT',
    consumed_by: ['L6 tool registry'],
    owner_role_ref: 'AS-PPL-003 (systems owner)',
    enrolment_stage: 2,
  }),
  f({
    field_id: 'AS-SYS-020',
    family: 'AS-SYS',
    label: 'Connector rate limit',
    purpose: 'bound calls per interval to a connector, per the client licence',
    value_type: 'integer',
    requirement: 'conditional',
    requirement_condition: 'a connector is enabled',
    scopable_by: ['process'],
    who_defines: 'IT / systems owner',
    consumed_by: ['L6 tool invoker'],
    owner_role_ref: 'AS-PPL-003',
    enrolment_stage: 2,
  }),
  f({
    field_id: 'AS-SYS-021',
    family: 'AS-SYS',
    label: 'Connector timeout (ms)',
    purpose: 'fail a tool call that has stopped making progress rather than holding a node open',
    value_type: 'integer',
    requirement: 'conditional',
    requirement_condition: 'a connector is enabled',
    who_defines: 'IT / systems owner',
    consumed_by: ['L6 tool invoker'],
    owner_role_ref: 'AS-PPL-003',
    enrolment_stage: 2,
  }),
  f({
    field_id: 'AS-SYS-040',
    family: 'AS-SYS',
    label: 'LLM provider and model per route',
    purpose:
      'select which model serves each skill and mode. The platform ships route shapes, ' +
      'never vendor choices',
    value_type: 'json',
    requirement: 'mandatory',
    scopable_by: ['process'],
    who_defines: 'IT / systems owner',
    approval_needed: 'Financial controller',
    consumed_by: ['C9 LLM gateway'],
    owner_role_ref: 'AS-PPL-003',
    enrolment_stage: 2,
  }),
  f({
    field_id: 'AS-SYS-041',
    family: 'AS-SYS',
    label: 'Model data-handling terms',
    purpose:
      'record training opt-out and retention terms, which the tenant isolation invariant ' +
      'depends on',
    value_type: 'json',
    requirement: 'mandatory',
    who_defines: 'IT / systems owner',
    approval_needed: 'Accountable owner',
    consumed_by: ['C9 LLM gateway'],
    owner_role_ref: 'AS-PPL-003',
    enrolment_stage: 2,
  }),
  f({
    field_id: 'AS-SYS-083',
    family: 'AS-SYS',
    label: 'Audit log primary destination',
    purpose: 'name where the immutable audit log is written',
    value_type: 'string',
    requirement: 'mandatory',
    who_defines: 'IT / systems owner',
    consumed_by: ['C15 audit store'],
    owner_role_ref: 'AS-PPL-003',
    enrolment_stage: 2,
  }),
  f({
    field_id: 'AS-SYS-084',
    family: 'AS-SYS',
    label: 'Audit log secondary destination',
    purpose:
      'name a second destination outside the worker’s write control, so a compromise of ' +
      'the worker cannot erase its own record',
    value_type: 'string',
    requirement: 'mandatory',
    who_defines: 'IT / systems owner',
    consumed_by: ['C15 audit store'],
    owner_role_ref: 'AS-PPL-003',
    enrolment_stage: 2,
  }),
  f({
    field_id: 'AS-SYS-090',
    family: 'AS-SYS',
    label: 'Settings staleness bound (seconds)',
    purpose: 'set how old a settings snapshot may be before state-changing work is refused',
    value_type: 'integer',
    requirement: 'mandatory',
    who_defines: 'IT / systems owner',
    consumed_by: ['C16 configuration service'],
    owner_role_ref: 'AS-PPL-003',
    enrolment_stage: 2,
  }),
  f({
    field_id: 'AS-SYS-095',
    family: 'AS-SYS',
    label: 'Webhook replay window (seconds)',
    purpose: 'reject a webhook whose timestamp is outside the replay window',
    value_type: 'integer',
    requirement: 'mandatory',
    who_defines: 'IT / systems owner',
    consumed_by: ['C1 channel gateway'],
    owner_role_ref: 'AS-PPL-003',
    enrolment_stage: 2,
  }),
  f({
    field_id: 'AS-SYS-096',
    family: 'AS-SYS',
    label: 'Secret rotation overlap window (seconds)',
    purpose:
      'accept both the current and the next webhook secret during rotation, so there is ' +
      'never a window with no verification',
    value_type: 'integer',
    requirement: 'mandatory',
    who_defines: 'IT / systems owner',
    consumed_by: ['C1 channel gateway'],
    owner_role_ref: 'AS-PPL-003',
    enrolment_stage: 2,
  }),
  f({
    field_id: 'AS-SYS-100',
    family: 'AS-SYS',
    label: 'Personal data handling policy',
    purpose: 'govern how payroll and personal data are minimised before a model sees them',
    value_type: 'json',
    requirement: 'mandatory',
    who_defines: 'IT / systems owner',
    approval_needed: 'Accountable owner',
    consumed_by: ['pre-model redaction pipeline'],
    owner_role_ref: 'AS-PPL-003',
    enrolment_stage: 2,
  }),
  f({
    field_id: 'AS-SYS-112',
    family: 'AS-SYS',
    label: 'Data classification scheme',
    purpose: 'map the tenant’s own classification onto the four platform tiers',
    value_type: 'json',
    requirement: 'mandatory',
    who_defines: 'IT / systems owner',
    consumed_by: ['C14 delivery service', 'channel permission matrix'],
    owner_role_ref: 'AS-PPL-003',
    enrolment_stage: 2,
  }),
  f({
    field_id: 'AS-SYS-BGT-001',
    family: 'AS-SYS',
    label: 'Per-graph cost ceiling',
    purpose:
      'cap what one task graph may spend on models and connectors before it halts with a ' +
      'budget failure',
    value_type: 'money',
    requirement: 'mandatory',
    scopable_by: ['process'],
    who_defines: 'Financial controller',
    consumed_by: ['C9 LLM gateway', 'C10 tool invoker'],
    owner_role_ref: 'AS-PPL-002',
    enrolment_stage: 2,
  }),
  f({
    field_id: 'AS-SYS-BGT-002',
    family: 'AS-SYS',
    label: 'Per-graph token ceiling',
    purpose: 'cap total model tokens for one task graph',
    value_type: 'integer',
    requirement: 'mandatory',
    scopable_by: ['process'],
    who_defines: 'Financial controller',
    consumed_by: ['C9 LLM gateway'],
    owner_role_ref: 'AS-PPL-002',
    enrolment_stage: 2,
  }),
  f({
    field_id: 'AS-SYS-BGT-003',
    family: 'AS-SYS',
    label: 'Per-call model cost ceiling',
    purpose: 'refuse a single model call that would exceed the per-call ceiling',
    value_type: 'money',
    requirement: 'mandatory',
    who_defines: 'Financial controller',
    consumed_by: ['C9 LLM gateway'],
    owner_role_ref: 'AS-PPL-002',
    enrolment_stage: 2,
  }),
];

// ---------------------------------------------------------------------------
// Stage 4 — AS-DOA: approval authority and delegation.
// AS-DOA-001..010 are PLATFORM CONSTANTS: they encode the immutable rules and
// are not client-editable.
// ---------------------------------------------------------------------------

const DOA: readonly CatalogueField[] = [
  f({
    field_id: 'AS-DOA-001',
    family: 'AS-DOA',
    label: 'The agent is never an approver (platform constant)',
    purpose:
      'record immutable rule 1. Present for completeness of the register; it is not ' +
      'switchable by any admin or client instruction',
    value_type: 'boolean',
    requirement: 'mandatory',
    who_defines: 'Platform',
    consumed_by: ['C6 policy engine'],
    owner_role_ref: 'Platform',
    enrolment_stage: 4,
  }),
  f({
    field_id: 'AS-DOA-002',
    family: 'AS-DOA',
    label: 'Approval record requirements (platform constant)',
    purpose: 'record what an approval must capture for non-repudiation',
    value_type: 'json',
    requirement: 'mandatory',
    who_defines: 'Platform',
    consumed_by: ['L9 authorisation'],
    owner_role_ref: 'Platform',
    enrolment_stage: 4,
  }),
  f({
    field_id: 'AS-DOA-020',
    family: 'AS-DOA',
    label: 'Approval matrix',
    purpose:
      'name who may approve which output class up to which value, resolved to a person ' +
      'through AS-PPL-',
    value_type: 'json',
    requirement: 'mandatory',
    scopable_by: ['entity', 'process'],
    who_defines: 'CFO',
    approval_needed: 'CFO / board where required',
    consumed_by: ['L9 authorisation', 'hand-off assignment'],
    owner_role_ref: 'AS-PPL-004 (CFO)',
    enrolment_stage: 4,
  }),
  f({
    field_id: 'AS-DOA-030',
    family: 'AS-DOA',
    label: 'Segregation-of-duties exclusions',
    purpose: 'name pairs of activities the same person may never perform on the same item',
    value_type: 'list',
    requirement: 'mandatory',
    scopable_by: ['entity', 'process'],
    who_defines: 'CFO',
    consumed_by: ['C6 policy engine', 'hand-off assignment'],
    owner_role_ref: 'AS-PPL-004',
    enrolment_stage: 4,
  }),
  f({
    field_id: 'AS-DOA-040',
    family: 'AS-DOA',
    label: 'Dual-control threshold',
    purpose: 'set the value above which a second named approver is required',
    value_type: 'money',
    requirement: 'mandatory',
    scopable_by: ['entity', 'process'],
    who_defines: 'CFO',
    consumed_by: ['C6 policy engine'],
    owner_role_ref: 'AS-PPL-004',
    enrolment_stage: 4,
  }),
];

// ---------------------------------------------------------------------------
// Stage 6 — AS-RUL: business rules, tolerances, SLAs, materiality.
// ---------------------------------------------------------------------------

const RUL: readonly CatalogueField[] = [
  f({
    field_id: 'AS-RUL-010',
    family: 'AS-RUL',
    label: 'Three-way match price tolerance',
    purpose: 'decide when an invoice price variance is within tolerance and may be coded',
    value_type: 'money',
    requirement: 'conditional',
    requirement_condition: 'P2P is in scope',
    scopable_by: ['entity', 'process'],
    who_defines: 'Financial controller',
    approval_needed: 'CFO',
    consumed_by: ['PP/01 s.5 three-way match'],
    owner_role_ref: 'AS-PPL-002',
    enrolment_stage: 6,
  }),
  f({
    field_id: 'AS-RUL-011',
    family: 'AS-RUL',
    label: 'Three-way match quantity tolerance',
    purpose: 'decide when a goods-receipt quantity variance is within tolerance',
    value_type: 'decimal',
    requirement: 'conditional',
    requirement_condition: 'P2P is in scope',
    scopable_by: ['entity', 'process'],
    who_defines: 'Financial controller',
    consumed_by: ['PP/01 s.5'],
    owner_role_ref: 'AS-PPL-002',
    enrolment_stage: 6,
  }),
  f({
    field_id: 'AS-RUL-MAT-001',
    family: 'AS-RUL',
    label: 'Materiality threshold',
    purpose:
      'decide whether a reviewer’s edit is material, which opens a change request and ' +
      'feeds the accuracy floor',
    value_type: 'money',
    requirement: 'mandatory',
    scopable_by: ['entity'],
    who_defines: 'Financial controller',
    approval_needed: 'CFO',
    consumed_by: ['L9 reviewer action', 'L8 drift monitors'],
    owner_role_ref: 'AS-PPL-002',
    enrolment_stage: 6,
  }),
  f({
    field_id: 'AS-RUL-SLA-001',
    family: 'AS-RUL',
    label: 'Hand-off SLA',
    purpose: 'set how long an approver has before the hand-off escalates',
    value_type: 'string',
    requirement: 'mandatory',
    scopable_by: ['process'],
    who_defines: 'Financial controller',
    consumed_by: ['hand-off timer', 'escalation'],
    owner_role_ref: 'AS-PPL-002',
    enrolment_stage: 6,
  }),
  f({
    field_id: 'AS-RUL-SLA-002',
    family: 'AS-RUL',
    label: 'Conversational latency ceiling',
    purpose:
      'set the point at which the worker must acknowledge with an expected time rather ' +
      'than continue silently',
    value_type: 'string',
    requirement: 'mandatory',
    scopable_by: ['channel'],
    who_defines: 'Financial controller',
    consumed_by: ['C7 workflow executor', 'C14 delivery'],
    owner_role_ref: 'AS-PPL-002',
    enrolment_stage: 6,
  }),
  f({
    field_id: 'AS-RUL-CTX-001',
    family: 'AS-RUL',
    label: 'Resolved context TTL',
    purpose:
      'set how long a resolved L0 context stays usable before it must be re-resolved. A ' +
      'graph suspended overnight must not resume on yesterday’s period status',
    value_type: 'string',
    requirement: 'mandatory',
    who_defines: 'Financial controller',
    consumed_by: ['C3 context resolver', 'C7 workflow executor'],
    owner_role_ref: 'AS-PPL-002',
    enrolment_stage: 6,
  }),
];

// ---------------------------------------------------------------------------
// Stage 7 — AS-SCP: process scope, autonomy, supervision.
// AS-SCP-001..016 are PLATFORM CONSTANTS encoding the immutable rules.
// ---------------------------------------------------------------------------

const SCP: readonly CatalogueField[] = [
  f({
    field_id: 'AS-SCP-002',
    family: 'AS-SCP',
    label: 'Agent may never be recorded as approver (platform constant)',
    purpose: 'record immutable rule 1 at the scope layer',
    value_type: 'boolean',
    requirement: 'mandatory',
    who_defines: 'Platform',
    consumed_by: ['C6 policy engine'],
    owner_role_ref: 'Platform',
    enrolment_stage: 7,
  }),
  f({
    field_id: 'AS-SCP-008',
    family: 'AS-SCP',
    label: 'Named individual supervisor per row',
    purpose:
      'name the individual who supervises each SOP row above Observe. A role, a mailbox ' +
      'or a team is not a supervisor',
    value_type: 'reference',
    requirement: 'conditional',
    requirement_condition: 'the row is above Observe',
    scopable_by: ['process', 'entity'],
    who_defines: 'Accountable owner',
    approval_needed: 'CFO',
    consumed_by: ['autonomy computation', 'C6 policy engine'],
    owner_role_ref: 'AS-PPL-005 (accountable owner)',
    enrolment_stage: 7,
  }),
  f({
    field_id: 'AS-SCP-010',
    family: 'AS-SCP',
    label: 'Autonomy raise approval and parallel-run record',
    purpose:
      'evidence the dated written approval and the completed parallel run that an ' +
      'autonomy raise requires',
    value_type: 'json',
    requirement: 'conditional',
    requirement_condition: 'the row is above Observe',
    scopable_by: ['process', 'entity'],
    who_defines: 'Accountable owner',
    approval_needed: 'CFO',
    consumed_by: ['autonomy computation'],
    owner_role_ref: 'AS-PPL-005',
    enrolment_stage: 7,
  }),
  f({
    field_id: 'AS-SCP-013',
    family: 'AS-SCP',
    label: 'Limit re-check at execution time (platform constant)',
    purpose:
      'require every limit to be re-evaluated at execution, not only at planning. A limit ' +
      'checked once at plan time is a limit that can be exceeded',
    value_type: 'boolean',
    requirement: 'mandatory',
    who_defines: 'Platform',
    consumed_by: ['C7 workflow executor'],
    owner_role_ref: 'Platform',
    enrolment_stage: 7,
  }),
  f({
    field_id: 'AS-SCP-014',
    family: 'AS-SCP',
    label: 'Agent may not change its own scope (platform constant)',
    purpose:
      'forbid the worker generating, editing, approving or publishing its own Scope Card, ' +
      'autonomy, supervisor, thresholds or review basis',
    value_type: 'boolean',
    requirement: 'mandatory',
    who_defines: 'Platform',
    consumed_by: ['C6 policy engine', 'scope card generator'],
    owner_role_ref: 'Platform',
    enrolment_stage: 7,
  }),
  f({
    field_id: 'AS-SCP-015',
    family: 'AS-SCP',
    label: 'In-scope SOP rows',
    purpose:
      'switch on each SOP the worker may attempt. Anything not listed is not attempted, ' +
      'and a request for it is routed out of scope',
    value_type: 'list',
    requirement: 'mandatory',
    scopable_by: ['entity'],
    who_defines: 'Accountable owner',
    approval_needed: 'CFO',
    consumed_by: ['C4 intake', 'C5 planner'],
    owner_role_ref: 'AS-PPL-005',
    enrolment_stage: 7,
  }),
  f({
    field_id: 'AS-SCP-020',
    family: 'AS-SCP',
    label: 'Autonomy level per SOP row',
    purpose:
      'set Observe, Draft-for-review or Execute per SOP row. Default on enrolment is ' +
      'Observe for every row',
    value_type: 'enum',
    enum_values: ['observe', 'draft', 'execute'],
    requirement: 'mandatory',
    scopable_by: ['process', 'entity'],
    who_defines: 'Accountable owner',
    approval_needed: 'CFO',
    consumed_by: ['autonomy computation', 'C5 planner'],
    owner_role_ref: 'AS-PPL-005',
    enrolment_stage: 7,
  }),
  f({
    field_id: 'AS-SCP-025',
    family: 'AS-SCP',
    label: 'Post-hoc sample rate for Execute rows',
    purpose:
      'set the rate at which a human samples completed Execute work. A zero sample rate ' +
      'is invalid',
    value_type: 'decimal',
    requirement: 'conditional',
    requirement_condition: 'the row is at Execute',
    scopable_by: ['process', 'entity'],
    who_defines: 'Accountable owner',
    consumed_by: ['L8 sampling'],
    owner_role_ref: 'AS-PPL-005',
    enrolment_stage: 7,
  }),
  f({
    field_id: 'AS-SCP-026',
    family: 'AS-SCP',
    label: 'Scope-expanding instructions are refused (platform constant)',
    purpose:
      'forbid honouring a human instruction that expands scope, and require it be logged ' +
      'as an out-of-scope request',
    value_type: 'boolean',
    requirement: 'mandatory',
    who_defines: 'Platform',
    consumed_by: ['C4 intake', 'C6 policy engine'],
    owner_role_ref: 'Platform',
    enrolment_stage: 7,
  }),
  f({
    field_id: 'AS-SCP-030',
    family: 'AS-SCP',
    label: 'Accuracy floor per skill',
    purpose:
      'set the measured accuracy below which a skill is pulled back one autonomy level. ' +
      'The platform supplies the metric and the window; the number is yours',
    value_type: 'decimal',
    requirement: 'conditional',
    requirement_condition: 'the row is above Observe',
    scopable_by: ['process', 'entity'],
    who_defines: 'Accountable owner',
    consumed_by: ['L8 accuracy floors'],
    owner_role_ref: 'AS-PPL-005',
    enrolment_stage: 7,
  }),
  f({
    field_id: 'AS-SCP-035',
    family: 'AS-SCP',
    label: 'Answer confidence floor',
    purpose: 'set the confidence below which the worker hands off rather than answering',
    value_type: 'decimal',
    requirement: 'mandatory',
    scopable_by: ['process'],
    who_defines: 'Accountable owner',
    consumed_by: ['L8 gates', 'C8 skill runtime'],
    owner_role_ref: 'AS-PPL-005',
    enrolment_stage: 7,
  }),
];

// ---------------------------------------------------------------------------
// Stage 8 — AS-PPL: people, notification, escalation, lifecycle.
// ---------------------------------------------------------------------------

const PPL: readonly CatalogueField[] = [
  f({
    field_id: 'AS-PPL-001',
    family: 'AS-PPL',
    label: 'People register',
    purpose:
      'resolve every role reference to a named, currently-active individual. An ' +
      'unresolvable reference collapses the affected row to Observe',
    value_type: 'list',
    requirement: 'mandatory',
    who_defines: 'Accountable owner',
    approval_needed: 'CFO + engagement partner',
    consumed_by: ['every approval route', 'escalation', 'scope card'],
    owner_role_ref: 'AS-PPL-005',
    enrolment_stage: 8,
  }),
  f({
    field_id: 'AS-PPL-010',
    family: 'AS-PPL',
    label: 'Accountable human per output class',
    purpose:
      'name who carries accountability for each output class. Absence blocks that class ' +
      'from being delivered at all',
    value_type: 'json',
    requirement: 'mandatory',
    scopable_by: ['entity'],
    who_defines: 'Accountable owner',
    approval_needed: 'CFO',
    consumed_by: ['L9 authorisation', 'C5 planner admission'],
    owner_role_ref: 'AS-PPL-005',
    enrolment_stage: 8,
  }),
  f({
    field_id: 'AS-PPL-020',
    family: 'AS-PPL',
    label: 'Manager of record',
    purpose: 'name the single human who owns the worker as a worker',
    value_type: 'reference',
    requirement: 'mandatory',
    who_defines: 'CFO',
    consumed_by: ['scope card', 'governance pack'],
    owner_role_ref: 'AS-PPL-004',
    enrolment_stage: 8,
  }),
  f({
    field_id: 'AS-PPL-047',
    family: 'AS-PPL',
    label: 'Payroll data entitlement',
    purpose: 'name who may see individual payroll data, which is Restricted by default',
    value_type: 'list',
    requirement: 'conditional',
    requirement_condition: 'payroll is in scope',
    who_defines: 'Accountable owner',
    consumed_by: ['C14 delivery service', 'entitlement check'],
    owner_role_ref: 'AS-PPL-005',
    enrolment_stage: 8,
  }),
  f({
    field_id: 'AS-PPL-060',
    family: 'AS-PPL',
    label: 'Registered notification classes',
    purpose:
      'enumerate the classes of message the worker may send internally. An unregistered ' +
      'class is dropped and logged',
    value_type: 'list',
    requirement: 'mandatory',
    scopable_by: ['channel'],
    who_defines: 'Accountable owner',
    consumed_by: ['C14 delivery service'],
    owner_role_ref: 'AS-PPL-005',
    enrolment_stage: 8,
  }),
  f({
    field_id: 'AS-PPL-070',
    family: 'AS-PPL',
    label: 'Conversation idle timeout',
    purpose:
      'set how long a conversation stays open before it closes and its working memory is ' +
      'destroyed',
    value_type: 'string',
    requirement: 'mandatory',
    who_defines: 'Accountable owner',
    consumed_by: ['conversation state machine'],
    owner_role_ref: 'AS-PPL-005',
    enrolment_stage: 8,
  }),
  f({
    field_id: 'AS-PPL-097',
    family: 'AS-PPL',
    label: 'Per-channel sensitivity ceiling override',
    purpose: 'lower (never raise) the sensitivity a channel may carry for this tenant',
    value_type: 'json',
    requirement: 'optional',
    scopable_by: ['channel'],
    who_defines: 'Accountable owner',
    consumed_by: ['C14 delivery service'],
    owner_role_ref: 'AS-PPL-005',
    enrolment_stage: 8,
  }),
  f({
    field_id: 'AS-PPL-130',
    family: 'AS-PPL',
    label: 'Incident re-grading authority',
    purpose:
      'name who may re-grade an incident severity. Downward re-grading requires the ' +
      'accountable owner',
    value_type: 'reference',
    requirement: 'mandatory',
    who_defines: 'Accountable owner',
    consumed_by: ['incident procedure'],
    owner_role_ref: 'AS-PPL-005',
    enrolment_stage: 8,
  }),
  f({
    field_id: 'AS-PPL-ESC-001',
    family: 'AS-PPL',
    label: 'Escalation ladder',
    purpose:
      'name who receives a hand-off that has breached its SLA, and who receives it after ' + 'that',
    value_type: 'json',
    requirement: 'mandatory',
    scopable_by: ['process'],
    who_defines: 'Accountable owner',
    consumed_by: ['hand-off escalation'],
    owner_role_ref: 'AS-PPL-005',
    enrolment_stage: 8,
  }),
];

// ---------------------------------------------------------------------------
// Stages 3 and 5 — AS-COA and AS-REG, the fields the runtime reads.
// ---------------------------------------------------------------------------

const COA: readonly CatalogueField[] = [
  f({
    field_id: 'AS-COA-001',
    family: 'AS-COA',
    label: 'Chart of accounts',
    purpose: 'resolve an account code the worker proposes to a real account in the ledger',
    value_type: 'json',
    requirement: 'mandatory',
    scopable_by: ['entity'],
    who_defines: 'Financial controller',
    consumed_by: ['PP/01', 'PP/02', 'PP/03'],
    owner_role_ref: 'AS-PPL-002',
    enrolment_stage: 3,
  }),
  f({
    field_id: 'AS-COA-100',
    family: 'AS-COA',
    label: 'Tax code mapping',
    purpose: 'map a tax treatment to the ledger tax code that carries it',
    value_type: 'json',
    requirement: 'conditional',
    requirement_condition: 'tax is in scope',
    scopable_by: ['entity'],
    who_defines: 'Financial controller',
    consumed_by: ['PP/05 tax compliance'],
    owner_role_ref: 'AS-PPL-002',
    enrolment_stage: 3,
  }),
  f({
    field_id: 'AS-COA-200',
    family: 'AS-COA',
    label: 'Period lock status source',
    purpose:
      'tell the worker where to read whether a period is open, so it never posts into a ' +
      'closed period',
    value_type: 'string',
    requirement: 'mandatory',
    scopable_by: ['entity'],
    who_defines: 'Financial controller',
    consumed_by: ['L0 context resolver', 'C6 policy engine'],
    owner_role_ref: 'AS-PPL-002',
    enrolment_stage: 3,
  }),
];

const REG: readonly CatalogueField[] = [
  f({
    field_id: 'AS-REG-001',
    family: 'AS-REG',
    label: 'Statutory registrations',
    purpose: 'record which tax and statutory registrations the entity holds',
    value_type: 'json',
    requirement: 'mandatory',
    scopable_by: ['entity'],
    who_defines: 'Tax and payroll leads',
    approval_needed: 'CFO',
    consumed_by: ['PP/05', 'PP/04'],
    owner_role_ref: 'AS-PPL-006 (tax lead)',
    enrolment_stage: 5,
    requires_reverification: true,
  }),
  f({
    field_id: 'AS-REG-050',
    family: 'AS-REG',
    label: 'Filing calendar',
    purpose: 'derive statutory deadlines so a schedule trigger fires against the real date',
    value_type: 'json',
    requirement: 'mandatory',
    scopable_by: ['entity'],
    who_defines: 'Tax and payroll leads',
    consumed_by: ['schedule triggers', 'PP/05'],
    owner_role_ref: 'AS-PPL-006',
    enrolment_stage: 5,
    requires_reverification: true,
  }),
  f({
    field_id: 'AS-REG-100',
    family: 'AS-REG',
    label: 'Statutory rate verification horizon (days)',
    purpose:
      'set how long a statutory rate stays trusted before the worker must halt and ' +
      'escalate rather than use it',
    value_type: 'integer',
    requirement: 'mandatory',
    who_defines: 'Tax and payroll leads',
    consumed_by: ['C11 knowledge service', 'immutable rule 10'],
    owner_role_ref: 'AS-PPL-006',
    enrolment_stage: 5,
    requires_reverification: true,
  }),
];

export const SETTINGS_CATALOGUE: readonly CatalogueField[] = [
  ...ORG,
  ...SYS,
  ...COA,
  ...DOA,
  ...REG,
  ...RUL,
  ...SCP,
  ...PPL,
];

/** Fields Phase 0 requires complete before anything runs (file 08 s.3.2). */
export const PHASE_0_MANDATORY: readonly string[] = [
  'AS-ORG-001',
  'AS-ORG-002',
  'AS-ORG-003',
  'AS-ORG-004',
  'AS-ORG-005',
  'AS-ORG-121',
  'AS-ORG-130',
  'AS-SYS-083',
  'AS-SYS-084',
  'AS-SYS-090',
  'AS-SYS-095',
  'AS-SCP-002',
  'AS-SCP-013',
  'AS-SCP-014',
  'AS-SCP-026',
  'AS-DOA-001',
  'AS-DOA-002',
];

/**
 * The platform constants. These encode the immutable rules; a client entry for
 * them is recorded for register completeness, but the policy engine reads the
 * rule from code, not from configuration. Nothing a tenant writes can switch
 * one off.
 */
export const PLATFORM_CONSTANTS: readonly string[] = [
  'AS-DOA-001',
  'AS-DOA-002',
  'AS-SCP-002',
  'AS-SCP-013',
  'AS-SCP-014',
  'AS-SCP-026',
];

export const isPlatformConstant = (fieldId: string): boolean =>
  PLATFORM_CONSTANTS.includes(fieldId);
