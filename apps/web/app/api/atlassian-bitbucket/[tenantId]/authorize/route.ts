import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { randomUUID } from 'crypto';
import { getSessionFromRequest } from '@/lib/session';
import { getAtlassianBitbucketApp } from '@/lib/atlassian-app';
import { BITBUCKET_REQUIRED_SCOPES } from '@/lib/atlassian-scopes';
import { getOrigin } from '@/lib/get-origin';
import { logger } from '@/lib/logger';

/**
 * Authorize against the fourth Atlassian app ("Renkei Bitbucket") — a
 * Bitbucket Cloud OAuth consumer, on bitbucket.org rather than the 3LO
 * platform. One consequence shapes this route: Bitbucket scopes are fixed
 * on the consumer and the authorize URL takes no scope parameter, so the
 * user's narrowing here is recorded on the pending row (it becomes
 * requested_scopes, which the tool gate intersects with what the token
 * carries) but never travels to Bitbucket.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string }> }
): Promise<NextResponse> {
  const { tenantId } = await params;
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  try {
    const tenant = await db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();
    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    // The resulting grant is bound to whoever completes this flow.
    const session = await getSessionFromRequest(request, tenantId);
    if (!session) {
      return NextResponse.json(
        { error: 'Not signed in', error_description: 'Sign in before connecting' },
        { status: 401 }
      );
    }

    const originResult = await getOrigin(request);
    if (!originResult.ok) {
      return NextResponse.json({ error: 'Config error' }, { status: 500 });
    }
    const app = await getAtlassianBitbucketApp(tenantId, originResult.val);
    if (!app) {
      return NextResponse.json(
        { error: 'Bitbucket connector not configured for this organization' },
        { status: 503 }
      );
    }

    // Narrowing only: any requested scope outside the org's set is refused.
    const ceiling = new Set(app.scopes.split(/\s+/));
    const requestedParam = new URL(request.url).searchParams.get('scopes');
    let effectiveScopes = app.scopes;
    if (requestedParam) {
      const requested = requestedParam.split(/[\s,+]+/).filter(Boolean);
      const outside = requested.filter((scope) => !ceiling.has(scope));
      if (outside.length > 0) {
        return NextResponse.json(
          { error: `Scopes not allowed by this organization: ${outside.join(', ')}` },
          { status: 400 }
        );
      }
      effectiveScopes = [
        ...requested,
        ...BITBUCKET_REQUIRED_SCOPES.filter((scope) => !requested.includes(scope)),
      ].join(' ');
    }

    const state = randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000);
    await db
      .insertInto('pending_oidc_signin')
      .values({
        id: randomUUID(),
        state,
        nonce: randomUUID(),
        tenant_id: tenantId,
        subject: session.subject,
        provider: 'atlassian-bitbucket',
        scopes: effectiveScopes,
        expires_at: expiresAt.toISOString(),
        created_at: new Date().toISOString(),
      })
      .execute();

    // No scope parameter, deliberately: Bitbucket ignores it — the consumer's
    // configured scopes are what the token will carry, whatever is asked.
    const authUrl = new URL('https://bitbucket.org/site/oauth2/authorize');
    authUrl.searchParams.append('client_id', app.clientId);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('state', state);

    logger.debug('Bitbucket authorize redirect', {
      component: 'auth/oauth',
      tenantId,
      clientId: app.clientId,
    });
    return NextResponse.redirect(authUrl.toString());
  } catch (error) {
    logger.error('Bitbucket authorize error: {error}', {
      component: 'auth/oauth',
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to initiate authorization' }, { status: 500 });
  }
}
