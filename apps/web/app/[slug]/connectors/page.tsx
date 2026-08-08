import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import JiraConnector from './jira-connector';
import WebexUserConnector from './webex-user-connector';
import McpEndpoint from './mcp-endpoint';
import { WEBEX_USER, ATLASSIAN } from '@renkei/provider-grants';
import { WEBEX_USER_CONNECTOR } from '@/lib/webex-app';
import { DEFAULT_WEBEX_USER_SCOPES } from '@/lib/webex-scopes';
import { DEFAULT_ATLASSIAN_SCOPES } from '@/lib/atlassian-scopes';

/** The org's scope ceiling for a connector, from its non-secret settings. */
function ceilingFrom(settings: unknown, fallback: string): string[] {
  if (typeof settings === 'object' && settings !== null && 'scopes' in settings) {
    // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- narrowing jsonb
    const scopes = (settings as Record<string, unknown>).scopes;
    if (typeof scopes === 'string' && scopes) return scopes.split(/\s+/);
  }
  return fallback.split(' ');
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

  const atlassianCeiling = ceilingFrom(settingsOf('atlassian'), DEFAULT_ATLASSIAN_SCOPES);
  const webexCeiling = ceilingFrom(settingsOf(WEBEX_USER_CONNECTOR), DEFAULT_WEBEX_USER_SCOPES);

  // The caller's own grants, server-rendered — connection state, and the
  // scopes they previously authorized (seeding the picker on reconnect).
  const [atlassianGrant, webexGrant] = dbResult.ok
    ? await Promise.all([
        enabled.has('atlassian')
          ? dbResult.val
              .selectFrom('provider_grants')
              .select(['display_name', 'scopes'])
              .where('tenant_id', '=', tenant.id)
              .where('provider', '=', ATLASSIAN)
              .where('subject', '=', session.subject)
              .executeTakeFirst()
          : Promise.resolve(undefined),
        enabled.has(WEBEX_USER_CONNECTOR)
          ? dbResult.val
              .selectFrom('provider_grants')
              .select(['display_name', 'scopes'])
              .where('tenant_id', '=', tenant.id)
              .where('provider', '=', WEBEX_USER)
              .where('subject', '=', session.subject)
              .executeTakeFirst()
          : Promise.resolve(undefined),
      ])
    : [undefined, undefined];

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Connectors</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Your connected accounts, and the endpoint your LLM app talks to.
      </p>

      <div className="space-y-6">
        {enabled.has('atlassian') ? (
          <JiraConnector
            tenantId={tenant.id}
            ceiling={atlassianCeiling}
            priorScopes={atlassianGrant?.scopes ?? null}
          />
        ) : (
          <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
            <h2 className="font-semibold">Jira</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              Not enabled for this organization. An org admin can set it up under Connector setup.
            </p>
          </div>
        )}

        {enabled.has('webex') && (
          <div className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950">
            <h2 className="font-semibold">WebEx (org bot)</h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
              Enabled by your organization. Add the bot to a space and mention it, or forward it a
              message in a 1:1 — there is nothing to connect here.
            </p>
          </div>
        )}

        {enabled.has(WEBEX_USER_CONNECTOR) && (
          <WebexUserConnector
            tenantId={tenant.id}
            connected={webexGrant !== undefined && webexGrant !== null}
            displayName={webexGrant?.display_name ?? null}
            ceiling={webexCeiling}
            priorScopes={webexGrant?.scopes ?? null}
          />
        )}

        <McpEndpoint tenantId={tenant.id} />
      </div>
    </div>
  );
}
