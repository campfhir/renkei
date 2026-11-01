import React from 'react';
import { redirect } from 'next/navigation';
import { getDataStore } from '@renkei/db';
import { wrapAsync } from '@campfhir/safe-functions/helpers';
import {
  countAwaitingReview as countJiraAwaitingReview,
  countPendingChangeRequests,
} from '@/lib/jira-admin/change-requests';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import AtlassianConnector from './atlassian-connector';
import WebexUserConnector from './webex-user-connector';
import MicrosoftConnector from './microsoft-connector';
import EntraDeveloperConnector from './entra-developer-connector';
import ZoomConnector from './zoom-connector';
import GitHubConnector from './github-connector';
import SalesforceConnector, { SalesforceOrphanedConnections } from './salesforce-connector';
import HylandConnector from './hyland-connector';
import McpEndpoint from './mcp-endpoint';
import FilesharesConnector from './fileshares-connector';
import McpServersConnector from './mcp-servers-connector';
import MirthConnector from './mirth-connector';
import AdManagerConnector from './admanager-connector';
import SandboxSecrets from './sandbox-secrets';
import { AddConnectorButton, RemovableProducts } from './catalog-controls';
import type { CatalogItem } from './add-connector-modal';
import { listSharesWithConnection } from '@renkei/connector-fileshares';
import { listInstancesWithConnection } from '@renkei/connector-mirth';
import {
  connectedServerIds,
  getToolLists,
  listServers,
  mcpCapabilityKey,
} from '@renkei/connector-mcp';
import { listInstancesWithConnection as listAdManagerInstancesWithConnection } from '@renkei/connector-admanager';
import { sandboxBrowserEnabled, sbSecretsList } from '@/lib/sandbox/service-client';
import {
  WEBEX_USER,
  ATLASSIAN,
  ATLASSIAN_JSM,
  ATLASSIAN_CONFLUENCE,
  ATLASSIAN_BITBUCKET,
  ATLASSIAN_ADMIN,
  ATLASSIAN_ADMIN_TOKEN,
  MICROSOFT,
  ENTRA_DEVELOPER,
  ZOOM,
  ONBASE,
  ONBASE_ADMIN,
  GITHUB,
} from '@renkei/provider-grants';
import { WEBEX_USER_CONNECTOR } from '@/lib/webex-app';
import { MICROSOFT_CONNECTOR } from '@/lib/microsoft-app';
import { ENTRA_DEVELOPER_CONNECTOR } from '@/lib/entra-developer-app';
import { ZOOM_CONNECTOR } from '@/lib/zoom-app';
import { GITHUB_CONNECTOR } from '@/lib/github-app';
import { listSalesforceConnectors } from '@/lib/salesforce-app';
import { listSalesforceConnections } from '@/lib/salesforce-grants';
import { SALESFORCE_ADMIN_KIND, SALESFORCE_CRM_KIND } from '@/lib/salesforce-kinds';
import { takesChanges } from '@renkei/connector-salesforce';
import {
  countAwaitingReview as countSalesforceAwaitingReview,
  countPendingChangeRequests as countSalesforceAdminChanges,
} from '@/lib/salesforce-admin/change-requests';
import { ROLE_OPERATOR } from '@/lib/access';
import { DEFAULT_WEBEX_USER_SCOPES } from '@/lib/webex-scopes';
import { DEFAULT_MICROSOFT_SCOPES } from '@/lib/microsoft-scopes';
import { DEFAULT_ENTRA_DEVELOPER_SCOPES } from '@/lib/entra-developer-scopes';
import { DEFAULT_ZOOM_SCOPES } from '@/lib/zoom-scopes';
import { DEFAULT_GITHUB_SCOPES } from '@/lib/github-scopes';
import {
  usableAtlassianCeiling,
  usableAtlassianJsmCeiling,
  usableAtlassianConfluenceCeiling,
  usableAtlassianBitbucketCeiling,
  usableAtlassianAdminCeiling,
} from '@/lib/atlassian-scopes';
import { resolveUserCatalog } from '@/lib/connectors/user-catalog';
import { resolveAudienceAllows } from '@/lib/connectors/audience';
import { connectorEntryFor } from '@/lib/connector-catalog';
import {
  anyConnectorCard,
  atlassianProducts,
  catalogItems as catalogItemsOf,
  ceilingFrom,
  connectorCards,
  microsoftShownKeys,
  pageSections,
  removableProducts,
  storedScopes,
  webexAllSpaces,
  zoomMissingScopes,
  type ConnectorCard,
} from './connectors-page.model';

/** The label the catalog gives a capability key, for the remove links. */
function labelOf(capabilityKey: string): string {
  return connectorEntryFor(capabilityKey)?.label ?? capabilityKey;
}

/**
 * The user's own connections: the connectors they added or connected, the
 * catalog of what else the org offers them, and the MCP endpoint URL to
 * paste into an LLM app.
 *
 * What is on the page is added ∪ connected (lib/connectors/user-catalog.ts),
 * so a connection made before the catalog existed keeps its card. What is
 * offered is what the org enabled, did not switch off, and — where an admin
 * scoped a connector to an audience — meant for this person. What exists in
 * the code but is not provisioned here is not this user's business.
 *
 * Which cards, in what order, which need setup, and what each hosts are
 * connectors-page.model.ts's; this reads the store and draws.
 */
export default async function ConnectorsPage(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) {
    redirect(signInUrl(`/connectors`));
  }

  // Fresh, because this page is where selections are saved from: a route
  // handler wrote the row, and this server component holds its own cache.
  // Non-secret settings carry the org's scope ceiling, which the connect
  // cards let the user narrow; their secrets are never read here.
  const loaded = await wrapAsync(async () => {
    const audienceAllows = await resolveAudienceAllows(session.subject);
    const userCatalog = await resolveUserCatalog(session.subject, {
      audienceAllows,
      fresh: true,
    });
    const enabledConfigs = await getDataStore().connectorConfigs.list({ enabledOnly: true });
    return { audienceAllows, catalog: userCatalog, configs: enabledConfigs };
  }, 'DB_ERROR' as const);
  if (!loaded.ok) {
    return (
      <div className="mx-auto max-w-6xl">
        <h1 className="mb-1 text-xl font-bold">Connectors</h1>
        <p className="text-sm text-red-700 dark:text-red-400">The database is unavailable.</p>
      </div>
    );
  }
  const { audienceAllows, catalog, configs } = loaded.val;
  const { shown, grants } = catalog;

  const settingsOf = (connector: string) =>
    configs.find((c) => c.connector === connector)?.settings;

  // File shares have no connector_configs row: an admin registers each
  // share's connection details, and this person connects it with their own
  // credentials right on the card. Every enabled share is offered.
  const fileshareRows = shown.has('fileshares')
    ? await listSharesWithConnection(session.subject)
    : null;
  const connectableShares =
    fileshareRows && fileshareRows.ok
      ? fileshareRows.val.map((entry) => ({
          id: entry.share.id,
          name: entry.share.name,
          protocol: entry.share.protocol,
          host: entry.share.host,
          shareName: entry.share.shareName,
          connection: entry.connection
            ? {
                username: entry.connection.username,
                toolAccess: entry.connection.toolAccess,
                allowDelete: entry.connection.allowDelete,
              }
            : null,
        }))
      : [];

  // Mirth instances follow the same arrangement as file shares: an admin
  // registers each server, and this person connects it with their own
  // Mirth account right on the card. Every enabled instance is offered.
  const mirthRows = shown.has('mirth') ? await listInstancesWithConnection(session.subject) : null;
  const connectableMirthInstances =
    mirthRows && mirthRows.ok
      ? mirthRows.val.map((entry) => ({
          id: entry.instance.id,
          name: entry.instance.name,
          environment: entry.instance.environment,
          baseUrl: entry.instance.baseUrl,
          connection: entry.connection
            ? {
                username: entry.connection.username,
                permissions: entry.connection.permissions,
              }
            : null,
        }))
      : [];

  // ADManager Plus instances follow the same arrangement as Mirth: an
  // admin registers each server, and this person connects it with their
  // own authtoken right on the card. Every enabled instance is offered.
  const admanagerRows = shown.has('admanager')
    ? await listAdManagerInstancesWithConnection(session.subject)
    : null;
  const connectableAdManagerInstances =
    admanagerRows && admanagerRows.ok
      ? admanagerRows.val.map((entry) => ({
          id: entry.instance.id,
          name: entry.instance.name,
          environment: entry.instance.environment,
          baseUrl: entry.instance.baseUrl,
          connection: entry.connection
            ? {
                technicianName: entry.connection.technicianName,
                permissions: entry.connection.permissions,
              }
            : null,
        }))
      : [];

  // Browser secrets live on the sandbox worker, never in this app's tables:
  // the card exists only where the deployment runs the sandbox browser, and
  // the listing is names, fields and hosts — no values.
  const browserSecrets = (await sandboxBrowserEnabled())
    ? await sbSecretsList({ subject: session.subject })
    : null;

  // Filtered to catalog-known scopes: a ceiling saved before the granular
  // migration is all classic and degrades to the defaults until re-saved.
  const atlassianCeiling = usableAtlassianCeiling(storedScopes(settingsOf('atlassian')));
  const jsmCeiling = usableAtlassianJsmCeiling(storedScopes(settingsOf('atlassian-jsm')));
  const confluenceCeiling = usableAtlassianConfluenceCeiling(
    storedScopes(settingsOf('atlassian-confluence'))
  );
  const bitbucketCeiling = usableAtlassianBitbucketCeiling(
    storedScopes(settingsOf('atlassian-bitbucket'))
  );
  const jiraAdminCeiling = usableAtlassianAdminCeiling(storedScopes(settingsOf('atlassian-admin')));
  const webexCeiling = ceilingFrom(settingsOf(WEBEX_USER_CONNECTOR), DEFAULT_WEBEX_USER_SCOPES);
  const microsoftCeiling = ceilingFrom(settingsOf(MICROSOFT_CONNECTOR), DEFAULT_MICROSOFT_SCOPES);
  const entraDeveloperCeiling = ceilingFrom(
    settingsOf(ENTRA_DEVELOPER_CONNECTOR),
    DEFAULT_ENTRA_DEVELOPER_SCOPES
  );
  const zoomCeiling = ceilingFrom(settingsOf(ZOOM_CONNECTOR), DEFAULT_ZOOM_SCOPES);
  const githubCeiling = ceilingFrom(settingsOf(GITHUB_CONNECTOR), DEFAULT_GITHUB_SCOPES);
  // One card per Salesforce connector (org) the admin switched on, each
  // connected separately; plus any connection to an org since removed —
  // for the CRM and the admin connector alike, each on its own grants.
  const salesforceKinds = await Promise.all(
    [SALESFORCE_CRM_KIND, SALESFORCE_ADMIN_KIND]
      .filter((kind) => shown.has(kind.key))
      .map(async (kind) => {
        const all = await listSalesforceConnectors(kind);
        return {
          kind,
          connectors: all.filter((org) => org.enabled),
          connections: await listSalesforceConnections(session.subject, all, kind.provider),
        };
      })
  );
  // An operator is the one who approves, so the card counts everything
  // waiting; anyone else's count is their own requests still undecided.
  const salesforcePending = shown.has(SALESFORCE_ADMIN_KIND.key)
    ? session.roles.includes(ROLE_OPERATOR)
      ? await countSalesforceAwaitingReview()
      : await countSalesforceAdminChanges(session.subject)
    : new Map<string, number>();

  // The caller's own grants, one query, mapped by provider — connection
  // state, and the scopes they previously authorized (seeding the picker on
  // reconnect).
  const atlassianGrant = grants.get(ATLASSIAN);
  const jsmGrant = grants.get(ATLASSIAN_JSM);
  const confluenceGrant = grants.get(ATLASSIAN_CONFLUENCE);
  const bitbucketGrant = grants.get(ATLASSIAN_BITBUCKET);
  const jiraAdminGrant = grants.get(ATLASSIAN_ADMIN);
  // The API token beside it: its display name is the email it belongs to.
  const jiraAdminToken = grants.get(ATLASSIAN_ADMIN_TOKEN);
  // Proposals wait for their owner on the review page; the card says how
  // many, so an agent's proposal is not only a notification away.
  const pendingJiraAdminChanges = jiraAdminGrant
    ? session.roles.includes(ROLE_OPERATOR)
      ? await countJiraAwaitingReview()
      : await countPendingChangeRequests(session.subject)
    : 0;
  const microsoftGrant = grants.get(MICROSOFT);
  const entraDeveloperGrant = grants.get(ENTRA_DEVELOPER);
  const zoomGrant = grants.get(ZOOM);
  const githubGrant = grants.get(GITHUB);
  const onbaseGrant = grants.get(ONBASE);
  const onbaseAdminGrant = grants.get(ONBASE_ADMIN);
  const webexGrant = grants.get(WEBEX_USER);

  // Jira and JSM share the 'jira' capability key: the Atlassian card hosts
  // each only where the org registered its app (atlassianProducts).
  const enabledConfig = new Set(configs.map((c) => c.connector));
  const products = atlassianProducts(shown, enabledConfig);
  const catalogItems: CatalogItem[] = catalogItemsOf(catalog);
  const removable = (keys: readonly string[]) => removableProducts(catalog, keys, labelOf);

  // Remote MCP servers: the admin's list, every enabled one in this
  // person's audience. The server owns sign-in, so "connected" is simply
  // whether this person holds a grant on it.
  const mcpServerRows = await listServers();
  const mcpConnected = await connectedServerIds(session.subject);
  const mcpToolLists = await getToolLists(session.subject);
  const mcpServerViews =
    mcpServerRows.ok && mcpConnected.ok
      ? mcpServerRows.val
          .filter((server) => server.enabled && audienceAllows(mcpCapabilityKey(server.slug)))
          .map((server) => ({
            id: server.id,
            slug: server.slug,
            name: server.name,
            host: new URL(server.url).host,
            transport: server.transport,
            authMode: server.authMode,
            context: server.context,
            connected: mcpConnected.val.includes(server.id),
            toolCount: mcpToolLists.ok ? (mcpToolLists.val.get(server.id)?.tools.length ?? 0) : 0,
          }))
      : [];

  const microsoftKeys = microsoftShownKeys(shown);
  const anyCard = anyConnectorCard(shown, mcpServerViews.length);

  /**
   * Each card, tagged with whether it has something a person added but
   * never finished connecting (connectors-page.model.ts). Those float to
   * their own section above everything else: a card you already use is a
   * reference, but a card you started and abandoned is the one thing on
   * this page that is actually blocking you.
   */
  const cards = connectorCards({
    shown,
    grants: new Set(grants.keys()),
    enabledConfigs: enabledConfig,
    salesforce: salesforceKinds.map(({ kind, connectors, connections }) => ({
      kindKey: kind.key,
      orgKeys: connectors.map((org) => org.key),
      connectedOrgs: connections.map((c) => c.connector),
    })),
    fileshares: connectableShares.map((share) => ({ connected: share.connection !== null })),
    mirth: connectableMirthInstances.map((instance) => ({
      connected: instance.connection !== null,
    })),
    admanager: connectableAdManagerInstances.map((instance) => ({
      connected: instance.connection !== null,
    })),
    mcpServers: mcpServerViews,
    browserSecrets: browserSecrets !== null,
  });

  function renderCard(card: ConnectorCard): React.ReactNode {
    if (card.kind === 'salesforce') {
      const entry = salesforceKinds.find(({ kind }) => kind.key === card.kindKey);
      const org = entry?.connectors.find((candidate) => candidate.key === card.orgKey);
      if (!entry || !org) return null;
      const { kind } = entry;
      const connection = entry.connections.find((c) => c.connector === org.key);
      return (
        <>
          <SalesforceConnector
            kind={kind}
            connectorKey={org.key}
            name={org.name}
            sandbox={org.sandbox}
            orgHost={org.host}
            connected={connection !== undefined}
            displayName={connection?.displayName ?? null}
            username={connection?.username ?? null}
            ceiling={kind.ceiling(org.scopes.join(' '))}
            priorScopes={connection?.requestedScopes ?? null}
            pendingChanges={salesforcePending.get(org.key) ?? 0}
            takesChanges={takesChanges(org)}
          />
          {card.last && <RemovableProducts products={removable([kind.key])} />}
        </>
      );
    }
    if (card.kind === 'salesforce-removed') {
      const entry = salesforceKinds.find(({ kind }) => kind.key === card.kindKey);
      if (!entry) return null;
      return (
        <SalesforceOrphanedConnections
          kind={entry.kind}
          connections={entry.connections.filter((c) => c.connector === null)}
        />
      );
    }
    switch (card.key) {
      case 'atlassian':
        return (
          <>
            <AtlassianConnector
              jira={
                products.jira
                  ? {
                      connected: atlassianGrant !== undefined,
                      displayName: atlassianGrant?.displayName ?? null,
                      ceiling: atlassianCeiling,
                      priorScopes: atlassianGrant?.requestedScopes ?? null,
                    }
                  : undefined
              }
              jsm={
                products.jsm
                  ? {
                      connected: jsmGrant !== undefined,
                      displayName: jsmGrant?.displayName ?? null,
                      ceiling: jsmCeiling,
                      priorScopes: jsmGrant?.requestedScopes ?? null,
                    }
                  : undefined
              }
              jiraAdmin={
                products.jiraAdmin
                  ? {
                      connected: jiraAdminGrant !== undefined,
                      displayName: jiraAdminGrant?.displayName ?? null,
                      ceiling: jiraAdminCeiling,
                      priorScopes: jiraAdminGrant?.requestedScopes ?? null,
                      changesHref: `/jira-admin/changes`,
                      templatesHref: `/jira-admin/templates`,
                      pendingChanges: pendingJiraAdminChanges,
                      apiTokenFor: jiraAdminToken?.displayName ?? null,
                    }
                  : undefined
              }
              confluence={
                products.confluence
                  ? {
                      connected: confluenceGrant !== undefined,
                      displayName: confluenceGrant?.displayName ?? null,
                      ceiling: confluenceCeiling,
                      priorScopes: confluenceGrant?.requestedScopes ?? null,
                    }
                  : undefined
              }
              bitbucket={
                products.bitbucket
                  ? {
                      connected: bitbucketGrant !== undefined,
                      displayName: bitbucketGrant?.displayName ?? null,
                      ceiling: bitbucketCeiling,
                      priorScopes: bitbucketGrant?.requestedScopes ?? null,
                    }
                  : undefined
              }
            />
            <RemovableProducts
              products={removable([
                'jira',
                'jira-admin',
                'atlassian-confluence',
                'atlassian-bitbucket',
              ])}
            />
          </>
        );
      case 'webex':
        return (
          <>
            <WebexUserConnector
              connected={webexGrant !== undefined}
              displayName={webexGrant?.displayName ?? null}
              allSpaces={webexAllSpaces(webexGrant)}
              ceiling={webexCeiling}
              priorScopes={webexGrant?.requestedScopes ?? null}
            />
            <RemovableProducts products={removable(['webex'])} />
          </>
        );
      case 'microsoft':
        return (
          <>
            <MicrosoftConnector
              connected={microsoftGrant !== undefined}
              displayName={microsoftGrant?.displayName ?? null}
              ceiling={microsoftCeiling}
              priorScopes={microsoftGrant?.requestedScopes ?? null}
              shownKeys={microsoftKeys}
            />
            <RemovableProducts products={removable(microsoftKeys)} />
          </>
        );
      case 'entra-developer':
        // Its own card, not a panel in the Microsoft 365 one: a second Entra
        // app registration and a second consent (entra-developer-connector.tsx).
        return (
          <>
            <EntraDeveloperConnector
              connected={entraDeveloperGrant !== undefined}
              displayName={entraDeveloperGrant?.displayName ?? null}
              ceiling={entraDeveloperCeiling}
              priorScopes={entraDeveloperGrant?.requestedScopes ?? null}
            />
            <RemovableProducts products={removable(['entra-developer'])} />
          </>
        );
      case 'zoom':
        return (
          <>
            {/* Scope drift the Marketplace app hides: Zoom silently drops any
                requested scope the app doesn't carry, and the only symptom is
                tools quietly not registering. Surface the difference here. */}
            <ZoomConnector
              missingScopes={zoomMissingScopes(zoomGrant)}
              connected={zoomGrant !== undefined}
              displayName={zoomGrant?.displayName ?? null}
              ceiling={zoomCeiling}
              priorScopes={zoomGrant?.requestedScopes ?? null}
            />
            <RemovableProducts products={removable(['zoom'])} />
          </>
        );
      case 'github':
        return (
          <>
            <GitHubConnector
              connected={githubGrant !== undefined}
              displayName={githubGrant?.displayName ?? null}
              ceiling={githubCeiling}
              priorScopes={githubGrant?.requestedScopes ?? null}
            />
            <RemovableProducts products={removable(['github'])} />
          </>
        );
      case 'hyland':
        return (
          <>
            <HylandConnector
              onbase={
                shown.has('onbase')
                  ? {
                      connected: onbaseGrant !== undefined,
                      displayName: onbaseGrant?.displayName ?? null,
                    }
                  : undefined
              }
              onbaseAdmin={
                shown.has('onbase-admin')
                  ? {
                      connected: onbaseAdminGrant !== undefined,
                      displayName: onbaseAdminGrant?.displayName ?? null,
                    }
                  : undefined
              }
            />
            <RemovableProducts products={removable(['onbase', 'onbase-admin'])} />
          </>
        );
      case 'fileshares':
        return (
          <>
            <FilesharesConnector shares={connectableShares} />
            <RemovableProducts products={removable(['fileshares'])} />
          </>
        );
      case 'mirth':
        return (
          <>
            <MirthConnector instances={connectableMirthInstances} />
            <RemovableProducts products={removable(['mirth'])} />
          </>
        );
      case 'admanager':
        return (
          <>
            <AdManagerConnector instances={connectableAdManagerInstances} />
            <RemovableProducts products={removable(['admanager'])} />
          </>
        );
      case 'mcp-servers':
        return <McpServersConnector servers={mcpServerViews} />;
      case 'browser-secrets':
        // Not an "add and connect" surface: it never counts as needing setup.
        return <SandboxSecrets secrets={browserSecrets?.ok ? browserSecrets.val : []} />;
    }
  }

  const { needsSetup, settled, settledHeading } = pageSections(cards);

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 text-xl font-bold">Connectors</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Your connected accounts, and the endpoint your LLM app talks to.
          </p>
        </div>
        {anyCard && <AddConnectorButton items={catalogItems} />}
      </div>

      {/*
        Two bands, because the endpoint and the connectors are different
        kinds of thing. The endpoint is one URL you copy once; the connectors
        are a set you scan and pick from. Its own full-width row gives the
        URL room to sit on one line, and stops it competing with the cards
        for a place in the packing order.

        `order-last` keeps the phone ordering the column flow used to carry:
        below `lg` the connect buttons are what you came for, and nobody
        pastes an MCP URL from a phone. From `lg` up it leads, which is where
        a first-time visitor should meet it.
      */}
      <div className="flex flex-col gap-6">
        <div className="order-last lg:order-first">
          <McpEndpoint />
        </div>

        {!anyCard && (
          <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center dark:border-gray-700">
            <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">
              Nothing added yet. Pick the tools you work with; each one connects with your own
              account.
            </p>
            <AddConnectorButton items={catalogItems} emphasis />
          </div>
        )}

        {/*
        Two passes over the same card list, in the same column mechanism,
        rather than one flat pass: a card that has something added but not
        connected is the one thing on this page actually blocking someone,
        and used to sit wherever the DOM order happened to put it — often
        below several already-working cards nobody needed to look at again.
        `needsSetup` gets its own heading and renders first; `settled`
        follows, unlabeled when nothing needed setup (the common case, once
        someone has finished onboarding) so the page doesn't insist on a
        heading for a distinction that isn't live today.

        Columns rather than one long stack within each section: with six
        connectors the stack made you scroll past everything already
        connected to reach the one you had not.

        Capped at TWO. Three fit the page at `xl` but not the cards: inside
        `max-w-6xl` a third of the width is ~350px, and Atlassian — three
        nested product panels, each with its own capability list and connect
        button — spent it all on padding and two-line button labels. Two
        columns give every card ~540px, which is what the densest one needs.

        CSS multi-column rather than a grid, because these cards differ in
        height by a factor of five. Columns pack vertically instead, and
        `break-inside-avoid` on each card is what stops one being split down
        the middle across a column boundary. Splitting `needsSetup` into its
        own multi-column block (instead of just sorting one shared list)
        keeps that packing well-behaved too: without it, a handful of small
        unconnected cards trying to balance against one huge connected one
        is exactly the uneven-column case multi-column already struggles
        with — a short section balances far more predictably on its own.

        The `-mb-6` cancels the trailing margin of whichever card ends a
        section's flow, so the gap to what follows — the next section, or
        the endpoint row on a phone — is the same `gap-6` as everywhere
        else.
      */}
        {needsSetup.length > 0 && (
          <div>
            <h2 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">
              Needs setup
            </h2>
            <div className="-mb-6 lg:columns-2 lg:gap-6">
              {needsSetup.map((card) => (
                <div
                  key={card.key}
                  id={`connector-${card.key}`}
                  className="mb-6 break-inside-avoid"
                >
                  {renderCard(card)}
                </div>
              ))}
            </div>
          </div>
        )}

        {settled.length > 0 && (
          <div>
            {settledHeading && (
              <h2 className="mb-3 text-sm font-semibold text-gray-700 dark:text-gray-300">
                {settledHeading}
              </h2>
            )}
            <div className="-mb-6 lg:columns-2 lg:gap-6">
              {settled.map((card) => (
                <div
                  key={card.key}
                  id={`connector-${card.key}`}
                  className="mb-6 break-inside-avoid"
                >
                  {renderCard(card)}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
