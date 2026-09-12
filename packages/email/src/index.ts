/**
 * Transactional email for messages the platform sends on its own behalf.
 *
 * One port, two implementations: Resend in deployed environments, and a
 * recorder for tests and local development where an enrolment link belongs in
 * the log rather than in somebody's inbox.
 */
export {
  RecordingEmailSender,
  ResendEmailSender,
  type EmailMessage,
  type EmailReceipt,
  type EmailSender,
  type ResendConfig,
} from './sender.js';

export { enrolmentEmail, passwordResetEmail, type InviteEmailInput } from './templates.js';
