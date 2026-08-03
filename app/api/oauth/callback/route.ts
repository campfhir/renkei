import { NextRequest, NextResponse } from 'next/server';
import { getConfig } from '@/lib/env';
import { getDatabase } from '@/lib/db';
import { setJiraGrant } from '@/lib/tenant-operations';
import { randomUUID } from 'crypto';

interface JiraTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

interface JiraUserInfo {
  account_id: string;
  display_name: string;
}

export async function GET(request: NextRequest) {
  const config = getConfig();
  const db = getDatabase();
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
      .select(['tenant_id', 'expires_at'])
      .where('state', '=', state)
      .executeTakeFirst();

    if (!pendingSignIn) {
      return NextResponse.json(
        { error: 'Invalid or expired state' },
        { status: 400 }
      );
    }

    // Delete pending record (single-use) to prevent replay attacks
    await db
      .deleteFrom('pending_oidc_signin')
      .where('state', '=', state)
      .execute();

    // Verify state is not expired
    const stateExpiresAt = new Date(pendingSignIn.expires_at);
    if (stateExpiresAt < new Date()) {
      return NextResponse.json(
        { error: 'State expired' },
        { status: 400 }
      );
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

    console.log(`[MCP ${tenant.id}] Jira OAuth callback`);

    // Exchange authorization code for Jira tokens
    const tokenResponse = await fetch('https://auth.atlassian.com/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        client_id: config.ATLASSIAN_CLIENT_ID,
        client_secret: config.ATLASSIAN_CLIENT_SECRET,
        code,
        redirect_uri: config.ATLASSIAN_REDIRECT_URI,
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      console.error('Jira token exchange failed:', errorText);
      return NextResponse.json(
        { error: 'Failed to exchange authorization code' },
        { status: 400 }
      );
    }

    const tokenData = (await tokenResponse.json()) as JiraTokenResponse;

    // Get user info from Jira
    const userResponse = await fetch('https://api.atlassian.com/me', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!userResponse.ok) {
      console.error('Failed to fetch user info from Jira');
      return NextResponse.json({ error: 'Failed to get user info' }, { status: 400 });
    }

    const userInfo = (await userResponse.json()) as JiraUserInfo;

    // Get accessible resources (cloud IDs) to find the site
    const resourcesResponse = await fetch('https://api.atlassian.com/oauth/token/accessible-resources', {
      headers: { Authorization: `Bearer ${tokenData.access_token}` },
    });

    if (!resourcesResponse.ok) {
      console.error('Failed to fetch accessible resources');
      return NextResponse.json(
        { error: 'Failed to get accessible resources' },
        { status: 400 }
      );
    }

    const resources = (await resourcesResponse.json()) as Array<{
      id: string;
      url: string;
      name: string;
    }>;

    // For MVP, use the first accessible resource (cloud ID)
    const resource = resources[0];
    if (!resource) {
      return NextResponse.json(
        { error: 'No Jira sites accessible' },
        { status: 400 }
      );
    }

    // Store encrypted Jira grant
    await setJiraGrant(tenant.id, {
      accountId: userInfo.account_id,
      atlassianClientId: config.ATLASSIAN_CLIENT_ID,
      cloudId: resource.id,
      siteUrl: resource.url,
      displayName: userInfo.display_name,
      accessToken: tokenData.access_token,
      refreshToken: tokenData.refresh_token || '',
      expiresAt: new Date(Date.now() + (tokenData.expires_in || 3600) * 1000).toISOString(),
      scopes: ['read:jira-work', 'write:jira-work', 'read:jira-user'],
    });

    // Redirect back to MCP endpoint dashboard
    return NextResponse.redirect(new URL(`/mcp/${tenant.id}`, request.url));
  } catch (err) {
    console.error('OAuth callback error:', err);
    return NextResponse.json({ error: 'Authentication failed' }, { status: 500 });
  }
}

