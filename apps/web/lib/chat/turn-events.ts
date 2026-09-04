/**
 * The in-process channel between a running turn and the SSE route(s)
 * watching it: the fast path, for the common one-replica deployment.
 *
 * Every event gets a sequence number and is kept in a bounded ring, so a
 * browser that reconnects with `Last-Event-ID` inside the ring replays
 * exactly what it missed; one that reconnects after the ring moved on
 * (or on another replica, where no channel exists) is told so and falls
 * back to the database snapshot path in the stream route. Registry lives
 * on globalThis for the same reason the database client does — Next's
 * separate module graphs — and entries linger briefly after close so a
 * late subscriber still sees the ending.
 */

import type { ChatStreamEvent } from './stream-events';

export interface SequencedEvent {
  seq: number;
  event: ChatStreamEvent;
}

export interface TurnChannel {
  readonly turnId: string;
  readonly closed: boolean;
  readonly cancelRequested: boolean;
  /** The newest sequence number handed out. */
  readonly lastSeq: number;
  emit(event: ChatStreamEvent): void;
  /**
   * Replay everything after `fromSeq` and follow live. Returns an
   * unsubscribe, or null when `fromSeq` fell out of the ring — the caller
   * must take the snapshot path instead.
   */
  subscribe(fromSeq: number, listener: (event: SequencedEvent) => void): (() => void) | null;
  requestCancel(): void;
  onCancel(listener: () => void): void;
  close(): void;
}

const RING_CAPACITY = 2_000;
const LINGER_MS = 30_000;

interface Registry {
  channels: Map<string, TurnChannel>;
}

declare global {
  var __renkeiChatChannels: Registry | undefined;
}

function registry(): Registry {
  return (globalThis.__renkeiChatChannels ??= { channels: new Map() });
}

export function openTurnChannel(turnId: string): TurnChannel {
  const ring: SequencedEvent[] = [];
  const listeners = new Set<(event: SequencedEvent) => void>();
  const cancelListeners = new Set<() => void>();
  let seq = 0;
  let closed = false;
  let cancelRequested = false;

  const channel: TurnChannel = {
    turnId,
    get closed() {
      return closed;
    },
    get cancelRequested() {
      return cancelRequested;
    },
    get lastSeq() {
      return seq;
    },
    emit(event) {
      if (closed) return;
      seq += 1;
      const entry = { seq, event };
      ring.push(entry);
      if (ring.length > RING_CAPACITY) ring.shift();
      for (const listener of listeners) {
        try {
          listener(entry);
        } catch {
          // A broken subscriber must not take the turn down with it.
        }
      }
    },
    subscribe(fromSeq, listener) {
      const oldest = ring.length > 0 ? ring[0].seq : seq + 1;
      // Replay is possible when every event after fromSeq is still held:
      // either nothing was evicted (oldest is 1) or fromSeq is at least
      // the last evicted one.
      if (fromSeq + 1 < oldest) return null;
      for (const entry of ring) {
        if (entry.seq > fromSeq) listener(entry);
      }
      if (closed) return () => {};
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    requestCancel() {
      if (cancelRequested) return;
      cancelRequested = true;
      for (const listener of cancelListeners) {
        try {
          listener();
        } catch {
          // Same reasoning as emit.
        }
      }
    },
    onCancel(listener) {
      if (cancelRequested) {
        listener();
        return;
      }
      cancelListeners.add(listener);
    },
    close() {
      if (closed) return;
      closed = true;
      listeners.clear();
      cancelListeners.clear();
      const timer = setTimeout(() => {
        const current = registry().channels.get(turnId);
        if (current === channel) registry().channels.delete(turnId);
      }, LINGER_MS);
      // Never keep a process alive for a bookkeeping timer.
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
    },
  };
  registry().channels.set(turnId, channel);
  return channel;
}

export function getTurnChannel(turnId: string): TurnChannel | undefined {
  return registry().channels.get(turnId);
}

/** Test hook. */
export function resetTurnChannels(): void {
  registry().channels.clear();
}
