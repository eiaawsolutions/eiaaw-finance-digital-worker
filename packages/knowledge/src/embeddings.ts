/**
 * Embedding providers.
 *
 * The interface lives here; the *hosted* implementation lives in `@eiaaw/llm`,
 * because D2 says nothing calls a model except C9 and the eslint config
 * enforces it by banning provider SDK imports outside that package.
 *
 * The deterministic provider below is not a stub in the pejorative sense. It is
 * the `dev`/`test` implementation the deployment table calls for (s.14.3:
 * "dev: synthetic only, stubs implementing the capability schemas"), and it has
 * one property a hosted model cannot offer: identical vectors across runs, so
 * a retrieval test asserts retrieval logic rather than embedding drift.
 */
import { createHash } from 'node:crypto';
import type { EmbeddingProvider } from './service.js';

/**
 * Hashed bag-of-tokens projected into a fixed-width unit vector.
 *
 * Lexical overlap moves vectors closer together, which is enough to exercise
 * ranking, filtering and the coverage-gap paths deterministically. It is not
 * semantic, and it is never used outside dev and test — `createEmbeddingProvider`
 * refuses to return it in prod.
 */
export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly model = 'deterministic-hash-v1';
  readonly dimensions: number;

  constructor(dimensions = 1536) {
    this.dimensions = dimensions;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async embed(texts: readonly string[]): Promise<number[][]> {
    return texts.map((text) => this.#embedOne(text));
  }

  #embedOne(text: string): number[] {
    const vector = new Array<number>(this.dimensions).fill(0);
    const tokens = text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 2);

    for (const token of tokens) {
      const digest = createHash('sha256').update(token).digest();
      // Three positions per token so a short text still occupies enough of the
      // space for cosine distance to discriminate.
      for (let i = 0; i < 3; i += 1) {
        const index = digest.readUInt32BE(i * 4) % this.dimensions;
        const sign = (digest[12 + i] as number) % 2 === 0 ? 1 : -1;
        vector[index] = (vector[index] as number) + sign;
      }
    }

    const norm = Math.sqrt(vector.reduce((acc, v) => acc + v * v, 0));
    if (norm === 0) {
      // An empty or all-stopword text still needs a valid unit vector.
      vector[0] = 1;
      return vector;
    }
    return vector.map((v) => v / norm);
  }
}

export function createEmbeddingProvider(options: {
  readonly deployEnvironment: string;
  readonly hosted?: EmbeddingProvider;
  readonly dimensions?: number;
}): EmbeddingProvider {
  if (options.hosted) return options.hosted;

  if (options.deployEnvironment === 'prod') {
    throw new Error(
      'No hosted embedding provider is configured, and the deterministic provider is ' +
        'refused in prod. Configure the model at AS-SYS-040 and register the provider ' +
        'from @eiaaw/llm.',
    );
  }

  return new DeterministicEmbeddingProvider(options.dimensions ?? 1536);
}
