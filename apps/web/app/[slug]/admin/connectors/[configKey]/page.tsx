import React from 'react';
import { redirect, notFound } from 'next/navigation';
import Link from 'next/link';
import { getOrgSettings } from '@renkei/settings';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { resolvePublicOrigin } from '@/lib/public-origin';
import { definitionFor } from '@/lib/connectors/definitions';
import BackLink from '@/components/back-link';
import ConnectorIcon from '@/components/connector-icon';
import AvailabilityToggles from '../availability-toggles';

/**
 * One connector's page: its credentials form, and the org-wide switches
 * for the capabilities it provisions. Addressable — /admin/connectors/zoom
 * is a link somebody can be sent — which is what the catalog list is for.
 */
export default async function AdminConnectorPage({
  params,
}: {
  params: Promise<{ slug: string; configKey: string }>;
}): Promise<React.ReactNode> {
  const { slug, configKey } = await params;
  const tenantRef = await tenantForSlug(slug);
  if (!tenantRef) notFound();
  if (!(await checkAccess(tenantRef.id, [ROLE_OPERATOR]))) {
    redirect(`/${slug}/admin`);
  }

  const definition = definitionFor(configKey);
  if (!definition) notFound();
  if (definition.manageHref) redirect(definition.manageHref(slug));

  const origin = await resolvePublicOrigin();
  const settings = await getOrgSettings(tenantRef.id);
  const disabledConnectors = settings.ok ? settings.val.disabledConnectors : [];
  const Form = definition.adminForm;
  const togglable = definition.entries.filter((entry) => entry.togglable);
  // Jira and JSM share one capability key; one switch, listed once.
  const seen = new Set<string>();
  const switches = togglable
    .filter((entry) => {
      if (seen.has(entry.capabilityKey)) return false;
      seen.add(entry.capabilityKey);
      return true;
    })
    .map((entry) => ({
      capabilityKey: entry.capabilityKey,
      label: entry.capabilityKey === 'jira' ? 'Jira and Jira Service Management' : entry.label,
      toolPrefix: togglable
        .filter((product) => product.capabilityKey === entry.capabilityKey)
        .map((product) => product.toolPrefix)
        .join(', '),
    }));

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <div className="mb-1 flex items-center gap-2">
          <BackLink href={`/${slug}/admin/connectors`} label="All connectors" />
          <ConnectorIcon
            capabilityKey={definition.entries[0].capabilityKey}
            label={definition.label}
            size={22}
            maxWidth={88}
          />
          <h1 className="min-w-0 truncate text-xl font-bold">{definition.label}</h1>
        </div>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          {definition.entries.length === 1
            ? definition.entries[0].summary
            : `One registration provisions ${definition.entries.map((entry) => entry.label).join(', ')}.`}
        </p>
      </div>

      {Form ? (
        <Form slug={slug} tenantId={tenantRef.id} origin={origin} />
      ) : (
        <section className="rounded-lg border border-gray-200 bg-white p-4 text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-400">
          Nothing to configure: Renkei provides this connector without credentials.
        </section>
      )}

      {switches.length > 0 && (
        <AvailabilityToggles slug={slug} initialDisabled={disabledConnectors} products={switches} />
      )}

      <p className="text-xs text-gray-500 dark:text-gray-400">
        People connect their own account from{' '}
        <Link href={`/${slug}/connectors`} className="underline">
          Connectors
        </Link>
        , where this appears in their catalog once it is enabled here.
      </p>
    </div>
  );
}
