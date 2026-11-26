import React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { Icon, ICONS } from '@/components/icons';
import CoachTarget from '@/components/coach-marks/anchor';
import { SETTINGS_GROUPS, settingsGroupHref } from '../admin-nav.model';

/**
 * The org's operating settings — everything adjustable that has no more
 * specific home — as its groups, each a page of its own
 * (settings/[group]/page.tsx). Connector switches live on Connector
 * setup, redaction on Sensitive data, run retention on Agent oversight;
 * Settings owns the rest (read-only mode, agent guardrails, token
 * lifetimes, request limits) and says where the others went instead of
 * duplicating them.
 */
export default async function SettingsPage(): Promise<React.ReactNode> {
  if (!(await checkAccess([ROLE_OPERATOR]))) {
    redirect(`/admin`);
  }

  return (
    <div className="max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Settings</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Organization-wide controls. Changes take effect within a minute and are recorded in the{' '}
        <Link href={`/admin/audit`} className="text-blue-600 hover:underline dark:text-blue-400">
          audit trail
        </Link>
        .
      </p>

      <CoachTarget
        as="section"
        name="admin-settings-groups"
        className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950"
      >
        <nav aria-label="Settings groups">
          <ul>
            {SETTINGS_GROUPS.map((group, index) => (
              <li
                key={group.id}
                className={index > 0 ? 'border-t border-gray-100 dark:border-gray-900' : ''}
              >
                <Link
                  href={settingsGroupHref(group.id)}
                  className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-900"
                >
                  <Icon
                    path={ICONS[group.icon]}
                    className="h-5 w-5 shrink-0 text-gray-500 dark:text-gray-400"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block font-medium">{group.label}</span>
                    <span className="line-clamp-2 text-sm text-gray-500 dark:text-gray-400">
                      {group.blurb}
                    </span>
                  </span>
                  <Icon path={ICONS.chevron} className="h-4 w-4 shrink-0 text-gray-400" />
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </CoachTarget>

      <section className="mt-6 rounded-lg border border-gray-200 bg-white p-4 text-sm dark:border-gray-800 dark:bg-gray-950">
        <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-gray-500">
          Elsewhere
        </h2>
        <ul className="space-y-1 text-gray-600 dark:text-gray-400">
          <li>
            Connector on/off switches and scope ceilings —{' '}
            <Link
              href={`/admin/connectors`}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              Connector setup
            </Link>
          </li>
          <li>
            Redaction detectors and record-number formats —{' '}
            <Link
              href={`/admin/redaction`}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              Sensitive data
            </Link>
          </li>
          <li>
            Agent run history retention —{' '}
            <Link
              href={`/admin/agents`}
              className="text-blue-600 hover:underline dark:text-blue-400"
            >
              Agent oversight
            </Link>
          </li>
        </ul>
      </section>
    </div>
  );
}
