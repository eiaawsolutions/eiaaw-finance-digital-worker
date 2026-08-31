/**
 * @eiaaw/channels — C1, the Channel Gateway and its four adapters.
 *
 * D3: this package emits an `InboundRequest` and receives an `OutboundDelivery`.
 * It never calls the planner, the policy engine, the workflow executor, the
 * tool invoker, the knowledge service or the records service — the eslint
 * config fails the build if it tries.
 */
export * from './adapter.js';
export * from './capabilities.js';
export * from './webhooks.js';
export * from './whatsapp-port.js';
