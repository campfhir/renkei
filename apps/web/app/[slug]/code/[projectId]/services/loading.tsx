import { FramedSectionsSkeleton } from '../../../chat/_components/frame-skeleton';

/** A project's Services while the page's own data loads: what runs, what may. */
export default function CodeProjectServicesLoading() {
  return <FramedSectionsSkeleton label="Loading services…" sections={2} />;
}
