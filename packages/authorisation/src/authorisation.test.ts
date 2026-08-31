import { describe, expect, it } from 'vitest';
import { authorise } from './handoff.js';
import { cardFingerprint, generateScopeCard, type ScopeCardInputs } from './scope-card.js';

describe('the authorisation decision (s.3.13)', () => {
  const base = {
    effective_autonomy: 'execute' as const,
    immutable_rule_engaged: null,
    reviewer_action_id: null,
    gates_passed: true,
  };

  it('permits an unreserved class at Execute', () => {
    expect(authorise({ ...base, output_class: 'journal_entry_routine' }).verdict).toBe('may_issue');
  });

  it('requires a human for every reserved act, whatever the autonomy', () => {
    for (const outputClass of [
      'payment_release',
      'statutory_filing_submission',
      'reconciliation_certification',
      'external_communication',
    ] as const) {
      expect(authorise({ ...base, output_class: outputClass }).verdict).toBe('requires_human');
    }
  });

  it('requires a human when an immutable rule engaged', () => {
    const decision = authorise({
      ...base,
      output_class: 'journal_entry_routine',
      immutable_rule_engaged: 2,
    });
    expect(decision.verdict).toBe('requires_human');
    expect(decision.reason).toMatch(/immutable rule 2/);
  });

  it('requires a human when a gate did not pass', () => {
    expect(
      authorise({ ...base, output_class: 'journal_entry_routine', gates_passed: false }).verdict,
    ).toBe('requires_human');
  });

  it('requires a human below Execute autonomy', () => {
    expect(
      authorise({ ...base, output_class: 'journal_entry_routine', effective_autonomy: 'draft' })
        .verdict,
    ).toBe('requires_human');
  });

  it('requires a human when the register caps an UNRESERVED class below Execute', () => {
    // `payroll_computation_and_variance_pack` is not a reserved act — the
    // worker may compute and reconcile it — but the register caps it at Draft.
    // A reserved class would exercise the earlier branch instead.
    const decision = authorise({
      ...base,
      output_class: 'payroll_computation_and_variance_pack',
    });
    expect(decision.verdict).toBe('requires_human');
    expect(decision.reason).toMatch(/caps .* at "draft"/);
  });
});

describe('the Scope Card generator (file 01 s.3)', () => {
  const inputs: ScopeCardInputs = {
    tenant_id: 'tnt_acme',
    worker_display_name: 'Finance Expert',
    worker_version: '1.0.0',
    entity: {
      id: 'ENT-0007',
      name: 'Acme Sdn Bhd',
      jurisdiction: 'MY',
      currency: 'MYR',
      fiscal_year_end: '31 December',
    },
    manager_of_record: { principal_id: 'usr_mgr', name: 'A Manager', role: 'Financial Controller' },
    scope_rows: [
      {
        sop_ref: 'PP/05 s.5',
        procedure_name: 'SST return preparation',
        autonomy: 'draft',
        supervisor_principal_id: 'usr_tax',
        supervisor_name: 'A Tax Lead',
        review_basis: '100% review before effect',
        sample_rate: null,
      },
    ],
    knowledge_domains: [
      { module_id: 'PP/05', corpus_version: '2026.08.1', effective_from: '2026-01-01' },
    ],
    systems_read: [{ system: 'ERP', scope: 'ap:read', state_changing: false }],
    channels: [
      { channel: 'chat', max_sensitivity: 'restricted' },
      { channel: 'email', max_sensitivity: 'confidential' },
    ],
    accountable_humans: Object.fromEntries(
      [
        'cited_answer_informational',
        'cited_answer_material_reliance',
        'journal_entry_routine',
        'journal_entry_judgmental',
        'reconciliation_matching',
        'reconciliation_certification',
        'supplier_invoice_coding_and_match',
        'payment_proposal_file',
        'payment_destination_masterdata_change',
        'non_payment_masterdata_change',
        'payroll_computation_and_variance_pack',
        'statutory_contribution_schedule',
        'tax_computation_and_return_working',
        'einvoice_validation',
        'management_report_and_analysis_pack',
        'statutory_financial_statement_component',
        'judgment_going_concern_impairment_provision',
        'internal_communication',
        'external_communication',
        'control_evidence_pack',
        'incident_declaration',
        'licensed_advice',
      ].map((c) => [c, { principal_id: 'usr_owner', name: 'An Owner', role: 'Controller' }]),
    ),
    confidence_floor: '0.85',
    sod_exclusions: ['preparer_cannot_approve'],
    escalation: { supervisor: 'usr_tax', backup: 'usr_backup', accountable_owner: 'usr_owner' },
    input_versions: { 'AS-SCP': '4', 'AS-DOA': '2', 'AS-PPL': '7' },
    generated_by: 'usr_admin',
    effective_from: '2099-01-01',
  };

  it('generates a card when every reference resolves', () => {
    const result = generateScopeCard(inputs, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.card_version).toBe('1.0.0');
    expect(result.value.content_hash).toMatch(/^sha256:/);
  });

  it('is deterministic — the same inputs produce a byte-identical card', () => {
    const a = generateScopeCard(inputs, null);
    const b = generateScopeCard(inputs, null);
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    // Ids and timestamps differ; the CONTENT must not.
    expect(cardFingerprint(a.value).replace(/"generated_at":"[^"]+"/, '')).toBe(
      cardFingerprint(b.value).replace(/"generated_at":"[^"]+"/, ''),
    );
    expect(a.value.content_hash.length).toBe(b.value.content_hash.length);
  });

  it('fails closed on an unnamed supervisor rather than emitting a placeholder', () => {
    const result = generateScopeCard(
      {
        ...inputs,
        scope_rows: [
          {
            ...(inputs.scope_rows[0] as never),
            supervisor_principal_id: null,
            supervisor_name: null,
          },
        ],
      },
      '1.0.0',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.unresolved[0]).toMatch(/supervisor for PP\/05/);
    expect(result.error.detail).toMatch(/never generated with a placeholder/);
  });

  it('fails closed on a zero sample rate for an Execute row', () => {
    const result = generateScopeCard(
      {
        ...inputs,
        scope_rows: [
          {
            ...(inputs.scope_rows[0] as never),
            autonomy: 'execute',
            sample_rate: '0',
          },
        ],
      },
      '1.0.0',
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.unresolved.some((u) => /sample rate/.test(u))).toBe(true);
  });

  it('fails closed on a missing manager of record', () => {
    const result = generateScopeCard({ ...inputs, manager_of_record: null }, '1.0.0');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.unresolved).toContain('manager of record (AS-PPL-020)');
  });

  it('fails closed on an unresolved accountable human', () => {
    const { journal_entry_routine: _drop, ...rest } = inputs.accountable_humans;
    const result = generateScopeCard({ ...inputs, accountable_humans: rest }, '1.0.0');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.unresolved.some((u) => /journal_entry_routine/.test(u))).toBe(true);
  });

  it('refuses generation attributed to the worker (AS-SCP-014)', () => {
    const result = generateScopeCard({ ...inputs, generated_by: 'worker' }, null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.detail).toMatch(/cannot generate, edit, approve or publish its own card/);
  });

  it('carries the disclosure line and the eleven rules', () => {
    const result = generateScopeCard(inputs, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const header = result.value.content['header'] as Record<string, unknown>;
    expect(String(header['disclosure'])).toMatch(/I am an AI digital worker, not a person/);

    const never = result.value.content['what_i_will_never_do'] as Record<string, unknown>;
    expect((never['immutable_rules'] as unknown[]).length).toBe(11);
  });

  it('does not reproduce threshold values, which could drift', () => {
    const result = generateScopeCard(inputs, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const decide = result.value.content['what_i_may_decide'] as Record<string, unknown>;
    expect(String(decide['note'])).toMatch(/a copy could drift from the value actually in force/);
  });

  it('carries the four reviewer moves and no fifth', () => {
    const result = generateScopeCard(inputs, null);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const signs = result.value.content['where_a_human_signs'] as Record<string, unknown>;
    expect((signs['reviewer_moves'] as unknown[]).length).toBe(4);
  });
});
