import { LoadingRegion, SkeletonForm } from '@/components/skeleton';
import { FrameHeaderSkeleton } from '../../chat/_components/frame-skeleton';

/** The new-project form while the Bitbucket connection is checked. */
export default function NewCodeProjectLoading() {
  return (
    <LoadingRegion label="Loading…" className="flex h-full min-h-0 flex-col">
      <FrameHeaderSkeleton back actions={0} />
      <div aria-hidden="true" className="min-h-0 flex-1 overflow-hidden">
        <div className="mx-auto max-w-3xl p-4">
          <SkeletonForm fields={4} />
        </div>
      </div>
    </LoadingRegion>
  );
}
