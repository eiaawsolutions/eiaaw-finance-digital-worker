/**
 * Transactional email, for messages the platform sends on its own behalf:
 * enrolment links and password resets.
 *
 * Deliberately not routed through `@eiaaw/delivery`. That path exists for
 * tenant-facing output — it resolves a principal's channel bindings, records a
 * delivery row, and carries an audit trail, all of which presuppose an
 * established identity. These messages are sent *to establish* one, often
 * before the recipient has a session at all, and attributing them to the
 * identity they create would be circular.
 */
import { WorkerError } from '@eiaaw/core';

export interface EmailMessage {
  readonly to: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

export interface EmailReceipt {
  readonly providerMessageId: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<EmailReceipt>;
}

export interface ResendConfig {
  readonly apiKey: string;
  /** Display form, e.g. `EIAAW <noreply@eiaaw.dev>`. Must be a verified domain. */
  readonly from: string;
  readonly endpoint?: string;
}

const DEFAULT_ENDPOINT = 'https://api.resend.com/emails';

/**
 * Classify by status, because what the caller should do differs completely.
 *
 * The distinction that matters most is 401/403: a rejected key cannot be fixed
 * by trying again, and a retry loop against an auth failure looks like an
 * attack to the provider and gets the sending domain throttled.
 */
function failureFor(status: number, providerMessage: string): WorkerError {
  if (status === 401 || status === 403) {
    return new WorkerError('dependency_unavailable', {
      detail:
        `The email provider rejected our credentials (HTTP ${String(status)}: ${providerMessage}). ` +
        'RESEND_API resolves to a key the provider does not accept. Retrying cannot fix this, ' +
        'and repeated auth failures get the sending domain throttled.',
      failureClass: 'configuration',
      retryable: false,
    });
  }

  if (status === 429 || status >= 500) {
    return new WorkerError('dependency_unavailable', {
      detail:
        `The email provider is not accepting messages right now (HTTP ${String(status)}: ` +
        `${providerMessage}). This is transient.`,
      failureClass: 'tool',
      retryable: true,
    });
  }

  return new WorkerError('dependency_unavailable', {
    detail:
      `The email provider refused the message (HTTP ${String(status)}: ${providerMessage}). ` +
      'A refused message is a malformed request — a bad address or an unverified sending ' +
      'domain — and sending it again unchanged will be refused again.',
    failureClass: 'contract',
    retryable: false,
  });
}

export class ResendEmailSender implements EmailSender {
  readonly #config: ResendConfig;
  readonly #fetch: typeof globalThis.fetch;

  constructor(config: ResendConfig, options: { readonly fetch?: typeof globalThis.fetch } = {}) {
    this.#config = config;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async send(message: EmailMessage): Promise<EmailReceipt> {
    let response: Response;

    try {
      response = await this.#fetch(this.#config.endpoint ?? DEFAULT_ENDPOINT, {
        method: 'POST',
        headers: {
          // Bearer header, never a query parameter: a key in a URL reaches
          // access logs, proxies and referrers.
          authorization: `Bearer ${this.#config.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          from: this.#config.from,
          to: [message.to],
          subject: message.subject,
          text: message.text,
          ...(message.html === undefined ? {} : { html: message.html }),
        }),
      });
    } catch (cause) {
      throw new WorkerError('dependency_unavailable', {
        detail:
          'The email provider could not be reached. The enrolment link was not sent, so the ' +
          'recipient is waiting for something that is not coming — surface this rather than ' +
          'recording the invite as delivered.',
        failureClass: 'tool',
        retryable: true,
        cause,
      });
    }

    if (!response.ok) {
      // Read the provider's own words, but never echo our message body: the
      // enrolment link is a bearer credential for one account, and an error
      // detail is a log line.
      let providerMessage = response.statusText;
      try {
        const body = (await response.json()) as { message?: unknown };
        if (typeof body.message === 'string') providerMessage = body.message;
      } catch {
        // A provider that returns non-JSON on an error is not worth a second failure.
      }
      throw failureFor(response.status, providerMessage);
    }

    const body = (await response.json()) as { id?: unknown };

    if (typeof body.id !== 'string') {
      throw new WorkerError('dependency_unavailable', {
        detail:
          'The email provider accepted the message but returned no message id. Without one ' +
          'there is nothing to correlate a bounce or a complaint against later.',
        failureClass: 'tool',
        retryable: false,
      });
    }

    return { providerMessageId: body.id };
  }
}

/**
 * Captures instead of sending. Used by tests, and by local development where an
 * enrolment link should appear in the log rather than in somebody's inbox.
 */
export class RecordingEmailSender implements EmailSender {
  readonly sent: EmailMessage[] = [];

  // eslint-disable-next-line @typescript-eslint/require-await
  async send(message: EmailMessage): Promise<EmailReceipt> {
    this.sent.push(message);
    return { providerMessageId: `recorded_${String(this.sent.length)}` };
  }
}
