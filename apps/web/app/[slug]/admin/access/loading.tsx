import { PageSkeleton, SkeletonTable } from '@/components/skeleton';

/** Access: one table of people and their connectors. */
export default function AdminAccessLoading() {
  return (
    <PageSkeleton label="Loading access…">
      <SkeletonTable rows={6} columns={5} />
    </PageSkeleton>
  );
}
