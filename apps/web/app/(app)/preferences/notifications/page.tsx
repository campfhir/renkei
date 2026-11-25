import React from 'react';
import { redirect } from 'next/navigation';
import { getDataStore } from '@renkei/db';
import { getNotificationPrefs } from '@renkei/user-prefs';
import { actsByConnector, ACT_CATEGORIES } from '@renkei/tool-outcomes';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { CONNECTOR_CATALOG } from '@/lib/connector-catalog';
import { getChannelAvailability } from '@/lib/notification-channels';
import { hasCodeHost } from '@/lib/code/access';
import PreferencesForm from '../preferences-form';
import { notificationConnectorRows } from '../preferences-form.model';
import { NOTIFICATION_CARDS } from '../preferences-nav.model';

/**
 * Preferences › Notifications: what Renkei tells you about, and where.
 * Long, so a phone gets a row of chips that jump to each card (a wide
 * screen lists them in the sidebar instead).
 */
export default async function NotificationsPreferencesPage(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/preferences/notifications`));
  const [notifications, channels, myAgents, codeHost] = await Promise.all([
    getNotificationPrefs(session.subject, { fresh: true }),
    getChannelAvailability(session.subject),
    // Just id + name: the overrides picker names an agent, it doesn't need its steps.
    getDataStore()
      .personalAccount.ownedAgentNames(session.subject)
      .catch(() => []),
    // The Deployments card is for someone with Bitbucket or GitHub connected.
    hasCodeHost(session.subject),
  ]);
  /*
    The categories each connector's acts fall into, one row per capability
    key (Jira and Jira Service Management share one), resolved here rather
    than in the form: pure data the server already has in memory. A
    connector with no curated acts is dropped rather than shown empty.
  */
  const connectors = notificationConnectorRows(
    CONNECTOR_CATALOG,
    actsByConnector(),
    ACT_CATEGORIES
  );
  return (
    <div>
      <nav
        aria-label="Notification cards"
        className="sticky top-14 z-10 -mx-4 mb-3 flex gap-1.5 overflow-x-auto border-b border-gray-200 bg-white/95 px-4 py-2 sm:-mx-6 sm:px-6 backdrop-blur lg:hidden dark:border-gray-800 dark:bg-black/90"
      >
        {NOTIFICATION_CARDS.map((card) => (
          <a
            key={card.id}
            href={`#${card.id}`}
            className="shrink-0 rounded-full border border-gray-300 px-2.5 py-1 text-xs whitespace-nowrap text-gray-700 hover:bg-gray-100 dark:border-gray-700 dark:text-gray-300 dark:hover:bg-gray-900"
          >
            {card.label}
          </a>
        ))}
      </nav>
      <PreferencesForm
        connectors={connectors}
        channels={channels}
        deployments={codeHost}
        initial={notifications}
        agents={myAgents}
      />
    </div>
  );
}
