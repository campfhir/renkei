import React from 'react';
import Link from 'next/link';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { tenantForSlug } from '@/lib/tenant-slug';
import { redirect, notFound } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { readAtlassianMetadata } from '@renkei/provider-grants';

/**
 * Every external place this org's Renkei reaches, in two kinds:
 *
 *  - Atlassian sites, derived from connected grants across all three
 *    Atlassian apps (Jira, JSM, Confluence) — each grant records the cloud
 *    id it was minted for, so the site list IS the grant list, aggregated,
 *    with a product badge per app that reaches it.
 *  - Indexed scopes from content watches — the SharePoint libraries,
 *    Confluence spaces and Jira projects someone is feeding into knowledge
 *    search, with their sync state.
 *
 * Derived, not managed, and the page says where the actions live: access is
 * per-person (People), indexing is per-watch (each user's Knowledge page).
 */

const PRODUCT_OF_PROVIDER: Record<string, string> = {
  atlassian: 'Jira',
  'atlassian-jsm': 'JSM',
  'atlassian-confluence': 'Confluence',
};

const WATCH_KIND: Record<string, string> = {
  project: 'Jira project',
  space: 'Confluence space',
  drive: 'SharePoint / OneDrive library',
};

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

  const [grants, watches] = await Promise.all([
    dbResult.val
      .selectFrom('provider_grants')
      .select(['provider', 'metadata', 'display_name', 'created_at'])
      .where('tenant_id', '=', tenantRef.id)
      .where('provider', 'in', ['atlassian', 'atlassian-jsm', 'atlassian-confluence'])
      .execute(),
    dbResult.val
      .selectFrom('content_watches')
      .select(['provider', 'scope_type', 'scope_label', 'scope_key', 'enabled', 'sync_status'])
      .where('tenant_id', '=', tenantRef.id)
      .orderBy('provider')
      .execute(),
  ]);

  // Aggregate Atlassian grants by cloud: which site, through which products,
  // via how many accounts. JSM/Confluence grants record only the cloud id,
  // so the site URL comes from whichever grant of the trio carries one.
  const sites = new Map<
    string,
    { cloudId: string; siteUrl: string; products: Set<string>; users: Set<string> }
  >();
  for (const grant of grants) {
    const metadata =
      typeof grant.metadata === 'object' &&
      grant.metadata !== null &&
      !Array.isArray(grant.metadata)
        ? readAtlassianMetadata({ ...grant.metadata })
        : { cloudId: '', siteUrl: '' };
    if (!metadata.cloudId) continue;

    let site = sites.get(metadata.cloudId);
    if (!site) {
      site = { cloudId: metadata.cloudId, siteUrl: '', products: new Set(), users: new Set() };
      sites.set(metadata.cloudId, site);
    }
    if (metadata.siteUrl) site.siteUrl = metadata.siteUrl;
    site.products.add(PRODUCT_OF_PROVIDER[grant.provider] ?? grant.provider);
    site.users.add(grant.display_name ?? 'Unknown');
  }

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Sites</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        The external places this organization reaches — derived from connected accounts and content
        watches. Access is per-person: manage it on{' '}
        <Link
          href={`/${slug}/admin/people`}
          className="text-blue-600 hover:underline dark:text-blue-400"
        >
          People
        </Link>
        .
      </p>

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
        Atlassian sites
      </h2>
      {sites.size === 0 ? (
        <p className="mb-6 text-sm text-gray-500">
          None yet — they appear when someone connects Jira, JSM or Confluence.
        </p>
      ) : (
        <div className="mb-8 space-y-3">
          {[...sites.values()].map((site) => (
            <div
              key={site.cloudId}
              className="rounded-lg border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
            >
              <div className="flex flex-wrap items-center gap-2">
                {site.siteUrl ? (
                  <a
                    href={site.siteUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="font-semibold text-blue-600 hover:underline dark:text-blue-400"
                  >
                    {site.siteUrl.replace(/^https?:\/\//, '')}
                  </a>
                ) : (
                  <span className="font-semibold">{site.cloudId}</span>
                )}
                {[...site.products].map((product) => (
                  <span
                    key={product}
                    className="rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-blue-800 dark:bg-blue-900/40 dark:text-blue-300"
                  >
                    {product}
                  </span>
                ))}
              </div>
              <p className="mt-1 break-all font-mono text-xs text-gray-500">{site.cloudId}</p>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                {site.users.size === 1
                  ? `1 connected account: ${[...site.users][0]}`
                  : `${site.users.size} connected accounts: ${[...site.users].join(', ')}`}
              </p>
            </div>
          ))}
        </div>
      )}

      <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
        Indexed for knowledge search
      </h2>
      {watches.length === 0 ? (
        <p className="text-sm text-gray-500">
          Nothing indexed yet — people set up watches on their Knowledge page.
        </p>
      ) : (
        <div className="space-y-2">
          {watches.map((watch) => (
            <div
              key={`${watch.provider}:${watch.scope_type}:${watch.scope_key}`}
              className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-gray-200 bg-white px-4 py-2.5 dark:border-gray-800 dark:bg-gray-950"
            >
              <div className="min-w-0">
                <span className="font-medium">{watch.scope_label || watch.scope_key}</span>
                <span className="ml-2 text-xs text-gray-500">
                  {WATCH_KIND[watch.scope_type] ?? `${watch.provider} ${watch.scope_type}`}
                </span>
              </div>
              <span
                className={`text-xs ${
                  !watch.enabled
                    ? 'text-gray-400 dark:text-gray-600'
                    : watch.sync_status === 'error'
                      ? 'text-red-600 dark:text-red-400'
                      : 'text-gray-500'
                }`}
              >
                {!watch.enabled ? 'off' : watch.sync_status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
