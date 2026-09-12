import { RecordingEmailSender } from '@eiaaw/email';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  CONSOLE_AUTH_DEFAULTS,
  ConsoleAuthService,
  emailHash,
  type OpenedSession,
} from './console-auth.js';
import { InMemoryConsoleIdentityStore } from './console-store.js';
import { deriveSealingKey, openSecret } from './sealing.js';
import { totpCode } from './totp.js';

const TENANT = 'tnt_eiaaw';
const PRINCIPAL = 'usr_amos';
const EMAIL = 'eiaawsolutions@gmail.com';
const PASSWORD = 'correct horse battery staple';

const SEALING_KEY = deriveSealingKey('k'.repeat(64), 'totp');
const CHALLENGE_KEY = deriveSealingKey('k'.repeat(64), 'challenge');

let store: InMemoryConsoleIdentityStore;
let mail: RecordingEmailSender;
let clock: Date;
let auth: ConsoleAuthService;

function build(): void {
  store = new InMemoryConsoleIdentityStore();
  mail = new RecordingEmailSender();
  clock = new Date('2026-09-12T09:00:00.000Z');
  auth = new ConsoleAuthService(
    {
      consoleName: 'EIAAW Finance Worker',
      consoleBaseUrl: 'https://console.example',
      sealingKey: SEALING_KEY,
      challengeKey: CHALLENGE_KEY,
      ...CONSOLE_AUTH_DEFAULTS,
    },
    { store, email: mail, now: () => clock },
  );
  store.grant(TENANT, PRINCIPAL, EMAIL, emailHash(EMAIL));
}

const advance = (ms: number): void => {
  clock = new Date(clock.getTime() + ms);
};

function linkToken(): string {
  const link = /token=([^\s&]+)/.exec(mail.sent[mail.sent.length - 1]?.text ?? '');
  return decodeURIComponent(link?.[1] ?? '');
}

/** Walk a fresh principal all the way to a usable account. */
async function enrol(): Promise<{ session: OpenedSession; secret: string }> {
  await auth.requestEnrolmentLink(EMAIL);
  const pending = await auth.acceptInvite(linkToken(), PASSWORD);
  const secret = pending.totpSecret as string;
  const session = await auth.confirmEnrolment(pending.challenge, totpCode(secret, clock.getTime()));
  return { session, secret };
}

beforeEach(build);

describe('requesting a link', () => {
  it('emails an enrolment link to a granted principal', async () => {
    await auth.requestEnrolmentLink(EMAIL);

    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0]?.to).toBe(EMAIL);
    expect(mail.sent[0]?.subject).toMatch(/set up/i);
  });

  it('sends a reset rather than an enrolment once a password exists', async () => {
    await enrol();
    mail.sent.length = 0;

    await auth.requestEnrolmentLink(EMAIL);

    expect(mail.sent[0]?.subject).toMatch(/reset/i);
  });

  /**
   * Silence, not an error. Throwing for an unknown address and succeeding for a
   * known one is the same oracle as saying so outright.
   */
  it('says nothing and sends nothing for an address with no account', async () => {
    await expect(auth.requestEnrolmentLink('stranger@example.com')).resolves.toBeUndefined();

    expect(mail.sent).toHaveLength(0);
  });

  it('sends nothing when console access has been revoked', async () => {
    store.credentials.clear();

    await auth.requestEnrolmentLink(EMAIL);

    expect(mail.sent).toHaveLength(0);
  });

  it('issues a link carrying the tenant, so the lookup can run under RLS', async () => {
    await auth.requestEnrolmentLink(EMAIL);

    expect(linkToken().startsWith(`${TENANT}.`)).toBe(true);
  });
});

describe('first factor', () => {
  it('returns a challenge, not a session, when the password is right', async () => {
    await enrol();

    const pending = await auth.signInWithPassword(EMAIL, PASSWORD);

    expect(pending.purpose).toBe('awaiting_totp');
    expect(pending.challenge).toMatch(/.+\..+/);
  });

  /**
   * The three failures below must be indistinguishable. If they are not, the
   * sign-in form answers "does this person have an account here".
   */
  it('refuses a wrong password, an unknown address and an unenrolled account alike', async () => {
    await enrol();
    const messages: string[] = [];

    for (const attempt of [
      () => auth.signInWithPassword(EMAIL, 'wrong password entirely'),
      () => auth.signInWithPassword('stranger@example.com', PASSWORD),
    ]) {
      await attempt().catch((error: Error) => messages.push(error.message));
    }

    build();
    await auth
      .signInWithPassword(EMAIL, PASSWORD)
      .catch((error: Error) => messages.push(error.message));

    expect(messages).toHaveLength(3);
    expect(new Set(messages).size).toBe(1);
  });

  it('locks the account after the configured number of failures', async () => {
    await enrol();

    for (let attempt = 0; attempt < CONSOLE_AUTH_DEFAULTS.maxFailedAttempts; attempt += 1) {
      await auth.signInWithPassword(EMAIL, 'wrong').catch(() => undefined);
    }

    const credential = await store.findCredential(TENANT, PRINCIPAL);
    expect(credential?.lockedUntil).not.toBeNull();
  });

  it('refuses the correct password while locked', async () => {
    await enrol();
    for (let attempt = 0; attempt < CONSOLE_AUTH_DEFAULTS.maxFailedAttempts; attempt += 1) {
      await auth.signInWithPassword(EMAIL, 'wrong').catch(() => undefined);
    }

    await expect(auth.signInWithPassword(EMAIL, PASSWORD)).rejects.toThrow();
  });

  it('accepts the correct password once the lockout has passed', async () => {
    await enrol();
    for (let attempt = 0; attempt < CONSOLE_AUTH_DEFAULTS.maxFailedAttempts; attempt += 1) {
      await auth.signInWithPassword(EMAIL, 'wrong').catch(() => undefined);
    }

    advance((CONSOLE_AUTH_DEFAULTS.lockoutMinutes + 1) * 60_000);

    await expect(auth.signInWithPassword(EMAIL, PASSWORD)).resolves.toBeDefined();
  });

  it('forgets earlier failures after a success', async () => {
    await enrol();
    await auth.signInWithPassword(EMAIL, 'wrong').catch(() => undefined);

    await auth.signInWithPassword(EMAIL, PASSWORD);

    expect((await store.findCredential(TENANT, PRINCIPAL))?.failedAttempts).toBe(0);
  });
});

describe('accepting an invite', () => {
  it('sets the password and hands back an authenticator enrolment', async () => {
    await auth.requestEnrolmentLink(EMAIL);

    const pending = await auth.acceptInvite(linkToken(), PASSWORD);

    expect(pending.purpose).toBe('awaiting_totp_enrolment');
    expect(pending.otpauthUri).toContain('otpauth://totp/');
  });

  /**
   * A link left sitting in an inbox is a credential. Consuming it on first use
   * is what stops it being one forever.
   */
  it('refuses a link that has already been used', async () => {
    await auth.requestEnrolmentLink(EMAIL);
    const token = linkToken();
    await auth.acceptInvite(token, PASSWORD);

    await expect(auth.acceptInvite(token, 'a different long password')).rejects.toThrow(
      /already been used/i,
    );
  });

  it('refuses an expired link', async () => {
    await auth.requestEnrolmentLink(EMAIL);
    const token = linkToken();

    advance((CONSOLE_AUTH_DEFAULTS.inviteTtlMinutes + 1) * 60_000);

    await expect(auth.acceptInvite(token, PASSWORD)).rejects.toThrow(/expired/i);
  });

  it('refuses a token that was never issued', async () => {
    await expect(auth.acceptInvite(`${TENANT}.fabricated`, PASSWORD)).rejects.toThrow(/not valid/i);
  });

  it('refuses a token with no tenant prefix', async () => {
    await expect(auth.acceptInvite('no-tenant-here', PASSWORD)).rejects.toThrow(/not valid/i);
  });

  /**
   * Unlike sign-in, this failure says exactly what is wrong: it is the person's
   * own password field, and a refusal without a reason is a dead end.
   */
  it('says why a password was rejected', async () => {
    await auth.requestEnrolmentLink(EMAIL);

    await expect(auth.acceptInvite(linkToken(), 'short')).rejects.toThrow(/12 characters/);
  });

  it('stores the authenticator seed sealed, never in the clear', async () => {
    await auth.requestEnrolmentLink(EMAIL);

    const pending = await auth.acceptInvite(linkToken(), PASSWORD);

    const stored = (await store.findCredential(TENANT, PRINCIPAL))?.totpSecretSealed as string;
    expect(stored).not.toContain(pending.totpSecret as string);
    expect(openSecret(stored, SEALING_KEY)).toBe(pending.totpSecret);
  });

  /**
   * Password set but factor unproven. If this state allowed sign-in, an
   * interrupted enrolment would leave the account reachable by password alone —
   * exactly the single-factor account the second factor exists to prevent.
   */
  it('leaves the seed unconfirmed until a code proves the device', async () => {
    await auth.requestEnrolmentLink(EMAIL);

    await auth.acceptInvite(linkToken(), PASSWORD);

    expect((await store.findCredential(TENANT, PRINCIPAL))?.totpConfirmedAt).toBeNull();
  });

  it('routes an interrupted enrolment back to the authenticator step', async () => {
    await auth.requestEnrolmentLink(EMAIL);
    await auth.acceptInvite(linkToken(), PASSWORD);

    const pending = await auth.signInWithPassword(EMAIL, PASSWORD);

    expect(pending.purpose).toBe('awaiting_totp_enrolment');
  });
});

describe('second factor', () => {
  it('opens a session when the code is right', async () => {
    const { session } = await enrol();

    expect(session.principalId).toBe(PRINCIPAL);
    expect(session.cookie.startsWith(`${TENANT}.`)).toBe(true);
  });

  it('refuses a wrong code at enrolment', async () => {
    await auth.requestEnrolmentLink(EMAIL);
    const pending = await auth.acceptInvite(linkToken(), PASSWORD);

    await expect(auth.confirmEnrolment(pending.challenge, '000000')).rejects.toThrow(
      /not accepted/i,
    );
  });

  it('refuses a wrong code at sign-in', async () => {
    await enrol();
    const pending = await auth.signInWithPassword(EMAIL, PASSWORD);

    await expect(auth.completeSignIn(pending.challenge, '000000')).rejects.toThrow();
  });

  it('opens a session at sign-in when the code is right', async () => {
    const { secret } = await enrol();
    const pending = await auth.signInWithPassword(EMAIL, PASSWORD);

    const session = await auth.completeSignIn(pending.challenge, totpCode(secret, clock.getTime()));

    expect(session.principalId).toBe(PRINCIPAL);
  });

  /**
   * The purpose is inside the signature for this: an enrolment challenge
   * accepted at the sign-in step would let someone finish a sign-in having
   * proved only a password.
   */
  it('refuses an enrolment challenge presented at the sign-in step', async () => {
    await auth.requestEnrolmentLink(EMAIL);
    const pending = await auth.acceptInvite(linkToken(), PASSWORD);

    await expect(
      auth.completeSignIn(
        pending.challenge,
        totpCode(pending.totpSecret as string, clock.getTime()),
      ),
    ).rejects.toThrow();
  });

  it('refuses a challenge that has expired', async () => {
    const { secret } = await enrol();
    const pending = await auth.signInWithPassword(EMAIL, PASSWORD);

    advance(11 * 60_000);

    await expect(
      auth.completeSignIn(pending.challenge, totpCode(secret, clock.getTime())),
    ).rejects.toThrow(/expired/i);
  });
});

describe('sessions', () => {
  it('resolves a live session to its principal', async () => {
    const { session } = await enrol();

    expect(await auth.resolveSession(session.cookie)).toMatchObject({
      tenantId: TENANT,
      principalId: PRINCIPAL,
    });
  });

  it('does not resolve an expired session', async () => {
    const { session } = await enrol();

    advance((CONSOLE_AUTH_DEFAULTS.sessionTtlHours + 1) * 3_600_000);

    expect(await auth.resolveSession(session.cookie)).toBeNull();
  });

  /**
   * Sessions are rows precisely so this works. A signed stateless cookie could
   * not be withdrawn before it expired.
   */
  it('does not resolve a session after sign-out', async () => {
    const { session } = await enrol();

    await auth.signOut(session.cookie);

    expect(await auth.resolveSession(session.cookie)).toBeNull();
  });

  it('does not resolve a cookie whose tenant prefix has been edited', async () => {
    const { session } = await enrol();
    const edited = session.cookie.replace(TENANT, 'tnt_someone-else');

    expect(await auth.resolveSession(edited)).toBeNull();
  });

  it('does not resolve a malformed cookie', async () => {
    expect(await auth.resolveSession('rubbish')).toBeNull();
  });

  it('tolerates signing out with a malformed cookie', async () => {
    await expect(auth.signOut('rubbish')).resolves.toBeUndefined();
  });
});
