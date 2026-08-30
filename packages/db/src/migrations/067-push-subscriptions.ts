import { Kysely, sql } from 'kysely';

/**
 * A device's standing invitation for the server to wake it, addressed the
 * same way `agent_notifications` is: one tenant, one subject.
 *
 * This is what makes an OS notification survive a closed tab or a
 * suspended phone. The client-poll path (`agent_notifications` +
 * NotificationCenter) only ever runs while a tab's JavaScript is alive,
 * which iOS in particular stops doing within seconds of backgrounding a
 * PWA — permission granted, service worker registered, and still nothing
 * arrives, because nothing is left running to notice. A subscription here
 * lets the WRITER (worker-agents, or wherever a notification gets
 * recorded) push the browser's own push service directly; the service
 * worker's `push` handler wakes on its own, no open tab required.
 *
 * `endpoint` is the whole subscription's identity as far as the browser is
 * concerned — one per (browser, origin, device), reissued if the browser
 * ever invalidates it. `p256dh`/`auth` are the subscription's own public
 * key and auth secret, required to encrypt a payload it alone can decrypt;
 * neither is sensitive enough to need @renkei/crypto's envelope (they
 * authorize delivery TO a specific browser, not access to anything), unlike
 * the VAPID private key that signs the sender's identity, which is sealed
 * in `platform_settings` instead.
 *
 * `(tenant_id, endpoint)` is unique so re-subscribing the same browser —
 * which `PushManager.subscribe()` returns idempotently for an
 * already-subscribed device — upserts in place rather than piling up
 * duplicate rows that would each get a separate push.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('push_subscriptions')
    .addColumn('id', 'uuid', (col) => col.primaryKey())
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('subject', 'varchar(255)', (col) => col.notNull())
    .addColumn('endpoint', 'text', (col) => col.notNull())
    .addColumn('p256dh', 'text', (col) => col.notNull())
    .addColumn('auth', 'text', (col) => col.notNull())
    .addColumn('created_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .execute();

  await sql`
    CREATE UNIQUE INDEX idx_push_subscriptions_endpoint
      ON push_subscriptions (tenant_id, endpoint)
  `.execute(db);

  // Every send fans out to one subject's subscriptions across their devices.
  await db.schema
    .createIndex('idx_push_subscriptions_subject')
    .on('push_subscriptions')
    .columns(['tenant_id', 'subject'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('push_subscriptions').execute();
}
