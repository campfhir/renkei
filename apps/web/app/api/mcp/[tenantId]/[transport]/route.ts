/**
 * MCP HTTP endpoint using mcp-handler.
 *
 * Handles JSON-RPC 2.0 messages via HTTP POST.
 * Caches server per (tenantId, accountId) to avoid recreating and registering
 * 43+ tools on every request. Cache persists for the lifetime of the Next.js process.
 */

import { NextRequest, NextResponse } from 'next/server';
import { createMcpHandler } from 'mcp-handler';
import { getDatabase } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { getJiraGrant } from '@/lib/tenant-operations';
import { getOrigin } from '@/lib/get-origin';
import { getBearerToken, resolveAccessToken, unauthorizedResponse } from '@/lib/mcp-token';
import { logger } from '@/lib/logger';
import { cacheTokenMetadata, cacheUserDisplayName } from '@/lib/mcp-tools';
import {
  resolveConnectorAvailability,
  provisionedConnectorsFor,
  registerRenkeiTools,
} from '@/lib/mcp-tools/registry';
import { withUsageTracking } from '@/lib/mcp-tools/usage-tracking';
import { ATLASSIAN_JSM, getGrant, readAtlassianMetadata } from '@renkei/provider-grants';
import { parseEncryptionKey } from '@renkei/crypto';
import { getIdentityEmail } from '@/lib/identity';
import { createProjection } from '@renkei/capability-registry';
import type { MCPToolContext } from '@/lib/mcp-tools/common';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { McpServer } from '@modelcontextprotocol/server';

// Cache MCP handlers per (tenantId, accountId)
const handlerCache = new Map<string, (request: Request) => Promise<Response>>();

function getCacheKey(
  tenantId: string,
  accountId: string,
  readOnly: boolean,
  knowledgeAvailable: boolean,
  webexAvailable: boolean,
  microsoftAvailable: boolean,
  sharepointAvailable: boolean,
  onedriveAvailable: boolean,
  zoomAvailable: boolean,
  confluenceAvailable: boolean,
  userEmail: string | null,
  disabledConnectors: readonly string[]
): string {
  // Everything the registered tool set or a handler closure depends on must
  // be part of the key, or a change takes effect only on process restart:
  // the org's read-only mode, whether the knowledge layer is provisioned,
  // which per-user connector grants this caller holds, and the caller's
  // recorded email (captured by search_knowledge's closure).
  return (
    `${tenantId}:${accountId}:${readOnly ? 'ro' : 'rw'}:${knowledgeAvailable ? 'k' : 'nk'}:` +
    `${webexAvailable ? 'w' : 'nw'}:${microsoftAvailable ? 'm' : 'nm'}:${zoomAvailable ? 'z' : 'nz'}:` +
    `${sharepointAvailable ? 's' : 'ns'}:${onedriveAvailable ? 'o' : 'no'}:` +
    `${confluenceAvailable ? 'c' : 'nc'}:${userEmail ?? ''}:` +
    // Sorted, so the same set in a different order is the same key rather
    // than a needless cache miss.
    `${[...disabledConnectors].sort().join(',')}`
  );
}

/**
 * The caller's grant on the second Atlassian app ("Renkei JSM"), decrypted —
 * or null when they have not connected it (JSM tools then fall back to the
 * main grant). Effective scopes prefer what the token actually carries.
 */
async function resolveJsmGrant(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<{ accessToken: string; cloudId: string; accountId: string; scopes?: string[] } | null> {
  const row = await db
    .selectFrom('provider_grants')
    .select(['provider_account_id'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', ATLASSIAN_JSM)
    .where('subject', '=', subject)
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return null;
  const grantResult = await getGrant(
    ATLASSIAN_JSM,
    tenantId,
    row.provider_account_id,
    keyResult.val
  );
  if (!grantResult.ok || !grantResult.val) return null;
  const grant = grantResult.val;
  const site = readAtlassianMetadata(grant.metadata);
  if (!site.cloudId) return null;
  return {
    accessToken: grant.accessToken,
    cloudId: site.cloudId,
    accountId: grant.accountId,
    scopes: grant.grantedScopes ?? grant.requestedScopes,
  };
}

const handler = async (
  request: NextRequest,
  { params }: { params: Promise<{ tenantId: string; transport: string }> }
): Promise<Response> => {
  const { tenantId } = await params;
  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return NextResponse.json({ error: 'Database error' }, { status: 500 });
  }
  const db = dbResult.val;

  // request.url is the internal URL behind a reverse proxy (localhost:3000), so any
  // link built from it is unreachable for the user. getOrigin resolves the public one.
  const originResult = await getOrigin(request);
  if (!originResult.ok) {
    return NextResponse.json({ error: 'Config error' }, { status: 500 });
  }
  const origin = originResult.val;

  try {
    // Verify tenant exists
    const tenant = await db
      .selectFrom('tenants')
      .select('id')
      .where('id', '=', tenantId)
      .executeTakeFirst();

    if (!tenant) {
      return new Response(JSON.stringify({ error: 'Tenant not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Identify the caller. Without this the server cannot tell one user of a
    // tenant from another and previously acted as whichever grant came back
    // first — attributing every comment, transition and worklog to that account.
    const bearer = getBearerToken(request);
    if (!bearer) {
      logger.warn('Request without bearer token', { component: 'mcp/transport', tenantId });
      return unauthorizedResponse(tenantId, origin, 'Authorization required');
    }

    const tokenRecord = await resolveAccessToken(bearer, tenantId);
    if (!tokenRecord) {
      logger.warn('Request with unknown or expired bearer token', {
        component: 'mcp/transport',
        tenantId,
      });
      return unauthorizedResponse(tenantId, origin, 'Invalid or expired access token');
    }

    const subject = tokenRecord.subject;

    // This caller's own Jira grant. A grant with a NULL subject predates per-user
    // ownership and is deliberately not matched: we cannot prove it belongs to
    // this caller, and serving it would let one user act as another in Jira.
    const grants = await db
      .selectFrom('provider_grants')
      .select(['provider_account_id as account_id'])
      .where('tenant_id', '=', tenantId)
      .where('provider', '=', 'atlassian')
      .where('subject', '=', subject)
      .limit(1)
      .execute();

    if (grants.length === 0) {
      // No grant found - register only the jira_connect tool
      const mcpHandler = createMcpHandler(
        async (server: McpServer) => {
          server.registerTool(
            'jira_connect',
            {
              title: 'Jira · Read — Connect Jira',
              annotations: { readOnlyHint: true },
              description:
                'Jira is not connected. Click this link to authenticate: [Connect Jira](' +
                origin +
                ')',
            },
            async () => ({
              content: [
                {
                  type: 'text' as const,
                  text: `Jira is not connected. Please authenticate: [Connect Jira](${origin})`,
                },
              ],
            })
          );
        },
        {
          serverInfo: {
            name: 'Renkei MCP',
            version: '1.0.0',
          },
          instructions: 'Jira authentication required',
          verboseLogs: false,
        }
      );

      return await mcpHandler(request);
    }

    const accountId = grants[0].account_id;
    const grantResult = await getJiraGrant(tenantId, accountId);
    if (!grantResult.ok) {
      return new Response(JSON.stringify({ error: 'Failed to retrieve Jira grant' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const grant = grantResult.val;
    if (!grant) {
      // Grant was deleted during refresh (GRANT_REVOKED) - direct user to re-authenticate.
      // Link to the origin, not the Jira authorize endpoint: the user has to sign in to
      // the MCP first, otherwise the Atlassian grant would be bound without authentication.
      return new Response(
        JSON.stringify({
          error: 'Jira grant revoked',
          message: `Your Jira authentication has expired or was revoked. Please re-authenticate: [Connect Jira](${origin})`,
        }),
        { status: 400, headers: { 'Content-Type': 'application/json' } }
      );
    }

    // Org policy (read-only mode, limits) comes from the database per tenant.
    const settingsResult = await getOrgSettings(tenantId);
    if (!settingsResult.ok) {
      return NextResponse.json({ error: 'Settings error' }, { status: 500 });
    }
    const settings = settingsResult.val;

    // Record the grant's token on every request, not just at handler creation:
    // the cached handler's closure holds whatever token existed when it was
    // built, and jiraFetch resolves the current one through this cache. This
    // also picks up tokens rotated by another process, since the grant above
    // is read fresh from the database each request.
    cacheTokenMetadata(grant.accessToken, tenantId, accountId, subject);

    // Seed the display-name cache from the grant's durable record. The cache
    // is in-memory, so a restarted container logged every tool call with
    // displayName: null until the user happened to reconnect or ask who they
    // are — while provider_grants.display_name held the answer all along.
    if (grant.displayName) {
      cacheUserDisplayName(accountId, grant.displayName);
    }

    // The caller's recorded email (identity spine): what the knowledge gate
    // verifies provider access against. Absent = the gate fails closed.
    const emailResult = await getIdentityEmail(tenantId, subject);
    const userEmail = emailResult.ok ? emailResult.val : null;

    // Which connectors this caller has, and on what scopes. Shared with the
    // tools page so the list it shows is the list this route registers.
    const availability = await resolveConnectorAvailability(db, tenantId, subject);
    const {
      knowledgeAvailable,
      webexAvailable,
      webexScopes,
      microsoftAvailable,
      graphScopes,
      sharepointAvailable,
      onedriveAvailable,
      zoomAvailable,
      zoomScopes,
      confluenceAvailable,
      confluenceScopes,
    } = availability;
    const jiraScopes = grant.grantedScopes ?? grant.requestedScopes;

    // The second Atlassian app's grant ("Renkei JSM": JSM + Ops scopes) —
    // JSM/Ops tools run on this token when it exists; absent, they fall back
    // to the main grant, the pre-split single-app shape.
    const jsmGrant = await resolveJsmGrant(db, tenantId, subject);
    if (jsmGrant) {
      cacheTokenMetadata(
        jsmGrant.accessToken,
        tenantId,
        jsmGrant.accountId,
        subject,
        ATLASSIAN_JSM
      );
    }
    const jsmScopes = jsmGrant?.scopes ?? [];

    // Check cache. The tool set now varies with every grant's scopes, so they
    // are part of the key — a reconnect with different scopes must not be
    // served a handler built for the old ones.
    const scopeFingerprint =
      `${[...jiraScopes].sort().join(',')}|${[...webexScopes].sort().join(',')}|` +
      `${[...jsmScopes].sort().join(',')}:${jsmGrant ? 'jsm' : 'nojsm'}|` +
      `${[...graphScopes].sort().join(',')}|${[...zoomScopes].sort().join(',')}|` +
      `${[...confluenceScopes].sort().join(',')}`;
    const cacheKey =
      getCacheKey(
        tenantId,
        accountId,
        settings.readOnly,
        knowledgeAvailable,
        webexAvailable,
        microsoftAvailable,
        sharepointAvailable,
        onedriveAvailable,
        zoomAvailable,
        confluenceAvailable,
        userEmail,
        settings.disabledConnectors
      ) + `:${scopeFingerprint}`;
    let cachedHandler = handlerCache.get(cacheKey);

    if (!cachedHandler) {
      logger.debug('Creating new handler (cache miss)', {
        component: 'mcp/transport',
        tenantId,
        accountId,
      });

      // Create MCP handler with tool registration
      cachedHandler = createMcpHandler(
        async (rawServer: McpServer) => {
          try {
            logger.verbose('Server created', { component: 'mcp/transport', tenantId, accountId });

            // Outermost wrapper, so it observes exactly the tools that
            // actually register: the gates inside it drop the ones this user
            // may not have, and a tool that was never registered cannot be
            // called and so should never appear in usage.
            const server = withUsageTracking(rawServer, { tenantId, subject });

            const context: MCPToolContext = {
              tenantId,
              accountId,
              siteUrl: grant.siteUrl,
              apiBaseUrl: `https://api.atlassian.com/ex/jira/${grant.cloudId}`,
              cloudId: grant.cloudId,
              accessToken: grant.accessToken,
              maxJqlResults: settings.maxJqlResults,
              maxAttachmentBytes: settings.maxAttachmentBytes,
              origin,
              userEmail: userEmail ?? undefined,
              subject,
              grantedScopes: jiraScopes,
              webexScopes: webexAvailable ? webexScopes : undefined,
              graphScopes: microsoftAvailable ? graphScopes : undefined,
              zoomScopes: zoomAvailable ? zoomScopes : undefined,
              confluenceScopes: confluenceAvailable ? confluenceScopes : undefined,
              jsmGrant: jsmGrant ?? undefined,
              db,
            };

            // Register all tools, filtered through the per-user capability
            // projection (RENKEI.md Decision #12). Org policy first: READ_ONLY
            // is the org-wide read-only capability flag, so mutating tools are
            // simply never registered under it. This caller reached here with
            // their own Jira grant, so the jira connector is provisioned;
            // per-capability user expose/hide choices arrive with the
            // preferences UI.
            const projection = createProjection(
              {
                readOnly: settings.readOnly,
                // The org-admin's org-wide off switch (Connector setup →
                // Available connectors). Unlike narrowing the scope ceiling,
                // this touches no grant, so flipping it back restores the
                // tools without anyone reconnecting.
                disabledConnectors: settings.disabledConnectors,
                disabledCapabilities: [],
              },
              {
                provisionedConnectors: provisionedConnectorsFor(availability),
                hiddenCapabilities: [],
              }
            );
            await registerRenkeiTools(server, context, availability, projection);

            logger.verbose('All tools registered', {
              component: 'mcp/transport',
              tenantId,
              accountId,
            });
          } catch (err) {
            logger.error('Tool registration failed', {
              component: 'mcp/transport',
              tenantId,
              accountId,
              error: err instanceof Error ? err.message : String(err),
              cause:
                err instanceof AggregateError
                  ? err.errors.map((e) => (e instanceof Error ? e.message : String(e)))
                  : undefined,
            });
            throw err;
          }
        },
        {
          serverInfo: {
            name: 'Renkei MCP',
            version: '1.0.0',
          },
          instructions:
            'Renkei: org tools over MCP. Tools are named <connector>_<verb>_<noun> and titled ' +
            '"Connector · Read|Act". Connectors: Jira (jira_*), Jira Service Management ' +
            '(jsm_*, jsm_ops_*), WebEx (webex_*), Outlook/Microsoft 365 (outlook_*), ' +
            'SharePoint (sharepoint_*), OneDrive (onedrive_*), Confluence (confluence_*), ' +
            'Zoom (zoom_*), plus search_knowledge (org knowledge, access-verified per user), ' +
            'analyze_transcript (meeting transcript to suggested Jira actions) and whoami. ' +
            'Read tools are safe anywhere; Act tools change systems and are disabled in org ' +
            'read-only mode.',
          verboseLogs: false,
        }
      );

      // Store in cache
      handlerCache.set(cacheKey, cachedHandler);
    } else {
      logger.debug('Using cached handler', { component: 'mcp/transport', tenantId, accountId });
    }

    // Handle the request with cached handler
    return await cachedHandler(request);
  } catch (error) {
    logger.error('{error}', {
      component: 'mcp/transport',
      error: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    });
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        error: {
          code: -32603,
          message: `Internal server error: ${error instanceof Error ? error.message : String(error)}`,
        },
        id: null,
      }),
      { status: 500, headers: { 'Content-Type': 'application/json' } }
    );
  }
};

export { handler as GET, handler as POST, handler as DELETE };
