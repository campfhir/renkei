import { LoadingRegion, Skeleton, SkeletonHeading } from '@/components/skeleton';

/** The Organization page: its sections of link tiles. */
export default function AdminLoading() {
  return (
    <LoadingRegion label="Loading…" className="mx-auto max-w-4xl">
      <SkeletonHeading />
      {[5, 2, 1, 3, 3].map((tiles, section) => (
        <div key={section} aria-hidden="true" className="mb-8">
          <Skeleton className="mb-3 h-3 w-28" />
          <div className="grid gap-3 sm:grid-cols-2">
            {Array.from({ length: tiles }, (_, index) => (
              <div
                key={index}
                className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-800 dark:bg-gray-950"
              >
                <Skeleton className="h-4 w-32" />
                <Skeleton className="mt-2 h-3.5 w-full" />
              </div>
            ))}
          </div>
        </div>
      ))}
    </LoadingRegion>
  );
}
