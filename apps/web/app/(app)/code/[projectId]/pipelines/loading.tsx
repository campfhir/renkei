import { FramedSectionsSkeleton } from '../../../chat/_components/frame-skeleton';

/** A project's Pipelines while the page's own data loads: runs, setup, variables. */
export default function CodeProjectPipelinesLoading() {
  return <FramedSectionsSkeleton label="Loading pipelines…" sections={3} />;
}
