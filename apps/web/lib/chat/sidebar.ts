/**
 * The menu's chat list: the viewer's chats (archived ones too, flagged),
 * the chats shared with them by name, the chats in the projects they
 * belong to, and those projects — loaded by the tenant layout for every
 * page, since the list sits in the app menu.
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
  /** A code project's repository (`workspace/repo`); null on a chat project. */
  repoFullName: string | null;
}

/**
 * The menu's two sections: chats and chat projects under Chat; code
 * projects — and the chats inside them — under Code. A chat in a code
 * project is never listed among the person's ordinary chats: it belongs
 * to its repository, and the Code section is where it is found.
 */
export interface ChatSidebarData {
  chats: ChatListItem[];
  projects: ProjectListItem[];
  code: {
    projects: ProjectListItem[];
    chats: ChatListItem[];
  };
}

function item(
  chat: ChatRow,
  via: ChatListItem['via'],
  ownerName: string | null,
  projectName: string | null
): ChatListItem {
  return {
    id: chat.id,
    title: chat.title,
    projectId: chat.projectId,
    projectName,
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
    // Archived chats ride along, flagged; the list hides them by default.
    listOwnedChats(db, tenantId, subject, { includeArchived: true }),
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
  const projectNames = new Map(projects.map((project) => [project.id, project.name]));
  const codeProjectIds = new Set(
    projects.filter((project) => project.kind === 'code').map((project) => project.id)
  );
  const projectNameOf = (chat: ChatRow) =>
    chat.projectId ? (projectNames.get(chat.projectId) ?? null) : null;
  const allChats: ChatListItem[] = [
    ...owned.map((chat) => item(chat, 'owner', null, projectNameOf(chat))),
    ...granted.map((chat) =>
      item(chat, 'grant', names.get(chat.ownerSubject) ?? null, projectNameOf(chat))
    ),
    ...inProjects
      .filter((chat) => !grantedIds.has(chat.id))
      .map((chat) =>
        item(chat, 'project', names.get(chat.ownerSubject) ?? null, projectNameOf(chat))
      ),
  ];
  const inCode = (chat: ChatListItem) =>
    chat.projectId !== null && codeProjectIds.has(chat.projectId);
  const listItem = (project: (typeof projects)[number]): ProjectListItem => ({
    id: project.id,
    name: project.name,
    ownerSubject: project.ownerSubject,
    ownerName: project.ownerSubject === subject ? null : (names.get(project.ownerSubject) ?? null),
    role: project.ownerSubject === subject ? 'owner' : 'member',
    updatedAt: project.updatedAt.toISOString(),
    repoFullName: project.repo?.fullName ?? null,
  });
  return {
    chats: allChats.filter((chat) => !inCode(chat)),
    projects: projects.filter((project) => project.kind === 'chat').map(listItem),
    code: {
      projects: projects.filter((project) => project.kind === 'code').map(listItem),
      chats: allChats.filter(inCode),
    },
  };
}
