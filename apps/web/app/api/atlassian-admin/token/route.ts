/**
 * The person's Atlassian API token, beside their Jira Administration grant
 * — the Automation API's only key (lib/mcp-tools/jira-admin/automation-client.ts).
 *
 * POST stores it through the delegate (grant/store: the secret travels
 * there once and never comes back), then checks it the only way the design
 * allows — a call to the Automation API through the delegate — and drops
 * it again on a 401, so a mistyped token is never kept. DELETE removes it.
 * Subject-scoped: the session decides whose token, never a parameter, and
 * it is tied to the Jira Administration grant's site.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import {
  ATLASSIAN_ADMIN,
  ATLASSIAN_ADMIN_TOKEN,
  readAtlassianMetadata,
} from '@renkei/provider-grants';
import { delegateGrants } from '@renkei/delegate-client';
import { getSessionFromRequest } from '@/lib/session';
import { recordAuditEvent } from '@/lib/audit-events';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { jiraAdminGet } from '@/lib/mcp-tools/jira-admin/client';
import { resolveAutomationAccess } from '@/lib/mcp-tools/jira-admin/automation-client';
import { routeLog } from '@/lib/log-context';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const TOKEN_MAX = 1024;

async function POSTHandler(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const body: unknown = await request.json().catch(() => null);
  const record = typeof body === 'object' && body !== null ? Object(body) : {};
  const email = typeof record.email === 'string' ? record.email.trim() : '';
  const token = typeof record.token === 'string' ? record.token.trim() : '';
  if (!EMAIL.test(email)) {
    return NextResponse.json({ error: 'Enter the Atlassian account’s email.' }, { status: 400 });
  }
  if (!token || token.length > TOKEN_MAX) {
    return NextResponse.json({ error: 'Enter the API token.' }, { status: 400 });
  }

  // Tied to the Jira Administration grant: its site, its account.
  const admin = await delegateGrants().describe({
    provider: ATLASSIAN_ADMIN,
    subject: session.subject,
  });
  if (!admin.ok) {
    return NextResponse.json(
      { error: 'Connect Jira Administration first; the token is kept beside that connection.' },
      { status: 409 }
    );
  }
  const site = readAtlassianMetadata(admin.val.metadata);
  if (!site.cloudId) {
    return NextResponse.json(
      { error: 'The Jira Administration connection is missing its site; reconnect it first.' },
      { status: 409 }
    );
  }

  const stored = await delegateGrants().store({
    provider: ATLASSIAN_ADMIN_TOKEN,
    subject: session.subject,
    accountId: admin.val.accountId,
    displayName: email,
    secret: token,
    metadata: { email, cloudId: site.cloudId, siteUrl: site.siteUrl },
  });
  if (!stored.ok) {
    return NextResponse.json({ error: 'Could not store the token.' }, { status: 500 });
  }

  // Checked the only way the token may be used: a call through the delegate.
  const access = await resolveAutomationAccess({ subject: session.subject });
  if (typeof access === 'string') {
    return NextResponse.json({ error: access }, { status: 500 });
  }
  const probe = await jiraAdminGet(
    { subject: session.subject },
    access,
    '/rest/v1/rule/summary?limit=1'
  );
  if (!probe.ok && probe.status === 401) {
    await delegateGrants().delete({
      provider: ATLASSIAN_ADMIN_TOKEN,
      accountId: admin.val.accountId,
    });
    return NextResponse.json(
      {
        error:
          'Atlassian refused that token, so it was not kept. Check the email is the account the ' +
          'token was made for, and that the token has not been revoked.',
      },
      { status: 400 }
    );
  }

  recordAuditEvent({
    actorSubject: session.subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: ATLASSIAN_ADMIN_TOKEN,
  });
  invalidateToolCatalogCache(session.subject);
  const note = probe.ok
    ? null
    : probe.status === 403
      ? 'Saved. Atlassian answered that this account may not manage automation rules; it will ' +
        'work once it is a Jira administrator.'
      : `Saved, but it could not be checked right now: ${probe.error}`;
  return NextResponse.json({ message: 'API token saved', note });
}

async function DELETEHandler(request: NextRequest): Promise<NextResponse> {
  const session = await getSessionFromRequest(request);
  if (!session) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database error' }, { status: 500 });
  const grant = await dbResult.val
    .selectFrom('provider_grants')
    .select('provider_account_id')
    .where('provider', '=', ATLASSIAN_ADMIN_TOKEN)
    .where('subject', '=', session.subject)
    .executeTakeFirst();
  if (!grant) return NextResponse.json({ message: 'Nothing to remove' });

  const deleted = await delegateGrants().delete({
    provider: ATLASSIAN_ADMIN_TOKEN,
    accountId: grant.provider_account_id,
  });
  if (!deleted.ok)
    return NextResponse.json({ error: 'Could not remove the token' }, { status: 500 });
  recordAuditEvent({
    actorSubject: session.subject,
    action: 'connector.disconnected',
    targetKind: 'connector',
    targetLabel: ATLASSIAN_ADMIN_TOKEN,
  });
  invalidateToolCatalogCache(session.subject);
  return NextResponse.json({ message: 'API token removed' });
}

export const POST = routeLog(POSTHandler);
export const DELETE = routeLog(DELETEHandler);
