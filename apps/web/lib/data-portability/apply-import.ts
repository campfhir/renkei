/**
 * Writing an import plan (import-parse.ts) into the person's account,
 * through the same modules the app writes with:
 *
 *   - Memories go in through `appendUserMemory`, sealed under the person's
 *     own key, after the caller's redaction (the memory route's rule).
 *     Memory holds at most USER_MEMORY_HARD_CAP entries and appending past
 *     it drops the oldest, so an import adds only as many as there is room
 *     for — it never pushes out what the person already has — and says how
 *     many it left out.
 *   - Chats are created as the person's own, outside any project, each
 *     with its own key, the messages written in order as complete prompts
 *     and replies (text only). The title says where the chat came from.
 *     They can be continued like any chat: the request builder joins rows
 *     of one role, and a chat ends wherever the export ended. With
 *     `archiveChats` they go straight to the archive, so a few hundred
 *     imported chats do not bury the sidebar.
 *
 * A chat whose key cannot be made (the person's session is not delegated)
 * stops the import there: the half-made chat is deleted, and what was
 * imported before it stays, counted.
 */

import { getDataStore } from '@renkei/db';
import { cipherFor } from '@/lib/chat/chat-keys';
import { insertMessage } from '@/lib/chat/messages';
import { createChat } from '@/lib/chat/store';
import { USER_MEMORY_HARD_CAP, appendUserMemory } from '@/lib/chat/user-memory';
import { sourceName } from './import-parse';
import type { ImportOutcome, ImportPlan, ImportedChat } from './types';

export interface ImportChoice {
  memories: boolean;
  chats: boolean;
  archiveChats: boolean;
}

/** The title an imported chat carries: its own, then where it came from. */
export function importedTitle(chat: Pick<ImportedChat, 'title' | 'source'>): string {
  return chat.source === 'renkei' ? chat.title : `${chat.title} · ${sourceName(chat.source)}`;
}

async function memoryRoom(subject: string): Promise<number> {
  const rows = await getDataStore().userMemory.list(subject, USER_MEMORY_HARD_CAP + 1);
  const entries = rows.filter((row) => row.kind === 'entry').length;
  return Math.max(0, USER_MEMORY_HARD_CAP - entries);
}

async function importChat(
  subject: string,
  chat: ImportedChat,
  archive: boolean
): Promise<number | null> {
  const chatId = await createChat({
    ownerSubject: subject,
    projectId: null,
    llmModelId: null,
    toolConfig: null,
    thinkingEnabled: false,
  });
  const cipher = await cipherFor('chat', { id: chatId, ownerSubject: subject }, subject, 'owner');
  const store = getDataStore();
  if (cipher.unavailable) {
    await store.chats.delete(subject, chatId);
    return null;
  }
  for (const message of chat.messages) {
    const inserted = await insertMessage({
      chatId,
      turnId: null,
      role: message.role,
      kind: message.role === 'user' ? 'prompt' : 'assistant',
      status: 'complete',
      blocks: [{ type: 'text', text: message.text }],
      cipher,
    });
    if (!inserted) {
      await store.chats.delete(subject, chatId);
      return null;
    }
  }
  await store.chats.touch(chatId, {});
  await store.chats.update(subject, chatId, {
    title: importedTitle(chat),
    ...(archive ? { archived: true } : {}),
  });
  return chat.messages.length;
}

export async function applyImport(
  subject: string,
  plan: ImportPlan,
  choice: ImportChoice,
  redact: (text: string) => string
): Promise<ImportOutcome> {
  const outcome: ImportOutcome = {
    memoriesAdded: 0,
    memoriesNoRoom: 0,
    chatsAdded: 0,
    messagesAdded: 0,
    stopped: null,
  };

  if (choice.memories && plan.memories.length > 0) {
    const room = await memoryRoom(subject);
    outcome.memoriesNoRoom = Math.max(0, plan.memories.length - room);
    for (const memory of plan.memories.slice(0, room)) {
      const id = await appendUserMemory({
        ownerSubject: subject,
        content: redact(memory),
        chatId: null,
      });
      if (!id) {
        outcome.stopped = 'memory-key';
        return outcome;
      }
      outcome.memoriesAdded += 1;
    }
  }

  if (choice.chats) {
    for (const chat of plan.chats) {
      const written = await importChat(subject, chat, choice.archiveChats);
      if (written === null) {
        outcome.stopped = 'chat-key';
        return outcome;
      }
      outcome.chatsAdded += 1;
      outcome.messagesAdded += written;
    }
  }

  return outcome;
}
