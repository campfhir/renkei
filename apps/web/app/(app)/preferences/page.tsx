import React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { getOrgSettings } from '@renkei/settings';
import { getChatArchivePrefs, getHighRiskPrefs, getThemePrefs } from '@renkei/user-prefs';
import { listAgents } from '@/lib/agents/store';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { getChatToolPermissionPrefs } from '@/lib/chat/permission-prefs';
import { Icon, ICONS } from '@/components/icons';
import CoachTarget from '@/components/coach-marks/anchor';
import { PREFERENCES_GROUPS, sectionHref, sectionSummaries } from './preferences-nav.model';

/**
 * Preferences: the sections, grouped, each with where it stands now. On a
 * phone this list is how you reach a section; on a wide screen the same
 * sections are in the sidebar beside it (preferences-nav.tsx) and this is
 * the overview. Each section is its own page and saves on its own.
 */
export default async function PreferencesPage(): Promise<React.ReactNode> {
  const session = await getSessionFromCookies();
  if (!session) redirect(signInUrl(`/preferences`));

  const [theme, archive, permissions, agents, codeHighRisk, org] = await Promise.all([
    getThemePrefs(session.subject, { fresh: true }),
    getChatArchivePrefs(session.subject, { fresh: true }),
    getChatToolPermissionPrefs(session.subject, { fresh: true }),
    listAgents(session.subject).catch(() => []),
    getHighRiskPrefs(session.subject, 'code', { fresh: true }),
    getOrgSettings(),
  ]);
  const locked = new Set(org.ok ? org.val.lockedHighRiskTools : []);
  const summaries = sectionSummaries({
    theme,
    archiveAfterDays: archive.afterDays,
    permissions: {
      allowed: permissions.alwaysAllow.length,
      blocked: permissions.alwaysDeny.length,
    },
    agentsAllowing: agents.filter((agent) => agent.allowedActions.some((tool) => !locked.has(tool)))
      .length,
    codeChanges: codeHighRisk.marked.length + codeHighRisk.unmarked.length,
  });

  return (
    <CoachTarget name="prefs-sections" className="space-y-4">
      {PREFERENCES_GROUPS.map((group) => (
        <section
          key={group.label}
          aria-labelledby={`prefs-group-${group.label}`}
          className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950"
        >
          <h2
            id={`prefs-group-${group.label}`}
            className="border-b border-gray-200 bg-gray-50 px-4 py-2 text-xs font-semibold tracking-wide text-gray-500 uppercase dark:border-gray-800 dark:bg-gray-900"
          >
            {group.label}
          </h2>
          <ul>
            {group.sections.map((section, index) => (
              <li
                key={section.id}
                className={index > 0 ? 'border-t border-gray-100 dark:border-gray-900' : ''}
              >
                <Link
                  href={sectionHref(section.id)}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-900"
                >
                  <Icon
                    path={ICONS[section.icon]}
                    className="h-5 w-5 shrink-0 text-gray-500 dark:text-gray-400"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{section.label}</span>
                    <span className="block truncate text-sm text-gray-500 dark:text-gray-400">
                      {summaries[section.id]}
                    </span>
                  </span>
                  <Icon path={ICONS.chevron} className="h-4 w-4 shrink-0 text-gray-400" />
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </CoachTarget>
  );
}
