/**
 * A project page's data: the project as the viewer may see it, its files,
 * its memory, the chats inside it (everyone's — the viewer's own open
 * normally, the others read-only), and the viewer's role.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { ResourceAccess } from './access';
import { listAttachments, toAttachmentView } from './attachments';
import { readProjectMemory } from './memory';
import { getProjectRow } from './projects';
import { listProjectChats } from './store';
import type { AttachmentView, ChatListItem, ChatToolConfigView } from './views';

export interface ProjectView {
  project: {
    id: string;
    name: string;
    description: string | null;
    instructions: string | null;
    toolConfig: ChatToolConfigView | null;
    publishedToOrg: boolean;
    ownerSubject: string;
    ownerName: string | null;
    createdAt: string;
    updatedAt: string;
  };
  role: 'owner' | 'editor' | 'viewer';
  files: AttachmentView[];
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
  db: Kysely<DB>,
  tenantId: string,
  viewerSubject: string,
  projectId: string,
  access: ResourceAccess
): Promise<ProjectView | null> {
  const project = await getProjectRow(db, tenantId, projectId);
  if (!project) return null;
  const [files, memory, chats] = await Promise.all([
    listAttachments(db, tenantId, { projectId }),
    readProjectMemory(db, tenantId, projectId, { maxEntries: 300 }),
    listProjectChats(db, tenantId, [projectId], null),
  ]);
  const subjects = [
    project.ownerSubject,
    ...chats.map((chat) => chat.ownerSubject),
    ...memory.entries.flatMap((entry) => (entry.authorSubject ? [entry.authorSubject] : [])),
  ];
  const unique = [...new Set(subjects)];
  const identities =
    unique.length > 0
      ? await db
          .selectFrom('identities')
          .select(['subject', 'display_name', 'email'])
          .where('tenant_id', '=', tenantId)
          .where('subject', 'in', unique)
          .execute()
      : [];
  const names = new Map(identities.map((row) => [row.subject, row.display_name ?? row.email]));
  const role = access.role === 'owner' ? 'owner' : access.role === 'editor' ? 'editor' : 'viewer';
  return {
    project: {
      id: project.id,
      name: project.name,
      description: project.description,
      instructions: project.instructions,
      toolConfig: project.toolConfig,
      publishedToOrg: project.publishedToOrg,
      ownerSubject: project.ownerSubject,
      ownerName: names.get(project.ownerSubject) ?? null,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
    },
    role,
    files: files.map(toAttachmentView),
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
