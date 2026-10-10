import { PageSkeleton, SkeletonTable } from '@/components/skeleton';

/** The events log. */
export default function AdminEventsLoading() {
  return (
    <PageSkeleton label="Loading events…" width="4xl">
      <SkeletonTable rows={8} columns={4} />
    </PageSkeleton>
  );
}
