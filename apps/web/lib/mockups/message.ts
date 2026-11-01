/**
 * The tag every message a mockup's document posts to its frame carries —
 * shared by the document's own script (document.ts, server) and the page
 * that listens (mockup-frame.ts, browser), so it lives where both may
 * import it.
 */
export const MOCKUP_MESSAGE_SOURCE = 'renkei-mockup';

/**
 * How short and how tall a frame may be made to fit the height its
 * document reports — the card and the fullscreen viewer both hold to it
 * (mockup-card.model.ts, mockup-viewer.model.ts).
 */
export const FRAME_HEIGHT_MIN = 80;
export const FRAME_HEIGHT_MAX = 6000;

export function clampFrameHeight(height: number): number {
  return Math.max(FRAME_HEIGHT_MIN, Math.min(FRAME_HEIGHT_MAX, Math.ceil(height)));
}
