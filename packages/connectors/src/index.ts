/**
 * @eiaaw/connectors — C10, the Tool Invoker and Connector Runtime.
 *
 * D1: nothing calls a system of record except this package, and it calls only
 * what the L6 registry declares. The eslint config forbids anything outside
 * this package from importing an adapter directly.
 */
export * from './invoker.js';
export { CalculationConnector, totalOf } from './adapters/calc.js';
export {
  StubDocumentConnector,
  StubErpConnector,
  stubConnectors,
  type StubLedgerEntry,
} from './adapters/stub-erp.js';
