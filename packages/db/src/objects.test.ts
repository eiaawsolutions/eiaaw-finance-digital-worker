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
