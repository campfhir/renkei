import { PageSkeleton, Skeleton, SkeletonRows } from '@/components/skeleton';

/** The audit log: a day heading, then its divided list; twice. */
export default function AuditLoading() {
  return (
    <PageSkeleton label="Loading audit…">
      <div aria-hidden="true" className="space-y-6">
        {[5, 3].map((rows, index) => (
          <div key={index}>
            <Skeleton className="mb-2 h-3.5 w-24" />
            <SkeletonRows count={rows} divided pill={false} />
          </div>
        ))}
      </div>
    </PageSkeleton>
  );
}
