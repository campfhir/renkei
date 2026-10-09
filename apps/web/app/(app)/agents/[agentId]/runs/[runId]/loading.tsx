import { PageSkeleton, SkeletonCards } from '@/components/skeleton';

/** One run: its steps, each a card of output. */
export default function AgentsAgentidRunsRunidLoading() {
  return (
    <PageSkeleton label="Loading run…" back>
      <SkeletonCards count={3} lines={3} chips={0} />
    </PageSkeleton>
  );
}
