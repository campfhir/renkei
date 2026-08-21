import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { randomUUID } from 'crypto';
import { getSessionFromRequest } from '@/lib/session';
import { getAtlassianApp } from '@/lib/atlassian-app';
import { ATLASSIAN_REQUIRED_SCOPES } from '@/lib/atlassian-scopes';
import { getOrigin } from '@/lib/get-origin';
import { logger } from '@/lib/logger';

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
    // Verify tenant exists
    const tenant = await db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();

    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 404 });
    }

    // The resulting grant is bound to whoever completes this flow, so the caller
    // must already be signed in. Without this, anyone holding a tenantId could
    // attach their own Atlassian account to that tenant.
    const session = await getSessionFromRequest(request, tenantId);
    if (!session) {
      return NextResponse.json(
        { error: 'Not signed in', error_description: 'Sign in before connecting Jira' },
        { status: 401 }
      );
    }

    // The org's Atlassian app registration comes from connector config in
    // the database; without one, no Atlassian flow can start.
    const originResult = await getOrigin(request);
    if (!originResult.ok) {
      return NextResponse.json({ error: 'Config error' }, { status: 500 });
    }
    const app = await getAtlassianApp(tenantId, originResult.val);
    if (!app) {
      return NextResponse.json(
        { error: 'Atlassian connector not configured for this organization' },
        { status: 503 }
      );
    }

    // The user may narrow the org's scope ceiling, never widen it: any
    // requested scope outside the org's configured set is refused here,
    // server-side — the picker UI is convenience, this check is the rule.
    // Required scopes (offline_access) are appended regardless; a grant
    // without a refresh token dies within the hour and helps nobody.
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
        ...ATLASSIAN_REQUIRED_SCOPES.filter((scope) => !requested.includes(scope)),
      ].join(' ');
    }

    // Generate state for CSRF protection
    const state = randomUUID();
    const nonce = randomUUID();
    const expiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes

    // Store pending OAuth state, carrying the connecting user so the callback
    // knows whose grant to stamp.
    await db
      .insertInto('pending_oidc_signin')
      .values({
        id: randomUUID(),
        state,
        nonce,
        tenant_id: tenantId,
        subject: session.subject,
        scopes: effectiveScopes,
        expires_at: expiresAt.toISOString(),
        created_at: new Date().toISOString(),
      })
      .execute();

    // Build Atlassian OAuth URL for this tenant
    const authUrl = new URL('https://auth.atlassian.com/authorize');
    authUrl.searchParams.append('audience', 'api.atlassian.com');
    authUrl.searchParams.append('client_id', app.clientId);
    authUrl.searchParams.append('redirect_uri', app.redirectUri);
    authUrl.searchParams.append('response_type', 'code');
    authUrl.searchParams.append('scope', effectiveScopes);
    authUrl.searchParams.append('state', state);
    // Required per Atlassian's 3LO docs: always show the consent screen, so
    // a scope change (e.g. narrowed checkboxes) is re-consented rather than
    // silently reusing the previous grant's screen-less approval.
    authUrl.searchParams.append('prompt', 'consent');

    logger.debug('Jira OAuth authorize redirect', {
      component: 'auth/oauth',
      tenantId,
      clientId: app.clientId,
      redirectUri: app.redirectUri,
      urlLength: authUrl.toString().length,
    });
    // Atlassian's login/consent chain re-encodes this URL into nested
    // redirects, and their CDN 414s around ~4k nested chars — which an
    // ~83-scope union hit in practice. The curated catalog sits well under;
    // this warns before a future catalog grows back into the cliff.
    if (authUrl.toString().length > 2600) {
      logger.warn(
        'authorize URL is {length} chars; Atlassian CDN 414s near ~4k after nested re-encoding',
        {
          component: 'auth/oauth',
          tenantId,
          length: authUrl.toString().length,
        }
      );
    }

    return NextResponse.redirect(authUrl.toString());
  } catch (error) {
    logger.error('MCP authorize error: {error}', {
      component: 'auth/oauth',
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to initiate authorization' }, { status: 500 });
  }
}
