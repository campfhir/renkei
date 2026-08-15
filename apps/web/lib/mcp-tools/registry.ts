/**
 * What this caller has, and what gets registered because of it.
 *
 * Both halves used to live inline in the MCP route, which was fine while the
 * route was the only thing that needed them. The tools page needs the same two
 * answers — which connectors is this person provisioned for, and which tools
 * does that actually produce — and a second copy would drift the first time a
 * connector was added, showing people a tool list their client does not have.
 * So the route and the page call this, and there is one answer.
 *
 * Registration performs no I/O: every tool's network and database work happens
 * inside its handler, never at registration time. That is what lets the page
 * enumerate the real tool set by registering into a collector rather than
 * guessing from a static catalog — and `tool-catalog.ts` depends on it, so if
 * a future tool starts doing work at registration, that is the thing to fix
 * rather than working around here.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import type { McpServer } from '@modelcontextprotocol/server';
import type { CapabilityProjection } from '@renkei/capability-registry';
import { WEBEX_USER, ATLASSIAN_CONFLUENCE, MICROSOFT, ZOOM } from '@renkei/provider-grants';
import { resolveEmbeddingProvider } from '@renkei/knowledge';
import { registerAllTools } from '@/lib/mcp-tools';
import { withCapabilityGate, JIRA_CONNECTOR } from '@/lib/mcp-tools/capability-gate';
import { registerKnowledgeTools, KNOWLEDGE_CONNECTOR } from '@/lib/mcp-tools/knowledge';
import { registerWebexUserTools, WEBEX_USER_MCP_CONNECTOR } from '@/lib/mcp-tools/webex';
import { oauthWebexAuth } from '@/lib/mcp-tools/webex/webex-auth';
import { registerOutlookTools, OUTLOOK_MCP_CONNECTOR } from '@/lib/mcp-tools/outlook';
import { registerSharePointTools, SHAREPOINT_MCP_CONNECTOR } from '@/lib/mcp-tools/sharepoint';
import { registerOneDriveTools, ONEDRIVE_MCP_CONNECTOR } from '@/lib/mcp-tools/onedrive';
import { oauthGraphAuth } from '@/lib/mcp-tools/graph/graph-auth';
import { registerZoomTools, ZOOM_MCP_CONNECTOR } from '@/lib/mcp-tools/zoom';
import { oauthZoomAuth } from '@/lib/mcp-tools/zoom/zoom-auth';
import { registerConfluenceTools, CONFLUENCE_MCP_CONNECTOR } from '@/lib/mcp-tools/confluence';
import { oauthConfluenceAuth } from '@/lib/mcp-tools/confluence/confluence-auth';
import { registerSummaryTools, type SummaryProvider } from '@/lib/mcp-tools/summary';
import { collectCalendar, collectUnreadMail } from '@/lib/mcp-tools/summary/collect-outlook';
import { collectSprint, collectWorkItems } from '@/lib/mcp-tools/summary/collect-jira';
import { collectZoom } from '@/lib/mcp-tools/summary/collect-zoom';
import { collectWebex } from '@/lib/mcp-tools/summary/collect-webex';
import {
  collectSharePointChanges,
  collectConfluenceChanges,
} from '@/lib/mcp-tools/summary/collect-docs';
import type { MCPToolContext } from '@/lib/mcp-tools/common';

/** Which connectors this caller has connected, and on what scopes. */
export interface ConnectorAvailability {
  knowledgeAvailable: boolean;
  webexAvailable: boolean;
  webexScopes: string[];
  microsoftAvailable: boolean;
  graphScopes: string[];
  sharepointAvailable: boolean;
  onedriveAvailable: boolean;
  zoomAvailable: boolean;
  zoomScopes: string[];
  confluenceAvailable: boolean;
  confluenceScopes: string[];
}

async function grantRow(
  db: Kysely<DB>,
  tenantId: string,
  provider: string,
  subject: string
): Promise<{ requested_scopes: string[]; granted_scopes: string[] | null } | undefined> {
  return db
    .selectFrom('provider_grants')
    .select(['requested_scopes', 'granted_scopes'])
    .where('tenant_id', '=', tenantId)
    .where('provider', '=', provider)
    .where('subject', '=', subject)
    .limit(1)
    .executeTakeFirst();
}

export async function resolveConnectorAvailability(
  db: Kysely<DB>,
  tenantId: string,
  subject: string
): Promise<ConnectorAvailability> {
  // The knowledge connector is provisioned org-wide when an embedding
  // provider is configured — its capabilities register only then.
  const knowledgeAvailable = (await resolveEmbeddingProvider(tenantId)) !== null;

  // The WebEx user tools register only when this caller has connected
  // their own WebEx account (the grant is per-user, unlike the org bot).
  // Its scopes gate which of those tools register.
  const webexGrantRow = await grantRow(db, tenantId, WEBEX_USER, subject);
  const webexAvailable = webexGrantRow !== undefined;
  // Gate on what the token actually carries when that is known; the
  // request is only the fallback for opaque tokens.
  const webexScopes = webexGrantRow
    ? (webexGrantRow.granted_scopes ?? webexGrantRow.requested_scopes)
    : [];

  // The Outlook tools register only when this caller has connected their
  // own Microsoft account. Same granted-over-requested rule as WebEx.
  const microsoftGrantRow = await grantRow(db, tenantId, MICROSOFT, subject);
  const microsoftAvailable = microsoftGrantRow !== undefined;
  const graphScopes = microsoftGrantRow
    ? (microsoftGrantRow.granted_scopes ?? microsoftGrantRow.requested_scopes)
    : [];
  // One Microsoft grant backs three namespaces, so which of them a caller
  // has is a question about the SCOPES on that grant, not about a separate
  // connection: someone who connected for mail alone has no SharePoint.
  const sharepointAvailable =
    microsoftAvailable && graphScopes.some((scope) => scope.startsWith('Sites.'));
  const onedriveAvailable =
    microsoftAvailable && graphScopes.some((scope) => scope.startsWith('Files.'));

  // Zoom inverts the rule: the token ALWAYS carries the Marketplace app's
  // full scope set (Zoom cannot narrow at consent), so bare granted would
  // erase the user's narrowing. Requested ∩ granted when both are known;
  // requested alone otherwise.
  const zoomGrantRow = await grantRow(db, tenantId, ZOOM, subject);
  const zoomAvailable = zoomGrantRow !== undefined;
  const zoomGranted = zoomGrantRow?.granted_scopes;
  const zoomScopes = zoomGrantRow
    ? zoomGranted
      ? zoomGrantRow.requested_scopes.filter((scope) => zoomGranted.includes(scope))
      : zoomGrantRow.requested_scopes
    : [];

  // The Confluence tools register only when this caller has connected the
  // third Atlassian app ("Renkei Confluence"). Same granted-over-requested
  // rule as WebEx/Microsoft — Confluence resolves its own access token
  // fresh per call (see confluence/client.ts), so only availability and
  // scopes are needed here.
  const confluenceGrantRow = await grantRow(db, tenantId, ATLASSIAN_CONFLUENCE, subject);
  const confluenceAvailable = confluenceGrantRow !== undefined;
  const confluenceScopes = confluenceGrantRow
    ? (confluenceGrantRow.granted_scopes ?? confluenceGrantRow.requested_scopes)
    : [];

  return {
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
  };
}

/**
 * The connectors a caller is provisioned for.
 *
 * Jira is unconditional: reaching either caller path at all requires their own
 * Jira grant.
 */
export function provisionedConnectorsFor(availability: ConnectorAvailability): string[] {
  return [
    JIRA_CONNECTOR,
    ...(availability.knowledgeAvailable ? [KNOWLEDGE_CONNECTOR] : []),
    ...(availability.webexAvailable ? [WEBEX_USER_MCP_CONNECTOR] : []),
    ...(availability.microsoftAvailable ? [OUTLOOK_MCP_CONNECTOR] : []),
    ...(availability.sharepointAvailable ? [SHAREPOINT_MCP_CONNECTOR] : []),
    ...(availability.onedriveAvailable ? [ONEDRIVE_MCP_CONNECTOR] : []),
    ...(availability.zoomAvailable ? [ZOOM_MCP_CONNECTOR] : []),
    ...(availability.confluenceAvailable ? [CONFLUENCE_MCP_CONNECTOR] : []),
  ];
}

/**
 * Register every tool this caller should have, each namespace behind its own
 * capability gate.
 *
 * The caller supplies the server, so the MCP route can hand in one wrapped in
 * usage tracking and the tools page can hand in one that only collects names.
 */
export async function registerRenkeiTools(
  server: McpServer,
  context: MCPToolContext,
  availability: ConnectorAvailability,
  projection: CapabilityProjection
): Promise<void> {
  const {
    webexAvailable,
    microsoftAvailable,
    sharepointAvailable,
    onedriveAvailable,
    zoomAvailable,
    confluenceAvailable,
  } = availability;

  await registerAllTools(withCapabilityGate(server, projection), context);
  await registerKnowledgeTools(
    withCapabilityGate(server, projection, KNOWLEDGE_CONNECTOR),
    context
  );
  if (webexAvailable) {
    // Production's one path: the caller's own WebEx grant. Anything else (a
    // future sandbox credential) is injected by whoever calls
    // registerWebexUserTools directly — see webex.no-sandbox.test.ts.
    await registerWebexUserTools(
      withCapabilityGate(server, projection, WEBEX_USER_MCP_CONNECTOR),
      context,
      oauthWebexAuth(context)
    );
  }
  if (microsoftAvailable) {
    await registerOutlookTools(
      withCapabilityGate(server, projection, OUTLOOK_MCP_CONNECTOR),
      context
    );
  }

  // Composed from the SAME availability the tool registration uses,
  // so the summary can never reach a source whose tools this caller
  // does not have. Order is the order it reads in.
  const declaredProviders: SummaryProvider[] = [
    ...(microsoftAvailable
      ? [
          {
            connector: OUTLOOK_MCP_CONNECTOR,
            label: 'Calendar',
            toolName: 'outlook_calendar_summary',
            collect: collectCalendar,
          },
          {
            connector: OUTLOOK_MCP_CONNECTOR,
            label: 'Unread mail',
            toolName: 'outlook_mail_summary',
            collect: collectUnreadMail,
          },
        ]
      : []),
    // Two Jira providers: a sprint is a STATE with its own dates,
    // work items are a WINDOW. Splitting them is what lets "what
    // moved yesterday" be asked without dragging the whole sprint in.
    {
      connector: JIRA_CONNECTOR,
      label: 'Sprint',
      toolName: 'sprint_summary',
      collect: collectSprint,
    },
    {
      connector: JIRA_CONNECTOR,
      label: 'Work items',
      toolName: 'work_item_summary',
      collect: collectWorkItems,
    },
    ...(sharepointAvailable
      ? [
          {
            connector: SHAREPOINT_MCP_CONNECTOR,
            label: 'SharePoint documents',
            toolName: 'sharepoint_summary',
            collect: collectSharePointChanges,
          },
        ]
      : []),
    ...(confluenceAvailable
      ? [
          {
            connector: CONFLUENCE_MCP_CONNECTOR,
            label: 'Confluence pages',
            toolName: 'confluence_summary',
            collect: collectConfluenceChanges,
          },
        ]
      : []),
    ...(zoomAvailable
      ? [
          {
            connector: ZOOM_MCP_CONNECTOR,
            label: 'Zoom meetings',
            toolName: 'zoom_summary',
            collect: collectZoom,
          },
        ]
      : []),
    ...(webexAvailable
      ? [
          {
            connector: WEBEX_USER_MCP_CONNECTOR,
            label: 'WebEx unread',
            toolName: 'webex_summary',
            collect: collectWebex,
          },
        ]
      : []),
  ];

  // Each provider is checked against its OWN connector before it is offered.
  // Availability above only asks whether the caller connected the account;
  // this asks whether the org still permits that connector at all. Without it
  // an admin who switched Microsoft off would keep `outlook_mail_summary` —
  // registered behind the Jira gate, since the summary tools share one
  // registration — and it would go on calling Graph. Filtering here covers
  // both the standalone tool and what `daily_summary` reaches, because the
  // orchestrator loops over exactly this list.
  const summaryProviders = declaredProviders.filter((provider) =>
    projection.allows({ id: provider.toolName, connector: provider.connector, kind: 'read' })
  );
  registerSummaryTools(
    withCapabilityGate(server, projection, JIRA_CONNECTOR),
    context,
    summaryProviders
  );

  // Production's one path for both: the caller's own Microsoft grant, one
  // instance shared since SharePoint and OneDrive both close over the same
  // context. Same reasoning as WebEx/Zoom above — see graph/graph-auth.ts.
  const graphAuth = oauthGraphAuth(context);
  if (sharepointAvailable) {
    await registerSharePointTools(
      withCapabilityGate(server, projection, SHAREPOINT_MCP_CONNECTOR),
      context,
      graphAuth
    );
  }
  if (onedriveAvailable) {
    await registerOneDriveTools(
      withCapabilityGate(server, projection, ONEDRIVE_MCP_CONNECTOR),
      context,
      graphAuth
    );
  }
  if (zoomAvailable) {
    // Production's one path: the caller's own Zoom grant. See webex's
    // identical comment above — the same reasoning applies here.
    await registerZoomTools(
      withCapabilityGate(server, projection, ZOOM_MCP_CONNECTOR),
      context,
      oauthZoomAuth(context)
    );
  }
  if (confluenceAvailable) {
    await registerConfluenceTools(
      withCapabilityGate(server, projection, CONFLUENCE_MCP_CONNECTOR),
      context,
      oauthConfluenceAuth(context)
    );
  }
}
