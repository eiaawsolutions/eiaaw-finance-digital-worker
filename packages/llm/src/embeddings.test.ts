import { describe, expect, it } from 'vitest';
import { SecretRef } from '@eiaaw/core';
import { VoyageEmbeddingProvider } from './embeddings.js';

const KEY = new SecretRef('VOYAGE_API_KEY', 'pa-test-key');

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** A fetch stand-in that records the request and replays a canned response. */
function fakeFetch(response: unknown, status = 200) {
  const calls: RecordedCall[] = [];
  const impl: typeof fetch = (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    calls.push({
      url,
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(response),
      text: () => Promise.resolve(''),
    } as Response);
  };
  return Object.assign(impl, { calls });
}

/** Voyage returns objects carrying their own `index`, not a positional array. */
const embeddingsResponse = (vectors: number[][]) => ({
  object: 'list',
  data: vectors.map((embedding, index) => ({ object: 'embedding', embedding, index })),
  model: 'test-model',
  usage: { total_tokens: 8 },
});

const provider = (fetchImpl: typeof fetch, dimensions = 3) =>
  new VoyageEmbeddingProvider({ apiKey: KEY, model: 'test-model', dimensions, fetchImpl });

describe('VoyageEmbeddingProvider', () => {
  it('posts to the embeddings endpoint with bearer auth', async () => {
    const f = fakeFetch(embeddingsResponse([[1, 0, 0]]));
    await provider(f).embed(['hello']);

    expect(f.calls[0]?.url).toBe('https://api.voyageai.com/v1/embeddings');
    expect(f.calls[0]?.method).toBe('POST');
    expect(f.calls[0]?.headers['authorization']).toBe('Bearer pa-test-key');
  });

  it('asks for the configured model and output width', async () => {
    const f = fakeFetch(embeddingsResponse([[1, 0, 0]]));
    await provider(f).embed(['hello']);

    expect(JSON.parse(f.calls[0]?.body ?? '{}')).toMatchObject({
      model: 'test-model',
      output_dimension: 3,
      input: ['hello'],
    });
  });

  /**
   * The response carries `index` precisely because the service does not promise
   * array order. Trusting position would silently mis-pair chunks with vectors,
   * which surfaces as bad retrieval rather than as an error.
   */
  it('orders vectors by the index the API reports, not by array position', async () => {
    const f = fakeFetch({
      object: 'list',
      data: [
        { object: 'embedding', embedding: [0, 0, 1], index: 2 },
        { object: 'embedding', embedding: [1, 0, 0], index: 0 },
        { object: 'embedding', embedding: [0, 1, 0], index: 1 },
      ],
      model: 'test-model',
      usage: { total_tokens: 9 },
    });

    expect(await provider(f).embed(['a', 'b', 'c'])).toEqual([
      [1, 0, 0],
      [0, 1, 0],
      [0, 0, 1],
    ]);
  });

  /**
   * The pgvector column has a fixed width. A vector of the wrong length fails
   * at INSERT with a Postgres type error far from its cause, so it is caught
   * here where the provider and its configured width can both be named.
   */
  it('refuses a vector whose width is not the configured one', async () => {
    const f = fakeFetch(embeddingsResponse([[1, 0, 0, 0]]));

    await expect(provider(f, 3).embed(['hello'])).rejects.toThrow(/width|dimension/i);
  });

  it('refuses a response missing a vector for an input', async () => {
    const f = fakeFetch(embeddingsResponse([[1, 0, 0]]));

    await expect(provider(f).embed(['a', 'b'])).rejects.toThrow(/returned 1/);
  });

  it('raises with the status when the API rejects the call', async () => {
    const f = fakeFetch({ detail: 'invalid api key' }, 401);

    await expect(provider(f).embed(['hello'])).rejects.toThrow(/401/);
  });

  it('never puts the api key in the error it raises', async () => {
    const f = fakeFetch({ detail: 'nope' }, 500);

    await expect(provider(f).embed(['hello'])).rejects.not.toThrow(/pa-test-key/);
  });

  it('does not call the API at all for an empty batch', async () => {
    const f = fakeFetch(embeddingsResponse([]));

    expect(await provider(f).embed([])).toEqual([]);
    expect(f.calls).toHaveLength(0);
  });
});
