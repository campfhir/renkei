/* eslint-disable @typescript-eslint/consistent-type-assertions */
import { NextRequest, NextResponse } from 'next/server';
import { getAtlassianApp } from '@/lib/atlassian-app';
import { getWebexUserApp } from '@/lib/webex-app';
import { getMicrosoftApp } from '@/lib/microsoft-app';
import { getZoomApp } from '@/lib/zoom-app';
import { getDatabase } from '@renkei/db';
import { webhookEventsQueue } from '@renkei/queue';
import { setJiraGrant } from '@/lib/tenant-operations';
import {
  setGrant,
  scopesFromAccessToken,
  ATLASSIAN,
  ATLASSIAN_JSM,
  ATLASSIAN_CONFLUENCE,
  ATLASSIAN_BITBUCKET,
  WEBEX_USER,
  MICROSOFT,
  ZOOM,
  ONBASE,
  ONBASE_ADMIN,
} from '@renkei/provider-grants';
import { getOnBaseApp } from '@/lib/onbase-app';
import { obExchangeCode, onbaseClientFailure } from '@/lib/onbase/service-client';
import {
  getAtlassianJsmApp,
  getAtlassianConfluenceApp,
  getAtlassianBitbucketApp,
} from '@/lib/atlassian-app';
import { parseEncryptionKey } from '@renkei/crypto';
import { getOrigin } from '@/lib/get-origin';
import { logger } from '@/lib/logger';
import { cacheUserDisplayName } from '@/lib/mcp-tools/common';
import { recordAuditEvent } from '@/lib/audit-events';

interface JiraTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
  /** Space-separated scopes actually granted, when Atlassian echoes them. */
  scope?: string;
}

interface JiraUserInfo {
  accountId: string;
  displayName?: string;
  name?: string;
}

function isJiraTokenResponse(data: unknown): data is JiraTokenResponse {
  if (typeof data !== 'object' || data === null) return false;

  const obj = data as Record<string, unknown>;
  return (
    typeof obj.access_token === 'string' &&
    typeof obj.token_type === 'string' &&
    typeof obj.expires_in === 'number'
  );
}

function isJiraUserInfo(data: unknown): data is JiraUserInfo {
  if (typeof data !== 'object' || data === null) return false;

  const obj = data as Record<string, unknown>;
  return typeof obj.accountId === 'string';
}

/** Decode a JWT's payload without verification — claims for identity hints only. */
function decodeJwtPayload(token: string): Record<string, unknown> | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const parsed: unknown = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof parsed === 'object' && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The Atlassian account id from the access token's sub claim. */
function subFromTokenClaims(accessToken: string): string | null {
  const claims = decodeJwtPayload(accessToken);
  return typeof claims?.sub === 'string' && claims.sub ? claims.sub : null;
}

/**
 * The Jira site's cloud id from the token's resource ARIs
 * (ari:cloud:jira::site/{cloudId}) — the fallback when accessible-resources
 * has nothing to say because the token carries no Jira scopes.
 */
function cloudIdFromTokenClaims(accessToken: string): string | null {
  const claims = decodeJwtPayload(accessToken);
  const resources = claims?.['https://id.atlassian.com/resource'];
  if (!Array.isArray(resources)) return null;
  for (const entry of resources) {
    if (typeof entry !== 'string') continue;
    const match = /^ari:cloud:jira::site\/(.+)$/.exec(entry);
    if (match) return match[1];
  }
  return null;
}

function isResourceArray(data: unknown): data is Array<{ id: string; url: string; name: string }> {
  if (!Array.isArray(data)) return false;

  return data.every(
    (item) =>
      typeof item === 'object' &&
      item !== null &&
      typeof (item as Record<string, unknown>).id === 'string' &&
      typeof (item as Record<string, unknown>).url === 'string' &&
      typeof (item as Record<string, unknown>).name === 'string'
  );
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;
  const { searchParams } = new URL(request.url);
  const code = searchParams.get('code');
  const state = searchParams.get('state');
  const error = searchParams.get('error');
  const errorDescription = searchParams.get('error_description');

  // Handle Jira OAuth error response
  if (error) {
    return NextResponse.json(
      { error, error_description: errorDescription || 'Unknown error' },
      { status: 400 }
    );
  }

  if (!code || !state) {
    return NextResponse.json({ error: 'Missing code or state' }, { status: 400 });
  }

  try {
    // Look up the pending authorization by state (single-use token). The
    // pending record tells us which tenant this flow is for and which
    // provider's token endpoint the code must be exchanged at.
    const pendingSignIn = await db
      .selectFrom('pending_oidc_signin')
      .select(['tenant_id', 'expires_at', 'subject', 'provider', 'scopes', 'code_verifier'])
      .where('state', '=', state)
      .executeTakeFirst();

    if (!pendingSignIn) {
      return NextResponse.json({ error: 'Invalid or expired state' }, { status: 400 });
    }

    // The authorize step records who initiated the connect. A pending row without
    // one predates per-user grants; completing it would produce an unowned grant
    // that no caller can use, so send the user back through a fresh sign-in.
    if (!pendingSignIn.subject) {
      logger.error('Pending sign-in has no subject; cannot assign grant owner', {
        component: 'auth/oauth',
        tenantId: pendingSignIn.tenant_id,
      });
      return NextResponse.json({ error: 'Sign in again before connecting Jira' }, { status: 400 });
    }

    // Delete pending record (single-use) to prevent replay attacks
    await db.deleteFrom('pending_oidc_signin').where('state', '=', state).execute();

    // Verify state is not expired
    const stateExpiresAt = new Date(pendingSignIn.expires_at);
    if (stateExpiresAt < new Date()) {
      return NextResponse.json({ error: 'State expired' }, { status: 400 });
    }

    // Verify tenant exists
    const tenant = await db
      .selectFrom('tenants')
      .select(['id', 'slug'])
      .where('id', '=', pendingSignIn.tenant_id)
      .executeTakeFirst();

    if (!tenant) {
      return NextResponse.json({ error: 'Tenant not found' }, { status: 400 });
    }

    // Dispatch on the provider the authorize step recorded. Null predates
    // the column and means Atlassian — the only provider that existed then.
    if (pendingSignIn.provider === 'webex-user') {
      return handleWebexUserCallback(
        request,
        tenant,
        pendingSignIn.subject,
        code,
        pendingSignIn.scopes
      );
    }
    if (pendingSignIn.provider === 'atlassian-jsm') {
      return handleAtlassianJsmCallback(
        request,
        tenant,
        pendingSignIn.subject,
        code,
        pendingSignIn.scopes
      );
    }
    if (pendingSignIn.provider === 'atlassian-confluence') {
      return handleAtlassianConfluenceCallback(
        request,
        tenant,
        pendingSignIn.subject,
        code,
        pendingSignIn.scopes
      );
    }
    if (pendingSignIn.provider === 'atlassian-bitbucket') {
      return handleAtlassianBitbucketCallback(
        request,
        tenant,
        pendingSignIn.subject,
        code,
        pendingSignIn.scopes
      );
    }
    if (pendingSignIn.provider === 'microsoft') {
      return handleMicrosoftCallback(
        request,
        tenant,
        pendingSignIn.subject,
        code,
        pendingSignIn.scopes
      );
    }
    if (pendingSignIn.provider === 'zoom') {
      return handleZoomCallback(request, tenant, pendingSignIn.subject, code, pendingSignIn.scopes);
    }
    if (pendingSignIn.provider === 'onbase') {
      return handleOnBaseCallback(
        request,
        tenant,
        pendingSignIn.subject,
        code,
        pendingSignIn.scopes,
        pendingSignIn.code_verifier,
        ONBASE_SPEC
      );
    }
    if (pendingSignIn.provider === 'onbase-admin') {
      // A SEPARATE Hyland OAuth client from 'onbase' above — see
      // lib/onbase-app.ts's header — so it rides the identical callback
      // logic with a different connector key, grant provider and label.
      return handleOnBaseCallback(
        request,
        tenant,
        pendingSignIn.subject,
        code,
        pendingSignIn.scopes,
        pendingSignIn.code_verifier,
        ONBASE_ADMIN_SPEC
      );
    }

    logger.debug('Jira callback', { component: 'auth/oauth', tenantId: tenant.id });

    // The org's Atlassian app registration, from connector config. The
    // authorize step used the same reader, so both legs of the exchange
    // present the same client and redirect URI.
    const appOriginResult = await getOrigin(request);
    if (!appOriginResult.ok) {
      return NextResponse.json({ error: 'Config error' }, { status: 500 });
    }
    const atlassianApp = await getAtlassianApp(tenant.id, appOriginResult.val);
    if (!atlassianApp) {
      return NextResponse.json(
        { error: 'Atlassian connector not configured for this organization' },
        { status: 503 }
      );
    }

    logger.debug('Exchanging code for tokens', { component: 'auth/oauth', tenantId: tenant.id });

    // Exchange authorization code for Jira tokens
    const tokenResponse = await fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: atlassianApp.clientId,
        client_secret: atlassianApp.clientSecret,
        code,
        redirect_uri: atlassianApp.redirectUri,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      logger.error('Token exchange failed', {
        component: 'auth/oauth',
        tenantId: tenant.id,
        status: tokenResponse.status,
        error: errorText,
      });
      return NextResponse.json({ error: 'Failed to exchange authorization code' }, { status: 400 });
    }

    const tokenData = await tokenResponse.json();
    // Record only whether a token came back, never any of its bytes: these
    // records are persisted by the Postgres log adapter and are readable over
    // HTTP by tenant users, so even a 20-character prefix does not belong here.
    logger.debug('Token response OK', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      hasAccessToken: Boolean(tokenData.access_token),
      expiresIn: tokenData.expires_in,
    });
    if (!isJiraTokenResponse(tokenData)) {
      logger.error('Invalid token response format', {
        component: 'auth/oauth',
        tenantId: tenant.id,
        tokenData,
      });
      return NextResponse.json({ error: 'Invalid token response format' }, { status: 400 });
    }

    logger.debug('Fetching accessible resources', { component: 'auth/oauth', tenantId: tenant.id });
    // Get accessible resources first to determine site URL
    const resourcesResponse = await fetch(
      'https://api.atlassian.com/oauth/token/accessible-resources',
      {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      }
    );

    if (!resourcesResponse.ok) {
      const resourcesErrorText = await resourcesResponse.text();
      logger.error('Failed to fetch resources', {
        component: 'auth/oauth',
        tenantId: tenant.id,
        status: resourcesResponse.status,
        error: resourcesErrorText,
      });
      return NextResponse.json({ error: 'Failed to get accessible resources' }, { status: 400 });
    }

    const resources = await resourcesResponse.json();
    logger.debug('Resources received', { component: 'auth/oauth', tenantId: tenant.id, resources });
    if (!isResourceArray(resources)) {
      logger.error('Invalid resources format', {
        component: 'auth/oauth',
        tenantId: tenant.id,
        resources,
      });
      return NextResponse.json({ error: 'Invalid resources response format' }, { status: 400 });
    }

    // Use the first accessible resource for the site identity. A token with
    // no Jira scopes (an ops-only or otherwise narrowed grant) surfaces no
    // resources here, and /myself is equally closed to it — for that shape,
    // identity comes from the access token's own claims and the site from the
    // caller's previous grant.
    const resource = resources[0] ?? null;
    let cloudId = resource?.id ?? '';
    let siteUrl = resource?.url ?? '';
    if (!resource) {
      // The AUTHORIZATION CODE is itself a JWT and reliably carries the
      // site's ARI (the access token does not) — the primary fallback.
      // Disconnect-then-reconnect deletes the caller's own prior grant, so
      // the tenant's other grants stand in for the siteUrl: one org, one
      // site, in practice.
      cloudId =
        cloudIdFromTokenClaims(code) ?? cloudIdFromTokenClaims(tokenData.access_token) ?? '';

      const prior = await db
        .selectFrom('provider_grants')
        .select(['metadata'])
        .where('tenant_id', '=', tenant.id)
        .where('provider', '=', 'atlassian')
        .orderBy('updated_at', 'desc')
        .executeTakeFirst();
      if (prior && typeof prior.metadata === 'object' && prior.metadata !== null) {
        const metadata = prior.metadata as Record<string, unknown>;
        if (!cloudId && typeof metadata.cloudId === 'string') cloudId = metadata.cloudId;
        if (typeof metadata.siteUrl === 'string') siteUrl = metadata.siteUrl;
      }

      if (!cloudId) {
        logger.error('No accessible resources, no site ARI in code/token claims, no prior grant', {
          component: 'auth/oauth',
          tenantId: tenant.id,
        });
        return NextResponse.json({ error: 'No Jira sites accessible' }, { status: 400 });
      }
      logger.debug('No accessible resources (jira-less scopes); using fallback site identity', {
        component: 'auth/oauth',
        tenantId: tenant.id,
        cloudId,
      });
    }

    logger.debug('Fetching user info', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      cloudId,
    });
    // Get user info via API gateway path for OAuth 2.0 3LO
    const userResponse = await fetch(
      `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`,
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: 'application/json',
        },
      }
    );

    let accountId = '';
    let displayName = '';
    if (userResponse.ok) {
      const userInfo = await userResponse.json();
      logger.debug('User info received', {
        component: 'auth/oauth',
        tenantId: tenant.id,
        userInfo,
      });
      if (!isJiraUserInfo(userInfo)) {
        logger.error('Invalid user info response format', {
          component: 'auth/oauth',
          tenantId: tenant.id,
          userInfo,
        });
        return NextResponse.json(
          {
            error: 'Invalid user info response format',
            details: `Expected account_id, got: ${JSON.stringify(userInfo)}`,
          },
          { status: 400 }
        );
      }
      accountId = userInfo.accountId;
      // Extract display name from any of several possible field names
      displayName = userInfo.displayName || userInfo.name || userInfo.accountId;
    } else {
      // /myself is a Jira-scoped endpoint; a jira-less token cannot call it.
      // The access token's own sub claim is the Atlassian account id.
      const sub = subFromTokenClaims(tokenData.access_token);
      if (!sub) {
        const userErrorText = await userResponse.text().catch(() => '');
        logger.error('Failed to fetch user info and token carries no sub claim', {
          component: 'auth/oauth',
          tenantId: tenant.id,
          status: userResponse.status,
          error: userErrorText.slice(0, 300),
        });
        return NextResponse.json({ error: 'Failed to get user info' }, { status: 400 });
      }
      accountId = sub;
      displayName = sub;
      const priorName = await db
        .selectFrom('provider_grants')
        .select('display_name')
        .where('tenant_id', '=', tenant.id)
        .where('provider', '=', 'atlassian')
        .where('provider_account_id', '=', sub)
        .executeTakeFirst();
      if (priorName?.display_name) displayName = priorName.display_name;
      logger.debug('User identity from token claims (jira-less scopes)', {
        component: 'auth/oauth',
        tenantId: tenant.id,
        accountId,
      });
    }

    // Cache the displayName for logging
    cacheUserDisplayName(accountId, displayName);

    logger.debug('Storing Jira grant', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      subject: pendingSignIn.subject,
    });
    // Store encrypted Jira grant
    await setJiraGrant(tenant.id, {
      subject: pendingSignIn.subject,
      accountId,
      atlassianClientId: atlassianApp.clientId,
      cloudId,
      siteUrl,
      displayName,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || '',
      expiresAt: new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString(),
      // Provenance kept separate on purpose: requested is what the (possibly
      // user-narrowed) authorize step asked for; granted is decoded from the
      // minted token's own claims — the credential Atlassian's gateway
      // actually evaluates. The token-response echo is only a fallback, and
      // nothing here ever assumes granted equals requested.
      requestedScopes: (pendingSignIn.scopes || atlassianApp.scopes).split(' '),
      grantedScopes:
        scopesFromAccessToken(tokenData.access_token) ??
        ((typeof tokenData.scope === 'string' && tokenData.scope.trim()) || null)?.split(/\s+/) ??
        null,
    });

    logger.info('Jira grant stored successfully', { component: 'auth/oauth', tenantId: tenant.id });
    recordAuditEvent({
      tenantId: tenant.id,
      actorSubject: pendingSignIn.subject,
      action: 'connector.connected',
      targetKind: 'connector',
      targetLabel: 'atlassian',
    });
    // Back to the connectors page, which shows the fresh connection status.
    const originResult = await getOrigin(request);
    if (!originResult.ok) {
      return NextResponse.json({ error: 'Config error' }, { status: 500 });
    }
    const origin = originResult.val;
    const connectorsUrl = new URL(`/${tenant.slug}/connectors`, origin);
    logger.debug('Redirecting', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      url: connectorsUrl.toString(),
    });
    return NextResponse.redirect(connectorsUrl);
  } catch (err) {
    logger.error('Callback error', {
      component: 'auth/oauth',
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return NextResponse.json({ error: 'Authentication failed' }, { status: 500 });
  }
}

/**
 * The WebEx leg of the shared callback: exchange the code with webexapis.com,
 * ask /people/me who authorized, store the grant bound to the signed-in
 * subject. Read access only — the scopes were fixed at the authorize step.
 */
async function handleWebexUserCallback(
  request: NextRequest,
  tenant: { id: string; slug: string },
  subject: string | null,
  code: string,
  requestedScopes: string | null
): Promise<NextResponse> {
  if (!subject) {
    logger.error('WebEx pending flow has no subject; cannot assign grant owner', {
      component: 'auth/oauth',
      tenantId: tenant.id,
    });
    return NextResponse.json({ error: 'Sign in again before connecting WebEx' }, { status: 400 });
  }

  const originResult = await getOrigin(request);
  if (!originResult.ok) {
    return NextResponse.json({ error: 'Config error' }, { status: 500 });
  }
  const app = await getWebexUserApp(tenant.id, originResult.val);
  if (!app) {
    return NextResponse.json(
      { error: 'WebEx user integration not configured for this organization' },
      { status: 503 }
    );
  }

  const tokenResponse = await fetch('https://webexapis.com/v1/access_token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
      redirect_uri: app.redirectUri,
    }),
  });
  if (!tokenResponse.ok) {
    const body = await tokenResponse.text().catch(() => '');
    logger.error('WebEx token exchange failed', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      status: tokenResponse.status,
      body: body.slice(0, 300),
    });
    return NextResponse.json({ error: 'WebEx token exchange failed' }, { status: 502 });
  }
  const tokenData: unknown = await tokenResponse.json().catch(() => null);
  const tokens = tokenData as Record<string, unknown> | null;
  const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token : null;
  if (!accessToken) {
    logger.error('WebEx token response carried no access_token', {
      component: 'auth/oauth',
      tenantId: tenant.id,
    });
    return NextResponse.json({ error: 'Malformed WebEx token response' }, { status: 502 });
  }
  const refreshToken = typeof tokens?.refresh_token === 'string' ? tokens.refresh_token : '';
  const expiresIn = typeof tokens?.expires_in === 'number' ? tokens.expires_in : 3600;

  // Who granted this. personId is the durable account key; email is what the
  // access verifier checks room membership against. Requires the always-on
  // spark:people_read scope — a 403 here means the Integration at
  // developer.webex.com does not have it selected.
  const meResponse = await fetch('https://webexapis.com/v1/people/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const meData: unknown = await meResponse.json().catch(() => null);
  const me = meData as Record<string, unknown> | null;
  const personId = typeof me?.id === 'string' ? me.id : null;
  if (!meResponse.ok || !personId) {
    logger.error('WebEx /people/me failed; cannot identify grantor', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      status: meResponse.status,
      hint:
        meResponse.status === 403
          ? 'Select spark:people_read on the Integration at developer.webex.com'
          : undefined,
    });
    return NextResponse.json(
      {
        error: 'Could not identify WebEx user',
        ...(meResponse.status === 403
          ? {
              error_description:
                'The Integration is missing the spark:people_read scope. Select it at developer.webex.com, then reconnect.',
            }
          : {}),
      },
      { status: 502 }
    );
  }
  const displayName = typeof me?.displayName === 'string' ? me.displayName : personId;
  const emails = Array.isArray(me?.emails) ? me.emails.filter((e) => typeof e === 'string') : [];

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    logger.error('TOKEN_ENCRYPTION_KEY missing or malformed; cannot store WebEx grant', {
      component: 'auth/oauth',
      tenantId: tenant.id,
    });
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const stored = await setGrant(
    WEBEX_USER,
    tenant.id,
    {
      accountId: personId,
      clientId: app.clientId,
      displayName,
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      // WebEx does not echo scopes in its token response, so the (possibly
      // user-narrowed) request carried through the pending row is the record.
      requestedScopes: (requestedScopes || app.scopes).split(' '),
      // WebEx access tokens are opaque, so this stays null: unknown, honestly.
      grantedScopes: scopesFromAccessToken(accessToken),
      metadata: { personEmail: emails[0] ?? null },
      subject,
    },
    keyResult.val
  );
  if (!stored.ok) {
    logger.error('Failed to store WebEx grant', { component: 'auth/oauth', tenantId: tenant.id });
    return NextResponse.json({ error: 'Failed to store WebEx grant' }, { status: 500 });
  }

  logger.info('WebEx user grant stored', { component: 'auth/oauth', tenantId: tenant.id, subject });
  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: WEBEX_USER,
  });
  return NextResponse.redirect(new URL(`/${tenant.slug}/connectors`, originResult.val));
}

/**
 * Complete the OAuth flow for the Microsoft (Entra) app: exchange at the
 * org's own tenant token endpoint, identity from the id_token claims (oid,
 * tid, preferred_username) with GET /me as fallback, and a `grant.connected`
 * event enqueued so the WORKER bootstraps Graph subscriptions and the
 * initial delta backfill — the subscription handshake calls our webhook
 * route synchronously, so it cannot run inside this request.
 */
async function handleMicrosoftCallback(
  request: NextRequest,
  tenant: { id: string; slug: string },
  subject: string | null,
  code: string,
  requestedScopes: string | null
): Promise<NextResponse> {
  if (!subject) {
    logger.error('Microsoft pending flow has no subject; cannot assign grant owner', {
      component: 'auth/oauth',
      tenantId: tenant.id,
    });
    return NextResponse.json(
      { error: 'Sign in again before connecting Microsoft' },
      { status: 400 }
    );
  }

  const originResult = await getOrigin(request);
  if (!originResult.ok) {
    return NextResponse.json({ error: 'Config error' }, { status: 500 });
  }
  const app = await getMicrosoftApp(tenant.id, originResult.val);
  if (!app) {
    return NextResponse.json(
      { error: 'Microsoft integration not configured for this organization' },
      { status: 503 }
    );
  }

  const tokenResponse = await fetch(
    `https://login.microsoftonline.com/${encodeURIComponent(app.directoryTenantId)}/oauth2/v2.0/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: app.clientId,
        client_secret: app.clientSecret,
        code,
        redirect_uri: app.redirectUri,
        scope: requestedScopes || app.scopes,
      }),
    }
  );
  if (!tokenResponse.ok) {
    const body = await tokenResponse.text().catch(() => '');
    logger.error('Microsoft token exchange failed', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      status: tokenResponse.status,
      body: body.slice(0, 300),
    });
    return NextResponse.json({ error: 'Microsoft token exchange failed' }, { status: 502 });
  }
  const tokenData: unknown = await tokenResponse.json().catch(() => null);
  const tokens = tokenData as Record<string, unknown> | null;
  const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token : null;
  if (!accessToken) {
    logger.error('Microsoft token response carried no access_token', {
      component: 'auth/oauth',
      tenantId: tenant.id,
    });
    return NextResponse.json({ error: 'Malformed Microsoft token response' }, { status: 502 });
  }
  const refreshToken = typeof tokens?.refresh_token === 'string' ? tokens.refresh_token : '';
  const expiresIn = typeof tokens?.expires_in === 'number' ? tokens.expires_in : 3600;
  const scopeEcho = typeof tokens?.scope === 'string' ? tokens.scope : null;
  const idToken = typeof tokens?.id_token === 'string' ? tokens.id_token : null;

  // Who granted this. The id_token claims answer directly; /me is the
  // fallback when a claim is missing (some Entra configs omit email).
  const claims = idToken ? decodeJwtPayload(idToken) : null;
  let oid = typeof claims?.oid === 'string' ? claims.oid : null;
  const tid = typeof claims?.tid === 'string' ? claims.tid : app.directoryTenantId;
  let upn = typeof claims?.preferred_username === 'string' ? claims.preferred_username : null;
  let displayName = typeof claims?.name === 'string' ? claims.name : null;
  let email = typeof claims?.email === 'string' ? claims.email : null;

  if (!oid || !upn || !email) {
    const meResponse = await fetch('https://graph.microsoft.com/v1.0/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const meData: unknown = await meResponse.json().catch(() => null);
    const me = meData as Record<string, unknown> | null;
    if (meResponse.ok && me) {
      oid = oid ?? (typeof me.id === 'string' ? me.id : null);
      upn = upn ?? (typeof me.userPrincipalName === 'string' ? me.userPrincipalName : null);
      displayName = displayName ?? (typeof me.displayName === 'string' ? me.displayName : null);
      email = email ?? (typeof me.mail === 'string' ? me.mail : null);
    }
  }
  if (!oid || !upn) {
    logger.error('Could not identify Microsoft user from id_token claims or /me', {
      component: 'auth/oauth',
      tenantId: tenant.id,
    });
    return NextResponse.json({ error: 'Could not identify Microsoft user' }, { status: 502 });
  }

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    logger.error('TOKEN_ENCRYPTION_KEY missing or malformed; cannot store Microsoft grant', {
      component: 'auth/oauth',
      tenantId: tenant.id,
    });
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  // A reconnect replaces the metadata wholesale, and the indexing opt-in
  // lives there — carry it over, or reconnecting silently turns a user's
  // indexing off.
  let carriedIndexing: Record<string, unknown> = {};
  const dbForPrefs = getDatabase();
  if (dbForPrefs.ok) {
    const prior = await dbForPrefs.val
      .selectFrom('provider_grants')
      .select('metadata')
      .where('tenant_id', '=', tenant.id)
      .where('provider', '=', MICROSOFT)
      .where('provider_account_id', '=', oid)
      .executeTakeFirst()
      .catch(() => undefined);
    const priorMetadata =
      typeof prior?.metadata === 'object' &&
      prior.metadata !== null &&
      !Array.isArray(prior.metadata)
        ? prior.metadata
        : {};
    const record: Record<string, unknown> = { ...priorMetadata };
    if (typeof record.indexing === 'object' && record.indexing !== null) {
      carriedIndexing = { indexing: record.indexing };
    }
  }

  const stored = await setGrant(
    MICROSOFT,
    tenant.id,
    {
      accountId: oid,
      clientId: app.clientId,
      displayName: displayName ?? upn,
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      requestedScopes: (requestedScopes || app.scopes).split(' '),
      // Graph access tokens carry scp; the token-response echo is the
      // fallback. Both describe what was actually minted.
      grantedScopes: scopesFromAccessToken(accessToken) ?? scopeEcho?.split(/\s+/) ?? null,
      // tid keeps refresh pointed at the right authority; upn/email are what
      // the refIds and the access verifier are built from.
      metadata: { tid, upn, email: email ?? null, ...carriedIndexing },
      subject,
    },
    keyResult.val
  );
  if (!stored.ok) {
    logger.error('Failed to store Microsoft grant', {
      component: 'auth/oauth',
      tenantId: tenant.id,
    });
    return NextResponse.json({ error: 'Failed to store Microsoft grant' }, { status: 500 });
  }

  // Subscription creation + initial delta backfill belong in the worker: the
  // Graph handshake POSTs to our webhook route while the create call is in
  // flight, and a backfill is minutes of work, not callback work.
  const enqueued = await webhookEventsQueue().producer.enqueue({
    tenantId: tenant.id,
    source: MICROSOFT,
    type: 'grant.connected',
    payload: { accountId: oid, subject },
    orderingKey: `microsoft/${oid}`,
  });
  if (!enqueued.ok) {
    logger.error('Could not enqueue microsoft/grant.connected; sweep will bootstrap', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      error: enqueued.err.message ?? 'unknown',
    });
  }

  logger.info('Microsoft grant stored', {
    component: 'auth/oauth',
    tenantId: tenant.id,
    subject,
  });
  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: MICROSOFT,
  });
  return NextResponse.redirect(new URL(`/${tenant.slug}/connectors`, originResult.val));
}

/**
 * Complete the OAuth flow for Zoom: Basic-auth code exchange, identity from
 * GET /users/me. Zoom's consent screen always covers the Marketplace app's
 * full scope set — the (possibly user-narrowed) request carried through the
 * pending row is what tool registration narrows by, so it is recorded as
 * requestedScopes even though Zoom never saw it.
 */
async function handleZoomCallback(
  request: NextRequest,
  tenant: { id: string; slug: string },
  subject: string | null,
  code: string,
  requestedScopes: string | null
): Promise<NextResponse> {
  if (!subject) {
    logger.error('Zoom pending flow has no subject; cannot assign grant owner', {
      component: 'auth/oauth',
      tenantId: tenant.id,
    });
    return NextResponse.json({ error: 'Sign in again before connecting Zoom' }, { status: 400 });
  }

  const originResult = await getOrigin(request);
  if (!originResult.ok) {
    return NextResponse.json({ error: 'Config error' }, { status: 500 });
  }
  const app = await getZoomApp(tenant.id, originResult.val);
  if (!app) {
    return NextResponse.json(
      { error: 'Zoom integration not configured for this organization' },
      { status: 503 }
    );
  }

  const basic = Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64');
  const tokenResponse = await fetch('https://zoom.us/oauth/token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: app.redirectUri,
    }),
  });
  if (!tokenResponse.ok) {
    const body = await tokenResponse.text().catch(() => '');
    logger.error('Zoom token exchange failed', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      status: tokenResponse.status,
      body: body.slice(0, 300),
    });
    return NextResponse.json({ error: 'Zoom token exchange failed' }, { status: 502 });
  }
  const tokenData: unknown = await tokenResponse.json().catch(() => null);
  const tokens = tokenData as Record<string, unknown> | null;
  const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token : null;
  if (!accessToken) {
    logger.error('Zoom token response carried no access_token', {
      component: 'auth/oauth',
      tenantId: tenant.id,
    });
    return NextResponse.json({ error: 'Malformed Zoom token response' }, { status: 502 });
  }
  const refreshToken = typeof tokens?.refresh_token === 'string' ? tokens.refresh_token : '';
  const expiresIn = typeof tokens?.expires_in === 'number' ? tokens.expires_in : 3600;
  const scopeEcho = typeof tokens?.scope === 'string' ? tokens.scope : null;

  // The minted token must be able to say who it belongs to. When the echo
  // says user:read:user was not granted, /users/me can only fail — say why
  // instead of letting the 400 speak for itself (a granular Marketplace app
  // without the scope, or one that dropped it from the build flow).
  if (scopeEcho && !scopeEcho.split(/[\s,]+/).includes('user:read:user')) {
    logger.error('Zoom token was minted without user:read:user; cannot identify grantor', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      scopeEcho,
    });
    // The echo names what WAS minted, which distinguishes the causes: an
    // empty/default set means the app ignored or lacks the requested
    // scopes; a near-complete set missing only this one means it is
    // marked Optional and was unchecked at consent.
    return NextResponse.json(
      {
        error: 'Could not identify Zoom user',
        error_description:
          'The minted token lacks the user:read:user scope. Add user:read:user to the ' +
          "Marketplace app's scopes (Scopes → Add Scopes, under the Users product) and keep " +
          'it Required, not Optional — then reconnect. The token actually carried: ' +
          `${scopeEcho || '(nothing)'}`,
      },
      { status: 502 }
    );
  }

  // Who granted this. The Zoom user id is the durable key — it is also what
  // webhook deliveries carry as host_id, which is how a transcript event
  // finds its way back to this grant.
  const meResponse = await fetch('https://api.zoom.us/v2/users/me', {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const meBodyText = await meResponse.text().catch(() => '');
  let meData: unknown = null;
  try {
    meData = JSON.parse(meBodyText);
  } catch {
    // handled below via zoomUserId null
  }
  const me = meData as Record<string, unknown> | null;
  const zoomUserId = typeof me?.id === 'string' ? me.id : null;
  if (!meResponse.ok || !zoomUserId) {
    // Zoom's error body names the missing scope (code 4711) — without it
    // this failure was undiagnosable from the log line alone.
    logger.error('Zoom /users/me failed; cannot identify grantor', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      status: meResponse.status,
      body: meBodyText.slice(0, 300),
      scopeEcho: scopeEcho ?? '(none echoed)',
    });
    const zoomMessage = typeof me?.message === 'string' ? me.message : null;
    return NextResponse.json(
      {
        error: 'Could not identify Zoom user',
        ...(zoomMessage ? { error_description: zoomMessage } : {}),
      },
      { status: 502 }
    );
  }
  const email = typeof me?.email === 'string' ? me.email : null;
  const displayName =
    typeof me?.display_name === 'string' && me.display_name
      ? me.display_name
      : [me?.first_name, me?.last_name].filter((part) => typeof part === 'string').join(' ') ||
        zoomUserId;

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    logger.error('TOKEN_ENCRYPTION_KEY missing or malformed; cannot store Zoom grant', {
      component: 'auth/oauth',
      tenantId: tenant.id,
    });
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const stored = await setGrant(
    ZOOM,
    tenant.id,
    {
      accountId: zoomUserId,
      clientId: app.clientId,
      displayName,
      accessToken,
      refreshToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      requestedScopes: (requestedScopes || app.scopes).split(' '),
      // Zoom access tokens carry no scope claim; the token-response echo is
      // the record of what the app was actually minted — always the full
      // Marketplace set, which is exactly why narrowing gates on requested.
      grantedScopes: scopesFromAccessToken(accessToken) ?? scopeEcho?.split(/\s+/) ?? null,
      metadata: { email, zoomAccountId: typeof me?.account_id === 'string' ? me.account_id : null },
      subject,
    },
    keyResult.val
  );
  if (!stored.ok) {
    logger.error('Failed to store Zoom grant', { component: 'auth/oauth', tenantId: tenant.id });
    return NextResponse.json({ error: 'Failed to store Zoom grant' }, { status: 500 });
  }

  logger.info('Zoom grant stored', { component: 'auth/oauth', tenantId: tenant.id, subject });
  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: ZOOM,
  });
  return NextResponse.redirect(new URL(`/${tenant.slug}/connectors`, originResult.val));
}

/**
 * Complete the OAuth flow for the second Atlassian app ("Renkei JSM": JSM +
 * Ops scopes on their own grant). Same token endpoint and callback as the
 * Jira app — a different client id, and a token that usually carries no Jira
 * scopes, so identity comes from the token claims and the site identity from
 * the claims/prior-grant fallbacks the ops-only experiment established.
 */
async function handleAtlassianJsmCallback(
  request: NextRequest,
  tenant: { id: string; slug: string },
  subject: string,
  code: string,
  requestedScopes: string | null
): Promise<NextResponse> {
  logger.debug('Atlassian JSM callback', { component: 'auth/oauth', tenantId: tenant.id });
  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database error' }, { status: 500 });
  const db = dbResult.val;

  const originResult = await getOrigin(request);
  if (!originResult.ok) return NextResponse.json({ error: 'Config error' }, { status: 500 });
  const app = await getAtlassianJsmApp(tenant.id, originResult.val);
  if (!app) {
    return NextResponse.json({ error: 'Atlassian JSM connector not configured' }, { status: 503 });
  }

  const tokenResponse = await fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
      redirect_uri: app.redirectUri,
    }),
  });
  const rawTokenBody = await tokenResponse.text().catch(() => '');
  let tokenData: unknown = null;
  try {
    tokenData = JSON.parse(rawTokenBody);
  } catch {
    // stays null — isJiraTokenResponse below fails on it, same as a real parse failure
  }
  if (!tokenResponse.ok || !isJiraTokenResponse(tokenData)) {
    logger.error('Atlassian JSM token exchange failed', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      status: tokenResponse.status,
      // No token material reaches a failed exchange's body — safe to log
      // verbatim, and this is exactly what a wrong client_secret needs to
      // diagnose instead of a bare status code.
      body: rawTokenBody.slice(0, 300),
    });
    return NextResponse.json({ error: 'Token exchange failed' }, { status: 502 });
  }

  // Site identity: a JSM/Ops-scoped token may surface no accessible
  // resources, so fall through the chain the ops-only experiment proved out —
  // the code JWT's site ARI, then any prior Atlassian grant in this tenant.
  let cloudId: string | null = null;
  try {
    const resources = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
    });
    const list: unknown = await resources.json().catch(() => null);
    if (isResourceArray(list) && list.length > 0) cloudId = list[0].id;
  } catch {
    // fall through to the claim/prior-grant chain
  }
  cloudId ??= cloudIdFromTokenClaims(code) ?? cloudIdFromTokenClaims(tokenData.access_token);
  if (!cloudId) {
    const prior = await db
      .selectFrom('provider_grants')
      .select('metadata')
      .where('tenant_id', '=', tenant.id)
      .where('provider', 'in', [ATLASSIAN, ATLASSIAN_JSM])
      .executeTakeFirst();
    if (prior && typeof prior.metadata === 'object' && prior.metadata !== null) {
      const meta = prior.metadata as Record<string, unknown>;
      if (typeof meta.cloudId === 'string' && meta.cloudId) cloudId = meta.cloudId;
    }
  }
  if (!cloudId) {
    logger.error('Atlassian JSM callback could not resolve a cloud id', {
      component: 'auth/oauth',
      tenantId: tenant.id,
    });
    return NextResponse.json({ error: 'No Jira site resolvable for this token' }, { status: 502 });
  }

  // The account id comes from the token claims — /myself is closed to a
  // token without Jira scopes. Display name borrows from the caller's Jira
  // grant when one exists (same human, same Atlassian account).
  const accountId = subFromTokenClaims(tokenData.access_token);
  if (!accountId) {
    return NextResponse.json({ error: 'Token carries no account identity' }, { status: 502 });
  }
  const jiraGrantRow = await db
    .selectFrom('provider_grants')
    .select('display_name')
    .where('tenant_id', '=', tenant.id)
    .where('provider', '=', ATLASSIAN)
    .where('subject', '=', subject)
    .executeTakeFirst();
  const displayName = jiraGrantRow?.display_name || accountId;

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const stored = await setGrant(
    ATLASSIAN_JSM,
    tenant.id,
    {
      accountId,
      clientId: app.clientId,
      displayName,
      subject,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || '',
      expiresAt: new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString(),
      requestedScopes: (requestedScopes || app.scopes).split(' '),
      grantedScopes:
        scopesFromAccessToken(tokenData.access_token) ??
        ((typeof tokenData.scope === 'string' && tokenData.scope.trim()) || null)?.split(/\s+/) ??
        null,
      metadata: { cloudId, siteUrl: '' },
    },
    keyResult.val
  );
  if (!stored.ok) {
    logger.error('Failed to store Atlassian JSM grant', {
      component: 'auth/oauth',
      tenantId: tenant.id,
    });
    return NextResponse.json({ error: 'Failed to store grant' }, { status: 500 });
  }

  logger.info('Atlassian JSM grant stored', {
    component: 'auth/oauth',
    tenantId: tenant.id,
    subject,
  });
  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: ATLASSIAN_JSM,
  });
  return NextResponse.redirect(new URL(`/${tenant.slug}/connectors`, originResult.val));
}

/**
 * The third Atlassian app ("Renkei Confluence"): Confluence's own product
 * API, a genuinely separate surface from Jira/JSM (not the same-site
 * shortcut JSM is), but the OAuth mechanics and cloud-id resolution chain
 * are identical — same auth.atlassian.com, same accessible-resources call,
 * same JWT-claim/prior-grant fallback (a tenant's Jira and Confluence
 * products normally live under the same Atlassian site/cloud id, so a
 * prior Jira/JSM grant's cloud id is still a valid fallback here).
 */
async function handleAtlassianConfluenceCallback(
  request: NextRequest,
  tenant: { id: string; slug: string },
  subject: string,
  code: string,
  requestedScopes: string | null
): Promise<NextResponse> {
  logger.debug('Atlassian Confluence callback', { component: 'auth/oauth', tenantId: tenant.id });
  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database error' }, { status: 500 });
  const db = dbResult.val;

  const originResult = await getOrigin(request);
  if (!originResult.ok) return NextResponse.json({ error: 'Config error' }, { status: 500 });
  const app = await getAtlassianConfluenceApp(tenant.id, originResult.val);
  if (!app) {
    return NextResponse.json(
      { error: 'Atlassian Confluence connector not configured' },
      { status: 503 }
    );
  }

  const tokenResponse = await fetch('https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'authorization_code',
      client_id: app.clientId,
      client_secret: app.clientSecret,
      code,
      redirect_uri: app.redirectUri,
    }),
  });
  const rawTokenBody = await tokenResponse.text().catch(() => '');
  let tokenData: unknown = null;
  try {
    tokenData = JSON.parse(rawTokenBody);
  } catch {
    // stays null — isJiraTokenResponse below fails on it, same as a real parse failure
  }
  if (!tokenResponse.ok || !isJiraTokenResponse(tokenData)) {
    logger.error('Atlassian Confluence token exchange failed', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      status: tokenResponse.status,
      // No token material reaches a failed exchange's body — safe to log
      // verbatim, and this is exactly what a wrong client_secret needs to
      // diagnose instead of a bare status code.
      body: rawTokenBody.slice(0, 300),
    });
    return NextResponse.json({ error: 'Token exchange failed' }, { status: 502 });
  }

  // Site identity: a Confluence-scoped token may surface no accessible
  // resources, so fall through the same chain JSM uses — the code JWT's
  // site ARI, then any prior Atlassian grant in this tenant (Jira,
  // JSM, or a previous Confluence connect).
  let cloudId: string | null = null;
  try {
    const resources = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
      headers: { Authorization: `Bearer ${tokenData.access_token}`, Accept: 'application/json' },
    });
    const list: unknown = await resources.json().catch(() => null);
    if (isResourceArray(list) && list.length > 0) cloudId = list[0].id;
  } catch {
    // fall through to the claim/prior-grant chain
  }
  cloudId ??= cloudIdFromTokenClaims(code) ?? cloudIdFromTokenClaims(tokenData.access_token);
  if (!cloudId) {
    const prior = await db
      .selectFrom('provider_grants')
      .select('metadata')
      .where('tenant_id', '=', tenant.id)
      .where('provider', 'in', [ATLASSIAN, ATLASSIAN_JSM, ATLASSIAN_CONFLUENCE])
      .executeTakeFirst();
    if (prior && typeof prior.metadata === 'object' && prior.metadata !== null) {
      const meta = prior.metadata as Record<string, unknown>;
      if (typeof meta.cloudId === 'string' && meta.cloudId) cloudId = meta.cloudId;
    }
  }
  if (!cloudId) {
    logger.error('Atlassian Confluence callback could not resolve a cloud id', {
      component: 'auth/oauth',
      tenantId: tenant.id,
    });
    return NextResponse.json(
      { error: 'No Confluence site resolvable for this token' },
      { status: 502 }
    );
  }

  // The account id comes from the token claims — /myself is closed to a
  // token without Jira scopes. Display name borrows from the caller's Jira
  // grant when one exists (same human, same Atlassian account).
  const accountId = subFromTokenClaims(tokenData.access_token);
  if (!accountId) {
    return NextResponse.json({ error: 'Token carries no account identity' }, { status: 502 });
  }
  const jiraGrantRow = await db
    .selectFrom('provider_grants')
    .select('display_name')
    .where('tenant_id', '=', tenant.id)
    .where('provider', '=', ATLASSIAN)
    .where('subject', '=', subject)
    .executeTakeFirst();
  const displayName = jiraGrantRow?.display_name || accountId;

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const stored = await setGrant(
    ATLASSIAN_CONFLUENCE,
    tenant.id,
    {
      accountId,
      clientId: app.clientId,
      displayName,
      subject,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || '',
      expiresAt: new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString(),
      requestedScopes: (requestedScopes || app.scopes).split(' '),
      grantedScopes:
        scopesFromAccessToken(tokenData.access_token) ??
        ((typeof tokenData.scope === 'string' && tokenData.scope.trim()) || null)?.split(/\s+/) ??
        null,
      metadata: { cloudId, siteUrl: '' },
    },
    keyResult.val
  );
  if (!stored.ok) {
    logger.error('Failed to store Atlassian Confluence grant', {
      component: 'auth/oauth',
      tenantId: tenant.id,
    });
    return NextResponse.json({ error: 'Failed to store grant' }, { status: 500 });
  }

  logger.info('Atlassian Confluence grant stored', {
    component: 'auth/oauth',
    tenantId: tenant.id,
    subject,
  });
  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: ATLASSIAN_CONFLUENCE,
  });
  return NextResponse.redirect(new URL(`/${tenant.slug}/connectors`, originResult.val));
}

/** The granted-scope list from a Bitbucket token response, either spelling. */
function grantedScopesOf(tokenData: Record<string, unknown>): string[] | null {
  const raw =
    (typeof tokenData.scopes === 'string' && tokenData.scopes.trim()) ||
    (typeof tokenData.scope === 'string' && tokenData.scope.trim()) ||
    '';
  return raw ? raw.split(/\s+/) : null;
}

/**
 * Complete a Bitbucket connect — the fourth Atlassian app, on Bitbucket's
 * own OAuth system rather than the 3LO platform. The token endpoint wants
 * HTTP Basic app auth and a form body (Zoom-style), and its response
 * carries the granted scopes as a plain `scopes` string — the consumer's
 * fixed set, which is what the tool gate intersects the user's requested
 * narrowing with. Identity comes from GET /2.0/user (the always-requested
 * `account` scope exists exactly for this call).
 */
async function handleAtlassianBitbucketCallback(
  request: NextRequest,
  tenant: { id: string; slug: string },
  subject: string,
  code: string,
  requestedScopes: string | null
): Promise<NextResponse> {
  logger.debug('Bitbucket callback', { component: 'auth/oauth', tenantId: tenant.id });

  const originResult = await getOrigin(request);
  if (!originResult.ok) return NextResponse.json({ error: 'Config error' }, { status: 500 });
  const app = await getAtlassianBitbucketApp(tenant.id, originResult.val);
  if (!app) {
    return NextResponse.json({ error: 'Bitbucket connector not configured' }, { status: 503 });
  }

  const tokenResponse = await fetch('https://bitbucket.org/site/oauth2/access_token', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code }),
  });
  const rawTokenBody = await tokenResponse.text().catch(() => '');
  let tokenData: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(rawTokenBody);
    if (typeof parsed === 'object' && parsed !== null) {
      tokenData = parsed as Record<string, unknown>;
    }
  } catch {
    // stays empty — the access_token check below fails on it
  }
  const accessToken = typeof tokenData.access_token === 'string' ? tokenData.access_token : '';
  if (!tokenResponse.ok || !accessToken) {
    logger.error('Bitbucket token exchange failed', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      status: tokenResponse.status,
      // No token material reaches a failed exchange's body — safe to log
      // verbatim, and exactly what a wrong consumer secret needs to diagnose.
      body: rawTokenBody.slice(0, 300),
    });
    return NextResponse.json({ error: 'Token exchange failed' }, { status: 502 });
  }

  // Identity: Bitbucket tokens are opaque (no JWT claims to decode), so the
  // /2.0/user read is the only source. Its uuid is the durable account key;
  // the username is display material and rides in metadata.
  const userResponse = await fetch('https://api.bitbucket.org/2.0/user', {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
  });
  const userInfo: unknown = await userResponse.json().catch(() => null);
  const user =
    typeof userInfo === 'object' && userInfo !== null ? (userInfo as Record<string, unknown>) : {};
  const accountId = typeof user.uuid === 'string' ? user.uuid : '';
  if (!userResponse.ok || !accountId) {
    logger.error('Bitbucket identity read failed', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      status: userResponse.status,
    });
    return NextResponse.json({ error: 'Could not read the Bitbucket account' }, { status: 502 });
  }
  const username = typeof user.username === 'string' ? user.username : '';
  const displayName =
    (typeof user.display_name === 'string' && user.display_name) || username || accountId;

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const expiresIn = typeof tokenData.expires_in === 'number' ? tokenData.expires_in : 7200;
  const stored = await setGrant(
    ATLASSIAN_BITBUCKET,
    tenant.id,
    {
      accountId,
      clientId: app.clientId,
      displayName,
      subject,
      accessToken,
      refreshToken: typeof tokenData.refresh_token === 'string' ? tokenData.refresh_token : '',
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      requestedScopes: (requestedScopes || app.scopes).split(' '),
      // The consumer's fixed set, from the token response — Bitbucket cannot
      // narrow at consent, so this is always the full configured list.
      // Read under both spellings: Bitbucket documents `scopes`, RFC 6749
      // says `scope`, and a NULL here (observed in the field) quietly turns
      // the requested ∩ granted narrowing into bare-requested.
      grantedScopes: grantedScopesOf(tokenData),
      metadata: { username },
    },
    keyResult.val
  );
  if (!stored.ok) {
    logger.error('Failed to store Bitbucket grant', {
      component: 'auth/oauth',
      tenantId: tenant.id,
    });
    return NextResponse.json({ error: 'Failed to store grant' }, { status: 500 });
  }

  logger.info('Bitbucket grant stored', {
    component: 'auth/oauth',
    tenantId: tenant.id,
    subject,
  });
  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: ATLASSIAN_BITBUCKET,
  });
  return NextResponse.redirect(new URL(`/${tenant.slug}/connectors`, originResult.val));
}

/** Which of the two Hyland connectors handleOnBaseCallback is completing. */
interface OnBaseCallbackSpec {
  /** connector_configs key AND pending_oidc_signin.provider — same string. */
  connector: string;
  /** provider_grants.provider to store the resulting grant under. */
  grantProvider: string;
  /** For log/error prose: "OnBase" or "OnBase Administration". */
  label: string;
}

const ONBASE_SPEC: OnBaseCallbackSpec = { connector: 'onbase', grantProvider: ONBASE, label: 'OnBase' };
const ONBASE_ADMIN_SPEC: OnBaseCallbackSpec = {
  connector: 'onbase-admin',
  grantProvider: ONBASE_ADMIN,
  label: 'OnBase Administration',
};

/**
 * Complete an OnBase connect — either connector, per `spec`: 'onbase' (the
 * Document Management API) and 'onbase-admin' (the Administration API) are
 * separate Hyland OAuth clients (lib/onbase-app.ts's header), but the token
 * exchange and grant-storage logic is identical between them. The token
 * exchange runs through the OnBase worker — the customer's Hyland IdP
 * usually lives on a private network this process must not dial —
 * presenting the PKCE code_verifier the authorize step stored on the state
 * row. Identity comes from the id_token's `sub` claim, decoded locally: the
 * token arrived over TLS from the IdP's own token endpoint via our trusted
 * worker, which is exactly the case where the OIDC code flow needs no
 * signature check — and it works even when the IdP exposes no userinfo
 * endpoint.
 */
async function handleOnBaseCallback(
  request: NextRequest,
  tenant: { id: string; slug: string },
  subject: string | null,
  code: string,
  requestedScopes: string | null,
  codeVerifier: string | null,
  spec: OnBaseCallbackSpec
): Promise<NextResponse> {
  if (!subject) {
    logger.error('{label} pending flow has no subject; cannot assign grant owner', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      label: spec.label,
    });
    return NextResponse.json(
      { error: `Sign in again before connecting ${spec.label}` },
      { status: 400 }
    );
  }
  if (!codeVerifier) {
    // Every OnBase authorize stores one; a row without it is not ours.
    logger.error('{label} pending flow carries no code_verifier', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      label: spec.label,
    });
    return NextResponse.json({ error: `Start the ${spec.label} connect again` }, { status: 400 });
  }

  const originResult = await getOrigin(request);
  if (!originResult.ok) {
    return NextResponse.json({ error: 'Config error' }, { status: 500 });
  }
  const app = await getOnBaseApp(tenant.id, originResult.val, spec.connector);
  if (!app) {
    return NextResponse.json(
      { error: `${spec.label} integration not configured for this organization` },
      { status: 503 }
    );
  }

  const exchanged = await obExchangeCode({
    tenantId: tenant.id,
    connector: spec.connector,
    code,
    redirectUri: app.redirectUri,
    codeVerifier,
  });
  if (!exchanged.ok) {
    const failure = onbaseClientFailure(exchanged.err);
    logger.error('{label} token exchange failed: {message}', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      label: spec.label,
      message: failure.message,
    });
    return NextResponse.json(
      { error: `${spec.label} token exchange failed`, error_description: failure.message },
      { status: 502 }
    );
  }
  const tokens = exchanged.val;
  const refreshToken = typeof tokens.refresh_token === 'string' ? tokens.refresh_token : '';
  const expiresIn = typeof tokens.expires_in === 'number' ? tokens.expires_in : 3600;
  const scopeEcho = typeof tokens.scope === 'string' ? tokens.scope : null;

  const idClaims = typeof tokens.id_token === 'string' ? decodeJwtPayload(tokens.id_token) : null;
  const accountId = typeof idClaims?.sub === 'string' ? idClaims.sub : null;
  if (!accountId) {
    // Without a subject there is no durable key to store the grant under.
    logger.error('{label} id_token carried no sub claim; cannot identify grantor', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      label: spec.label,
      hadIdToken: typeof tokens.id_token === 'string',
    });
    return NextResponse.json(
      {
        error: `Could not identify ${spec.label} user`,
        error_description:
          "The IdP's token response carried no usable id_token. Ensure the client registered " +
          'for Renkei on the Hyland IdP allows the openid scope, then reconnect.',
      },
      { status: 502 }
    );
  }
  const displayName =
    (typeof idClaims?.name === 'string' && idClaims.name) ||
    (typeof idClaims?.preferred_username === 'string' && idClaims.preferred_username) ||
    accountId;

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) {
    logger.error('TOKEN_ENCRYPTION_KEY missing or malformed; cannot store {label} grant', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      label: spec.label,
    });
    return NextResponse.json({ error: 'Server misconfigured' }, { status: 500 });
  }

  const stored = await setGrant(
    spec.grantProvider,
    tenant.id,
    {
      accountId,
      clientId: app.clientId,
      displayName,
      accessToken: tokens.access_token,
      refreshToken,
      expiresAt: new Date(Date.now() + expiresIn * 1000).toISOString(),
      requestedScopes: (requestedScopes || `openid offline_access ${app.idpScopeName}`).split(' '),
      grantedScopes: scopesFromAccessToken(tokens.access_token) ?? scopeEcho?.split(/\s+/) ?? null,
      metadata: { issuer: app.idpIssuer },
      subject,
    },
    keyResult.val
  );
  if (!stored.ok) {
    logger.error('Failed to store {label} grant', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      label: spec.label,
    });
    return NextResponse.json({ error: `Failed to store ${spec.label} grant` }, { status: 500 });
  }

  // No refresh token means the connection dies with this access token —
  // an IdP-side setting (offline_access), worth a log line now instead of
  // a mystery disconnect later.
  if (!refreshToken) {
    logger.warn('{label} grant stored without a refresh token (offline_access not granted?)', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      label: spec.label,
      subject,
    });
  }

  logger.info('{label} grant stored', {
    component: 'auth/oauth',
    tenantId: tenant.id,
    label: spec.label,
    subject,
  });
  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: spec.grantProvider,
  });
  return NextResponse.redirect(new URL(`/${tenant.slug}/connectors`, originResult.val));
}
