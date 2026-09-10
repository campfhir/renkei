import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { getOrgSettings } from '@renkei/settings';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { CONNECTOR_DEFINITIONS } from '@/lib/connectors/definitions';
import ConnectorList, { type ConnectorRow } from './connector-list';

/**
 * Org-admin provisioning of connectors (RENKEI.md Decision #13), as a
 * catalog: every connector the code knows, searchable and grouped, each
 * with its status and a page of its own. The forms used to stack on this
 * page in one long scroll; with a dozen of them, reaching the one that
 * matters meant scrolling past the eleven that did not.
 *
 * What is shown here is presence and state only — a config row exists, it
 * is enabled, the org switched its tools off. Secrets never reach this page.
 */
export default async function AdminConnectorsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) notFound();
  if (!(await checkAccess(tenantRef.id, [ROLE_OPERATOR]))) {
    redirect(`/${slug}/admin`);
  }

  const settings = await getOrgSettings(tenantRef.id);
  const disabledConnectors = settings.ok ? settings.val.disabledConnectors : [];
  const audiences = settings.ok ? settings.val.connectorAudiences : {};

  const dbResult = getDatabase();
  const configs = dbResult.ok
    ? await dbResult.val
        .selectFrom('connector_configs')
        .select(['connector', 'enabled'])
        .where('tenant_id', '=', tenantRef.id)
        .execute()
    : [];
  const configByKey = new Map(configs.map((row) => [row.connector, row.enabled]));

  const rows: ConnectorRow[] = CONNECTOR_DEFINITIONS.map((definition) => ({
    configKey: definition.configKey,
    label: definition.label,
    category: definition.entries[0].category,
    configurable: definition.adminForm !== undefined,
    manageHref: definition.manageHref ? definition.manageHref(slug) : null,
    configured: configByKey.has(definition.configKey),
    enabled: configByKey.get(definition.configKey) ?? false,
    products: definition.entries.map((entry) => ({
      capabilityKey: entry.capabilityKey,
      label: entry.label,
      summary: entry.summary,
      toolPrefix: entry.toolPrefix,
      keywords: entry.keywords,
      togglable: entry.togglable,
      audienceGroups: audiences[entry.capabilityKey]?.length ?? 0,
    })),
  }));

  return (
    <div className="mx-auto max-w-4xl">
      <h1 className="mb-1 text-xl font-bold">Connector setup</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        What your organization runs, with what credentials. Open a connector to register its app and
        secrets; switch one off to stop its tools being offered to everyone, immediately, without
        touching anyone&rsquo;s connection.
      </p>
      <ConnectorList slug={slug} rows={rows} initialDisabled={disabledConnectors} />
    </div>
  );
}
