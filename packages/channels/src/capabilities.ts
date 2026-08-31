/**
 * The four channel capability objects — file 02 s.1, DWD-06 s.4.1, s.4.3.
 *
 * Every provider-specific number here is marked `[UNVERIFIED as at 2026-08-29]`
 * in the spec and belongs in `AS-SYS-*` at build time. The values below are the
 * documented shapes; `withTenantOverrides` applies the client's own, and can
 * only ever LOWER a ceiling — never raise one, because a tenant cannot grant
 * itself a capability the platform withholds.
 */
import type { SensitivityTierName } from '@eiaaw/contracts';
import type { ChannelCapabilities } from './adapter.js';

/**
 * Email — file 02 s.2.
 *
 * The primary evidence-bundle channel: strong identity through domain
 * verification, attachments in native form, and threading that survives a
 * multi-day approval.
 */
export const EMAIL_CAPABILITIES: ChannelCapabilities = {
  channel: 'email',
  max_body_chars: 100_000,
  supports_attachments: true,
  max_attachment_bytes: 25 * 1024 * 1024,
  supports_rich_blocks: true,
  supports_interactive_controls: 'limited', // reply-keyword grammar, not buttons
  supports_streaming: false,
  identity_strength: 'high',
  sensitivity_ceiling: 'confidential',
  supports_proactive: 'always',
  supports_delivery_receipt: true,
  supports_read_receipt: false,
  session_window: null,
  template_required_outside_window: false,
  can_carry_evidence_bundle: true,
  can_carry_approval: true,
};

/**
 * In-app chat — file 02 s.3.
 *
 * "The only channel that may carry every output class." OIDC session, native
 * approval controls, an inline diff editor, and streaming.
 */
export const CHAT_CAPABILITIES: ChannelCapabilities = {
  channel: 'chat',
  max_body_chars: 500_000,
  supports_attachments: true,
  max_attachment_bytes: 100 * 1024 * 1024,
  supports_rich_blocks: true,
  supports_interactive_controls: 'full',
  supports_streaming: true,
  identity_strength: 'high',
  // The only channel that reaches Restricted, and then only with step-up.
  sensitivity_ceiling: 'restricted',
  supports_proactive: 'always',
  supports_delivery_receipt: true,
  supports_read_receipt: true,
  session_window: null,
  template_required_outside_window: false,
  can_carry_evidence_bundle: true,
  can_carry_approval: true,
};

/**
 * Telegram — file 02 s.4.
 *
 * Notification and quick query. A bundle summary plus a link, never the bundle:
 * the binding ceremony gives medium identity strength, which is not enough to
 * approve on.
 */
export const TELEGRAM_CAPABILITIES: ChannelCapabilities = {
  channel: 'telegram',
  max_body_chars: 4096,
  supports_attachments: true,
  max_attachment_bytes: 50 * 1024 * 1024,
  supports_rich_blocks: false,
  supports_interactive_controls: 'limited',
  supports_streaming: false,
  identity_strength: 'medium',
  sensitivity_ceiling: 'internal',
  supports_proactive: 'always',
  supports_delivery_receipt: true,
  supports_read_receipt: false,
  session_window: null,
  template_required_outside_window: false,
  can_carry_evidence_bundle: false,
  can_carry_approval: false,
};

/**
 * WhatsApp — file 02 s.5.
 *
 * The lowest ceiling of the four. Notification and light query only, a 24-hour
 * session window, and an approved template required outside it.
 */
export const WHATSAPP_CAPABILITIES: ChannelCapabilities = {
  channel: 'whatsapp',
  max_body_chars: 4096,
  supports_attachments: true,
  max_attachment_bytes: 16 * 1024 * 1024,
  supports_rich_blocks: false,
  supports_interactive_controls: 'limited',
  supports_streaming: false,
  identity_strength: 'medium',
  sensitivity_ceiling: 'internal',
  supports_proactive: 'template_only',
  supports_delivery_receipt: true,
  supports_read_receipt: true,
  session_window: 'PT24H',
  template_required_outside_window: true,
  can_carry_evidence_bundle: false,
  can_carry_approval: false,
};

export const ALL_CAPABILITIES: readonly ChannelCapabilities[] = [
  CHAT_CAPABILITIES,
  EMAIL_CAPABILITIES,
  TELEGRAM_CAPABILITIES,
  WHATSAPP_CAPABILITIES,
];

const TIER_RANK = { public: 0, internal: 1, confidential: 2, restricted: 3 } as const;

/**
 * Apply the tenant's own limits from `AS-PPL-097` and `AS-SYS-*`.
 *
 * A ceiling may only be LOWERED. file 07 s.3.1: a tenant "may not add a tier
 * below Restricted or RAISE A PLATFORM CEILING" — so an override that would
 * widen a channel is silently clamped rather than honoured.
 */
export function withTenantOverrides(
  base: ChannelCapabilities,
  overrides: Partial<{
    sensitivity_ceiling: SensitivityTierName;
    max_body_chars: number;
    max_attachment_bytes: number;
    session_window: string;
    can_carry_evidence_bundle: boolean;
    can_carry_approval: boolean;
  }>,
): ChannelCapabilities {
  const ceiling =
    overrides.sensitivity_ceiling !== undefined &&
    TIER_RANK[overrides.sensitivity_ceiling] < TIER_RANK[base.sensitivity_ceiling]
      ? overrides.sensitivity_ceiling
      : base.sensitivity_ceiling;

  return {
    ...base,
    sensitivity_ceiling: ceiling,
    max_body_chars: Math.min(base.max_body_chars, overrides.max_body_chars ?? base.max_body_chars),
    max_attachment_bytes: Math.min(
      base.max_attachment_bytes,
      overrides.max_attachment_bytes ?? base.max_attachment_bytes,
    ),
    session_window: overrides.session_window ?? base.session_window,
    // A capability can be withdrawn, never granted.
    can_carry_evidence_bundle:
      base.can_carry_evidence_bundle && (overrides.can_carry_evidence_bundle ?? true),
    can_carry_approval: base.can_carry_approval && (overrides.can_carry_approval ?? true),
  };
}
