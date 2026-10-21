/**
 * The lines every code-project route starts with, once: the session and
 * database, the person's access to the project (404 for none, never
 * 403), the project row as a code project, and — for a write — the
 * editor role, the feature switch, and the org's read-only mode. The
 * older routes (tree, diff, env) spell these out themselves; the code
 * pane's routes share them here.
 */

import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { sandboxWorkspacesEnabled } from '@renkei/sandbox-client';
import { chatRequestContext, jsonError } from '@/lib/chat/route-support';
import { resolveResourceAccess, type ResourceAccess } from '@/lib/chat/access';
import { getProjectRow, type ProjectRow } from '@/lib/chat/projects';
import { getChatRow, type ChatRow } from '@/lib/chat/store';
import { getOrigin } from '@/lib/get-origin';
import { projectWorkspace } from './projects';
import { ensureChatWorktree } from './worktree';
import type { Session } from '@/lib/session';

export interface CodeProjectContext {
  db: Kysely<DB>;
  session: Session;
  access: ResourceAccess;
  project: ProjectRow;
  /**
   * The checkout the route works in: the named chat's worktree
   * (`options.chatId`, from a `/chats/[chatId]/` URL), else the project's
   * base clone. Null until one exists.
   */
  workspaceId: string | null;
  /** The chat the route is scoped to, when it is. */
  chat: ChatRow | null;
}

export async function codeProjectContext(
  request: NextRequest,
  projectId: string,
  options: {
    write?: boolean;
    /** Work in this chat's worktree instead of the project's base clone. */
    chatId?: string | undefined;
  } = {}
): Promise<{ ok: true; context: CodeProjectContext } | { ok: false; response: NextResponse }> {
  const ready = await chatRequestContext(request);
  if (!ready.ok) return ready;
  const { db, session } = ready.context;
  if (options.write && !(await sandboxWorkspacesEnabled())) {
    return {
      ok: false,
      response: jsonError(
        503,
        'unavailable',
        'Code workspaces are not enabled on this deployment.'
      ),
    };
  }
  const access = await resolveResourceAccess(db, session.subject, 'chat_project', projectId);
  if (!access) return { ok: false, response: jsonError(404, 'not-found', 'No such project') };
  const project = await getProjectRow(db, projectId);
  if (!project || project.kind !== 'code' || !project.repo) {
    return { ok: false, response: jsonError(404, 'not-found', 'No such project') };
  }
  if (options.write) {
    if (access.role === 'viewer') {
      return {
        ok: false,
        response: jsonError(403, 'read-only', 'Only editors can change this project’s repository.'),
      };
    }
    const settings = await getOrgSettings();
    if (settings.ok && settings.val.readOnly) {
      return {
        ok: false,
        response: jsonError(403, 'read-only', 'The organization is in read-only mode.'),
      };
    }
  }
  const origin = await getOrigin(request);
  const scoped = await resolveChatScope(db, session.subject, project, options.chatId, {
    write: options.write ?? false,
    ...(origin.ok ? { origin: origin.val } : {}),
  });
  if (!scoped.ok) return scoped;
  const chat = scoped.chat;
  return {
    ok: true,
    context: {
      db,
      session,
      access,
      project,
      workspaceId: scoped.workspaceId,
      chat,
    },
  };
}

/**
 * Which checkout a route works in: the named chat's worktree, or — with no
 * chat — the project's base clone. Anyone who can read the project may
 * look in a chat's worktree; only the chat's owner changes it, as it is
 * theirs the way the chat is.
 */
export async function resolveChatScope(
  db: Kysely<DB>,
  subject: string,
  project: ProjectRow,
  chatId: string | undefined,
  options: { write: boolean; origin?: string }
): Promise<
  | { ok: true; chat: ChatRow | null; workspaceId: string | null }
  | { ok: false; response: NextResponse }
> {
  if (!chatId) return { ok: true, chat: null, workspaceId: project.workspaceId };
  const chat = await getChatRow(db, chatId);
  if (!chat || chat.projectId !== project.id) {
    return { ok: false, response: jsonError(404, 'not-found', 'No such chat') };
  }
  if (options.write && chat.ownerSubject !== subject) {
    return {
      ok: false,
      response: jsonError(403, 'read-only', 'Only the chat’s owner can change its worktree.'),
    };
  }
  // A chat that opens its pane or adds a file before its first message has
  // no worktree yet: the owner's write makes the one its first turn would.
  if (options.write && !chat.workspaceId && project.workspaceId) {
    const base = await projectWorkspace(project);
    if (base?.status === 'ready') {
      const made = await ensureChatWorktree(db, project, chat, base, {
        subject,
        ...(options.origin ? { origin: options.origin } : {}),
      });
      if (made.ok) return { ok: true, chat, workspaceId: made.val.id };
    }
  }
  return { ok: true, chat, workspaceId: chat.workspaceId };
}
