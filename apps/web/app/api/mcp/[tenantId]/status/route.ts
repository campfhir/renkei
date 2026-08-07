import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';

/**
 * Whether the signed-in caller has connected Jira, for the setup page at
 * /mcp/{tenantId}.
 *
 * Answers only about the caller's own grant. This previously took the first
 * grant in the tenant with no subject filter and no authentication at all,
 * which was wrong twice over: it handed anyone holding a tenantId — a value
 * that appears in every MCP endpoint URL, so not a secret — another person's
 * Atlassian account id, real name and Jira site; and once grants became
 * per-user it told the second user of a tenant they were connected as the
 * first, so the page hid the connect button from someone who had no grant.
 */
export const GET = async (
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> => {
  const { tenantId } = await params;

  // Before any lookup: a session proves both who is asking and that the tenant
  // exists, since a session row cannot reference a tenant that does not.
  const session = await getSessionFromRequest(request, tenantId);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  try {
    // Keyed on subject, so this is the caller's grant or nothing. A grant with
    // a NULL subject predates per-user ownership and never matches.
    const grant = await db
      .selectFrom('provider_grants')
      .select(['provider_account_id', 'display_name', 'metadata'])
      .where('tenant_id', '=', tenantId)
      .where('provider', '=', 'atlassian')
      .where('subject', '=', session.subject)
      .executeTakeFirst();

    if (!grant) {
      return NextResponse.json({
        connected: false,
        message: 'No Jira grant configured',
      });
    }

    // Read the site straight out of metadata rather than going through
    // getJiraGrant, which decrypts both Atlassian tokens — and can trigger a
    // refresh against Atlassian — to serve what is only a page-load probe.
    const metadata: Record<string, unknown> =
      typeof grant.metadata === 'object' && grant.metadata !== null ? { ...grant.metadata } : {};

    return NextResponse.json({
      connected: true,
      accountId: grant.provider_account_id,
      displayName: grant.display_name,
      siteUrl: typeof metadata.siteUrl === 'string' ? metadata.siteUrl : null,
    });
  } catch (error) {
    console.error('Status check error:', error);
    return NextResponse.json(
      {
        connected: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
};
