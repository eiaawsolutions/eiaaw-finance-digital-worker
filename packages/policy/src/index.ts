/**
 * @eiaaw/policy — C6, the Policy Engine, and the eleven immutable rules.
 *
 * D5: consulted by the workflow executor (C7), never by the skill runtime (C8).
 * A skill cannot ask for its own permission, and the eslint config enforces it.
 */
export * from './immutable-rules.js';
export * from './autonomy.js';
export * from './engine.js';
