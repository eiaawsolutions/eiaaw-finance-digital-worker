import { describe, expect, it } from 'vitest';
import { SecretRef } from '@eiaaw/core';
import {
  ALL_CAPABILITIES,
  CHAT_CAPABILITIES,
  EMAIL_CAPABILITIES,
  TELEGRAM_CAPABILITIES,
  WHATSAPP_CAPABILITIES,
  withTenantOverrides,
} from './capabilities.js';
import { checkCapability, selectChannel, type ComposePayload } from './adapter.js';
import { StubWhatsAppPort, sessionWindowState } from './whatsapp-port.js';
import { VerificationFailureTracker, verifyHmacSignature, verifySecretToken } from './webhooks.js';

const payload = (overrides: Partial<ComposePayload> = {}): ComposePayload => ({
  recipient: 'usr_1',
  body: 'A short answer.',
  sensitivity: 'internal',
  carries_evidence_bundle: false,
  is_proactive: false,
  ...overrides,
});

describe('channel capabilities (file 02 s.1)', () => {
  it('describes exactly four channels', () => {
    expect(ALL_CAPABILITIES).toHaveLength(4);
  });

  it('makes in-app chat the only channel that reaches Restricted', () => {
    expect(CHAT_CAPABILITIES.sensitivity_ceiling).toBe('restricted');
    for (const other of [EMAIL_CAPABILITIES, TELEGRAM_CAPABILITIES, WHATSAPP_CAPABILITIES]) {
      expect(other.sensitivity_ceiling).not.toBe('restricted');
    }
  });

  it('lets only email and chat carry an evidence bundle', () => {
    expect(EMAIL_CAPABILITIES.can_carry_evidence_bundle).toBe(true);
    expect(CHAT_CAPABILITIES.can_carry_evidence_bundle).toBe(true);
    expect(TELEGRAM_CAPABILITIES.can_carry_evidence_bundle).toBe(false);
    expect(WHATSAPP_CAPABILITIES.can_carry_evidence_bundle).toBe(false);
  });

  it('lets only email and chat carry an approval', () => {
    expect(TELEGRAM_CAPABILITIES.can_carry_approval).toBe(false);
    expect(WHATSAPP_CAPABILITIES.can_carry_approval).toBe(false);
  });

  it('gives WhatsApp the lowest reach and a session window', () => {
    expect(WHATSAPP_CAPABILITIES.session_window).toBe('PT24H');
    expect(WHATSAPP_CAPABILITIES.supports_proactive).toBe('template_only');
  });
});

describe('tenant overrides can only narrow', () => {
  it('lowers a ceiling', () => {
    const narrowed = withTenantOverrides(CHAT_CAPABILITIES, { sensitivity_ceiling: 'internal' });
    expect(narrowed.sensitivity_ceiling).toBe('internal');
  });

  it('refuses to raise a ceiling', () => {
    // file 07 s.3.1: a tenant may not raise a platform ceiling.
    const attempted = withTenantOverrides(WHATSAPP_CAPABILITIES, {
      sensitivity_ceiling: 'restricted',
    });
    expect(attempted.sensitivity_ceiling).toBe('internal');
  });

  it('refuses to grant a capability the platform withholds', () => {
    const attempted = withTenantOverrides(TELEGRAM_CAPABILITIES, {
      can_carry_evidence_bundle: true,
      can_carry_approval: true,
    });
    expect(attempted.can_carry_evidence_bundle).toBe(false);
    expect(attempted.can_carry_approval).toBe(false);
  });

  it('takes the smaller of the two limits', () => {
    expect(withTenantOverrides(EMAIL_CAPABILITIES, { max_body_chars: 5000 }).max_body_chars).toBe(
      5000,
    );
    expect(
      withTenantOverrides(TELEGRAM_CAPABILITIES, { max_body_chars: 999_999 }).max_body_chars,
    ).toBe(TELEGRAM_CAPABILITIES.max_body_chars);
  });
});

describe('capability checks refuse rather than truncate (s.4.2)', () => {
  it('refuses a payload above the channel ceiling', () => {
    const error = checkCapability(WHATSAPP_CAPABILITIES, payload({ sensitivity: 'confidential' }));
    expect(error?.class).toBe('capability_refusal');
    expect(error?.detail).toMatch(/escalated, never the payload truncated/);
  });

  it('refuses an evidence bundle on a channel that cannot carry one', () => {
    const error = checkCapability(
      TELEGRAM_CAPABILITIES,
      payload({ carries_evidence_bundle: true }),
    );
    expect(error?.detail).toMatch(/approving on partial information/);
  });

  it('refuses an oversized body rather than trimming it', () => {
    const error = checkCapability(TELEGRAM_CAPABILITIES, payload({ body: 'x'.repeat(5000) }));
    expect(error?.detail).toMatch(/would drop the citations or the limits/);
  });

  it('refuses a proactive message on a channel that cannot start one', () => {
    const capabilities = { ...TELEGRAM_CAPABILITIES, supports_proactive: 'never' as const };
    expect(checkCapability(capabilities, payload({ is_proactive: true }))?.class).toBe(
      'capability_refusal',
    );
  });

  it('refuses free text outside a session window', () => {
    const error = checkCapability(
      WHATSAPP_CAPABILITIES,
      payload({ session_age_ms: 25 * 3_600_000 }),
    );
    expect(error?.detail).toMatch(/session window has closed/);
  });

  it('permits a conformant payload', () => {
    expect(checkCapability(CHAT_CAPABILITIES, payload())).toBeNull();
  });
});

describe('the router asks capabilities, never channel names', () => {
  it('honours the recipient preference when the channel can carry it', () => {
    const result = selectChannel(ALL_CAPABILITIES, payload(), ['telegram', 'chat', 'email']);
    expect('channel' in result && result.channel).toBe('telegram');
  });

  it('escalates to a channel that can carry a confidential payload', () => {
    const result = selectChannel(ALL_CAPABILITIES, payload({ sensitivity: 'confidential' }), [
      'whatsapp',
      'telegram',
      'email',
      'chat',
    ]);
    expect('channel' in result).toBe(true);
    if (!('channel' in result)) return;
    expect(['email', 'chat']).toContain(result.channel);
    expect(result.escalated).toBe(true);
  });

  it('escalates an evidence bundle off a consumer channel', () => {
    const result = selectChannel(
      ALL_CAPABILITIES,
      payload({ carries_evidence_bundle: true, sensitivity: 'confidential' }),
      ['whatsapp', 'telegram', 'email'],
    );
    expect('channel' in result && result.channel).toBe('email');
  });

  it('holds the output rather than sending a reduced version', () => {
    const result = selectChannel(
      [TELEGRAM_CAPABILITIES, WHATSAPP_CAPABILITIES],
      payload({ sensitivity: 'restricted' }),
      ['telegram'],
    );
    expect('refused' in result).toBe(true);
    if (!('refused' in result)) return;
    expect(result.refused.detail).toMatch(/rather than being sent a reduced version/);
  });
});

// DWD-06 s.6
describe('webhook verification', () => {
  const secret = new SecretRef('WEBHOOK', 'a-test-webhook-secret-value');
  const next = new SecretRef('WEBHOOK_NEXT', 'the-next-webhook-secret-value');
  const rawBody = Buffer.from('{"hello":"world"}');
  const nowMs = 1_800_000_000_000;
  const timestamp = String(Math.floor(nowMs / 1000));

  const sign = (s: SecretRef): string =>
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('node:crypto')
      .createHmac('sha256', s.expose())
      .update(`${timestamp}.${rawBody.toString('utf8')}`)
      .digest('hex');

  it('verifies a correctly signed body', () => {
    const result = verifyHmacSignature({
      rawBody,
      signature: sign(secret),
      timestamp,
      secrets: { current: secret },
      replayWindowSeconds: 300,
      providerEventId: 'evt_1',
      now: nowMs,
    });
    expect(result.verified).toBe(true);
  });

  it('accepts the NEXT secret during a rotation overlap (s.6.3)', () => {
    const result = verifyHmacSignature({
      rawBody,
      signature: sign(next),
      timestamp,
      secrets: { current: secret, next },
      replayWindowSeconds: 300,
      providerEventId: 'evt_1',
      now: nowMs,
    });
    // There is never a window with no verification.
    expect(result.verified).toBe(true);
  });

  it('rejects a body altered after signing', () => {
    const result = verifyHmacSignature({
      rawBody: Buffer.from('{"hello":"tampered"}'),
      signature: sign(secret),
      timestamp,
      secrets: { current: secret },
      replayWindowSeconds: 300,
      providerEventId: 'evt_1',
      now: nowMs,
    });
    expect(result.verified).toBe(false);
  });

  it('rejects skew outside the replay window BEFORE comparing the HMAC (W3)', () => {
    const result = verifyHmacSignature({
      rawBody,
      signature: sign(secret),
      timestamp,
      secrets: { current: secret },
      replayWindowSeconds: 300,
      providerEventId: 'evt_1',
      now: nowMs + 600_000,
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toMatch(/replay window/);
  });

  it('verifies a Telegram secret token', () => {
    expect(
      verifySecretToken({
        presented: secret.expose(),
        secrets: { current: secret },
        providerEventId: null,
      }).verified,
    ).toBe(true);
    expect(
      verifySecretToken({ presented: 'wrong', secrets: { current: secret }, providerEventId: null })
        .verified,
    ).toBe(false);
    expect(
      verifySecretToken({
        presented: undefined,
        secrets: { current: secret },
        providerEventId: null,
      }).verified,
    ).toBe(false);
  });
});

describe('verification failure tracking (W5)', () => {
  it('trips a block after repeated failures from one source', () => {
    const tracker = new VerificationFailureTracker(3, 60_000);
    expect(tracker.record('1.2.3.4').blocked).toBe(false);
    expect(tracker.record('1.2.3.4').blocked).toBe(false);
    expect(tracker.record('1.2.3.4').blocked).toBe(true);
    expect(tracker.isBlocked('1.2.3.4')).toBe(true);
  });

  it('does not block an unrelated source', () => {
    const tracker = new VerificationFailureTracker(2, 60_000);
    tracker.record('1.2.3.4');
    tracker.record('1.2.3.4');
    expect(tracker.isBlocked('5.6.7.8')).toBe(false);
  });

  it('forgets failures once the window passes', () => {
    const tracker = new VerificationFailureTracker(2, 1000);
    tracker.record('1.2.3.4', 0);
    tracker.record('1.2.3.4', 0);
    expect(tracker.isBlocked('1.2.3.4', 5000)).toBe(false);
  });
});

// DWD-06 s.4.4
describe('the WhatsApp BSP port', () => {
  it('computes the session window from canonical timestamps (P5)', () => {
    const lastInbound = Math.floor(Date.now() / 1000) - 3600;
    const state = sessionWindowState({
      lastInboundEpochSeconds: lastInbound,
      windowMs: 24 * 3_600_000,
    });
    expect(state.open).toBe(true);
    expect(state.requires_template).toBe(false);
  });

  it('requires a template once the window has closed', () => {
    const lastInbound = Math.floor(Date.now() / 1000) - 25 * 3600;
    const state = sessionWindowState({
      lastInboundEpochSeconds: lastInbound,
      windowMs: 24 * 3_600_000,
    });
    expect(state.open).toBe(false);
    expect(state.requires_template).toBe(true);
  });

  it('requires a template when there has been no inbound at all', () => {
    expect(
      sessionWindowState({ lastInboundEpochSeconds: null, windowMs: 24 * 3_600_000 })
        .requires_template,
    ).toBe(true);
  });

  it('normalises inbound so no provider field escapes (P1)', () => {
    const port = new StubWhatsAppPort();
    const events = port.normaliseInbound({
      entry: [
        {
          changes: [
            {
              value: {
                messages: [
                  {
                    id: 'wamid.ABC',
                    from: '60123456789',
                    timestamp: '1800000000',
                    type: 'text',
                    text: { body: 'What is the SST position?' },
                    // A proprietary field that must not survive.
                    bsp_internal_routing_hint: 'do-not-leak',
                  },
                ],
              },
            },
          ],
        },
      ],
    });

    expect(events).toHaveLength(1);
    expect(events[0]?.wamid).toBe('wamid.ABC');
    expect(events[0]?.text).toBe('What is the SST position?');
    expect(JSON.stringify(events[0])).not.toContain('bsp_internal_routing_hint');
  });

  it('refuses a template that is not in the approved catalogue (P3)', async () => {
    const port = new StubWhatsAppPort();
    const result = await port.sendTemplateMessage('60123', 'not_approved', 'en_MY', [], 'key');
    expect(result.accepted).toBe(false);
    expect(result.error?.detail).toMatch(/never in code/);
  });

  it('refuses a template with the wrong variable count', async () => {
    const port = new StubWhatsAppPort();
    const result = await port.sendTemplateMessage(
      '60123',
      'handoff_awaiting_action',
      'en_MY',
      ['only-one'],
      'key',
    );
    expect(result.accepted).toBe(false);
    expect(result.error?.class).toBe('provider_contract');
  });

  it('is idempotent on the same key', async () => {
    const port = new StubWhatsAppPort();
    await port.sendSessionMessage('60123', 'hello', 'key-1');
    await port.sendSessionMessage('60123', 'hello', 'key-1');
    expect(port.sent).toHaveLength(1);
  });
});
