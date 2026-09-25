/**
 * The lines a route reading PRs, commits or pipeline runs starts with:
 * the usual codeProjectContext, then the RepoHostAdapter for whichever
 * host the project's repository is on. One place for this pairing so
 * pulls/route.ts, commits/route.ts and actions/route.ts don't each
 * re-resolve the caller's origin and provider by hand.
 */

import type { NextRequest } from 'next/server';
import type { NextResponse } from 'next/server';
import { codeProjectContext, type CodeProjectContext } from './route-access';
import { hostAdapterFor, type RepoHostAdapter } from './repo-host';
import { getOrigin } from '@/lib/get-origin';
import { jsonError } from '@/lib/chat/route-support';

export interface CodeProjectHostContext extends CodeProjectContext {
  adapter: RepoHostAdapter;
}

export async function codeProjectHostContext(
  request: NextRequest,
  tenantId: string,
  projectId: string
): Promise<{ ok: true; context: CodeProjectHostContext } | { ok: false; response: NextResponse }> {
  const ready = await codeProjectContext(request, tenantId, projectId);
  if (!ready.ok) return ready;
  const { session, project } = ready.context;
  const origin = await getOrigin(request);
  const adapter = hostAdapterFor(project.repo!.provider, {
    tenantId,
    subject: session.subject,
    origin: origin.ok ? origin.val : '',
  });
  if (!adapter) {
    return {
      ok: false,
      response: jsonError(409, 'unsupported-host', 'This repository’s host is not supported.'),
    };
  }
  return { ok: true, context: { ...ready.context, adapter } };
}
