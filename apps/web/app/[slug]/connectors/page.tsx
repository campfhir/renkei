import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import JiraConnector from './jira-connector';
import WebexUserConnector from './webex-user-connector';
import McpEndpoint from './mcp-endpoint';
import { WEBEX_USER } from '@renkei/provider-grants';
import { WEBEX_USER_CONNECTOR } from '@/lib/webex-app';

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

  // Enabled flags only — settings and secrets stay out of user pages.
  const dbResult = getDatabase();
  const configs = dbResult.ok
    ? await dbResult.val
        .selectFrom('connector_configs')
        .select(['connector', 'enabled'])
        .where('tenant_id', '=', tenant.id)
        .where('enabled', '=', true)
        .execute()
    : [];
  const enabled = new Set(configs.map((c) => c.connector));

  // The caller's own WebEx grant, server-rendered: exists or not.
  const webexGrant =
    dbResult.ok && enabled.has(WEBEX_USER_CONNECTOR)
      ? await dbResult.val
          .selectFrom('provider_grants')
          .select('display_name')
          .where('tenant_id', '=', tenant.id)
          .where('provider', '=', WEBEX_USER)
          .where('subject', '=', session.subject)
          .executeTakeFirst()
      : undefined;

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Connectors</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Your connected accounts, and the endpoint your LLM app talks to.
      </p>

      <div className="space-y-6">
        {enabled.has('atlassian') ? (
          <JiraConnector tenantId={tenant.id} />
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
          />
        )}

        <McpEndpoint tenantId={tenant.id} />
      </div>
    </div>
  );
}
