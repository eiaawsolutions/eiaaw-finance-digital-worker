/**
 * Data sensitivity — file 07 s.3.
 *
 * Four tiers, a 22-class register, and the channel permission matrix. This is
 * the module that stops an evidence bundle reaching WhatsApp.
 *
 * Two rules make it fail closed:
 *
 *   s.3.2 "A field with no tag is treated as Restricted until tagged."
 *   s.3.3 "Passing this matrix never implies the recipient may see the item."
 *         Entitlement is a separate, additional test performed by the policy
 *         engine — this module answers only "may this tier be rendered into
 *         this channel's payload at all".
 */

export const SENSITIVITY_TIERS = ['public', 'internal', 'confidential', 'restricted'] as const;
export type SensitivityTier = (typeof SENSITIVITY_TIERS)[number];

const TIER_RANK: Record<SensitivityTier, number> = {
  public: 0,
  internal: 1,
  confidential: 2,
  restricted: 3,
};

export const CHANNELS = ['email', 'chat', 'telegram', 'whatsapp'] as const;
export type Channel = (typeof CHANNELS)[number];

/** How a class may be rendered, beyond a plain yes/no. */
export type RenderMode =
  | 'allow'
  | 'deny'
  | 'pointer_only' // a notification that work exists; no substance
  | 'step_up' // allowed, but the session must re-authenticate
  | 'masked' // allowed with the value display-masked (e.g. bank account)
  | 'minimised' // allowed with identifiers stripped
  | 'conditional' // allowed only where the named AS- controls are met
  | 'self_only' // allowed only where the datum concerns the recipient
  | 'never'; // absolute prohibition, not a ceiling question

export interface DataClass {
  readonly id: string;
  readonly label: string;
  readonly tier: SensitivityTier;
  readonly typicalSource: string;
  /** Per-channel rendering. Absent channel means `deny`. */
  readonly channels: Readonly<Partial<Record<Channel, RenderMode>>>;
  /** AS- settings that must be satisfied when the mode is `conditional`. */
  readonly conditions?: readonly string[];
  readonly note?: string;
}

const ALL_CHANNELS_ALLOW: Readonly<Record<Channel, RenderMode>> = {
  email: 'allow',
  chat: 'allow',
  telegram: 'allow',
  whatsapp: 'allow',
};

const EMAIL_AND_CONSOLE: Readonly<Partial<Record<Channel, RenderMode>>> = {
  email: 'allow',
  chat: 'allow',
};

/** File 07 s.3.2 — the register, in full. */
export const DATA_CLASSES: Readonly<Record<string, DataClass>> = Object.freeze({
  D01: {
    id: 'D01',
    label: 'Published statutory accounts, filed returns already public, published prices',
    tier: 'public',
    typicalSource: 'L2 or L1',
    channels: ALL_CHANNELS_ALLOW,
    note: 'Verify it is genuinely published before relying on the tier.',
  },
  D02: {
    id: 'D02',
    label: 'Definitions, standards explanations, generic guidance, SOP descriptions',
    tier: 'public',
    typicalSource: 'L2 corpus',
    channels: ALL_CHANNELS_ALLOW,
  },
  D03: {
    id: 'D03',
    label: 'Process status ("the close is at day 4", "the reconciliation is drafted")',
    tier: 'internal',
    typicalSource: 'L5 task state',
    channels: { email: 'allow', chat: 'allow', telegram: 'allow', whatsapp: 'pointer_only' },
  },
  D04: {
    id: 'D04',
    label: 'Aggregated internal metrics with no attribution: queue depth, hand-off counts',
    tier: 'internal',
    typicalSource: 'Observability rail',
    channels: { email: 'allow', chat: 'allow', telegram: 'allow', whatsapp: 'pointer_only' },
  },
  D05: {
    id: 'D05',
    label: 'Non-attributed policy statements, without the value',
    tier: 'internal',
    typicalSource: 'AS- configuration',
    channels: { email: 'allow', chat: 'allow', telegram: 'allow', whatsapp: 'pointer_only' },
  },
  D06: {
    id: 'D06',
    label: 'Named counterparty identity (supplier, customer) in any context',
    tier: 'confidential',
    typicalSource: 'L1 master data',
    channels: EMAIL_AND_CONSOLE,
  },
  D07: {
    id: 'D07',
    label: 'Invoice, PO, GRN and credit note detail, including amounts',
    tier: 'confidential',
    typicalSource: 'L1',
    channels: EMAIL_AND_CONSOLE,
  },
  D08: {
    id: 'D08',
    label: 'Ledger balances, trial balance, ageing, management accounts before publication',
    tier: 'confidential',
    typicalSource: 'L1',
    channels: EMAIL_AND_CONSOLE,
  },
  D09: {
    id: 'D09',
    label: 'Threshold, tolerance and materiality values as configured',
    tier: 'confidential',
    typicalSource: 'AS-RUL-',
    channels: EMAIL_AND_CONSOLE,
    note: 'Disclosure tells an attacker exactly how to stay under a control.',
  },
  D10: {
    id: 'D10',
    label: 'Approval matrix content: who may approve what, up to what value',
    tier: 'confidential',
    typicalSource: 'AS-DOA-',
    channels: EMAIL_AND_CONSOLE,
  },
  D11: {
    id: 'D11',
    label: 'Contract terms, pricing to a named counterparty, rebates, credit limits',
    tier: 'confidential',
    typicalSource: 'L1, DMS',
    channels: EMAIL_AND_CONSOLE,
  },
  D12: {
    id: 'D12',
    label: 'Internal correspondence and reviewer commentary on a draft',
    tier: 'confidential',
    typicalSource: 'Conversation store',
    channels: EMAIL_AND_CONSOLE,
  },
  D13: {
    id: 'D13',
    label: 'Unpublished results, forecasts, budgets, board packs, price-sensitive material',
    tier: 'restricted',
    typicalSource: 'L1, DMS',
    channels: { email: 'conditional', chat: 'step_up' },
    conditions: ['AS-SYS-105', 'AS-SYS-106', 'AS-SYS-097'],
    note: 'May also carry a listed-entity market abuse dimension.',
  },
  D14: {
    id: 'D14',
    label: 'Tax positions, uncertain tax treatments, transfer pricing, authority correspondence',
    tier: 'restricted',
    typicalSource: 'L2 tenant-specific and L1',
    channels: { email: 'conditional', chat: 'step_up' },
    conditions: ['AS-SYS-105', 'AS-SYS-106', 'AS-SYS-097'],
    note: 'Legally privileged in some cases.',
  },
  D15: {
    id: 'D15',
    label: 'Bank account numbers, IBAN, SWIFT/BIC, settlement instructions, mandates, signatories',
    tier: 'restricted',
    typicalSource: 'L1 master data',
    channels: { chat: 'masked' },
    note: 'The direct payment-fraud target. Never a full account number in a message body.',
  },
  D16: {
    id: 'D16',
    label: 'Individual payroll data: salary, bonus, deductions, contributions, bank details',
    tier: 'restricted',
    typicalSource: 'Payroll',
    channels: { chat: 'step_up' },
  },
  D17: {
    id: 'D17',
    label: 'Personal data: name plus identifier, national ID, passport, DOB, address, next of kin',
    tier: 'restricted',
    typicalSource: 'PDPA in scope',
    channels: {
      email: 'minimised',
      chat: 'minimised',
      telegram: 'self_only',
      whatsapp: 'self_only',
    },
    note: 'Business contact only where necessary for the task; identifiers never.',
  },
  D18: {
    id: 'D18',
    label: 'Credentials, tokens, keys, secrets of any kind',
    tier: 'restricted',
    typicalSource: 'Vault',
    channels: { email: 'never', chat: 'never', telegram: 'never', whatsapp: 'never' },
    note: 'Not a ceiling question but an absolute prohibition. Never emitted at all.',
  },
  D19: {
    id: 'D19',
    label: 'Fraud investigation, whistleblowing, disciplinary or grievance material',
    tier: 'restricted',
    typicalSource: 'Handled outside the worker where possible',
    channels: { chat: 'step_up' },
    note: 'Restricted-access workspace only, not the general chat.',
  },
  D20: {
    id: 'D20',
    label: 'Audit findings not yet reported, going-concern doubts, covenant breach analysis',
    tier: 'restricted',
    typicalSource: 'L1, DMS',
    channels: { email: 'conditional', chat: 'step_up' },
    conditions: ['AS-SYS-105', 'AS-SYS-106', 'AS-SYS-097'],
  },
  D21: {
    id: 'D21',
    label: 'Evidence bundles (composite of D06 to D14)',
    tier: 'restricted',
    typicalSource: 'L9',
    channels: { email: 'allow', chat: 'allow' },
    note:
      'Restricted as a composite. A channel that cannot carry a bundle hands up rather than ' +
      'approving on partial information — it is never summarised down to fit.',
  },
  D22: {
    id: 'D22',
    label: 'The immutable audit log and its extracts',
    tier: 'restricted',
    typicalSource: 'Governance rail',
    channels: { chat: 'step_up' },
  },
});

export type DataClassId = keyof typeof DATA_CLASSES;

/** file 07 s.3.2: an untagged field is Restricted. The default fails closed. */
export const UNTAGGED_TIER: SensitivityTier = 'restricted';

export function tierOf(classId: string | undefined): SensitivityTier {
  if (classId === undefined) return UNTAGGED_TIER;
  return DATA_CLASSES[classId]?.tier ?? UNTAGGED_TIER;
}

export const tierRank = (tier: SensitivityTier): number => TIER_RANK[tier];

export const exceedsCeiling = (tier: SensitivityTier, ceiling: SensitivityTier): boolean =>
  TIER_RANK[tier] > TIER_RANK[ceiling];

/** The lowest of a set of ceilings. A conversation's ceiling is min(channels seen). */
export function lowestCeiling(tiers: readonly SensitivityTier[]): SensitivityTier {
  if (tiers.length === 0) return 'public';
  return tiers.reduce((lowest, next) => (TIER_RANK[next] < TIER_RANK[lowest] ? next : lowest));
}

export interface RenderDecision {
  readonly allowed: boolean;
  readonly mode: RenderMode;
  readonly reason: string;
  readonly conditions?: readonly string[];
}

/**
 * May this data class be rendered into this channel's payload at all?
 *
 * Entitlement of the individual recipient is a separate and additional test.
 */
export function canRender(classId: string, channel: Channel): RenderDecision {
  const dataClass = DATA_CLASSES[classId];

  if (!dataClass) {
    return {
      allowed: false,
      mode: 'deny',
      reason:
        `Data class "${classId}" is not in the register. An untagged or unknown class is ` +
        'treated as Restricted and denied on every channel until it is tagged (file 07 s.3.2).',
    };
  }

  const mode = dataClass.channels[channel] ?? 'deny';

  switch (mode) {
    case 'never':
      return {
        allowed: false,
        mode,
        reason: `${dataClass.id} (${dataClass.label}) is never emitted on any channel.`,
      };
    case 'deny':
      return {
        allowed: false,
        mode,
        reason:
          `${dataClass.id} is tier "${dataClass.tier}" and exceeds the ceiling of the ` +
          `${channel} channel. Escalate the channel rather than truncating the payload.`,
      };
    case 'conditional':
      return {
        allowed: true,
        mode,
        reason:
          `${dataClass.id} may be rendered on ${channel} only where ` +
          `${(dataClass.conditions ?? []).join(', ')} are met and the tenant has explicitly ` +
          'enabled it.',
        conditions: dataClass.conditions ?? [],
      };
    default:
      return {
        allowed: true,
        mode,
        reason: `${dataClass.id} may be rendered on ${channel} in mode "${mode}".`,
      };
  }
}

/**
 * Decide for a whole payload. The payload's effective tier is the highest of
 * its parts — a composite is as sensitive as its most sensitive component
 * (file 07 s.3.7, which is why D21 exists as a class of its own).
 */
export function classifyPayload(classIds: readonly string[]): {
  readonly tier: SensitivityTier;
  readonly classes: readonly string[];
} {
  const tier = classIds.reduce<SensitivityTier>((highest, id) => {
    const next = tierOf(id);
    return TIER_RANK[next] > TIER_RANK[highest] ? next : highest;
  }, 'public');
  return { tier, classes: classIds };
}

export interface PayloadRenderDecision {
  readonly allowed: boolean;
  readonly tier: SensitivityTier;
  readonly blockedBy: readonly { classId: string; reason: string }[];
  readonly modes: Readonly<Record<string, RenderMode>>;
  readonly conditions: readonly string[];
}

export function canRenderPayload(
  classIds: readonly string[],
  channel: Channel,
): PayloadRenderDecision {
  const blockedBy: { classId: string; reason: string }[] = [];
  const modes: Record<string, RenderMode> = {};
  const conditions = new Set<string>();

  for (const id of classIds) {
    const decision = canRender(id, channel);
    modes[id] = decision.mode;
    if (!decision.allowed) blockedBy.push({ classId: id, reason: decision.reason });
    for (const c of decision.conditions ?? []) conditions.add(c);
  }

  return {
    allowed: blockedBy.length === 0,
    tier: classifyPayload(classIds).tier,
    blockedBy,
    modes,
    conditions: [...conditions],
  };
}
