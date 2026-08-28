/**
 * The tools a given caller actually has.
 *
 * There is no static list of tool names anywhere, and deliberately so: a
 * hand-maintained catalog would drift from the real surface the first time
 * someone added a tool and forgot, and the page would confidently show people
 * a tool their client cannot call. Instead this runs the SAME registration the
 * MCP route runs, through the SAME capability and scope gates, against a
 * server that only collects names. Whatever `tools/list` would return is what
 * comes back here, including the exclusions — a tool the gates refuse is never
 * registered, so it simply does not appear.
 *
 * This depends on registration being free of I/O (see `registry.ts`). The
 * context below carries no usable Jira token for that reason: enumeration must
 * never transact with a provider, and giving it a real token would invite a
 * future tool to do exactly that. Scopes ARE real, because the scope gates read
 * them at registration time and a faithful list depends on them.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getDatabase } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { createProjection } from '@renkei/capability-registry';
import { ATLASSIAN, ATLASSIAN_JSM } from '@renkei/provider-grants';
import { logger } from '@/lib/logger';
import type { MCPToolContext } from '@/lib/mcp-tools/common';
import { connectorKeyForTool } from '@/lib/mcp-tools/tool-connector';
import { resolveOutcomes, type ToolOutcomes } from '@/lib/mcp-tools/outcomes';
import {
  resolveConnectorAvailability,
  provisionedConnectorsFor,
  registerRenkeiTools,
} from '@/lib/mcp-tools/registry';

export interface ToolDescriptor {
  name: string;
  /** Catalog capability key, or null for a namespace this build does not know. */
  connector: string | null;
  /** Mutating tools are the ones an org read-only mode removes. */
  kind: 'read' | 'act';
  title: string | null;
  description: string | null;
  /**
   * Invoked only by a preview card's buttons (`_meta.ui.visibility: ['app']`)
   * — the model never sees it, so the tools page should not present it as
   * part of the model-facing surface.
   */
  appOnly: boolean;
  /**
   * The enumerated ways this tool can succeed or fail — what the agent
   * builder offers failure handling for. Always present; resolution falls
   * back through registration-declared → curated → generic (see outcomes.ts).
   */
  outcomes: ToolOutcomes;
}

/** The registration surface we need — the rest of McpServer is never touched. */
interface RegisteredConfig {
  title?: unknown;
  description?: unknown;
  annotations?: { readOnlyHint?: unknown };
  _meta?: { ui?: { visibility?: unknown }; outcomes?: unknown };
}

/**
 * A server that registers nothing and remembers everything.
 *
 * The gates call `registerTool` on whatever they wrap, so collecting at this
 * level sees exactly the tools that survived them.
 */
function collectingServer(): { server: McpServer; tools: ToolDescriptor[] } {
  const tools: ToolDescriptor[] = [];
  const collector = {
    registerTool: (name: string, config: RegisteredConfig) => {
      // Same rule the capability gate applies: an absent hint means mutating.
      const kind = config?.annotations?.readOnlyHint === true ? 'read' : 'act';
      tools.push({
        name,
        connector: connectorKeyForTool(name),
        kind,
        title: typeof config?.title === 'string' ? config.title : null,
        description: typeof config?.description === 'string' ? config.description : null,
        appOnly:
          Array.isArray(config?._meta?.ui?.visibility) &&
          !config._meta.ui.visibility.includes('model'),
        outcomes: resolveOutcomes(name, kind, config?._meta),
      });
    },
  };
  // The collector implements the one method registration uses. The assertion
  // is confined to this line rather than spread through the module.
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions
  return { server: collector as unknown as McpServer, tools };
}

async function jiraScopesFor(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<{ connected: boolean; scopes: string[]; accountId: string | null }> {
  // Read straight from the grant row rather than through `getJiraGrant`: that
  // path refreshes the access token, and rendering a page must not mutate
  // anyone's credentials.
  const row = await db
    .selectFrom('provider_grants')
    .select(['provider_account_id', 'requested_scopes', 'granted_scopes'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', ATLASSIAN)
    .where('subject', '=', subject)
    .limit(1)
    .executeTakeFirst();
  if (!row) return { connected: false, scopes: [], accountId: null };
  return {
    connected: true,
    scopes: row.granted_scopes ?? row.requested_scopes,
    accountId: row.provider_account_id,
  };
}

/**
 * The caller's grant on the second Atlassian app ("Renkei JSM"), scopes only.
 *
 * The MCP route swaps this grant's scopes in before registering the JSM/Ops
 * families (registerAllTools), so the catalog must too or every jsm_* tool
 * silently vanishes from the builder while the live server still serves it —
 * post-split, the main grant no longer carries the JSM scopes. Read straight
 * from the grant row like jiraScopesFor above: no token is decrypted or
 * refreshed, because enumeration must never be able to transact.
 */
async function jsmGrantScopesFor(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<{ accountId: string; scopes: string[] } | null> {
  const row = await db
    .selectFrom('provider_grants')
    .select(['provider_account_id', 'requested_scopes', 'granted_scopes'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', ATLASSIAN_JSM)
    .where('subject', '=', subject)
    .limit(1)
    .executeTakeFirst();
  if (!row) return null;
  return {
    accountId: row.provider_account_id,
    scopes: row.granted_scopes ?? row.requested_scopes,
  };
}

/**
 * Every tool this caller would be offered over MCP right now.
 *
 * A caller who has not connected Jira still gets their real list: the scope
 * gate registers no Jira/JSM tools for an empty scope set, and every other
 * connector's availability is its own question. (This used to return [] to
 * mirror the MCP route's jira_connect stub; the agent builder needs the
 * honest per-connector answer instead, and the gates already give it.)
 */
export async function listAvailableTools(
  tenantId: string,
  subject: string
): Promise<ToolDescriptor[]> {
  const dbResult = getDatabase();
  if (!dbResult.ok) return [];
  const db = dbResult.val;

  const [jira, jsm] = await Promise.all([
    jiraScopesFor(db, tenantId, subject),
    jsmGrantScopesFor(db, tenantId, subject),
  ]);

  const settingsResult = await getOrgSettings(tenantId);
  if (!settingsResult.ok) return [];
  const settings = settingsResult.val;

  const availability = await resolveConnectorAvailability(db, tenantId, subject);
  const projection = createProjection(
    {
      readOnly: settings.readOnly,
      disabledConnectors: settings.disabledConnectors,
      disabledCapabilities: [],
    },
    { provisionedConnectors: provisionedConnectorsFor(availability), hiddenCapabilities: [] }
  );

  const context: MCPToolContext = {
    tenantId,
    accountId: jira.accountId ?? '',
    // Deliberately empty: enumeration must not be able to call a provider.
    siteUrl: '',
    apiBaseUrl: '',
    accessToken: '',
    maxJqlResults: settings.maxJqlResults,
    maxAttachmentBytes: settings.maxAttachmentBytes,
    subject,
    grantedScopes: jira.scopes,
    webexScopes: availability.webexAvailable ? availability.webexScopes : undefined,
    graphScopes: availability.microsoftAvailable ? availability.graphScopes : undefined,
    zoomScopes: availability.zoomAvailable ? availability.zoomScopes : undefined,
    confluenceScopes: availability.confluenceAvailable ? availability.confluenceScopes : undefined,
    bitbucketScopes: availability.bitbucketAvailable ? availability.bitbucketScopes : undefined,
    // Scopes real, credentials deliberately empty — same reasoning as the
    // token fields above: the JSM scope gates read these at registration,
    // and nothing here may be able to reach Atlassian.
    jsmGrant: jsm
      ? { accessToken: '', cloudId: '', accountId: jsm.accountId, scopes: jsm.scopes }
      : undefined,
    db,
  };

  const { server, tools } = collectingServer();
  try {
    await registerRenkeiTools(server, context, availability, projection);
  } catch (error) {
    // A page that cannot enumerate should show usage without the catalog
    // rather than fail outright.
    logger.warn('tool catalog enumeration failed: {error}', {
      component: 'mcp/catalog',
      tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }

  return tools.sort((a, b) => a.name.localeCompare(b.name));
}
