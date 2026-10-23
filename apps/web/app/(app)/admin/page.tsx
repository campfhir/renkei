import React from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { checkAccess, ROLE_OPERATOR } from '@/lib/access';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import CoachTarget from '@/components/coach-marks/anchor';
import { adminSections } from '@/lib/admin-areas';

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
    return (
      <div className="mx-auto max-w-4xl">
        <h1 className="mb-1 text-xl font-bold">Organization</h1>
        <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
          Everything an operator configures for this organization. Activity for the whole
          organization is on the shared Activity page.
        </p>
        <CoachTarget name="admin-sections">
          {adminSections().map((section) => (
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
                      <p className="mt-1 text-sm text-gray-600 dark:text-gray-400">{area.detail}</p>
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </CoachTarget>
      </div>
    );
  }

  const session = await getSessionFromCookies();
  if (!session) {
    redirect(signInUrl(`/admin`));
  }
  return (
    <div className="mx-auto max-w-lg">
      <h2 className="mb-2 text-lg font-semibold">Operator access required</h2>
      <p className="text-sm text-gray-600 dark:text-gray-400">
        You are signed in, but your account does not carry the operator role for this organization.
        Roles come from your identity provider&apos;s claim mapping — an existing operator can check
        it under Settings.
      </p>
    </div>
  );
}
