/**
 * Hosted embedding provider.
 *
 * Lives here rather than in `@eiaaw/knowledge` because D2 says nothing calls a
 * model except C9, and the eslint config enforces it. `@eiaaw/knowledge` owns
 * the port and the deterministic dev implementation; this is the hosted one.
 *
 * DWD-06 s.11.1: model and provider identities are client-entered, so no model
 * id is defaulted here. The caller supplies it, and a deployment that has not
 * chosen one does not get a provider.
 */
import { WorkerError, type SecretRef } from '@eiaaw/core';

/**
 * Structurally identical to `EmbeddingProvider` in `@eiaaw/knowledge`. Declared
 * rather than imported: `@eiaaw/knowledge` does not depend on this package and
 * must not start, so the shape is the contract.
 */
export interface HostedEmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: readonly string[]): Promise<number[][]>;
}

export interface VoyageEmbeddingOptions {
  readonly apiKey: SecretRef;
  /** From configuration. No default — see s.11.1. */
  readonly model: string;
  /** Must equal the width of the pgvector column the vectors land in. */
  readonly dimensions: number;
  readonly timeoutMs?: number;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
}

interface VoyageResponse {
  data?: { embedding?: number[]; index?: number }[];
}

const DEFAULT_BASE_URL = 'https://api.voyageai.com/v1';
const DEFAULT_TIMEOUT_MS = 30_000;

export class VoyageEmbeddingProvider implements HostedEmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  readonly #apiKey: SecretRef;
  readonly #timeoutMs: number;
  readonly #baseUrl: string;
  readonly #fetch: typeof fetch;

  constructor(options: VoyageEmbeddingOptions) {
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.#apiKey = options.apiKey;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /**
   * `input_type` is deliberately left unset.
   *
   * Voyage prepends a different prompt for `document` and `query`, which helps
   * retrieval only when indexing and searching use the matching pair. The port
   * this implements embeds through one method with no notion of which side it
   * is on, so setting either value would guarantee a mismatch on the other.
   * Symmetric and unprompted beats asymmetric and mispaired. Threading the
   * distinction through `EmbeddingProvider` is the improvement, not guessing.
   */
  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.#timeoutMs);

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          // `expose()` at the point of use, never at assembly.
          authorization: `Bearer ${this.#apiKey.expose()}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          input: texts,
          model: this.model,
          output_dimension: this.dimensions,
        }),
        signal: controller.signal,
      });
    } catch (cause) {
      throw new WorkerError('dependency_unavailable', {
        detail: `The embedding provider did not respond within ${this.#timeoutMs}ms.`,
        failureClass: 'transport',
        retryable: true,
        cause,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!response.ok) {
      // The status and nothing else: a provider error body can echo the request,
      // and the request carries the key.
      throw new WorkerError('dependency_unavailable', {
        detail:
          `The embedding provider rejected the call with HTTP ${response.status}. ` +
          `Verify VOYAGE_API_KEY and that model "${this.model}" is available to this account.`,
        failureClass: 'model',
        retryable: response.status >= 500 || response.status === 429,
      });
    }

    const payload = (await response.json()) as VoyageResponse;
    const rows = payload.data ?? [];

    if (rows.length !== texts.length) {
      throw new WorkerError('dependency_unavailable', {
        detail:
          `Asked the embedding provider for ${texts.length} vector(s) and it returned ` +
          `${rows.length}. Embedding a chunk set partially would pair vectors with the ` +
          'wrong chunks, so the batch is refused.',
        failureClass: 'model',
        retryable: true,
      });
    }

    // Ordered by the reported index, not by array position — the API returns
    // `index` precisely because position is not promised.
    const vectors = new Array<number[] | undefined>(texts.length);
    for (const [position, row] of rows.entries()) {
      const index = row.index ?? position;
      const embedding = row.embedding;

      if (!embedding) {
        throw new WorkerError('dependency_unavailable', {
          detail: `The embedding provider returned an entry with no vector at index ${index}.`,
          failureClass: 'model',
          retryable: true,
        });
      }
      if (embedding.length !== this.dimensions) {
        throw new WorkerError('contract_invalid', {
          detail:
            `Model "${this.model}" returned a vector of width ${embedding.length}, but this ` +
            `deployment is configured for ${this.dimensions} and the knowledge_embeddings ` +
            'column is fixed at that width. A width change is a model change: migrate the ' +
            'column and re-embed the corpus rather than storing mixed widths.',
          failureClass: 'configuration',
          retryable: false,
        });
      }
      if (index < 0 || index >= texts.length) {
        throw new WorkerError('dependency_unavailable', {
          detail: `The embedding provider reported index ${index} for a batch of ${texts.length}.`,
          failureClass: 'model',
          retryable: true,
        });
      }
      vectors[index] = embedding;
    }

    const complete = vectors.filter((v): v is number[] => v !== undefined);
    if (complete.length !== texts.length) {
      throw new WorkerError('dependency_unavailable', {
        detail:
          'The embedding provider returned duplicate indices, leaving an input without a ' +
          'vector. The batch is refused rather than stored partially paired.',
        failureClass: 'model',
        retryable: true,
      });
    }
    return complete;
  }
}
