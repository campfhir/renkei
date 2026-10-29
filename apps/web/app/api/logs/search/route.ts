import { NextRequest, NextResponse } from 'next/server';
import { getDataStore, type LogCipher } from '@renkei/db';
import { resolveLogCipher } from '@/lib/log-encryption';
import { buildLogQueryOptions } from '@/lib/log-query';
import { getSessionFromRequest } from '@/lib/session';
import type { LogRow } from '@campfhir/bored-logs';

/** encrypt/decrypt for secure()-stored attributes, when LOG_ENCRYPTION_KEY is set. */
function logCipher(): LogCipher | undefined {
  const resolved = resolveLogCipher();
  return resolved.state === 'on'
    ? { encrypt: resolved.cipher.encrypt, decrypt: resolved.cipher.decrypt }
    : undefined;
}

/** The query's rows, or the adapter's refusal as the message to send back. */
async function runQuery(
  options: ReturnType<typeof buildLogQueryOptions>
): Promise<{ ok: true; logs: LogRow[] } | { ok: false; message: string }> {
  try {
    return { ok: true, logs: await getDataStore().activityLogs.search(options, logCipher()) };
  } catch (error) {
    console.error('Query error:', error);
    return {
      ok: false,
      message: (error instanceof Error && error.message) || 'Failed to query logs',
    };
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const { searchParams } = new URL(request.url);
  const requestedAccountId = searchParams.get('accountId');

  // Roles come from the server-side session, never from a client-supplied cookie.
  const session = await getSessionFromRequest(request);
  if (!session) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const userRoles = new Set(session.roles);

  try {
    // Verify tenant exists
    // Parse user query from request body
    let userQuery: string | null = null;
    try {
      const body = await request.json();
      userQuery = body?.query || body?.filter || null;
    } catch {
      // If no body, use empty query
    }

    // Enforce role-based access control
    // renkei-operator: can view aggregated logs for entire tenant
    // renkei-user: can view only their own logs (requires accountId)

    // Check for operator role
    if (userRoles.has('renkei-operator')) {
      // Operator can view all logs, filter by tenant only
      const result = await runQuery(buildLogQueryOptions(userQuery));

      if (!result.ok) {
        return NextResponse.json({ error: result.message }, { status: 500 });
      }

      return NextResponse.json({
        role: 'renkei-operator',
        roles: [...userRoles],
        query: userQuery || undefined,
        logs: result.logs,
        count: result.logs.length,
      });
    }

    // Check for user role
    if (userRoles.has('renkei-user')) {
      // A user sees only their own logs. The account id is derived from the
      // caller's own grant, never read from the query string — "this account
      // has a grant" is not "the caller owns this account", so trusting a
      // client-supplied accountId let any user read another user's logs. A
      // grant with a NULL subject predates per-user ownership and never matches.
      const accountId = await getDataStore().personalAccount.providerAccountId(
        session.subject,
        'atlassian'
      );


      // A caller may still name an account, but only their own: serving their
      // own logs under someone else's id would misreport whose activity these are.
      if (requestedAccountId && requestedAccountId !== accountId) {
        return NextResponse.json({ error: 'Cannot view other users logs' }, { status: 403 });
      }

      // User can view only their own logs
      const result = await runQuery(
        buildLogQueryOptions(userQuery, { accountId, subject: session.subject })
      );

      if (!result.ok) {
        return NextResponse.json({ error: result.message }, { status: 500 });
      }

      return NextResponse.json({
        role: 'renkei-user',
        roles: [...userRoles],
        accountId,
        query: userQuery || undefined,
        logs: result.logs,
        count: result.logs.length,
      });
    }

    // No recognized role
    return NextResponse.json({ error: 'Invalid user role' }, { status: 403 });
  } catch (error) {
    console.error('Failed to fetch logs:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to fetch logs' },
      { status: 500 }
    );
  }
}
