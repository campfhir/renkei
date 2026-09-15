import { FramedIndexSkeleton } from '../_components/frame-skeleton';

/** Memory: the summary, then what has been remembered. */
export default function MemoryLoading() {
  return <FramedIndexSkeleton label="Loading memory…" groups={[6]} />;
}
