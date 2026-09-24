import { PageSkeleton, SkeletonForm } from '@/components/skeleton';

/** One ADManager Plus instance's management page: its connection form. */
export default function AdManagerInstanceLoading() {
  return (
    <PageSkeleton label="Loading ADManager Plus instance…">
      <SkeletonForm fields={5} />
    </PageSkeleton>
  );
}
