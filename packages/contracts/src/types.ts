/**
 * The sixteen canonical data contracts — DWD-06 s.3.
 *
 *   "A component boundary carries only these sixteen shapes."
 *   "If a shape is not in section 3, it is not a canonical contract and must
 *    not cross a component boundary."
 *
 * Every field below is traceable to the field tables in DWD-06 s.3.1 to s.3.16.
 * Conditionally-required fields (`C` in the spec) are modelled as optional here
 * and enforced by the JSON Schema, because the condition is usually a
 * cross-field one that TypeScript cannot express.
 */
import type { Money } from '@eiaaw/core';
import type {
  ActorKind,
  AdmissionCheck,
  AdmissionDecision,
  AssuranceGate,
  AuditEventType,
  AuditOutcome,
  AuthorKind,
  AuthorisationVerdict,
  AutonomyLevel,
  ChannelName,
  ComponentId,
  ConfidenceBand,
  ContextAxis,
  ConversationState,
  CorrectnessLabel,
  CoverageTier,
  DecisionType,
  DeliveryStatus,
  ExtractionStatus,
  FeedbackHookKind,
  FeedbackSignal,
  FeedbackSource,
  FiscalPeriodStatus,
  GateResult,
  GraphState,
  ImmutableRuleNumber,
  InvocationStatus,
  Layer,
  MessageDirection,
  NodeKind,
  NodeOwnerKind,
  NodeState,
  OutputClass,
  PolicyVerdictValue,
  PrincipalResolution,
  QualityCriterionResult,
  RedactionState,
  RejectionReasonCode,
  ResolutionStatus,
  ReviewerMove,
  ScanVerdict,
  SensitivityTierName,
  SkillMode,
  ToolOutcome,
  TriggerClass,
  TrustClass,
} from './enums.js';

/** RFC 3339 with an explicit offset. */
export type Timestamp = string;
/** `YYYY-MM-DD`. */
export type DateOnly = string;
/** `sha256:<64 hex>`. */
export type PrefixedHash = string;
/** `obj://…` or `worm://…`. */
export type StorageRef = string;
/** A decimal string with explicit precision — never a float (DWD-06 s.2.2). */
export type DecimalString = string;
/** `AS-<FAMILY>-<nnn>` or a family wildcard such as `AS-RUL-*`. */
export type SettingRef = string;

/** Every contract carries a semver `schema_version`; consumers reject an unknown MAJOR. */
export interface Versioned {
  readonly schema_version: string;
}

// ===========================================================================
// 3.1 InboundRequest — L7 → L5
// ===========================================================================

export interface InboundPrincipal {
  /** Required when `resolution` is `bound`. */
  readonly principal_id?: string;
  readonly resolution: PrincipalResolution;
  readonly confidence: ConfidenceBand;
  readonly binding_id?: string;
  /** What the transport asserted. Never authoritative alone. */
  readonly claimed_identity?: string;
}

export interface InboundAttachment {
  readonly attachment_id: string;
  readonly filename: string;
  readonly media_type: string;
  readonly size_bytes: number;
  /** Also the OCR idempotency key (file 05 s.10.7). */
  readonly content_hash: PrefixedHash;
  readonly storage_ref: StorageRef;
  readonly scan_verdict: ScanVerdict;
  readonly extraction_status: ExtractionStatus;
}

export interface SecurityFlags {
  readonly dmarc?: 'pass' | 'fail' | 'none' | 'not_applicable';
  readonly spf?: 'pass' | 'fail' | 'none' | 'not_applicable';
  readonly dkim?: 'pass' | 'fail' | 'none' | 'not_applicable';
  readonly sender_external: boolean;
  readonly allow_list: 'member' | 'non_member' | 'not_applicable';
  readonly loop_indicator: boolean;
  readonly replay_suspected: boolean;
}

export interface InboundRequest extends Versioned {
  readonly request_id: string;
  readonly tenant_id: string;
  readonly trace_id: string;
  readonly channel: ChannelName;
  /** Native provider ID; part of the inbound dedupe key (DWD-06 s.8.1). */
  readonly transport_message_id: string;
  /** Logical conversation, not the transport thread (file 02 s.10). */
  readonly conversation_key: string;
  readonly received_at: Timestamp;
  /** Provider-claimed send time. Never trusted for ordering. */
  readonly transport_sent_at?: Timestamp;
  readonly principal: InboundPrincipal;
  /** Canonical text, signatures and quotes stripped. */
  readonly body_text: string;
  /** Retained for audit; never used for reasoning. */
  readonly body_raw_ref: StorageRef;
  /** Never entered into reasoning before `scan_verdict = clean`. */
  readonly attachments?: readonly InboundAttachment[];
  /** Transport hint only; L5 classifies. */
  readonly intent_hint?: { readonly source: string; readonly value: string };
  readonly reply_context?: {
    readonly in_reply_to?: string;
    readonly references?: readonly string[];
  };
  /** BCP 47. Overridden by AS-ORG-* and AS-PPL-*. */
  readonly locale_hint?: string;
  readonly security_flags: SecurityFlags;
  /** A rejected request is logged and goes no further. */
  readonly admission: { readonly decision: AdmissionDecision; readonly reason_code: string | null };
}

// ===========================================================================
// 3.2 ResolvedContext — L0. Implements the L0 minimum artefact schema in full.
// A build may extend it; it may never omit a field.
// ===========================================================================

export interface AxisResolution {
  readonly value: string;
  /** Provenance of the resolution. Build extension. */
  readonly source: string;
  readonly coverage_tier: CoverageTier;
}

export interface KnowledgePinModule {
  readonly module_id: string;
  readonly version: string;
  readonly effective_from: DateOnly;
  readonly effective_to: DateOnly | null;
}

export interface ResolvedContext extends Versioned {
  readonly context_id: string;
  readonly request_id: string;
  readonly tenant_id: string;
  readonly resolution_status: ResolutionStatus;
  /** Required when status is `partial` or `refused`. */
  readonly resolution_reason: string | null;
  readonly axes: Readonly<Record<ContextAxis, AxisResolution>>;
  readonly pack: { readonly pack_id: string; readonly pack_version: string };
  readonly residency_zone: string;
  readonly resolved_locale: string;
  readonly fiscal_period?: {
    readonly period_id: string;
    readonly start_date: DateOnly;
    readonly end_date: DateOnly;
    readonly status: FiscalPeriodStatus;
  };
  /** The versions pinned for this context's lifetime. Build extension, required. */
  readonly knowledge_pin: {
    readonly pinned_at: Timestamp;
    readonly modules: readonly KnowledgePinModule[];
  };
  readonly resolved_at: Timestamp;
  /** A stale context must be re-resolved, never reused (DWD-06 s.7.3). */
  readonly expires_at: Timestamp;
}

// ===========================================================================
// 3.3 Conversation — L5, L7
// ===========================================================================

export interface Conversation extends Versioned {
  readonly conversation_key: string;
  readonly tenant_id: string;
  readonly principal_id: string | null;
  readonly channels_seen: readonly ChannelName[];
  readonly primary_channel: ChannelName;
  readonly state: ConversationState;
  readonly opened_at: Timestamp;
  readonly last_activity_at: Timestamp;
  /** Idle expiry from AS-PPL-*; closing destroys working memory. */
  readonly closes_at: Timestamp;
  readonly context_ref?: string;
  /** Task-graph-scoped memory pointer; never a citation source. */
  readonly working_memory_ref?: string;
  /** Non-authoritative; never affects substantive conclusions. */
  readonly preference_snapshot?: Readonly<Record<string, string>>;
  /** Minimum of the ceilings of `channels_seen`. */
  readonly sensitivity_ceiling: SensitivityTierName;
  readonly handoff_open: boolean;
}

// ===========================================================================
// 3.4 Message — L7
// ===========================================================================

export interface ContentBlock {
  readonly kind: 'text' | 'citation' | 'table' | 'code' | 'divider' | 'action' | 'diff';
  readonly text?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

export interface Message extends Versioned {
  readonly message_id: string;
  readonly conversation_key: string;
  readonly tenant_id: string;
  readonly direction: MessageDirection;
  readonly channel: ChannelName;
  readonly transport_message_id: string | null;
  readonly author: { readonly kind: AuthorKind; readonly principal_id: string | null };
  readonly sent_at: Timestamp;
  readonly content_text: string;
  readonly content_blocks?: readonly ContentBlock[];
  readonly attachment_ids?: readonly string[];
  /** Inbound is ALWAYS `untrusted_content` (DWD-06 s.3.4, file 03 s.12). */
  readonly trust_class: TrustClass;
  readonly related_request_id: string | null;
  readonly related_delivery_id: string | null;
  readonly redaction_state: RedactionState;
}

// ===========================================================================
// 3.5 TaskGraph — L5
// ===========================================================================

export interface GraphEdge {
  readonly from: string;
  readonly to: string;
  readonly kind: 'sequence' | 'data' | 'compensation';
}

/** Makes the autonomy computation auditable after the fact. */
export interface AutonomyBasis {
  readonly platform_ceiling: AutonomyLevel;
  readonly as_scp_grant: AutonomyLevel;
  readonly supervisor_ref: SettingRef | null;
  readonly supervisor_active: boolean;
}

export interface GraphBudget {
  readonly token_ceiling: number;
  readonly cost_ceiling: Money;
  readonly source: SettingRef;
}

export interface TaskGraph extends Versioned {
  readonly graph_id: string;
  readonly tenant_id: string;
  readonly request_id: string;
  readonly context_ref: string;
  readonly trigger_class: TriggerClass;
  readonly intent: string;
  readonly root_skill_id: string;
  readonly skill_version: string;
  /** `min(ceiling, grant, immutable cap)` (file 05 s.3.5). */
  readonly effective_autonomy: AutonomyLevel;
  readonly autonomy_basis: AutonomyBasis;
  readonly nodes: readonly { readonly node_id: string }[];
  readonly edges: readonly GraphEdge[];
  /** Compile-time ranks; irreversible nodes hold the highest (DWD-06 s.9.6). */
  readonly sequence_ranks: Readonly<Record<string, number>>;
  readonly admission: {
    readonly checks_passed: readonly AdmissionCheck[];
    readonly decision: AdmissionDecision;
    readonly failed_check?: AdmissionCheck;
    readonly reason?: string;
  };
  readonly budget: GraphBudget;
  readonly state: GraphState;
  readonly created_at: Timestamp;
  readonly completed_at: Timestamp | null;
  readonly workflow_run_id: string;
}

// ===========================================================================
// 3.6 TaskNode — L5
// ===========================================================================

export interface NodeCompensation {
  readonly tool_id: string;
  readonly invoked: boolean;
  readonly compensation_key: string | null;
}

export interface NodeFailure {
  readonly class: string;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

export interface TaskNode extends Versioned {
  readonly node_id: string;
  readonly graph_id: string;
  readonly kind: NodeKind;
  readonly label: string;
  /** A node without an owner fails admission. */
  readonly owner: { readonly kind: NodeOwnerKind; readonly ref: string };
  /** Required for any node compiled from an SOP step. */
  readonly sop_step_ref?: string;
  readonly depends_on: readonly string[];
  readonly sequence_rank: number;
  readonly state: NodeState;
  readonly state_changing: boolean;
  readonly irreversible: boolean;
  /** Required when `state_changing` is true. 64 lowercase hex. */
  readonly idempotency_key?: string;
  /** Required when `state_changing` is true and `irreversible` is false. */
  readonly compensation?: NodeCompensation;
  /** Reflects the tool's graduation stage (file 05 s.11). */
  readonly dry_run: boolean;
  readonly attempt: number;
  readonly max_attempts: number;
  readonly started_at: Timestamp | null;
  readonly ended_at: Timestamp | null;
  readonly confidence?: DecimalString;
  readonly cost?: Money;
  readonly failure: NodeFailure | null;
}

// ===========================================================================
// 3.7 PolicyVerdict — L5, L9
// ===========================================================================

/** A reference plus a hash. Never an inline client value (DWD-06 s.3.7). */
export interface ThresholdValueRef {
  readonly setting_id: SettingRef;
  readonly value_ref: string;
  readonly value_hash: PrefixedHash;
}

export interface PolicyVerdict extends Versioned {
  readonly verdict_id: string;
  readonly graph_id: string;
  readonly node_id: string;
  readonly rule_id: string;
  readonly rule_version: string;
  readonly context_selector: Readonly<Record<string, string>>;
  readonly condition_evaluated: string;
  /** Makes a verdict re-derivable during audit. Build extension. */
  readonly inputs_hash: PrefixedHash;
  readonly verdict: PolicyVerdictValue;
  readonly threshold_values: readonly ThresholdValueRef[];
  readonly precedence_rank: number;
  readonly effective_from: DateOnly;
  readonly effective_to: DateOnly | null;
  readonly owner: SettingRef;
  readonly immutable_rules_evaluated: readonly ImmutableRuleNumber[];
  /** Non-null forces `refuse` regardless of the rule verdict. */
  readonly immutable_rule_engaged: ImmutableRuleNumber | null;
  readonly decided_at: Timestamp;
}

// ===========================================================================
// 3.8 SkillInvocation — L4
// ===========================================================================

/** The L2 knowledge chunk minimum schema. The grounding gate reads this. */
export interface KnowledgeUsed {
  readonly module_id: string;
  readonly chunk_id: string;
  readonly version: string;
  readonly effective_from: DateOnly;
  readonly effective_to: DateOnly | null;
  readonly citation_locator: string;
  readonly licence_class: string;
}

/** The L1 record minimum schema, including lineage. */
export interface RecordUsed {
  readonly source_system_id: string;
  readonly record_type: string;
  readonly entity_id: string;
  readonly period: string;
  readonly content_hash: PrefixedHash;
  readonly connector_version: string;
  readonly extracted_at: Timestamp;
}

export interface Citation {
  readonly claim_ref: string;
  readonly chunk_id: string;
  readonly version: string;
  readonly effective_from: DateOnly;
  readonly locator?: string;
}

export interface SkillInvocation extends Versioned {
  readonly invocation_id: string;
  readonly graph_id: string;
  readonly node_id: string;
  readonly skill_id: string;
  readonly skill_version: string;
  /** Set by C7, never by the skill. */
  readonly mode: SkillMode;
  readonly context_ref: string;
  readonly inputs_ref: StorageRef;
  readonly inputs_hash: PrefixedHash;
  readonly knowledge_used: readonly KnowledgeUsed[];
  readonly records_used: readonly RecordUsed[];
  readonly tool_call_ids: readonly string[];
  readonly model_route: {
    readonly route_id: string;
    readonly model: string;
    readonly fallback_used: boolean;
  };
  readonly output_ref: StorageRef | null;
  readonly output_hash: PrefixedHash | null;
  /** An empty array with a non-empty substantive output fails the grounding gate. */
  readonly citations: readonly Citation[];
  readonly confidence?: DecimalString;
  readonly quality_criteria_results: readonly {
    readonly criterion: string;
    readonly result: QualityCriterionResult;
    readonly detail?: string;
  }[];
  readonly tokens: { readonly input: number; readonly output: number };
  readonly cost: Money;
  readonly duration_ms: number;
  readonly status: InvocationStatus;
}

// ===========================================================================
// 3.9 ToolCall — L6
// ===========================================================================

export interface ScopeQualifiers {
  readonly entity_id?: string;
  readonly period?: string;
  readonly journal_source?: string;
  readonly max_absolute_value?: Money;
  readonly [key: string]: string | Money | undefined;
}

export interface ToolCall extends Versioned {
  readonly tool_call_id: string;
  readonly graph_id: string;
  readonly node_id: string;
  readonly invocation_id: string | null;
  readonly tool_id: string;
  readonly capability_schema_version: string;
  readonly permission_scope_requested: string;
  /** A difference is a refusal, never a downgrade-and-proceed. */
  readonly permission_scope_granted: string | null;
  readonly scope_qualifiers: ScopeQualifiers;
  /** Ties the call to the autonomy and the gate that permitted it. */
  readonly authority_ref: {
    readonly autonomy: AutonomyLevel;
    readonly policy_verdict_id: string | null;
    readonly approval_ref: string | null;
  };
  readonly state_changing: boolean;
  readonly dry_run: boolean;
  /** Mandatory when state-changing. */
  readonly idempotency_key?: string;
  readonly request_hash: PrefixedHash;
  readonly attempt: number;
  readonly started_at: Timestamp;
  readonly ended_at: Timestamp | null;
  readonly outcome: ToolOutcome;
  /** The system-of-record identifier created; needed to compensate. */
  readonly provider_reference?: string;
  readonly business_key?: string;
  readonly rate_limit_remaining?: number;
  readonly cost: Money;
  readonly error: NodeFailure | null;
  /** Tool call ID of the compensation, when one ran. */
  readonly compensated_by: string | null;
}

// ===========================================================================
// 3.10 EvidenceBundle — L9
// ===========================================================================

export interface BundleTraceEntry {
  readonly node_id: string;
  readonly kind: NodeKind;
  /** A node-level summary. Reasoning text is NEVER placed in a bundle. */
  readonly summary: string;
}

export interface EvidenceBundle extends Versioned {
  readonly bundle_id: string;
  readonly tenant_id: string;
  readonly graph_id: string;
  readonly output_class: OutputClass;
  /** Increments when a reviewer edit produces a new proposal. */
  readonly bundle_version: number;
  readonly proposed_output: {
    readonly artifact_ref: StorageRef;
    readonly content_hash: PrefixedHash;
    readonly render_ref?: StorageRef;
  };
  readonly trace: readonly BundleTraceEntry[];
  readonly citations: readonly {
    readonly chunk_id: string;
    readonly module_id: string;
    readonly version: string;
    readonly effective_from: DateOnly;
    readonly locator: string;
  }[];
  readonly records: readonly RecordUsed[];
  readonly policy_verdicts: readonly string[];
  readonly confidence_by_step: readonly {
    readonly node_id: string;
    readonly confidence: DecimalString;
  }[];
  readonly lowest_confidence_step: string | null;
  /** A bundle cannot be assembled with a failing gate. */
  readonly assurance: Readonly<Record<AssuranceGate, GateResult>> & {
    readonly harness_version: string;
  };
  readonly cost_to_date: Money & { readonly budget_ref: SettingRef };
  readonly pack_version: string;
  readonly platform_version: string;
  readonly assembled_at: Timestamp;
  /** Written before the bundle is shown to any human. */
  readonly worm_ref: StorageRef;
}

// ===========================================================================
// 3.11 HandoffPackage — L5, L9
// ===========================================================================

export interface HandoffPackage extends Versioned {
  readonly handoff_id: string;
  readonly graph_id: string;
  readonly node_id: string;
  readonly bundle_id: string;
  readonly bundle_version: number;
  /** Exactly one, phrased as a decision (file 04 s.6.2). */
  readonly question: string;
  readonly decision_type: DecisionType;
  readonly assignee: {
    readonly principal_id: string;
    readonly role_ref: string;
    readonly source: SettingRef;
  };
  /** True for every irreversible node and every `dual_control` verdict. */
  readonly dual_control_required: boolean;
  readonly second_approver: { readonly principal_id: string; readonly role_ref: string } | null;
  readonly sod_exclusions_applied: readonly string[];
  /** Exactly the four moves; no fifth value is representable. */
  readonly permitted_moves: readonly ReviewerMove[];
  readonly channels: {
    readonly delivery: readonly ChannelName[];
    readonly approval: readonly ChannelName[];
  };
  readonly sla: {
    readonly due_at: Timestamp;
    readonly source: SettingRef;
    readonly escalation_target: SettingRef;
  };
  /** Single-use; binds an approval to this bundle version (DWD-06 s.6.5). */
  readonly nonce: string;
  readonly issued_at: Timestamp;
  readonly state: string;
}

// ===========================================================================
// 3.12 ReviewerAction — L9
// ===========================================================================

export interface ReviewerAction extends Versioned {
  readonly action_id: string;
  readonly handoff_id: string;
  /** An action against a superseded bundle version is rejected. */
  readonly bundle_version_acted_on: number;
  readonly actor: {
    readonly principal_id: string;
    readonly auth_method: string;
    readonly channel: ChannelName;
  };
  readonly move: ReviewerMove;
  readonly nonce_presented: string;
  readonly nonce_valid: boolean;
  /** Required on `reject_with_reason`. Feeds drift monitors and the accuracy floor. */
  readonly reason_code: RejectionReasonCode | null;
  readonly free_text: string | null;
  readonly diff_ref: StorageRef | null;
  /** Required on `edit_and_approve`. A material edit opens a change request. */
  readonly materiality?: {
    readonly assessed: boolean;
    readonly material: boolean;
    readonly threshold_ref: SettingRef;
    readonly change_request_id: string | null;
  };
  /** Required on `approve` and `edit_and_approve`. This exact artefact may be released. */
  readonly approved_output_hash?: PrefixedHash;
  readonly acted_at: Timestamp;
  readonly ip_or_device_ref: string;
  readonly second_approver_action_id: string | null;
}

// ===========================================================================
// 3.13 DecisionRecord — L9, governance rail
// ===========================================================================

export interface DecisionRecord extends Versioned {
  readonly decision_id: string;
  readonly tenant_id: string;
  readonly output_class: OutputClass;
  readonly authorisation_verdict: AuthorisationVerdict;
  readonly named_owner: {
    readonly principal_id: string;
    readonly role_ref: string;
    readonly source: SettingRef;
  };
  readonly evidence_bundle_ref: StorageRef;
  readonly pack_version: string;
  readonly platform_version: string;
  readonly skill_versions: readonly { readonly skill_id: string; readonly version: string }[];
  readonly reviewer_action_id: string | null;
  /** The reserved-acts register entry engaged, when one was. */
  readonly reserved_act_ref: string | null;
  readonly graph_id: string;
  readonly timestamp: Timestamp;
  readonly worm_ref: StorageRef;
}

// ===========================================================================
// 3.14 AuditEvent — rail. Append-only; nothing edits or deletes.
// ===========================================================================

export interface AuditEvent extends Versioned {
  readonly event_id: string;
  readonly tenant_id: string;
  readonly trace_id: string;
  readonly span_id: string;
  readonly occurred_at: Timestamp;
  readonly recorded_at: Timestamp;
  readonly layer: Layer;
  readonly component: ComponentId;
  readonly event_type: AuditEventType;
  readonly actor: {
    readonly kind: ActorKind;
    readonly skill_id?: string;
    readonly principal_id: string | null;
  };
  readonly subject: { readonly kind: string; readonly id: string };
  readonly context_ref: string | null;
  readonly graph_id: string | null;
  readonly outcome: AuditOutcome;
  /** Payload content is stored by reference; the hash is in the chain. */
  readonly payload_hash: PrefixedHash;
  readonly payload_ref: StorageRef | null;
  readonly prev_event_hash: PrefixedHash;
  readonly event_hash: PrefixedHash;
}

/** The shape written before the chain hash is computed. */
export type UnsealedAuditEvent = Omit<AuditEvent, 'prev_event_hash' | 'event_hash' | 'recorded_at'>;

// ===========================================================================
// 3.15 OutboundDelivery — L7
// ===========================================================================

/** All five elements present, or the delivery is refused (file 04 s.1). */
export interface ResponseContractElements {
  readonly answer: boolean;
  readonly basis_and_citations: boolean;
  readonly status_and_limits: boolean;
  readonly exclusions: boolean;
  readonly next_action_and_owner: boolean;
}

export interface OutboundDelivery extends Versioned {
  readonly delivery_id: string;
  readonly tenant_id: string;
  readonly conversation_key: string;
  readonly graph_id: string;
  /** No delivery without an authorisation decision. */
  readonly decision_record_ref: string;
  readonly output_class: OutputClass;
  readonly recipient: { readonly principal_id: string; readonly external: boolean };
  readonly channel: ChannelName;
  readonly locale: string;
  readonly sensitivity: SensitivityTierName;
  readonly payload: {
    readonly body_ref: StorageRef;
    readonly attachments?: readonly {
      readonly artifact_ref: StorageRef;
      readonly content_hash: PrefixedHash;
    }[];
  };
  readonly contract_elements: ResponseContractElements;
  readonly idempotency_key: string;
  readonly attempt_group: number;
  readonly status: DeliveryStatus;
  readonly status_history: readonly { readonly status: DeliveryStatus; readonly at: Timestamp }[];
  readonly provider_reference: string | null;
  readonly failure: NodeFailure | null;
  readonly feedback_hook: { readonly kind: FeedbackHookKind; readonly token: string | null };
}

// ===========================================================================
// 3.16 FeedbackEvent — L7 → L8
// ===========================================================================

export interface FeedbackEvent extends Versioned {
  readonly feedback_id: string;
  readonly tenant_id: string;
  readonly delivery_id: string | null;
  readonly graph_id: string;
  readonly skill_id: string;
  readonly skill_version: string;
  readonly source: FeedbackSource;
  readonly signal: FeedbackSignal;
  readonly category: string | null;
  readonly free_text: string | null;
  /** The supervised signal the accuracy floor consumes. */
  readonly correctness_label: CorrectnessLabel | null;
  readonly labelled_by: { readonly principal_id: string; readonly role_ref: string } | null;
  /** False for preference-only feedback, which never affects substantive measurement. */
  readonly affects_accuracy_floor: boolean;
  readonly created_at: Timestamp;
}

// ===========================================================================
// The registry of all sixteen
// ===========================================================================

export interface ContractMap {
  InboundRequest: InboundRequest;
  ResolvedContext: ResolvedContext;
  Conversation: Conversation;
  Message: Message;
  TaskGraph: TaskGraph;
  TaskNode: TaskNode;
  PolicyVerdict: PolicyVerdict;
  SkillInvocation: SkillInvocation;
  ToolCall: ToolCall;
  EvidenceBundle: EvidenceBundle;
  HandoffPackage: HandoffPackage;
  ReviewerAction: ReviewerAction;
  DecisionRecord: DecisionRecord;
  AuditEvent: AuditEvent;
  OutboundDelivery: OutboundDelivery;
  FeedbackEvent: FeedbackEvent;
}

export type ContractName = keyof ContractMap;

export const CONTRACT_NAMES: readonly ContractName[] = [
  'InboundRequest',
  'ResolvedContext',
  'Conversation',
  'Message',
  'TaskGraph',
  'TaskNode',
  'PolicyVerdict',
  'SkillInvocation',
  'ToolCall',
  'EvidenceBundle',
  'HandoffPackage',
  'ReviewerAction',
  'DecisionRecord',
  'AuditEvent',
  'OutboundDelivery',
  'FeedbackEvent',
];

/** The MAJOR every contract currently ships at. A consumer rejects an unknown MAJOR. */
export const CURRENT_SCHEMA_VERSION = '1.0.0';
