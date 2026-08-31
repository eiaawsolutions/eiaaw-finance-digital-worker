/**
 * @eiaaw/skills — C8, the Skill Runtime.
 *
 * D2: the only component that calls the LLM gateway.
 * D5: it never consults the policy engine — a skill cannot ask for its own
 *     permission, and the eslint config enforces that by import restriction.
 */
export * from './runtime.js';
