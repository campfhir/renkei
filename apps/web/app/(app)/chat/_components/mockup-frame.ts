'use client';

/**
 * What a mockup's document says to the page that frames it, and the one
 * hook that listens (lib/mockups/document.ts's HOST_SCRIPT is the other
 * end). The card and the fullscreen viewer each frame the same document,
 * and both need the same three things: how tall it is, and — while the
 * mockup has the keyboard or the trackpad — the zoom and Escape the
 * frame would otherwise swallow.
 *
 * Every message is checked against `event.source`, so only the frame this
 * component holds can speak to it; the frame has an opaque origin, so its
 * origin is no help.
 */

import { useEffect, type RefObject } from 'react';
import { MOCKUP_MESSAGE_SOURCE } from '@/lib/mockups/message';

export type FrameMessage =
  | { type: 'size'; height: number }
  | { type: 'zoom'; deltaY: number }
  | { type: 'zoom-step'; direction: -1 | 0 | 1 }
  | { type: 'escape' };

/** How short and how tall a frame may be made to fit its document. */
export const FRAME_HEIGHT_MIN = 80;
export const FRAME_HEIGHT_MAX = 6000;

export function clampFrameHeight(height: number): number {
  return Math.max(FRAME_HEIGHT_MIN, Math.min(FRAME_HEIGHT_MAX, Math.ceil(height)));
}

export function parseFrameMessage(data: unknown): FrameMessage | null {
  if (typeof data !== 'object' || data === null) return null;
  const { source, type, height, deltaY, direction }: Record<string, unknown> = Object.fromEntries(
    Object.entries(data)
  );
  if (source !== MOCKUP_MESSAGE_SOURCE) return null;
  if (type === 'size' && typeof height === 'number' && Number.isFinite(height)) {
    return { type: 'size', height };
  }
  if (type === 'zoom' && typeof deltaY === 'number' && Number.isFinite(deltaY)) {
    return { type: 'zoom', deltaY };
  }
  if (type === 'zoom-step' && (direction === -1 || direction === 0 || direction === 1)) {
    return { type: 'zoom-step', direction };
  }
  if (type === 'escape') return { type: 'escape' };
  return null;
}

export function useFrameMessages(
  frame: RefObject<HTMLIFrameElement | null>,
  onMessage: (message: FrameMessage) => void
): void {
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (!frame.current || event.source !== frame.current.contentWindow) return;
      const message = parseFrameMessage(event.data);
      if (message) onMessage(message);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [frame, onMessage]);
}
