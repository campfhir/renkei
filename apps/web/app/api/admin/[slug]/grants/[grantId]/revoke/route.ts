import { NextRequest, NextResponse } from 'next/server';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { getDatabase } from '@renkei/db';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { grantProviderLabel, GRANT_PROVIDER_LABELS } from '@/lib/provider-labels';

/**
 * Operator revoke of any user's connector grant — every provider, not just
 * Atlassian. POST /api/admin/[slug]/grants/[grantId]/revoke with
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
  { params }: { params: Promise<{ slug: string; grantId: string }> }
): Promise<NextResponse> {
  const { slug, grantId } = await params;
  const access = await checkAccess(tenantRef.id, [ROLE_OPERATOR]);
  if (!access) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  const body: unknown = await request.json().catch(() => null);
  const requested: { provider?: unknown } = typeof body === 'object' && body !== null ? body : {};
  const provider = typeof requested.provider === 'string' ? requested.provider : 'atlassian';
  if (!(provider in GRANT_PROVIDER_LABELS)) {
    return NextResponse.json({ error: 'Unknown provider' }, { status: 400 });
  }

  const grant = await db
    .selectFrom('provider_grants')
    .select(['provider_account_id', 'display_name', 'subject'])
    .where('provider_account_id', '=', grantId)
    .where('provider', '=', provider)
    .executeTakeFirst();
  if (!grant) {
    return NextResponse.json({ error: 'Grant not found' }, { status: 404 });
  }

  await db
    .deleteFrom('provider_grants')
    .where('provider_account_id', '=', grantId)
    .where('provider', '=', provider)
    .execute();

  // The subject's MCP bearer credentials go with the grant: an access token
  // or refresh token issued to them keeps naming them as the caller for up
  // to its lifetime, and the admin pressed this to cut access now, not at
  // the next expiry. Every client's — one revoke, no survivors.
  if (grant.subject) {
    await db
      .deleteFrom('oauth_access_tokens')
      .where('subject', '=', grant.subject)
      .execute();
    await db
      .deleteFrom('oauth_refresh_tokens')
      .where('subject', '=', grant.subject)
      .execute();
  }

  recordAuditEvent({
    actorSubject: access.subject,
    action: 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: provider,
    // Whose access died, and that it was not their own doing — the two
    // things the person will ask when their tools stop working.
    details: { byAdmin: true, subject: grant.subject, account: grant.display_name },
  });
  // The GRANT's own subject lost the connector, not the admin who revoked it.
  // A pre-per-user-ownership grant can carry no subject at all, in which
  // case there is no cached caller to invalidate.
  if (grant.subject) invalidateToolCatalogCache(tenantRef.id, grant.subject);

  return NextResponse.json({
    success: true,
    message: `${grantProviderLabel(provider)} access for ${grant.display_name ?? grantId} has been revoked`,
  });
}
