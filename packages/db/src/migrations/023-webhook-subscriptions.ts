import { Kysely, sql } from 'kysely';

/**
 * Provider webhook subscriptions that Renkei itself must create and keep
 * alive. WebEx webhooks never expire, so their state is reconstructed from
 * the provider on every sweep — but Microsoft Graph change-notification
 * subscriptions expire in days and carry secrets of ours (clientState), so
 * they need rows: what we subscribed, for which grant, when it lapses, and
 * where the delta cursor stands.
 *
 * One row per (grant, resource) is both the subscription state AND the sync
 * cursor: notifications and scheduled sweeps run the same delta round from
 * `delta_link`, so the orchestration never cares which producer fired
 * (RENKEI.md's scheduler-as-producer stance).
 *
 * subscription_id is NULL between "we want this subscription" and the
 * provider acknowledging it — a row with a NULL id is the sweep's signal to
 * (re)create.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('webhook_subscriptions')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) => col.notNull().references('tenants.id'))
    .addColumn('provider', 'varchar(32)', (col) => col.notNull())
    // The owning grant's provider_account_id — deliveries are processed
    // under this user's credential, never a shared one.
    .addColumn('account_id', 'varchar(255)', (col) => col.notNull())
    // The OIDC subject behind the grant, denormalized so disconnect can
    // clean up without a join through provider_grants.
    .addColumn('subject', 'varchar(255)')
    // Provider-shaped resource path (e.g. me/mailFolders('inbox')/messages).
    .addColumn('resource', 'varchar(255)', (col) => col.notNull())
    .addColumn('subscription_id', 'varchar(255)')
    // Echoed back by the provider on each delivery; a mismatch is a forgery.
    .addColumn('client_state', 'varchar(128)', (col) => col.notNull())
    .addColumn('expires_at', 'timestamp')
    .addColumn('delta_link', 'text')
    .addColumn('created_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addColumn('updated_at', 'timestamp', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  // One subscription per grant per resource; re-bootstrapping upserts.
  await db.schema
    .createIndex('idx_webhook_subscriptions_grant_resource')
    .unique()
    .on('webhook_subscriptions')
    .columns(['tenant_id', 'provider', 'account_id', 'resource'])
    .execute();

  // Deliveries look up by the provider's subscription id.
  await db.schema
    .createIndex('idx_webhook_subscriptions_subscription_id')
    .on('webhook_subscriptions')
    .columns(['subscription_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('webhook_subscriptions').execute();
}
