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
import McpEndpoint from './mcp-endpoint';
import {
  WEBEX_USER,
  ATLASSIAN,
  ATLASSIAN_JSM,
  ATLASSIAN_CONFLUENCE,
  MICROSOFT,
  ZOOM,
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
} from '@/lib/atlassian-scopes';

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

/**
 * The user's own connections: which connectors the org has enabled, this
 * user's grant on each, and the MCP endpoint URL to paste into an LLM app.
 * Only org-enabled connectors appear — what exists in the code but is not
 * provisioned here is not this user's business.
 *
 * This absorbs what /mcp/[tenantId] used to do; connecting an account and
 * copying the endpoint URL is a section of a page, not a page.
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

  // Enabled flags plus non-secret settings — the settings carry the org's
  // scope ceiling, which the connect cards let the user narrow. Secrets
  // never touch this page.
  const dbResult = getDatabase();
  const configs = dbResult.ok
    ? await dbResult.val
        .selectFrom('connector_configs')
        .select(['connector', 'enabled', 'settings'])
        .where('tenant_id', '=', tenant.id)
        .where('enabled', '=', true)
        .execute()
    : [];
  const enabled = new Set(configs.map((c) => c.connector));
  const settingsOf = (connector: string) =>
    configs.find((c) => c.connector === connector)?.settings;

  // Filtered to catalog-known scopes: a ceiling saved before the granular
  // migration is all classic and degrades to the defaults until re-saved.
  const atlassianCeiling = usableAtlassianCeiling(storedScopes(settingsOf('atlassian')));
  const jsmCeiling = usableAtlassianJsmCeiling(storedScopes(settingsOf('atlassian-jsm')));
  const confluenceCeiling = usableAtlassianConfluenceCeiling(
    storedScopes(settingsOf('atlassian-confluence'))
  );
  const webexCeiling = ceilingFrom(settingsOf(WEBEX_USER_CONNECTOR), DEFAULT_WEBEX_USER_SCOPES);
  const microsoftCeiling = ceilingFrom(settingsOf(MICROSOFT_CONNECTOR), DEFAULT_MICROSOFT_SCOPES);
  const zoomCeiling = ceilingFrom(settingsOf(ZOOM_CONNECTOR), DEFAULT_ZOOM_SCOPES);

  // The caller's own grants, server-rendered — connection state, and the
  // scopes they previously authorized (seeding the picker on reconnect).
  const [atlassianGrant, webexGrant, jsmGrant, confluenceGrant, microsoftGrant, zoomGrant] =
    dbResult.ok
      ? await Promise.all([
          enabled.has('atlassian')
            ? dbResult.val
                .selectFrom('provider_grants')
                .select(['display_name', 'requested_scopes'])
                .where('tenant_id', '=', tenant.id)
                .where('provider', '=', ATLASSIAN)
                .where('subject', '=', session.subject)
                .executeTakeFirst()
            : Promise.resolve(undefined),
          enabled.has(WEBEX_USER_CONNECTOR)
            ? dbResult.val
                .selectFrom('provider_grants')
                .select(['display_name', 'requested_scopes', 'metadata'])
                .where('tenant_id', '=', tenant.id)
                .where('provider', '=', WEBEX_USER)
                .where('subject', '=', session.subject)
                .executeTakeFirst()
            : Promise.resolve(undefined),
          enabled.has('atlassian-jsm')
            ? dbResult.val
                .selectFrom('provider_grants')
                .select(['display_name', 'requested_scopes'])
                .where('tenant_id', '=', tenant.id)
                .where('provider', '=', ATLASSIAN_JSM)
                .where('subject', '=', session.subject)
                .executeTakeFirst()
            : Promise.resolve(undefined),
          enabled.has('atlassian-confluence')
            ? dbResult.val
                .selectFrom('provider_grants')
                .select(['display_name', 'requested_scopes'])
                .where('tenant_id', '=', tenant.id)
                .where('provider', '=', ATLASSIAN_CONFLUENCE)
                .where('subject', '=', session.subject)
                .executeTakeFirst()
            : Promise.resolve(undefined),
          enabled.has(MICROSOFT_CONNECTOR)
            ? dbResult.val
                .selectFrom('provider_grants')
                .select(['display_name', 'requested_scopes'])
                .where('tenant_id', '=', tenant.id)
                .where('provider', '=', MICROSOFT)
                .where('subject', '=', session.subject)
                .executeTakeFirst()
            : Promise.resolve(undefined),
          enabled.has(ZOOM_CONNECTOR)
            ? dbResult.val
                .selectFrom('provider_grants')
                .select(['display_name', 'requested_scopes', 'granted_scopes'])
                .where('tenant_id', '=', tenant.id)
                .where('provider', '=', ZOOM)
                .where('subject', '=', session.subject)
                .executeTakeFirst()
            : Promise.resolve(undefined),
        ])
      : [undefined, undefined, undefined, undefined, undefined, undefined];

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="mb-1 text-xl font-bold">Connectors</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Your connected accounts, and the endpoint your LLM app talks to.
      </p>

      {/*
        Columns rather than one long stack: with seven connectors the stack
        made you scroll past everything already connected to reach the one
        you had not. Capped at three — wider than that and the cards stretch
        far enough that the eye loses the row.

        CSS multi-column rather than a grid, because these cards differ in
        height by a factor of five. A grid puts each in a row-height cell, so
        the endpoint card ends up with a screenful of white space beneath it
        while Microsoft's four products set the row. Columns pack vertically
        instead, and `break-inside-avoid` on each card is what stops one
        being split down the middle across a column boundary.

        The two layout modes also carry the ordering. Below `lg` this is a
        flex column, where `order-last` puts the endpoint URL at the bottom —
        on a phone the connect buttons are what you came for, and nobody
        pastes an MCP URL from there. At `lg` the container becomes `block`
        with columns, `order` stops applying, and the endpoint card (first in
        the DOM) leads the first column, which is where a first-time visitor
        should meet it.
      */}
      <div className="flex flex-col lg:block lg:columns-2 lg:gap-6 xl:columns-3">
        <div className="order-last mb-6 break-inside-avoid">
          <McpEndpoint tenantId={tenant.id} />
        </div>

        <div className="mb-6 break-inside-avoid">
          {/*
          One Atlassian card holding all three products. Each keeps its own
          connect/disconnect controls — they are three separate OAuth apps
          with three separate grants, unlike Microsoft's single consent.
        */}
          <AtlassianConnector
            tenantId={tenant.id}
            jira={
              enabled.has('atlassian')
                ? {
                    ceiling: atlassianCeiling,
                    priorScopes: atlassianGrant?.requested_scopes ?? null,
                  }
                : undefined
            }
            jsm={
              enabled.has('atlassian-jsm')
                ? {
                    connected: jsmGrant !== undefined && jsmGrant !== null,
                    displayName: jsmGrant?.display_name ?? null,
                    ceiling: jsmCeiling,
                    priorScopes: jsmGrant?.requested_scopes ?? null,
                  }
                : undefined
            }
            confluence={
              enabled.has('atlassian-confluence')
                ? {
                    connected: confluenceGrant !== undefined && confluenceGrant !== null,
                    displayName: confluenceGrant?.display_name ?? null,
                    ceiling: confluenceCeiling,
                    priorScopes: confluenceGrant?.requested_scopes ?? null,
                  }
                : undefined
            }
          />
        </div>

        {enabled.has(WEBEX_USER_CONNECTOR) && (
          <div className="mb-6 break-inside-avoid">
            <WebexUserConnector
              tenantId={tenant.id}
              connected={webexGrant !== undefined && webexGrant !== null}
              displayName={webexGrant?.display_name ?? null}
              allSpaces={
                typeof webexGrant?.metadata === 'object' &&
                webexGrant.metadata !== null &&
                !Array.isArray(webexGrant.metadata) &&
                'allSpaces' in webexGrant.metadata &&
                webexGrant.metadata.allSpaces === true
              }
              ceiling={webexCeiling}
              priorScopes={webexGrant?.requested_scopes ?? null}
            />
          </div>
        )}

        {enabled.has(MICROSOFT_CONNECTOR) && (
          <div className="mb-6 break-inside-avoid">
            <MicrosoftConnector
              tenantId={tenant.id}
              connected={microsoftGrant !== undefined && microsoftGrant !== null}
              displayName={microsoftGrant?.display_name ?? null}
              ceiling={microsoftCeiling}
              priorScopes={microsoftGrant?.requested_scopes ?? null}
            />
          </div>
        )}

        {/* Scope drift the Marketplace app hides: Zoom silently drops any
            requested scope the app doesn't carry, and the only symptom is
            tools quietly not registering. Surface the difference here. */}
        {enabled.has(ZOOM_CONNECTOR) && (
          <div className="mb-6 break-inside-avoid">
            <ZoomConnector
              missingScopes={
                zoomGrant?.granted_scopes
                  ? (zoomGrant.requested_scopes ?? []).filter(
                      (scope) => !zoomGrant.granted_scopes?.includes(scope)
                    )
                  : []
              }
              tenantId={tenant.id}
              connected={zoomGrant !== undefined && zoomGrant !== null}
              displayName={zoomGrant?.display_name ?? null}
              ceiling={zoomCeiling}
              priorScopes={zoomGrant?.requested_scopes ?? null}
            />
          </div>
        )}
      </div>
    </div>
  );
}
