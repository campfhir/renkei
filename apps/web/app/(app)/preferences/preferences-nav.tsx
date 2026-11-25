'use client';

/**
 * The frame every Preferences page sits in. On a wide screen: the title,
 * then the section sidebar beside the section, the sidebar staying put
 * while the section scrolls (Notifications lists its cards under it while
 * it is open). On a phone the section list is the /preferences page
 * itself (page.tsx), and a section opens with a link back to it instead
 * of the sidebar. Which section is current, and what the sidebar lists,
 * is preferences-nav.model.ts's.
 */

import type { ReactNode } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Icon, ICONS } from '@/components/icons';
import {
  NOTIFICATION_CARDS,
  PREFERENCES_GROUPS,
  PREFERENCES_PATH,
  currentSection,
  isSectionList,
  sectionHref,
} from './preferences-nav.model';

export default function PreferencesFrame({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const current = currentSection(pathname);
  const atList = isSectionList(pathname);

  return (
    <div className="mx-auto max-w-6xl">
      <header className={atList ? 'mb-6' : 'mb-6 hidden lg:block'}>
        <h1 className="mb-1 text-xl font-bold">Preferences</h1>
        <p className="text-sm text-gray-600 dark:text-gray-400">
          Yours alone. Nobody else sees these.
        </p>
      </header>
      {atList ? null : (
        <Link
          href={PREFERENCES_PATH}
          className="mb-3 inline-flex items-center gap-0.5 text-sm text-blue-600 hover:underline lg:hidden dark:text-blue-400"
        >
          <Icon path={ICONS.chevron} className="h-4 w-4 rotate-180" />
          Preferences
        </Link>
      )}
      <div className="lg:grid lg:grid-cols-[13rem_minmax(0,1fr)] lg:items-start lg:gap-8">
        <nav
          aria-label="Preferences sections"
          className="sticky top-20 hidden max-h-[calc(100vh-6rem)] flex-col gap-3 overflow-y-auto text-sm lg:flex"
        >
          {PREFERENCES_GROUPS.map((group) => (
            <div key={group.label}>
              <p className="mb-1 px-2.5 text-xs font-semibold tracking-wide text-gray-500 uppercase">
                {group.label}
              </p>
              <ul className="space-y-0.5">
                {group.sections.map((section) => {
                  const here = current === section.id;
                  return (
                    <li key={section.id}>
                      <Link
                        href={sectionHref(section.id)}
                        aria-current={here ? 'page' : undefined}
                        className={`flex items-center gap-2.5 rounded-lg px-2.5 py-1.5 ${
                          here
                            ? 'bg-blue-50 font-semibold text-blue-700 dark:bg-blue-950/50 dark:text-blue-300'
                            : 'text-gray-800 hover:bg-gray-100 dark:text-gray-200 dark:hover:bg-gray-900'
                        }`}
                      >
                        <Icon
                          path={ICONS[section.icon]}
                          className={`h-4 w-4 shrink-0 ${here ? '' : 'text-gray-500 dark:text-gray-400'}`}
                        />
                        <span className="truncate">{section.label}</span>
                      </Link>
                      {here && section.id === 'notifications' ? (
                        <ul className="mt-0.5 mb-1 ml-5 border-l border-gray-200 dark:border-gray-800">
                          {NOTIFICATION_CARDS.map((card) => (
                            <li key={card.id}>
                              <a
                                href={`#${card.id}`}
                                className="block py-0.5 pl-3 text-xs text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                              >
                                {card.label}
                              </a>
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
