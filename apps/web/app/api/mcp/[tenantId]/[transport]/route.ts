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
import { attemptFromHeaders, withAttempt } from '@/lib/mcp-tools/attempt-context';
import { getOrgSettings } from '@renkei/settings';
import { getJiraGrant, type JiraGrant } from '@/lib/tenant-operations';
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
import { registerWidgetResources } from '@/lib/mcp-tools/widgets';
import { withRedaction } from '@/lib/mcp-tools/redaction-gate';
import {
  createPseudonymizer,
  deriveRedactionKey,
  knownDetectors,
  DEFAULT_MCP_POLICY,
} from '@renkei/redaction';
import { ATLASSIAN_JSM, getGrant, readAtlassianMetadata } from '@renkei/provider-grants';
import { parseEncryptionKey } from '@renkei/crypto';
import { getIdentityEmail } from '@/lib/identity';
import { createProjection } from '@renkei/capability-registry';
import { toolSurfaceVersion } from '@/lib/mcp-tools/surface-version';
import { getHandler, setHandler } from '@/lib/mcp-tools/handler-cache';
import type { MCPToolContext } from '@/lib/mcp-tools/common';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { McpServer } from '@modelcontextprotocol/server';

/**
 * Derived once per process from the deployment secret, so a given identifier
 * gets the same pseudonym in every request and every conversation. Deriving it
 * per call would still redact, but the tokens would stop being comparable,
 * which is most of what makes them useful.
 */
const redactionKeyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
const redactionKey = deriveRedactionKey(redactionKeyResult.ok ? redactionKeyResult.val : null);

/**
 * The caller's grant on the second Atlassian app ("Renkei JSM"), decrypted —
 * or null when they have not connected it (JSM tools then fall back to the
 * main grant). Effective scopes prefer what the token actually carries.
 *
 * Null for any OTHER reason is not a quiet fallback — the caller HAS a JSM
 * grant, and returning null makes every jsm_* tool vanish from this request's
 * tool list while the connect page still shows JSM connected. getGrant
 * refreshes the access token, so a transient Atlassian failure lands exactly
 * here; without the warns this presents as tools that "sometimes disappear"
 * with nothing in the logs to say why.
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

  const failed = (reason: string): null => {
    logger.warn(
      'JSM grant exists but could not be resolved ({reason}); jsm_* tools are absent this request',
      { component: 'mcp/transport', tenantId, subject, reason }
    );
    return null;
  };

  const keyResult = parseEncryptionKey(process.env.TOKEN_ENCRYPTION_KEY || '');
  if (!keyResult.ok) return failed('encryption key unavailable');
  const grantResult = await getGrant(
    ATLASSIAN_JSM,
    tenantId,
    row.provider_account_id,
    keyResult.val
  );
  if (!grantResult.ok) return failed('grant read/refresh failed');
  if (!grantResult.val) return failed('grant row disappeared');
  const grant = grantResult.val;
  const site = readAtlassianMetadata(grant.metadata);
  if (!site.cloudId) return failed('no cloudId in grant metadata');
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

    // Two token classes reach this endpoint: MCP-client tokens ('jira',
    // issued via the OAuth AS) and agent-runner tokens ('agent', minted by
    // the agents worker for one run under the owner's subject). Each class
    // is looked up explicitly — resolveAccessToken never matches across
    // applications — so accepting the second is a deliberate widening here,
    // not a loosening of the token store.
    const tokenRecord =
      (await resolveAccessToken(bearer, tenantId)) ??
      (await resolveAccessToken(bearer, tenantId, 'agent'));
    if (!tokenRecord) {
      logger.warn('Request with unknown or expired bearer token', {
        component: 'mcp/transport',
        tenantId,
      });
      return unauthorizedResponse(tenantId, origin, 'Invalid or expired access token');
    }

    const subject = tokenRecord.subject;
    // The acting agent, when this is an agent-runner token. Everything else
    // about the call is the OWNER's (subject, email, grants, gates) — this
    // only lets tools stamp agent provenance on what they write.
    const agentId = tokenRecord.application === 'agent' ? tokenRecord.agentId : null;

    // Captured before any of the reads below that feed tool registration
    // (Jira grant, connector availability, org settings, JSM grant, email):
    // those are several separate, unsynchronized round trips, and a write to
    // any table this version covers (surface-version.ts) landing among them
    // must never be reflected in `availability`/`context` while the cache
    // key built here still names the state from before that write — a
    // stale-tools-cached-under-a-fresh-key handler would then be served
    // deterministically for up to the cache's TTL instead of self-healing on
    // the next request. Reading the version first means the reverse can
    // happen instead — a slightly newer availability snapshot filed under a
    // slightly older key — which is harmless: the key it lands under either
    // already has a correct handler cached (a hit, this build is discarded)
    // or gets rebuilt correctly as soon as a request computes the new
    // version, exactly the "reuse whatever is cached, next request corrects
    // it" fallback this cache is designed around.
    const surfaceVersion = await toolSurfaceVersion(db, tenantId, subject);
    // Roles ride in the cache key, not just surfaceVersion: they come from
    // the token, not a row surfaceVersion watches, and two tokens for the
    // same subject can carry different roles (a re-authorize after the IdP
    // role changed) — without this, whichever request built the cached
    // handler first would pin its role-gated tool set for every later
    // caller of this subject until the TTL/version otherwise busts it.
    const roles = tokenRecord.roles;
    const cacheKey = `${tenantId}:${subject}:${agentId ?? 'none'}:${roles.join(',')}:${surfaceVersion}`;

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

    // Which connectors this caller has, resolved BEFORE the Jira decision:
    // a caller with no Jira but a Microsoft grant gets their real (Jira-less)
    // tool set below, same relaxation the tool catalog applies. Shared with
    // the tools page so the list it shows is the list this route registers.
    const availability = await resolveConnectorAvailability(db, tenantId, subject);
    const anyOtherConnector =
      availability.knowledgeAvailable ||
      availability.webexAvailable ||
      availability.microsoftAvailable ||
      availability.zoomAvailable ||
      availability.confluenceAvailable ||
      availability.filesharesAvailable ||
      availability.onbaseAvailable;

    if (grants.length === 0 && !anyOtherConnector) {
      // Nothing connected at all — serve only the jira_connect pointer.
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
          // We do NOT send notifications/tools/list_changed: nothing in this
          // codebase publishes one, and GET on this endpoint is 405, so there
          // is no stream for one to travel on. The SDK advertises the bit as
          // `true` by default the moment a tool is registered
          // (registerCapabilities uses `?? true`), which tells a client the
          // server will announce changes — an invitation to cache the tool
          // list indefinitely and wait for a notification that never comes.
          // Saying `false` is simply the truth, and leaves a client to
          // re-list on its own terms.
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: {
            name: 'Renkei MCP',
            // A fixed surface — one connect pointer — so a fixed version.
            version: '1.0.0+unconnected',
          },
          instructions: 'Jira authentication required',
          verboseLogs: false,
        }
      );

      return await mcpHandler(request);
    }

    let grant: JiraGrant | null = null;
    if (grants.length > 0) {
      const grantResult = await getJiraGrant(tenantId, grants[0].account_id);
      if (!grantResult.ok) {
        return new Response(JSON.stringify({ error: 'Failed to retrieve Jira grant' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      grant = grantResult.val;
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
    }
    const accountId = grant ? grants[0].account_id : '';

    // Org policy (read-only mode, limits) comes from the database per tenant.
    const settingsResult = await getOrgSettings(tenantId);
    if (!settingsResult.ok) {
      return NextResponse.json({ error: 'Settings error' }, { status: 500 });
    }
    const settings = settingsResult.val;

    if (grant) {
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
    }

    // The caller's recorded email (identity spine): what the knowledge gate
    // verifies provider access against. Absent = the gate fails closed.
    const emailResult = await getIdentityEmail(tenantId, subject);
    const userEmail = emailResult.ok ? emailResult.val : null;

    // Only what this scope still reads by name. The per-connector availability
    // flags used to be destructured here to build the cache key; the key is now
    // derived from row versions, and `availability` itself is what
    // registerRenkeiTools gates on.
    const {
      webexAvailable,
      webexScopes,
      microsoftAvailable,
      graphScopes,
      zoomAvailable,
      zoomScopes,
      confluenceAvailable,
      confluenceScopes,
      bitbucketAvailable,
      bitbucketScopes,
    } = availability;
    // No Jira grant → an empty scope list, which the scope gate reads as
    // "register no Jira/JSM tools" (never undefined — that means a legacy
    // grant with no provenance and passes everything).
    const jiraScopes = grant ? (grant.grantedScopes ?? grant.requestedScopes) : [];

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

    // cacheKey (identity plus a version derived from the rows the tool
    // surface is built from) was captured above, before availability/settings/
    // jsmGrant/email were read — see the comment there for why the ordering
    // matters. Re-checking here, rather than reusing a lookup from up there,
    // also picks up a handler a concurrent request may have finished building
    // in the meantime.
    let cachedHandler = getHandler(cacheKey);

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
            const tracked = withUsageTracking(rawServer, { tenantId, subject, agentId });

            // Outside usage tracking, so the timing it records includes the
            // filtering — that cost is real and belongs in the latency the
            // tools page shows. When redaction is switched off the server is
            // passed through unwrapped rather than wrapped in a no-op, the
            // same idiom withScopeGate uses for "gate not configured".
            const server = settings.redactionEnabled
              ? withRedaction(tracked, {
                  tenantId,
                  detectors: knownDetectors(settings.redactionDetectors),
                  mrnFormats: settings.redactionMrnFormats,
                  policy: DEFAULT_MCP_POLICY,
                  pseudonymizer: createPseudonymizer(redactionKey, tenantId),
                })
              : tracked;

            const context: MCPToolContext = {
              tenantId,
              accountId,
              siteUrl: grant?.siteUrl ?? '',
              apiBaseUrl: grant ? `https://api.atlassian.com/ex/jira/${grant.cloudId}` : '',
              cloudId: grant?.cloudId,
              accessToken: grant?.accessToken ?? '',
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
              bitbucketScopes: bitbucketAvailable ? bitbucketScopes : undefined,
              jsmGrant: jsmGrant ?? undefined,
              agent: agentId ? { agentId } : undefined,
              roles,
              db,
            };

            // Register all tools, filtered through the per-user capability
            // projection (RENKEI.md Decision #12). Org policy first: READ_ONLY
            // is the org-wide read-only capability flag, so mutating tools are
            // simply never registered under it. A caller without a Jira grant
            // still reaches here on their other connectors; the empty Jira
            // scope list keeps that namespace unregistered. Per-capability
            // user expose/hide choices arrive with the preferences UI.
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
                roles,
              }
            );
            await registerRenkeiTools(server, context, availability, projection);

            // A caller with other connectors but no Jira still gets the
            // pointer to connect it — as a normal tool, so it shows up in
            // their list without hijacking the whole server.
            if (!grant) {
              server.registerTool(
                'jira_connect',
                {
                  title: 'Jira · Read — Connect Jira',
                  annotations: { readOnlyHint: true },
                  description: `Jira is not connected. Click this link to authenticate: [Connect Jira](${origin})`,
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
            }

            // The MCP Apps widget templates (ui:// resources) go on the raw
            // server: the gate proxies only intercept registerTool, and a
            // template is inert until a preview tool that survived the gates
            // binds to it via _meta.ui.resourceUri — so per-user filtering
            // happens where it always has, on the tools.
            registerWidgetResources(rawServer);

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
          // We do NOT send notifications/tools/list_changed: nothing in this
          // codebase publishes one, and GET on this endpoint is 405, so there
          // is no stream for one to travel on. The SDK advertises the bit as
          // `true` by default the moment a tool is registered
          // (registerCapabilities uses `?? true`), which tells a client the
          // server will announce changes — an invitation to cache the tool
          // list indefinitely and wait for a notification that never comes.
          // Saying `false` is simply the truth, and leaves a client to
          // re-list on its own terms.
          capabilities: { tools: { listChanged: false }, resources: { listChanged: false } },
          serverInfo: {
            name: 'Renkei MCP',
            // The surface version rides in the build metadata, so a client
            // that keys anything off server identity sees this server change
            // when its tool set does. Costs nothing — it is the same value
            // the handler cache is keyed on, already computed above — and
            // even when a client ignores it, it says which surface a given
            // session is holding, which is most of what made the stale-tool
            // reports hard to diagnose.
            version: `1.0.0+${surfaceVersion}`,
          },
          instructions:
            'Renkei: org tools over MCP. Tools are named <connector>_<verb>_<noun> and titled ' +
            '"Connector · Read|Act". Connectors: Jira (jira_*), Jira Service Management ' +
            '(jsm_*, jsm_ops_*), WebEx (webex_*), Outlook/Microsoft 365 (outlook_*), ' +
            'SharePoint (sharepoint_*), OneDrive (onedrive_*), Confluence (confluence_*), ' +
            'Zoom (zoom_*), org network file shares (fileshare_*, SMB/SFTP, connected with ' +
            "the user's own credentials per share), OnBase document management (onbase_*, " +
            'no free-text search: queries scope to a document type or saved custom query ' +
            'and constrain keyword values — the tools resolve keyword/document-type NAMES ' +
            'to ids themselves), plus search_knowledge (org knowledge, access-verified ' +
            "per user), web_search (the public web through the org's Azure OpenAI web " +
            'search, with citations — for current or external facts, never org content), ' +
            'analyze_transcript (meeting transcript to suggested Jira actions) and whoami. ' +
            'Read tools are safe anywhere; Act tools change systems and are disabled in org ' +
            'read-only mode. Some Act tools have *_preview variants that render an ' +
            'interactive card for the user to confirm or cancel — prefer those whenever the ' +
            'user should review before something is sent or scheduled on their behalf. ' +
            'When a request covers many items, prefer a bulk read tool, one search with the ' +
            'right fields, or outlook_start_bulk_mail_job (an async job — poll ' +
            'outlook_get_bulk_mail_job rather than resubmitting) over calling a single-item ' +
            'tool once per item. Never generate file content as base64 tool arguments: to ' +
            "upload a file, call the destination's *_request_*_upload tool, send the raw " +
            'bytes to the returned short-lived endpoint (curl with the Authorization header, ' +
            'or the browser link), then confirm with check_file_upload; to attach a file ' +
            'that already lives in Microsoft 365 to a Jira issue, use jira_add_attachment ' +
            'with a driveItem or outlookAttachment source.',
          verboseLogs: false,
        }
      );

      // Store in cache
      setHandler(cacheKey, cachedHandler);
    } else {
      logger.debug('Using cached handler', { component: 'mcp/transport', tenantId, accountId });
    }

    // Handle the request with cached handler.
    //
    // The attempt rides in AsyncLocalStorage rather than on the context the
    // handler closed over: handlers are cached and shared, and this value
    // changes on every retry. See lib/mcp-tools/attempt-context.ts.
    return await withAttempt(attemptFromHeaders(request.headers), () => cachedHandler(request));
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
