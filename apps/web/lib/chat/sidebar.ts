/**
 * The menu's chat list: the viewer's chats (archived ones too, flagged),
 * the chats shared with them by name, the chats in the projects they
 * belong to — chat projects and code projects alike, each row marked
 * with which — and those projects — loaded by the tenant layout for
 * every page, since the list sits in the app menu.
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
 * The menu's Chat section: every chat the person can open — ordinary
 * ones, those in chat projects and those in code projects, each row
 * saying which kind and naming its project — and the chat projects a
 * chat can be moved into. Code projects are kept apart: the Code page
 * lists them, and the menu only opens that door.
 */
export interface ChatSidebarData {
  chats: ChatListItem[];
  projects: ProjectListItem[];
  code: {
    projects: ProjectListItem[];
  };
}

function item(
  chat: ChatRow,
  via: ChatListItem['via'],
  ownerName: string | null,
  project: { name: string; kind: 'chat' | 'code' } | null
): ChatListItem {
  return {
    id: chat.id,
    title: chat.title,
    projectId: chat.projectId,
    projectName: project?.name ?? null,
    projectKind: project?.kind ?? null,
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
  const projectsById = new Map(
    projects.map((project) => [project.id, { name: project.name, kind: project.kind }])
  );
  const projectOf = (chat: ChatRow) =>
    chat.projectId ? (projectsById.get(chat.projectId) ?? null) : null;
  // "+ New" creates its chat up front; one nothing was said in yet is not
  // listed (nor is anyone else's), so abandoned starts never pile up here.
  const started = (chat: ChatRow) => chat.lastMessageAt !== null;
  const allChats: ChatListItem[] = [
    ...owned.filter(started).map((chat) => item(chat, 'owner', null, projectOf(chat))),
    ...granted
      .filter(started)
      .map((chat) => item(chat, 'grant', names.get(chat.ownerSubject) ?? null, projectOf(chat))),
    ...inProjects
      .filter((chat) => started(chat) && !grantedIds.has(chat.id))
      .map((chat) => item(chat, 'project', names.get(chat.ownerSubject) ?? null, projectOf(chat))),
  ];
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
    chats: allChats,
    projects: projects.filter((project) => project.kind === 'chat').map(listItem),
    code: {
      projects: projects.filter((project) => project.kind === 'code').map(listItem),
    },
  };
}
