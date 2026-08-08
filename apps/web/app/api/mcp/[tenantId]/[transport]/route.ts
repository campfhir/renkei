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
import { registerAllTools, cacheTokenMetadata, cacheUserDisplayName } from '@/lib/mcp-tools';
import { withCapabilityGate, JIRA_CONNECTOR } from '@/lib/mcp-tools/capability-gate';
import { registerKnowledgeTools, KNOWLEDGE_CONNECTOR } from '@/lib/mcp-tools/knowledge';
import { registerWebexUserTools, WEBEX_USER_MCP_CONNECTOR } from '@/lib/mcp-tools/webex';
import { WEBEX_USER } from '@renkei/provider-grants';
import { getIdentityEmail } from '@/lib/identity';
import { resolveEmbeddingProvider } from '@renkei/knowledge';
import { createProjection } from '@renkei/capability-registry';
import type { MCPToolContext } from '@/lib/mcp-tools/common';
import type { McpServer } from '@modelcontextprotocol/server';

// Cache MCP handlers per (tenantId, accountId)
const handlerCache = new Map<string, (request: Request) => Promise<Response>>();

function getCacheKey(
  tenantId: string,
  accountId: string,
  readOnly: boolean,
  knowledgeAvailable: boolean,
  webexAvailable: boolean,
  userEmail: string | null
): string {
  // Everything the registered tool set or a handler closure depends on must
  // be part of the key, or a change takes effect only on process restart:
  // the org's read-only mode, whether the knowledge layer is provisioned,
  // whether this caller holds a WebEx user grant, and the caller's recorded
  // email (captured by search_knowledge's closure).
  return `${tenantId}:${accountId}:${readOnly ? 'ro' : 'rw'}:${knowledgeAvailable ? 'k' : 'nk'}:${webexAvailable ? 'w' : 'nw'}:${userEmail ?? ''}`;
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
      logger.warn('[MCP] Request without bearer token', { tenantId });
      return unauthorizedResponse(tenantId, origin, 'Authorization required');
    }

    const tokenRecord = await resolveAccessToken(bearer, tenantId);
    if (!tokenRecord) {
      logger.warn('[MCP] Request with unknown or expired bearer token', { tenantId });
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
      // No grant found - register only the connect_jira tool
      const mcpHandler = createMcpHandler(
        async (server: McpServer) => {
          server.registerTool(
            'connect_jira',
            {
              title: 'Connect Jira',
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
            name: 'Jira Renkei MCP',
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
    cacheTokenMetadata(grant.accessToken, tenantId, accountId);

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

    // The knowledge connector is provisioned org-wide when an embedding
    // provider is configured — its capabilities register only then.
    const knowledgeAvailable = (await resolveEmbeddingProvider(tenantId)) !== null;

    // The WebEx user tools register only when this caller has connected
    // their own WebEx account (the grant is per-user, unlike the org bot).
    const webexGrantRow = await db
      .selectFrom('provider_grants')
      .select('provider_account_id')
      .where('tenant_id', '=', tenantId)
      .where('provider', '=', WEBEX_USER)
      .where('subject', '=', subject)
      .limit(1)
      .executeTakeFirst();
    const webexAvailable = webexGrantRow !== undefined;

    // Check cache
    const cacheKey = getCacheKey(
      tenantId,
      accountId,
      settings.readOnly,
      knowledgeAvailable,
      webexAvailable,
      userEmail
    );
    let cachedHandler = handlerCache.get(cacheKey);

    if (!cachedHandler) {
      logger.info('[MCP] Creating new handler (cache miss)', { tenantId, accountId });

      // Create MCP handler with tool registration
      cachedHandler = createMcpHandler(
        async (server: McpServer) => {
          try {
            logger.info('[MCP] Server created', { tenantId, accountId });

            const context: MCPToolContext = {
              tenantId,
              accountId,
              siteUrl: grant.siteUrl,
              apiBaseUrl: `https://api.atlassian.com/ex/jira/${grant.cloudId}`,
              accessToken: grant.accessToken,
              maxJqlResults: settings.maxJqlResults,
              maxAttachmentBytes: settings.maxAttachmentBytes,
              origin,
              userEmail: userEmail ?? undefined,
              subject,
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
                disabledConnectors: [],
                disabledCapabilities: [],
              },
              {
                provisionedConnectors: [
                  JIRA_CONNECTOR,
                  ...(knowledgeAvailable ? [KNOWLEDGE_CONNECTOR] : []),
                  ...(webexAvailable ? [WEBEX_USER_MCP_CONNECTOR] : []),
                ],
                hiddenCapabilities: [],
              }
            );
            await registerAllTools(withCapabilityGate(server, projection), context);
            await registerKnowledgeTools(
              withCapabilityGate(server, projection, KNOWLEDGE_CONNECTOR),
              context
            );
            if (webexAvailable) {
              await registerWebexUserTools(
                withCapabilityGate(server, projection, WEBEX_USER_MCP_CONNECTOR),
                context
              );
            }

            logger.info('[MCP] All tools registered', {
              tenantId,
              accountId,
            });
          } catch (err) {
            logger.error('[MCP] Tool registration failed', {
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
            name: 'Jira Renkei MCP',
            version: '1.0.0',
          },
          instructions: 'Jira work item management via MCP',
          verboseLogs: false,
        }
      );

      // Store in cache
      handlerCache.set(cacheKey, cachedHandler);
    } else {
      logger.debug('[MCP] Using cached handler', { tenantId, accountId });
    }

    // Handle the request with cached handler
    return await cachedHandler(request);
  } catch (error) {
    logger.error('[MCP Handler Error] {error}', {
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
