/**
 * The sidebar's data: the viewer's chats, the chats shared with them by
 * name, the chats in the projects they belong to, and those projects —
 * fetched once for the chat layout and again for the list route.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { listAccessibleProjectIds, listGrantedResources } from './access';
import { listProjectsById } from './projects';
import { listChatsById, listOwnedChats, listProjectChats, type ChatRow } from './store';
import type { ChatListItem } from './views';

export interface ProjectListItem {
  id: string;
  name: string;
  ownerSubject: string;
  ownerName: string | null;
  role: 'owner' | 'member';
  updatedAt: string;
}

export interface ChatSidebarData {
  chats: ChatListItem[];
  projects: ProjectListItem[];
}

function item(chat: ChatRow, via: ChatListItem['via'], ownerName: string | null): ChatListItem {
  return {
    id: chat.id,
    title: chat.title,
    projectId: chat.projectId,
    updatedAt: chat.updatedAt.toISOString(),
    lastMessageAt: chat.lastMessageAt ? chat.lastMessageAt.toISOString() : null,
    archived: chat.archivedAt !== null,
    ownerSubject: chat.ownerSubject,
    ownerName,
    via,
  };
}

async function namesFor(
  db: Kysely<DB>,
  tenantId: string,
  subjects: string[]
): Promise<Map<string, string | null>> {
  const unique = [...new Set(subjects)];
  if (unique.length === 0) return new Map();
  const rows = await db
    .selectFrom('identities')
    .select(['subject', 'display_name', 'email'])
    .where('tenant_id', '=', tenantId)
    .where('subject', 'in', unique)
    .execute();
  return new Map(rows.map((row) => [row.subject, row.display_name ?? row.email ?? null]));
}

export async function loadChatSidebar(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<ChatSidebarData> {
  const [owned, grants, projectIds] = await Promise.all([
    listOwnedChats(db, tenantId, subject),
    listGrantedResources(db, tenantId, subject, 'chat'),
    listAccessibleProjectIds(db, tenantId, subject),
  ]);
  const [granted, inProjects, projects] = await Promise.all([
    listChatsById(
      db,
      tenantId,
      grants.map((grant) => grant.resourceId)
    ),
    listProjectChats(db, tenantId, projectIds, subject),
    listProjectsById(db, tenantId, projectIds),
  ]);
  const grantedIds = new Set(granted.map((chat) => chat.id));
  const names = await namesFor(db, tenantId, [
    ...granted.map((chat) => chat.ownerSubject),
    ...inProjects.map((chat) => chat.ownerSubject),
    ...projects.map((project) => project.ownerSubject),
  ]);
  return {
    chats: [
      ...owned.map((chat) => item(chat, 'owner', null)),
      ...granted.map((chat) => item(chat, 'grant', names.get(chat.ownerSubject) ?? null)),
      ...inProjects
        .filter((chat) => !grantedIds.has(chat.id))
        .map((chat) => item(chat, 'project', names.get(chat.ownerSubject) ?? null)),
    ],
    projects: projects.map((project) => ({
      id: project.id,
      name: project.name,
      ownerSubject: project.ownerSubject,
      ownerName:
        project.ownerSubject === subject ? null : (names.get(project.ownerSubject) ?? null),
      role: project.ownerSubject === subject ? 'owner' : 'member',
      updatedAt: project.updatedAt.toISOString(),
    })),
  };
}
