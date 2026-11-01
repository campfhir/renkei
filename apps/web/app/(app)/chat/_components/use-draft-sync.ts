'use client';

/**
 * Keeps the composer's unsent text on the server (lib/chat/drafts.ts) so a
 * reload or another device finds it. Typing is debounced — a save goes out
 * once the box has been still for `SAVE_DELAY_MS`, not per keystroke —
 * while clearing the box (a send, a cancel) saves at once so a sent
 * message never comes back as a draft. One save is in flight at a time and
 * the newest text always goes last, so a slow earlier request cannot
 * overwrite a later one. Leaving the page flushes what is pending. Those
 * rules are draft-sync.model.ts, tested beside it; this hook holds the
 * timer and makes the requests.
 */

import { useCallback, useEffect, useRef } from 'react';
import { chatClient } from '@/lib/chat/client';
import {
  SAVE_DELAY_MS,
  initialDraftSync,
  saveAnswered,
  saveRequested,
  saveTiming,
  type DraftStep,
} from './draft-sync.model';

export function useDraftSync(chatId: string, text: string, enabled: boolean, initial: string) {
  const latest = useRef(text);
  const sync = useRef(initialDraftSync(initial));
  latest.current = text;

  const push = useCallback(
    async (keepalive = false) => {
      let step: DraftStep = saveRequested(sync.current, latest.current);
      sync.current = step.state;
      while (step.save !== null) {
        let ok = false;
        try {
          ok = !(await chatClient.saveDraft(chatId, step.save, keepalive)).error;
        } catch {
          // Saved stays behind: the next change tries again.
        }
        step = saveAnswered(sync.current, ok, latest.current);
        sync.current = step.state;
      }
    },
    [chatId]
  );

  useEffect(() => {
    const timing = saveTiming(text, sync.current.saved, enabled);
    if (timing === 'none') return;
    if (timing === 'now') {
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
