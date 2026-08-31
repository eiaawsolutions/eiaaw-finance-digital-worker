/**
 * The L9 reserved-acts register — file 01 s.7.2, transcribed in full.
 *
 * This table is what makes "the worker is never an approver" structural rather
 * than aspirational. Two rules from s.7.3 govern it:
 *
 *   "If an output class is not in the register, it is reserved by default until
 *    the register is extended through section 10 change control."
 *
 *   "If a tenant asks to move a Yes to a No, that is a platform change, not a
 *    configuration change, and it is refused."
 *
 * Hence the register lives in code and is seeded into a platform-owned table
 * the worker's database role cannot write (migration 0008 revokes INSERT).
 */
import type { AutonomyLevel, OutputClass, ImmutableRuleNumber } from '@eiaaw/contracts';

export type GateBehaviour =
  | 'hard_stop'
  | 'degrade_to_prepare'
  | 'route_to_supervisor'
  | 'field_level_write_denial'
  | 'class_check_at_send'
  | 'grounding_gate';

export interface OutputClassEntry {
  readonly output_class: OutputClass;
  readonly label: string;
  /** Yes where the act itself may only be performed by a human. */
  readonly reserved_act: boolean;
  readonly worker_maximum_contribution: string;
  readonly accountable_role_ref: string;
  readonly minimum_competency_level: string;
  readonly gate_behaviour: GateBehaviour;
  /** `none` encodes the register's "Not applicable". */
  readonly autonomy_ceiling: AutonomyLevel | 'none';
  readonly immutable_rule_ref?: ImmutableRuleNumber;
  readonly notes?: string;
}

const e = (entry: OutputClassEntry): OutputClassEntry => entry;

export const OUTPUT_CLASS_REGISTER: readonly OutputClassEntry[] = [
  e({
    output_class: 'cited_answer_informational',
    label: 'Cited answer, informational',
    reserved_act: false,
    worker_maximum_contribution: 'Deliver with citations and effective dates',
    accountable_role_ref: "Asker's own manager for reliance",
    minimum_competency_level: 'L3 for material reliance',
    gate_behaviour: 'grounding_gate',
    autonomy_ceiling: 'execute',
    notes: 'Refuse if uncited.',
  }),
  e({
    output_class: 'cited_answer_material_reliance',
    label: 'Cited answer relied on for a material decision',
    reserved_act: true,
    worker_maximum_contribution: 'Deliver with a reliance warning naming the confirming role',
    accountable_role_ref: 'Financial controller or process owner',
    minimum_competency_level: 'L3',
    gate_behaviour: 'grounding_gate',
    autonomy_ceiling: 'draft',
    notes: 'The reserved act is the reliance decision, not the answer.',
  }),
  e({
    output_class: 'journal_entry_routine',
    label: 'Journal entry, routine rule-based',
    reserved_act: false,
    worker_maximum_contribution: 'Post at Execute within AS-RUL- and AS-DOA- limits',
    accountable_role_ref: 'Financial controller / process owner certifying the batch',
    minimum_competency_level: 'L3',
    gate_behaviour: 'degrade_to_prepare',
    autonomy_ceiling: 'execute',
  }),
  e({
    output_class: 'journal_entry_judgmental',
    label: 'Journal entry, judgmental (provisions, impairment, one-off)',
    reserved_act: true,
    worker_maximum_contribution: 'Draft with stated basis and alternatives',
    accountable_role_ref: 'Financial controller, escalating by materiality to CFO',
    minimum_competency_level: 'L3 to L5',
    gate_behaviour: 'hard_stop',
    autonomy_ceiling: 'draft',
  }),
  e({
    output_class: 'reconciliation_matching',
    label: 'Reconciliation, matching and break proposal',
    reserved_act: false,
    worker_maximum_contribution: 'Match, age, classify breaks as proposals',
    accountable_role_ref: "Preparer's reviewer",
    minimum_competency_level: 'L2 to L3',
    gate_behaviour: 'degrade_to_prepare',
    autonomy_ceiling: 'execute',
    notes: 'Matching may complete; certification is blocked.',
  }),
  e({
    output_class: 'reconciliation_certification',
    label: 'Reconciliation certification',
    reserved_act: true,
    worker_maximum_contribution: 'Present the completed reconciliation',
    accountable_role_ref: 'Financial controller or delegated certifier per AS-DOA-',
    minimum_competency_level: 'L3',
    gate_behaviour: 'hard_stop',
    autonomy_ceiling: 'draft',
    immutable_rule_ref: 5,
  }),
  e({
    output_class: 'supplier_invoice_coding_and_match',
    label: 'Supplier invoice coding and three-way match',
    reserved_act: false,
    worker_maximum_contribution: 'Code and match within AS-RUL- tolerance',
    accountable_role_ref: 'AP process owner',
    minimum_competency_level: 'L2 to L3',
    gate_behaviour: 'route_to_supervisor',
    autonomy_ceiling: 'execute',
  }),
  e({
    output_class: 'payment_proposal_file',
    label: 'Payment proposal file',
    reserved_act: false,
    worker_maximum_contribution: 'Prepare, validate, flag anomalies',
    accountable_role_ref: 'Treasury approver',
    minimum_competency_level: 'L3 to L5',
    gate_behaviour: 'hard_stop',
    autonomy_ceiling: 'execute',
    notes: 'File prepared; transmission blocked.',
  }),
  e({
    output_class: 'payment_release',
    label: 'Payment release or bank transmission',
    reserved_act: true,
    worker_maximum_contribution: 'None beyond the proposal',
    accountable_role_ref: 'Bank mandate signatories per AS-DOA-',
    minimum_competency_level: 'Per mandate, typically L5 to L6',
    gate_behaviour: 'hard_stop',
    autonomy_ceiling: 'none',
    immutable_rule_ref: 2,
  }),
  e({
    output_class: 'payment_destination_masterdata_change',
    label: 'Payment-destination master data change',
    reserved_act: true,
    worker_maximum_contribution: 'Prepare a change request with evidence; report mismatches',
    accountable_role_ref: 'Master data approver plus dual-control second person',
    minimum_competency_level: 'L3 plus second',
    gate_behaviour: 'field_level_write_denial',
    autonomy_ceiling: 'draft',
    immutable_rule_ref: 6,
  }),
  e({
    output_class: 'non_payment_masterdata_change',
    label: 'Non-payment master data change (naming, terms, cost centre)',
    reserved_act: false,
    worker_maximum_contribution: 'Prepare and, where at Execute, apply within AS-RUL-',
    accountable_role_ref: 'Master data owner',
    minimum_competency_level: 'L3',
    gate_behaviour: 'degrade_to_prepare',
    autonomy_ceiling: 'execute',
  }),
  e({
    output_class: 'payroll_computation_and_variance_pack',
    label: 'Payroll computation and variance pack',
    reserved_act: false,
    worker_maximum_contribution: 'Compute, validate, reconcile, report variances',
    accountable_role_ref: 'Payroll process owner',
    minimum_competency_level: 'L3',
    gate_behaviour: 'route_to_supervisor',
    autonomy_ceiling: 'draft',
  }),
  e({
    output_class: 'payroll_approval_and_release',
    label: 'Payroll approval and release',
    reserved_act: true,
    worker_maximum_contribution: 'None',
    accountable_role_ref: 'Payroll approver, and treasury approver for the payment',
    minimum_competency_level: 'L3 to L5',
    gate_behaviour: 'hard_stop',
    autonomy_ceiling: 'none',
    immutable_rule_ref: 4,
  }),
  e({
    output_class: 'statutory_contribution_schedule',
    label: 'Statutory contribution schedules (EPF, SOCSO, EIS, PCB or local equivalent)',
    reserved_act: true,
    worker_maximum_contribution: 'Compute and reconcile',
    accountable_role_ref: 'Payroll approver and tax lead',
    minimum_competency_level: 'L3 to L5',
    gate_behaviour: 'hard_stop',
    autonomy_ceiling: 'draft',
    immutable_rule_ref: 3,
    notes: 'Prepared; submission blocked.',
  }),
  e({
    output_class: 'tax_computation_and_return_working',
    label: 'Tax computation and return workings',
    reserved_act: false,
    worker_maximum_contribution: 'Prepare workings, reconcile to books, run validations',
    accountable_role_ref: 'Tax lead',
    minimum_competency_level: 'L3 to L5',
    gate_behaviour: 'hard_stop',
    autonomy_ceiling: 'draft',
    notes: 'Prepared; submission blocked.',
  }),
  e({
    output_class: 'statutory_filing_submission',
    label: 'Statutory filing submission and declaration',
    reserved_act: true,
    worker_maximum_contribution: 'None beyond the payload',
    accountable_role_ref: 'Licensed or authorised human submitter; accountable owner',
    minimum_competency_level: 'L5 to L6',
    gate_behaviour: 'hard_stop',
    autonomy_ceiling: 'none',
    immutable_rule_ref: 3,
    notes: 'The declaration is a personal legal act.',
  }),
  e({
    output_class: 'einvoice_validation',
    label: 'E-invoice validation and pre-submission check',
    reserved_act: false,
    worker_maximum_contribution: 'Validate, flag, reconcile',
    accountable_role_ref: 'Tax lead',
    minimum_competency_level: 'L3',
    gate_behaviour: 'hard_stop',
    autonomy_ceiling: 'execute',
    notes: 'Validated; transmission to the authority blocked.',
  }),
  e({
    output_class: 'management_report_and_analysis_pack',
    label: 'Management report and analysis pack',
    reserved_act: false,
    worker_maximum_contribution: 'Assemble, compute, draft commentary',
    accountable_role_ref: 'Process owner issues; senior owner owns positions taken',
    minimum_competency_level: 'L3, positions L4 to L5',
    gate_behaviour: 'degrade_to_prepare',
    autonomy_ceiling: 'execute',
    notes: 'Execute for mechanics; Draft-for-review for commentary.',
  }),
  e({
    output_class: 'statutory_financial_statement_component',
    label: 'Statutory financial statement component or disclosure',
    reserved_act: true,
    worker_maximum_contribution: 'Draft disclosures, tag, cross-check consistency',
    accountable_role_ref: 'Financial controller approves content; directors sign',
    minimum_competency_level: 'L5 approves, L6 signs',
    gate_behaviour: 'hard_stop',
    autonomy_ceiling: 'draft',
  }),
  e({
    output_class: 'judgment_going_concern_impairment_provision',
    label: 'Going concern, impairment, provision and similar judgments',
    reserved_act: true,
    worker_maximum_contribution: 'Assemble inputs, present alternatives with basis',
    accountable_role_ref: 'CFO or board as the framework requires',
    minimum_competency_level: 'L5 to L6',
    gate_behaviour: 'hard_stop',
    autonomy_ceiling: 'draft',
    notes: 'Never delegated.',
  }),
  e({
    output_class: 'internal_communication',
    label: 'Internal communication to a verified internal user',
    reserved_act: false,
    worker_maximum_contribution: 'Send within the AS-PPL- registered notification classes',
    accountable_role_ref: "Manager of record for the worker's communications",
    minimum_competency_level: 'L3',
    gate_behaviour: 'class_check_at_send',
    autonomy_ceiling: 'execute',
    notes: 'An unregistered class is dropped and logged.',
  }),
  e({
    output_class: 'external_communication',
    label: 'External communication of any kind',
    reserved_act: true,
    worker_maximum_contribution: 'Draft and hold',
    accountable_role_ref: 'Approver for that communication class per AS-DOA-',
    minimum_competency_level: 'L3 to L5',
    gate_behaviour: 'hard_stop',
    autonomy_ceiling: 'draft',
    immutable_rule_ref: 7,
  }),
  e({
    output_class: 'control_evidence_pack',
    label: 'Control evidence pack for audit',
    reserved_act: false,
    worker_maximum_contribution: 'Assemble evidence with provenance',
    accountable_role_ref: 'Control owner (always human)',
    minimum_competency_level: 'L3',
    gate_behaviour: 'hard_stop',
    autonomy_ceiling: 'execute',
    notes: 'Assembled; attestation blocked.',
  }),
  e({
    output_class: 'control_attestation',
    label: 'Control attestation or certification',
    reserved_act: true,
    worker_maximum_contribution: 'None',
    accountable_role_ref: 'Control owner',
    minimum_competency_level: 'L3 to L5',
    gate_behaviour: 'hard_stop',
    autonomy_ceiling: 'none',
  }),
  e({
    output_class: 'scope_or_configuration_change',
    label: 'Scope, autonomy or configuration change',
    reserved_act: true,
    worker_maximum_contribution: 'Raise a change request',
    accountable_role_ref: 'Accountable owner plus process approver',
    minimum_competency_level: 'L5 to L6',
    gate_behaviour: 'hard_stop',
    autonomy_ceiling: 'none',
    notes: 'AS-SCP-014, AS-SCP-010. The worker cannot change its own scope.',
  }),
  e({
    output_class: 'incident_declaration',
    label: 'Incident declaration and severity assignment',
    reserved_act: false,
    worker_maximum_contribution: 'Declare and propose an initial severity',
    accountable_role_ref: 'Incident manager re-grades; downward only with the accountable owner',
    minimum_competency_level: 'L3 to L5',
    gate_behaviour: 'route_to_supervisor',
    autonomy_ceiling: 'execute',
    notes: 'Declaration accepted; re-grading is human (AS-PPL-130).',
  }),
  e({
    output_class: 'licensed_advice',
    label: 'Advice issued in a licensed capacity',
    reserved_act: true,
    worker_maximum_contribution: 'Draft only',
    accountable_role_ref: 'The licensed practitioner',
    minimum_competency_level: 'L5 to L6',
    gate_behaviour: 'hard_stop',
    autonomy_ceiling: 'draft',
    notes: 'Professional standards treat agent work as staff work.',
  }),
];

export const OUTPUT_CLASS_BY_NAME: ReadonlyMap<string, OutputClassEntry> = new Map(
  OUTPUT_CLASS_REGISTER.map((entry) => [entry.output_class, entry]),
);

/**
 * s.7.3: "If an output class is not in the register, it is reserved by default."
 *
 * So an unknown class returns a synthetic entry with a `none` ceiling, rather
 * than `undefined` that a caller might treat as "no constraint".
 */
export function lookupOutputClass(outputClass: string): OutputClassEntry {
  return (
    OUTPUT_CLASS_BY_NAME.get(outputClass) ?? {
      output_class: outputClass as OutputClass,
      label: `Unregistered class "${outputClass}"`,
      reserved_act: true,
      worker_maximum_contribution: 'None',
      accountable_role_ref: 'Accountable owner',
      minimum_competency_level: 'L5',
      gate_behaviour: 'hard_stop',
      autonomy_ceiling: 'none',
      notes:
        'Not in the register. Reserved by default until the register is extended through ' +
        'change control (file 01 s.7.3).',
    }
  );
}

export const isReservedAct = (outputClass: string): boolean =>
  lookupOutputClass(outputClass).reserved_act;

export const ceilingFor = (outputClass: string): AutonomyLevel | 'none' =>
  lookupOutputClass(outputClass).autonomy_ceiling;
