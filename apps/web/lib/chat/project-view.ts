/**
 * A project page's data: the project as the viewer may see it, its files,
 * its memory, the chats inside it (everyone's — the viewer's own open
 * normally, the others read-only), and the viewer's role.
 */

import { getDataStore } from '@renkei/db';
import type { ProjectAccess } from './access';
import { listProjectArtifacts, toAttachmentView } from './attachments';
import { ALWAYS_BUDGET_TOKENS, tokensOf } from './artifact-library';
import { readProjectMemory } from './memory';
import { getProjectRow, openProjectInstructions } from './projects';
import { listProjectChats } from './store';
import type { ChatListItem, ChatToolConfigView, ProjectArtifactView } from './views';

export interface ProjectView {
  project: {
    id: string;
    name: string;
    description: string | null;
    instructions: string | null;
    toolConfig: ChatToolConfigView | null;
    ownerSubject: string;
    ownerName: string | null;
    createdAt: string;
    updatedAt: string;
  };
  role: 'owner' | 'editor' | 'viewer';
  /** Who is looking, so the page can tell their own artifacts from others'. */
  viewerSubject: string;
  files: ProjectArtifactView[];
  /** Tokens the `always` artifacts take per turn, against the budget. */
  alwaysTokens: { used: number; budget: number };
  memory: {
    summary: string | null;
    entries: {
      id: string;
      content: string;
      authorName: string | null;
      chatId: string | null;
      createdAt: string;
    }[];
  };
  chats: ChatListItem[];
}

export async function loadProjectView(
  viewerSubject: string,
  projectId: string,
  access: ProjectAccess
): Promise<ProjectView | null> {
  const project = await getProjectRow(projectId);
  if (!project) return null;
  const store = getDataStore();
  const [files, memory, chats] = await Promise.all([
    listProjectArtifacts(projectId),
    readProjectMemory(projectId, access.cipher, { maxEntries: 300 }),
    listProjectChats([projectId], null),
  ]);
  const fileIds = files.map((file) => file.id);
  const fileChatIds = [...new Set(files.flatMap((file) => (file.chatId ? [file.chatId] : [])))];
  const [textSizes, usage, fileChats] = await Promise.all([
    fileIds.length > 0 ? store.artifacts.textLengths(fileIds) : Promise.resolve([]),
    fileIds.length > 0 ? store.artifacts.referenceCounts(fileIds) : Promise.resolve([]),
    fileChatIds.length > 0 ? store.chats.listByIds(fileChatIds) : Promise.resolve([]),
  ]);
  const charsOf = new Map(textSizes.map((row) => [row.id, row.chars]));
  const usingOf = new Map(usage.map((row) => [row.artifactId, row.count]));
  const chatOf = new Map(fileChats.map((chat) => [chat.id, chat]));
  const subjects = [
    project.ownerSubject,
    ...files.map((file) => file.ownerSubject),
    ...chats.map((chat) => chat.ownerSubject),
    ...memory.entries.flatMap((entry) => (entry.authorSubject ? [entry.authorSubject] : [])),
  ];
  const unique = [...new Set(subjects)];
  const identities = unique.length > 0 ? await store.identities.listBySubjects(unique) : [];
  const names = new Map(identities.map((row) => [row.subject, row.displayName ?? row.email]));
  const role = access.role === 'owner' ? 'owner' : access.role === 'editor' ? 'editor' : 'viewer';
  return {
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      instructions: openProjectInstructions(project, access.cipher),
      toolConfig: project.toolConfig,
      ownerSubject: project.ownerSubject,
      ownerName: names.get(project.ownerSubject) ?? null,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    },
    role,
    viewerSubject,
    files: files.map((file) => ({
      ...toAttachmentView(file),
      mode: file.mode,
      origin: file.origin,
      ownerSubject: file.ownerSubject,
      ownerName:
        file.ownerSubject === viewerSubject ? null : (names.get(file.ownerSubject) ?? null),
      chat:
        file.origin === 'model' && file.chatId && chatOf.has(file.chatId)
          ? { id: file.chatId, title: chatOf.get(file.chatId)?.title ?? null }
          : null,
      projectsUsing: usingOf.get(file.id) ?? 1,
      tokens: tokensOf(charsOf.get(file.id) ?? 0),
      createdAt: file.createdAt.toISOString(),
    })),
    alwaysTokens: {
      used: files
        .filter((file) => file.mode === 'always')
        .reduce((sum, file) => sum + tokensOf(charsOf.get(file.id) ?? 0), 0),
      budget: ALWAYS_BUDGET_TOKENS,
    },
    memory: {
      summary: memory.summary,
      entries: memory.entries.map((entry) => ({
        id: entry.id,
        content: entry.content,
        authorName: entry.authorSubject ? (names.get(entry.authorSubject) ?? null) : null,
        chatId: entry.chatId,
        createdAt: entry.createdAt.toISOString(),
      })),
    },
    chats: chats.map((chat) => ({
      id: chat.id,
      title: chat.title,
      projectId: chat.projectId,
      projectName: project.name,
      projectKind: project.kind,
      // The project page names the branch in its own repository section.
      projectBranch: null,
      updatedAt: chat.updatedAt.toISOString(),
      lastMessageAt: chat.lastMessageAt ? chat.lastMessageAt.toISOString() : null,
      archived: chat.archivedAt !== null,
      ownerSubject: chat.ownerSubject,
      ownerName:
        chat.ownerSubject === viewerSubject ? null : (names.get(chat.ownerSubject) ?? null),
      via: chat.ownerSubject === viewerSubject ? 'owner' : 'project',
    })),
  };
}
