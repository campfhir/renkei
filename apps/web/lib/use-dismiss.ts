'use client';

/**
 * Dismiss-on-outside-click + Escape for small popovers (the flow canvas's
 * "+" menu and friends). Listeners attach only while the popover is open;
 * clicks INSIDE the ref (including the toggle button, when it lives there)
 * are the popover's own business.
 */

import { useEffect, type RefObject } from 'react';

export function useDismiss(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void
): void {
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onDismiss();
    };
    const onMouseDown = (event: MouseEvent) => {
      if (ref.current && event.target instanceof Node && !ref.current.contains(event.target)) {
        onDismiss();
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onMouseDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onMouseDown);
    };
  }, [open, ref, onDismiss]);
}
