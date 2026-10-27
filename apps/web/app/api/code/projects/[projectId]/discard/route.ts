/**
 * Discarding every uncommitted change on a code project's checkout —
 * `git reset --hard HEAD` plus `git clean -fd` on the sandbox
 * (sbWorkspaceGitDiscard) — so a person blocked from switching branches
 * by a dirty working tree (branch/route.ts's own 409 'dirty') has a way
 * through besides opening a chat and asking the model to run git.
 * Irreversible: anything not committed is lost, the same warning the
 * project-delete confirmation already carries. Editors only, and — like
 * a branch switch — refused while the active chat is mid-turn, since its
 * tool calls are working on this exact checkout.
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { clientFailure, sbWorkspaceGitDiscard } from '@renkei/sandbox-client';
import { jsonError } from '@/lib/chat/route-support';
import { codeProjectContext } from '@/lib/code/route-access';
import { codeProjectTarget } from '@/lib/code/scope';
import { getActiveTurn } from '@/lib/chat/turns';
import { recordAuditEvent } from '@/lib/audit-events';

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ projectId: string; chatId?: string }> }
): Promise<Response> {
  const { projectId, chatId } = await params;
  const ready = await codeProjectContext(request, projectId, { write: true, chatId });
  if (!ready.ok) return ready.response;
  const { session, project, workspaceId, chat } = ready.context;
  if (!workspaceId)
    return jsonError(409, 'not-cloned', 'There is no checkout to discard changes on.');

  if (chat) {
    const running = await getActiveTurn(chat.id);
    if (running) {
      return jsonError(
        409,
        'turn-running',
        'The chat is mid-turn — its tool calls are working in this worktree right now. Wait for it to finish before discarding changes.'
      );
    }
  }

  const target = codeProjectTarget(projectId);
  const discarded = await sbWorkspaceGitDiscard(target, { id: workspaceId });
  if (!discarded.ok) {
    const failure = clientFailure(discarded.err);
    return jsonError(failure.status, 'discard', failure.message);
  }
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'code.discard_changes',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: { projectId, branch: discarded.val.branch },
  });
  return NextResponse.json({ branch: discarded.val.branch });
}
