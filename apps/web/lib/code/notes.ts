/**
 * The code pane's note rows, written: what a person did to the checkout
 * — a save, a commit, a push — as a user-role row of kind 'note'
 * (note-text.ts has the vocabulary and the parser the thread uses).
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { insertMessage } from '@/lib/chat/messages';
import { getActiveTurn } from '@/lib/chat/turns';
import type { ChatMessageView } from '@/lib/chat/views';
import { noteText, type ChatNote } from './note-text';

export { noteFromInput, noteText, parseNote, type ChatNote } from './note-text';

/**
 * Append the note to the chat. Refused while a turn is running: the
 * runner is the only writer then, and a user-role row landing between a
 * reply's rows would sit where the provider expects a tool result. The
 * chat row is locked for the check and the insert together, so a turn
 * starting in the same instant waits its turn.
 */
export async function appendChatNote(
  db: Kysely<DB>,
  input: { tenantId: string; chatId: string; note: ChatNote }
): Promise<
  { ok: true; message: ChatMessageView } | { ok: false; reason: 'turn-running' | 'failed' }
> {
  const text = noteText(input.note);
  return db.transaction().execute(async (trx) => {
    await trx
      .selectFrom('chats')
      .select('id')
      .where('id', '=', input.chatId)
      .forUpdate()
      .executeTakeFirst();
    if (await getActiveTurn(trx, input.chatId)) return { ok: false, reason: 'turn-running' };
    const inserted = await insertMessage(trx, {
      tenantId: input.tenantId,
      chatId: input.chatId,
      turnId: null,
      role: 'user',
      kind: 'note',
      status: 'complete',
      blocks: [{ type: 'text', text }],
    });
    if (!inserted) return { ok: false, reason: 'failed' };
    return {
      ok: true,
      message: {
        id: inserted.id,
        turnId: null,
        seq: inserted.seq,
        role: 'user',
        kind: 'note',
        status: 'complete',
        blocks: [{ type: 'text', text }],
        llmModelId: null,
        provider: null,
        model: null,
        stopReason: null,
        usage: null,
        error: null,
        createdAt: inserted.createdAt.toISOString(),
        attachments: [],
      },
    };
  });
}
