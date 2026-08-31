/**
 * C9 — the LLM Gateway. DWD-06 s.11.
 *
 *   D2:     "Nothing calls a model except C9, and C9 is called only by C8."
 *   s.11.4: "The gateway REFUSES a call that would exceed the graph ceiling
 *            rather than making it and reporting an overrun afterwards."
 *   s.11.3: on a content filter or a provider refusal — "Do not advance. Treat
 *            as a model failure and halt. SWITCHING MODELS TO OBTAIN A DIFFERENT
 *            ANSWER IS PROHIBITED."
 *   s.11.3: "Fallback used on a state-changing skill in execute mode → node is
 *            downgraded to draft for this run and a hand-off is raised, because
 *            the route that was benchmarked was not the route that ran."
 *
 * The last one is the subtle one and the easiest to omit: a fallback is not a
 * free substitution. The accuracy floor that justified Execute autonomy was
 * measured on the primary route.
 */
import {
  type Money,
  type Result,
  WorkerError,
  add,
  err,
  greaterThan,
  money,
  multiplyByRate,
  newNonce,
  ok,
} from '@eiaaw/core';
import type { AutonomyLevel, SkillMode } from '@eiaaw/contracts';
import { recordLlmUsage, withSpan } from '@eiaaw/telemetry';
import { type AssembledPrompt } from './prompt.js';
import {
  type CompletionResponse,
  type ModelProvider,
  ProviderError,
  type ProviderFailureKind,
} from './providers.js';

/** DWD-06 s.11.1 — every value is client-entered at AS-SYS-*. */
export interface ModelRoute {
  readonly route_id: string;
  readonly skill_id: string;
  readonly mode: SkillMode;
  readonly primary: RouteTarget;
  readonly fallbacks: readonly FallbackTarget[];
  readonly max_context_tokens: number;
  readonly cost_ceiling_per_call: Money;
  readonly residency_zone: string;
  readonly data_handling: {
    readonly training_opt_out: boolean;
    readonly retention: string;
  };
  readonly route_version: string;
}

export interface RouteTarget {
  readonly provider: string;
  readonly model: string;
  readonly max_output_tokens: number;
  /** Decimal string — never a float (s.2.2). */
  readonly temperature: string;
  readonly timeout_ms: number;
  /** Client-entered unit prices, in minor units per million tokens. */
  readonly price_per_million_input_minor: number;
  readonly price_per_million_output_minor: number;
}

export interface FallbackTarget extends RouteTarget {
  /** s.11.3 — only these conditions advance the chain. */
  readonly conditions: readonly ProviderFailureKind[];
}

export interface GatewayCallInput {
  readonly tenant_id: string;
  readonly graph_id: string;
  readonly node_id: string;
  readonly skill_id: string;
  readonly mode: SkillMode;
  readonly route: ModelRoute;
  readonly prompt: AssembledPrompt;
  readonly channel: string;
  readonly entity_id: string;
  readonly trace_id: string;
  /** Remaining graph budget. The call is refused if it could exceed this. */
  readonly budget_remaining: Money;
  readonly tokens_remaining: number;
  /** True when the node is state-changing at Execute — see the fallback rule. */
  readonly state_changing: boolean;
  readonly effective_autonomy: AutonomyLevel;
}

export interface GatewayCallResult {
  readonly text: string;
  readonly route_id: string;
  readonly model: string;
  readonly fallback_used: boolean;
  readonly tokens: { readonly input: number; readonly output: number };
  readonly cost: Money;
  readonly duration_ms: number;
  readonly segment_hashes: Readonly<Record<string, string>>;
  /**
   * s.11.3: set when a fallback ran on a state-changing execute node. The
   * caller must downgrade the node to draft and raise a hand-off.
   */
  readonly downgrade_to_draft: boolean;
  readonly attempts: readonly {
    readonly provider: string;
    readonly model: string;
    readonly outcome: 'success' | ProviderFailureKind;
  }[];
}

export interface LlmGatewayOptions {
  readonly providers: ReadonlyMap<string, ModelProvider>;
  /** Hard platform ceiling. A tenant budget may be lower, never higher. */
  readonly globalCostCeiling: Money;
}

export class LlmGateway {
  readonly #providers: ReadonlyMap<string, ModelProvider>;
  readonly #globalCeiling: Money;

  constructor(options: LlmGatewayOptions) {
    this.#providers = options.providers;
    this.#globalCeiling = options.globalCostCeiling;
  }

  async call(input: GatewayCallInput): Promise<Result<GatewayCallResult>> {
    // --- budget, checked BEFORE the spend (s.11.4) -------------------------
    const estimatedTokensIn = Math.ceil(
      (input.prompt.system.length + input.prompt.user.length) / 4,
    );

    if (estimatedTokensIn > input.route.max_context_tokens) {
      return err(
        new WorkerError('unprocessable_content', {
          detail:
            `The assembled prompt is approximately ${estimatedTokensIn} tokens, above this ` +
            `route's context ceiling of ${input.route.max_context_tokens}. Reduce the ` +
            'grounding set rather than truncating it — a silently truncated prompt drops ' +
            'citations the answer depends on.',
          failureClass: 'budget',
          retryable: false,
        }),
      );
    }

    if (estimatedTokensIn > input.tokens_remaining) {
      return err(this.#budgetRefusal('token', input));
    }

    const worstCase = this.#estimateCost(
      input.route.primary,
      estimatedTokensIn,
      input.route.primary.max_output_tokens,
    );

    if (greaterThan(worstCase, input.budget_remaining)) {
      return err(this.#budgetRefusal('cost', input));
    }
    if (greaterThan(worstCase, input.route.cost_ceiling_per_call)) {
      return err(
        new WorkerError('unprocessable_content', {
          detail:
            `This call could cost up to ${worstCase.amount_minor} minor units, above the ` +
            `per-call ceiling of ${input.route.cost_ceiling_per_call.amount_minor} at ` +
            'AS-SYS-BGT-*. Refused before the spend, not reported after it.',
          failureClass: 'budget',
          retryable: false,
        }),
      );
    }
    if (greaterThan(worstCase, this.#globalCeiling)) {
      return err(
        new WorkerError('unprocessable_content', {
          detail: 'This call would exceed the platform-wide per-call cost ceiling.',
          failureClass: 'budget',
          retryable: false,
        }),
      );
    }

    // --- the chain ---------------------------------------------------------
    const targets: readonly (RouteTarget & {
      isFallback: boolean;
      conditions?: readonly ProviderFailureKind[];
    })[] = [
      { ...input.route.primary, isFallback: false },
      ...input.route.fallbacks.map((f) => ({ ...f, isFallback: true })),
    ];

    const attempts: {
      provider: string;
      model: string;
      outcome: 'success' | ProviderFailureKind;
    }[] = [];
    let lastError: ProviderError | null = null;

    for (const target of targets) {
      // A fallback only runs for the conditions it declares.
      if (target.isFallback) {
        const permitted = target.conditions ?? [];
        if (lastError === null || !permitted.includes(lastError.kind)) break;
      }

      const provider = this.#providers.get(target.provider);
      if (!provider) {
        lastError = new ProviderError(
          'invalid_request',
          `No provider is registered for "${target.provider}". Model and provider are ` +
            'client-entered at AS-SYS-040; the platform ships route shapes, not vendors.',
        );
        attempts.push({
          provider: target.provider,
          model: target.model,
          outcome: 'invalid_request',
        });
        continue;
      }

      const started = Date.now();

      try {
        const response = await withSpan(
          'llm.call',
          { tenant_id: input.tenant_id, trace_id: input.trace_id, graph_id: input.graph_id },
          {
            route_id: input.route.route_id,
            model: target.model,
            fallback_used: target.isFallback,
          },
          async () =>
            provider.complete({
              model: target.model,
              system: input.prompt.system,
              user: input.prompt.user,
              maxOutputTokens: target.max_output_tokens,
              temperature: target.temperature,
              timeoutMs: target.timeout_ms,
            }),
        );

        // s.11.3: a provider refusal is a model failure, and it does NOT
        // advance the chain. Trying another model to get a different answer is
        // exactly what this forbids.
        if (response.stopReason === 'refusal') {
          attempts.push({
            provider: target.provider,
            model: target.model,
            outcome: 'content_filter',
          });
          return err(
            new WorkerError('unprocessable_content', {
              detail:
                'The model declined to respond. This halts the task. Switching models to ' +
                'obtain a different answer is prohibited (DWD-06 s.11.3).',
              failureClass: 'model',
              retryable: false,
            }),
          );
        }

        const cost = this.#actualCost(target, response);
        attempts.push({ provider: target.provider, model: target.model, outcome: 'success' });

        recordLlmUsage({
          skill: input.skill_id,
          route: input.route.route_id,
          tenant: input.tenant_id,
          channel: input.channel,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
          costMinor: cost.amount_minor,
        });

        // s.11.3: the benchmarked route was not the route that ran.
        const downgrade =
          target.isFallback && input.state_changing && input.effective_autonomy === 'execute';

        return ok({
          text: response.text,
          route_id: input.route.route_id,
          model: target.model,
          fallback_used: target.isFallback,
          tokens: { input: response.tokensIn, output: response.tokensOut },
          cost,
          duration_ms: Date.now() - started,
          segment_hashes: input.prompt.segmentHashes,
          downgrade_to_draft: downgrade,
          attempts,
        });
      } catch (error) {
        if (!(error instanceof ProviderError)) throw error;
        lastError = error;
        attempts.push({ provider: target.provider, model: target.model, outcome: error.kind });

        // A content filter never advances the chain, whatever the route says.
        if (error.kind === 'content_filter') {
          return err(
            new WorkerError('unprocessable_content', {
              detail:
                'The provider filtered this request. This halts the task; the chain is not ' +
                'advanced, because switching models to obtain a different answer is prohibited.',
              failureClass: 'model',
              retryable: false,
            }),
          );
        }
      }
    }

    // s.11.3: all routes exhausted → model failure class; the graph halts and
    // hands off. A model failure never becomes a guess.
    return err(
      new WorkerError('dependency_unavailable', {
        detail:
          'Every route in the chain failed: ' +
          attempts.map((a) => `${a.provider}/${a.model} (${a.outcome})`).join(', ') +
          '. The task halts and hands off rather than proceeding without a model.',
        failureClass: 'model',
        retryable: false,
        context: { attempts },
      }),
    );
  }

  #estimateCost(target: RouteTarget, tokensIn: number, tokensOut: number): Money {
    const currency = this.#globalCeiling.currency;
    const inputCost = multiplyByRate(
      money(target.price_per_million_input_minor, currency),
      String(tokensIn / 1_000_000),
    );
    const outputCost = multiplyByRate(
      money(target.price_per_million_output_minor, currency),
      String(tokensOut / 1_000_000),
    );
    return add(inputCost, outputCost);
  }

  #actualCost(target: RouteTarget, response: CompletionResponse): Money {
    return this.#estimateCost(target, response.tokensIn, response.tokensOut);
  }

  #budgetRefusal(kind: 'token' | 'cost', input: GatewayCallInput): WorkerError {
    return new WorkerError('unprocessable_content', {
      detail:
        kind === 'token'
          ? `This call would exceed the graph's remaining token budget of ` +
            `${input.tokens_remaining}. The graph halts with a budget failure and the ` +
            'partial results are preserved.'
          : `This call would exceed the graph's remaining budget of ` +
            `${input.budget_remaining.amount_minor} ${input.budget_remaining.currency} minor ` +
            'units. Refused before the spend rather than reported after it.',
      failureClass: 'budget',
      retryable: false,
      context: { graph_id: input.graph_id, node_id: input.node_id },
    });
  }
}

/**
 * Build a route from tenant configuration.
 *
 * Every field comes from AS-SYS-*. There is no default model, no default
 * provider and no default price — a route that cannot be built from
 * configuration is a refusal, not a fallback to something sensible.
 */
export function buildRoute(input: {
  readonly skill_id: string;
  readonly mode: SkillMode;
  readonly config: Record<string, unknown>;
  readonly residencyZone: string;
  readonly costCeiling: Money;
}): Result<ModelRoute> {
  const primary = input.config['primary'] as RouteTarget | undefined;
  if (!primary?.provider || !primary.model) {
    return err(
      new WorkerError('contract_invalid', {
        detail:
          `No model route is configured for skill ${input.skill_id} in ${input.mode} mode. ` +
          'The provider and model are client-entered at AS-SYS-040; the platform ships ' +
          'route shapes, not vendor choices, and will not pick one for you.',
        failureClass: 'configuration',
        retryable: false,
      }),
    );
  }

  return ok({
    route_id: `rt-${input.skill_id.toLowerCase()}-${input.mode}`,
    skill_id: input.skill_id,
    mode: input.mode,
    primary,
    fallbacks: (input.config['fallbacks'] as FallbackTarget[] | undefined) ?? [],
    max_context_tokens: (input.config['max_context_tokens'] as number | undefined) ?? 200_000,
    cost_ceiling_per_call: input.costCeiling,
    residency_zone: input.residencyZone,
    data_handling: (input.config['data_handling'] as ModelRoute['data_handling'] | undefined) ?? {
      training_opt_out: true,
      retention: 'zero_or_minimum_available',
    },
    route_version: (input.config['route_version'] as string | undefined) ?? '1.0.0',
  });
}

/** A nonce per call, so the untrusted fence token is unpredictable. */
export const newFenceNonce = (): string => newNonce();
