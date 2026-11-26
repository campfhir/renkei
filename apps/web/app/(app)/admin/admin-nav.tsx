'use client';

/**
 * The frame every Organization page sits in. On a wide screen: the area
 * sidebar beside the page, the sidebar staying put while the page scrolls
 * (Settings lists its groups under it while it is open). On a phone the
 * area list is the /admin page itself (page.tsx), and an area opens with
 * a link back to it instead of the sidebar (a Settings group, back to
 * Settings). Which area is current is
 * admin-nav.model.ts's; the areas are lib/admin-areas.ts's.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, ICONS } from '@/components/icons';
import { adminSections } from '@/lib/admin-areas';
import {
  ADMIN_PATH,
  SETTINGS_GROUPS,
  SETTINGS_HREF,
  backLink,
  currentArea,
  currentSettingsGroup,
  isAreaList,
  settingsGroupHref,
} from './admin-nav.model';

const SECTIONS = adminSections();

export default function AdminFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const current = currentArea(pathname);
  const atList = isAreaList(pathname);
  const group = currentSettingsGroup(pathname);
  const back = backLink(pathname);

  return (
    <div className="mx-auto max-w-7xl">
      {back ? (
        <Link
          href={back.href}
          className="mb-3 inline-flex items-center gap-0.5 text-sm text-blue-600 hover:underline lg:hidden dark:text-blue-400"
        >
          <Icon path={ICONS.chevron} className="h-4 w-4 rotate-180" />
          {back.label}
        </Link>
      ) : null}
      <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start lg:gap-8">
        <nav
          aria-label="Organization areas"
          className="sticky top-20 hidden max-h-[calc(100vh-6rem)] flex-col gap-3 overflow-y-auto text-sm lg:flex"
        >
          <Link
            href={ADMIN_PATH}
            aria-current={atList ? 'page' : undefined}
            className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 ${
              atList
                ? 'bg-blue-50 font-semibold text-blue-700 dark:bg-blue-950/50 dark:text-blue-300'
                : 'text-gray-800 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-900'
            }`}
          >
            <Icon
              path={ICONS.building}
              className={`h-4 w-4 shrink-0 ${atList ? '' : 'text-gray-500 dark:text-gray-400'}`}
            />
            <span className="truncate">Overview</span>
          </Link>
          {SECTIONS.map((section) => (
            <div key={section.label}>
              <p className="mb-1 px-2.5 text-xs font-semibold tracking-wide text-gray-500 uppercase">
                {section.label}
              </p>
              <ul className="space-y-0.5">
                {section.areas.map((area) => {
                  const here = current === area.href;
                  return (
                    <li key={area.href}>
                      <Link
                        href={area.href}
                        aria-current={
                          here && !(group && area.href === SETTINGS_HREF) ? 'page' : undefined
                        }
                        className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 ${
                          here
                            ? 'bg-blue-50 font-semibold text-blue-700 dark:bg-blue-950/50 dark:text-blue-300'
                            : 'text-gray-800 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-900'
                        }`}
                      >
                        <Icon
                          path={ICONS[area.icon]}
                          className={`h-4 w-4 shrink-0 ${here ? '' : 'text-gray-500 dark:text-gray-400'}`}
                        />
                        <span className="truncate">{area.label}</span>
                      </Link>
                      {here && area.href === SETTINGS_HREF ? (
                        <ul className="mt-0.5 mb-1 ml-5 border-l border-gray-200 dark:border-gray-800">
                          {SETTINGS_GROUPS.map((entry) => (
                            <li key={entry.id}>
                              <Link
                                href={settingsGroupHref(entry.id)}
                                aria-current={group === entry.id ? 'page' : undefined}
                                className={`block py-0.5 pl-3 text-xs ${
                                  group === entry.id
                                    ? 'font-semibold text-blue-700 dark:text-blue-300'
                                    : 'text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
                                }`}
                              >
                                {entry.label}
                              </Link>
                            </li>
                          ))}
                        </ul>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <div className="min-w-0">{children}</div>
      </div>
    </div>
  );
}
