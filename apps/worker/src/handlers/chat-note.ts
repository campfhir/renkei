/**
 * A system note dropped into a chat's own transcript — the same
 * envelope apps/web/lib/chat/content-crypto.ts's sealBlocks writes: the
 * chat's own key (`renc2`, migration 133), opened on its owner's behalf
 * through @renkei/user-keys, so the chat page reads it exactly like a
 * person's own note from the code pane (lib/code/chat-commits.ts's own
 * doc comment on that pattern). A chat whose owner's key is locked (their
 * own key, not unlocked) cannot take the note: the error says so and the
 * caller records that no note landed.
 *
 * This worker cannot start a new chat turn — a turn's execution is
 * bound to the Next.js request that started it
 * (apps/web/lib/chat/start-turn.ts; see docs/RENKEI dev notes for why),
 * with no background/queue path today. A pipeline-failure "auto fix"
 * therefore lands as this note, not as the agent unattended re-engaging
 * the work: the note is what pr-pipeline-events.ts posts when a
 * subscription's auto_fix is on and the pipeline failed, ready for
 * whoever opens the chat next.
 */

import { sql, type Kysely } from 'kysely';
import { getDatabase, type DB } from '@renkei/db';
import { encryptWithResourceKey } from '@renkei/crypto';
import { ensureResourceKey } from '@renkei/user-keys';

/** The note's blocks sealed the way the chat's own rows are: under the chat's key, as its owner. */
async function sealNote(
  db: Kysely<DB>,
  tenantId: string,
  chatId: string,
  text: string
): Promise<string> {
  const chat = await db
    .selectFrom('chats')
    .select('owner_subject')
    .where('tenant_id', '=', tenantId)
    .where('id', '=', chatId)
    .executeTakeFirst();
  if (!chat) throw new Error('the chat is gone');
  const key = await ensureResourceKey(
    db,
    { tenantId, kind: 'chat', resourceId: chatId },
    chat.owner_subject
  );
  if (!key.ok) throw new Error(`the chat's key could not be opened (${key.err.type})`);
  return encryptWithResourceKey(JSON.stringify([{ type: 'text', text }]), key.val.id, key.val.key);
}

export async function insertChatNote(
  tenantId: string,
  chatId: string,
  text: string
): Promise<void> {
  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('database unavailable');
  const db = dbResult.val;
  const sealed = await sealNote(db, tenantId, chatId, text);

  await db
    .insertInto('chat_messages')
    .values({
      tenant_id: tenantId,
      chat_id: chatId,
      turn_id: null,
      seq: sql<number>`(SELECT COALESCE(MAX(seq), 0) + 1 FROM chat_messages WHERE chat_id = ${chatId})`,
      role: 'user',
      kind: 'note',
      status: 'complete',
      content: sealed,
    })
    .execute();
}
