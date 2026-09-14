import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import AtlassianConnector from './atlassian-connector';
import WebexUserConnector from './webex-user-connector';
import MicrosoftConnector from './microsoft-connector';
import ZoomConnector from './zoom-connector';
import HylandConnector from './hyland-connector';
import McpEndpoint from './mcp-endpoint';
import FilesharesConnector from './fileshares-connector';
import SandboxSecrets from './sandbox-secrets';
import { AddConnectorButton, RemovableProducts } from './catalog-controls';
import type { CatalogItem } from './add-connector-modal';
import { listSharesWithConnection } from '@renkei/connector-fileshares';
import { sandboxBrowserEnabled, sbSecretsList } from '@/lib/sandbox/service-client';
import {
  WEBEX_USER,
  ATLASSIAN,
  ATLASSIAN_JSM,
  ATLASSIAN_CONFLUENCE,
  ATLASSIAN_BITBUCKET,
  MICROSOFT,
  ZOOM,
  ONBASE,
  ONBASE_ADMIN,
} from '@renkei/provider-grants';
import { WEBEX_USER_CONNECTOR } from '@/lib/webex-app';
import { MICROSOFT_CONNECTOR } from '@/lib/microsoft-app';
import { ZOOM_CONNECTOR } from '@/lib/zoom-app';
import { DEFAULT_WEBEX_USER_SCOPES } from '@/lib/webex-scopes';
import { DEFAULT_MICROSOFT_SCOPES } from '@/lib/microsoft-scopes';
import { DEFAULT_ZOOM_SCOPES } from '@/lib/zoom-scopes';
import {
  usableAtlassianCeiling,
  usableAtlassianJsmCeiling,
  usableAtlassianConfluenceCeiling,
  usableAtlassianBitbucketCeiling,
} from '@/lib/atlassian-scopes';
import { resolveUserCatalog, type UserCatalog } from '@/lib/connectors/user-catalog';
import { resolveAudienceAllows } from '@/lib/connectors/audience';
import { connectorEntryFor } from '@/lib/connector-catalog';

/** The org's stored scopes string for a connector, from non-secret settings. */
function storedScopes(settings: unknown): string | null {
  if (typeof settings === 'object' && settings !== null && 'scopes' in settings) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- narrowing jsonb
    const scopes = (settings as Record<string, unknown>).scopes;
    if (typeof scopes === 'string' && scopes) return scopes;
  }
  return null;
}

/** The org's scope ceiling for a connector, from its non-secret settings. */
function ceilingFrom(settings: unknown, fallback: string): string[] {
  return (storedScopes(settings) ?? fallback).split(/\s+/);
}

/** The label the catalog gives a capability key, for the remove links. */
function labelOf(capabilityKey: string): string {
  return connectorEntryFor(capabilityKey)?.label ?? capabilityKey;
}

/**
 * Under a card, the products on the page with nothing connected — the
 * ones a person may take back off. Connected products are not listed: they
 * have Disconnect, and hiding a live connection is not on offer.
 */
function removable(catalog: UserCatalog, keys: string[]) {
  return keys
    .filter((key) => catalog.shown.has(key) && !catalog.connected.has(key))
    .map((key) => ({ capabilityKey: key, label: labelOf(key) }));
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
 */
export default async function ConnectorsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/connectors`));
  }

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return (
      <div className="mx-auto max-w-6xl">
        <h1 className="mb-1 text-xl font-bold">Connectors</h1>
        <p className="text-sm text-red-700 dark:text-red-400">The database is unavailable.</p>
      </div>
    );
  }
  const db = dbResult.val;

  // Fresh, because this page is where selections are saved from: a route
  // handler wrote the row, and this server component holds its own cache.
  const catalog = await resolveUserCatalog(db, tenant.id, session.subject, {
    audienceAllows: await resolveAudienceAllows(db, tenant.id, session.subject),
    fresh: true,
  });
  const { shown, grants } = catalog;

  // Non-secret settings carry the org's scope ceiling, which the connect
  // cards let the user narrow. Secrets never touch this page.
  const configs = await db
    .selectFrom('connector_configs')
    .select(['connector', 'settings'])
    .where('tenant_id', '=', tenant.id)
    .where('enabled', '=', true)
    .execute();
  const settingsOf = (connector: string) =>
    configs.find((c) => c.connector === connector)?.settings;

  // File shares have no connector_configs row: an admin registers each
  // share's connection details, and this person connects it with their own
  // credentials right on the card. Every enabled share is offered.
  const fileshareRows = shown.has('fileshares')
    ? await listSharesWithConnection(db, tenant.id, session.subject)
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

  // Browser secrets live on the sandbox worker, never in this app's tables:
  // the card exists only where the deployment runs the sandbox browser, and
  // the listing is names, fields and hosts — no values.
  const browserSecrets = sandboxBrowserEnabled()
    ? await sbSecretsList({ tenantId: tenant.id, subject: session.subject })
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
  const webexCeiling = ceilingFrom(settingsOf(WEBEX_USER_CONNECTOR), DEFAULT_WEBEX_USER_SCOPES);
  const microsoftCeiling = ceilingFrom(settingsOf(MICROSOFT_CONNECTOR), DEFAULT_MICROSOFT_SCOPES);
  const zoomCeiling = ceilingFrom(settingsOf(ZOOM_CONNECTOR), DEFAULT_ZOOM_SCOPES);

  // The caller's own grants, one query, mapped by provider — connection
  // state, and the scopes they previously authorized (seeding the picker on
  // reconnect).
  const atlassianGrant = grants.get(ATLASSIAN);
  const jsmGrant = grants.get(ATLASSIAN_JSM);
  const confluenceGrant = grants.get(ATLASSIAN_CONFLUENCE);
  const bitbucketGrant = grants.get(ATLASSIAN_BITBUCKET);
  const microsoftGrant = grants.get(MICROSOFT);
  const zoomGrant = grants.get(ZOOM);
  const onbaseGrant = grants.get(ONBASE);
  const onbaseAdminGrant = grants.get(ONBASE_ADMIN);
  const webexGrant = grants.get(WEBEX_USER);

  // Jira and JSM share the 'jira' capability key. The Atlassian card hosts
  // both, so "jira shown" means both products are on the page — the card
  // itself hides a product the org has not provisioned.
  const enabledConfig = new Set(configs.map((c) => c.connector));
  const jiraShown = shown.has('jira');

  const catalogItems: CatalogItem[] = catalog.available.map((entry) => ({
    entry,
    added: catalog.added.includes(entry.capabilityKey),
    connected: catalog.connected.has(entry.capabilityKey),
  }));

  const microsoftKeys = ['microsoft', 'sharepoint', 'onedrive'].filter((key) => shown.has(key));
  const atlassianShown =
    jiraShown || shown.has('atlassian-confluence') || shown.has('atlassian-bitbucket');
  const hylandShown = shown.has('onbase') || shown.has('onbase-admin');
  const anyCard =
    atlassianShown ||
    shown.has('webex') ||
    microsoftKeys.length > 0 ||
    shown.has('zoom') ||
    hylandShown ||
    shown.has('fileshares');

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="mb-1 text-xl font-bold">Connectors</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            Your connected accounts, and the endpoint your LLM app talks to.
          </p>
        </div>
        {anyCard && <AddConnectorButton tenantId={tenant.id} items={catalogItems} />}
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
          <McpEndpoint tenantId={tenant.id} />
        </div>

        {!anyCard && (
          <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center dark:border-gray-700">
            <p className="mb-3 text-sm text-gray-600 dark:text-gray-400">
              Nothing added yet. Pick the tools you work with; each one connects with your own
              account.
            </p>
            <AddConnectorButton tenantId={tenant.id} items={catalogItems} emphasis />
          </div>
        )}

        {/*
        Columns rather than one long stack: with six connectors the stack
        made you scroll past everything already connected to reach the one
        you had not.

        Capped at TWO. Three fit the page at `xl` but not the cards: inside
        `max-w-6xl` a third of the width is ~350px, and Atlassian — three
        nested product panels, each with its own capability list and connect
        button — spent it all on padding and two-line button labels. Two
        columns give every card ~540px, which is what the densest one needs.

        CSS multi-column rather than a grid, because these cards differ in
        height by a factor of five. Columns pack vertically instead, and
        `break-inside-avoid` on each card is what stops one being split down
        the middle across a column boundary.

        The `-mb-6` cancels the trailing margin of whichever card ends the
        flow, so the gap to the endpoint row below on a phone is the same
        `gap-6` as everywhere else.
      */}
        <div className="-mb-6 lg:columns-2 lg:gap-6">
          {/*
            One Atlassian card holding all four products. Each keeps its own
            connect/disconnect controls — they are four separate OAuth apps
            with four separate grants, unlike Microsoft's single consent.
          */}
          {atlassianShown && (
            <div className="mb-6 break-inside-avoid">
              <AtlassianConnector
                tenantId={tenant.id}
                jira={
                  jiraShown && enabledConfig.has('atlassian')
                    ? {
                        ceiling: atlassianCeiling,
                        priorScopes: atlassianGrant?.requestedScopes ?? null,
                      }
                    : undefined
                }
                jsm={
                  jiraShown && enabledConfig.has('atlassian-jsm')
                    ? {
                        connected: jsmGrant !== undefined,
                        displayName: jsmGrant?.displayName ?? null,
                        ceiling: jsmCeiling,
                        priorScopes: jsmGrant?.requestedScopes ?? null,
                      }
                    : undefined
                }
                confluence={
                  shown.has('atlassian-confluence')
                    ? {
                        connected: confluenceGrant !== undefined,
                        displayName: confluenceGrant?.displayName ?? null,
                        ceiling: confluenceCeiling,
                        priorScopes: confluenceGrant?.requestedScopes ?? null,
                      }
                    : undefined
                }
                bitbucket={
                  shown.has('atlassian-bitbucket')
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
                tenantId={tenant.id}
                products={removable(catalog, [
                  'jira',
                  'atlassian-confluence',
                  'atlassian-bitbucket',
                ])}
              />
            </div>
          )}

          {shown.has('webex') && (
            <div className="mb-6 break-inside-avoid">
              <WebexUserConnector
                tenantId={tenant.id}
                connected={webexGrant !== undefined}
                displayName={webexGrant?.displayName ?? null}
                allSpaces={
                  typeof webexGrant?.metadata === 'object' &&
                  webexGrant.metadata !== null &&
                  !Array.isArray(webexGrant.metadata) &&
                  'allSpaces' in webexGrant.metadata &&
                  webexGrant.metadata.allSpaces === true
                }
                ceiling={webexCeiling}
                priorScopes={webexGrant?.requestedScopes ?? null}
              />
              <RemovableProducts tenantId={tenant.id} products={removable(catalog, ['webex'])} />
            </div>
          )}

          {microsoftKeys.length > 0 && (
            <div className="mb-6 break-inside-avoid">
              <MicrosoftConnector
                tenantId={tenant.id}
                connected={microsoftGrant !== undefined}
                displayName={microsoftGrant?.displayName ?? null}
                ceiling={microsoftCeiling}
                priorScopes={microsoftGrant?.requestedScopes ?? null}
                shownKeys={microsoftKeys}
              />
              <RemovableProducts
                tenantId={tenant.id}
                products={removable(catalog, microsoftKeys)}
              />
            </div>
          )}

          {/* Scope drift the Marketplace app hides: Zoom silently drops any
              requested scope the app doesn't carry, and the only symptom is
              tools quietly not registering. Surface the difference here. */}
          {shown.has('zoom') && (
            <div className="mb-6 break-inside-avoid">
              <ZoomConnector
                missingScopes={
                  zoomGrant?.grantedScopes
                    ? (zoomGrant.requestedScopes ?? []).filter(
                        (scope) => !zoomGrant.grantedScopes?.includes(scope)
                      )
                    : []
                }
                tenantId={tenant.id}
                connected={zoomGrant !== undefined}
                displayName={zoomGrant?.displayName ?? null}
                ceiling={zoomCeiling}
                priorScopes={zoomGrant?.requestedScopes ?? null}
              />
              <RemovableProducts tenantId={tenant.id} products={removable(catalog, ['zoom'])} />
            </div>
          )}

          {hylandShown && (
            <div className="mb-6 break-inside-avoid">
              <HylandConnector
                tenantId={tenant.id}
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
              <RemovableProducts
                tenantId={tenant.id}
                products={removable(catalog, ['onbase', 'onbase-admin'])}
              />
            </div>
          )}

          {shown.has('fileshares') && (
            <div className="mb-6 break-inside-avoid">
              <FilesharesConnector tenantId={tenant.id} shares={connectableShares} />
              <RemovableProducts
                tenantId={tenant.id}
                products={removable(catalog, ['fileshares'])}
              />
            </div>
          )}

          {browserSecrets && (
            <div className="mb-6 break-inside-avoid">
              <SandboxSecrets
                tenantId={tenant.id}
                secrets={browserSecrets.ok ? browserSecrets.val : []}
              />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
