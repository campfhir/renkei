/**
 * The menu's chat list: the viewer's chats (archived ones too, flagged),
 * the chats shared with them by name, the chats in the projects they
 * belong to — chat projects and code projects alike, each row marked
 * with which — and those projects — loaded by the tenant layout for
 * every page, since the list sits in the app menu.
 */

import { getDataStore } from '@renkei/db';
import { workspaceBranches } from '@/lib/code/branches';
import { listAccessibleProjectIds, listGrantedResources } from './access';
import { listProjectsById } from './projects';
import {
  hasOwnedChatBefore,
  listChatsById,
  listOwnedChats,
  listProjectChats,
  type ChatRow,
} from './store';
import type { ChatListItem } from './views';

/** The sidebar's default window: chats untouched this long sit behind "Load more". */
export const CHAT_SIDEBAR_ACTIVE_DAYS = 90;

/** How many older chats one "Load more" click brings in. */
const CHAT_SIDEBAR_PAGE_SIZE = 30;

export function chatSidebarActiveSince(now: Date = new Date()): Date {
  return new Date(now.getTime() - CHAT_SIDEBAR_ACTIVE_DAYS * 86_400_000);
}

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
  /**
   * A cursor for "Load more": owned chats last touched before this instant
   * exist but were left out of `chats`. Null once nothing further is
   * hidden, or when the caller asked for the whole history (no `since`).
   */
  moreChatsBefore: string | null;
}

function item(
  chat: ChatRow,
  via: ChatListItem['via'],
  ownerName: string | null,
  project: { name: string; kind: 'chat' | 'code' } | null,
  branch: string | null
): ChatListItem {
  return {
    id: chat.id,
    title: chat.title,
    projectId: chat.projectId,
    projectName: project?.name ?? null,
    projectKind: project?.kind ?? null,
    projectBranch: branch,
    updatedAt: chat.updatedAt.toISOString(),
    lastMessageAt: chat.lastMessageAt ? chat.lastMessageAt.toISOString() : null,
    archived: chat.archivedAt !== null,
    temporary: chat.temporary,
    ownerSubject: chat.ownerSubject,
    ownerName,
    via,
  };
}

/** A project's name and kind, by id. */
function projectMapFor(
  projects: Awaited<ReturnType<typeof listProjectsById>>
): Map<string, { name: string; kind: 'chat' | 'code' }> {
  return new Map(
    projects.map((project) => [project.id, { name: project.name, kind: project.kind }])
  );
}

/**
 * The branch each code chat's worktree is on, for the rows of the menu:
 * one read of the worker's own table, never a worker call from the menu.
 * A chat with no worktree yet (no turn has run) names no branch.
 */
async function chatBranchesFor(chats: ChatRow[]): Promise<(chat: ChatRow) => string | null> {
  const branches = await workspaceBranches(chats.map((chat) => chat.workspaceId));
  return (chat) => (chat.workspaceId ? (branches.get(chat.workspaceId) ?? null) : null);
}

async function namesFor(subjects: string[]): Promise<Map<string, string | null>> {
  const unique = [...new Set(subjects)];
  if (unique.length === 0) return new Map();
  const rows = await getDataStore().identities.listBySubjects(unique);
  return new Map(rows.map((row) => [row.subject, row.displayName ?? row.email ?? null]));
}

/**
 * @param options.since Bounds every chat list (mine, shared with me, a
 * project's) to activity at or after this instant. Left out, the whole
 * history loads, as callers that only want the project lists still do.
 * Passing it is what makes `moreChatsBefore` non-null when there is more.
 */
export async function loadChatSidebar(
  subject: string,
  options: { since?: Date } = {}
): Promise<ChatSidebarData> {
  const { since } = options;
  const [owned, grants, projectIds] = await Promise.all([
    // Archived chats ride along, flagged; the list hides them by default.
    listOwnedChats(subject, { includeArchived: true, ...(since ? { since } : {}) }),
    listGrantedResources(subject, 'chat'),
    listAccessibleProjectIds(subject),
  ]);
  const [grantedAll, inProjects, projects, moreOwned] = await Promise.all([
    listChatsById(grants.map((grant) => grant.resourceId)),
    listProjectChats(projectIds, subject, since ? { since } : {}),
    listProjectsById(projectIds),
    since ? hasOwnedChatBefore(subject, since) : Promise.resolve(false),
  ]);
  // listChatsById fetches by id, not by date, so the window is applied here.
  const granted = since ? grantedAll.filter((chat) => chat.updatedAt >= since) : grantedAll;
  const grantedIds = new Set(granted.map((chat) => chat.id));
  const names = await namesFor([
    ...granted.map((chat) => chat.ownerSubject),
    ...inProjects.map((chat) => chat.ownerSubject),
    ...projects.map((project) => project.ownerSubject),
  ]);
  const projectsById = projectMapFor(projects);
  const branchOf = await chatBranchesFor([...owned, ...granted, ...inProjects]);
  const projectOf = (chat: ChatRow) =>
    chat.projectId ? (projectsById.get(chat.projectId) ?? null) : null;
  // "+ New" creates its chat up front; one nothing was said in yet is not
  // listed (nor is anyone else's), so abandoned starts never pile up here.
  const started = (chat: ChatRow) => chat.lastMessageAt !== null;
  const allChats: ChatListItem[] = [
    ...owned
      .filter(started)
      .map((chat) => item(chat, 'owner', null, projectOf(chat), branchOf(chat))),
    ...granted
      .filter(started)
      .map((chat) =>
        item(chat, 'grant', names.get(chat.ownerSubject) ?? null, projectOf(chat), branchOf(chat))
      ),
    ...inProjects
      .filter((chat) => started(chat) && !grantedIds.has(chat.id))
      .map((chat) =>
        item(chat, 'project', names.get(chat.ownerSubject) ?? null, projectOf(chat), branchOf(chat))
      ),
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
    moreChatsBefore: since && moreOwned ? since.toISOString() : null,
  };
}

/**
 * One page of owned chats older than `before` — what a "Load more" click
 * in the sidebar asks for, since the initial load only carries the last
 * `CHAT_SIDEBAR_ACTIVE_DAYS` days. Shared-with-me and project chats are
 * not paginated here: the window on those is small enough in practice
 * that the initial `since` load is the whole story.
 */
export async function loadMoreOwnedChats(
  subject: string,
  before: Date
): Promise<{ chats: ChatListItem[]; nextBefore: string | null }> {
  const [rows, projectIds] = await Promise.all([
    listOwnedChats(subject, {
      includeArchived: true,
      before,
      limit: CHAT_SIDEBAR_PAGE_SIZE + 1,
    }),
    listAccessibleProjectIds(subject),
  ]);
  const hasMore = rows.length > CHAT_SIDEBAR_PAGE_SIZE;
  const page = (hasMore ? rows.slice(0, CHAT_SIDEBAR_PAGE_SIZE) : rows).filter(
    (chat) => chat.lastMessageAt !== null
  );
  const projects = await listProjectsById(projectIds);
  const projectsById = projectMapFor(projects);
  const branchOf = await chatBranchesFor(page);
  const chats = page.map((chat) =>
    item(
      chat,
      'owner',
      null,
      chat.projectId ? (projectsById.get(chat.projectId) ?? null) : null,
      branchOf(chat)
    )
  );
  const cursor = hasMore ? rows[CHAT_SIDEBAR_PAGE_SIZE - 1] : rows[rows.length - 1];
  return { chats, nextBefore: hasMore && cursor ? cursor.updatedAt.toISOString() : null };
}
