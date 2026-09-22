import { NextRequest, NextResponse } from 'next/server';
import { getDatabase } from '@renkei/db';
import { randomUUID } from 'crypto';
import { getSessionFromRequest } from '@/lib/session';
import { getGitHubApp } from '@/lib/github-app';
import { ALL_GITHUB_SCOPES } from '@/lib/github-scopes';
import { getOrigin } from '@/lib/get-origin';
import { logger } from '@/lib/logger';

/**
 * Authorize against Renkei's GitHub App. As with Bitbucket, a GitHub
 * App's real permissions are fixed on the App's own registration — the
 * authorize URL takes no scope parameter, so the user's narrowing here is
 * recorded on the pending row (it becomes requested_scopes, which the
 * tool gate intersects with what Renkei chooses to use) but never travels
 * to GitHub. If the App has "Request user authorization (OAuth) during
 * installation" enabled (the recommended setting), this same link also
 * prompts installing the App on an org/repos first when it is not
 * installed yet — one click either way.
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
    const app = await getGitHubApp(tenantId, originResult.val);
    if (!app) {
      return NextResponse.json(
        { error: 'GitHub connector not configured for this organization' },
        { status: 503 }
      );
    }

    // Narrowing only: any requested capability outside the org's set is
    // refused — same rule as Bitbucket's authorize route.
    const ceiling = new Set(app.scopes.split(/\s+/));
    const requestedParam = new URL(request.url).searchParams.get('scopes');
    let effectiveScopes = app.scopes;
    if (requestedParam) {
      const requested = requestedParam.split(/[\s,+]+/).filter(Boolean);
      const outside = requested.filter(
        (scope) => !ceiling.has(scope) || !ALL_GITHUB_SCOPES.includes(scope)
      );
      if (outside.length > 0) {
        return NextResponse.json(
          { error: `Capabilities not allowed by this organization: ${outside.join(', ')}` },
          { status: 400 }
        );
      }
      effectiveScopes = requested.join(' ');
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
        provider: 'github',
        scopes: effectiveScopes,
        expires_at: expiresAt.toISOString(),
        created_at: new Date().toISOString(),
      })
      .execute();

    // No scope parameter, deliberately: GitHub App permissions are fixed
    // on the App's registration, not requested here.
    const authUrl = new URL('https://github.com/login/oauth/authorize');
    authUrl.searchParams.append('client_id', app.clientId);
    authUrl.searchParams.append('redirect_uri', app.redirectUri);
    authUrl.searchParams.append('state', state);

    logger.debug('GitHub authorize redirect', {
      component: 'auth/oauth',
      tenantId,
      clientId: app.clientId,
    });
    return NextResponse.redirect(authUrl.toString());
  } catch (error) {
    logger.error('GitHub authorize error: {error}', {
      component: 'auth/oauth',
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json({ error: 'Failed to initiate authorization' }, { status: 500 });
  }
}
