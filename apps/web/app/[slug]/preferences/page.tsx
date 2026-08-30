import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { getNotificationPrefs } from '@renkei/user-prefs';
import { actsByConnector } from '@renkei/tool-outcomes';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog';
import NotificationPermissionNudge from '@/components/notification-permission-nudge';
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

  /*
    The acts each connector can perform, resolved HERE rather than in the
    form: the catalog is pure data, so shipping the whole of it to the
    browser to be grouped there would be work done twice — once at build,
    once per visit — for a list the server already has in memory.

    One row per capability key, not per catalog entry: Jira and Jira
    Service Management share a key, so two rows would be two switches for
    one thing that disagree with each other the moment somebody uses them.
    That is also why JSM's acts read "service request" — they sit in the
    Jira group and still have to be tellable apart.

    A connector with no curated acts is dropped rather than shown empty.
    Everything it does still reaches the "anything else" default, so
    nothing goes unreported; there is simply nothing here to decide yet.
  */
  const acts = new Map(actsByConnector().map((group) => [group.connector, group.acts]));
  const seen = new Set<string>();
  const connectors = CONNECTOR_CATALOG.filter((entry) => {
    if (seen.has(entry.capabilityKey)) return false;
    seen.add(entry.capabilityKey);
    return acts.has(entry.capabilityKey);
  }).map((entry) => ({
    key: entry.capabilityKey,
    label: entry.label,
    acts: acts.get(entry.capabilityKey) ?? [],
  }));

  return (
    /*
      Wider than the usual max-w-3xl reading column, because this page is
      not prose: its bulk is a grid of forty-odd short checkbox labels, and
      3xl leaves room for two columns where 5xl fits three. Still capped —
      the layout's own max-w-6xl would stretch the explanatory sentences
      past comfortable reading length to no benefit.
    */
    <div className="mx-auto max-w-5xl">
      <NotificationPermissionNudge
        tenantId={tenant.id}
        desktopEnabled={notifications.desktopEnabled}
      />
      <h1 className="mb-1 text-xl font-bold">Preferences</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Yours alone — nobody else sees these, and they change nothing about what your agents are
        allowed to do.
      </p>
      <PreferencesForm tenantId={tenant.id} connectors={connectors} initial={notifications} />
    </div>
  );
}
