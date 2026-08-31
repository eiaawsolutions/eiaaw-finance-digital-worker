/**
 * @eiaaw/workflow — C7, the durable Workflow Executor.
 *
 * DWD-06 s.14.1 lists a "durable workflow engine, Temporal-class" as not
 * deferrable, because the state machines in s.7 assume one. This is that
 * engine, built on Postgres so a Railway deployment is one database and N
 * stateless workers rather than a second distributed system to operate.
 */
export * from './context.js';
export * from './executor.js';
