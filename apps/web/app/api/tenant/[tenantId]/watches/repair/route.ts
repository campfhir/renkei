/**
 * POST — rebind a broken watch to the caller's live grant, cursor intact.
 *
 * The unblock for a misaligned grant (owner left, token revoked, grant
 * swept as expired): every poll fails, and before this route the only fix
 * was a full re-index — purge plus refetch, which on a large Jira project
 * or Confluence space is exactly the cost a repair must avoid. This
 * verifies the CALLER can reach the scope with their own grant, then
 * takes the tenant's existing watch rows for it over — subject and
 * account rebind, cursor untouched — so polling resumes incrementally
 * from where it stopped.
 *
 * Jira and Confluence only: their cursors are plain updated-since
 * timestamps, valid under any grant that can see the scope. SharePoint
 * repair is a re-add (its delta sync self-heals via reconcile).
 */

import { NextRequest, NextResponse } from 'next/server';
import { ATLASSIAN, ATLASSIAN_CONFLUENCE } from '@renkei/provider-grants';
import { rec, str } from '@renkei/connector-atlassian';
import { getSessionFromRequest } from '@/lib/session';
import { getOrigin } from '@/lib/get-origin';
import {
  resolveAtlassianUserAccess,
  type AtlassianUserProvider,
} from '@/lib/atlassian-user-access';
import { repairWatch } from '@/lib/mcp-tools/content-watches';

type AtlassianWatchProvider = 'jira' | 'confluence';

function isAtlassianWatchProvider(value: unknown): value is AtlassianWatchProvider {
  return value === 'jira' || value === 'confluence';
}

function grantProviderFor(provider: AtlassianWatchProvider): AtlassianUserProvider {
  return provider === 'jira' ? ATLASSIAN : ATLASSIAN_CONFLUENCE;
}

const SCOPE_TYPE: Record<AtlassianWatchProvider, 'project' | 'space'> = {
  jira: 'project',
  confluence: 'space',
};

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body = await request.json().catch(() => null);
  const provider = rec(body).provider;
  const scopeKey = str(rec(body).scopeKey).trim();
  if (!isAtlassianWatchProvider(provider) || !scopeKey) {
    return NextResponse.json(
      { error: 'provider (jira|confluence) and scopeKey are required' },
      { status: 400 }
    );
  }

  const originResult = await getOrigin(request);
  if (!originResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // The caller's grant is resolved (and refreshed) right now — a repair
  // that rebinds a watch onto another dead grant would only move the
  // failure, not fix it.
  const access = await resolveAtlassianUserAccess(
    tenantId,
    session.subject,
    grantProviderFor(provider),
    originResult.val
  );
  if (typeof access === 'string') return NextResponse.json({ error: access }, { status: 400 });

  const result = await repairWatch(
    { tenantId, subject: session.subject, accountId: access.accountId },
    provider,
    SCOPE_TYPE[provider],
    scopeKey
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 500 });
  if (result.repaired === 0) {
    return NextResponse.json(
      { error: `No watch exists for that ${provider} scope in this organization.` },
      { status: 404 }
    );
  }
  return NextResponse.json({ repaired: result.repaired });
}
