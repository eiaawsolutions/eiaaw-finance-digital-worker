/**
 * @eiaaw/intake — C4, Intake and Classifier.
 *
 * Thread reconstruction, dedupe, admission, intent classification and routing.
 * Classification is lexical by design: routing decides which governed pipeline
 * runs, and a model in that position would be an injection surface with
 * authority (file 03 s.12).
 */
export * from './classifier.js';
export * from './admission.js';
