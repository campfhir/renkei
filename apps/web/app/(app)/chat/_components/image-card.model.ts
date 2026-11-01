/**
 * What the chat's picture card (image-card.tsx) shows, with no React or
 * DOM: its caption for each state of the call (waiting for permission,
 * being drawn, done, failed) worded for a picture or an animation,
 * whether the outline, the picture or the error is up, and what the
 * card's own state — the picture loaded, broken, or open in the preview —
 * does to that. The outline's shape is lib/chat/image-size.ts's
 * `skeletonRatio`. Tested in image-card.model.test.ts.
 */

export type ImageCardState = 'waiting' | 'pending' | 'done' | 'failed';

export interface ImageCardLocal {
  /** The picture has been drawn by the browser. */
  loaded: boolean;
  /** The browser could not draw it. */
  broken: boolean;
  /** The preview window is open. */
  open: boolean;
}

export const initImageCard = (): ImageCardLocal => ({ loaded: false, broken: false, open: false });

export type ImageCardAction =
  { type: 'loaded' } | { type: 'broken' } | { type: 'opened' } | { type: 'closed' };

export function imageCardReducer(state: ImageCardLocal, action: ImageCardAction): ImageCardLocal {
  switch (action.type) {
    case 'loaded':
      return state.loaded ? state : { ...state, loaded: true };
    case 'broken':
      return state.broken ? state : { ...state, broken: true };
    case 'opened':
      return { ...state, open: true };
    case 'closed':
      return { ...state, open: false };
  }
}

/** A call's time as the card shows it: "12s", or "1m 5s" past a minute. */
export function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export interface ImageCardView {
  noun: 'image' | 'animation';
  label: string;
  /** The body under the caption: nothing (waiting), the reason (failed), or the frame. */
  body: 'none' | 'error' | 'frame';
  errorText: string;
  /** The picture is in the frame (it may still be loading). */
  showImage: boolean;
  /** The picture is in and drawn: the frame fits it, and the file's line shows under it. */
  showPicture: boolean;
  /** Done, but the browser could not draw it. */
  brokenNotice: boolean;
  /** Done, but no stored file was found for this call. */
  missingNotice: boolean;
}

export function imageCardView(input: {
  state: ImageCardState;
  animated: boolean;
  /** A stored file this call kept. */
  hasImage: boolean;
  /** What the tool answered; on a failure, the reason. */
  resultContent: string | null;
  local: ImageCardLocal;
}): ImageCardView {
  const { state, animated, hasImage, local } = input;
  const noun = animated ? 'animation' : 'image';
  const label =
    state === 'waiting'
      ? `Waiting for permission to generate an ${noun}`
      : state === 'pending'
        ? `Generating ${noun}`
        : state === 'failed'
          ? `${animated ? 'Animation' : 'Image'} could not be generated`
          : `Generated ${noun}`;
  const showImage = state === 'done' && hasImage && !local.broken;
  return {
    noun,
    label,
    body: state === 'waiting' ? 'none' : state === 'failed' ? 'error' : 'frame',
    errorText: input.resultContent || 'The image tool failed.',
    showImage,
    showPicture: showImage && local.loaded,
    brokenNotice: state === 'done' && local.broken,
    missingNotice: state === 'done' && !hasImage,
  };
}
