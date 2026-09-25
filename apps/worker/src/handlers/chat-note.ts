/**
 * A system note dropped into a chat's own transcript — the same
 * envelope apps/web/lib/chat/content-crypto.ts's sealBlocks writes
 * (renc1: + secretbox under CONTENT_ENCRYPTION_KEY, falling back to
 * TOKEN_ENCRYPTION_KEY, both already present on this service), so the
 * chat page reads it exactly like a person's own note from the code
 * pane (lib/code/chat-commits.ts's own doc comment on that pattern).
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

import { sql } from 'kysely';
import { getDatabase } from '@renkei/db';
import { contentEncryptionKey, encryptContent } from '@renkei/crypto';

export async function insertChatNote(tenantId: string, chatId: string, text: string): Promise<void> {
  const keyResult = contentEncryptionKey();
  if (!keyResult.ok) throw new Error('content encryption key is not configured');
  const sealed = encryptContent(JSON.stringify([{ type: 'text', text }]), keyResult.val);

  const dbResult = getDatabase();
  if (!dbResult.ok) throw new Error('database unavailable');

  await dbResult.val
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
