/**
 * The closed enumerations.
 *
 * DWD-06 s.2.3: "Enumerations are closed. A new value is MINOR only if consumers
 * are specified to treat unknown values as `unknown` and refuse; otherwise
 * MAJOR." Every enumeration in this file is therefore exhaustive, and the
 * validator refuses an unknown member rather than passing it through.
 *
 * Where an enumeration exists to make an illegal state unrepresentable, that is
 * noted — those are the ones a future contributor will be tempted to widen.
 */

export const CHANNELS = ['email', 'chat', 'telegram', 'whatsapp'] as const;
export type ChannelName = (typeof CHANNELS)[number];

export const PRINCIPAL_RESOLUTIONS = ['bound', 'unbound', 'unresolved'] as const;
export type PrincipalResolution = (typeof PRINCIPAL_RESOLUTIONS)[number];

export const CONFIDENCE_BANDS = ['high', 'medium', 'low'] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

export const ADMISSION_DECISIONS = ['admitted', 'rejected'] as const;
export type AdmissionDecision = (typeof ADMISSION_DECISIONS)[number];

export const SCAN_VERDICTS = ['pending', 'clean', 'infected', 'unscannable'] as const;
export type ScanVerdict = (typeof SCAN_VERDICTS)[number];

export const EXTRACTION_STATUSES = ['pending', 'extracted', 'failed', 'skipped'] as const;
export type ExtractionStatus = (typeof EXTRACTION_STATUSES)[number];

// --- L0 -------------------------------------------------------------------
export const RESOLUTION_STATUSES = ['resolved', 'partial', 'refused'] as const;
export type ResolutionStatus = (typeof RESOLUTION_STATUSES)[number];

export const COVERAGE_TIERS = ['full', 'partial', 'none'] as const;
export type CoverageTier = (typeof COVERAGE_TIERS)[number];

/** The five axes the L0 minimum artefact schema requires. None is optional. */
export const CONTEXT_AXES = [
  'jurisdiction',
  'reporting_framework',
  'legal_entity',
  'currency',
  'as_of_date',
] as const;
export type ContextAxis = (typeof CONTEXT_AXES)[number];

export const FISCAL_PERIOD_STATUSES = ['open', 'closing', 'closed', 'locked'] as const;
export type FiscalPeriodStatus = (typeof FISCAL_PERIOD_STATUSES)[number];

// --- Conversation ---------------------------------------------------------
export const CONVERSATION_STATES = [
  'active',
  'awaiting_human',
  'escalated',
  'closed',
  'terminated',
  'suspended',
  'purged',
] as const;
export type ConversationState = (typeof CONVERSATION_STATES)[number];

export const MESSAGE_DIRECTIONS = ['inbound', 'outbound'] as const;
export type MessageDirection = (typeof MESSAGE_DIRECTIONS)[number];

export const AUTHOR_KINDS = ['human', 'worker', 'system'] as const;
export type AuthorKind = (typeof AUTHOR_KINDS)[number];

/**
 * DWD-06 s.3.4, s.11.2. The content/instruction boundary is structural.
 * Inbound content is ALWAYS `untrusted_content` — there is deliberately no
 * value that would let a message promote itself to an instruction.
 */
export const TRUST_CLASSES = ['untrusted_content', 'reference_data', 'system_instruction'] as const;
export type TrustClass = (typeof TRUST_CLASSES)[number];

export const REDACTION_STATES = ['none', 'partial', 'full'] as const;
export type RedactionState = (typeof REDACTION_STATES)[number];

// --- L5 orchestration -----------------------------------------------------
export const TRIGGER_CLASSES = ['request', 'schedule', 'event', 'watch'] as const;
export type TriggerClass = (typeof TRIGGER_CLASSES)[number];

/** Three levels, set per SOP, never per module (admin-settings 00-INDEX s.4). */
export const AUTONOMY_LEVELS = ['observe', 'draft', 'execute'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];

export const AUTONOMY_RANK: Readonly<Record<AutonomyLevel, number>> = {
  observe: 0,
  draft: 1,
  execute: 2,
};

export const GRAPH_STATES = [
  'compiled',
  'admitted',
  'refused',
  'running',
  'retrying',
  'awaiting_approval',
  'escalated',
  'halted',
  'compensating',
  'compensated',
  'authorising',
  'delivering',
  'completed',
  'cancelled',
  'failed',
  'manual_intervention',
  'suspended',
] as const;
export type GraphState = (typeof GRAPH_STATES)[number];

/** DWD-06 s.7.2. Terminal means terminal; a new attempt is a new graph. */
export const TERMINAL_GRAPH_STATES: readonly GraphState[] = [
  'refused',
  'halted',
  'cancelled',
  'completed',
  'failed',
  'compensated',
  'manual_intervention',
];

export const NODE_KINDS = [
  'grounding',
  'skill',
  'gate',
  'tool_call',
  'handoff',
  'assurance',
  'authorisation',
  'delivery',
  'compensation',
] as const;
export type NodeKind = (typeof NODE_KINDS)[number];

export const NODE_STATES = [
  'pending',
  'ready',
  'running',
  'retrying',
  'completed',
  'failed',
  'skipped',
  'compensated',
  'refused',
] as const;
export type NodeState = (typeof NODE_STATES)[number];

export const NODE_OWNER_KINDS = ['skill', 'tool', 'human', 'platform'] as const;
export type NodeOwnerKind = (typeof NODE_OWNER_KINDS)[number];

/** DWD-06 s.3.5. A graph is never admitted "with a warning". */
export const ADMISSION_CHECKS = [
  'owner',
  'autonomy',
  'accountable_human',
  'immutable_rules',
  'grounding_effective_date',
  'budget',
  'latency',
] as const;
export type AdmissionCheck = (typeof ADMISSION_CHECKS)[number];

// --- L5/L9 policy ---------------------------------------------------------
export const POLICY_VERDICTS = ['allow', 'dual_control', 'escalate', 'refuse'] as const;
export type PolicyVerdictValue = (typeof POLICY_VERDICTS)[number];

/** file 01 s.6.2 — the eleven. Not configurable by anyone, including a tenant. */
export const IMMUTABLE_RULES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] as const;
export type ImmutableRuleNumber = (typeof IMMUTABLE_RULES)[number];

// --- L4 skills ------------------------------------------------------------
export const SKILL_MODES = ['analyse', 'draft', 'execute'] as const;
export type SkillMode = (typeof SKILL_MODES)[number];

export const INVOCATION_STATUSES = ['succeeded', 'refused', 'failed', 'halted'] as const;
export type InvocationStatus = (typeof INVOCATION_STATUSES)[number];

export const SKILL_STATUSES = ['draft', 'active', 'restricted', 'suspended', 'retired'] as const;
export type SkillStatus = (typeof SKILL_STATUSES)[number];

/** Only `active` and `restricted` are invocable (file 05 s.2.2). */
export const INVOCABLE_SKILL_STATUSES: readonly SkillStatus[] = ['active', 'restricted'];

export const QUALITY_CRITERION_RESULTS = ['pass', 'fail', 'not_applicable'] as const;
export type QualityCriterionResult = (typeof QUALITY_CRITERION_RESULTS)[number];

// --- L6 tools -------------------------------------------------------------
export const TOOL_OUTCOMES = ['success', 'failure', 'refused', 'dry_run'] as const;
export type ToolOutcome = (typeof TOOL_OUTCOMES)[number];

/** file 05 s.11.2 — a connector graduates per tool, not per system. */
export const GRADUATION_STAGES = [1, 2, 3, 4] as const;
export type GraduationStage = (typeof GRADUATION_STAGES)[number];

// --- L8 assurance ---------------------------------------------------------
export const GATE_RESULTS = ['pass', 'fail', 'not_applicable'] as const;
export type GateResult = (typeof GATE_RESULTS)[number];

export const ASSURANCE_GATES = ['grounding_gate', 'arithmetic_gate', 'consistency_gate'] as const;
export type AssuranceGate = (typeof ASSURANCE_GATES)[number];

// --- L9 authorisation -----------------------------------------------------
export const AUTHORISATION_VERDICTS = ['may_issue', 'requires_human'] as const;
export type AuthorisationVerdict = (typeof AUTHORISATION_VERDICTS)[number];

/**
 * DWD-06 s.3.11, file 04 s.6.3. Exactly four moves.
 * `approve_with_comment` is deliberately not representable — a comment that
 * changes the output is an edit, and one that does not is not a decision.
 */
export const REVIEWER_MOVES = [
  'approve',
  'edit_and_approve',
  'reject_with_reason',
  'reassign',
] as const;
export type ReviewerMove = (typeof REVIEWER_MOVES)[number];

export const DECISION_TYPES = [
  'approve_output',
  'authorise_action',
  'resolve_exception',
  'confirm_classification',
] as const;
export type DecisionType = (typeof DECISION_TYPES)[number];

export const HANDOFF_STATES = [
  'awaiting_action',
  'awaiting_second_approver',
  'actioned',
  'escalated',
  'expired',
  'withdrawn',
] as const;
export type HandoffState = (typeof HANDOFF_STATES)[number];

/** file 01 s.9.3 — the closed list feeding rejection analysis and drift monitors. */
export const REJECTION_REASON_CODES = [
  'incorrect_classification',
  'incorrect_calculation',
  'incorrect_period',
  'incorrect_entity',
  'missing_supporting_evidence',
  'stale_or_wrong_authority',
  'policy_or_threshold_misapplied',
  'out_of_scope_for_this_item',
  'presentation_or_format',
  'superseded_by_events',
  'other_with_free_text',
] as const;
export type RejectionReasonCode = (typeof REJECTION_REASON_CODES)[number];

// --- L7 delivery ----------------------------------------------------------
export const DELIVERY_STATUSES = [
  'queued',
  'accepted',
  'delivered',
  'read',
  'failed',
  'expired',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** DWD-06 s.4.2 — the seven adapter error classes. */
export const ADAPTER_ERROR_CLASSES = [
  'transport_transient',
  'transport_permanent',
  'capability_refusal',
  'auth',
  'rate_limited',
  'policy_blocked',
  'provider_contract',
] as const;
export type AdapterErrorClass = (typeof ADAPTER_ERROR_CLASSES)[number];

export const RETRYABLE_ADAPTER_ERRORS: readonly AdapterErrorClass[] = [
  'transport_transient',
  'rate_limited',
];

export const FEEDBACK_HOOK_KINDS = [
  'reply_keyword',
  'inline_control',
  'callback_query',
  'none',
] as const;
export type FeedbackHookKind = (typeof FEEDBACK_HOOK_KINDS)[number];

// --- L8 feedback ----------------------------------------------------------
export const FEEDBACK_SOURCES = [
  'reviewer_action',
  'explicit_rating',
  'downstream_correction',
  'audit_finding',
  'sampling',
] as const;
export type FeedbackSource = (typeof FEEDBACK_SOURCES)[number];

export const FEEDBACK_SIGNALS = [
  'accepted',
  'material_edit',
  'immaterial_edit',
  'rejected',
  'reassigned',
  'late',
  'error_found',
] as const;
export type FeedbackSignal = (typeof FEEDBACK_SIGNALS)[number];

export const CORRECTNESS_LABELS = ['correct', 'incorrect', 'partially_correct'] as const;
export type CorrectnessLabel = (typeof CORRECTNESS_LABELS)[number];

// --- Governance rail ------------------------------------------------------
export const LAYERS = ['L0', 'L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7', 'L8', 'L9', 'rail'] as const;
export type Layer = (typeof LAYERS)[number];

export const COMPONENTS = [
  'C1', // Channel Gateway
  'C2', // Identity and Binding
  'C3', // Context Resolver
  'C4', // Intake and Classifier
  'C5', // Planner
  'C6', // Policy Engine
  'C7', // Workflow Executor
  'C8', // Skill Runtime
  'C9', // LLM Gateway
  'C10', // Tool Invoker
  'C11', // Knowledge Service
  'C12', // Records Service
  'C13', // Assurance Harness
  'C14', // Delivery Service
  'C15', // Audit and Evidence Store
  'C16', // Configuration Service
] as const;
export type ComponentId = (typeof COMPONENTS)[number];

/**
 * DWD-06 s.3.14: "`event_type` is a closed enumeration; a new type is a MINOR
 * contract change."
 *
 * Phase 0 acceptance P0-1 requires every type here to be emittable and a
 * synthetic end-to-end run to produce the expected set — including for events
 * nothing yet emits.
 */
export const AUDIT_EVENT_TYPES = [
  // C1 — channel
  'request.received',
  'request.admitted',
  'request.rejected',
  'webhook.verification_failed',
  'webhook.replay_detected',
  // C2 — identity
  'principal.resolved',
  'principal.unresolved',
  'binding.created',
  'binding.verified',
  'binding.revoked',
  // C3 — L0 context
  'context.resolved',
  'context.partial',
  'context.refused',
  'context.expired',
  // C4 — intake
  'intent.classified',
  'clarification.requested',
  'duplicate.detected',
  'injection.suspected',
  'attachment.scanned',
  // C5 — planner
  'graph.compiled',
  'graph.admitted',
  'graph.refused',
  // C6 — policy
  'policy.evaluated',
  'immutable_rule.engaged',
  'refusal.issued',
  // C7 — workflow
  'graph.state_changed',
  'node.started',
  'node.completed',
  'node.failed',
  'node.retried',
  'compensation.started',
  'compensation.completed',
  'compensation.failed',
  'graph.suspended',
  'graph.resumed',
  // C8 / C9 — skill and model
  'skill.invoked',
  'skill.completed',
  'skill.refused',
  'llm.called',
  'llm.fallback_used',
  'llm.budget_exceeded',
  // C10 — tools
  'tool.invoked',
  'tool_call_completed',
  'tool.refused',
  'tool.dry_run',
  'tool.scope_denied',
  // C11 / C12 — knowledge and records
  'knowledge.retrieved',
  'knowledge.coverage_gap',
  'knowledge.version_published',
  'records.fetched',
  // C13 — assurance
  'assurance.gate_evaluated',
  'assurance.gate_failed',
  'accuracy_floor.breached',
  'skill.pulled_back',
  'release_gate.evaluated',
  // C14 — delivery
  'delivery.queued',
  'delivery.sent',
  'delivery.status_changed',
  'delivery.failed',
  'delivery.blocked',
  // L9 — authorisation and hand-off
  'evidence_bundle.assembled',
  'handoff.issued',
  'handoff.escalated',
  'handoff.expired',
  'reviewer.acted',
  'decision.recorded',
  'reserved_act.blocked',
  'scope_card.generated',
  'scope_card.published',
  // rails — configuration, secrets, audit, tenancy
  'config.loaded',
  'config.changed',
  'config.missing',
  'config.stale',
  'secret.rotated',
  'secret.canary_triggered',
  'audit.chain_anchored',
  'audit.chain_verified',
  'audit.chain_broken',
  'pack.published',
  'pack.rolled_back',
  'tenant.suspended',
  'tenant.resumed',
  'retention.purged',
  'legal_hold.applied',
  'legal_hold.released',
  'incident.declared',
  'feedback.received',
] as const;
export type AuditEventType = (typeof AUDIT_EVENT_TYPES)[number];

export const AUDIT_OUTCOMES = ['success', 'failure', 'refused', 'blocked'] as const;
export type AuditOutcome = (typeof AUDIT_OUTCOMES)[number];

export const ACTOR_KINDS = ['worker', 'human', 'system', 'provider'] as const;
export type ActorKind = (typeof ACTOR_KINDS)[number];

/**
 * file 01 s.7.2 — the L9 reserved-acts register. `output_class` on a
 * DecisionRecord must be one of these; an unlisted class is reserved by
 * default until the register is extended through change control (s.7.3).
 */
export const OUTPUT_CLASSES = [
  'cited_answer_informational',
  'cited_answer_material_reliance',
  'journal_entry_routine',
  'journal_entry_judgmental',
  'reconciliation_matching',
  'reconciliation_certification',
  'supplier_invoice_coding_and_match',
  'payment_proposal_file',
  'payment_release',
  'payment_destination_masterdata_change',
  'non_payment_masterdata_change',
  'payroll_computation_and_variance_pack',
  'payroll_approval_and_release',
  'statutory_contribution_schedule',
  'tax_computation_and_return_working',
  'statutory_filing_submission',
  'einvoice_validation',
  'management_report_and_analysis_pack',
  'statutory_financial_statement_component',
  'judgment_going_concern_impairment_provision',
  'internal_communication',
  'external_communication',
  'control_evidence_pack',
  'control_attestation',
  'scope_or_configuration_change',
  'incident_declaration',
  'licensed_advice',
] as const;
export type OutputClass = (typeof OUTPUT_CLASSES)[number];

export const SENSITIVITY_TIERS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type SensitivityTierName = (typeof SENSITIVITY_TIERS)[number];
