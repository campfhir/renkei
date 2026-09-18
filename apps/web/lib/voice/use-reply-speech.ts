'use client';

/**
 * Reads the reply in flight aloud as it streams. Watches the thread's
 * messages for the running turn's assistant text, cuts what has closed
 * into sentences (sentences.ts) and hands each to the queue the moment it
 * is complete; when the turn ends, whatever is left is spoken too.
 *
 * Text is tracked by position in the turn's concatenated prose, so a
 * snapshot that re-sends the same rows never re-speaks them, and a tool
 * call in the middle of a reply (a new assistant row) simply continues
 * the count.
 */

import { useEffect, useRef } from 'react';
import type { ChatMessageView } from '@/lib/chat/views';
import { takeSpeakable } from './sentences';
import type { SpeechQueue } from './speech-queue';

/** The owner tag the queue carries while it reads a live reply. */
export const LIVE_REPLY_OWNER = 'live';

/** Every text block of the turn's assistant rows, in order, as one string. */
export function replyProse(messages: ChatMessageView[], turnId: string): string {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.turnId !== turnId || message.role !== 'assistant') continue;
    for (const block of message.blocks) {
      if (block.type === 'text') parts.push(block.text);
    }
  }
  // A block boundary is a paragraph boundary for the voice.
  return parts.join('\n\n');
}

export function useReplySpeech({
  queue,
  enabled,
  messages,
  activeTurnId,
}: {
  queue: SpeechQueue | null;
  /** Read replies aloud: the preference, or voice mode being open. */
  enabled: boolean;
  messages: ChatMessageView[];
  /** The turn in flight, null once it ends. */
  activeTurnId: string | null;
}): void {
  const followed = useRef<{ turnId: string; spoken: number } | null>(null);

  useEffect(() => {
    if (!queue) return;
    if (!enabled) {
      if (followed.current) {
        followed.current = null;
        if (queue.owner === LIVE_REPLY_OWNER) queue.stop();
      }
      return;
    }
    // A turn began: start a fresh stream. A turn ended: flush it.
    if (activeTurnId && followed.current?.turnId !== activeTurnId) {
      followed.current = { turnId: activeTurnId, spoken: 0 };
      queue.begin(LIVE_REPLY_OWNER);
    }
    const current = followed.current;
    if (!current) return;
    if (queue.owner !== LIVE_REPLY_OWNER) {
      // Something else (a Listen button, a stop) took the queue; this
      // reply is no longer being read.
      followed.current = null;
      return;
    }
    const prose = replyProse(messages, current.turnId);
    if (prose.length < current.spoken) current.spoken = prose.length;
    const ended = activeTurnId !== current.turnId;
    const { chunks, rest } = takeSpeakable(prose.slice(current.spoken), { final: ended });
    for (const chunk of chunks) queue.enqueue(chunk);
    current.spoken = prose.length - rest.length;
    if (ended) {
      queue.finish();
      followed.current = null;
    }
  }, [queue, enabled, messages, activeTurnId]);
}
