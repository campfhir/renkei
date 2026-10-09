import { PageSkeleton, SkeletonCards } from '@/components/skeleton';

/** Agent models. */
export default function AdminLlmModelsLoading() {
  return (
    <PageSkeleton label="Loading models…">
      <SkeletonCards count={2} lines={1} chips={2} />
    </PageSkeleton>
  );
}
