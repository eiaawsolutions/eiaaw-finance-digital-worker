#!/usr/bin/env tsx
/**
 * Chain verification job — DWD-06 s.10.5.
 *
 *   "verification job that walks the chain and alerts on a break"
 *
 * Run on a schedule. A break is an incident, not a warning: exit code 1 so a
 * scheduler or an alerting rule can act on it without parsing output.
 */
import { createHmac } from 'node:crypto';
import { closeDatabase, createDatabase, withPlatformScope } from '@eiaaw/db';
import { newId } from '@eiaaw/core';
import { AuditStore } from './store.js';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const residencyZone = process.env['RESIDENCY_ZONE'] ?? 'my-central';
  const anchorKey = process.env['AUDIT_CHAIN_ANCHOR_KEY'] ?? '';
  const shouldAnchor = process.argv.includes('--anchor');

  const db = createDatabase({ url, poolMax: 2, ssl: process.env['DATABASE_SSL'] === 'true' });
  const store = new AuditStore({ db, residencyZone });

  let broken = 0;

  try {
    const tenants = await withPlatformScope(
      db,
      async (sql) =>
        sql<{ tenant_id: string }[]>`
        SELECT tenant_id FROM tenants WHERE status IN ('active', 'suspended')
      `,
    );

    for (const { tenant_id } of tenants) {
      const result = await store.verifySegment(tenant_id);
      await store.recordVerification(tenant_id, result, newId('auditEvent'));

      if (result.ok) {
        console.log(
          `  ${tenant_id.padEnd(28)} ok      ${result.verified} events ` +
            `(seq ${result.from}..${result.to})`,
        );
      } else {
        broken += 1;
        console.error(
          `  ${tenant_id.padEnd(28)} BROKEN  at sequence ` +
            `${result.from + (result.brokenAt?.index ?? 0)}: ${result.brokenAt?.reason}`,
        );
      }

      if (shouldAnchor && result.ok) {
        if (!anchorKey) {
          console.error('  --anchor requested but AUDIT_CHAIN_ANCHOR_KEY is not set.');
          process.exit(1);
        }
        const anchor = await store.anchor(tenant_id, newId('auditEvent'), (payload) =>
          createHmac('sha256', anchorKey).update(payload).digest('hex'),
        );
        if (anchor) {
          console.log(`  ${''.padEnd(28)} anchored at sequence ${anchor.head_sequence}`);
        }
      }
    }

    if (broken > 0) {
      console.error(
        `\n✖ ${broken} tenant chain(s) BROKEN. This is an incident: the audit log is the ` +
          'record on which every other control depends.',
      );
      process.exit(1);
    }

    console.log(`\n✔ all ${tenants.length} tenant chain(s) verify.`);
    process.exit(0);
  } finally {
    await closeDatabase(db);
  }
}

void main();
