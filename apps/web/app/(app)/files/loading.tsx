import { PageSkeleton, SkeletonHeading, SkeletonTable } from '@/components/skeleton';

/** The file browser: its toolbar, then the listing. */
export default function FilesLoading() {
  return (
    <PageSkeleton label="Loading files…">
      <SkeletonHeading subtitle={false} actions={2} className="mb-4" />
      <SkeletonTable rows={6} columns={3} />
    </PageSkeleton>
  );
}
