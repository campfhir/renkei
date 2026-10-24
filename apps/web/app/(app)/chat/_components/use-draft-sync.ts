'use client';

/**
 * Keeps the composer's unsent text on the server (lib/chat/drafts.ts) so a
 * reload or another device finds it. Typing is debounced — a save goes out
 * once the box has been still for `SAVE_DELAY_MS`, not per keystroke —
 * while clearing the box (a send, a cancel) saves at once so a sent
 * message never comes back as a draft. One save is in flight at a time and
 * the newest text always goes last, so a slow earlier request cannot
 * overwrite a later one. Leaving the page flushes what is pending.
 */

import { useCallback, useEffect, useRef } from 'react';
import { chatClient } from '@/lib/chat/client';

export const SAVE_DELAY_MS = 800;

export function useDraftSync(chatId: string, text: string, enabled: boolean, initial: string) {
  const latest = useRef(text);
  const saved = useRef(initial);
  const inflight = useRef(false);
  const again = useRef(false);
  latest.current = text;

  const push = useCallback(
    async (keepalive = false) => {
      if (inflight.current) {
        again.current = true;
        return;
      }
      inflight.current = true;
      try {
        do {
          again.current = false;
          const value = latest.current;
          if (value === saved.current) break;
          const result = await chatClient.saveDraft(chatId, value, keepalive);
          // On failure `saved` stays behind, so the next change tries again.
          if (result.error) break;
          saved.current = value;
        } while (again.current);
      } finally {
        inflight.current = false;
      }
    },
    [chatId]
  );

  useEffect(() => {
    if (!enabled || text === saved.current) return;
    if (text.length === 0) {
      void push();
      return;
    }
    const timer = window.setTimeout(() => void push(), SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [text, enabled, push]);

  // Leaving — a tab closed, a phone app backgrounded, the chat navigated
  // away from — must not lose what the debounce is still holding.
  useEffect(() => {
    if (!enabled) return;
    const flush = () => void push(true);
    const onHide = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onHide);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onHide);
      flush();
    };
  }, [enabled, push]);
}
