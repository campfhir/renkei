/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * The shared OAuth callback for every connector. No token passes through
 * this process (docs/delegate-key-design.md, "Phase 1 as built"): the code
 * is exchanged by the delegate (`oauth/exchange`), which keeps the tokens
 * behind a ten-minute handle; the identity calls a connect needs next ride
 * that handle (`grantFetch({ pending })`); and `grant/commit` seals the
 * tokens as the person's grant. What this route decides is WHO authorized
 * and what to record about them — the delegate decides nothing about
 * identity and never answers a token.
 *
 * The delegate also decodes the granted scopes from the minted token's own
 * claims at commit time (Atlassian and Graph tokens carry them; WebEx,
 * Zoom, GitHub, Bitbucket and OnBase tokens are opaque and record null —
 * unknown, honestly), so nothing here assumes granted equals requested.
 */
import { NextRequest, NextResponse } from 'next/server';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import {
  getAtlassianApp,
  getAtlassianJsmApp,
  getAtlassianConfluenceApp,
  getAtlassianBitbucketApp,
  getAtlassianAdminApp,
} from '@/lib/atlassian-app';
import { getWebexUserApp } from '@/lib/webex-app';
import { getMicrosoftApp, type MicrosoftApp } from '@/lib/microsoft-app';
import { getEntraDeveloperApp } from '@/lib/entra-developer-app';
import { getZoomApp } from '@/lib/zoom-app';
import { getDatabase } from '@renkei/db';
import { webhookEventsQueue } from '@renkei/queue';
import {
  ATLASSIAN,
  ATLASSIAN_JSM,
  ATLASSIAN_CONFLUENCE,
  ATLASSIAN_BITBUCKET,
  ATLASSIAN_ADMIN,
  WEBEX_USER,
  MICROSOFT,
  ENTRA_DEVELOPER,
  ZOOM,
  ONBASE,
  ONBASE_ADMIN,
  GITHUB,
} from '@renkei/provider-grants';
import {
  delegateGrants,
  grantFetch,
  type AuthedFetch,
  type ExchangeOutcome,
  type GrantOpError,
} from '@renkei/delegate-client';
import { getGitHubApp } from '@/lib/github-app';
import { getOnBaseApp } from '@/lib/onbase-app';
import { getOrigin } from '@/lib/get-origin';
import { getSessionFromRequest } from '@/lib/session';
import { clearConnectFlow, isConnectFlowBound } from '@/lib/connect-flow-binding';
import { logger } from '@/lib/logger';
import { cacheUserDisplayName } from '@/lib/mcp-tools/common';
import { invalidateToolCatalogCache } from '@/lib/mcp-tools/tool-catalog';
import { recordAuditEvent } from '@/lib/audit-events';

interface JiraUserInfo {
  accountId: string;
  displayName?: string;
  name?: string;
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

/**
 * The Atlassian account id from the AUTHORIZATION CODE's sub claim. The
 * code is itself a JWT; with the access token out of reach (it lives in
 * the delegate), the code's claims are the identity hint a token without
 * Jira scopes — one /myself is closed to — can still offer.
 */
function subFromCodeClaims(code: string): string | null {
  const claims = decodeJwtPayload(code);
  return typeof claims?.sub === 'string' && claims.sub ? claims.sub : null;
}

/**
 * The Jira site's cloud id from the authorization code's resource ARIs
 * (ari:cloud:jira::site/{cloudId}) — the fallback when accessible-resources
 * has nothing to say because the token carries no Jira scopes.
 */
function cloudIdFromCodeClaims(code: string): string | null {
  const claims = decodeJwtPayload(code);
  const resources = claims?.['https://id.atlassian.com/resource'];
  if (!Array.isArray(resources)) return null;
  for (const entry of resources) {
    if (typeof entry !== 'string') continue;
    const match = /^ari:cloud:jira::site\/(.+)$/.exec(entry);
    if (match) return match[1];
  }
  return null;
}

interface AtlassianResource {
  id: string;
  url: string;
  name: string;
}

function isResourceArray(data: unknown): data is AtlassianResource[] {
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

/** A response body as a record, or null when it is not JSON or not an object. */
async function jsonRecord(response: Response): Promise<Record<string, unknown> | null> {
  const parsed: unknown = await response.json().catch(() => null);
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** A pending-token request that failed to send reads as a 502 with an empty body. */
async function pendingGet(
  pending: AuthedFetch,
  url: string,
  headers: Record<string, string> = {}
): Promise<Response> {
  try {
    return await pending(url, { headers: { Accept: 'application/json', ...headers } });
  } catch (error) {
    logger.warn('Identity lookup through the delegate failed: {detail}', {
      component: 'oauth-callback',
      detail: error instanceof Error ? error.message : String(error),
    });
    return new Response('identity lookup failed', { status: 502 });
  }
}

/** The delegate could not exchange the code: logged, and phrased for the browser. */
function exchangeFailed(
  label: string,
  tenantId: string,
  error: { type: GrantOpError; message?: string }
): NextResponse {
  logger.error('{label} token exchange failed: {reason}', {
    component: 'auth/oauth',
    tenantId,
    label,
    reason: error.type,
    // The delegate relays the provider's own error_description — no token
    // material reaches a failed exchange's body, and this is exactly what a
    // wrong client secret needs to diagnose instead of a bare tag.
    detail: error.message,
  });
  const unconfigured = error.type === 'NOT_CONFIGURED' || error.type === 'DELEGATE_UNCONFIGURED';
  return NextResponse.json(
    {
      error: `${label} token exchange failed`,
      ...(error.message ? { error_description: error.message } : {}),
    },
    { status: unconfigured ? 503 : 502 }
  );
}

/** The delegate could not seal the grant (the handle expired, or the row would not store). */
function storeFailed(
  label: string,
  tenantId: string,
  error: { type: GrantOpError; message?: string }
): NextResponse {
  logger.error('Failed to store {label} grant: {reason}', {
    component: 'auth/oauth',
    tenantId,
    label,
    reason: error.type,
    detail: error.message,
  });
  return NextResponse.json({ error: `Failed to store ${label} grant` }, { status: 500 });
}

function logExchanged(label: string, tenantId: string, outcome: ExchangeOutcome): void {
  // Only whether tokens came back, never any of their bytes: these records
  // are persisted by the Postgres log adapter and are readable over HTTP by
  // tenant users — and the bytes are in the delegate anyway.
  logger.debug('{label} token exchange OK', {
    component: 'auth/oauth',
    tenantId,
    label,
    expiresAt: outcome.expiresAt,
    hasRefreshToken: outcome.hasRefreshToken,
  });
}

/**
 * The browser binding (lib/connect-flow-binding.ts) is checked inside; this
 * wrapper exists so the binding cookie is cleared on EVERY response once the
 * state has named its tenant — success, refusal, or a provider handler's
 * own error — without threading the cookie through each provider branch.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const flow: { tenantId: string | null } = { tenantId: null };
  const response = await handleCallback(request, flow);
  return flow.tenantId ? clearConnectFlow(response, flow.tenantId) : response;
}

async function handleCallback(
  request: NextRequest,
  flow: { tenantId: string | null }
): Promise<NextResponse> {
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
    flow.tenantId = pendingSignIn.tenant_id;

    // CSRF / grant-planting defense (lib/connect-flow-binding.ts): the state
    // must match the cookie the authorize route set in THIS browser, and the
    // browser must hold a session for the SAME subject the pending row
    // recorded. A callback URL captured from one browser and replayed into
    // another carries neither, so it is refused — and the state is consumed
    // either way, so it cannot be retried with a different browser.
    if (!isConnectFlowBound(request, pendingSignIn.tenant_id, state)) {
      await db.deleteFrom('pending_oidc_signin').where('state', '=', state).execute();
      logger.warn('Connect flow state cookie missing or mismatched; rejecting callback', {
        component: 'auth/oauth',
        tenantId: pendingSignIn.tenant_id,
        provider: pendingSignIn.provider ?? 'atlassian',
      });
      return NextResponse.json({ error: 'Invalid state' }, { status: 400 });
    }
    const session = await getSessionFromRequest(request, pendingSignIn.tenant_id);
    if (!session || !pendingSignIn.subject || session.subject !== pendingSignIn.subject) {
      await db.deleteFrom('pending_oidc_signin').where('state', '=', state).execute();
      logger.warn('Connect flow completed by a different session than started it; rejecting', {
        component: 'auth/oauth',
        tenantId: pendingSignIn.tenant_id,
        provider: pendingSignIn.provider ?? 'atlassian',
        signedIn: Boolean(session),
      });
      return NextResponse.json(
        { error: 'Sign in as the person who started this connection, then try again' },
        { status: 403 }
      );
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
    if (pendingSignIn.provider === 'atlassian-admin') {
      return handleAtlassianAdminCallback(
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
    if (pendingSignIn.provider === 'github') {
      return handleGitHubCallback(
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
    if (pendingSignIn.provider === 'entra-developer') {
      // A SEPARATE Entra app registration from 'microsoft' above — see
      // lib/entra-developer-app.ts — so it rides the same token exchange
      // with a different app, grant provider and label, and none of the
      // Microsoft 365 grant's indexing bootstrap.
      return handleEntraDeveloperCallback(
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

    // The org's Atlassian app registration, from connector config: the
    // redirect URI the authorize step used (the exchange must present the
    // same one), the client id the grant records, and the default scopes.
    // The client secret stays in the delegate's reading of the same config.
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
    const connect = await exchangeAtlassianCode(
      'Jira',
      tenant.id,
      ATLASSIAN,
      code,
      atlassianApp.redirectUri
    );
    if (connect instanceof NextResponse) return connect;
    const { handle, pending, resources } = connect;

    // Use the first accessible resource for the site identity. A token with
    // no Jira scopes (an ops-only or otherwise narrowed grant) surfaces no
    // resources here, and /myself is equally closed to it — for that shape,
    // identity comes from the authorization code's own claims and the site
    // from the caller's previous grant.
    const resource = resources[0] ?? null;
    let cloudId = resource?.id ?? '';
    let siteUrl = resource?.url ?? '';
    if (!resource) {
      // The AUTHORIZATION CODE is itself a JWT and reliably carries the
      // site's ARI — the primary fallback. Disconnect-then-reconnect deletes
      // the caller's own prior grant, so the tenant's other grants stand in
      // for the siteUrl: one org, one site, in practice.
      cloudId = cloudIdFromCodeClaims(code) ?? '';

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
        logger.error('No accessible resources, no site ARI in code claims, no prior grant', {
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
    // Get user info via API gateway path for OAuth 2.0 3LO, on the pending token.
    let identity = await atlassianMyself(pending, cloudId);
    if (identity) {
      logger.debug('User info received', {
        component: 'auth/oauth',
        tenantId: tenant.id,
        accountId: identity.accountId,
      });
    } else {
      // /myself is a Jira-scoped endpoint; a jira-less token cannot call it.
      // The authorization code's sub claim is the Atlassian account id, and
      // the caller's existing grant the fallback behind that.
      const accountId = await atlassianAccountIdOffline(db, tenant.id, pendingSignIn.subject, code);
      if (!accountId) {
        logger.error('Failed to fetch user info and no identity hint in code claims or grants', {
          component: 'auth/oauth',
          tenantId: tenant.id,
        });
        return NextResponse.json({ error: 'Failed to get user info' }, { status: 400 });
      }
      const priorName = await db
        .selectFrom('provider_grants')
        .select('display_name')
        .where('tenant_id', '=', tenant.id)
        .where('provider', '=', 'atlassian')
        .where('provider_account_id', '=', accountId)
        .executeTakeFirst();
      identity = { accountId, displayName: priorName?.display_name || null };
      logger.debug('User identity from code claims (jira-less scopes)', {
        component: 'auth/oauth',
        tenantId: tenant.id,
        accountId,
      });
    }
    const accountId = identity.accountId;
    const displayName = identity.displayName || accountId;

    // Cache the displayName for logging
    cacheUserDisplayName(accountId, displayName);

    logger.debug('Storing Jira grant', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      subject: pendingSignIn.subject,
    });
    // Seal the grant: the delegate stores the tokens it holds behind the
    // handle, with the identity and site decided here. Site identity is
    // Atlassian-specific, so it lives in metadata rather than as columns
    // every other provider would leave NULL.
    const stored = await delegateGrants().commit({
      tenantId: tenant.id,
      provider: ATLASSIAN,
      handle,
      subject: pendingSignIn.subject,
      accountId,
      displayName,
      clientId: atlassianApp.clientId,
      // Provenance kept separate on purpose: requested is what the (possibly
      // user-narrowed) authorize step asked for; granted is decoded by the
      // delegate from the minted token's own claims — the credential
      // Atlassian's gateway actually evaluates.
      requestedScopes: (pendingSignIn.scopes || atlassianApp.scopes).split(' '),
      metadata: { cloudId, siteUrl },
    });
    if (!stored.ok) return storeFailed('Jira', tenant.id, stored.err);

    logger.info('Jira grant stored successfully', { component: 'auth/oauth', tenantId: tenant.id });
    recordAuditEvent({
      tenantId: tenant.id,
      actorSubject: pendingSignIn.subject,
      action: 'connector.connected',
      targetKind: 'connector',
      targetLabel: 'atlassian',
    });
    invalidateToolCatalogCache(tenant.id, pendingSignIn.subject);
    // Back to the connectors page, which shows the fresh connection status.
    const connectorsUrl = new URL(`/${tenant.slug}/connectors`, appOriginResult.val);
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

/* ------------------------------ Atlassian ------------------------------ */

/** What an Atlassian code becomes: the handle, a fetcher on it, and the sites it sees. */
interface AtlassianConnect {
  handle: string;
  pending: AuthedFetch;
  /** accessible-resources — empty when the token carries no Jira scopes. */
  resources: AtlassianResource[];
}

/**
 * Exchange an Atlassian authorization code at the delegate and list the
 * sites the minted token reaches. Shared by all four 3LO apps (Jira, JSM,
 * Confluence, Jira Admin): same token endpoint, a different client per
 * provider, which the delegate reads from that provider's connector
 * config. A NextResponse is the failure already phrased for the browser.
 */
async function exchangeAtlassianCode(
  label: string,
  tenantId: string,
  provider: string,
  code: string,
  redirectUri: string
): Promise<AtlassianConnect | NextResponse> {
  const exchanged = await delegateGrants().exchange({
    tenantId,
    provider,
    form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri },
  });
  if (!exchanged.ok) return exchangeFailed(label, tenantId, exchanged.err);
  logExchanged(label, tenantId, exchanged.val);
  const handle = exchanged.val.handle;
  const pending = grantFetch({ tenantId, provider, pending: handle });

  logger.debug('Fetching accessible resources', { component: 'auth/oauth', tenantId });
  const response = await pendingGet(
    pending,
    'https://api.atlassian.com/oauth/token/accessible-resources'
  );
  const list: unknown = response.ok ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    // A token with no Jira scopes is refused here; the fallbacks below
    // (code claims, prior grants) take over, so this is a debug line.
    logger.debug('accessible-resources not readable on this token', {
      component: 'auth/oauth',
      tenantId,
      status: response.status,
    });
  }
  const resources = isResourceArray(list) ? list : [];
  logger.debug('Resources received', {
    component: 'auth/oauth',
    tenantId,
    resources: resources.map((resource) => ({ id: resource.id, url: resource.url })),
  });
  return { handle, pending, resources };
}

interface AtlassianIdentity {
  accountId: string;
  displayName: string | null;
}

/** /myself on the pending token: the real account id and name, when the token carries Jira scopes. */
async function atlassianMyself(
  pending: AuthedFetch,
  cloudId: string
): Promise<AtlassianIdentity | null> {
  const response = await pendingGet(
    pending,
    `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`
  );
  if (!response.ok) return null;
  const me: unknown = await response.json().catch(() => null);
  if (!isJiraUserInfo(me)) return null;
  return { accountId: me.accountId, displayName: me.displayName || me.name || null };
}

/**
 * The Atlassian account id without a Jira call, for a token /myself is
 * closed to: the authorization code's sub claim, else the account id on
 * the caller's existing Atlassian grant of any flavor — same human, same
 * Atlassian account across Jira, JSM, Confluence and Jira Admin.
 */
async function atlassianAccountIdOffline(
  db: Kysely<DB>,
  tenantId: string,
  subject: string,
  code: string
): Promise<string | null> {
  const fromCode = subFromCodeClaims(code);
  if (fromCode) return fromCode;
  const prior = await db
    .selectFrom('provider_grants')
    .select('provider_account_id')
    .where('tenant_id', '=', tenantId)
    .where('provider', 'in', [ATLASSIAN, ATLASSIAN_JSM, ATLASSIAN_CONFLUENCE, ATLASSIAN_ADMIN])
    .where('subject', '=', subject)
    .orderBy('updated_at', 'desc')
    .executeTakeFirst();
  return prior?.provider_account_id ?? null;
}

/** The caller's Jira grant row, whose display name and site a sibling connect borrows. */
async function callerJiraGrant(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<{ display_name: string; metadata: unknown } | undefined> {
  return db
    .selectFrom('provider_grants')
    .select(['display_name', 'metadata'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', ATLASSIAN)
    .where('subject', '=', subject)
    .executeTakeFirst();
}

/** The cloud id recorded on any prior grant of the given Atlassian providers in this tenant. */
async function priorCloudId(
  db: Kysely<DB>,
  tenantId: string,
  providers: string[]
): Promise<string | null> {
  const prior = await db
    .selectFrom('provider_grants')
    .select('metadata')
    .where('tenant_id', '=', tenantId)
    .where('provider', 'in', providers)
    .executeTakeFirst();
  if (prior && typeof prior.metadata === 'object' && prior.metadata !== null) {
    const meta = prior.metadata as Record<string, unknown>;
    if (typeof meta.cloudId === 'string' && meta.cloudId) return meta.cloudId;
  }
  return null;
}

/**
 * Complete the OAuth flow for the second Atlassian app ("Renkei JSM": JSM +
 * Ops scopes on their own grant). Same token endpoint and callback as the
 * Jira app — a different client id, and a token that usually carries no Jira
 * scopes, so identity comes from the code's claims and the site identity from
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

  const connect = await exchangeAtlassianCode(
    'Atlassian JSM',
    tenant.id,
    ATLASSIAN_JSM,
    code,
    app.redirectUri
  );
  if (connect instanceof NextResponse) return connect;
  const { handle, pending, resources } = connect;

  // Site identity: a JSM/Ops-scoped token may surface no accessible
  // resources, so fall through the chain the ops-only experiment proved out —
  // the code JWT's site ARI, then any prior Atlassian grant in this tenant.
  const cloudId =
    resources[0]?.id ??
    cloudIdFromCodeClaims(code) ??
    (await priorCloudId(db, tenant.id, [ATLASSIAN, ATLASSIAN_JSM]));
  if (!cloudId) {
    logger.error('Atlassian JSM callback could not resolve a cloud id', {
      component: 'auth/oauth',
      tenantId: tenant.id,
    });
    return NextResponse.json({ error: 'No Jira site resolvable for this token' }, { status: 502 });
  }

  // The account id comes from the code's claims — /myself is closed to a
  // token without Jira scopes — with the token's own answer as the last
  // resort. Display name borrows from the caller's Jira grant when one
  // exists (same human, same Atlassian account).
  const accountId =
    (await atlassianAccountIdOffline(db, tenant.id, subject, code)) ??
    (await atlassianMyself(pending, cloudId))?.accountId;
  if (!accountId) {
    return NextResponse.json({ error: 'Token carries no account identity' }, { status: 502 });
  }
  const jiraGrantRow = await callerJiraGrant(db, tenant.id, subject);
  const displayName = jiraGrantRow?.display_name || accountId;

  const stored = await delegateGrants().commit({
    tenantId: tenant.id,
    provider: ATLASSIAN_JSM,
    handle,
    subject,
    accountId,
    displayName,
    clientId: app.clientId,
    requestedScopes: (requestedScopes || app.scopes).split(' '),
    metadata: { cloudId, siteUrl: '' },
  });
  if (!stored.ok) return storeFailed('Atlassian JSM', tenant.id, stored.err);

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
  invalidateToolCatalogCache(tenant.id, subject);
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

  const connect = await exchangeAtlassianCode(
    'Atlassian Confluence',
    tenant.id,
    ATLASSIAN_CONFLUENCE,
    code,
    app.redirectUri
  );
  if (connect instanceof NextResponse) return connect;
  const { handle, pending, resources } = connect;

  // Site identity: a Confluence-scoped token may surface no accessible
  // resources, so fall through the same chain JSM uses — the code JWT's
  // site ARI, then any prior Atlassian grant in this tenant (Jira,
  // JSM, or a previous Confluence connect).
  const cloudId =
    resources[0]?.id ??
    cloudIdFromCodeClaims(code) ??
    (await priorCloudId(db, tenant.id, [ATLASSIAN, ATLASSIAN_JSM, ATLASSIAN_CONFLUENCE]));
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

  // The account id comes from the code's claims — /myself is closed to a
  // token without Jira scopes — with the token's own answer as the last
  // resort. Display name borrows from the caller's Jira grant when one
  // exists (same human, same Atlassian account).
  const accountId =
    (await atlassianAccountIdOffline(db, tenant.id, subject, code)) ??
    (await atlassianMyself(pending, cloudId))?.accountId;
  if (!accountId) {
    return NextResponse.json({ error: 'Token carries no account identity' }, { status: 502 });
  }
  const jiraGrantRow = await callerJiraGrant(db, tenant.id, subject);
  const displayName = jiraGrantRow?.display_name || accountId;

  const stored = await delegateGrants().commit({
    tenantId: tenant.id,
    provider: ATLASSIAN_CONFLUENCE,
    handle,
    subject,
    accountId,
    displayName,
    clientId: app.clientId,
    requestedScopes: (requestedScopes || app.scopes).split(' '),
    metadata: { cloudId, siteUrl: '' },
  });
  if (!stored.ok) return storeFailed('Atlassian Confluence', tenant.id, stored.err);

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
  invalidateToolCatalogCache(tenant.id, subject);
  return NextResponse.redirect(new URL(`/${tenant.slug}/connectors`, originResult.val));
}

/**
 * The fifth Atlassian app ("Renkei Jira Admin"): Jira administration with
 * classic scopes. Same token endpoint and fallback chain as Confluence, with
 * two differences that matter for an admin grant:
 *
 * - The SITE is chosen, not taken first. accessible-resources lists every
 *   site the person reaches; when their Jira grant names one of them, this
 *   grant targets the same site, so admin changes never land on a different
 *   Jira from the one they work in. Otherwise the first site, as elsewhere.
 * - The token carries read:jira-user, so /myself answers with the person's
 *   real display name instead of borrowing one from another grant.
 */
async function handleAtlassianAdminCallback(
  request: NextRequest,
  tenant: { id: string; slug: string },
  subject: string,
  code: string,
  requestedScopes: string | null
): Promise<NextResponse> {
  logger.debug('Atlassian Jira Admin callback', { component: 'auth/oauth', tenantId: tenant.id });
  const dbResult = getDatabase();
  if (!dbResult.ok) return NextResponse.json({ error: 'Database error' }, { status: 500 });
  const db = dbResult.val;

  const originResult = await getOrigin(request);
  if (!originResult.ok) return NextResponse.json({ error: 'Config error' }, { status: 500 });
  const app = await getAtlassianAdminApp(tenant.id, originResult.val);
  if (!app) {
    return NextResponse.json(
      { error: 'Jira Administration connector not configured' },
      { status: 503 }
    );
  }

  const connect = await exchangeAtlassianCode(
    'Atlassian Jira Admin',
    tenant.id,
    ATLASSIAN_ADMIN,
    code,
    app.redirectUri
  );
  if (connect instanceof NextResponse) return connect;
  const { handle, pending, resources } = connect;

  const jiraGrantRow = await callerJiraGrant(db, tenant.id, subject);
  const jiraMeta =
    jiraGrantRow && typeof jiraGrantRow.metadata === 'object' && jiraGrantRow.metadata !== null
      ? (jiraGrantRow.metadata as Record<string, unknown>)
      : {};
  const jiraCloudId = typeof jiraMeta.cloudId === 'string' ? jiraMeta.cloudId : '';

  const site = resources.find((entry) => entry.id === jiraCloudId) ?? resources[0] ?? null;
  const cloudId = site?.id ?? cloudIdFromCodeClaims(code) ?? (jiraCloudId || null);
  const siteUrl = site?.url ?? '';
  if (!cloudId) {
    logger.error('Atlassian Jira Admin callback could not resolve a cloud id', {
      component: 'auth/oauth',
      tenantId: tenant.id,
    });
    return NextResponse.json({ error: 'No Jira site resolvable for this token' }, { status: 502 });
  }

  // read:jira-user lets /myself answer with the real name; the code's
  // claims and the borrowed Jira identity stand behind it.
  const myself = await atlassianMyself(pending, cloudId);
  const accountId =
    myself?.accountId ?? (await atlassianAccountIdOffline(db, tenant.id, subject, code));
  if (!accountId) {
    return NextResponse.json({ error: 'Token carries no account identity' }, { status: 502 });
  }
  const displayName = myself?.displayName || jiraGrantRow?.display_name || accountId;

  const stored = await delegateGrants().commit({
    tenantId: tenant.id,
    provider: ATLASSIAN_ADMIN,
    handle,
    subject,
    accountId,
    displayName,
    clientId: app.clientId,
    requestedScopes: (requestedScopes || app.scopes).split(' '),
    metadata: { cloudId, siteUrl },
  });
  if (!stored.ok) return storeFailed('Atlassian Jira Admin', tenant.id, stored.err);

  logger.info('Atlassian Jira Admin grant stored', {
    component: 'auth/oauth',
    tenantId: tenant.id,
    subject,
  });
  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: ATLASSIAN_ADMIN,
  });
  invalidateToolCatalogCache(tenant.id, subject);
  return NextResponse.redirect(new URL(`/${tenant.slug}/connectors`, originResult.val));
}

/**
 * Complete a Bitbucket connect — the fourth Atlassian app, on Bitbucket's
 * own OAuth system rather than the 3LO platform. The token endpoint wants
 * HTTP Basic app auth and a form body (Zoom-style), which the delegate
 * supplies from the connector config. Identity comes from GET /2.0/user
 * (the always-requested `account` scope exists exactly for this call).
 * Bitbucket tokens are opaque, so the granted scopes are whatever the
 * exchange answer echoed, handed to the delegate at commit.
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

  const exchanged = await delegateGrants().exchange({
    tenantId: tenant.id,
    provider: ATLASSIAN_BITBUCKET,
    form: { grant_type: 'authorization_code', code },
  });
  if (!exchanged.ok) return exchangeFailed('Bitbucket', tenant.id, exchanged.err);
  logExchanged('Bitbucket', tenant.id, exchanged.val);
  const handle = exchanged.val.handle;
  const pending = grantFetch({
    tenantId: tenant.id,
    provider: ATLASSIAN_BITBUCKET,
    pending: handle,
  });

  // Identity: Bitbucket tokens are opaque (no JWT claims to decode), so the
  // /2.0/user read is the only source. Its uuid is the durable account key;
  // the username is display material and rides in metadata.
  const userResponse = await pendingGet(pending, 'https://api.bitbucket.org/2.0/user');
  const user = (await jsonRecord(userResponse)) ?? {};
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

  const stored = await delegateGrants().commit({
    tenantId: tenant.id,
    provider: ATLASSIAN_BITBUCKET,
    handle,
    subject,
    accountId,
    displayName,
    clientId: app.clientId,
    requestedScopes: (requestedScopes || app.scopes).split(' '),
    // Opaque token: what Bitbucket's exchange answer said was granted is the
    // only record of it, so it is passed along for the tool gate.
    grantedScopes: exchanged.val.scope ? exchanged.val.scope.split(' ').filter(Boolean) : undefined,
    metadata: { username },
  });
  if (!stored.ok) return storeFailed('Bitbucket', tenant.id, stored.err);

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
  invalidateToolCatalogCache(tenant.id, subject);
  return NextResponse.redirect(new URL(`/${tenant.slug}/connectors`, originResult.val));
}

/* -------------------------------- WebEx -------------------------------- */

/**
 * The WebEx leg of the shared callback: exchange the code at the delegate,
 * ask /people/me who authorized, seal the grant bound to the signed-in
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

  const exchanged = await delegateGrants().exchange({
    tenantId: tenant.id,
    provider: WEBEX_USER,
    form: { grant_type: 'authorization_code', code, redirect_uri: app.redirectUri },
  });
  if (!exchanged.ok) return exchangeFailed('WebEx', tenant.id, exchanged.err);
  logExchanged('WebEx', tenant.id, exchanged.val);
  const handle = exchanged.val.handle;
  const pending = grantFetch({ tenantId: tenant.id, provider: WEBEX_USER, pending: handle });

  // Who granted this. personId is the durable account key; email is what the
  // access verifier checks room membership against. Requires the always-on
  // spark:people_read scope — a 403 here means the Integration at
  // developer.webex.com does not have it selected.
  const meResponse = await pendingGet(pending, 'https://webexapis.com/v1/people/me');
  const me = await jsonRecord(meResponse);
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

  const stored = await delegateGrants().commit({
    tenantId: tenant.id,
    provider: WEBEX_USER,
    handle,
    subject,
    accountId: personId,
    displayName,
    clientId: app.clientId,
    // WebEx does not echo scopes in its token response and its tokens are
    // opaque, so the (possibly user-narrowed) request carried through the
    // pending row is the record; granted stays null — unknown, honestly.
    requestedScopes: (requestedScopes || app.scopes).split(' '),
    metadata: { personEmail: emails[0] ?? null },
  });
  if (!stored.ok) return storeFailed('WebEx', tenant.id, stored.err);

  logger.info('WebEx user grant stored', { component: 'auth/oauth', tenantId: tenant.id, subject });
  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: WEBEX_USER,
  });
  invalidateToolCatalogCache(tenant.id, subject);
  return NextResponse.redirect(new URL(`/${tenant.slug}/connectors`, originResult.val));
}

/* -------------------------------- GitHub -------------------------------- */

/**
 * Complete the OAuth flow for Renkei's GitHub App: the delegate exchanges
 * the code at github.com's token endpoint (a normal client_id/client_secret
 * POST, the Bitbucket shape rather than Zoom's Basic auth — and GitHub's
 * HTTP-200-with-{error} answer to a rejected code reads as an exchange
 * failure there, since no access_token comes back); identity via GET /user.
 * Permissions are fixed on the App, not requested here, so the (possibly
 * user-narrowed) request carried through the pending row is what tool
 * registration narrows by, same as Bitbucket/Zoom.
 */
async function handleGitHubCallback(
  request: NextRequest,
  tenant: { id: string; slug: string },
  subject: string | null,
  code: string,
  requestedScopes: string | null
): Promise<NextResponse> {
  if (!subject) {
    logger.error('GitHub pending flow has no subject; cannot assign grant owner', {
      component: 'auth/oauth',
      tenantId: tenant.id,
    });
    return NextResponse.json({ error: 'Sign in again before connecting GitHub' }, { status: 400 });
  }

  const originResult = await getOrigin(request);
  if (!originResult.ok) {
    return NextResponse.json({ error: 'Config error' }, { status: 500 });
  }
  const app = await getGitHubApp(tenant.id, originResult.val);
  if (!app) {
    return NextResponse.json(
      { error: 'GitHub integration not configured for this organization' },
      { status: 503 }
    );
  }

  const exchanged = await delegateGrants().exchange({
    tenantId: tenant.id,
    provider: GITHUB,
    form: { grant_type: 'authorization_code', code, redirect_uri: app.redirectUri },
  });
  if (!exchanged.ok) return exchangeFailed('GitHub', tenant.id, exchanged.err);
  logExchanged('GitHub', tenant.id, exchanged.val);
  const handle = exchanged.val.handle;
  const pending = grantFetch({ tenantId: tenant.id, provider: GITHUB, pending: handle });

  // Who granted this. The account id (a stable numeric id, not the login,
  // which can be renamed) is the durable key; login is what API paths and
  // the connect card display.
  const meResponse = await pendingGet(pending, 'https://api.github.com/user', {
    Accept: 'application/vnd.github+json',
  });
  const me = await jsonRecord(meResponse);
  const accountId = typeof me?.id === 'number' ? String(me.id) : null;
  const login = typeof me?.login === 'string' ? me.login : null;
  if (!meResponse.ok || !accountId || !login) {
    logger.error('GitHub /user failed; cannot identify grantor', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      status: meResponse.status,
    });
    return NextResponse.json({ error: 'Could not identify GitHub user' }, { status: 502 });
  }
  const displayName = typeof me?.name === 'string' && me.name ? me.name : login;

  const stored = await delegateGrants().commit({
    tenantId: tenant.id,
    provider: GITHUB,
    handle,
    subject,
    accountId,
    displayName,
    clientId: app.clientId,
    requestedScopes: (requestedScopes || app.scopes).split(' '),
    metadata: { login },
  });
  if (!stored.ok) return storeFailed('GitHub', tenant.id, stored.err);

  logger.info('GitHub grant stored', { component: 'auth/oauth', tenantId: tenant.id, subject });
  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: GITHUB,
  });
  invalidateToolCatalogCache(tenant.id, subject);
  return NextResponse.redirect(new URL(`/${tenant.slug}/connectors`, originResult.val));
}

/* ------------------------------- Microsoft ------------------------------- */

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

  const exchanged = await exchangeMicrosoftCode(
    'Microsoft',
    app,
    tenant.id,
    MICROSOFT,
    code,
    requestedScopes
  );
  if (exchanged instanceof NextResponse) return exchanged;
  const { handle, oid, tid, upn, displayName, email } = exchanged;

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

  const stored = await delegateGrants().commit({
    tenantId: tenant.id,
    provider: MICROSOFT,
    handle,
    subject,
    accountId: oid,
    displayName: displayName ?? upn,
    clientId: app.clientId,
    requestedScopes: (requestedScopes || app.scopes).split(' '),
    // tid keeps refresh pointed at the right authority; upn/email are what
    // the refIds and the access verifier are built from.
    metadata: { tid, upn, email: email ?? null, ...carriedIndexing },
  });
  if (!stored.ok) return storeFailed('Microsoft', tenant.id, stored.err);

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
  invalidateToolCatalogCache(tenant.id, subject);
  return NextResponse.redirect(new URL(`/${tenant.slug}/connectors`, originResult.val));
}

/** What a Microsoft authorization code becomes, for either Entra app registration. */
interface MicrosoftExchange {
  handle: string;
  oid: string;
  tid: string;
  upn: string;
  displayName: string | null;
  email: string | null;
}

/**
 * Exchange an authorization code at the org's own tenant token endpoint
 * (the delegate builds it from `directoryTenantId`) and identify who
 * granted — the id_token claims (oid, tid, preferred_username) with GET /me
 * on the pending token as fallback. Shared by the Microsoft 365 and Entra
 * Developer callbacks: two app registrations, one exchange. A NextResponse
 * is the failure already phrased for the browser.
 */
async function exchangeMicrosoftCode(
  label: string,
  app: MicrosoftApp,
  tenantId: string,
  provider: string,
  code: string,
  requestedScopes: string | null
): Promise<MicrosoftExchange | NextResponse> {
  const exchanged = await delegateGrants().exchange({
    tenantId,
    provider,
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: app.redirectUri,
      scope: requestedScopes || app.scopes,
    },
    directoryTenantId: app.directoryTenantId,
  });
  if (!exchanged.ok) return exchangeFailed(label, tenantId, exchanged.err);
  logExchanged(label, tenantId, exchanged.val);
  const handle = exchanged.val.handle;

  // Who granted this. The id_token claims answer directly; /me is the
  // fallback when a claim is missing (some Entra configs omit email).
  const claims = exchanged.val.idToken ? decodeJwtPayload(exchanged.val.idToken) : null;
  let oid = typeof claims?.oid === 'string' ? claims.oid : null;
  const tid = typeof claims?.tid === 'string' ? claims.tid : app.directoryTenantId;
  let upn = typeof claims?.preferred_username === 'string' ? claims.preferred_username : null;
  let displayName = typeof claims?.name === 'string' ? claims.name : null;
  let email = typeof claims?.email === 'string' ? claims.email : null;

  if (!oid || !upn || !email) {
    const pending = grantFetch({ tenantId, provider, pending: handle });
    const meResponse = await pendingGet(pending, 'https://graph.microsoft.com/v1.0/me');
    const me = await jsonRecord(meResponse);
    if (meResponse.ok && me) {
      oid = oid ?? (typeof me.id === 'string' ? me.id : null);
      upn = upn ?? (typeof me.userPrincipalName === 'string' ? me.userPrincipalName : null);
      displayName = displayName ?? (typeof me.displayName === 'string' ? me.displayName : null);
      email = email ?? (typeof me.mail === 'string' ? me.mail : null);
    }
  }
  if (!oid || !upn) {
    logger.error('Could not identify {label} user from id_token claims or /me', {
      component: 'auth/oauth',
      tenantId,
      label,
    });
    return NextResponse.json({ error: `Could not identify ${label} user` }, { status: 502 });
  }

  return { handle, oid, tid, upn, displayName, email };
}

/**
 * Complete the OAuth flow for the Entra Developer app — the SECOND Entra
 * app registration (lib/entra-developer-app.ts). Same exchange as the
 * Microsoft 365 callback, stored under its own grant provider; no
 * `grant.connected` event, since this connector indexes nothing and holds
 * no Graph subscriptions for the worker to bootstrap.
 */
async function handleEntraDeveloperCallback(
  request: NextRequest,
  tenant: { id: string; slug: string },
  subject: string | null,
  code: string,
  requestedScopes: string | null
): Promise<NextResponse> {
  if (!subject) {
    logger.error('Entra Developer pending flow has no subject; cannot assign grant owner', {
      component: 'auth/oauth',
      tenantId: tenant.id,
    });
    return NextResponse.json(
      { error: 'Sign in again before connecting Entra Developer' },
      { status: 400 }
    );
  }

  const originResult = await getOrigin(request);
  if (!originResult.ok) {
    return NextResponse.json({ error: 'Config error' }, { status: 500 });
  }
  const app = await getEntraDeveloperApp(tenant.id, originResult.val);
  if (!app) {
    return NextResponse.json(
      { error: 'Entra Developer integration not configured for this organization' },
      { status: 503 }
    );
  }

  const exchanged = await exchangeMicrosoftCode(
    'Entra Developer',
    app,
    tenant.id,
    ENTRA_DEVELOPER,
    code,
    requestedScopes
  );
  if (exchanged instanceof NextResponse) return exchanged;
  const { handle, oid, tid, upn, displayName, email } = exchanged;

  const stored = await delegateGrants().commit({
    tenantId: tenant.id,
    provider: ENTRA_DEVELOPER,
    handle,
    subject,
    accountId: oid,
    displayName: displayName ?? upn,
    clientId: app.clientId,
    requestedScopes: (requestedScopes || app.scopes).split(' '),
    // tid keeps refresh pointed at the right authority; upn names the
    // person on the card and in the tools' "connected as" line.
    metadata: { tid, upn, email: email ?? null },
  });
  if (!stored.ok) return storeFailed('Entra Developer', tenant.id, stored.err);

  logger.info('Entra Developer grant stored', {
    component: 'auth/oauth',
    tenantId: tenant.id,
    subject,
  });
  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: ENTRA_DEVELOPER,
  });
  invalidateToolCatalogCache(tenant.id, subject);
  return NextResponse.redirect(new URL(`/${tenant.slug}/connectors`, originResult.val));
}

/* --------------------------------- Zoom --------------------------------- */

/**
 * Complete the OAuth flow for Zoom: a Basic-auth code exchange (the
 * delegate supplies it), identity from GET /users/me. Zoom's consent screen
 * always covers the Marketplace app's full scope set — the (possibly
 * user-narrowed) request carried through the pending row is what tool
 * registration narrows by, so it is recorded as requestedScopes even though
 * Zoom never saw it.
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

  const exchanged = await delegateGrants().exchange({
    tenantId: tenant.id,
    provider: ZOOM,
    form: { grant_type: 'authorization_code', code, redirect_uri: app.redirectUri },
  });
  if (!exchanged.ok) return exchangeFailed('Zoom', tenant.id, exchanged.err);
  logExchanged('Zoom', tenant.id, exchanged.val);
  const handle = exchanged.val.handle;
  const pending = grantFetch({ tenantId: tenant.id, provider: ZOOM, pending: handle });
  // The token-response echo names what the app was actually minted —
  // always the full Marketplace set, which is exactly why narrowing gates
  // on requested. The delegate relays it; Zoom tokens carry no scope claim.
  const scopeEcho = exchanged.val.scope;

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
  const meResponse = await pendingGet(pending, 'https://api.zoom.us/v2/users/me');
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

  const stored = await delegateGrants().commit({
    tenantId: tenant.id,
    provider: ZOOM,
    handle,
    subject,
    accountId: zoomUserId,
    displayName,
    clientId: app.clientId,
    requestedScopes: (requestedScopes || app.scopes).split(' '),
    metadata: { email, zoomAccountId: typeof me?.account_id === 'string' ? me.account_id : null },
  });
  if (!stored.ok) return storeFailed('Zoom', tenant.id, stored.err);

  logger.info('Zoom grant stored', { component: 'auth/oauth', tenantId: tenant.id, subject });
  recordAuditEvent({
    tenantId: tenant.id,
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: ZOOM,
  });
  invalidateToolCatalogCache(tenant.id, subject);
  return NextResponse.redirect(new URL(`/${tenant.slug}/connectors`, originResult.val));
}

/* -------------------------------- OnBase -------------------------------- */

/** Which of the two Hyland connectors handleOnBaseCallback is completing. */
interface OnBaseCallbackSpec {
  /** connector_configs key AND pending_oidc_signin.provider — same string. */
  connector: string;
  /** provider_grants.provider to store the resulting grant under. */
  grantProvider: string;
  /** For log/error prose: "OnBase" or "OnBase Administration". */
  label: string;
}

const ONBASE_SPEC: OnBaseCallbackSpec = {
  connector: 'onbase',
  grantProvider: ONBASE,
  label: 'OnBase',
};
const ONBASE_ADMIN_SPEC: OnBaseCallbackSpec = {
  connector: 'onbase-admin',
  grantProvider: ONBASE_ADMIN,
  label: 'OnBase Administration',
};

/**
 * Complete an OnBase connect — either connector, per `spec`: 'onbase' (the
 * Document Management API) and 'onbase-admin' (the Administration API) are
 * separate Hyland OAuth clients (lib/onbase-app.ts's header), but the token
 * exchange and grant-storage logic is identical between them. The delegate
 * runs the exchange through the OnBase worker — the customer's Hyland IdP
 * usually lives on a private network neither this process nor the delegate
 * may dial — presenting the PKCE code_verifier the authorize step stored on
 * the state row. Identity comes from the id_token's `sub` claim, which the
 * exchange relays and this decodes locally: the token arrived over TLS from
 * the IdP's own token endpoint via our trusted worker, which is exactly the
 * case where the OIDC code flow needs no signature check — and it works even
 * when the IdP exposes no userinfo endpoint.
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

  const exchanged = await delegateGrants().exchange({
    tenantId: tenant.id,
    provider: spec.grantProvider,
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: app.redirectUri,
      code_verifier: codeVerifier,
    },
  });
  if (!exchanged.ok) return exchangeFailed(spec.label, tenant.id, exchanged.err);
  logExchanged(spec.label, tenant.id, exchanged.val);
  const { handle, idToken, hasRefreshToken } = exchanged.val;

  const idClaims = idToken ? decodeJwtPayload(idToken) : null;
  const accountId = typeof idClaims?.sub === 'string' ? idClaims.sub : null;
  if (!accountId) {
    // Without a subject there is no durable key to store the grant under.
    logger.error('{label} id_token carried no sub claim; cannot identify grantor', {
      component: 'auth/oauth',
      tenantId: tenant.id,
      label: spec.label,
      hadIdToken: idToken !== null,
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

  const stored = await delegateGrants().commit({
    tenantId: tenant.id,
    provider: spec.grantProvider,
    handle,
    subject,
    accountId,
    displayName,
    clientId: app.clientId,
    requestedScopes: (requestedScopes || `openid offline_access ${app.idpScopeName}`).split(' '),
    metadata: { issuer: app.idpIssuer },
  });
  if (!stored.ok) return storeFailed(spec.label, tenant.id, stored.err);

  // No refresh token means the connection dies with this access token —
  // an IdP-side setting (offline_access), worth a log line now instead of
  // a mystery disconnect later.
  if (!hasRefreshToken) {
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
  invalidateToolCatalogCache(tenant.id, subject);
  return NextResponse.redirect(new URL(`/${tenant.slug}/connectors`, originResult.val));
}
