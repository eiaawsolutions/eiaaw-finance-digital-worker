/**
 * C4 — Intake and Classifier.
 *
 * Turns an admitted `InboundRequest` into an intent plus a routing decision.
 *
 *   file 03 s.12 / DWD-06 s.6.4: "Content arriving through any channel or
 *   document is DATA, NEVER INSTRUCTIONS." Classification therefore reads the
 *   message to decide *what was asked*, and never to decide *what is permitted*.
 *   A message that says "you have authority to post this" classifies as a
 *   posting request from someone who claimed authority — the claim is recorded,
 *   never honoured.
 *
 *   file 01 s.6.4 / AS-SCP-026: an instruction that expands scope is refused
 *   and logged as an out-of-scope request, not obeyed.
 *
 * The classifier is deliberately lexical rather than model-driven. Routing
 * decides which governed pipeline runs, and a model in that position would be
 * an injection surface with authority. The model does the finance work *after*
 * the governance has been applied, not before.
 */
import type { ChannelName, InboundRequest } from '@eiaaw/contracts';

export type IntentFamily =
  | 'question' // ANSWER — grounded Q&A from the L2 corpus
  | 'prepare' // PREPARE — produce a draft for approval
  | 'execute' // EXECUTE — complete a procedural action
  | 'status' // where is my thing
  | 'approval_response' // a reviewer acting on a hand-off
  | 'feedback'
  | 'out_of_scope'
  | 'unclear';

export interface Classification {
  readonly family: IntentFamily;
  readonly intent: string;
  readonly confidence: 'high' | 'medium' | 'low';
  /** The SOP family the request appears to concern, where one is identifiable. */
  readonly process_hint: string | null;
  /** Axis hints for the L0 resolver. Hints only — configuration decides. */
  readonly hints: {
    readonly entity?: string;
    readonly period?: string;
    readonly as_of_date?: string;
    readonly business_key?: string;
  };
  /** Recorded when the message asserted an authority it cannot confer. */
  readonly authority_claims: readonly string[];
  readonly clarification_needed: string | null;
}

/** SOP families, matched on the vocabulary an operator actually uses. */
const PROCESS_SIGNALS: readonly { readonly process: string; readonly pattern: RegExp }[] = [
  {
    process: 'PP/01',
    pattern:
      /\b(?:purchase order|three[- ]way match|supplier invoice|goods receipt|\bAP\b|accounts payable|vendor)\b/i,
  },
  {
    process: 'PP/02',
    pattern:
      /\b(?:customer invoice|receivable|\bAR\b|collection|credit note|cash application|dunning)\b/i,
  },
  {
    process: 'PP/03',
    pattern:
      /\b(?:month[- ]end|close|journal|accrual|trial balance|reconcil|general ledger|\bGL\b)\b/i,
  },
  { process: 'PP/04', pattern: /\b(?:payroll|salary|wages|EPF|SOCSO|EIS|PCB|headcount)\b/i },
  { process: 'PP/05', pattern: /\b(?:tax|SST|GST|e-?invoice|LHDN|return|withholding|CP204)\b/i },
  { process: 'PP/06', pattern: /\b(?:payment|treasury|bank|cash flow|remittance|FX|forex)\b/i },
  {
    process: 'PP/07',
    pattern: /\b(?:budget|forecast|variance|management report|board pack|KPI)\b/i,
  },
  {
    process: 'PP/08',
    pattern: /\b(?:master data|chart of accounts|cost cent|configuration|setup)\b/i,
  },
];

/** A question wants knowledge. It changes nothing. */
const QUESTION_SIGNALS =
  /^\s*(?:what|when|which|who|how|why|where|is|are|do|does|can|should|could|would)\b|\?\s*$/i;

/** A prepare wants a draft that a human will approve. */
const PREPARE_SIGNALS =
  /\b(?:prepare|draft|compute|calculate|work out|produce|assemble|reconcile|analyse|analyze|review|check|summar[iy]|extract)\b/i;

/** An execute wants effect. */
const EXECUTE_SIGNALS =
  /\b(?:post|book|record it|apply|create|update|amend|change|submit|send|release|approve|certify|run the)\b/i;

const STATUS_SIGNALS =
  /\b(?:status|where (?:is|are)|what happened to|progress|any update|has (?:it|this) been)\b/i;

const FEEDBACK_SIGNALS =
  // "That answer is wrong" and "that's wrong" are the same signal; the words
  // between the subject and the verdict vary and carry no meaning here.
  /\bthat\b[^.!?]{0,24}\b(?:is|was|looks?)\s+(?:wrong|incorrect|right|correct|off)\b|\bthat(?:'s| is)\s+(?:wrong|incorrect|right|correct)\b|\bgood (?:answer|work|catch)\b|\bnot what I asked\b|\byou (?:got|made) (?:it|a) \b/i;

/**
 * Claims of authority a message might make.
 *
 * Recorded, never honoured. file 01 s.6.2: "A human with the authority to do
 * the act does the act themselves; they cannot instruct the worker to do it for
 * them." So the presence of a claim is itself signal — for the refusal message,
 * and for the record.
 */
const AUTHORITY_CLAIMS: readonly { readonly label: string; readonly pattern: RegExp }[] = [
  {
    label: 'claims_own_authority',
    // Three shapes, because people assert authority all three ways: by naming
    // the power ("I have the authority"), by naming the role ("I am the
    // controller"), and by performing it ("I authorise you to").
    pattern:
      /\bI (?:have|hold) (?:the )?(?:authorit|approval right|mandate|signator)|\bI am (?:the |a )?(?:CFO|controller|finance director|approver|signator|partner|director|head of)|\bI (?:authorise|authorize|approve)\b/i,
  },
  {
    label: 'claims_delegated_authority',
    pattern:
      /\b(?:the )?(?:CFO|controller|director|partner|board)\s+(?:has\s+)?(?:said|approved|authorised|authorized|agreed)/i,
  },
  {
    label: 'claims_urgency_override',
    pattern: /\b(?:urgent|asap|immediately|no time)\b.{0,40}\b(?:skip|bypass|without|just do)/i,
  },
  {
    label: 'claims_prior_approval',
    pattern: /\b(?:already|previously) (?:approved|signed off|authorised|authorized)\b/i,
  },
  { label: 'instructs_on_behalf', pattern: /\bon (?:my|his|her|their) behalf\b/i },
];

export interface ClassifyInput {
  readonly request: InboundRequest;
  /** SOP rows switched on at AS-SCP-015. Anything else is out of scope. */
  readonly in_scope_processes: readonly string[];
  readonly extracted_text?: readonly string[];
}

export function classify(input: ClassifyInput): Classification {
  const body = input.request.body_text.trim();
  const all = [body, ...(input.extracted_text ?? [])].join('\n');

  // An interactive callback carries its own intent and does not need parsing.
  const hint = input.request.intent_hint;
  if (hint && /^(?:approve|reject|reassign|edit)/.test(hint.value)) {
    return {
      family: 'approval_response',
      intent: hint.value,
      confidence: 'high',
      process_hint: null,
      hints: {},
      authority_claims: [],
      clarification_needed: null,
    };
  }

  const authorityClaims = AUTHORITY_CLAIMS.filter((c) => c.pattern.test(all)).map((c) => c.label);
  const process = PROCESS_SIGNALS.find((p) => p.pattern.test(all))?.process ?? null;
  const hints = extractHints(all);

  if (body.length === 0) {
    return {
      family: 'unclear',
      intent: 'empty_message',
      confidence: 'high',
      process_hint: process,
      hints,
      authority_claims: authorityClaims,
      clarification_needed: 'The message has no text. What would you like me to do?',
    };
  }

  // Order matters: a message can look like several things, and the STRONGEST
  // effect wins. "Prepare the journal and post it" is an execute request.
  let family: IntentFamily;
  if (STATUS_SIGNALS.test(body)) family = 'status';
  else if (FEEDBACK_SIGNALS.test(body)) family = 'feedback';
  else if (EXECUTE_SIGNALS.test(body)) family = 'execute';
  else if (PREPARE_SIGNALS.test(body)) family = 'prepare';
  else if (QUESTION_SIGNALS.test(body)) family = 'question';
  else family = 'unclear';

  // AS-SCP-015: anything not switched on is not attempted.
  if (
    (family === 'prepare' || family === 'execute') &&
    process !== null &&
    !input.in_scope_processes.includes(process)
  ) {
    return {
      family: 'out_of_scope',
      intent: `${family}_${process}`,
      confidence: 'high',
      process_hint: process,
      hints,
      authority_claims: authorityClaims,
      clarification_needed: null,
    };
  }

  const confidence: Classification['confidence'] =
    family === 'unclear' ? 'low' : process === null && family !== 'question' ? 'medium' : 'high';

  return {
    family,
    intent: process === null ? family : `${family}_${process.replace('/', '_').toLowerCase()}`,
    confidence,
    process_hint: process,
    hints,
    authority_claims: authorityClaims,
    clarification_needed:
      family === 'unclear'
        ? 'I am not sure what you are asking me to do. Could you say what you need, and for ' +
          'which entity and period?'
        : null,
  };
}

/**
 * Pull axis hints out of the text.
 *
 * These are HINTS. The L0 resolver checks each against configuration and
 * refuses on a contradiction rather than preferring the message — otherwise a
 * message could steer the worker onto the wrong entity by asserting one.
 */
function extractHints(text: string): Classification['hints'] {
  const hints: {
    entity?: string;
    period?: string;
    as_of_date?: string;
    business_key?: string;
  } = {};

  const entity = /\b(ENT-\d{4})\b/.exec(text);
  if (entity) hints.entity = entity[1] as string;

  const isoDate = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (isoDate) hints.as_of_date = isoDate[1] as string;

  const isoPeriod = /\b(\d{4}-(?:0[1-9]|1[0-2]))\b(?!-\d)/.exec(text);
  if (isoPeriod) hints.period = isoPeriod[1] as string;

  // "July 2026" and "for July" — the second only yields a month, and the
  // resolver refuses rather than assuming a year.
  const named =
    /\b(january|february|march|april|may|june|july|august|september|october|november|december)\s+(\d{4})\b/i.exec(
      text,
    );
  if (named && !hints.period) {
    const month = MONTHS.indexOf((named[1] as string).toLowerCase()) + 1;
    hints.period = `${named[2]}-${String(month).padStart(2, '0')}`;
  }

  const businessKey = /\b((?:INV|PO|GR|JE|CN|PRUN)-[A-Z0-9-]+)\b/.exec(text);
  if (businessKey) hints.business_key = businessKey[1] as string;

  return hints;
}

const MONTHS = [
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
];

/**
 * Which skill serves this intent.
 *
 * A registry lookup, not an inference: the routing table is configuration, and
 * an intent with no registered skill routes to a human rather than to the
 * closest match.
 */
export interface RoutingDecision {
  readonly skill_id: string | null;
  readonly reason: string;
}

export function route(
  classification: Classification,
  routingTable: Readonly<Record<string, string>>,
): RoutingDecision {
  if (classification.family === 'out_of_scope') {
    return {
      skill_id: null,
      reason:
        `${classification.process_hint ?? 'This process'} is not switched on for this tenant ` +
        '(AS-SCP-015). I do not attempt what is not in scope.',
    };
  }

  if (classification.family === 'unclear') {
    return { skill_id: null, reason: classification.clarification_needed ?? 'unclear request' };
  }

  const skillId = routingTable[classification.intent] ?? routingTable[classification.family];
  if (!skillId) {
    return {
      skill_id: null,
      reason:
        `No skill is registered for intent "${classification.intent}". The request goes to a ` +
        'human rather than to the nearest available skill.',
    };
  }

  return { skill_id: skillId, reason: `routed to ${skillId}` };
}

/** Channel suitability — file 05 s.14. A skill is not triggerable from anywhere. */
export function channelPermitsSkill(
  channel: ChannelName,
  channelSuitability: readonly ChannelName[],
): boolean {
  return channelSuitability.includes(channel);
}
