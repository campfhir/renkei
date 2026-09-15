import { PageSkeleton, SkeletonRows } from '@/components/skeleton';

/** Holiday calendars: a row per calendar. */
export default function CalendarsLoading() {
  return (
    <PageSkeleton label="Loading calendars…">
      <SkeletonRows count={3} pill={false} />
    </PageSkeleton>
  );
}
