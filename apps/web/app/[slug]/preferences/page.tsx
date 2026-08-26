import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { getNotificationPrefs } from '@renkei/user-prefs';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog';
import PreferencesForm from './preferences-form';

/**
 * The page the nav's Preferences item has been pointing at since before it
 * existed — its placeholder said "Coming soon" and carried a comment
 * explaining it was waiting for a per-user store.
 */
export default async function PreferencesPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) redirect(signInUrl(tenant.id, `/${slug}/preferences`));

  const notifications = await getNotificationPrefs(tenant.id, session.subject, { fresh: true });

  // One row per capability key, not per catalog entry: Jira and Jira
  // Service Management share a key, so two rows would be two switches for
  // one thing that disagree with each other the moment somebody uses them.
  const seen = new Set<string>();
  const connectors = CONNECTOR_CATALOG.filter((entry) => {
    if (seen.has(entry.capabilityKey)) return false;
    seen.add(entry.capabilityKey);
    return true;
  }).map((entry) => ({ key: entry.capabilityKey, label: entry.label }));

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Preferences</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Yours alone — nobody else sees these, and they change nothing about what your agents are
        allowed to do.
      </p>
      <PreferencesForm tenantId={tenant.id} connectors={connectors} initial={notifications} />
    </div>
  );
}
