import type { CoachMarkProgressView, CoachMarkTour } from './types';

/**
 * The rules for which tour shows, and what a tour's state is called — pure,
 * so the provider and the Tutorials page agree and a test can pin them.
 */

/** '/e2e/agents' → '/agents'; '/e2e' → '/'. A pathname outside the slug is returned as is. */
export function slugRelativePath(pathname: string, slug: string): string {
  const prefix = `/${slug}`;
  if (pathname === prefix) return '/';
  if (pathname.startsWith(`${prefix}/`)) return pathname.slice(prefix.length);
  return pathname;
}

/** Every tour this person may see, in registry order. */
export function toursFor(tours: readonly CoachMarkTour[], isOperator: boolean): CoachMarkTour[] {
  return tours.filter((tour) => tour.audience === 'everyone' || isOperator);
}

/**
 * Whether this person's row settles the tour at its CURRENT version: a
 * completion or a dismissal of this edition. A row from an older edition,
 * or one still mid-way ('viewed'), leaves the tour eligible to auto-start
 * again — mid-way because a tour abandoned by closing the tab was never
 * skipped, and should offer itself once more.
 */
export function isSettled(
  progress: CoachMarkProgressView | undefined,
  tour: Pick<CoachMarkTour, 'version'>
): boolean {
  if (!progress) return false;
  if (progress.version < tour.version) return false;
  return progress.status === 'completed' || progress.status === 'dismissed';
}

/**
 * The tour to start unasked on this page, or null: the first, in registry
 * order, that auto-starts, matches the path, is for this person, and is
 * not settled — and only when they have auto-start on at all.
 */
export function pickAutoStartTour(input: {
  tours: readonly CoachMarkTour[];
  path: string;
  isOperator: boolean;
  autoStart: boolean;
  progress: ReadonlyMap<string, CoachMarkProgressView>;
}): CoachMarkTour | null {
  if (!input.autoStart) return null;
  for (const tour of toursFor(input.tours, input.isOperator)) {
    if (!tour.autoStart || !tour.matches(input.path)) continue;
    if (isSettled(input.progress.get(tour.id), tour)) continue;
    return tour;
  }
  return null;
}

export type CoachMarkStateLabel =
  'Not started' | 'In progress' | 'Completed' | 'Skipped' | 'Updated';

/**
 * What the Tutorials page calls a tour's state. 'Updated' is a settled row
 * from an older edition: they did see it, and the tour has changed since.
 */
export function stateLabel(
  progress: CoachMarkProgressView | undefined,
  tour: Pick<CoachMarkTour, 'version'>
): CoachMarkStateLabel {
  if (!progress) return 'Not started';
  if (progress.version < tour.version && progress.status !== 'viewed') return 'Updated';
  switch (progress.status) {
    case 'completed':
      return 'Completed';
    case 'dismissed':
      return 'Skipped';
    default:
      return 'In progress';
  }
}
