import { describe, expect, it } from 'vitest';
import { OUTPUT_CLASSES } from '@eiaaw/contracts';
import {
  OUTPUT_CLASS_REGISTER,
  ceilingFor,
  isReservedAct,
  lookupOutputClass,
} from './output-classes.js';
import {
  FORBIDDEN_SCOPES,
  TOOL_REGISTRY,
  isForbiddenScope,
  isRegisteredTool,
  validateRegistry,
} from './tools.js';
import {
  STANDARD_REVALIDATION_TRIGGERS,
  validateSkillDefinition,
  type SkillDefinition,
} from './skills.js';

describe('the L9 reserved-acts register (file 01 s.7.2)', () => {
  it('covers every output class in the contract enumeration', () => {
    const registered = new Set(OUTPUT_CLASS_REGISTER.map((e) => e.output_class));
    for (const outputClass of OUTPUT_CLASSES) {
      expect(registered, `${outputClass} is missing from the register`).toContain(outputClass);
    }
  });

  it('never gives a reserved act an execute ceiling', () => {
    for (const entry of OUTPUT_CLASS_REGISTER) {
      if (entry.reserved_act) {
        expect(entry.autonomy_ceiling, `${entry.output_class}`).not.toBe('execute');
      }
    }
  });

  it('treats an unregistered class as reserved by default (s.7.3)', () => {
    const entry = lookupOutputClass('some_class_nobody_registered');
    expect(entry.reserved_act).toBe(true);
    expect(entry.autonomy_ceiling).toBe('none');
    expect(entry.gate_behaviour).toBe('hard_stop');
    expect(entry.notes).toMatch(/Reserved by default/);
  });

  it.each([
    ['payment_release', 2],
    ['statutory_filing_submission', 3],
    ['payroll_approval_and_release', 4],
    ['reconciliation_certification', 5],
    ['payment_destination_masterdata_change', 6],
    ['external_communication', 7],
  ] as const)('%s cites immutable rule %i', (outputClass, ruleNumber) => {
    expect(lookupOutputClass(outputClass).immutable_rule_ref).toBe(ruleNumber);
  });

  it('gives the four never-applicable classes a ceiling of none', () => {
    for (const outputClass of [
      'payment_release',
      'payroll_approval_and_release',
      'statutory_filing_submission',
      'control_attestation',
      'scope_or_configuration_change',
    ] as const) {
      expect(ceilingFor(outputClass), outputClass).toBe('none');
    }
  });

  it('permits Execute where the register does', () => {
    expect(ceilingFor('journal_entry_routine')).toBe('execute');
    expect(isReservedAct('journal_entry_routine')).toBe(false);
    // Matching may complete; certification is blocked.
    expect(ceilingFor('reconciliation_matching')).toBe('execute');
    expect(ceilingFor('reconciliation_certification')).toBe('draft');
  });
});

describe('the L6 tool registry (file 05 s.10)', () => {
  it('satisfies every registry-wide invariant', () => {
    expect(validateRegistry()).toEqual([]);
  });

  it('registers the full catalogue across all fourteen classes', () => {
    const classes = new Set(TOOL_REGISTRY.map((t) => t.class));
    expect(classes.size).toBe(14);
    expect(TOOL_REGISTRY.length).toBeGreaterThanOrEqual(55);
  });

  it('has unique tool ids', () => {
    const ids = TOOL_REGISTRY.map((t) => t.tool_id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('requires an idempotency key on every state-changing tool', () => {
    for (const tool of TOOL_REGISTRY) {
      if (tool.state_changing) {
        expect(tool.idempotency_key_required, tool.tool_id).toBe(true);
      }
    }
  });

  it('gives every reversible state-changing tool a registered compensation', () => {
    const ids = new Set(TOOL_REGISTRY.map((t) => t.tool_id));
    for (const tool of TOOL_REGISTRY) {
      if (tool.state_changing && tool.irreversible !== true) {
        expect(tool.compensation_tool_id, tool.tool_id).toBeDefined();
        expect(ids, tool.tool_id).toContain(tool.compensation_tool_id);
      }
    }
  });

  it('marks the four genuinely one-way tools irreversible', () => {
    const irreversible = TOOL_REGISTRY.filter((t) => t.irreversible === true).map((t) => t.tool_id);
    expect(irreversible).toContain('TL-ERPW-10'); // period close
    expect(irreversible).toContain('TL-DOCS-04'); // WORM append
    expect(irreversible).toContain('TL-EINV-04'); // e-invoice cancellation
    expect(irreversible).toContain('TL-MAIL-02'); // external send
  });

  // Immutable rules 2, 3, 4, 5 are enforced by the ABSENCE of the capability,
  // not only by a policy check. This is the L6 half of defence in depth.
  it('contains no tool that releases a payment', () => {
    const names = TOOL_REGISTRY.map((t) => t.name);
    expect(names).not.toContain('payment.release');
    expect(names).not.toContain('payment.file.transmit');
    expect(names).not.toContain('bank.payment.authorise');
  });

  it('contains no tool that transmits a statutory filing', () => {
    const names = TOOL_REGISTRY.map((t) => t.name);
    expect(names).not.toContain('tax.submission.transmit');
    expect(names).not.toContain('tax.return.submit');
  });

  it('contains no tool that approves payroll or certifies a reconciliation', () => {
    const names = TOOL_REGISTRY.map((t) => t.name);
    expect(names).not.toContain('payroll.run.approve');
    expect(names).not.toContain('recon.certify');
  });

  it('declares no forbidden permission scope', () => {
    for (const tool of TOOL_REGISTRY) {
      expect(isForbiddenScope(tool.permission_scope), tool.tool_id).toBe(false);
    }
  });

  it('lists the scopes the worker must never hold', () => {
    expect(FORBIDDEN_SCOPES).toContain('pay:release');
    expect(FORBIDDEN_SCOPES).toContain('tax:submit');
    expect(FORBIDDEN_SCOPES).toContain('payroll:approve');
    expect(FORBIDDEN_SCOPES).toContain('recon:certify');
    expect(FORBIDDEN_SCOPES).toContain('md:write_payment_destination');
    expect(FORBIDDEN_SCOPES).toContain('approval:record');
    expect(FORBIDDEN_SCOPES).toContain('scope:write');
  });

  it('rejects anything not in the registry', () => {
    expect(isRegisteredTool('TL-ERPW-02')).toBe(true);
    expect(isRegisteredTool('TL-EVIL-99')).toBe(false);
  });

  it('detects a registry that violates its invariants', () => {
    const problems = validateRegistry([
      {
        tool_id: 'TL-BAD-01',
        name: 'bad.tool',
        class: 'erp_gl_write',
        permission_scope: 'gl:post',
        state_changing: true,
        dry_run_support: true,
        idempotency_key_required: false,
        compensation_tool_id: 'TL-MISSING-99',
      },
    ]);
    expect(problems.some((p) => /idempotency key/.test(p))).toBe(true);
    expect(problems.some((p) => /not in the registry/.test(p))).toBe(true);
  });
});

describe('skill definition validation (file 05 s.2.3)', () => {
  const validSkill: SkillDefinition = {
    skill_id: 'SK-P2P-05',
    semantic_version: '2.1.0',
    purpose:
      'Perform the three-way match between purchase order, goods receipt and supplier ' +
      'invoice for a single invoice, and classify any mismatch into the SOP exception taxonomy.',
    role_level: 'AP Accountant',
    role_ref: 'RR/01#accounts-payable',
    source_sop: {
      module: '01-procure-to-pay.md',
      sections: ['5'],
      steps_covered: ['5.1', '5.2', '5.3'],
      sop_content_hash: `sha256:${'a'.repeat(64)}`,
    },
    required_knowledge: [
      {
        query_template:
          'three-way match tolerance and exception taxonomy for {entity} under {framework}',
        l2_modules: ['process and procedure/01-procure-to-pay.md#5'],
        min_effective_from: 'as_of_date',
        pin_policy: 'pin_version_for_graph_lifetime',
        on_missing: 'refuse',
      },
    ],
    required_tools: [{ tool_id: 'TL-ERPR-02', permission_scope: 'ap:read', required: true }],
    input_schema: {},
    output_schema: {},
    quality_criteria: [
      'Every matched line cites the PO line ID, the GR line ID and the invoice line ID',
      'Every tolerance applied cites AS-RUL-* by field ID',
    ],
    accuracy_metric: 'exception_classification_accuracy',
    accuracy_floor_ref: 'AS-SCP-030',
    accuracy_measurement: 'golden suite plus practitioner benchmark, rolling 100 items or 30 days',
    breach_action: 'pull_back_one_level',
    revalidation_triggers: [...STANDARD_REVALIDATION_TRIGGERS],
    max_autonomy: 'execute',
    state_changing: true,
    output_class: 'supplier_invoice_coding_and_match',
    accountable_human_ref: 'AS-PPL-010',
    compensation: 'TL-ERPW-12 reversing journal against the same business key',
    irreversible: false,
    channel_suitability: ['chat', 'email'],
    cost_envelope_ref: 'AS-SYS-BGT-001',
    status: 'active',
  };

  it('accepts a well-formed definition', () => {
    expect(validateSkillDefinition(validSkill)).toEqual([]);
  });

  it('rejects a threshold value literal', () => {
    const problems = validateSkillDefinition({
      ...validSkill,
      quality_criteria: ['Variance within tolerance: 500 is accepted'],
    });
    expect(problems.some((p) => /threshold value literal/.test(p.problem))).toBe(true);
  });

  it('rejects a monetary literal', () => {
    const problems = validateSkillDefinition({
      ...validSkill,
      purpose: 'Match invoices below MYR 5000 automatically.',
    });
    expect(problems.some((p) => /monetary literal/.test(p.problem))).toBe(true);
  });

  it('rejects a statutory rate literal', () => {
    const problems = validateSkillDefinition({
      ...validSkill,
      quality_criteria: ['Apply SST at 6 per cent to the taxable amount'],
    });
    expect(problems.some((p) => /statutory rate/.test(p.problem))).toBe(true);
  });

  it('rejects a channel-specific branch', () => {
    const problems = validateSkillDefinition({
      ...validSkill,
      purpose: 'Summarise the match, and if channel == telegram omit the line detail.',
    });
    expect(problems.some((p) => /channel-specific branch/.test(p.problem))).toBe(true);
  });

  it('rejects a fallback that lowers grounding', () => {
    const problems = validateSkillDefinition({
      ...validSkill,
      quality_criteria: ['Where no chunk is found, fall back to an uncited best-effort answer'],
    });
    expect(problems.some((p) => /lowers grounding/.test(p.problem))).toBe(true);
  });

  it('rejects a person’s name', () => {
    const problems = validateSkillDefinition({
      ...validSkill,
      purpose: 'Prepare the match for review by Encik Azlan before posting.',
    });
    expect(problems.some((p) => /person's name/.test(p.problem))).toBe(true);
  });

  it('rejects an accuracy floor expressed as a number', () => {
    const problems = validateSkillDefinition({ ...validSkill, accuracy_floor_ref: '0.95' });
    expect(problems.some((p) => p.field === 'accuracy_floor_ref')).toBe(true);
  });

  it('rejects an accountable human that is not an AS-PPL pointer', () => {
    const problems = validateSkillDefinition({
      ...validSkill,
      accountable_human_ref: 'Siti Rahman',
    });
    expect(problems.some((p) => p.field === 'accountable_human_ref')).toBe(true);
  });

  it('rejects on_missing other than refuse', () => {
    const problems = validateSkillDefinition({
      ...validSkill,
      required_knowledge: [
        { ...(validSkill.required_knowledge[0] as never), on_missing: 'best_effort' as never },
      ],
    });
    expect(problems.some((p) => /CITE OR REFUSE/.test(p.problem))).toBe(true);
  });

  it('rejects a state-changing skill with neither compensation nor irreversibility', () => {
    const problems = validateSkillDefinition({
      ...validSkill,
      compensation: null,
      irreversible: false,
    });
    expect(problems.some((p) => p.field === 'compensation')).toBe(true);
  });

  it('accepts a state-changing skill that declares itself irreversible', () => {
    expect(
      validateSkillDefinition({ ...validSkill, compensation: null, irreversible: true }),
    ).toEqual([]);
  });

  it('rejects a definition that omits a standard revalidation trigger', () => {
    const problems = validateSkillDefinition({
      ...validSkill,
      revalidation_triggers: ['accuracy_floor_breach'],
    });
    expect(problems.some((p) => p.field === 'revalidation_triggers')).toBe(true);
  });
});
