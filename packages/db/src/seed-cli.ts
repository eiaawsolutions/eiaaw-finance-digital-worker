#!/usr/bin/env tsx
/**
 * Platform seed.
 *
 * Publishes the artefacts the platform OWNS — the AS- field catalogue, the L9
 * reserved-acts register, and the L6 tool registry — into tables the worker's
 * database role can read but not write.
 *
 * It seeds NO client values. admin-settings 00-INDEX s.7: "The platform ships
 * no client value and no statutory rate." Every threshold, rate, limit and
 * approver is entered by a human at enrolment, and until that happens the
 * settings-health endpoint reports the tenant as not ready.
 *
 * Safe to re-run: every insert is an upsert.
 */
import { seedCatalogue } from '@eiaaw/config';
import { seedRegistries } from '@eiaaw/registry';
import { closeDatabase, createDatabase, withPlatformScope } from './client.js';

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const db = createDatabase({
    url,
    poolMax: 2,
    ssl: process.env['DATABASE_SSL'] === 'true',
    applicationName: 'eiaaw-fdw-seed',
    statementTimeoutMs: 120_000,
  });

  try {
    console.log('Seeding platform-owned registries\n');

    const catalogue = await seedCatalogue(db);
    console.log(`  AS- field catalogue     ${catalogue.total} fields`);

    const registries = await seedRegistries(db);
    console.log(`  output-class register   ${registries.output_classes} classes`);
    console.log(`  tool registry           ${registries.tools} tools`);
    console.log(`  skill registry          ${registries.skills} skills`);

    // A tenant may be created here so an operator has somewhere to enrol into.
    const tenantId = process.env['SEED_TENANT_ID'];
    if (tenantId) {
      await withPlatformScope(db, async (sql) => {
        await sql`
          INSERT INTO tenants (tenant_id, display_name, residency_zone, status)
          VALUES (
            ${tenantId},
            ${process.env['SEED_TENANT_NAME'] ?? tenantId},
            ${process.env['RESIDENCY_ZONE'] ?? 'my-central'},
            'provisioning'
          )
          ON CONFLICT (tenant_id) DO NOTHING
        `;
      });
      console.log(`\n  tenant ${tenantId} created in status "provisioning"`);
    }

    console.log(
      '\n  No client values were seeded. Every threshold, rate, limit and approver is\n' +
        '  entered by a human at enrolment; until then the settings-health endpoint\n' +
        '  reports this tenant as not ready and no SOP will run.\n',
    );
  } catch (error) {
    console.error('\nSeed failed:\n');
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  } finally {
    await closeDatabase(db);
  }
}

void main();
