/**
 * A person's data, gathered for export: who they are, every preference
 * they saved, their memory, the projects they own (instructions and
 * project memory), and every chat they own — archived and temporary ones
 * too — with its messages opened under the chat's own key, the files
 * attached to each message listed (not their bytes), and its latest
 * compaction summary.
 *
 * Everything is read as the owner, through the same modules the pages
 * use, so a chat whose key cannot be opened right now comes out with its
 * messages as markers and `keyUnavailable` set, rather than failing the
 * whole export. Chats in someone else's project are the person's own and
 * come too; other people's chats they can merely read do not.
 */

import { getDataStore, type ChatRecord } from '@renkei/db';
import { cipherFor } from '@/lib/chat/chat-keys';
import { listMessages } from '@/lib/chat/messages';
import { latestChatSummary } from '@/lib/chat/compaction';
import { listOwnedProjects, listProjectsById, openProjectInstructions } from '@/lib/chat/projects';
import { PROJECT_MEMORY_HARD_CAP, readProjectMemory } from '@/lib/chat/memory';
import { USER_MEMORY_HARD_CAP, readUserMemory } from '@/lib/chat/user-memory';
import type {
  ExportAttachment,
  ExportChat,
  ExportData,
  ExportMemory,
  ExportProject,
} from './types';

/** Far above any real account; the store wants a bound. */
const MAX_CHATS = 100_000;
/** Chats opened at once: each is a key fetch and a few reads. */
const CONCURRENCY = 6;

const iso = (date: Date): string => date.toISOString();

function memoryOf(memory: {
  summary: string | null;
  entries: { id: string; content: string; chatId: string | null; createdAt: Date }[];
}): ExportMemory {
  return {
    summary: memory.summary,
    entries: memory.entries.map((entry) => ({
      id: entry.id,
      content: entry.content,
      chatId: entry.chatId,
      createdAt: iso(entry.createdAt),
    })),
  };
}

async function inBatches<T, R>(
  items: T[],
  size: number,
  each: (item: T) => Promise<R>
): Promise<R[]> {
  const out: R[] = [];
  for (let at = 0; at < items.length; at += size) {
    out.push(...(await Promise.all(items.slice(at, at + size).map(each))));
  }
  return out;
}

async function collectChat(
  chat: ChatRecord,
  subject: string,
  projectNames: Map<string, string>
): Promise<ExportChat> {
  const cipher = await cipherFor('chat', chat, subject, 'owner');
  const [messages, attachments, summary] = await Promise.all([
    listMessages(chat.id, cipher),
    getDataStore().artifacts.listByChat(chat.id),
    latestChatSummary(chat.id, cipher),
  ]);
  const byMessage = new Map<string, ExportAttachment[]>();
  for (const row of attachments) {
    if (!row.messageId) continue;
    byMessage.set(row.messageId, [
      ...(byMessage.get(row.messageId) ?? []),
      { filename: row.filename, contentType: row.contentType, sizeBytes: row.sizeBytes },
    ]);
  }
  return {
    id: chat.id,
    title: chat.title,
    projectId: chat.projectId,
    projectName: chat.projectId ? (projectNames.get(chat.projectId) ?? null) : null,
    archived: chat.archivedAt !== null,
    temporary: chat.temporary,
    keyUnavailable: cipher.unavailable !== null,
    createdAt: iso(chat.createdAt),
    updatedAt: iso(chat.updatedAt),
    summary: summary?.content ?? null,
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      kind: message.kind,
      status: message.status,
      model: message.model,
      createdAt: iso(message.createdAt),
      blocks: message.blocks,
      attachments: byMessage.get(message.id) ?? [],
    })),
  };
}

async function collectProjects(subject: string): Promise<ExportProject[]> {
  const projects = await listOwnedProjects(subject);
  return inBatches(projects, CONCURRENCY, async (project) => {
    const cipher = await cipherFor('chat_project', project, subject, 'owner');
    const memory = await readProjectMemory(project.id, cipher, {
      maxEntries: PROJECT_MEMORY_HARD_CAP,
    });
    return {
      id: project.id,
      kind: project.kind,
      name: project.name,
      description: project.description,
      instructions: openProjectInstructions(project, cipher),
      repo: project.repo,
      createdAt: iso(project.createdAt),
      updatedAt: iso(project.updatedAt),
      memory: memoryOf(memory),
    };
  });
}

export async function collectExportData(subject: string, now: Date): Promise<ExportData> {
  const store = getDataStore();
  const [identity, preferences, memory, projects, chats] = await Promise.all([
    store.identities.get(subject),
    store.userPreferences.listBySubject(subject),
    readUserMemory(subject, { maxEntries: USER_MEMORY_HARD_CAP }),
    collectProjects(subject),
    store.chats.listOwned(subject, { includeArchived: true, limit: MAX_CHATS }),
  ]);
  const projectIds = [
    ...new Set(chats.map((chat) => chat.projectId).filter((id): id is string => id !== null)),
  ];
  const projectNames = new Map(
    (await listProjectsById(projectIds)).map((project) => [project.id, project.name])
  );
  return {
    exportedAt: iso(now),
    person: {
      subject,
      displayName: identity?.displayName ?? null,
      email: identity?.email ?? null,
    },
    preferences,
    memory: memoryOf(memory),
    projects,
    chats: await inBatches(chats, CONCURRENCY, (chat) => collectChat(chat, subject, projectNames)),
  };
}
