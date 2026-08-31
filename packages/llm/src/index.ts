/**
 * @eiaaw/llm — C9, the LLM Gateway.
 *
 * The only package permitted to import a model provider SDK (D2). Everything
 * above the gateway calls `LlmGateway.call`, and the eslint config fails the
 * build if anything else reaches for a provider directly.
 */
export * from './prompt.js';
export * from './providers.js';
export * from './gateway.js';
