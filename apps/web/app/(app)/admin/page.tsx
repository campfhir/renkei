import React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import CoachTarget from '@/components/coach-marks/anchor';
import { adminSections } from '@/lib/admin-areas';
import { anchorId } from '@/lib/hash-scroll';
import { Icon, ICONS } from '@/components/icons';

/**
 * The Organization page: the admin console's front door, and the only
 * place the console's areas are listed — the app menu does not carry
 * them. A signed-in user without the operator role is told so rather
 * than being offered a sign-in that would change nothing; a signed-out
 * visitor is sent into the tenant's OIDC flow and comes back here (the
 * layout does this on a fresh load; this page does it for a session that
 * expired between two client-side navigations).
 */
export default async function AdminPage(): Promise<React.ReactNode> {
  const access = await checkAccess([ROLE_OPERATOR]);
  if (access) {
    const sections = adminSections();
    return (
      <div className="max-w-4xl">
        <h1 className="mb-1 text-xl font-bold">Organization</h1>
        <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
          Everything an operator configures for this organization. Activity for the whole
          organization is on the shared Activity page.
        </p>
        <CoachTarget name="admin-sections">
          {/* A phone, where this list is how an area is reached: the groups as
              cards, a row to each area, as Preferences lists its sections. */}
          <div className="space-y-4 lg:hidden">
            {sections.map((section) => (
              <section
                key={section.label}
                aria-labelledby={`admin-group-${anchorId('list', section.label)}`}
                className="overflow-hidden rounded-lg border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-950"
              >
                <h2
                  id={`admin-group-${anchorId('list', section.label)}`}
                  className="border-b border-gray-200 bg-gray-50 px-4 py-2 text-xs font-semibold tracking-wide text-gray-500 uppercase dark:border-gray-800 dark:bg-gray-900"
                >
                  {section.label}
                </h2>
                <ul>
                  {section.areas.map((area, index) => (
                    <li
                      key={area.href}
                      className={index > 0 ? 'border-t border-gray-100 dark:border-gray-900' : ''}
                    >
                      <Link
                        href={area.href}
                        className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 dark:hover:bg-gray-900"
                      >
                        <Icon
                          path={ICONS[area.icon]}
                          className="h-5 w-5 shrink-0 text-gray-500 dark:text-gray-400"
                        />
                        <span className="min-w-0 flex-1">
                          <span className="block font-medium">{area.label}</span>
                          <span className="line-clamp-2 text-sm text-gray-500 dark:text-gray-400">
                            {area.detail}
                          </span>
                        </span>
                        <Icon path={ICONS.chevron} className="h-4 w-4 shrink-0 text-gray-400" />
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
          {/* A wide screen, where the sidebar is the way in: what each area is for. */}
          <div className="hidden lg:block">
            {sections.map((section) => (
              <section key={section.label} className="mb-8">
                <h2 className="mb-3 text-xs font-semibold uppercase tracking-wide text-gray-500">
                  {section.label}
                </h2>
                <ul className="grid gap-3 sm:grid-cols-2">
                  {section.areas.map((area) => (
                    <li key={area.href}>
                      <Link
                        href={area.href}
                        className="block h-full rounded-xl border border-gray-200 bg-white p-4 hover:border-blue-300 hover:bg-blue-50/40 dark:border-gray-800 dark:bg-gray-950 dark:hover:border-blue-800 dark:hover:bg-blue-950/20"
                      >
                        <p className="text-sm font-semibold">{area.label}</p>
                        <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">
                          {area.detail}
                        </p>
                      </Link>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </div>
        </CoachTarget>
      </div>
    );
  }

  const session = await getSessionFromCookies();
  if (!session) {
    redirect(signInUrl(`/admin`));
  }
  return (
    <div className="max-w-lg">
      <h2 className="mb-2 text-lg font-semibold">Operator access required</h2>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        You are signed in, but your account does not carry the operator role for this organization.
        Roles come from your identity provider&apos;s claim mapping — an existing operator can check
        it under Settings.
      </p>
    </div>
  );
}
