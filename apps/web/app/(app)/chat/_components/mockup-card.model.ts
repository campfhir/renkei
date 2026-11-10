/**
 * The inline mockup card's state (mockup-card.tsx): how wide the card is,
 * the height its document reported, and whether the fullscreen viewer is
 * open.
 *
 * The component measures the card and listens to the frame; what it
 * decides from that — how far the design is scaled down to fit, how tall
 * the preview may be before it is cropped to its top, where a narrow
 * design sits — is here, and tested in mockup-card.model.test.ts.
 */

import { clampFrameHeight } from '@/lib/mockups/message';
import type { MockupRequest } from '@/lib/mockups/request';

/** How tall the preview may be before it is cropped to its top; the viewer shows the rest. */
export const INLINE_MAX_HEIGHT = 440;
/** The frame's height until the document reports its own. */
export const INITIAL_CARD_FRAME_HEIGHT = 400;

export interface CardState {
  designWidth: number;
  fixedHeight: number | null;
  /** The card's inner width in CSS pixels; 0 until measured. */
  boxWidth: number;
  reportedHeight: number | null;
  open: boolean;
}

export type CardAction =
  | { type: 'measured'; width: number }
  | { type: 'frame-size'; height: number }
  | { type: 'open' }
  | { type: 'close' };

export function initCard(request: Pick<MockupRequest, 'width' | 'height'>): CardState {
  return {
    designWidth: request.width,
    fixedHeight: request.height,
    boxWidth: 0,
    reportedHeight: null,
    open: false,
  };
}

export function cardReducer(state: CardState, action: CardAction): CardState {
  switch (action.type) {
    case 'measured':
      return state.boxWidth === action.width ? state : { ...state, boxWidth: action.width };
    case 'frame-size':
      if (state.fixedHeight !== null) return state;
      return { ...state, reportedHeight: clampFrameHeight(action.height) };
    case 'open':
      return { ...state, open: true };
    case 'close':
      return { ...state, open: false };
  }
}

export interface CardLayout {
  /** The scale the design is drawn at: down to the card's width, never up. */
  scale: number;
  /** The frame's own (unscaled) height. */
  frameHeight: number;
  /** How tall the preview is on screen. */
  shownHeight: number;
  /** Whether the design runs past the preview, which then shows its top with a fade. */
  cropped: boolean;
  /** The frame's left edge: a design narrower than the card sits in its middle. */
  left: number;
}

export function cardLayout(state: CardState): CardLayout {
  const frameHeight = state.fixedHeight ?? state.reportedHeight ?? INITIAL_CARD_FRAME_HEIGHT;
  const scale = state.boxWidth > 0 ? Math.min(1, state.boxWidth / state.designWidth) : 1;
  const fullHeight = frameHeight * scale;
  return {
    scale,
    frameHeight,
    shownHeight: Math.min(fullHeight, INLINE_MAX_HEIGHT),
    // A pixel of slack, so rounding never crops a design that fits.
    cropped: fullHeight > INLINE_MAX_HEIGHT + 1,
    left: Math.max(0, (state.boxWidth - state.designWidth * scale) / 2),
  };
}
