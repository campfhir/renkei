import { FramedSectionsSkeleton } from '../../chat/_components/frame-skeleton';

/**
 * A code project while its checkout, environment and chats load — the
 * heaviest page in the frame, and the one most often reached by a click
 * from the Code index: the file tree on the left, the sections beside it.
 */
export default function CodeProjectLoading() {
  return <FramedSectionsSkeleton label="Loading project…" sections={5} aside />;
}
