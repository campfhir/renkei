/* eslint-disable @typescript-eslint/consistent-type-assertions */
import { NextRequest, NextResponse } from 'next/server';
import { getAtlassianApp } from '@/lib/atlassian-app';
import { getDatabase } from '@renkei/db';
import { setJiraGrant } from '@/lib/tenant-operations';
import { getOrigin } from '@/lib/get-origin';
import { logger } from '@/lib/logger';
import { cacheUserDisplayName } from '@/lib/mcp-tools/common';

interface JiraTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
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
    // Look up pending Jira authorization by state (single-use token)
    // The pending record tells us which tenant this authorization is for
    const pendingSignIn = await db
      .selectFrom('pending_oidc_signin')
      .select(['tenant_id', 'expires_at', 'subject'])
      .where('state', '=', state)
      .executeTakeFirst();

    if (!pendingSignIn) {
      return NextResponse.json({ error: 'Invalid or expired state' }, { status: 400 });
    }

    // The authorize step records who initiated the connect. A pending row without
    // one predates per-user grants; completing it would produce an unowned grant
    // that no caller can use, so send the user back through a fresh sign-in.
    if (!pendingSignIn.subject) {
      logger.error('[OAuth] Pending sign-in has no subject; cannot assign grant owner', {
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

    logger.info('[OAuth] Jira callback', { tenantId: tenant.id });

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

    logger.info('[OAuth] Exchanging code for tokens', { tenantId: tenant.id });

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
      logger.error('[OAuth] Token exchange failed', {
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
    logger.info('[OAuth] Token response OK', {
      tenantId: tenant.id,
      hasAccessToken: Boolean(tokenData.access_token),
      expiresIn: tokenData.expires_in,
    });
    if (!isJiraTokenResponse(tokenData)) {
      logger.error('[OAuth] Invalid token response format', { tenantId: tenant.id, tokenData });
      return NextResponse.json({ error: 'Invalid token response format' }, { status: 400 });
    }

    logger.info('[OAuth] Fetching accessible resources', { tenantId: tenant.id });
    // Get accessible resources first to determine site URL
    const resourcesResponse = await fetch(
      'https://api.atlassian.com/oauth/token/accessible-resources',
      {
        headers: { Authorization: `Bearer ${tokenData.access_token}` },
      }
    );

    if (!resourcesResponse.ok) {
      const resourcesErrorText = await resourcesResponse.text();
      logger.error('[OAuth] Failed to fetch resources', {
        tenantId: tenant.id,
        status: resourcesResponse.status,
        error: resourcesErrorText,
      });
      return NextResponse.json({ error: 'Failed to get accessible resources' }, { status: 400 });
    }

    const resources = await resourcesResponse.json();
    logger.info('[OAuth] Resources received', { tenantId: tenant.id, resources });
    if (!isResourceArray(resources)) {
      logger.error('[OAuth] Invalid resources format', { tenantId: tenant.id, resources });
      return NextResponse.json({ error: 'Invalid resources response format' }, { status: 400 });
    }

    // For MVP, use the first accessible resource (cloud ID)
    const resource = resources[0];
    if (!resource) {
      return NextResponse.json({ error: 'No Jira sites accessible' }, { status: 400 });
    }

    logger.info('[OAuth] Fetching user info', { tenantId: tenant.id, cloudId: resource.id });
    // Get user info via API gateway path for OAuth 2.0 3LO
    const userResponse = await fetch(
      `https://api.atlassian.com/ex/jira/${resource.id}/rest/api/3/myself`,
      {
        headers: {
          Authorization: `Bearer ${tokenData.access_token}`,
          Accept: 'application/json',
        },
      }
    );

    if (!userResponse.ok) {
      const userErrorText = await userResponse.text();
      const userErrorJson = await userResponse.json().catch(() => ({}));
      logger.error('[OAuth] Failed to fetch user info', {
        tenantId: tenant.id,
        status: userResponse.status,
        statusText: userResponse.statusText,
        errorText: userErrorText,
        errorJson: userErrorJson,
        url: `https://api.atlassian.com/ex/jira/${resource.id}/rest/api/3/myself`,
      });
      return NextResponse.json({ error: 'Failed to get user info' }, { status: 400 });
    }

    const userInfo = await userResponse.json();
    logger.info('[OAuth] User info received', { tenantId: tenant.id, userInfo });
    if (!isJiraUserInfo(userInfo)) {
      logger.error('[OAuth] Invalid user info response format', { tenantId: tenant.id, userInfo });
      return NextResponse.json(
        {
          error: 'Invalid user info response format',
          details: `Expected account_id, got: ${JSON.stringify(userInfo)}`,
        },
        { status: 400 }
      );
    }

    // Extract display name from any of several possible field names
    const displayName = userInfo.displayName || userInfo.name || userInfo.accountId;

    // Cache the displayName for logging
    cacheUserDisplayName(userInfo.accountId, displayName);

    logger.info('[OAuth] Storing Jira grant', {
      tenantId: tenant.id,
      subject: pendingSignIn.subject,
    });
    // Store encrypted Jira grant
    await setJiraGrant(tenant.id, {
      subject: pendingSignIn.subject,
      accountId: userInfo.accountId,
      atlassianClientId: atlassianApp.clientId,
      cloudId: resource.id,
      siteUrl: resource.url,
      displayName,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || '',
      expiresAt: new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString(),
      scopes: ['read:jira-work', 'write:jira-work', 'read:jira-user'],
    });

    logger.info('[OAuth] Jira grant stored successfully', { tenantId: tenant.id });
    // Redirect back to MCP endpoint page to show updated Jira connection status
    const originResult = await getOrigin(request);
    if (!originResult.ok) {
      return NextResponse.json({ error: 'Config error' }, { status: 500 });
    }
    const origin = originResult.val;
    const mcpUrl = new URL(`/mcp/${tenant.id}`, origin);
    logger.info('[OAuth] Redirecting', { tenantId: tenant.id, url: mcpUrl.toString() });
    return NextResponse.redirect(mcpUrl);
  } catch (err) {
    logger.error('[OAuth] Callback error', {
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    return NextResponse.json({ error: 'Authentication failed' }, { status: 500 });
  }
}
