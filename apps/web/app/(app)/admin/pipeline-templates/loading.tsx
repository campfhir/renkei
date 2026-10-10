import { PageSkeleton, SkeletonRows } from '@/components/skeleton';

/** Pipeline templates: a row per template. */
export default function PipelineTemplatesLoading() {
  return (
    <PageSkeleton label="Loading templates…">
      <SkeletonRows count={4} pill={false} />
    </PageSkeleton>
  );
}
