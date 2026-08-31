import { describe, expect, it } from 'vitest';
import {
  renderNotification,
  renderResponse,
  validateResponseContract,
  type ResponseParts,
} from './response-contract.js';

const parts: ResponseParts = {
  answer: 'Output tax is accounted for in the taxable period in which the supply occurs [ck_9912].',
  citations: [
    {
      chunk_id: 'ck_9912',
      module_id: 'PP/05',
      version: '3.2.0',
      effective_from: '2026-01-01',
      locator: 's.5.4',
    },
  ],
  status: {
    service_class: 'ANSWER',
    as_of_date: '2026-07-31',
    entity: 'ENT-0007',
    framework: 'MFRS',
    confidence: '0.91',
  },
  exclusions: ['Imported services are not covered; that is a separate treatment.'],
  next_action: {
    what: 'Confirm this with your tax lead before relying on it for a material decision.',
    who: { name: 'A Tax Lead', role: 'Tax Lead' },
    where: 'the console',
  },
  worker_name: 'Finance Expert',
  scope_card_version: '1.2.0',
  scope_card_url: 'https://console.example/scope-card',
};

describe('the response contract (file 04 s.1)', () => {
  it('accepts a complete response', () => {
    expect(validateResponseContract(parts).complete).toBe(true);
  });

  it.each([
    ['answer', { answer: '' }],
    ['status_and_limits', { status: undefined }],
    ['next_action_and_owner', { next_action: undefined }],
  ])('refuses a response missing %s', (element, override) => {
    const result = validateResponseContract({ ...parts, ...(override as object) });
    expect(result.complete).toBe(false);
    expect(result.missing).toContain(element);
  });

  it('refuses a response with no basis at all', () => {
    const result = validateResponseContract({ ...parts, citations: [], records: [] });
    expect(result.missing).toContain('basis_and_citations');
  });

  it('accepts records as the basis where there are no citations', () => {
    const result = validateResponseContract({
      ...parts,
      citations: [],
      records: [
        {
          source_system_id: 'erp_prod',
          record_type: 'gl_balance',
          extracted_at: '2026-07-31T00:00:00+00:00',
        },
      ],
    });
    expect(result.complete).toBe(true);
  });

  it('does not require citations on a refusal', () => {
    // A refusal asserts nothing about the world, so it has nothing to cite.
    const result = validateResponseContract({
      ...parts,
      answer: 'I cannot answer this from the corpus.',
      citations: [],
      records: [],
    });
    expect(result.complete).toBe(true);
  });

  it('distinguishes an EMPTY exclusions list from an ABSENT one', () => {
    // "Nothing was excluded" is a statement. A missing section is a gap, and a
    // reader cannot tell the two apart once it is rendered.
    expect(validateResponseContract({ ...parts, exclusions: [] }).complete).toBe(true);
    expect(validateResponseContract({ ...parts, exclusions: undefined }).missing).toContain(
      'exclusions',
    );
  });
});

describe('rendering', () => {
  it('renders all five elements in order', () => {
    const { body } = renderResponse(parts, 'chat');
    const positions = ['Basis', 'Status', 'Not covered', 'Next'].map((h) => body.indexOf(h));
    expect(positions.every((p) => p > 0)).toBe(true);
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it('states the version and effective date of every citation', () => {
    const { body } = renderResponse(parts, 'chat');
    expect(body).toContain('version 3.2.0');
    expect(body).toContain('in force from 2026-01-01');
  });

  it('says what an ANSWER is and is not', () => {
    const { body } = renderResponse(parts, 'chat');
    expect(body).toMatch(/changes nothing and is not a decision/);
  });

  it('says a PREPARE has no effect until approved', () => {
    const { body } = renderResponse(
      { ...parts, status: { ...parts.status, service_class: 'PREPARE' } },
      'chat',
    );
    expect(body).toMatch(/no effect until the named person approves it/);
  });

  it('renders an explicit line when nothing was excluded', () => {
    const { body } = renderResponse({ ...parts, exclusions: [] }, 'chat');
    expect(body).toContain('Nothing was deliberately excluded');
  });

  it('surfaces a degradation reason', () => {
    const { body } = renderResponse(
      {
        ...parts,
        status: {
          ...parts.status,
          service_class: 'PREPARE',
          degraded_reason:
            'I prepared this rather than completing it, because a limit was not met.',
        },
      },
      'chat',
    );
    expect(body).toMatch(/prepared this rather than completing it/);
  });

  // file 01 s.13.1 — unconditional, on every message, on every channel.
  it('identifies the worker and links the Scope Card on every channel', () => {
    for (const channel of ['email', 'chat', 'telegram', 'whatsapp'] as const) {
      const { body } = renderResponse(parts, channel);
      expect(body).toContain('a digital worker');
      expect(body).toContain('Scope Card 1.2.0');
      expect(body).toContain('https://console.example/scope-card');
    }
  });

  it('gives email a subject that states the decision needed', () => {
    const prepared = renderResponse(
      { ...parts, status: { ...parts.status, service_class: 'PREPARE' } },
      'email',
    );
    expect(prepared.subject).toMatch(/^\[For approval\]/);

    const executed = renderResponse(
      { ...parts, status: { ...parts.status, service_class: 'EXECUTE' } },
      'email',
    );
    expect(executed.subject).toMatch(/^\[Completed\]/);
  });

  it('gives a chat message no subject', () => {
    expect(renderResponse(parts, 'chat').subject).toBeUndefined();
  });
});

describe('consumer-channel notifications (file 02 s.5)', () => {
  it('carries a summary and a link, never the substance', () => {
    const body = renderNotification({
      output_class: 'tax_computation_and_return_working',
      summary: 'The SST return working for July is ready for your review.',
      deep_link: 'https://console.example/handoff/hnd_1',
      worker_name: 'Finance Expert',
      sensitivity: 'internal',
    });

    expect(body).toContain('ready for your review');
    expect(body).toContain('https://console.example/handoff/hnd_1');
    // It says WHY it is thin, rather than appearing to be a complete answer.
    expect(body).toMatch(/this channel is not approved to carry it/);
  });
});
