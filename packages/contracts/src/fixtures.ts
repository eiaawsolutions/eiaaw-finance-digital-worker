/**
 * Canonical example instances — one per contract.
 *
 * These are transcribed from the example instances in DWD-06 s.3, adjusted only
 * where the spec's illustrative snippet elides a required field. They serve
 * three purposes:
 *
 *   1. the contract test asserts every one validates, so the schemas and the
 *      spec cannot silently diverge;
 *   2. downstream packages use them as test seeds rather than each inventing
 *      their own, which keeps fixtures consistent across the monorepo;
 *   3. the assurance harness uses them to exercise the audit event taxonomy
 *      end to end (Phase 0 acceptance P0-1).
 *
 * DWD-06 s.2.4 (rail): every value here is illustrative shape, never a source
 * of values. Nothing in this file may be read by production code.
 */
import type {
  AuditEvent,
  Conversation,
  DecisionRecord,
  EvidenceBundle,
  FeedbackEvent,
  HandoffPackage,
  InboundRequest,
  Message,
  OutboundDelivery,
  PolicyVerdict,
  ResolvedContext,
  ReviewerAction,
  SkillInvocation,
  TaskGraph,
  TaskNode,
  ToolCall,
} from './types.js';

const V = '1.0.0';
const UUID = '0192f3c1-7a10-7c31-9b6a-1f0d2c4b5e60';
const UUID2 = '0192f3c1-7a10-7c31-9b6a-1f0d2c4b5e61';
const TRACE = '4bf92f3577b34da6a3ce929d0e0e4736';
const SPAN = '00f067aa0ba902b7';
const HASH = `sha256:${'a'.repeat(64)}`;
const HASH2 = `sha256:${'b'.repeat(64)}`;
const KEY = 'b1c9'.padEnd(64, '0');
const TENANT = 'tnt_acme';

export const inboundRequestFixture: InboundRequest = {
  schema_version: V,
  request_id: UUID,
  tenant_id: TENANT,
  trace_id: TRACE,
  channel: 'email',
  transport_message_id: '<CADq...@mail.example>',
  conversation_key: `cnv_${UUID}`,
  received_at: '2026-08-29T02:14:11+00:00',
  transport_sent_at: '2026-08-29T02:14:09+08:00',
  principal: {
    principal_id: 'usr_00417',
    resolution: 'bound',
    confidence: 'high',
    binding_id: `bnd_${UUID}`,
    claimed_identity: 'azlan@client.example',
  },
  body_text: 'Please prepare the SST return working for July.',
  body_raw_ref: 'obj://raw/2026/08/29/0192f3c1.eml',
  attachments: [
    {
      attachment_id: `att_${UUID}`,
      filename: 'statement.pdf',
      media_type: 'application/pdf',
      size_bytes: 481233,
      content_hash: HASH,
      storage_ref: `obj://inbound/att_${UUID}`,
      scan_verdict: 'clean',
      extraction_status: 'pending',
    },
  ],
  intent_hint: { source: 'callback', value: `approve:hnd_${UUID}` },
  reply_context: { in_reply_to: '<CADp...@mail.example>', references: ['<CADo...>'] },
  locale_hint: 'en-MY',
  security_flags: {
    dmarc: 'pass',
    spf: 'pass',
    dkim: 'pass',
    sender_external: false,
    allow_list: 'member',
    loop_indicator: false,
    replay_suspected: false,
  },
  admission: { decision: 'admitted', reason_code: null },
};

export const resolvedContextFixture: ResolvedContext = {
  schema_version: V,
  context_id: `ctx_${UUID}`,
  request_id: UUID,
  tenant_id: TENANT,
  resolution_status: 'resolved',
  resolution_reason: null,
  axes: {
    jurisdiction: { value: 'MY', source: 'AS-ORG-*', coverage_tier: 'full' },
    reporting_framework: { value: 'MFRS', source: 'AS-ORG-FRM-*', coverage_tier: 'full' },
    legal_entity: { value: 'ENT-0007', source: 'AS-ORG-*', coverage_tier: 'full' },
    currency: { value: 'MYR', source: 'AS-ORG-*', coverage_tier: 'full' },
    as_of_date: { value: '2026-07-31', source: 'request', coverage_tier: 'full' },
  },
  pack: { pack_id: 'pack-my-mfrs', pack_version: '2026.07.1' },
  residency_zone: 'my-central',
  resolved_locale: 'en-MY',
  fiscal_period: {
    period_id: 'FY2026-P07',
    start_date: '2026-07-01',
    end_date: '2026-07-31',
    status: 'open',
  },
  knowledge_pin: {
    pinned_at: '2026-08-29T02:14:12+00:00',
    modules: [
      { module_id: 'PP/05', version: '3.2.0', effective_from: '2026-01-01', effective_to: null },
    ],
  },
  resolved_at: '2026-08-29T02:14:12+00:00',
  expires_at: '2026-08-29T06:14:12+00:00',
};

export const conversationFixture: Conversation = {
  schema_version: V,
  conversation_key: `cnv_${UUID}`,
  tenant_id: TENANT,
  principal_id: 'usr_00417',
  channels_seen: ['email', 'chat'],
  primary_channel: 'chat',
  state: 'active',
  opened_at: '2026-08-29T02:14:11+00:00',
  last_activity_at: '2026-08-29T02:31:40+00:00',
  closes_at: '2026-09-05T02:31:40+00:00',
  context_ref: `ctx_${UUID}`,
  working_memory_ref: `wm_${UUID}`,
  preference_snapshot: { locale: 'en-MY', verbosity: 'standard' },
  sensitivity_ceiling: 'confidential',
  handoff_open: false,
};

export const messageFixture: Message = {
  schema_version: V,
  message_id: `msg_${UUID}`,
  conversation_key: `cnv_${UUID}`,
  tenant_id: TENANT,
  direction: 'inbound',
  channel: 'chat',
  transport_message_id: 'cm_88213',
  author: { kind: 'human', principal_id: 'usr_00417' },
  sent_at: '2026-08-29T02:14:09+00:00',
  content_text: 'Please prepare the SST return working for July.',
  content_blocks: [{ kind: 'text', text: 'Please prepare the SST return working for July.' }],
  attachment_ids: [`att_${UUID}`],
  trust_class: 'untrusted_content',
  related_request_id: UUID,
  related_delivery_id: null,
  redaction_state: 'none',
};

export const taskGraphFixture: TaskGraph = {
  schema_version: V,
  graph_id: `tg_${UUID}`,
  tenant_id: TENANT,
  request_id: UUID,
  context_ref: `ctx_${UUID}`,
  trigger_class: 'request',
  intent: 'prepare_sst_return_working',
  root_skill_id: 'SK-TAX-07',
  skill_version: '1.4.0',
  effective_autonomy: 'draft',
  autonomy_basis: {
    platform_ceiling: 'draft',
    as_scp_grant: 'draft',
    supervisor_ref: 'AS-SCP-008',
    supervisor_active: true,
  },
  nodes: [{ node_id: 'n1' }, { node_id: 'n7' }],
  edges: [{ from: 'n1', to: 'n7', kind: 'sequence' }],
  sequence_ranks: { n1: 10, n7: 90 },
  admission: {
    checks_passed: [
      'owner',
      'autonomy',
      'accountable_human',
      'immutable_rules',
      'grounding_effective_date',
      'budget',
      'latency',
    ],
    decision: 'admitted',
  },
  budget: {
    token_ceiling: 400000,
    cost_ceiling: { amount_minor: 1500, currency: 'MYR', scale: 2 },
    source: 'AS-SYS-BGT-*',
  },
  state: 'running',
  created_at: '2026-08-29T02:14:13+00:00',
  completed_at: null,
  workflow_run_id: `wf_${UUID}`,
};

export const taskNodeFixture: TaskNode = {
  schema_version: V,
  node_id: 'n4',
  graph_id: `tg_${UUID}`,
  kind: 'tool_call',
  label: 'Post AP invoice INV-7741',
  owner: { kind: 'tool', ref: 'TL-ERPW-03' },
  sop_step_ref: 'PP/01 s.5 step 5.3',
  depends_on: ['n3'],
  sequence_rank: 40,
  state: 'completed',
  state_changing: true,
  irreversible: false,
  idempotency_key: KEY,
  compensation: { tool_id: 'TL-ERPW-12', invoked: false, compensation_key: null },
  dry_run: false,
  attempt: 1,
  max_attempts: 3,
  started_at: '2026-08-29T02:15:02+00:00',
  ended_at: '2026-08-29T02:15:04+00:00',
  confidence: '0.94',
  cost: { amount_minor: 3, currency: 'MYR', scale: 2 },
  failure: null,
};

export const policyVerdictFixture: PolicyVerdict = {
  schema_version: V,
  verdict_id: `pv_${UUID}`,
  graph_id: `tg_${UUID}`,
  node_id: 'n3',
  rule_id: 'RUL-P2P-TOL-01',
  rule_version: '2.0.0',
  context_selector: { jurisdiction: 'MY', entity: 'ENT-0007', process: 'P2P' },
  condition_evaluated: 'abs(invoice_total - po_total) <= AS-RUL-* price tolerance',
  inputs_hash: HASH,
  verdict: 'allow',
  threshold_values: [
    {
      setting_id: 'AS-RUL-*',
      value_ref: 'resolved at 2026-08-29T02:15:00Z',
      value_hash: HASH2,
    },
  ],
  precedence_rank: 20,
  effective_from: '2026-01-01',
  effective_to: null,
  owner: 'AS-PPL-* (control owner for P2P tolerances)',
  immutable_rules_evaluated: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  immutable_rule_engaged: null,
  decided_at: '2026-08-29T02:15:00+00:00',
};

export const skillInvocationFixture: SkillInvocation = {
  schema_version: V,
  invocation_id: `si_${UUID}`,
  graph_id: `tg_${UUID}`,
  node_id: 'n5',
  skill_id: 'SK-TAX-07',
  skill_version: '1.4.0',
  mode: 'draft',
  context_ref: `ctx_${UUID}`,
  inputs_ref: `obj://inputs/si_${UUID}`,
  inputs_hash: HASH,
  knowledge_used: [
    {
      module_id: 'PP/05',
      chunk_id: 'ck_9912',
      version: '3.2.0',
      effective_from: '2026-01-01',
      effective_to: null,
      citation_locator: 's.5.4',
      licence_class: 'internal',
    },
  ],
  records_used: [
    {
      source_system_id: 'erp_prod',
      record_type: 'sst_output_line',
      entity_id: 'ENT-0007',
      period: '2026-07',
      content_hash: HASH2,
      connector_version: '2.7.1',
      extracted_at: '2026-08-29T02:14:40+00:00',
    },
  ],
  tool_call_ids: [`tc_${UUID}`],
  model_route: { route_id: 'rt-tax-draft', model: 'client-entered', fallback_used: false },
  output_ref: `obj://outputs/si_${UUID}`,
  output_hash: HASH2,
  citations: [
    { claim_ref: 'c1', chunk_id: 'ck_9912', version: '3.2.0', effective_from: '2026-01-01' },
  ],
  confidence: '0.91',
  quality_criteria_results: [{ criterion: 'box totals agree to subledger', result: 'pass' }],
  tokens: { input: 18442, output: 3120 },
  cost: { amount_minor: 41, currency: 'MYR', scale: 2 },
  duration_ms: 8412,
  status: 'succeeded',
};

export const toolCallFixture: ToolCall = {
  schema_version: V,
  tool_call_id: `tc_${UUID}`,
  graph_id: `tg_${UUID}`,
  node_id: 'n4',
  invocation_id: `si_${UUID}`,
  tool_id: 'TL-ERPW-03',
  capability_schema_version: '1.3.0',
  permission_scope_requested: 'ap:post',
  permission_scope_granted: 'ap:post',
  scope_qualifiers: {
    entity_id: 'ENT-0007',
    period: '2026-07',
    max_absolute_value: { amount_minor: 5000000, currency: 'MYR', scale: 2 },
  },
  authority_ref: { autonomy: 'execute', policy_verdict_id: `pv_${UUID}`, approval_ref: null },
  state_changing: true,
  dry_run: false,
  idempotency_key: KEY,
  request_hash: HASH,
  attempt: 1,
  started_at: '2026-08-29T02:15:02+00:00',
  ended_at: '2026-08-29T02:15:04+00:00',
  outcome: 'success',
  provider_reference: 'ERP-DOC-99001234',
  business_key: 'INV-7741',
  rate_limit_remaining: 412,
  cost: { amount_minor: 3, currency: 'MYR', scale: 2 },
  error: null,
  compensated_by: null,
};

export const evidenceBundleFixture: EvidenceBundle = {
  schema_version: V,
  bundle_id: `eb_${UUID}`,
  tenant_id: TENANT,
  graph_id: `tg_${UUID}`,
  output_class: 'tax_computation_and_return_working',
  bundle_version: 2,
  proposed_output: {
    artifact_ref: 'obj://outputs/sst-2026-07.xlsx',
    content_hash: HASH,
    render_ref: 'obj://outputs/sst-2026-07.html',
  },
  trace: [{ node_id: 'n1', kind: 'grounding', summary: 'Pinned PP/05 v3.2.0' }],
  citations: [
    {
      chunk_id: 'ck_9912',
      module_id: 'PP/05',
      version: '3.2.0',
      effective_from: '2026-01-01',
      locator: 's.5.4',
    },
  ],
  records: skillInvocationFixture.records_used,
  policy_verdicts: [`pv_${UUID}`],
  confidence_by_step: [{ node_id: 'n5', confidence: '0.91' }],
  lowest_confidence_step: 'n5',
  assurance: {
    grounding_gate: 'pass',
    arithmetic_gate: 'pass',
    consistency_gate: 'pass',
    harness_version: '4.1.0',
  },
  cost_to_date: { amount_minor: 68, currency: 'MYR', scale: 2, budget_ref: 'AS-SYS-BGT-*' },
  pack_version: '2026.07.1',
  platform_version: '1.8.3',
  assembled_at: '2026-08-29T02:16:10+00:00',
  worm_ref: `worm://eb/${UUID}`,
};

export const handoffPackageFixture: HandoffPackage = {
  schema_version: V,
  handoff_id: `hnd_${UUID}`,
  graph_id: `tg_${UUID}`,
  node_id: 'n6',
  bundle_id: `eb_${UUID}`,
  bundle_version: 2,
  question:
    'Approve this SST return working for period 07/2026, or identify the line you disagree with?',
  decision_type: 'approve_output',
  assignee: { principal_id: 'usr_00092', role_ref: 'RR/01 tax lead', source: 'AS-PPL-*' },
  dual_control_required: false,
  second_approver: null,
  sod_exclusions_applied: ['preparer_cannot_approve'],
  permitted_moves: ['approve', 'edit_and_approve', 'reject_with_reason', 'reassign'],
  channels: { delivery: ['chat', 'email'], approval: ['chat', 'email'] },
  sla: {
    due_at: '2026-08-30T09:00:00+08:00',
    source: 'AS-RUL-*',
    escalation_target: 'AS-PPL-ESC-*',
  },
  nonce: 'b7f1'.padEnd(64, '0'),
  issued_at: '2026-08-29T02:16:12+00:00',
  state: 'awaiting_action',
};

export const reviewerActionFixture: ReviewerAction = {
  schema_version: V,
  action_id: `ra_${UUID}`,
  handoff_id: `hnd_${UUID}`,
  bundle_version_acted_on: 2,
  actor: { principal_id: 'usr_00092', auth_method: 'oidc_session', channel: 'chat' },
  move: 'edit_and_approve',
  nonce_presented: 'b7f1'.padEnd(64, '0'),
  nonce_valid: true,
  reason_code: null,
  free_text: 'Line 12 reclassified to exempt.',
  diff_ref: `obj://diffs/ra_${UUID}`,
  materiality: {
    assessed: true,
    material: true,
    threshold_ref: 'AS-RUL-MAT-*',
    change_request_id: `cr_${UUID}`,
  },
  approved_output_hash: HASH2,
  acted_at: '2026-08-29T03:02:44+08:00',
  ip_or_device_ref: 'obfuscated',
  second_approver_action_id: null,
};

export const decisionRecordFixture: DecisionRecord = {
  schema_version: V,
  decision_id: `dr_${UUID}`,
  tenant_id: TENANT,
  output_class: 'tax_computation_and_return_working',
  authorisation_verdict: 'requires_human',
  named_owner: { principal_id: 'usr_00092', role_ref: 'RR/01 tax lead', source: 'AS-PPL-*' },
  evidence_bundle_ref: `worm://eb/${UUID}`,
  pack_version: '2026.07.1',
  platform_version: '1.8.3',
  skill_versions: [{ skill_id: 'SK-TAX-07', version: '1.4.0' }],
  reviewer_action_id: `ra_${UUID}`,
  reserved_act_ref: null,
  graph_id: `tg_${UUID}`,
  timestamp: '2026-08-29T03:02:45+00:00',
  worm_ref: `worm://dr/${UUID}`,
};

export const auditEventFixture: AuditEvent = {
  schema_version: V,
  event_id: `ae_${UUID}`,
  tenant_id: TENANT,
  trace_id: TRACE,
  span_id: SPAN,
  occurred_at: '2026-08-29T02:15:04.221+00:00',
  recorded_at: '2026-08-29T02:15:04.238+00:00',
  layer: 'L6',
  component: 'C10',
  event_type: 'tool_call_completed',
  actor: { kind: 'worker', skill_id: 'SK-P2P-06', principal_id: null },
  subject: { kind: 'tool_call', id: `tc_${UUID}` },
  context_ref: `ctx_${UUID}`,
  graph_id: `tg_${UUID}`,
  outcome: 'success',
  payload_hash: HASH,
  payload_ref: `obj://audit/payloads/ae_${UUID}`,
  prev_event_hash: `sha256:${'5'.repeat(64)}`,
  event_hash: `sha256:${'e'.repeat(64)}`,
};

export const outboundDeliveryFixture: OutboundDelivery = {
  schema_version: V,
  delivery_id: `od_${UUID}`,
  tenant_id: TENANT,
  conversation_key: `cnv_${UUID}`,
  graph_id: `tg_${UUID}`,
  decision_record_ref: `dr_${UUID}`,
  output_class: 'tax_computation_and_return_working',
  recipient: { principal_id: 'usr_00092', external: false },
  channel: 'email',
  locale: 'en-MY',
  sensitivity: 'confidential',
  payload: {
    body_ref: `obj://render/od_${UUID}`,
    attachments: [{ artifact_ref: 'obj://outputs/sst-2026-07.xlsx', content_hash: HASH }],
  },
  contract_elements: {
    answer: true,
    basis_and_citations: true,
    status_and_limits: true,
    exclusions: true,
    next_action_and_owner: true,
  },
  idempotency_key: '7d21'.padEnd(64, '0'),
  attempt_group: 1,
  status: 'delivered',
  status_history: [{ status: 'accepted', at: '2026-08-29T03:03:01+00:00' }],
  provider_reference: '<CADr...@mail.example>',
  failure: null,
  feedback_hook: { kind: 'reply_keyword', token: 'FB-0192' },
};

export const feedbackEventFixture: FeedbackEvent = {
  schema_version: V,
  feedback_id: `fb_${UUID}`,
  tenant_id: TENANT,
  delivery_id: `od_${UUID}`,
  graph_id: `tg_${UUID}`,
  skill_id: 'SK-TAX-07',
  skill_version: '1.4.0',
  source: 'reviewer_action',
  signal: 'material_edit',
  category: 'classification_error',
  free_text: 'Line 12 should be exempt.',
  correctness_label: 'incorrect',
  labelled_by: { principal_id: 'usr_00092', role_ref: 'RR/01 tax lead' },
  affects_accuracy_floor: true,
  created_at: '2026-08-29T03:02:46+00:00',
};

export const CONTRACT_FIXTURES = {
  InboundRequest: inboundRequestFixture,
  ResolvedContext: resolvedContextFixture,
  Conversation: conversationFixture,
  Message: messageFixture,
  TaskGraph: taskGraphFixture,
  TaskNode: taskNodeFixture,
  PolicyVerdict: policyVerdictFixture,
  SkillInvocation: skillInvocationFixture,
  ToolCall: toolCallFixture,
  EvidenceBundle: evidenceBundleFixture,
  HandoffPackage: handoffPackageFixture,
  ReviewerAction: reviewerActionFixture,
  DecisionRecord: decisionRecordFixture,
  AuditEvent: auditEventFixture,
  OutboundDelivery: outboundDeliveryFixture,
  FeedbackEvent: feedbackEventFixture,
} as const;

/** UUID2 is exported so downstream tests can build a second, distinct instance. */
export const FIXTURE_IDS = { UUID, UUID2, TRACE, SPAN, HASH, HASH2, KEY, TENANT } as const;
