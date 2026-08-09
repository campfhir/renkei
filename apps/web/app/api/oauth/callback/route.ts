/* eslint-disable @typescript-eslint/consistent-type-assertions */
import { NextRequest, NextResponse } from 'next/server';
import { getAtlassianApp } from '@/lib/atlassian-app';
import { getWebexUserApp } from '@/lib/webex-app';
import { getDatabase } from '@renkei/db';
import { setJiraGrant } from '@/lib/tenant-operations';
import {
  setGrant,
  scopesFromAccessToken,
  ATLASSIAN,
  ATLASSIAN_JSM,
  WEBEX_USER,
} from '@renkei/provider-grants';
import { getAtlassianJsmApp } from '@/lib/atlassian-app';
import { parseEncryptionKey } from '@renkei/crypto';
import { getOrigin } from '@/lib/get-origin';
import { logger } from '@/lib/logger';
import { cacheUserDisplayName } from '@/lib/mcp-tools/common';

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
      .select(['tenant_id', 'expires_at', 'subject', 'provider', 'scopes'])
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

    logger.info('Jira callback', { component: 'auth/oauth', tenantId: tenant.id });

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

    logger.info('Exchanging code for tokens', { component: 'auth/oauth', tenantId: tenant.id });

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
    logger.info('Token response OK', {
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

    logger.info('Fetching accessible resources', { component: 'auth/oauth', tenantId: tenant.id });
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
    logger.info('Resources received', { component: 'auth/oauth', tenantId: tenant.id, resources });
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
      logger.info('No accessible resources (jira-less scopes); using fallback site identity', {
        component: 'auth/oauth',
        tenantId: tenant.id,
        cloudId,
      });
    }

    logger.info('Fetching user info', {
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
      logger.info('User info received', { component: 'auth/oauth', tenantId: tenant.id, userInfo });
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
      logger.info('User identity from token claims (jira-less scopes)', {
        component: 'auth/oauth',
        tenantId: tenant.id,
        accountId,
      });
    }

    // Cache the displayName for logging
    cacheUserDisplayName(accountId, displayName);

    logger.info('Storing Jira grant', {
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
    // Back to the connectors page, which shows the fresh connection status.
    const originResult = await getOrigin(request);
    if (!originResult.ok) {
      return NextResponse.json({ error: 'Config error' }, { status: 500 });
    }
    const origin = originResult.val;
    const connectorsUrl = new URL(`/${tenant.slug}/connectors`, origin);
    logger.info('Redirecting', {
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
  logger.info('Atlassian JSM callback', { component: 'auth/oauth', tenantId: tenant.id });
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
  const tokenData: unknown = await tokenResponse.json().catch(() => null);
  if (!tokenResponse.ok || !isJiraTokenResponse(tokenData)) {
    logger.error('Atlassian JSM token exchange failed', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      status: tokenResponse.status,
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
  return NextResponse.redirect(new URL(`/${tenant.slug}/connectors`, originResult.val));
}
