/**
 * The response contract — file 04 s.1, DWD-06 s.3.15.
 *
 *   "All five elements of the response contract present, or THE DELIVERY IS
 *    REFUSED."
 *
 * The five:
 *   1. Answer                  what was asked, answered
 *   2. Basis and citations     what it rests on, with version and effective date
 *   3. Status and limits       what state this is in, and what bounded it
 *   4. Exclusions              what was deliberately NOT covered
 *   5. Next action and owner   who does what next, named
 *
 * Element 4 is the one most often omitted and the one that does most work: an
 * answer that does not say what it left out invites the reader to assume it
 * covered everything.
 */
import type { OutputClass, SensitivityTierName } from '@eiaaw/contracts';

export interface ResponseParts {
  readonly answer: string;
  readonly citations: readonly {
    readonly chunk_id: string;
    readonly module_id: string;
    readonly version: string;
    readonly effective_from: string;
    readonly locator: string;
  }[];
  readonly records?: readonly {
    readonly source_system_id: string;
    readonly record_type: string;
    readonly extracted_at: string;
  }[];
  readonly status: {
    readonly service_class: 'ANSWER' | 'PREPARE' | 'EXECUTE';
    readonly as_of_date: string;
    readonly entity: string;
    readonly framework: string;
    readonly confidence?: string;
    /** Set when the output was degraded, e.g. Execute → Prepare. */
    readonly degraded_reason?: string;
  };
  readonly exclusions: readonly string[];
  readonly next_action: {
    readonly what: string;
    readonly who: { readonly name: string; readonly role: string };
    readonly where: string;
    readonly by_when?: string;
  };
  readonly worker_name: string;
  readonly scope_card_version: string;
  readonly scope_card_url: string;
}

export interface ContractValidation {
  readonly complete: boolean;
  readonly missing: readonly string[];
}

/**
 * Validate before rendering.
 *
 * A delivery missing an element is refused rather than sent with a gap, because
 * the reader cannot tell the difference between "there were no exclusions" and
 * "nobody wrote the exclusions down".
 */
export function validateResponseContract(parts: Partial<ResponseParts>): ContractValidation {
  const missing: string[] = [];

  if (!parts.answer || parts.answer.trim().length === 0) missing.push('answer');

  // A refusal legitimately has no citations — it asserts nothing.
  const isRefusal = parts.answer !== undefined && /^I cannot /m.test(parts.answer);
  if (!isRefusal && (!parts.citations || parts.citations.length === 0)) {
    if (!parts.records || parts.records.length === 0) {
      missing.push('basis_and_citations');
    }
  }

  if (!parts.status) missing.push('status_and_limits');
  // An empty array is a valid, deliberate statement; an absent one is not.
  if (parts.exclusions === undefined) missing.push('exclusions');
  if (!parts.next_action) missing.push('next_action_and_owner');

  return { complete: missing.length === 0, missing };
}

/**
 * Render for a channel.
 *
 * file 02 s.6.2: channel-specific rendering belongs to the adapter layer, and
 * the SHAPE is the same everywhere — a reader must recognise the same five
 * elements whichever channel they are reading on.
 */
export function renderResponse(
  parts: ResponseParts,
  channel: 'email' | 'chat' | 'telegram' | 'whatsapp',
): { subject?: string; body: string } {
  const sections: string[] = [];

  // 1. Answer
  sections.push(parts.answer.trim());

  // 2. Basis and citations
  if (parts.citations.length > 0 || (parts.records?.length ?? 0) > 0) {
    const lines: string[] = ['Basis'];
    for (const citation of parts.citations) {
      lines.push(
        `  ${citation.module_id} ${citation.locator} — version ${citation.version}, ` +
          `in force from ${citation.effective_from}`,
      );
    }
    for (const record of parts.records ?? []) {
      lines.push(`  ${record.source_system_id}/${record.record_type}, read ${record.extracted_at}`);
    }
    sections.push(lines.join('\n'));
  }

  // 3. Status and limits
  const status: string[] = [
    'Status',
    `  This is ${describeClass(parts.status.service_class)}.`,
    `  Prepared for ${parts.status.entity} under ${parts.status.framework}, ` +
      `as at ${parts.status.as_of_date}.`,
  ];
  if (parts.status.confidence) status.push(`  Confidence: ${parts.status.confidence}.`);
  if (parts.status.degraded_reason) status.push(`  ${parts.status.degraded_reason}`);
  sections.push(status.join('\n'));

  // 4. Exclusions — always present, even when empty
  sections.push(
    parts.exclusions.length === 0
      ? 'Not covered\n  Nothing was deliberately excluded from this.'
      : ['Not covered', ...parts.exclusions.map((e) => `  ${e}`)].join('\n'),
  );

  // 5. Next action and owner
  const next: string[] = [
    'Next',
    `  ${parts.next_action.what}`,
    `  Owner: ${parts.next_action.who.name} (${parts.next_action.who.role})`,
    `  Where: ${parts.next_action.where}`,
  ];
  if (parts.next_action.by_when) next.push(`  By: ${parts.next_action.by_when}`);
  sections.push(next.join('\n'));

  // The identification is unconditional (file 01 s.13.1): every message, every
  // channel, says what produced it and links to what it is allowed to do.
  sections.push(
    `— ${parts.worker_name}, a digital worker. Scope Card ${parts.scope_card_version}: ` +
      parts.scope_card_url,
  );

  const body = sections.join('\n\n');

  if (channel === 'email') {
    return {
      subject: subjectFor(parts),
      body,
    };
  }

  return { body };
}

function describeClass(serviceClass: ResponseParts['status']['service_class']): string {
  switch (serviceClass) {
    case 'ANSWER':
      return 'an answer. It changes nothing and is not a decision';
    case 'PREPARE':
      return 'a proposal. It has no effect until the named person approves it';
    case 'EXECUTE':
      return 'a completed action, taken within the configured limits and sampled afterwards';
  }
}

function subjectFor(parts: ResponseParts): string {
  const first = parts.answer.split(/[.\n]/)[0]?.trim() ?? 'Response';
  const prefix =
    parts.status.service_class === 'PREPARE'
      ? '[For approval] '
      : parts.status.service_class === 'EXECUTE'
        ? '[Completed] '
        : '';
  return `${prefix}${first.slice(0, 120)}`;
}

/**
 * A consumer-channel notification.
 *
 * file 02 s.5: Telegram and WhatsApp get "a bundle summary plus link only". The
 * substance stays on a channel that can carry it, and the notification says
 * where to find it rather than paraphrasing it.
 */
export function renderNotification(input: {
  readonly output_class: OutputClass;
  readonly summary: string;
  readonly deep_link: string;
  readonly worker_name: string;
  readonly sensitivity: SensitivityTierName;
}): string {
  return [
    input.summary,
    '',
    `Open it here: ${input.deep_link}`,
    '',
    `— ${input.worker_name}. The detail stays in the console: this channel is not approved ` +
      'to carry it.',
  ].join('\n');
}
