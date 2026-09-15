import { LoadingRegion, Skeleton, SkeletonTable } from '@/components/skeleton';

/** Activity: the header, the filter row, the search, then the log panel. */
export default function LogsLoading() {
  return (
    <LoadingRegion label="Loading activity…" wide className="flex flex-col gap-4">
      <div
        aria-hidden="true"
        className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-2"
      >
        <Skeleton className="h-7 w-32" />
        <Skeleton className="h-4 w-24" />
        <Skeleton className="h-3.5 w-full max-w-xl" />
      </div>
      <div aria-hidden="true" className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Skeleton className="h-9 w-64 rounded-lg" />
        <Skeleton className="h-9 w-56 rounded-lg" />
      </div>
      <Skeleton className="h-10 w-full rounded-lg" />
      <div
        aria-hidden="true"
        className="rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900/40"
      >
        <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 dark:border-slate-800">
          <Skeleton className="h-3 w-20" />
        </div>
        <div className="p-4">
          <SkeletonTable rows={10} columns={5} />
        </div>
      </div>
    </LoadingRegion>
  );
}
