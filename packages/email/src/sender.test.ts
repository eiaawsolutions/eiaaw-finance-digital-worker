import { describe, expect, it } from 'vitest';
import { RecordingEmailSender, ResendEmailSender } from './sender.js';

const MESSAGE = {
  to: 'eiaawsolutions@gmail.com',
  subject: 'Set your console password',
  text: 'Open the link.',
} as const;

/**
 * Records the request in an already-narrowed shape. `RequestInit['body']` is a
 * union that includes streams and form data, so capturing it raw would leave
 * every assertion stringifying something that might not be a string.
 */
interface RecordedCall {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

function stubFetch(response: { status: number; body?: unknown }): {
  fetch: typeof globalThis.fetch;
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchStub = ((url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: (init.headers ?? {}) as Record<string, string>,
      body: typeof init.body === 'string' ? init.body : '',
    });
    return Promise.resolve(
      new Response(JSON.stringify(response.body ?? { id: 'msg_1' }), {
        status: response.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof globalThis.fetch;

  return { fetch: fetchStub, calls };
}

const sender = (fetchImpl: typeof globalThis.fetch): ResendEmailSender =>
  new ResendEmailSender(
    { apiKey: 'test-key', from: 'EIAAW <noreply@eiaaw.dev>' },
    { fetch: fetchImpl },
  );

describe('Resend sender', () => {
  it('returns the provider message id on success', async () => {
    const stub = stubFetch({ status: 200, body: { id: 'msg_abc' } });

    const receipt = await sender(stub.fetch).send(MESSAGE);

    expect(receipt.providerMessageId).toBe('msg_abc');
  });

  it('presents the API key as a bearer token, never in the URL', async () => {
    const stub = stubFetch({ status: 200 });

    await sender(stub.fetch).send(MESSAGE);

    const call = stub.calls[0];
    expect(call?.headers['authorization']).toBe('Bearer test-key');
    expect(call?.url).not.toContain('test-key');
  });

  it('sends the configured from address and the message fields', async () => {
    const stub = stubFetch({ status: 200 });

    await sender(stub.fetch).send(MESSAGE);

    const body = JSON.parse(stub.calls[0]?.body ?? '{}') as Record<string, unknown>;
    expect(body['from']).toBe('EIAAW <noreply@eiaaw.dev>');
    expect(body['to']).toEqual(['eiaawsolutions@gmail.com']);
    expect(body['subject']).toBe('Set your console password');
    expect(body['text']).toBe('Open the link.');
  });

  /**
   * A rejected key is a deployment problem that retrying cannot fix, and a
   * retry loop against an auth failure looks like an attack to the provider.
   */
  it('treats a rejected API key as configuration, not as a transient failure', async () => {
    const stub = stubFetch({ status: 401, body: { message: 'invalid api key' } });

    await expect(sender(stub.fetch).send(MESSAGE)).rejects.toMatchObject({
      failureClass: 'configuration',
      retryable: false,
    });
  });

  it('treats a provider outage as retryable', async () => {
    const stub = stubFetch({ status: 503 });

    await expect(sender(stub.fetch).send(MESSAGE)).rejects.toMatchObject({ retryable: true });
  });

  it('treats rate limiting as retryable', async () => {
    const stub = stubFetch({ status: 429 });

    await expect(sender(stub.fetch).send(MESSAGE)).rejects.toMatchObject({ retryable: true });
  });

  /**
   * A malformed address is our bug or the operator's typo; retrying sends the
   * same broken request again forever.
   */
  it('treats a rejected message as a contract failure, not retryable', async () => {
    const stub = stubFetch({ status: 422, body: { message: 'invalid to address' } });

    await expect(sender(stub.fetch).send(MESSAGE)).rejects.toMatchObject({ retryable: false });
  });

  it('surfaces a network failure as retryable rather than as a crash', async () => {
    const failing = (() => Promise.reject(new Error('ECONNRESET'))) as unknown as typeof fetch;

    await expect(sender(failing).send(MESSAGE)).rejects.toMatchObject({ retryable: true });
  });

  /**
   * The link in an enrolment email is a bearer credential for one account. It
   * must never reach a log line, and an error message is a log line.
   */
  it('keeps the message body out of the failure detail', async () => {
    const stub = stubFetch({ status: 500 });

    await expect(
      sender(stub.fetch).send({ ...MESSAGE, text: 'https://console/set-password?token=SECRET' }),
    ).rejects.toThrow(/^(?!.*SECRET).*$/s);
  });
});

describe('recording sender', () => {
  it('captures messages instead of sending them', async () => {
    const recorder = new RecordingEmailSender();

    await recorder.send(MESSAGE);

    expect(recorder.sent).toHaveLength(1);
    expect(recorder.sent[0]?.subject).toBe('Set your console password');
  });

  it('returns a receipt so callers cannot tell it apart by shape', async () => {
    const recorder = new RecordingEmailSender();

    expect((await recorder.send(MESSAGE)).providerMessageId).toMatch(/.+/);
  });
});
