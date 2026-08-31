import React from 'react';
import { redirect, notFound } from 'next/navigation';
import { getNotificationPrefs } from '@renkei/user-prefs';
import { actsByConnector, ACT_CATEGORIES } from '@renkei/tool-outcomes';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog';
import { getChannelAvailability } from '@/lib/notification-channels';
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

  const [notifications, channels] = await Promise.all([
    getNotificationPrefs(tenant.id, session.subject, { fresh: true }),
    getChannelAvailability(tenant.id, session.subject),
  ]);

  /*
    The CATEGORIES each connector's acts fall into, resolved HERE rather
    than in the form for the same reason the old per-act list was: pure
    data, so grouping it in the browser would be work done twice for
    something the server already has in memory.

    One row per capability key, not per catalog entry: Jira and Jira
    Service Management share a key, so two rows would be two switches for
    one thing that disagree with each other the moment somebody uses them.

    Category, not act: a person choosing delivery for three channels over
    a couple hundred individual acts does not survive contact with eleven
    connectors (see the preferences form's own notes). 'other' is always
    offered, even when no curated act happens to declare it — it is the
    catch-all for everything this build has no wording for yet, which by
    definition never shows up in the curated list itself.

    A connector with no curated acts at all is dropped rather than shown
    empty — there is nothing here to decide yet.
  */
  const actsByKey = new Map(actsByConnector().map((group) => [group.connector, group.acts]));
  const seen = new Set<string>();
  const connectors = CONNECTOR_CATALOG.filter((entry) => {
    if (seen.has(entry.capabilityKey)) return false;
    seen.add(entry.capabilityKey);
    return actsByKey.has(entry.capabilityKey);
  }).map((entry) => {
    const present = new Set(actsByKey.get(entry.capabilityKey)?.map((act) => act.category) ?? []);
    const categories = ACT_CATEGORIES.filter(
      (category) => category === 'other' || present.has(category)
    );
    return { key: entry.capabilityKey, label: entry.label, categories };
  });

  return (
    /*
      Wider than the usual max-w-3xl reading column, because this page is
      not prose: its bulk is a grid of forty-odd short checkbox labels, and
      3xl leaves room for two columns where 5xl fits three. Still capped —
      the layout's own max-w-6xl would stretch the explanatory sentences
      past comfortable reading length to no benefit.
    */
    <div className="mx-auto max-w-5xl">
      <h1 className="mb-1 text-xl font-bold">Preferences</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Yours alone — nobody else sees these, and they change nothing about what your agents are
        allowed to do.
      </p>
      <PreferencesForm
        tenantId={tenant.id}
        slug={slug}
        connectors={connectors}
        channels={channels}
        initial={notifications}
      />
    </div>
  );
}
