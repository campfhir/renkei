import React from 'react';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { readAtlassianMetadata } from '@renkei/provider-grants';

/**
 * The Jira sites this tenant actually reaches, derived from the connected
 * grants — each grant records the cloud id and site URL Atlassian answered
 * with at connect time. Derived, not managed: every tool call runs against
 * the caller's own grant, so the site list IS the grant list, aggregated.
 *
 * This replaces a page that read the tenant_jira_sites table, which nothing
 * ever wrote (its claim/enable routes had no UI) and nothing ever enforced —
 * it reported "no sites" forever while Jira demonstrably worked.
 */
export default async function SitesPage({
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

  const dbResult = getDatabase();
  if (!dbResult.ok) {
    return (
      <div>
        <h2 className="mb-2 text-lg font-semibold">Error</h2>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Unable to connect to the database. Please try again later.
        </p>
      </div>
    );
  }

  const grants = await dbResult.val
    .selectFrom('provider_grants')
    .select(['metadata', 'display_name', 'created_at'])
    .where('tenant_id', '=', tenantRef.id)
    .where('provider', '=', 'atlassian')
    .execute();

  // Aggregate grants by site: which clouds this org touches, through whom.
  const sites = new Map<
    string,
    { cloudId: string; siteUrl: string; users: string[]; firstConnected: Date }
  >();
  for (const grant of grants) {
    const metadata =
      typeof grant.metadata === 'object' &&
      grant.metadata !== null &&
      !Array.isArray(grant.metadata)
        ? readAtlassianMetadata({ ...grant.metadata })
        : { cloudId: '', siteUrl: '' };
    if (!metadata.cloudId) continue;

    const connected = new Date(grant.created_at);
    const existing = sites.get(metadata.cloudId);
    if (existing) {
      existing.users.push(grant.display_name ?? 'Unknown');
      if (connected < existing.firstConnected) existing.firstConnected = connected;
    } else {
      sites.set(metadata.cloudId, {
        cloudId: metadata.cloudId,
        siteUrl: metadata.siteUrl,
        users: [grant.display_name ?? 'Unknown'],
        firstConnected: connected,
      });
    }
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Jira sites</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        The Atlassian sites this organization reaches, derived from connected accounts. Every
        request runs as the connected user — disconnecting the accounts disconnects the site.
      </p>

      {sites.size === 0 ? (
        <div className="rounded-lg border border-gray-200 bg-white p-6 text-center text-sm text-gray-600 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-400">
          No Jira sites yet — they appear when someone connects a Jira account under Connectors.
        </div>
      ) : (
        <div className="space-y-4">
          {[...sites.values()].map((site) => (
            <div
              key={site.cloudId}
              className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <a
                  href={site.siteUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-blue-600 hover:underline dark:text-blue-400"
                >
                  {site.siteUrl.replace(/^https?:\/\//, '') || site.cloudId}
                </a>
                <span className="text-xs text-gray-500">
                  since {site.firstConnected.toLocaleDateString()}
                </span>
              </div>
              <p className="mt-1 font-mono text-xs text-gray-500">{site.cloudId}</p>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-400">
                {site.users.length === 1
                  ? `1 connected account: ${site.users[0]}`
                  : `${site.users.length} connected accounts: ${site.users.join(', ')}`}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
