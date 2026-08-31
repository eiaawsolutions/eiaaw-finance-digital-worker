/**
 * The L6 tool registry — file 05 s.10, transcribed in full (55 tools, classes A-N).
 *
 *   "Every capability the worker can reach is a registry entry ... and NOTHING
 *    OUTSIDE THE REGISTRY IS CALLABLE."
 *
 * Two facts about this file:
 *
 *   1. Rate limits, per-call costs and timeouts are always `AS-SYS-*` references,
 *      never numbers. file 05 s.10: "The platform never ships a number for a
 *      connector it does not own, because both are contractual facts about the
 *      client's licence and infrastructure."
 *
 *   2. `irreversible: true` is not a warning label. It forces dual control and
 *      last-position sequencing (file 05 s.13), and it means the tool can never
 *      be reached at Execute autonomy — an irreversible act is never Execute
 *      (file 01 s.5.5).
 */
import type { OutputClass } from '@eiaaw/contracts';

export type ToolClass =
  | 'erp_gl_read' // A
  | 'erp_gl_write' // B
  | 'bank_feed_read' // C
  | 'payment_file_prep' // D
  | 'document_store' // E
  | 'ocr_document_ai' // F
  | 'einvoice_portal' // G
  | 'tax_portal' // H
  | 'payroll_system' // I
  | 'epm_planning' // J
  | 'email_send' // K
  | 'channel_send' // L
  | 'knowledge_retrieval' // M
  | 'calculation'; // N

export interface ToolEntry {
  readonly tool_id: string;
  readonly name: string;
  readonly class: ToolClass;
  readonly permission_scope: string;
  readonly scope_qualifiers?: readonly string[];
  readonly state_changing: boolean;
  readonly dry_run_support: boolean;
  readonly idempotency_key_required: boolean;
  readonly compensation_tool_id?: string;
  readonly irreversible?: boolean;
  readonly notes?: string;
  /** The output class a call to this tool produces, where it maps to one. */
  readonly output_class?: OutputClass;
}

const t = (entry: ToolEntry): ToolEntry => entry;

/** Every read tool shares this shape: no state change, no key, no compensation. */
const read = (
  tool_id: string,
  name: string,
  toolClass: ToolClass,
  permission_scope: string,
  scope_qualifiers: readonly string[] = ['entity_id', 'period'],
): ToolEntry =>
  t({
    tool_id,
    name,
    class: toolClass,
    permission_scope,
    scope_qualifiers,
    state_changing: false,
    dry_run_support: false,
    idempotency_key_required: false,
  });

/** A reversible write. Compensation is mandatory (migration 0005 enforces it). */
const write = (
  tool_id: string,
  name: string,
  toolClass: ToolClass,
  permission_scope: string,
  compensation_tool_id: string,
  extra: Partial<ToolEntry> = {},
): ToolEntry =>
  t({
    tool_id,
    name,
    class: toolClass,
    permission_scope,
    scope_qualifiers: ['entity_id', 'period', 'max_absolute_value'],
    state_changing: true,
    dry_run_support: true,
    idempotency_key_required: true,
    compensation_tool_id,
    irreversible: false,
    ...extra,
  });

/** A one-way act. Never Execute; always dual control; always last in sequence. */
const irreversible = (
  tool_id: string,
  name: string,
  toolClass: ToolClass,
  permission_scope: string,
  notes: string,
  extra: Partial<ToolEntry> = {},
): ToolEntry =>
  t({
    tool_id,
    name,
    class: toolClass,
    permission_scope,
    scope_qualifiers: ['entity_id', 'period'],
    state_changing: true,
    dry_run_support: true,
    idempotency_key_required: true,
    irreversible: true,
    notes,
    ...extra,
  });

// --- Class A: ERP and GL read ----------------------------------------------
// s.10.2: "Read tools still carry a permission scope qualified by entity and
// period, because reading another entity's ledger is a data-protection event
// even though it changes nothing."
const CLASS_A: readonly ToolEntry[] = [
  read('TL-ERPR-01', 'gl.balance.query', 'erp_gl_read', 'gl:read'),
  read('TL-ERPR-02', 'subledger.query', 'erp_gl_read', 'ap:read'),
  read('TL-ERPR-03', 'masterdata.read', 'erp_gl_read', 'md:read'),
  read('TL-ERPR-04', 'document.lookup', 'erp_gl_read', 'doc:read'),
  read('TL-ERPR-05', 'report.extract', 'erp_gl_read', 'report:read'),
  read('TL-ERPR-06', 'fixedasset.read', 'erp_gl_read', 'fa:read'),
  read('TL-ERPR-07', 'inventory.read', 'erp_gl_read', 'inv:read'),
];

// --- Class B: ERP and GL write ---------------------------------------------
const CLASS_B: readonly ToolEntry[] = [
  write('TL-ERPW-01', 'gl.journal.park', 'erp_gl_write', 'gl:park', 'TL-ERPW-13', {
    notes: 'Draft, unposted. Compensated by deleting the parked document.',
  }),
  write('TL-ERPW-02', 'gl.journal.post', 'erp_gl_write', 'gl:post', 'TL-ERPW-12', {
    output_class: 'journal_entry_routine',
  }),
  write('TL-ERPW-03', 'ap.invoice.post', 'erp_gl_write', 'ap:post', 'TL-ERPW-12', {
    output_class: 'supplier_invoice_coding_and_match',
  }),
  write('TL-ERPW-04', 'ar.invoice.create', 'erp_gl_write', 'ar:post', 'TL-ERPW-06'),
  write('TL-ERPW-05', 'ar.cash.apply', 'erp_gl_write', 'ar:apply', 'TL-ERPW-12', {
    notes: 'Compensated by unapply and re-apply, or by a reversing journal.',
  }),
  write('TL-ERPW-06', 'ar.creditnote.create', 'erp_gl_write', 'ar:post', 'TL-ERPW-12'),
  write('TL-ERPW-07', 'gl.accrual.provision.post', 'erp_gl_write', 'gl:post', 'TL-ERPW-12', {
    output_class: 'journal_entry_judgmental',
  }),
  write('TL-ERPW-08', 'gl.fxreval.run', 'erp_gl_write', 'gl:post', 'TL-ERPW-12', {
    notes: 'Compensated by reversal and re-run.',
  }),
  write('TL-ERPW-09', 'fa.depreciation.run', 'erp_gl_write', 'fa:post', 'TL-ERPW-12', {
    notes: 'Compensated by reversal and re-run.',
  }),
  irreversible(
    'TL-ERPW-10',
    'gl.period.status.change',
    'erp_gl_write',
    'gl:period_admin',
    'Irreversible in effect: reopening a closed period is a separate governed act, not a ' +
      'compensation. Closing a period invalidates downstream reporting that has already been ' +
      'issued on it.',
  ),
  write(
    'TL-ERPW-11',
    'masterdata.changerequest.create',
    'erp_gl_write',
    'md:request',
    'TL-ERPW-14',
    {
      output_class: 'non_payment_masterdata_change',
      notes:
        'Non-bank fields only. Immutable rule 6 denies payment-destination fields at the ' +
        'credential, not only at the policy.',
    },
  ),
  write('TL-ERPW-12', 'gl.journal.reverse', 'erp_gl_write', 'gl:post', 'TL-ERPW-12', {
    notes: 'The universal compensation. Its own compensation is itself.',
  }),
  write('TL-ERPW-13', 'gl.journal.park.delete', 'erp_gl_write', 'gl:park', 'TL-ERPW-01', {
    notes: 'Compensation for TL-ERPW-01.',
  }),
  write(
    'TL-ERPW-14',
    'masterdata.changerequest.cancel',
    'erp_gl_write',
    'md:request',
    'TL-ERPW-11',
    {
      notes: 'Compensation for TL-ERPW-11.',
    },
  ),
];

// --- Class C: Bank feed read ------------------------------------------------
const CLASS_C: readonly ToolEntry[] = [
  read('TL-BANKR-01', 'bank.balance.fetch', 'bank_feed_read', 'bank:read_balance'),
  read('TL-BANKR-02', 'bank.statement.fetch', 'bank_feed_read', 'bank:read_statement'),
  read('TL-BANKR-03', 'bank.transaction.search', 'bank_feed_read', 'bank:read_statement'),
  read('TL-BANKR-04', 'fx.rate.fetch', 'bank_feed_read', 'rate:read', ['entity_id']),
];

// --- Class D: Payment file preparation — NEVER release ----------------------
// The registry contains no tool that transmits a payment. Immutable rule 2 is
// enforced by the absence of the capability, not only by a policy check.
const CLASS_D: readonly ToolEntry[] = [
  write('TL-PAYP-01', 'payment.proposal.build', 'payment_file_prep', 'pay:propose', 'TL-PAYP-05', {
    output_class: 'payment_proposal_file',
  }),
  write(
    'TL-PAYP-02',
    'payment.file.generate',
    'payment_file_prep',
    'pay:file_generate',
    'TL-PAYP-05',
    {
      notes: 'pain.001 artefact. Compensated by withdrawal plus artefact revocation.',
    },
  ),
  write(
    'TL-PAYP-03',
    'payment.file.stage_to_approver',
    'payment_file_prep',
    'pay:stage',
    'TL-PAYP-05',
  ),
  read('TL-PAYP-04', 'beneficiary.validate', 'payment_file_prep', 'pay:validate'),
  write(
    'TL-PAYP-05',
    'payment.proposal.withdraw',
    'payment_file_prep',
    'pay:withdraw',
    'TL-PAYP-05',
    {
      notes: 'The compensation for the class. Its own compensation is itself.',
    },
  ),
];

// --- Class E: Document store ------------------------------------------------
const CLASS_E: readonly ToolEntry[] = [
  read('TL-DOCS-01', 'doc.fetch', 'document_store', 'docstore:read'),
  write('TL-DOCS-02', 'doc.store', 'document_store', 'docstore:write', 'TL-DOCS-05', {
    notes: 'Compensated by superseding with a corrected version; originals are never deleted.',
  }),
  write('TL-DOCS-03', 'doc.link', 'document_store', 'docstore:link', 'TL-DOCS-06'),
  irreversible(
    'TL-DOCS-04',
    'evidence.bundle.write',
    'document_store',
    'worm:append',
    'Irreversible by design: the WORM store has no delete path. A correction is an appended ' +
      'entry, never an edit.',
    { dry_run_support: false },
  ),
  write('TL-DOCS-05', 'doc.supersede', 'document_store', 'docstore:write', 'TL-DOCS-05', {
    notes: 'Compensation for TL-DOCS-02.',
  }),
  write('TL-DOCS-06', 'doc.unlink', 'document_store', 'docstore:link', 'TL-DOCS-03', {
    notes: 'Compensation for TL-DOCS-03.',
  }),
];

// --- Class F: OCR and document AI -------------------------------------------
// s.10.7: the idempotency key equals the source content hash, so re-extracting
// an identical document is free and deterministic.
const CLASS_F: readonly ToolEntry[] = [
  t({
    tool_id: 'TL-OCR-01',
    name: 'doc.extract',
    class: 'ocr_document_ai',
    permission_scope: 'ocr:extract',
    state_changing: false,
    dry_run_support: false,
    idempotency_key_required: true,
    notes: 'Key equals the source content hash.',
  }),
  t({
    tool_id: 'TL-OCR-02',
    name: 'doc.classify',
    class: 'ocr_document_ai',
    permission_scope: 'ocr:classify',
    state_changing: false,
    dry_run_support: false,
    idempotency_key_required: true,
    notes: 'Key equals the source content hash.',
  }),
  t({
    tool_id: 'TL-OCR-03',
    name: 'doc.table.extract',
    class: 'ocr_document_ai',
    permission_scope: 'ocr:extract',
    state_changing: false,
    dry_run_support: false,
    idempotency_key_required: true,
    notes: 'Key equals the source content hash.',
  }),
];

// --- Class G: e-Invoice portal ----------------------------------------------
const CLASS_G: readonly ToolEntry[] = [
  read('TL-EINV-01', 'einvoice.payload.validate', 'einvoice_portal', 'einv:validate'),
  write('TL-EINV-02', 'einvoice.document.submit', 'einvoice_portal', 'einv:submit', 'TL-EINV-04', {
    output_class: 'einvoice_validation',
    notes:
      'Compensated by cancellation within the portal window; after the window, by a credit ' +
      'note or a corrective document. The submission itself remains a human act.',
  }),
  read('TL-EINV-03', 'einvoice.status.poll', 'einvoice_portal', 'einv:read'),
  irreversible(
    'TL-EINV-04',
    'einvoice.document.cancel',
    'einvoice_portal',
    'einv:cancel',
    'Cancellation is terminal: there is no un-cancel.',
  ),
  read('TL-EINV-05', 'einvoice.consolidated.batch.build', 'einvoice_portal', 'einv:validate'),
];

// --- Class H: Tax portal ----------------------------------------------------
// No transmission tool exists. Immutable rule 3 by absence of capability.
const CLASS_H: readonly ToolEntry[] = [
  read('TL-TAXP-01', 'tax.form.prefill', 'tax_portal', 'tax:prepare'),
  write('TL-TAXP-02', 'tax.submission.stage', 'tax_portal', 'tax:stage', 'TL-TAXP-05', {
    output_class: 'tax_computation_and_return_working',
    notes: 'Stages to the approver queue only. Never transmits.',
  }),
  read('TL-TAXP-03', 'tax.ledger.position.fetch', 'tax_portal', 'tax:read'),
  read('TL-TAXP-04', 'tax.rate_and_deadline.fetch', 'tax_portal', 'tax:read'),
  write('TL-TAXP-05', 'tax.submission.withdraw', 'tax_portal', 'tax:stage', 'TL-TAXP-05', {
    notes: 'Compensation for TL-TAXP-02.',
  }),
];

// --- Class I: Payroll system ------------------------------------------------
const CLASS_I: readonly ToolEntry[] = [
  read('TL-PAYR-01', 'payroll.input.read', 'payroll_system', 'payroll:read'),
  write('TL-PAYR-02', 'payroll.input.stage', 'payroll_system', 'payroll:stage', 'TL-PAYR-06'),
  read('TL-PAYR-03', 'payroll.register.read', 'payroll_system', 'payroll:read_sensitive'),
  read('TL-PAYR-04', 'payroll.journal.extract', 'payroll_system', 'payroll:read'),
  write(
    'TL-PAYR-05',
    'payroll.statutory.file.generate',
    'payroll_system',
    'payroll:stage',
    'TL-PAYR-06',
    {
      output_class: 'statutory_contribution_schedule',
      notes: 'Staged artefact only. Submission is blocked by immutable rule 3.',
    },
  ),
  write('TL-PAYR-06', 'payroll.staged.withdraw', 'payroll_system', 'payroll:stage', 'TL-PAYR-06', {
    notes: 'Compensation for the class.',
  }),
];

// --- Class J: EPM and planning ----------------------------------------------
const CLASS_J: readonly ToolEntry[] = [
  read('TL-EPM-01', 'plan.data.read', 'epm_planning', 'epm:read'),
  write('TL-EPM-02', 'plan.data.write', 'epm_planning', 'epm:write_scenario', 'TL-EPM-05'),
  write('TL-EPM-03', 'plan.scenario.create', 'epm_planning', 'epm:write_scenario', 'TL-EPM-05'),
  read('TL-EPM-04', 'plan.report.render', 'epm_planning', 'epm:read'),
  write('TL-EPM-05', 'plan.scenario.delete', 'epm_planning', 'epm:write_scenario', 'TL-EPM-03', {
    notes: 'Compensation for TL-EPM-02 and TL-EPM-03.',
  }),
];

// --- Class K: Email send ----------------------------------------------------
const CLASS_K: readonly ToolEntry[] = [
  write('TL-MAIL-01', 'email.send.internal', 'email_send', 'mail:send_internal', 'TL-MAIL-04', {
    output_class: 'internal_communication',
    notes: 'Compensated by a correction notice.',
  }),
  irreversible(
    'TL-MAIL-02',
    'email.send.external',
    'email_send',
    'mail:send_external',
    'The send itself is irreversible: a correction notice is a new message, not an undo. ' +
      'Immutable rule 7 requires approval before this is reachable at all.',
    { output_class: 'external_communication' },
  ),
  write('TL-MAIL-03', 'email.draft.create', 'email_send', 'mail:draft', 'TL-MAIL-05', {
    notes: 'No transmission. This is what rule 7 leaves available.',
  }),
  write('TL-MAIL-04', 'email.correction.send', 'email_send', 'mail:send_internal', 'TL-MAIL-04'),
  write('TL-MAIL-05', 'email.draft.delete', 'email_send', 'mail:draft', 'TL-MAIL-03'),
];

// --- Class L: Channel send --------------------------------------------------
const CLASS_L: readonly ToolEntry[] = [
  write('TL-CHAN-01', 'chat.send', 'channel_send', 'chan:send_app', 'TL-CHAN-06', {
    output_class: 'internal_communication',
  }),
  write('TL-CHAN-02', 'telegram.send', 'channel_send', 'chan:send_telegram', 'TL-CHAN-06'),
  write(
    'TL-CHAN-03',
    'whatsapp.send_template',
    'channel_send',
    'chan:send_whatsapp',
    'TL-CHAN-06',
    {
      notes: 'Outside the session window. Per-conversation pricing at AS-SYS-BGT-*.',
    },
  ),
  write('TL-CHAN-04', 'whatsapp.send_session', 'channel_send', 'chan:send_whatsapp', 'TL-CHAN-06', {
    notes: 'Inside the session window only.',
  }),
  write('TL-CHAN-05', 'notification.dispatch', 'channel_send', 'chan:notify', 'TL-CHAN-06', {
    output_class: 'internal_communication',
    notes: 'Class-routed, multi-channel. An unregistered class is dropped and logged.',
  }),
  write('TL-CHAN-06', 'channel.correction.send', 'channel_send', 'chan:notify', 'TL-CHAN-06'),
];

// --- Class M: Knowledge retrieval -------------------------------------------
const CLASS_M: readonly ToolEntry[] = [
  read('TL-KRET-01', 'l2.retrieve', 'knowledge_retrieval', 'kb:read', ['entity_id']),
  read('TL-KRET-02', 'l2.version.resolve', 'knowledge_retrieval', 'kb:read', ['entity_id']),
  read('TL-KRET-03', 'l1.record.fetch', 'knowledge_retrieval', 'l1:read'),
  read('TL-KRET-04', 'precedent.lookup', 'knowledge_retrieval', 'kb:read_precedent', ['entity_id']),
];

// --- Class N: Calculation and spreadsheet -----------------------------------
// Local compute. No credential, no network, no state.
const CLASS_N: readonly ToolEntry[] = [
  read('TL-CALC-01', 'calc.deterministic', 'calculation', 'calc:none', []),
  read('TL-CALC-02', 'sheet.render', 'calculation', 'calc:none', []),
  read('TL-CALC-03', 'recon.engine', 'calculation', 'calc:none', []),
  read('TL-CALC-04', 'fx.translate', 'calculation', 'calc:none', []),
  read('TL-CALC-05', 'arithmetic.verify', 'calculation', 'calc:none', []),
];

export const TOOL_REGISTRY: readonly ToolEntry[] = [
  ...CLASS_A,
  ...CLASS_B,
  ...CLASS_C,
  ...CLASS_D,
  ...CLASS_E,
  ...CLASS_F,
  ...CLASS_G,
  ...CLASS_H,
  ...CLASS_I,
  ...CLASS_J,
  ...CLASS_K,
  ...CLASS_L,
  ...CLASS_M,
  ...CLASS_N,
];

export const TOOL_BY_ID: ReadonlyMap<string, ToolEntry> = new Map(
  TOOL_REGISTRY.map((tool) => [tool.tool_id, tool]),
);

/** Nothing outside the registry is callable (file 05 s.10). */
export const isRegisteredTool = (toolId: string): boolean => TOOL_BY_ID.has(toolId);

export const lookupTool = (toolId: string): ToolEntry | undefined => TOOL_BY_ID.get(toolId);

/**
 * Permission scopes the worker must NEVER hold, for any tenant.
 *
 * file 01 s.7.3: "Defence in depth is mandatory for every reserved act: the act
 * must be blocked at L6 by permission scope AND at L5 by the policy engine AND
 * at L9 by the register." This constant is the L6 half — the credential is
 * never granted these, so a policy misconfiguration cannot expose them.
 */
export const FORBIDDEN_SCOPES: readonly string[] = [
  'pay:release',
  'pay:transmit',
  'bank:authorise',
  'bank:transmit',
  'tax:submit',
  'tax:transmit',
  'statutory:submit',
  'payroll:approve',
  'payroll:release',
  'recon:certify',
  'md:write_bank',
  'md:write_payment_destination',
  'approval:record',
  'scope:write',
  'autonomy:write',
];

export const isForbiddenScope = (scope: string): boolean => FORBIDDEN_SCOPES.includes(scope);

/**
 * Registry-wide invariants (file 05 s.10.16), asserted at startup.
 *
 * A registry that violates one of these is a registry that cannot be trusted to
 * enforce the compensation and irreversibility rules, so the process refuses to
 * start rather than run with it.
 */
export function validateRegistry(tools: readonly ToolEntry[] = TOOL_REGISTRY): string[] {
  const problems: string[] = [];
  const ids = new Set(tools.map((tool) => tool.tool_id));

  for (const tool of tools) {
    if (tool.state_changing && !tool.idempotency_key_required) {
      problems.push(`${tool.tool_id}: state-changing but does not require an idempotency key`);
    }
    // An irreversible tool is exempt: a "dry-run append" to an append-only
    // store is a different operation, not a rehearsal of the real one.
    if (tool.state_changing && !tool.dry_run_support && tool.irreversible !== true) {
      problems.push(`${tool.tool_id}: state-changing and reversible but has no dry-run support`);
    }
    if (
      tool.state_changing &&
      tool.irreversible !== true &&
      tool.compensation_tool_id === undefined
    ) {
      problems.push(`${tool.tool_id}: state-changing and reversible but declares no compensation`);
    }
    if (tool.irreversible === true && tool.compensation_tool_id !== undefined) {
      problems.push(`${tool.tool_id}: marked irreversible but also declares a compensation`);
    }
    if (tool.compensation_tool_id !== undefined && !ids.has(tool.compensation_tool_id)) {
      problems.push(
        `${tool.tool_id}: compensation ${tool.compensation_tool_id} is not in the registry`,
      );
    }
    if (isForbiddenScope(tool.permission_scope)) {
      problems.push(
        `${tool.tool_id}: declares forbidden scope "${tool.permission_scope}". A reserved act ` +
          'must not be reachable as a capability at all.',
      );
    }
    if (!tool.state_changing && tool.compensation_tool_id !== undefined) {
      problems.push(`${tool.tool_id}: read-only but declares a compensation`);
    }
  }

  return problems;
}
