/**
 * Model providers.
 *
 * This is the only package permitted to import a provider SDK — D2, enforced by
 * the eslint config, not by convention. Everything above calls the gateway.
 *
 * DWD-06 s.11.1: "Model and provider identities are ALWAYS client-entered; the
 * platform ships route shapes, not vendor choices." So no model id appears as a
 * default anywhere in this file: the caller supplies it from AS-SYS-040.
 */
import { WorkerError, type SecretRef } from '@eiaaw/core';

export interface CompletionRequest {
  readonly model: string;
  readonly system: string;
  readonly user: string;
  readonly maxOutputTokens: number;
  /** Decimal string. Finance work runs at 0 unless a route says otherwise. */
  readonly temperature: string;
  readonly timeoutMs: number;
  readonly stopSequences?: readonly string[];
}

export interface CompletionResponse {
  readonly text: string;
  readonly tokensIn: number;
  readonly tokensOut: number;
  readonly stopReason: 'end_turn' | 'max_tokens' | 'stop_sequence' | 'refusal' | 'other';
  readonly modelReported: string;
}

export type ProviderFailureKind =
  | 'timeout'
  | 'provider_5xx'
  | 'rate_limited'
  | 'content_filter'
  | 'auth'
  | 'invalid_request'
  | 'unknown';

export class ProviderError extends WorkerError {
  readonly kind: ProviderFailureKind;

  constructor(kind: ProviderFailureKind, detail: string, cause?: unknown) {
    super(
      kind === 'rate_limited'
        ? 'rate_limited'
        : kind === 'auth'
          ? 'auth_failed'
          : kind === 'invalid_request'
            ? 'contract_invalid'
            : 'dependency_unavailable',
      {
        detail,
        failureClass: 'model',
        // s.11.3: a content filter or refusal does NOT advance the fallback
        // chain. "Switching models to obtain a different answer is prohibited."
        retryable: kind === 'timeout' || kind === 'provider_5xx' || kind === 'rate_limited',
        cause,
      },
    );
    this.name = 'ProviderError';
    this.kind = kind;
  }
}

export interface ModelProvider {
  readonly id: string;
  complete(request: CompletionRequest): Promise<CompletionResponse>;
}

// ---------------------------------------------------------------------------
// Anthropic
// ---------------------------------------------------------------------------

interface AnthropicMessage {
  content: { type: string; text?: string }[];
  usage: { input_tokens: number; output_tokens: number };
  stop_reason: string | null;
  model: string;
}

export class AnthropicProvider implements ModelProvider {
  readonly id = 'anthropic';
  #client: unknown;

  constructor(private readonly apiKey: SecretRef) {}

  async #ensureClient(): Promise<{
    messages: {
      create(
        body: Record<string, unknown>,
        options?: Record<string, unknown>,
      ): Promise<AnthropicMessage>;
    };
  }> {
    if (this.#client) {
      return this.#client as {
        messages: {
          create(
            body: Record<string, unknown>,
            options?: Record<string, unknown>,
          ): Promise<AnthropicMessage>;
        };
      };
    }
    const mod = (await import('@anthropic-ai/sdk')) as unknown as {
      default: new (opts: { apiKey: string }) => unknown;
    };
    // `expose()` at the point of use, never at assembly — the value never
    // sits in a field where a serialiser could reach it.
    this.#client = new mod.default({ apiKey: this.apiKey.expose() });
    return this.#ensureClient();
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const client = await this.#ensureClient();

    try {
      const response = await client.messages.create(
        {
          model: request.model,
          max_tokens: request.maxOutputTokens,
          temperature: Number(request.temperature),
          system: request.system,
          messages: [{ role: 'user', content: request.user }],
          ...(request.stopSequences ? { stop_sequences: [...request.stopSequences] } : {}),
        },
        { timeout: request.timeoutMs },
      );

      const text = response.content
        .filter((block) => block.type === 'text')
        .map((block) => block.text ?? '')
        .join('');

      return {
        text,
        tokensIn: response.usage.input_tokens,
        tokensOut: response.usage.output_tokens,
        stopReason: mapStopReason(response.stop_reason),
        modelReported: response.model,
      };
    } catch (error) {
      throw new ProviderError(classifyProviderError(error), describeProviderError(error), error);
    }
  }
}

function mapStopReason(raw: string | null): CompletionResponse['stopReason'] {
  switch (raw) {
    case 'end_turn':
      return 'end_turn';
    case 'max_tokens':
      return 'max_tokens';
    case 'stop_sequence':
      return 'stop_sequence';
    case 'refusal':
      return 'refusal';
    default:
      return 'other';
  }
}

function classifyProviderError(error: unknown): ProviderFailureKind {
  const status =
    typeof error === 'object' && error !== null && 'status' in error
      ? Number(error.status)
      : undefined;
  const message = error instanceof Error ? error.message.toLowerCase() : String(error);

  if (message.includes('timeout') || message.includes('aborted')) return 'timeout';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate_limited';
  if (status !== undefined && status >= 500) return 'provider_5xx';
  if (status === 400 && message.includes('content')) return 'content_filter';
  if (status === 400) return 'invalid_request';
  return 'unknown';
}

function describeProviderError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Deterministic stub — the `dev`/`test` provider (s.14.3)
// ---------------------------------------------------------------------------

export interface StubBehaviour {
  /** Matched against the assembled user segment. */
  readonly when: RegExp;
  readonly respond: string | ((user: string) => string);
  readonly failWith?: ProviderFailureKind;
}

/**
 * A scripted provider for the assurance harness and for local development.
 *
 * The harness needs a model whose output is fixed so a gate failure means the
 * gate is wrong, not that the model drifted. It also needs to be able to
 * *induce* failures — a content filter, a timeout — to prove the fallback
 * semantics in s.11.3.
 */
export class StubProvider implements ModelProvider {
  readonly id = 'stub';
  readonly calls: CompletionRequest[] = [];

  constructor(private readonly behaviours: readonly StubBehaviour[] = []) {}

  // eslint-disable-next-line @typescript-eslint/require-await
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    this.calls.push(request);

    const behaviour = this.behaviours.find((b) => b.when.test(request.user));

    if (behaviour?.failWith) {
      throw new ProviderError(behaviour.failWith, `stub induced ${behaviour.failWith}`);
    }

    const text = behaviour
      ? typeof behaviour.respond === 'function'
        ? behaviour.respond(request.user)
        : behaviour.respond
      : 'I cannot answer this from the grounding supplied.';

    return {
      text,
      tokensIn: Math.ceil((request.system.length + request.user.length) / 4),
      tokensOut: Math.ceil(text.length / 4),
      stopReason: 'end_turn',
      modelReported: request.model,
    };
  }
}
