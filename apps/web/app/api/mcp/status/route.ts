import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';
import { getDataStore } from '@renkei/db';
import { getSessionFromRequest } from '@/lib/session';
import { logger } from '@/lib/logger';

/**
 * Whether the signed-in caller has connected Jira, for the setup page at
 * /api/mcp.
 *
 * Answers only about the caller's own grant. This previously took the first
 * grant in the tenant with no subject filter and no authentication at all,
 * which was wrong twice over: it handed anyone holding a tenantId — a value
 * that appears in every MCP endpoint URL, so not a secret — another person's
 * Atlassian account id, real name and Jira site; and once grants became
 * per-user it told the second user of a tenant they were connected as the
 * first, so the page hid the connect button from someone who had no grant.
 */
export const GET = async (request: NextRequest): Promise<NextResponse> => {
  // Before any lookup: a session proves both who is asking and that the tenant
  // exists, since a session row cannot reference a tenant that does not.
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    // Keyed on subject, so this is the caller's grant or nothing. A grant with
    // a NULL subject predates per-user ownership and never matches.
    const [grant] = await getDataStore().providerGrants.listForSubject(session.subject, {
      provider: 'atlassian',
    });

    if (!grant) {
      return NextResponse.json({
        connected: false,
        message: 'No Jira grant configured',
      });
    }

    // Read the site straight out of metadata rather than asking the delegate
    // to describe the grant: this is only a page-load probe, and the row
    // already holds what it needs.
    const metadata: Record<string, unknown> =
      typeof grant.metadata === 'object' && grant.metadata !== null ? { ...grant.metadata } : {};

    return NextResponse.json({
      connected: true,
      accountId: grant.accountId,
      displayName: grant.displayName,
      siteUrl: typeof metadata.siteUrl === 'string' ? metadata.siteUrl : null,
    });
  } catch (error) {
    const correlationId = randomUUID();
    logger.error('Jira status check failed: {error}', {
      component: 'api/mcp/status',
      correlationId,
      subject: session.subject,
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return NextResponse.json(
      {
        connected: false,
        error: `Status check failed (ref ${correlationId})`,
      },
      { status: 500 }
    );
  }
};
