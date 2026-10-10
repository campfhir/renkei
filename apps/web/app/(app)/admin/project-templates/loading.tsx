import { PageSkeleton, SkeletonRows } from '@/components/skeleton';

/** Project templates: a row per template. */
export default function ProjectTemplatesLoading() {
  return (
    <PageSkeleton label="Loading templates…">
      <SkeletonRows count={4} pill={false} />
    </PageSkeleton>
  );
}
