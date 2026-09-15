import { PageSkeleton, Skeleton, SkeletonText } from '@/components/skeleton';

/** Knowledge search: the search box and its help. */
export default function KnowledgeLoading() {
  return (
    <PageSkeleton label="Loading knowledge search…">
      <Skeleton className="h-10 w-full rounded-md" />
      <SkeletonText lines={3} className="mt-4" />
    </PageSkeleton>
  );
}
