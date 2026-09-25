/**
 * A person switching the project's shared checkout to a different
 * branch — from the project screen's Repository card, or from the
 * active chat's title bar (branch-switcher.tsx, both places). GET lists
 * the repository's branches for the picker, read with the signed-in
 * person's own host grant (hostAdapterFor); POST fetches the chosen
 * branch and checks the checkout out onto it, the same primitive
 * `code_git_pull`'s optional `branch` argument uses
 * (sbWorkspaceGitPull), which updates `sandbox_workspaces.branch` on
 * the worker's own.
 *
 * Two guards nothing else in the code pane enforces today, because
 * switching the checkout out from under it is riskier than a commit or
 * push: refuse while the project's active chat has a turn running (its
 * tool calls are operating on the checkout right now), and refuse on a
 * dirty working tree (git's own checkout would otherwise carry
 * uncommitted changes onto the new branch rather than failing loudly).
 */

import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { validateGitRef } from '@renkei/connector-sandbox';
import { clientFailure, sbWorkspaceGitPull, sbWorkspaceGitStatus } from '@renkei/sandbox-client';
import { jsonError, readJsonBody } from '@/lib/chat/route-support';
import { codeProjectContext } from '@/lib/code/route-access';
import { codeProjectTarget } from '@/lib/code/scope';
import { hostAdapterFor } from '@/lib/code/repo-host';
import { getActiveTurn } from '@/lib/chat/turns';
import { getOrigin } from '@/lib/get-origin';
import { resolveWorkspaceGitCredential } from '@/lib/sandbox/workspace-git';
import { recordAuditEvent } from '@/lib/audit-events';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await codeProjectContext(request, tenantId, projectId);
  if (!ready.ok) return ready.response;
  const { session, project } = ready.context;
  const origin = await getOrigin(request);
  const adapter = hostAdapterFor(project.repo!.provider, {
    tenantId,
    subject: session.subject,
    origin: origin.ok ? origin.val : '',
  });
  if (!adapter) return jsonError(409, 'unsupported-host', 'This repository’s host is not supported.');
  const listed = await adapter.listBranches(project.repo!.fullName);
  if (!listed.ok) return jsonError(502, 'host', listed.error);
  return NextResponse.json({ branches: listed.branches });
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; projectId: string }> }
): Promise<Response> {
  const { tenantId, projectId } = await params;
  const ready = await codeProjectContext(request, tenantId, projectId, { write: true });
  if (!ready.ok) return ready.response;
  const { db, session, project } = ready.context;
  if (!project.workspaceId)
    return jsonError(409, 'not-cloned', 'There is no checkout to switch branches on yet.');

  const body = await readJsonBody(request);
  const branchInput = typeof body.branch === 'string' ? body.branch.trim() : '';
  if (!branchInput) return jsonError(400, 'invalid', 'Name the branch to switch to.');
  const ref = validateGitRef(branchInput);
  if (!ref.ok) return jsonError(400, 'invalid', ref.message);

  if (project.activeChatId) {
    const running = await getActiveTurn(db, project.activeChatId);
    if (running) {
      return jsonError(
        409,
        'turn-running',
        'The active chat is mid-turn — its tool calls are working on this checkout right now. Wait for it to finish before switching branches.'
      );
    }
  }

  const target = codeProjectTarget(tenantId, projectId);
  const status = await sbWorkspaceGitStatus(target, { id: project.workspaceId });
  if (!status.ok) {
    const failure = clientFailure(status.err);
    return jsonError(failure.status, 'status', failure.message);
  }
  if (status.val.status.trim()) {
    return jsonError(
      409,
      'dirty',
      'There are uncommitted changes on the checkout. Commit or discard them before switching branches.'
    );
  }

  const origin = await getOrigin(request);
  const credential = await resolveWorkspaceGitCredential(
    {
      tenantId,
      subject: session.subject,
      origin: origin.ok ? origin.val : '',
      provider: project.repo!.provider,
    },
    { write: false }
  );
  if (typeof credential === 'string') return jsonError(409, 'git-credential', credential);
  const pulled = await sbWorkspaceGitPull(target, {
    id: project.workspaceId,
    authHeader: credential.authHeader,
    branch: ref.ref,
  });
  if (!pulled.ok) {
    const failure = clientFailure(pulled.err);
    return jsonError(failure.status, 'switch', failure.message);
  }
  recordAuditEvent({
    tenantId,
    actorSubject: session.subject,
    action: 'code.branch_switch',
    targetKind: 'code_project',
    targetLabel: project.name,
    details: { projectId, branch: pulled.val.branch },
  });
  return NextResponse.json({ branch: pulled.val.branch });
}
