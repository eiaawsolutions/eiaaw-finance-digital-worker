/**
 * The two messages the console sends.
 *
 * Plain text first and HTML second, because these carry a link someone must be
 * able to trust: a text part that shows the destination in full is harder to
 * spoof than an anchor whose label and href disagree, and it survives every
 * client that strips HTML.
 *
 * Both state the expiry in words. "This link expires in 60 minutes" is what
 * stops the recipient filing it for later and then reporting a bug.
 */
import type { EmailMessage } from './sender.js';

export interface InviteEmailInput {
  readonly to: string;
  readonly link: string;
  readonly expiresInMinutes: number;
  /** Shown so the recipient can tell which deployment invited them. */
  readonly consoleName: string;
}

/**
 * Escaped because the console name is configuration and the link carries a
 * token — neither is attacker-controlled today, but an HTML email that
 * interpolates unescaped is one configuration change away from being so.
 */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function body(input: InviteEmailInput, opening: string, action: string): EmailMessage {
  const minutes = String(input.expiresInMinutes);

  const text = [
    opening,
    '',
    action,
    '',
    input.link,
    '',
    `This link expires in ${minutes} minutes and can be used once.`,
    '',
    'If you were not expecting this, you can ignore it — the link does nothing until',
    'it is opened, and it will expire on its own.',
    '',
    `— ${input.consoleName}`,
  ].join('\n');

  const html = [
    `<p>${escapeHtml(opening)}</p>`,
    `<p>${escapeHtml(action)}</p>`,
    `<p><a href="${escapeHtml(input.link)}">${escapeHtml(input.link)}</a></p>`,
    `<p>This link expires in ${minutes} minutes and can be used once.</p>`,
    '<p>If you were not expecting this, you can ignore it — the link does nothing until it is opened, and it will expire on its own.</p>',
    `<p>— ${escapeHtml(input.consoleName)}</p>`,
  ].join('\n');

  return { to: input.to, subject: '', text, html };
}

export function enrolmentEmail(input: InviteEmailInput): EmailMessage {
  return {
    ...body(
      input,
      `You have been granted access to ${input.consoleName}.`,
      'Choose a password to finish setting up your account. You will then be asked to set up an authenticator app for two-factor sign-in.',
    ),
    subject: `Set up your ${input.consoleName} account`,
  };
}

export function passwordResetEmail(input: InviteEmailInput): EmailMessage {
  return {
    ...body(
      input,
      `A password reset was requested for your ${input.consoleName} account.`,
      'Choose a new password. Your two-factor authenticator is unchanged and will still be required.',
    ),
    subject: `Reset your ${input.consoleName} password`,
  };
}
