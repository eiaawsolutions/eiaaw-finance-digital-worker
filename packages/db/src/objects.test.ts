import { describe, expect, it } from 'vitest';
import { S3ObjectStoreDriver, type S3ClientShape } from './objects.js';

/**
 * A stand-in for the AWS SDK client. It records the commands the driver sends
 * and answers from an in-memory map, so these tests assert the driver's
 * contract — key handling, bucket targeting, missing-object behaviour — without
 * reaching Cloudflare.
 */
function fakeClient(objects: Map<string, Buffer> = new Map()): S3ClientShape & {
  readonly sent: { name: string; input: Record<string, unknown> }[];
} {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  return {
    sent,
    // eslint-disable-next-line @typescript-eslint/require-await
    async send(command: { constructor: { name: string }; input: Record<string, unknown> }) {
      sent.push({ name: command.constructor.name, input: command.input });
      const key = String(command.input['Key']);

      if (command.constructor.name === 'PutObjectCommand') {
        objects.set(key, Buffer.from(command.input['Body'] as Uint8Array));
        return {};
      }
      if (command.constructor.name === 'GetObjectCommand') {
        const body = objects.get(key);
        if (!body) throw Object.assign(new Error('NoSuchKey'), { name: 'NoSuchKey' });
        return { Body: { transformToByteArray: () => Promise.resolve(new Uint8Array(body)) } };
      }
      if (command.constructor.name === 'HeadObjectCommand') {
        if (!objects.has(key)) throw Object.assign(new Error('NotFound'), { name: 'NotFound' });
        return {};
      }
      throw new Error(`unexpected command ${command.constructor.name}`);
    },
  };
}

/** A client that refuses every command, for exercising the write failure paths. */
function failingClient(error: unknown): S3ClientShape {
  return {
    // eslint-disable-next-line @typescript-eslint/require-await
    async send() {
      throw error;
    },
  };
}

/** An AWS SDK error carries its discriminator on `name` and `$metadata`. */
function s3Error(name: string, httpStatusCode?: number): Error {
  return Object.assign(new Error(name), {
    name,
    $metadata: httpStatusCode === undefined ? {} : { httpStatusCode },
  });
}

const CONFIG = {
  bucket: 'eiaaw-fdw-artifacts',
  endpoint: 'https://acct.r2.cloudflarestorage.com',
  accessKeyId: 'test-access-key',
  secretAccessKey: 'test-secret-key',
};

describe('S3ObjectStoreDriver', () => {
  it('round-trips a body through put and get', async () => {
    const driver = new S3ObjectStoreDriver(CONFIG, fakeClient());
    const body = Buffer.from('an evidence bundle', 'utf8');

    await driver.put('sha256/ab/cd/ef', body, 'application/json');

    expect(await driver.get('sha256/ab/cd/ef')).toEqual(body);
  });

  it('targets the configured bucket and key', async () => {
    const client = fakeClient();
    const driver = new S3ObjectStoreDriver(CONFIG, client);

    await driver.put('sha256/ab/cd/ef', Buffer.from('x'), 'application/pdf');

    expect(client.sent[0]).toMatchObject({
      name: 'PutObjectCommand',
      input: {
        Bucket: 'eiaaw-fdw-artifacts',
        Key: 'sha256/ab/cd/ef',
        ContentType: 'application/pdf',
      },
    });
  });

  it('reports existence without downloading the body', async () => {
    const client = fakeClient();
    const driver = new S3ObjectStoreDriver(CONFIG, client);
    await driver.put('present', Buffer.from('x'), 'text/plain');
    client.sent.length = 0;

    expect(await driver.exists('present')).toBe(true);
    expect(client.sent.map((c) => c.name)).toEqual(['HeadObjectCommand']);
  });

  it('reports a missing object as absent rather than throwing', async () => {
    const driver = new S3ObjectStoreDriver(CONFIG, fakeClient());

    expect(await driver.exists('never-written')).toBe(false);
  });

  /**
   * `get` on a missing key is not the same as `exists` returning false: the
   * caller has already established from `stored_objects` that the row exists,
   * so the object being gone is a chain-of-custody problem and must be loud.
   */
  it('fails loudly when a registered object is absent from the bucket', async () => {
    const driver = new S3ObjectStoreDriver(CONFIG, fakeClient());

    await expect(driver.get('vanished')).rejects.toThrow(/vanished/);
  });
});

/**
 * `get` may assume the bucket is reachable — a row in `stored_objects` is proof
 * something already wrote there. A write has no such witness, so the first
 * artefact a deployment stores is also the first test of whether the bucket name
 * and the credential agree. Both ways that can fail are silent until that moment
 * and identical in a raw SDK stack trace, so the driver names them apart.
 */
describe('S3ObjectStoreDriver write failures', () => {
  const put = (client: S3ClientShape): Promise<void> =>
    new S3ObjectStoreDriver(CONFIG, client).put('t/raw_inbound/ab', Buffer.from('x'), 'text/plain');

  it('refuses, without retrying, when the configured bucket does not exist', async () => {
    await expect(put(failingClient(s3Error('NoSuchBucket', 404)))).rejects.toMatchObject({
      code: 'dependency_unavailable',
      failureClass: 'configuration',
      retryable: false,
    });
  });

  it('names the bucket and the setting that points at it', async () => {
    await expect(put(failingClient(s3Error('NoSuchBucket', 404)))).rejects.toThrow(
      /eiaaw-fdw-artifacts[\s\S]*OBJECT_STORE_BUCKET/,
    );
  });

  it('points a refused credential at the token bucket scope, not the key', async () => {
    await expect(put(failingClient(s3Error('AccessDenied', 403)))).rejects.toThrow(/bucket scope/);
  });

  it('treats a refused credential as configuration, never as a retry', async () => {
    await expect(put(failingClient(s3Error('InvalidAccessKeyId', 403)))).rejects.toMatchObject({
      failureClass: 'configuration',
      retryable: false,
    });
  });

  it('marks a transient upstream failure retryable', async () => {
    await expect(put(failingClient(s3Error('InternalError', 500)))).rejects.toMatchObject({
      code: 'dependency_unavailable',
      failureClass: 'tool',
      retryable: true,
    });
  });

  it('treats a network failure with no HTTP status as retryable', async () => {
    await expect(put(failingClient(new Error('socket hang up')))).rejects.toMatchObject({
      retryable: true,
    });
  });

  it('carries the key and bucket as structured context', async () => {
    await expect(put(failingClient(s3Error('NoSuchBucket', 404)))).rejects.toMatchObject({
      context: { object_key: 't/raw_inbound/ab', bucket: 'eiaaw-fdw-artifacts' },
    });
  });
});
