import { FramedSectionsSkeleton } from '../../_components/frame-skeleton';

/** One library: a card per prompt. */
export default function PromptLibraryLoading() {
  return <FramedSectionsSkeleton label="Loading library…" sections={3} actions={2} />;
}
