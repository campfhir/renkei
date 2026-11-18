'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

/** The app's tabs under Deployments, the one open marked as the current page. */
export default function AppTabs({ projectId }: { projectId: string }) {
  const pathname = usePathname();
  const base = `/deployments/${projectId}`;
  const tabs = [
    { href: base, label: 'Deployments' },
    { href: `${base}/pipeline`, label: 'Pipeline' },
    { href: `${base}/runs`, label: 'Runs & variables' },
  ];
  return (
    <nav
      aria-label="App"
      className="flex gap-4 overflow-x-auto border-b border-gray-200 dark:border-gray-800"
    >
      {tabs.map((tab) => {
        const current = pathname === tab.href;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            aria-current={current ? 'page' : undefined}
            className={`-mb-px border-b-2 px-1 pb-2 text-sm font-semibold whitespace-nowrap ${
              current
                ? 'border-blue-600 text-blue-700 dark:text-blue-400'
                : 'border-transparent text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100'
            }`}
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}
