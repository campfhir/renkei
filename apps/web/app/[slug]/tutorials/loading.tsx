import { PageSkeleton, SkeletonCards } from '@/components/skeleton';

/** Tutorials: the switch card, then one card per tour. */
export default function TutorialsLoading() {
  return (
    <PageSkeleton label="Loading tutorials…">
      <SkeletonCards count={4} />
    </PageSkeleton>
  );
}
