/**
 * @eiaaw/contracts — the sixteen canonical data contracts.
 *
 * DWD-06 s.3: "A component boundary carries only these sixteen shapes."
 * If you are adding a seventeenth, it is not a contract — it is either an
 * internal type belonging inside one component, or a MAJOR change requiring a
 * coordinated release.
 */
export * from './enums.js';
export * from './types.js';
export * from './schemas.js';
export * from './validator.js';
export * from './builders.js';
