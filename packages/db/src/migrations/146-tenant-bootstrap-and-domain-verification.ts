import { Kysely, sql } from 'kysely';

/**
 * Two defenses against tenant squatting on the self-service onboarding
 * path (api/home-realm/create, api/tenant/[tenantId]/oidc):
 *
 * - `bootstrap_secret_hash` / `bootstrap_secret_expires_at`: a one-time
 *   secret minted when the tenant is created and shown once to whoever
 *   created it. The first — unauthenticated — identity-provider
 *   configuration must present it, so the tenant a person just created can
 *   only be claimed by that person, not by whoever reaches the id first.
 *   Only the SHA-256 digest is stored; the secret is cleared on use and
 *   dies after 24 hours regardless.
 *
 * - `domain_verification_token` / `domain_verified_at`: the sign-in page
 *   routes an email domain to its tenant only once a `renkei-verify=<token>`
 *   TXT record is published on that domain and checked
 *   (api/tenant/[tenantId]/verify-domain). Creating a tenant for a domain
 *   one does not control no longer captures that domain's sign-ins.
 *
 * Every tenant that exists at migration time is marked verified: they were
 * created before verification existed, and an upgrade must not log every
 * organization out of its own sign-in page. Those tenants carry no
 * bootstrap secret either; an unconfigured one needs an operator to set
 * its identity provider from the database side.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('tenants').addColumn('bootstrap_secret_hash', 'varchar(64)').execute();
  await db.schema
    .alterTable('tenants')
    .addColumn('bootstrap_secret_expires_at', 'timestamptz')
    .execute();
  await db.schema
    .alterTable('tenants')
    .addColumn('domain_verification_token', 'varchar(64)')
    .execute();
  await db.schema.alterTable('tenants').addColumn('domain_verified_at', 'timestamptz').execute();
  await sql`UPDATE tenants SET domain_verified_at = created_at WHERE domain_verified_at IS NULL`.execute(
    db
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('tenants').dropColumn('domain_verified_at').execute();
  await db.schema.alterTable('tenants').dropColumn('domain_verification_token').execute();
  await db.schema.alterTable('tenants').dropColumn('bootstrap_secret_expires_at').execute();
  await db.schema.alterTable('tenants').dropColumn('bootstrap_secret_hash').execute();
}
