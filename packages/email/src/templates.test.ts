import { describe, expect, it } from 'vitest';
import { enrolmentEmail, passwordResetEmail } from './templates.js';

const INPUT = {
  to: 'eiaawsolutions@gmail.com',
  link: 'https://console.example/set-password?token=abc123',
  expiresInMinutes: 60,
  consoleName: 'EIAAW Finance Worker',
} as const;

describe('enrolment email', () => {
  it('names the console in the subject, so the recipient knows what invited them', () => {
    expect(enrolmentEmail(INPUT).subject).toContain('EIAAW Finance Worker');
  });

  /**
   * The link has to appear in the text part in full. An anchor whose label and
   * destination disagree is the shape of every phishing email, and asking
   * someone to trust a link they cannot read is asking them to learn a habit
   * that will be used against them.
   */
  it('shows the full link in the plain-text part, not just as an anchor', () => {
    expect(enrolmentEmail(INPUT).text).toContain(INPUT.link);
  });

  it('states the expiry in both parts, so a filed-for-later link is not a bug report', () => {
    const message = enrolmentEmail(INPUT);

    expect(message.text).toContain('60 minutes');
    expect(message.html).toContain('60 minutes');
  });

  it('says the link is single-use', () => {
    expect(enrolmentEmail(INPUT).text).toMatch(/once/i);
  });

  it('tells an unexpecting recipient that ignoring it is safe', () => {
    expect(enrolmentEmail(INPUT).text).toMatch(/ignore/i);
  });

  it('mentions the authenticator step, so the second factor is not a surprise', () => {
    expect(enrolmentEmail(INPUT).text).toMatch(/authenticator/i);
  });

  it('escapes HTML so a configured name cannot inject markup', () => {
    const message = enrolmentEmail({ ...INPUT, consoleName: '<script>alert(1)</script>' });

    expect(message.html).not.toContain('<script>');
    expect(message.html).toContain('&lt;script&gt;');
  });
});

describe('password reset email', () => {
  it('is distinguishable from an enrolment, because the two mean different things', () => {
    expect(passwordResetEmail(INPUT).subject).not.toEqual(enrolmentEmail(INPUT).subject);
    expect(passwordResetEmail(INPUT).subject).toMatch(/reset/i);
  });

  /**
   * Someone resetting a password has usually lost something. Saying the second
   * factor is untouched prevents the reasonable but wrong assumption that this
   * link restores full access on its own.
   */
  it('says the second factor is unchanged and still required', () => {
    expect(passwordResetEmail(INPUT).text).toMatch(/two-factor|authenticator/i);
    expect(passwordResetEmail(INPUT).text).toMatch(/unchanged/i);
  });
});
