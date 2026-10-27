import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { getDataStore } from '@renkei/db';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { grantProviderLabel, GRANT_PROVIDER_LABELS } from '@/lib/provider-labels';

/**
 * Operator revoke of any user's connector grant — every provider, not just
 * Atlassian. POST /api/admin/grants/[grantId]/revoke with
 * { provider } in the body ('atlassian' assumed when absent, the shape the
 * old Jira-only page sent).
 *
 * Deletes only the stored credential: the provider keeps its own record of
 * the authorization until the user withdraws it there, and the per-provider
 * self-disconnect routes carry the deeper cleanup (subscriptions, indexed
 * chunks). An admin revoke is containment — cut Renkei's access now — not
 * the user's own tidy exit, so it stays deliberately blunt.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ grantId: string }> }
): Promise<NextResponse> {
  const { grantId } = await params;
  const access = await checkAccess([ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const body: unknown = await request.json().catch(() => null);
  const requested: { provider?: unknown } = typeof body === 'object' && body !== null ? body : {};
  const provider = typeof requested.provider === 'string' ? requested.provider : 'atlassian';
  if (!(provider in GRANT_PROVIDER_LABELS)) {
    return NextResponse.json({ error: 'Unknown provider' }, { status: 400 });
  }

  // The grant goes, and with it the subject's MCP bearer credentials: an
  // access or refresh token issued to them keeps naming them as the caller
  // for up to its lifetime, and the admin pressed this to cut access now,
  // not at the next expiry. Every client's — one revoke, no survivors.
  const grant = await getDataStore().orgAccess.revokeGrant(provider, grantId);
  if (!grant) {
    return NextResponse.json({ error: 'Grant not found' }, { status: 404 });
  }

  recordAuditEvent({
    actorSubject: access.subject,
    action: 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: provider,
    // Whose access died, and that it was not their own doing — the two
    // things the person will ask when their tools stop working.
    details: { byAdmin: true, subject: grant.subject, account: grant.displayName },
  });
  // The GRANT's own subject lost the connector, not the admin who revoked it.
  // A pre-per-user-ownership grant can carry no subject at all, in which
  // case there is no cached caller to invalidate.
  if (grant.subject) invalidateToolCatalogCache(grant.subject);

  return NextResponse.json({
    success: true,
    message: `${grantProviderLabel(provider)} access for ${grant.displayName ?? grantId} has been revoked`,
  });
}
