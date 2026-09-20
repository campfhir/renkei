import React from 'react';
import { notFound, redirect } from 'next/navigation';
import { getDatabase } from '@renkei/db';
import { getCoachMarkPrefs } from '@renkei/user-prefs';
import { getOrgSettings } from '@renkei/settings';
import { tenantForSlug } from '@/lib/tenant-slug';
import { getSessionFromCookies } from '@/lib/session';
import { signInUrl } from '@/lib/sign-in-url';
import { ROLE_OPERATOR } from '@/lib/access';
import { COACH_MARK_TOURS } from '@/lib/coach-marks/tours';
import { toursFor } from '@/lib/coach-marks/select';
import { listCoachMarkProgress } from '@/lib/coach-marks/store';
import TutorialsList from './tutorials-list';

/**
 * The Tutorials page, behind the avatar: every tour this person may take,
 * where each stands, and the way back into any of them — the "redo the
 * tutorial" door — plus the switch that stops tours starting unasked.
 *
 * Rows and the preference are read fresh here: this is the page they are
 * changed from, and a minute-old cache would show a tour as unfinished
 * the moment after it was finished.
 */
export default async function TutorialsPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<React.ReactNode> {
  const { slug } = await params;
  const tenant = await tenantForSlug(slug);
  if (!tenant) notFound();

  const session = await getSessionFromCookies(tenant.id);
  if (!session) redirect(signInUrl(tenant.id, `/${slug}/tutorials`));
  const isOperator = session.roles.includes(ROLE_OPERATOR);

  const dbResult = getDatabase();
  const [prefs, progress, orgSettings] = await Promise.all([
    getCoachMarkPrefs(tenant.id, session.subject, { fresh: true }),
    dbResult.ok ? listCoachMarkProgress(dbResult.val, tenant.id, session.subject) : [],
    getOrgSettings(tenant.id),
  ]);
  // The org's switch is off: say so, and offer nothing — a Start button
  // that did nothing would be worse than no button.
  if (orgSettings.ok && !orgSettings.val.coachMarksEnabled) {
    return (
      <div className="mx-auto max-w-3xl">
        <h1 className="mb-1 text-xl font-bold">Tutorials</h1>
        <p
          data-testid="tutorials-off"
          className="rounded-lg border border-dashed border-gray-300 p-6 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-400"
        >
          Guided tours are switched off for this organization. An operator can turn them back on
          under Organization → Settings.
        </p>
      </div>
    );
  }

  // Functions do not cross to the client; the list gets the data of each tour.
  const tours = toursFor(COACH_MARK_TOURS, isOperator).map((tour) => ({
    id: tour.id,
    area: tour.area,
    version: tour.version,
    title: tour.title,
    description: tour.description,
    steps: tour.steps.length,
    audience: tour.audience,
  }));

  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="mb-1 text-xl font-bold">Tutorials</h1>
      <p className="mb-6 text-sm text-gray-600 dark:text-gray-400">
        Short guided tours that point out what a page is for. Replay any of them here, or start one
        you have not taken yet.
      </p>
      <TutorialsList tours={tours} progress={progress} autoStart={prefs.autoStart} />
    </div>
  );
}
