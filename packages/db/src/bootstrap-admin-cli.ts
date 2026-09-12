#!/usr/bin/env tsx
/**
 * Grant the first console administrator.
 *
 * Creates the three rows a person needs before they can sign in: a principal,
 * a directory entry so their address resolves to a tenant, and an empty
 * credential row whose existence *is* the grant. It sets no password and no
 * authenticator seed — those are chosen by the person themselves from the
 * enrolment link, so this script never handles a secret and never needs to
 * print one.
 *
 * The address is an argument rather than a constant because a personal email
 * address does not belong in the history of a public repository.
 *
 * Safe to re-run. Running it again for an existing address re-grants console
 * access without disturbing a password or an enrolled authenticator, which is
 * also how you restore access you revoked.
 *
 *   pnpm db:bootstrap-admin someone@example.com
 *   pnpm db:bootstrap-admin someone@example.com --tenant tnt_other --name "Their Name"
 */
import { createHash } from 'node:crypto';
import { closeDatabase, createDatabase, withPlatformScope, withTenant } from './client.js';

const DEFAULT_TENANT = 'tnt_eiaaw';

interface Args {
  readonly email: string;
  readonly tenantId: string;
  readonly displayName: string;
  readonly principalId: string;
}

function parseArgs(argv: readonly string[]): Args {
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const email = positional[0]?.trim().toLowerCase();

  if (!email || !email.includes('@')) {
    console.error('Usage: pnpm db:bootstrap-admin <email> [--tenant tnt_x] [--name "Full Name"]');
    process.exit(1);
  }

  const flag = (name: string): string | undefined => {
    const index = argv.indexOf(`--${name}`);
    return index === -1 ? undefined : argv[index + 1];
  };

  // Derived from the address so re-running is idempotent, and prefixed so it
  // reads as a person in an audit trail rather than as an opaque identifier.
  const local = email.split('@')[0] ?? 'admin';
  const principalId = `usr_${local.replace(/[^a-z0-9]+/g, '-').slice(0, 40)}`;

  return {
    email,
    tenantId: flag('tenant') ?? DEFAULT_TENANT,
    displayName: flag('name') ?? email,
    principalId,
  };
}

async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (!url) {
    console.error('DATABASE_URL is not set.');
    process.exit(1);
  }

  const args = parseArgs(process.argv.slice(2));
  const residencyZone = process.env['RESIDENCY_ZONE'] ?? 'my-central';
  const emailHash = createHash('sha256').update(args.email).digest('hex');

  const db = createDatabase({
    url,
    poolMax: 2,
    ssl: process.env['DATABASE_SSL'] === 'true',
    applicationName: 'eiaaw-fdw-bootstrap-admin',
  });

  try {
    const tenantExists = await withPlatformScope(db, async (sql) => {
      const rows = await sql<{ tenant_id: string }[]>`
        SELECT tenant_id FROM tenants WHERE tenant_id = ${args.tenantId}
      `;
      return rows.length > 0;
    });

    if (!tenantExists) {
      console.error(
        `Tenant ${args.tenantId} does not exist. Migration 0011 creates ${DEFAULT_TENANT}; ` +
          'run the migrations first, or name a tenant that exists with --tenant.',
      );
      process.exit(1);
    }

    await withTenant(db, { tenantId: args.tenantId, residencyZone }, async (scope) => {
      await scope.sql`
        INSERT INTO principals (tenant_id, principal_id, display_name, primary_email, clearance)
        VALUES (${args.tenantId}, ${args.principalId}, ${args.displayName}, ${args.email}, 'restricted')
        ON CONFLICT (tenant_id, principal_id) DO UPDATE
          SET primary_email = EXCLUDED.primary_email,
              display_name  = EXCLUDED.display_name,
              status        = 'active',
              updated_at    = now()
      `;

      // The row's existence is the grant. Both secrets stay null: the person
      // chooses their own password and enrols their own authenticator, so this
      // script never holds either.
      await scope.sql`
        INSERT INTO console_credentials (tenant_id, principal_id)
        VALUES (${args.tenantId}, ${args.principalId})
        ON CONFLICT (tenant_id, principal_id) DO NOTHING
      `;
    });

    // Outside tenant scope on purpose: this is the one cross-tenant table, and
    // it is what lets a sign-in form find the tenant before one is known.
    await withPlatformScope(db, async (sql) => {
      await sql`
        INSERT INTO console_directory (email_hash, tenant_id, principal_id)
        VALUES (${emailHash}, ${args.tenantId}, ${args.principalId})
        ON CONFLICT (email_hash) DO UPDATE
          SET tenant_id = EXCLUDED.tenant_id,
              principal_id = EXCLUDED.principal_id,
              updated_at = now()
      `;
    });

    console.log('');
    console.log(`  Console access granted`);
    console.log(`    address     ${args.email}`);
    console.log(`    tenant      ${args.tenantId}`);
    console.log(`    principal   ${args.principalId}`);
    console.log('');
    console.log('  No password or authenticator was set. Open the console, enter that');
    console.log('  address, and follow the link it emails you.');
    console.log('');
  } finally {
    await closeDatabase(db);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
