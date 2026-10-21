/**
 * A chat's worktree, once the project's base clone is ready: the one the
 * chat has, or a new one. Shared by the chat turn (lib/code/turn.ts) and
 * the code pane's write routes (lib/code/route-access.ts), so a chat that
 * opens its pane or adds a file before its first message gets the same
 * worktree its first turn would have made.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getPublicBaseUrl } from '@renkei/settings';
import { sbWorkspaceGet, type WireWorkspace } from '@renkei/sandbox-client';
import type { ProjectRow } from '@/lib/chat/projects';
import { resolveWorkspaceGitAccess } from '@/lib/sandbox/workspace-git';
import { startChatWorktree, type CodeOutcome } from './projects';
import { codeProjectTarget } from './scope';

export async function ensureChatWorktree(
  db: Kysely<DB>,
  project: ProjectRow,
  chat: { id: string; workspaceId: string | null },
  base: WireWorkspace,
  actor: { subject: string; origin?: string }
): Promise<CodeOutcome<WireWorkspace>> {
  // A worktree of an older clone (the project was cloned again) is not the
  // chat's any more — the worker took it with that clone.
  if (chat.workspaceId) {
    const got = await sbWorkspaceGet(codeProjectTarget(project.id), chat.workspaceId);
    if (got.ok && got.val.status === 'ready' && got.val.parentId === base.id) {
      return { ok: true, val: got.val };
    }
  }
  // The remote is fetched first so the chat starts from where it is now,
  // not from the clone; without a usable grant it starts from the clone.
  const credential = await resolveWorkspaceGitAccess(
    {
      subject: actor.subject,
      origin: actor.origin ?? getPublicBaseUrl() ?? '',
      provider: project.repo!.provider,
    },
    { write: false }
  );
  return startChatWorktree(
    db,
    project,
    chat.id,
    base,
    typeof credential === 'string' ? undefined : credential.gitProxy
  );
}
