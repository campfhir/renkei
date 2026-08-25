import React from 'react';
import type { Metadata } from 'next';
import { notFound, redirect } from 'next/navigation';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { CHANGELOG, buildLabel, type ChangelogEntry } from '@/lib/changelog';
import RenkeiMark from '@/components/renkei-mark';
import packageJson from '../../../package.json';

export const metadata: Metadata = { title: 'About' };

const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * `2026-08-25` → `25 August 2026`, with no timezone in sight.
 *
 * Deliberately not LocalTime: a release date is a CALENDAR date, not an
 * instant. Parsing it as midnight UTC and rendering it in the viewer's zone
 * shows the day before for anyone west of Greenwich, which is both wrong and
 * the kind of wrong nobody reports.
 */
function releaseDate(iso: string): string {
  const [year, month, day] = iso.split('-').map(Number);
  const name = MONTHS[month - 1];
  return name ? `${day} ${name} ${year}` : iso;
}

/** Kind → the pill it renders as. Colour carries the same meaning throughout. */
const KIND_STYLE: Record<ChangelogEntry['kind'], { label: string; className: string }> = {
  added: {
    label: 'New',
    className: 'bg-green-100 text-green-800 dark:bg-green-950 dark:text-green-300',
  },
  changed: {
    label: 'Changed',
    className: 'bg-blue-100 text-blue-800 dark:bg-blue-950 dark:text-blue-300',
  },
  fixed: {
    label: 'Fixed',
    className: 'bg-amber-100 text-amber-800 dark:bg-amber-950 dark:text-amber-300',
  },
};

/**
 * What Renkei is and what has changed in it lately.
 *
 * Reached from the avatar menu. Signed-in only — not because the changelog is
 * sensitive, but because every route behind this shell requires a session and
 * an unauthenticated exception here would be a surprise rather than a
 * feature.
 */
export default async function AboutPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) {
    redirect(signInUrl(tenant.id, `/${slug}/about`));
  }

  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-center gap-3">
        <RenkeiMark className="h-10 w-10 shrink-0" title="Renkei" />
        <div className="min-w-0">
          <h1 className="text-xl font-bold">Renkei</h1>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            A permission-aware knowledge and action layer over the tools your organization already
            uses.
          </p>
        </div>
      </div>

      <h2 className="mb-1 text-lg font-semibold">What&rsquo;s changed</h2>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Newest first. Only changes you would notice are listed.
      </p>

      <div className="space-y-8">
        {CHANGELOG.map((release, index) => (
          <section key={`${release.date ?? 'unreleased'}-${release.heading ?? index}`}>
            <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b border-gray-200 pb-2 dark:border-gray-800">
              <h3 className="font-semibold">
                {/* An unreleased group is dated by its heading alone — putting
                    today's date on work that has not shipped would be a lie
                    the reader has no way to check. */}
                {release.date ? releaseDate(release.date) : (release.heading ?? 'Unreleased')}
              </h3>
              {release.date && release.heading ? (
                <span className="text-sm text-gray-500 dark:text-gray-400">{release.heading}</span>
              ) : null}
            </div>

            <ul className="space-y-3">
              {release.entries.map((entry) => {
                const style = KIND_STYLE[entry.kind];
                return (
                  <li key={entry.title} className="flex gap-3">
                    <span
                      className={`mt-0.5 h-fit shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${style.className}`}
                    >
                      {style.label}
                    </span>
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{entry.title}</p>
                      <p className="text-sm text-gray-600 dark:text-gray-400">{entry.detail}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>

      <p className="mt-10 border-t border-gray-200 pt-4 text-xs text-gray-500 dark:border-gray-800 dark:text-gray-400">
        Build {buildLabel(packageJson.version)}
      </p>
    </div>
  );
}
