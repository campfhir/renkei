import { Kysely } from 'kysely';

/**
 * The shared OAuth callback dispatches on which provider a pending flow
 * belongs to (docs/ui-shell-brief.md follow-on: the WebEx user integration
 * joins Atlassian on /api/oauth/callback). Null means Atlassian — every row
 * written before this column existed was a Jira connect or an OIDC sign-in,
 * and the OIDC callback never reads this table's provider.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('pending_oidc_signin').addColumn('provider', 'varchar(32)').execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable('pending_oidc_signin').dropColumn('provider').execute();
}
