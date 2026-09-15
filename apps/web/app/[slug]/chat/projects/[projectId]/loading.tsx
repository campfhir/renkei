import { FramedSectionsSkeleton } from '../../_components/frame-skeleton';

/** One project: its sections, from About down to the chats inside it. */
export default function ProjectLoading() {
  return <FramedSectionsSkeleton label="Loading project…" sections={4} actions={3} />;
}
