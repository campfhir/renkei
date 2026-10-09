import { FramedIndexSkeleton } from '../chat/_components/frame-skeleton';

/** The Code index while the person's projects load. */
export default function CodeLoading() {
  return <FramedIndexSkeleton label="Loading code projects…" />;
}
