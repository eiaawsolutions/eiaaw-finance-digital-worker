/**
 * @eiaaw/delivery — C14, the Delivery Service.
 *
 * Renders the payload per the channel skeleton, sends via the adapters, tracks
 * receipts and captures feedback. No output leaves without a decision record
 * and all five elements of the response contract.
 */
export * from './response-contract.js';
export * from './service.js';
