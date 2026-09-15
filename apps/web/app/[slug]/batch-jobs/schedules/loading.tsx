import { PageSkeleton, SkeletonRows } from '@/components/skeleton';

/** Schedules: a row per schedule. */
export default function SchedulesLoading() {
  return (
    <PageSkeleton label="Loading schedules…" back actions={1}>
      <SkeletonRows count={4} />
    </PageSkeleton>
  );
}
