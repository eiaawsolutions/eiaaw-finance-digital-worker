/**
 * @eiaaw/config — C16, the Configuration Service.
 *
 * DWD-06 s.1.3 D7: "C16 answers presence and value; it never answers 'what
 * should happen'." Nothing here interprets a value — interpretation belongs to
 * the policy engine, which reads from here.
 */
export * from './resolver.js';
export * from './catalogue.js';
export * from './seed.js';
export * from './validate.js';
