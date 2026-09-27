import { Kysely, sql } from 'kysely';

/**
 * A preview card's confirm/cancel decision, durable across devices.
 *
 * Today a card's "already decided" receipt (ui.ts's rememberDone/recallDone)
 * lives only in the browser that clicked the button — worse, in an opaque-
 * origin sandbox (widget-card.tsx's iframe has no `allow-same-origin`) even
 * that localStorage partition is unlinked from one page load to the next.
 * Reopening the same chat on another device, or the same device after a
 * reload, replays the unchanged `tool_result` and shows live Confirm/Cancel
 * buttons for something the person already decided.
 *
 * `state_key` is the same string each widget bundle already used as its
 * localStorage key (`renkei-preview:<previewId>` for most cards,
 * `renkei-email:<draftId>` for the email compose card) — reused rather than
 * inventing a second identity scheme, and stable across re-renders of one
 * card while never shared with a later preview of the same kind (the id is
 * minted fresh per preview call; see widgets.ts's `newPreviewId` doc).
 *
 * `state` is the card's own `DoneState` (ui.ts) as reported at the moment it
 * finished — the exact receipt every widget bundle already renders locally,
 * now the source of truth a second device (or a reload) reads back instead
 * of recomputing it from a live tool result it does not have.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('chat_widget_decisions')
    .addColumn('tenant_id', 'uuid', (col) =>
      col.notNull().references('tenants.id').onDelete('cascade')
    )
    .addColumn('chat_id', 'uuid', (col) => col.notNull().references('chats.id').onDelete('cascade'))
    .addColumn('state_key', 'varchar(255)', (col) => col.notNull())
    .addColumn('decision', 'varchar(16)', (col) => col.notNull())
    .addColumn('state', 'jsonb', (col) => col.notNull())
    .addColumn('decided_by', 'varchar(255)', (col) => col.notNull())
    .addColumn('decided_at', 'timestamptz', (col) => col.notNull().defaultTo(sql`NOW()`))
    .addCheckConstraint(
      'chat_widget_decisions_decision_check',
      sql`decision IN ('confirmed', 'cancelled')`
    )
    .addPrimaryKeyConstraint('chat_widget_decisions_pkey', ['tenant_id', 'state_key'])
    .execute();

  // chat-view.ts's read: every decision for one chat, in one query, merged
  // into that chat's messages by their own state_key.
  await db.schema
    .createIndex('idx_chat_widget_decisions_chat')
    .on('chat_widget_decisions')
    .columns(['tenant_id', 'chat_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('chat_widget_decisions').execute();
}
