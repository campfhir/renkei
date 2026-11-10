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
import { getDataStore, type ActorFields } from '@renkei/db';
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
import { parseIdentityUrl, salesforceAccountId, sameOrg, to18 } from '@renkei/connector-salesforce';
import { getSalesforceConnector } from '@/lib/salesforce-app';
import { listSalesforceConnections } from '@/lib/salesforce-grants';
import { salesforceKindOfProvider, type SalesforceKind } from '@/lib/salesforce-kinds';
import {
  delegateGrants,
  grantFetch,
  type AuthedFetch,
  type ExchangeOutcome,
  type GrantOpError,
} from '@renkei/delegate-client';
import { getServer, serverIdOfProvider } from '@renkei/connector-mcp';
import { refreshToolList } from '@/lib/mcp-servers/remote';
import { ensureWatching } from '@/lib/mcp-servers/watch';
import { getGitHubApp } from '@/lib/github-app';
import { getOnBaseApp } from '@/lib/onbase-app';
import { getOrigin } from '@/lib/get-origin';
import { getSessionFromRequest } from '@/lib/session';
import { clearConnectFlow, isConnectFlowBound } from '@/lib/connect-flow-binding';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';
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

/**
 * The connector a pending row's provider names, in the words the connectors
 * page uses — for log lines about a callback before its handler runs.
 */
function connectorLabel(provider: string | null): string {
  switch (provider) {
    case null:
    case ATLASSIAN:
      return 'Jira';
    case ATLASSIAN_JSM:
      return 'Atlassian JSM';
    case ATLASSIAN_CONFLUENCE:
      return 'Confluence';
    case ATLASSIAN_ADMIN:
      return 'Jira Administration';
    case ATLASSIAN_BITBUCKET:
      return 'Bitbucket';
    case 'webex-user':
      return 'WebEx';
    case GITHUB:
      return 'GitHub';
    case MICROSOFT:
      return 'Microsoft 365';
    case ENTRA_DEVELOPER:
      return 'Entra Developer';
    case ZOOM:
      return 'Zoom';
    case 'onbase':
      return 'OnBase';
    case 'onbase-admin':
      return 'OnBase Administration';
  }
  if (salesforceKindOfProvider(provider)) return 'Salesforce';
  if (serverIdOfProvider(provider)) return 'a remote MCP server';
  return provider;
}

/** A pending-token request that failed to send reads as a 502 with an empty body. */
async function pendingGet(
  pending: AuthedFetch,
  url: string,
  actor: ActorFields,
  headers: Record<string, string> = {}
): Promise<Response> {
  try {
    return await pending(url, { headers: { Accept: 'application/json', ...headers } });
  } catch (error) {
    logger.warn(
      "{actor}'s identity lookup at {host} through the delegate could not be sent; it counts as a 502 and the connect falls back on what else is known: {error}",
      {
        component: 'oauth-callback',
        ...actor,
        host: new URL(url).host,
        url,
        error: error instanceof Error ? error.message : String(error),
      }
    );
    return new Response('identity lookup failed', { status: 502 });
  }
}

/** The app origin could not be resolved: logged with the connect it stops, phrased for the browser. */
function originFailed(
  label: string,
  actor: ActorFields,
  error: { type: string; message?: string }
): NextResponse {
  logger.error(
    '{actor} authorized {label}, but the app origin could not be resolved; the grant was not stored and the person saw a config error: {error}',
    {
      component: 'auth/oauth',
      ...actor,
      label,
      error: error.message ?? error.type,
    }
  );
  return NextResponse.json({ error: 'Config error' }, { status: 500 });
}

/** The delegate could not exchange the code: logged, and phrased for the browser. */
function exchangeFailed(
  label: string,
  actor: ActorFields,
  error: { type: GrantOpError; message?: string }
): NextResponse {
  logger.error(
    '{actor} authorized {label}, but the code could not be exchanged for tokens ({reason}); the grant was not stored and the person saw an error: {error}',
    {
      component: 'auth/oauth',
      ...actor,
      label,
      reason: error.type,
      // The delegate relays the provider's own error_description — no token
      // material reaches a failed exchange's body, and this is exactly what a
      // wrong client secret needs to diagnose instead of a bare tag.
      error: error.message ?? error.type,
    }
  );
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
  actor: ActorFields,
  error: { type: GrantOpError; message?: string }
): NextResponse {
  logger.error(
    '{actor} authorized {label}, but the grant was not stored ({reason}); the person saw an error: {error}',
    {
      component: 'auth/oauth',
      ...actor,
      label,
      reason: error.type,
      error: error.message ?? error.type,
    }
  );
  return NextResponse.json({ error: `Failed to store ${label} grant` }, { status: 500 });
}

function logExchanged(label: string, actor: ActorFields, outcome: ExchangeOutcome): void {
  // Only whether tokens came back, never any of their bytes: these records
  // are persisted by the Postgres log adapter and are readable over HTTP by
  // tenant users — and the bytes are in the delegate anyway.
  logger.debug(
    '{actor}: the {label} code was exchanged for tokens{withRefresh}; the access token expires at {expiresAt}',
    {
      component: 'auth/oauth',
      ...actor,
      label,
      expiresAt: outcome.expiresAt,
      hasRefreshToken: outcome.hasRefreshToken,
      withRefresh: outcome.hasRefreshToken ? ' with a refresh token' : ' without a refresh token',
    }
  );
}

/**
 * The browser binding (lib/connect-flow-binding.ts) is checked inside; this
 * wrapper exists so the binding cookie is cleared on EVERY response once the
 * state has been recognised — success, refusal, or a provider handler's
 * own error — without threading the cookie through each provider branch.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const flow = { stateKnown: false };
  const response = await handleCallback(request, flow);
  return flow.stateKnown ? clearConnectFlow(response) : response;
}

async function handleCallback(
  request: NextRequest,
  flow: { stateKnown: boolean }
): Promise<NextResponse> {
  const store = getDataStore();
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

  // Who started the flow and which connector it is for, once the pending
  // row is known: what every line below, the catch-all included, names.
  let startedBy: ActorFields | null = null;
  let connector = 'a connector';
  try {
    // Look up the pending authorization by state (single-use token). The
    // pending record tells us which tenant this flow is for and which
    // provider's token endpoint the code must be exchanged at.
    const pendingSignIn = await store.pendingSignins.findByState(state);

    if (!pendingSignIn) {
      return NextResponse.json({ error: 'Invalid or expired state' }, { status: 400 });
    }
    flow.stateKnown = true;
    connector = connectorLabel(pendingSignIn.provider);
    const actor = await whoIs(pendingSignIn.subject);
    startedBy = actor;

    // CSRF / grant-planting defense (lib/connect-flow-binding.ts): the state
    // must match the cookie the authorize route set in THIS browser, and the
    // browser must hold a session for the SAME subject the pending row
    // recorded. A callback URL captured from one browser and replayed into
    // another carries neither, so it is refused — and the state is consumed
    // either way, so it cannot be retried with a different browser.
    if (!isConnectFlowBound(request, state)) {
      await store.pendingSignins.deleteByState(state);
      logger.warn(
        'the {connector} connect started by {actor} came back without the state cookie its authorize step set in the browser; the callback was rejected and the state consumed, so nothing was stored',
        {
          component: 'auth/oauth',
          ...actor,
          connector,
          provider: pendingSignIn.provider ?? 'atlassian',
        }
      );
      return NextResponse.json({ error: 'Invalid state' }, { status: 400 });
    }
    const session = await getSessionFromRequest(request);
    if (!session || !pendingSignIn.subject || session.subject !== pendingSignIn.subject) {
      await store.pendingSignins.deleteByState(state);
      logger.warn(
        'the {connector} connect started by {actor} was completed by {completedBy}; the callback was rejected and the state consumed, so nothing was stored',
        {
          component: 'auth/oauth',
          ...actor,
          connector,
          provider: pendingSignIn.provider ?? 'atlassian',
          signedIn: Boolean(session),
          completedBy: session ? (await whoIs(session.subject)).actor : 'a browser with no session',
          completedBySubject: session?.subject ?? null,
        }
      );
      return NextResponse.json(
        { error: 'Sign in as the person who started this connection, then try again' },
        { status: 403 }
      );
    }

    // The authorize step records who initiated the connect. A pending row without
    // one predates per-user grants; completing it would produce an unowned grant
    // that no caller can use, so send the user back through a fresh sign-in.
    if (!pendingSignIn.subject) {
      logger.error(
        'a {connector} connect callback arrived on a pending row that names no person (from before per-user grants); no grant can be owned, so the person was sent to sign in again',
        {
          component: 'auth/oauth',
          connector,
          provider: pendingSignIn.provider ?? 'atlassian',
        }
      );
      return NextResponse.json({ error: 'Sign in again before connecting Jira' }, { status: 400 });
    }

    // Delete pending record (single-use) to prevent replay attacks
    await store.pendingSignins.deleteByState(state);

    // Verify state is not expired
    const stateExpiresAt = pendingSignIn.expiresAt;
    if (stateExpiresAt < new Date()) {
      return NextResponse.json({ error: 'State expired' }, { status: 400 });
    }

    // Dispatch on the provider the authorize step recorded. Null predates
    // the column and means Atlassian — the only provider that existed then.
    if (pendingSignIn.provider === 'webex-user') {
      return handleWebexUserCallback(request, pendingSignIn.subject, code, pendingSignIn.scopes);
    }
    if (pendingSignIn.provider === 'atlassian-jsm') {
      return handleAtlassianJsmCallback(request, pendingSignIn.subject, code, pendingSignIn.scopes);
    }
    if (pendingSignIn.provider === 'atlassian-confluence') {
      return handleAtlassianConfluenceCallback(
        request,
        pendingSignIn.subject,
        code,
        pendingSignIn.scopes
      );
    }
    if (pendingSignIn.provider === 'atlassian-admin') {
      return handleAtlassianAdminCallback(
        request,
        pendingSignIn.subject,
        code,
        pendingSignIn.scopes
      );
    }
    if (pendingSignIn.provider === 'atlassian-bitbucket') {
      return handleAtlassianBitbucketCallback(
        request,
        pendingSignIn.subject,
        code,
        pendingSignIn.scopes
      );
    }
    if (pendingSignIn.provider === 'github') {
      return handleGitHubCallback(request, pendingSignIn.subject, code, pendingSignIn.scopes);
    }
    if (pendingSignIn.provider === 'microsoft') {
      return handleMicrosoftCallback(request, pendingSignIn.subject, code, pendingSignIn.scopes);
    }
    if (pendingSignIn.provider === 'entra-developer') {
      // A SEPARATE Entra app registration from 'microsoft' above — see
      // lib/entra-developer-app.ts — so it rides the same token exchange
      // with a different app, grant provider and label, and none of the
      // Microsoft 365 grant's indexing bootstrap.
      return handleEntraDeveloperCallback(
        request,
        pendingSignIn.subject,
        code,
        pendingSignIn.scopes
      );
    }
    const salesforceKind = salesforceKindOfProvider(pendingSignIn.provider ?? '');
    if (salesforceKind) {
      return handleSalesforceCallback(
        salesforceKind,
        request,
        pendingSignIn.subject,
        code,
        pendingSignIn.scopes,
        pendingSignIn.codeVerifier,
        pendingSignIn.connectorKey
      );
    }
    if (pendingSignIn.provider === 'zoom') {
      return handleZoomCallback(request, pendingSignIn.subject, code, pendingSignIn.scopes);
    }
    if (pendingSignIn.provider === 'onbase') {
      return handleOnBaseCallback(
        request,
        pendingSignIn.subject,
        code,
        pendingSignIn.scopes,
        pendingSignIn.codeVerifier,
        ONBASE_SPEC
      );
    }
    if (pendingSignIn.provider === 'onbase-admin') {
      // A SEPARATE Hyland OAuth client from 'onbase' above — see
      // lib/onbase-app.ts's header — so it rides the identical callback
      // logic with a different connector key, grant provider and label.
      return handleOnBaseCallback(
        request,
        pendingSignIn.subject,
        code,
        pendingSignIn.scopes,
        pendingSignIn.codeVerifier,
        ONBASE_ADMIN_SPEC
      );
    }

    // A remote MCP server: its own authorization server issued the code.
    const mcpServerId = serverIdOfProvider(pendingSignIn.provider ?? '');
    if (mcpServerId) {
      return handleMcpServerCallback(
        request,
        pendingSignIn.subject,
        code,
        pendingSignIn.scopes,
        pendingSignIn.codeVerifier,
        mcpServerId
      );
    }

    logger.debug("{actor} returned from Jira's consent screen with an authorization code", {
      component: 'auth/oauth',
      ...actor,
    });

    // The org's Atlassian app registration, from connector config: the
    // redirect URI the authorize step used (the exchange must present the
    // same one), the client id the grant records, and the default scopes.
    // The client secret stays in the delegate's reading of the same config.
    const appOriginResult = await getOrigin(request);
    if (!appOriginResult.ok) return originFailed('Jira', actor, appOriginResult.err);
    const atlassianApp = await getAtlassianApp(appOriginResult.val);
    if (!atlassianApp) {
      return NextResponse.json(
        { error: 'Atlassian connector not configured for this organization' },
        { status: 503 }
      );
    }

    logger.debug('{actor}: exchanging the Jira authorization code at the delegate', {
      component: 'auth/oauth',
      ...actor,
    });
    const connect = await exchangeAtlassianCode(
      'Jira',
      ATLASSIAN,
      code,
      atlassianApp.redirectUri,
      actor
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

      const prior = await store.providerGrants.latestOf([ATLASSIAN]);
      if (prior && typeof prior.metadata === 'object' && prior.metadata !== null) {
        const metadata = prior.metadata as Record<string, unknown>;
        if (!cloudId && typeof metadata.cloudId === 'string') cloudId = metadata.cloudId;
        if (typeof metadata.siteUrl === 'string') siteUrl = metadata.siteUrl;
      }

      if (!cloudId) {
        logger.error(
          '{actor} authorized Jira, but no site could be found for the token (no accessible resources, no site in the code claims, no prior grant); the grant was not stored',
          { component: 'auth/oauth', ...actor }
        );
        return NextResponse.json({ error: 'No Jira sites accessible' }, { status: 400 });
      }
      logger.debug(
        '{actor}: the Jira token lists no accessible sites (jira-less scopes); using the site from the code claims or a prior grant',
        {
          component: 'auth/oauth',
          ...actor,
          cloudId,
        }
      );
    }

    logger.debug('{actor}: asking Jira who authorized (/myself)', {
      component: 'auth/oauth',
      ...actor,
      cloudId,
    });
    // Get user info via API gateway path for OAuth 2.0 3LO, on the pending token.
    let identity = await atlassianMyself(pending, cloudId, actor);
    if (identity) {
      logger.debug('{actor}: Jira named the authorizing Atlassian account', {
        component: 'auth/oauth',
        ...actor,
        accountId: identity.accountId,
      });
    } else {
      // /myself is a Jira-scoped endpoint; a jira-less token cannot call it.
      // The authorization code's sub claim is the Atlassian account id, and
      // the caller's existing grant the fallback behind that.
      const accountId = await atlassianAccountIdOffline(pendingSignIn.subject, code);
      if (!accountId) {
        logger.error(
          '{actor} authorized Jira, but the Atlassian account could not be identified (/myself refused, no sub in the code claims, no prior grant); the grant was not stored',
          { component: 'auth/oauth', ...actor }
        );
        return NextResponse.json({ error: 'Failed to get user info' }, { status: 400 });
      }
      const priorName = await store.providerGrants.find(ATLASSIAN, accountId);
      identity = { accountId, displayName: priorName?.displayName || null };
      logger.debug(
        '{actor}: /myself is closed to this Jira token (jira-less scopes); the Atlassian account was taken from the code claims or a prior grant',
        {
          component: 'auth/oauth',
          ...actor,
          accountId,
        }
      );
    }
    const accountId = identity.accountId;
    const displayName = identity.displayName || accountId;

    // Cache the displayName for logging
    cacheUserDisplayName(accountId, displayName);

    logger.debug('{actor}: sealing the Jira grant as "{atlassianUser}" on site {site}', {
      component: 'auth/oauth',
      ...actor,
      accountId,
      atlassianUser: displayName,
      cloudId,
      siteUrl,
      site: siteUrl || cloudId,
    });
    // Seal the grant: the delegate stores the tokens it holds behind the
    // handle, with the identity and site decided here. Site identity is
    // Atlassian-specific, so it lives in metadata rather than as columns
    // every other provider would leave NULL.
    const stored = await delegateGrants().commit({
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
    if (!stored.ok) return storeFailed('Jira', actor, stored.err);

    logger.info(
      '{actor} connected Jira as "{atlassianUser}" on site {site}; sent back to the connectors page',
      {
        component: 'auth/oauth',
        ...actor,
        accountId,
        atlassianUser: displayName,
        cloudId,
        siteUrl,
        site: siteUrl || cloudId,
      }
    );
    recordAuditEvent({
      actorSubject: pendingSignIn.subject,
      action: 'connector.connected',
      targetKind: 'connector',
      targetLabel: 'atlassian',
    });
    invalidateToolCatalogCache(pendingSignIn.subject);
    // Back to the connectors page, which shows the fresh connection status.
    const connectorsUrl = new URL(`/connectors`, appOriginResult.val);
    logger.debug('{actor}: redirecting to {url} after the Jira connect', {
      component: 'auth/oauth',
      ...actor,
      url: connectorsUrl.toString(),
    });
    return NextResponse.redirect(connectorsUrl);
  } catch (err) {
    logger.error(
      'the {connector} connect{startedByPhrase} failed with an unexpected error; nothing was stored and the person saw "Authentication failed": {error}',
      {
        component: 'auth/oauth',
        ...(startedBy ?? {}),
        connector,
        startedByPhrase: startedBy ? ` started by ${startedBy.actor}` : '',
        error: err instanceof Error ? err.message : String(err),
        stack: err instanceof Error ? err.stack : undefined,
      }
    );
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
  provider: string,
  code: string,
  redirectUri: string,
  actor: ActorFields
): Promise<AtlassianConnect | NextResponse> {
  const exchanged = await delegateGrants().exchange({
    provider,
    form: { grant_type: 'authorization_code', code, redirect_uri: redirectUri },
  });
  if (!exchanged.ok) return exchangeFailed(label, actor, exchanged.err);
  logExchanged(label, actor, exchanged.val);
  const handle = exchanged.val.handle;
  const pending = grantFetch({ provider, pending: handle });

  logger.debug('{actor}: listing the Atlassian sites the {label} token reaches', {
    component: 'auth/oauth',
    ...actor,
    label,
  });
  const response = await pendingGet(
    pending,
    'https://api.atlassian.com/oauth/token/accessible-resources',
    actor
  );
  const list: unknown = response.ok ? await response.json().catch(() => null) : null;
  if (!response.ok) {
    // A token with no Jira scopes is refused here; the fallbacks below
    // (code claims, prior grants) take over, so this is a debug line.
    logger.debug(
      '{actor}: Atlassian refused accessible-resources for the {label} token ({status}); the site will come from the code claims or a prior grant',
      {
        component: 'auth/oauth',
        ...actor,
        label,
        status: response.status,
      }
    );
  }
  const resources = isResourceArray(list) ? list : [];
  logger.debug('{actor}: the {label} token reaches {count} Atlassian site(s)', {
    component: 'auth/oauth',
    ...actor,
    label,
    count: resources.length,
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
  cloudId: string,
  actor: ActorFields
): Promise<AtlassianIdentity | null> {
  const response = await pendingGet(
    pending,
    `https://api.atlassian.com/ex/jira/${cloudId}/rest/api/3/myself`,
    actor
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
async function atlassianAccountIdOffline(subject: string, code: string): Promise<string | null> {
  const fromCode = subFromCodeClaims(code);
  if (fromCode) return fromCode;
  const prior = await getDataStore().providerGrants.latestOf(
    [ATLASSIAN, ATLASSIAN_JSM, ATLASSIAN_CONFLUENCE, ATLASSIAN_ADMIN],
    { subject }
  );
  return prior?.accountId ?? null;
}

/** The caller's Jira grant row, whose display name and site a sibling connect borrows. */
async function callerJiraGrant(
  subject: string
): Promise<{ display_name: string; metadata: unknown } | undefined> {
  const [grant] = await getDataStore().providerGrants.listForSubject(subject, {
    provider: ATLASSIAN,
  });
  return grant && { display_name: grant.displayName, metadata: grant.metadata };
}

/** The cloud id recorded on any prior grant of the given Atlassian providers in this tenant. */
async function priorCloudId(providers: string[]): Promise<string | null> {
  const prior = await getDataStore().providerGrants.latestOf(providers);
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
  subject: string,
  code: string,
  requestedScopes: string | null
): Promise<NextResponse> {
  const actor = await whoIs(subject);
  logger.debug("{actor} returned from Atlassian JSM's consent screen with an authorization code", {
    component: 'auth/oauth',
    ...actor,
  });

  const originResult = await getOrigin(request);
  if (!originResult.ok) return originFailed('Atlassian JSM', actor, originResult.err);
  const app = await getAtlassianJsmApp(originResult.val);
  if (!app) {
    return NextResponse.json({ error: 'Atlassian JSM connector not configured' }, { status: 503 });
  }

  const connect = await exchangeAtlassianCode(
    'Atlassian JSM',
    ATLASSIAN_JSM,
    code,
    app.redirectUri,
    actor
  );
  if (connect instanceof NextResponse) return connect;
  const { handle, pending, resources } = connect;

  // Site identity: a JSM/Ops-scoped token may surface no accessible
  // resources, so fall through the chain the ops-only experiment proved out —
  // the code JWT's site ARI, then any prior Atlassian grant in this tenant.
  const cloudId =
    resources[0]?.id ??
    cloudIdFromCodeClaims(code) ??
    (await priorCloudId([ATLASSIAN, ATLASSIAN_JSM]));
  if (!cloudId) {
    logger.error(
      '{actor} authorized Atlassian JSM, but no Jira site could be resolved for the token (no accessible resources, no site in the code claims, no prior grant); the grant was not stored',
      { component: 'auth/oauth', ...actor }
    );
    return NextResponse.json({ error: 'No Jira site resolvable for this token' }, { status: 502 });
  }

  // The account id comes from the code's claims — /myself is closed to a
  // token without Jira scopes — with the token's own answer as the last
  // resort. Display name borrows from the caller's Jira grant when one
  // exists (same human, same Atlassian account).
  const accountId =
    (await atlassianAccountIdOffline(subject, code)) ??
    (await atlassianMyself(pending, cloudId, actor))?.accountId;
  if (!accountId) {
    logger.warn(
      '{actor} authorized Atlassian JSM, but the token names no Atlassian account; the grant was not stored',
      { component: 'auth/oauth', ...actor, cloudId }
    );
    return NextResponse.json({ error: 'Token carries no account identity' }, { status: 502 });
  }
  const jiraGrantRow = await callerJiraGrant(subject);
  const displayName = jiraGrantRow?.display_name || accountId;

  const stored = await delegateGrants().commit({
    provider: ATLASSIAN_JSM,
    handle,
    subject,
    accountId,
    displayName,
    clientId: app.clientId,
    requestedScopes: (requestedScopes || app.scopes).split(' '),
    metadata: { cloudId, siteUrl: '' },
  });
  if (!stored.ok) return storeFailed('Atlassian JSM', actor, stored.err);

  logger.info(
    '{actor} connected Atlassian JSM as "{atlassianUser}"; sent back to the connectors page',
    {
      component: 'auth/oauth',
      ...actor,
      accountId,
      atlassianUser: displayName,
      cloudId,
    }
  );
  recordAuditEvent({
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: ATLASSIAN_JSM,
  });
  invalidateToolCatalogCache(subject);
  return NextResponse.redirect(new URL(`/connectors`, originResult.val));
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
  subject: string,
  code: string,
  requestedScopes: string | null
): Promise<NextResponse> {
  const actor = await whoIs(subject);
  logger.debug("{actor} returned from Confluence's consent screen with an authorization code", {
    component: 'auth/oauth',
    ...actor,
  });

  const originResult = await getOrigin(request);
  if (!originResult.ok) return originFailed('Atlassian Confluence', actor, originResult.err);
  const app = await getAtlassianConfluenceApp(originResult.val);
  if (!app) {
    return NextResponse.json(
      { error: 'Atlassian Confluence connector not configured' },
      { status: 503 }
    );
  }

  const connect = await exchangeAtlassianCode(
    'Atlassian Confluence',
    ATLASSIAN_CONFLUENCE,
    code,
    app.redirectUri,
    actor
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
    (await priorCloudId([ATLASSIAN, ATLASSIAN_JSM, ATLASSIAN_CONFLUENCE]));
  if (!cloudId) {
    logger.error(
      '{actor} authorized Confluence, but no site could be resolved for the token (no accessible resources, no site in the code claims, no prior grant); the grant was not stored',
      { component: 'auth/oauth', ...actor }
    );
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
    (await atlassianAccountIdOffline(subject, code)) ??
    (await atlassianMyself(pending, cloudId, actor))?.accountId;
  if (!accountId) {
    logger.warn(
      '{actor} authorized Confluence, but the token names no Atlassian account; the grant was not stored',
      { component: 'auth/oauth', ...actor, cloudId }
    );
    return NextResponse.json({ error: 'Token carries no account identity' }, { status: 502 });
  }
  const jiraGrantRow = await callerJiraGrant(subject);
  const displayName = jiraGrantRow?.display_name || accountId;

  const stored = await delegateGrants().commit({
    provider: ATLASSIAN_CONFLUENCE,
    handle,
    subject,
    accountId,
    displayName,
    clientId: app.clientId,
    requestedScopes: (requestedScopes || app.scopes).split(' '),
    metadata: { cloudId, siteUrl: '' },
  });
  if (!stored.ok) return storeFailed('Atlassian Confluence', actor, stored.err);

  logger.info(
    '{actor} connected Confluence as "{atlassianUser}"; sent back to the connectors page',
    {
      component: 'auth/oauth',
      ...actor,
      accountId,
      atlassianUser: displayName,
      cloudId,
    }
  );
  recordAuditEvent({
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: ATLASSIAN_CONFLUENCE,
  });
  invalidateToolCatalogCache(subject);
  return NextResponse.redirect(new URL(`/connectors`, originResult.val));
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
  subject: string,
  code: string,
  requestedScopes: string | null
): Promise<NextResponse> {
  const actor = await whoIs(subject);
  logger.debug(
    "{actor} returned from Jira Administration's consent screen with an authorization code",
    { component: 'auth/oauth', ...actor }
  );

  const originResult = await getOrigin(request);
  if (!originResult.ok) return originFailed('Atlassian Jira Admin', actor, originResult.err);
  const app = await getAtlassianAdminApp(originResult.val);
  if (!app) {
    return NextResponse.json(
      { error: 'Jira Administration connector not configured' },
      { status: 503 }
    );
  }

  const connect = await exchangeAtlassianCode(
    'Atlassian Jira Admin',
    ATLASSIAN_ADMIN,
    code,
    app.redirectUri,
    actor
  );
  if (connect instanceof NextResponse) return connect;
  const { handle, pending, resources } = connect;

  const jiraGrantRow = await callerJiraGrant(subject);
  const jiraMeta =
    jiraGrantRow && typeof jiraGrantRow.metadata === 'object' && jiraGrantRow.metadata !== null
      ? (jiraGrantRow.metadata as Record<string, unknown>)
      : {};
  const jiraCloudId = typeof jiraMeta.cloudId === 'string' ? jiraMeta.cloudId : '';

  const site = resources.find((entry) => entry.id === jiraCloudId) ?? resources[0] ?? null;
  const cloudId = site?.id ?? cloudIdFromCodeClaims(code) ?? (jiraCloudId || null);
  const siteUrl = site?.url ?? '';
  if (!cloudId) {
    logger.error(
      '{actor} authorized Jira Administration, but no Jira site could be resolved for the token; the grant was not stored',
      { component: 'auth/oauth', ...actor }
    );
    return NextResponse.json({ error: 'No Jira site resolvable for this token' }, { status: 502 });
  }

  // read:jira-user lets /myself answer with the real name; the code's
  // claims and the borrowed Jira identity stand behind it.
  const myself = await atlassianMyself(pending, cloudId, actor);
  const accountId = myself?.accountId ?? (await atlassianAccountIdOffline(subject, code));
  if (!accountId) {
    logger.warn(
      '{actor} authorized Jira Administration, but the token names no Atlassian account; the grant was not stored',
      { component: 'auth/oauth', ...actor, cloudId, siteUrl }
    );
    return NextResponse.json({ error: 'Token carries no account identity' }, { status: 502 });
  }
  const displayName = myself?.displayName || jiraGrantRow?.display_name || accountId;

  const stored = await delegateGrants().commit({
    provider: ATLASSIAN_ADMIN,
    handle,
    subject,
    accountId,
    displayName,
    clientId: app.clientId,
    requestedScopes: (requestedScopes || app.scopes).split(' '),
    metadata: { cloudId, siteUrl },
  });
  if (!stored.ok) return storeFailed('Atlassian Jira Admin', actor, stored.err);

  logger.info(
    '{actor} connected Jira Administration as "{atlassianUser}" on site {site}; sent back to the connectors page',
    {
      component: 'auth/oauth',
      ...actor,
      accountId,
      atlassianUser: displayName,
      cloudId,
      siteUrl,
      site: siteUrl || cloudId,
    }
  );
  recordAuditEvent({
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: ATLASSIAN_ADMIN,
  });
  invalidateToolCatalogCache(subject);
  return NextResponse.redirect(new URL(`/connectors`, originResult.val));
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
  subject: string,
  code: string,
  requestedScopes: string | null
): Promise<NextResponse> {
  const actor = await whoIs(subject);
  logger.debug("{actor} returned from Bitbucket's consent screen with an authorization code", {
    component: 'auth/oauth',
    ...actor,
  });

  const originResult = await getOrigin(request);
  if (!originResult.ok) return originFailed('Bitbucket', actor, originResult.err);
  const app = await getAtlassianBitbucketApp(originResult.val);
  if (!app) {
    return NextResponse.json({ error: 'Bitbucket connector not configured' }, { status: 503 });
  }

  const exchanged = await delegateGrants().exchange({
    provider: ATLASSIAN_BITBUCKET,
    form: { grant_type: 'authorization_code', code },
  });
  if (!exchanged.ok) return exchangeFailed('Bitbucket', actor, exchanged.err);
  logExchanged('Bitbucket', actor, exchanged.val);
  const handle = exchanged.val.handle;
  const pending = grantFetch({
    provider: ATLASSIAN_BITBUCKET,
    pending: handle,
  });

  // Identity: Bitbucket tokens are opaque (no JWT claims to decode), so the
  // /2.0/user read is the only source. Its uuid is the durable account key;
  // the username is display material and rides in metadata.
  const userResponse = await pendingGet(pending, 'https://api.bitbucket.org/2.0/user', actor);
  const user = (await jsonRecord(userResponse)) ?? {};
  const accountId = typeof user.uuid === 'string' ? user.uuid : '';
  if (!userResponse.ok || !accountId) {
    logger.error(
      '{actor} authorized Bitbucket, but GET /2.0/user did not name the account ({status}); the grant was not stored',
      {
        component: 'auth/oauth',
        ...actor,
        status: userResponse.status,
      }
    );
    return NextResponse.json({ error: 'Could not read the Bitbucket account' }, { status: 502 });
  }
  const username = typeof user.username === 'string' ? user.username : '';
  const displayName =
    (typeof user.display_name === 'string' && user.display_name) || username || accountId;

  const stored = await delegateGrants().commit({
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
  if (!stored.ok) return storeFailed('Bitbucket', actor, stored.err);

  logger.info(
    '{actor} connected Bitbucket as "{bitbucketUser}"; sent back to the connectors page',
    {
      component: 'auth/oauth',
      ...actor,
      accountId,
      bitbucketUser: displayName,
      username,
    }
  );
  recordAuditEvent({
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: ATLASSIAN_BITBUCKET,
  });
  invalidateToolCatalogCache(subject);
  return NextResponse.redirect(new URL(`/connectors`, originResult.val));
}

/* -------------------------------- WebEx -------------------------------- */

/**
 * The WebEx leg of the shared callback: exchange the code at the delegate,
 * ask /people/me who authorized, seal the grant bound to the signed-in
 * subject. Read access only — the scopes were fixed at the authorize step.
 */
async function handleWebexUserCallback(
  request: NextRequest,
  subject: string | null,
  code: string,
  requestedScopes: string | null
): Promise<NextResponse> {
  if (!subject) {
    logger.error(
      'a WebEx connect callback arrived on a pending row that names no person; no grant can be owned, so the person was sent to sign in again',
      { component: 'auth/oauth' }
    );
    return NextResponse.json({ error: 'Sign in again before connecting WebEx' }, { status: 400 });
  }
  const actor = await whoIs(subject);

  const originResult = await getOrigin(request);
  if (!originResult.ok) return originFailed('WebEx', actor, originResult.err);
  const app = await getWebexUserApp(originResult.val);
  if (!app) {
    return NextResponse.json(
      { error: 'WebEx user integration not configured for this organization' },
      { status: 503 }
    );
  }

  const exchanged = await delegateGrants().exchange({
    provider: WEBEX_USER,
    form: { grant_type: 'authorization_code', code, redirect_uri: app.redirectUri },
  });
  if (!exchanged.ok) return exchangeFailed('WebEx', actor, exchanged.err);
  logExchanged('WebEx', actor, exchanged.val);
  const handle = exchanged.val.handle;
  const pending = grantFetch({ provider: WEBEX_USER, pending: handle });

  // Who granted this. personId is the durable account key; email is what the
  // access verifier checks room membership against. Requires the always-on
  // spark:people_read scope — a 403 here means the Integration at
  // developer.webex.com does not have it selected.
  const meResponse = await pendingGet(pending, 'https://webexapis.com/v1/people/me', actor);
  const me = await jsonRecord(meResponse);
  const personId = typeof me?.id === 'string' ? me.id : null;
  if (!meResponse.ok || !personId) {
    logger.error(
      '{actor} authorized WebEx, but /people/me did not identify them ({status}){because}; the grant was not stored',
      {
        component: 'auth/oauth',
        ...actor,
        status: meResponse.status,
        because:
          meResponse.status === 403
            ? ' because the Integration lacks the spark:people_read scope'
            : '',
        hint:
          meResponse.status === 403
            ? 'Select spark:people_read on the Integration at developer.webex.com'
            : undefined,
      }
    );
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
  if (!stored.ok) return storeFailed('WebEx', actor, stored.err);

  logger.info('{actor} connected WebEx as "{webexUser}"; sent back to the connectors page', {
    component: 'auth/oauth',
    ...actor,
    accountId: personId,
    webexUser: displayName,
    personEmail: emails[0] ?? null,
  });
  recordAuditEvent({
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: WEBEX_USER,
  });
  invalidateToolCatalogCache(subject);
  return NextResponse.redirect(new URL(`/connectors`, originResult.val));
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
  subject: string | null,
  code: string,
  requestedScopes: string | null
): Promise<NextResponse> {
  if (!subject) {
    logger.error(
      'a GitHub connect callback arrived on a pending row that names no person; no grant can be owned, so the person was sent to sign in again',
      { component: 'auth/oauth' }
    );
    return NextResponse.json({ error: 'Sign in again before connecting GitHub' }, { status: 400 });
  }
  const actor = await whoIs(subject);

  const originResult = await getOrigin(request);
  if (!originResult.ok) return originFailed('GitHub', actor, originResult.err);
  const app = await getGitHubApp(originResult.val);
  if (!app) {
    return NextResponse.json(
      { error: 'GitHub integration not configured for this organization' },
      { status: 503 }
    );
  }

  const exchanged = await delegateGrants().exchange({
    provider: GITHUB,
    form: { grant_type: 'authorization_code', code, redirect_uri: app.redirectUri },
  });
  if (!exchanged.ok) return exchangeFailed('GitHub', actor, exchanged.err);
  logExchanged('GitHub', actor, exchanged.val);
  const handle = exchanged.val.handle;
  const pending = grantFetch({ provider: GITHUB, pending: handle });

  // Who granted this. The account id (a stable numeric id, not the login,
  // which can be renamed) is the durable key; login is what API paths and
  // the connect card display.
  const meResponse = await pendingGet(pending, 'https://api.github.com/user', actor, {
    Accept: 'application/vnd.github+json',
  });
  const me = await jsonRecord(meResponse);
  const accountId = typeof me?.id === 'number' ? String(me.id) : null;
  const login = typeof me?.login === 'string' ? me.login : null;
  if (!meResponse.ok || !accountId || !login) {
    logger.error(
      '{actor} authorized GitHub, but GET /user did not identify the account ({status}); the grant was not stored',
      {
        component: 'auth/oauth',
        ...actor,
        status: meResponse.status,
      }
    );
    return NextResponse.json({ error: 'Could not identify GitHub user' }, { status: 502 });
  }
  const displayName = typeof me?.name === 'string' && me.name ? me.name : login;

  const stored = await delegateGrants().commit({
    provider: GITHUB,
    handle,
    subject,
    accountId,
    displayName,
    clientId: app.clientId,
    requestedScopes: (requestedScopes || app.scopes).split(' '),
    metadata: { login },
  });
  if (!stored.ok) return storeFailed('GitHub', actor, stored.err);

  logger.info('{actor} connected GitHub as "{login}"; sent back to the connectors page', {
    component: 'auth/oauth',
    ...actor,
    accountId,
    login,
    githubUser: displayName,
  });
  recordAuditEvent({
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: GITHUB,
  });
  invalidateToolCatalogCache(subject);
  return NextResponse.redirect(new URL(`/connectors`, originResult.val));
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
  subject: string | null,
  code: string,
  requestedScopes: string | null
): Promise<NextResponse> {
  if (!subject) {
    logger.error(
      'a Microsoft 365 connect callback arrived on a pending row that names no person; no grant can be owned, so the person was sent to sign in again',
      { component: 'auth/oauth' }
    );
    return NextResponse.json(
      { error: 'Sign in again before connecting Microsoft' },
      { status: 400 }
    );
  }
  const actor = await whoIs(subject);

  const originResult = await getOrigin(request);
  if (!originResult.ok) return originFailed('Microsoft', actor, originResult.err);
  const app = await getMicrosoftApp(originResult.val);
  if (!app) {
    return NextResponse.json(
      { error: 'Microsoft integration not configured for this organization' },
      { status: 503 }
    );
  }

  const exchanged = await exchangeMicrosoftCode(
    'Microsoft',
    app,
    MICROSOFT,
    code,
    requestedScopes,
    actor
  );
  if (exchanged instanceof NextResponse) return exchanged;
  const { handle, oid, tid, upn, displayName, email } = exchanged;

  // A reconnect replaces the metadata wholesale, and the indexing opt-in
  // lives there — carry it over, or reconnecting silently turns a user's
  // indexing off.
  let carriedIndexing: Record<string, unknown> = {};
  {
    const prior = await getDataStore()
      .providerGrants.find(MICROSOFT, oid)
      .catch((error: unknown) => {
        logger.warn(
          '{actor} is reconnecting Microsoft 365, but their earlier grant could not be read; the indexing opt-in was not carried over: {error}',
          {
            component: 'auth/oauth',
            ...actor,
            accountId: oid,
            error: error instanceof Error ? error.message : String(error),
          }
        );
        return null;
      });
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
  if (!stored.ok) return storeFailed('Microsoft', actor, stored.err);

  // Subscription creation + initial delta backfill belong in the worker: the
  // Graph handshake POSTs to our webhook route while the create call is in
  // flight, and a backfill is minutes of work, not callback work.
  const enqueued = await webhookEventsQueue().producer.enqueue({
    source: MICROSOFT,
    type: 'grant.connected',
    payload: { accountId: oid, subject },
    orderingKey: `microsoft/${oid}`,
  });
  if (!enqueued.ok) {
    logger.warn(
      "{actor} connected Microsoft 365, but the grant.connected event was not queued; the worker's sweep will set up their Graph subscriptions and backfill instead: {error}",
      {
        component: 'auth/oauth',
        ...actor,
        accountId: oid,
        error: enqueued.err.message ?? 'unknown',
      }
    );
  }

  logger.info('{actor} connected Microsoft 365 as {upn}; sent back to the connectors page', {
    component: 'auth/oauth',
    ...actor,
    accountId: oid,
    tid,
    upn,
    microsoftUser: displayName ?? upn,
  });
  recordAuditEvent({
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: MICROSOFT,
  });
  invalidateToolCatalogCache(subject);
  return NextResponse.redirect(new URL(`/connectors`, originResult.val));
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
  provider: string,
  code: string,
  requestedScopes: string | null,
  actor: ActorFields
): Promise<MicrosoftExchange | NextResponse> {
  const exchanged = await delegateGrants().exchange({
    provider,
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: app.redirectUri,
      scope: requestedScopes || app.scopes,
    },
    directoryTenantId: app.directoryTenantId,
  });
  if (!exchanged.ok) return exchangeFailed(label, actor, exchanged.err);
  logExchanged(label, actor, exchanged.val);
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
    const pending = grantFetch({ provider, pending: handle });
    const meResponse = await pendingGet(pending, 'https://graph.microsoft.com/v1.0/me', actor);
    const me = await jsonRecord(meResponse);
    if (meResponse.ok && me) {
      oid = oid ?? (typeof me.id === 'string' ? me.id : null);
      upn = upn ?? (typeof me.userPrincipalName === 'string' ? me.userPrincipalName : null);
      displayName = displayName ?? (typeof me.displayName === 'string' ? me.displayName : null);
      email = email ?? (typeof me.mail === 'string' ? me.mail : null);
    }
  }
  if (!oid || !upn) {
    logger.error(
      '{actor} authorized {label}, but neither the id_token claims nor /me identified the account; the grant was not stored',
      {
        component: 'auth/oauth',
        ...actor,
        label,
      }
    );
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
  subject: string | null,
  code: string,
  requestedScopes: string | null
): Promise<NextResponse> {
  if (!subject) {
    logger.error(
      'an Entra Developer connect callback arrived on a pending row that names no person; no grant can be owned, so the person was sent to sign in again',
      { component: 'auth/oauth' }
    );
    return NextResponse.json(
      { error: 'Sign in again before connecting Entra Developer' },
      { status: 400 }
    );
  }
  const actor = await whoIs(subject);

  const originResult = await getOrigin(request);
  if (!originResult.ok) return originFailed('Entra Developer', actor, originResult.err);
  const app = await getEntraDeveloperApp(originResult.val);
  if (!app) {
    return NextResponse.json(
      { error: 'Entra Developer integration not configured for this organization' },
      { status: 503 }
    );
  }

  const exchanged = await exchangeMicrosoftCode(
    'Entra Developer',
    app,
    ENTRA_DEVELOPER,
    code,
    requestedScopes,
    actor
  );
  if (exchanged instanceof NextResponse) return exchanged;
  const { handle, oid, tid, upn, displayName, email } = exchanged;

  const stored = await delegateGrants().commit({
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
  if (!stored.ok) return storeFailed('Entra Developer', actor, stored.err);

  logger.info('{actor} connected Entra Developer as {upn}; sent back to the connectors page', {
    component: 'auth/oauth',
    ...actor,
    accountId: oid,
    tid,
    upn,
    microsoftUser: displayName ?? upn,
  });
  recordAuditEvent({
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: ENTRA_DEVELOPER,
  });
  invalidateToolCatalogCache(subject);
  return NextResponse.redirect(new URL(`/connectors`, originResult.val));
}

/* ------------------------------ Salesforce ------------------------------ */

/**
 * Complete a connect to one Salesforce connector (one org): the code is
 * traded at that org's own token endpoint, with that connector's app and
 * the PKCE verifier the authorize step stored. The token answer names the
 * org it was minted for (instance_url) and who granted it (the identity
 * URL, `…/id/<orgId>/<userId>`); a token from any org but this connector's
 * is refused here, before anything is stored — the delegate would refuse to
 * send it anywhere else anyway, and a grant nothing can use is not a
 * connection. The account id is `<orgId>/<userId>` (a sandbox keeps
 * production's user ids), the metadata names the connector, and a person
 * reconnecting the same connector — as another Salesforce user, say —
 * replaces their earlier connection to it rather than holding two.
 */
async function handleSalesforceCallback(
  kind: SalesforceKind,
  request: NextRequest,
  subject: string | null,
  code: string,
  requestedScopes: string | null,
  codeVerifier: string | null,
  connectorKey: string | null
): Promise<NextResponse> {
  if (!subject) {
    logger.error(
      'a Salesforce connect callback arrived on a pending row that names no person; no grant can be owned, so the person was sent to sign in again',
      { component: 'auth/oauth' }
    );
    return NextResponse.json(
      { error: 'Sign in again before connecting Salesforce' },
      { status: 400 }
    );
  }
  const actor = await whoIs(subject);
  if (!codeVerifier || !connectorKey) {
    logger.error(
      '{actor} came back from Salesforce, but the pending row carries no PKCE verifier or connector key; nothing was stored and the person was told to start the connection again',
      {
        component: 'auth/oauth',
        ...actor,
        hadCodeVerifier: Boolean(codeVerifier),
        connector: connectorKey,
      }
    );
    return NextResponse.json({ error: 'Start the Salesforce connection again' }, { status: 400 });
  }

  const originResult = await getOrigin(request);
  if (!originResult.ok) return originFailed('Salesforce', actor, originResult.err);
  const connector = await getSalesforceConnector(originResult.val, connectorKey, kind);
  if (!connector) {
    return NextResponse.json(
      { error: `That ${kind.label} connector is not set up, or is switched off` },
      { status: 503 }
    );
  }

  const exchanged = await delegateGrants().exchange({
    provider: kind.provider,
    org: connector.key,
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: connector.redirectUri,
      code_verifier: codeVerifier,
    },
  });
  if (!exchanged.ok) return exchangeFailed('Salesforce', actor, exchanged.err);
  logExchanged('Salesforce', actor, exchanged.val);
  const { handle, instanceUrl, identityUrl } = exchanged.val;

  if (!instanceUrl || !sameOrg(instanceUrl, connector.myDomain)) {
    logger.warn(
      "{actor} authorized Salesforce, but the token is for {tokenOrg} rather than the {connectorName} connector's org {myDomain}; refused, nothing was stored",
      {
        component: 'auth/oauth',
        ...actor,
        instanceUrl,
        tokenOrg: instanceUrl ?? '(no instance_url)',
        connector: connector.key,
        connectorName: connector.name,
        myDomain: connector.myDomain,
      }
    );
    return NextResponse.json(
      {
        error: 'That Salesforce login belongs to a different org',
        error_description: `Sign in to ${connector.host} (${connector.name}) and connect again.`,
      },
      { status: 403 }
    );
  }
  const identity = identityUrl ? parseIdentityUrl(identityUrl) : null;
  if (!identity) {
    logger.error(
      '{actor} authorized Salesforce ({connectorName}), but the token answer named no identity URL; the grant was not stored',
      {
        component: 'auth/oauth',
        ...actor,
        connector: connector.key,
        connectorName: connector.name,
      }
    );
    return NextResponse.json({ error: 'Could not identify Salesforce user' }, { status: 502 });
  }
  const orgId = to18(identity.orgId);
  const userId = to18(identity.userId);
  const accountId = salesforceAccountId(orgId, userId);

  // Who granted this, in words: name and username for the card.
  const pending = grantFetch({ provider: kind.provider, pending: handle });
  const infoResponse = await pendingGet(
    pending,
    `${connector.myDomain}/services/oauth2/userinfo`,
    actor
  );
  const info = infoResponse.ok ? await jsonRecord(infoResponse) : null;
  const username = typeof info?.preferred_username === 'string' ? info.preferred_username : userId;
  const displayName = typeof info?.name === 'string' && info.name ? info.name : username;

  const stored = await delegateGrants().commit({
    provider: kind.provider,
    handle,
    subject,
    accountId,
    displayName,
    clientId: connector.clientId,
    requestedScopes: (requestedScopes || connector.ceiling.join(' ')).split(' '),
    metadata: {
      orgId,
      userId,
      instanceUrl: connector.myDomain,
      username,
      connector: connector.key,
    },
  });
  if (!stored.ok) return storeFailed('Salesforce', actor, stored.err);

  // One connection per person per connector: an earlier one to this org as
  // someone else goes (revoked at Salesforce too).
  const earlier = (await listSalesforceConnections(subject, [connector], kind.provider)).filter(
    (connection) => connection.connector === connector.key && connection.accountId !== accountId
  );
  for (const connection of earlier) {
    await delegateGrants().revoke({ provider: kind.provider, accountId: connection.accountId });
  }

  logger.info(
    '{actor} connected Salesforce ({connectorName}) as {salesforceUser}{replacing}; sent back to the connectors page',
    {
      component: 'auth/oauth',
      ...actor,
      accountId,
      connector: connector.key,
      connectorName: connector.name,
      salesforceUser: username,
      replacing:
        earlier.length > 0
          ? `, replacing ${earlier.length} earlier connection(s) to it as someone else`
          : '',
    }
  );
  recordAuditEvent({
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: `${kind.provider}:${connector.key}`,
  });
  invalidateToolCatalogCache(subject);
  return NextResponse.redirect(new URL(`/connectors`, originResult.val));
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
  subject: string | null,
  code: string,
  requestedScopes: string | null
): Promise<NextResponse> {
  if (!subject) {
    logger.error(
      'a Zoom connect callback arrived on a pending row that names no person; no grant can be owned, so the person was sent to sign in again',
      { component: 'auth/oauth' }
    );
    return NextResponse.json({ error: 'Sign in again before connecting Zoom' }, { status: 400 });
  }
  const actor = await whoIs(subject);

  const originResult = await getOrigin(request);
  if (!originResult.ok) return originFailed('Zoom', actor, originResult.err);
  const app = await getZoomApp(originResult.val);
  if (!app) {
    return NextResponse.json(
      { error: 'Zoom integration not configured for this organization' },
      { status: 503 }
    );
  }

  const exchanged = await delegateGrants().exchange({
    provider: ZOOM,
    form: { grant_type: 'authorization_code', code, redirect_uri: app.redirectUri },
  });
  if (!exchanged.ok) return exchangeFailed('Zoom', actor, exchanged.err);
  logExchanged('Zoom', actor, exchanged.val);
  const handle = exchanged.val.handle;
  const pending = grantFetch({ provider: ZOOM, pending: handle });
  // The token-response echo names what the app was actually minted —
  // always the full Marketplace set, which is exactly why narrowing gates
  // on requested. The delegate relays it; Zoom tokens carry no scope claim.
  const scopeEcho = exchanged.val.scope;

  // The minted token must be able to say who it belongs to. When the echo
  // says user:read:user was not granted, /users/me can only fail — say why
  // instead of letting the 400 speak for itself (a granular Marketplace app
  // without the scope, or one that dropped it from the build flow).
  if (scopeEcho && !scopeEcho.split(/[\s,]+/).includes('user:read:user')) {
    logger.error(
      '{actor} authorized Zoom, but the token was minted without user:read:user, so the account cannot be identified; the grant was not stored',
      {
        component: 'auth/oauth',
        ...actor,
        scopeEcho,
      }
    );
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
  const meResponse = await pendingGet(pending, 'https://api.zoom.us/v2/users/me', actor);
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
    logger.error(
      '{actor} authorized Zoom, but /users/me did not identify them ({status}); the grant was not stored',
      {
        component: 'auth/oauth',
        ...actor,
        status: meResponse.status,
        body: meBodyText.slice(0, 300),
        scopeEcho: scopeEcho ?? '(none echoed)',
      }
    );
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
    provider: ZOOM,
    handle,
    subject,
    accountId: zoomUserId,
    displayName,
    clientId: app.clientId,
    requestedScopes: (requestedScopes || app.scopes).split(' '),
    metadata: { email, zoomAccountId: typeof me?.account_id === 'string' ? me.account_id : null },
  });
  if (!stored.ok) return storeFailed('Zoom', actor, stored.err);

  logger.info('{actor} connected Zoom as "{zoomUser}"; sent back to the connectors page', {
    component: 'auth/oauth',
    ...actor,
    accountId: zoomUserId,
    zoomUser: displayName,
    zoomEmail: email,
  });
  recordAuditEvent({
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: ZOOM,
  });
  invalidateToolCatalogCache(subject);
  return NextResponse.redirect(new URL(`/connectors`, originResult.val));
}

/* -------------------------------- OnBase -------------------------------- */

/**
 * Complete the connect flow of a remote MCP server. The server's own
 * authorization server issued the code, the delegate (which registered
 * Renkei there) exchanges it, and the tokens are sealed as the person's
 * grant under `mcp:<server id>`. The MCP authorization flow carries no
 * identity claim, so the grant is keyed by the person themselves — one
 * connection per person per server.
 */
async function handleMcpServerCallback(
  request: NextRequest,
  subject: string | null,
  code: string,
  requestedScopes: string | null,
  codeVerifier: string | null,
  serverId: string
): Promise<NextResponse> {
  if (!subject || !codeVerifier) {
    return NextResponse.json({ error: 'Start the connection again' }, { status: 400 });
  }
  const server = await getServer(serverId);
  if (!server.ok || !server.val || !server.val.enabled) {
    return NextResponse.json({ error: 'That MCP server is no longer available' }, { status: 404 });
  }
  const actor = await whoIs(subject);
  const provider = `mcp:${serverId}`;
  const label = server.val.name;
  const originResult = await getOrigin(request);
  if (!originResult.ok) return originFailed(label, actor, originResult.err);

  const exchanged = await delegateGrants().exchange({
    provider,
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: `${originResult.val}/api/oauth/callback`,
      code_verifier: codeVerifier,
      resource: server.val.url,
    },
  });
  if (!exchanged.ok) return exchangeFailed(label, actor, exchanged.err);
  logExchanged(label, actor, exchanged.val);

  const idClaims = exchanged.val.idToken ? decodeJwtPayload(exchanged.val.idToken) : null;
  const displayName =
    (typeof idClaims?.name === 'string' && idClaims.name) ||
    (typeof idClaims?.email === 'string' && idClaims.email) ||
    label;
  const stored = await delegateGrants().commit({
    provider,
    handle: exchanged.val.handle,
    subject,
    accountId: subject,
    displayName,
    clientId: server.val.clientId ?? '',
    requestedScopes: (requestedScopes ?? '').split(/\s+/).filter(Boolean),
    grantedScopes: exchanged.val.scope?.split(/\s+/).filter(Boolean),
    metadata: { serverUrl: server.val.url },
  });
  if (!stored.ok) return storeFailed(label, actor, stored.err);

  // The first listing, so the tools are there the moment the person lands
  // back on the page. A failure is not fatal: the cache refills on demand.
  const listed = await refreshToolList(server.val, subject);
  if (!listed.ok) {
    logger.warn(
      '{actor} connected MCP server "{label}", but its tools could not be listed right away ({reason}); the list fills on demand',
      {
        component: 'auth/oauth',
        ...actor,
        label,
        server: server.val.slug,
        reason: listed.reason,
      }
    );
  }
  ensureWatching(server.val, subject);
  logger.info(
    '{actor} connected MCP server "{label}" as "{mcpUser}"; sent back to the connectors page',
    {
      component: 'auth/oauth',
      ...actor,
      label,
      server: server.val.slug,
      mcpUser: displayName,
    }
  );
  recordAuditEvent({
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: `mcp-${server.val.slug}`,
  });
  invalidateToolCatalogCache(subject);
  return NextResponse.redirect(new URL(`/connectors`, originResult.val));
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
  subject: string | null,
  code: string,
  requestedScopes: string | null,
  codeVerifier: string | null,
  spec: OnBaseCallbackSpec
): Promise<NextResponse> {
  if (!subject) {
    logger.error(
      'a {label} connect callback arrived on a pending row that names no person; no grant can be owned, so the person was sent to sign in again',
      {
        component: 'auth/oauth',
        label: spec.label,
      }
    );
    return NextResponse.json(
      { error: `Sign in again before connecting ${spec.label}` },
      { status: 400 }
    );
  }
  const actor = await whoIs(subject);
  if (!codeVerifier) {
    // Every OnBase authorize stores one; a row without it is not ours.
    logger.error(
      '{actor} came back from {label}, but the pending row carries no PKCE verifier; nothing was stored and the person was told to start the connect again',
      {
        component: 'auth/oauth',
        ...actor,
        label: spec.label,
      }
    );
    return NextResponse.json({ error: `Start the ${spec.label} connect again` }, { status: 400 });
  }

  const originResult = await getOrigin(request);
  if (!originResult.ok) return originFailed(spec.label, actor, originResult.err);
  const app = await getOnBaseApp(originResult.val, spec.connector);
  if (!app) {
    return NextResponse.json(
      { error: `${spec.label} integration not configured for this organization` },
      { status: 503 }
    );
  }

  const exchanged = await delegateGrants().exchange({
    provider: spec.grantProvider,
    form: {
      grant_type: 'authorization_code',
      code,
      redirect_uri: app.redirectUri,
      code_verifier: codeVerifier,
    },
  });
  if (!exchanged.ok) return exchangeFailed(spec.label, actor, exchanged.err);
  logExchanged(spec.label, actor, exchanged.val);
  const { handle, idToken, hasRefreshToken } = exchanged.val;

  const idClaims = idToken ? decodeJwtPayload(idToken) : null;
  const accountId = typeof idClaims?.sub === 'string' ? idClaims.sub : null;
  if (!accountId) {
    // Without a subject there is no durable key to store the grant under.
    logger.error(
      '{actor} authorized {label}, but the id_token carried no sub claim, so the account cannot be identified; the grant was not stored',
      {
        component: 'auth/oauth',
        ...actor,
        label: spec.label,
        hadIdToken: idToken !== null,
      }
    );
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
    provider: spec.grantProvider,
    handle,
    subject,
    accountId,
    displayName,
    clientId: app.clientId,
    requestedScopes: (requestedScopes || `openid offline_access ${app.idpScopeName}`).split(' '),
    metadata: { issuer: app.idpIssuer },
  });
  if (!stored.ok) return storeFailed(spec.label, actor, stored.err);

  // No refresh token means the connection dies with this access token —
  // an IdP-side setting (offline_access), worth a log line now instead of
  // a mystery disconnect later.
  if (!hasRefreshToken) {
    logger.warn(
      '{actor} connected {label}, but without a refresh token (offline_access not granted?); the connection will end when the access token expires',
      {
        component: 'auth/oauth',
        ...actor,
        label: spec.label,
        accountId,
      }
    );
  }

  logger.info('{actor} connected {label} as "{onbaseUser}"; sent back to the connectors page', {
    component: 'auth/oauth',
    ...actor,
    label: spec.label,
    accountId,
    onbaseUser: displayName,
    issuer: app.idpIssuer,
  });
  recordAuditEvent({
    actorSubject: subject,
    action: 'connector.connected',
    targetKind: 'connector',
    targetLabel: spec.grantProvider,
  });
  invalidateToolCatalogCache(subject);
  return NextResponse.redirect(new URL(`/connectors`, originResult.val));
}
