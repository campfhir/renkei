import { Kysely, sql } from 'kysely';

/**
 * IdP group claims, so an admin can scope a connector to an audience.
 *
 * Sign-in used to read one claim and keep two facts from it — operator or
 * user — discarding the rest. Audience rules ("Bitbucket is for people in
 * `eng-platform`") need the raw values, so:
 *
 * - `tenant_oidc.groups_claim` names the id_token claim carrying a person's
 *   groups. NULL means the conventional `groups`. Kept separate from
 *   `role_claim`: Entra puts app roles in one claim and directory groups in
 *   another, and an org may map operators from the first and audiences
 *   from the second.
 * - `identities.idp_groups` holds the values the claim carried at the
 *   person's LAST sign-in, replaced wholesale each time — a group the IdP
 *   removed is gone on their next session, never lingering. It lives on
 *   identities rather than in its own table because the audience question
 *   is asked per subject on every MCP connection, and `identities.updated_at`
 *   already feeds the tool-surface version, so a changed set retires the
 *   cached handler without any new plumbing. Claims are not authorization
 *   by themselves; the audience rules in tenant_settings are.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('tenant_oidc').addColumn('groups_claim', 'varchar(128)').execute();

  await db.schema
    .alterTable('identities')
    .addColumn('idp_groups', sql`text[]`, (col) => col.notNull().defaultTo(sql`'{}'::text[]`))
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('identities').dropColumn('idp_groups').execute();
  await db.schema.alterTable('tenant_oidc').dropColumn('groups_claim').execute();
}
