import { PageSkeleton, Skeleton, SkeletonRows } from '@/components/skeleton';

/** Notifications: a day heading, then its rows; twice. */
export default function NotificationsLoading() {
  return (
    <PageSkeleton label="Loading notifications…">
      <div aria-hidden="true" className="space-y-6">
        {Array.from({ length: 2 }, (_, index) => (
          <div key={index}>
            <Skeleton className="mb-2 h-3 w-20" />
            <SkeletonRows count={index === 0 ? 4 : 2} />
          </div>
        ))}
      </div>
    </PageSkeleton>
  );
}
