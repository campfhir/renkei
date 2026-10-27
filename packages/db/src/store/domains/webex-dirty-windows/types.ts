/**
 * WebEx windows waiting to be rebuilt (`webex_dirty_windows`): one mark
 * per (room, day), refreshed on every message; the worker's window sweep
 * turns a mark that has gone quiet into one rebuild job and drops it.
 */
export interface WebexDirtyWindowRecord {
  roomId: string;
  /** `YYYY-MM-DD`. */
  day: string;
  /** The watcher whose token reads the room; null when the mark did not record one. */
  subject: string | null;
  markedAt: Date;
}

export interface WebexDirtyWindowStore {
  /** Marks made at or before `markedBefore`, oldest first (ties by room, then day), at most `limit`. */
  listQuiet(markedBefore: Date, limit: number): Promise<WebexDirtyWindowRecord[]>;
  /**
   * Drop a mark; with `markedAt`, only if it has not been re-marked since
   * (compared to the millisecond, the precision a record carries).
   * Returns how many went (0 or 1).
   */
  delete(roomId: string, day: string, options?: { markedAt?: Date }): Promise<number>;
  /** Mark a window now for `subject`, unless it is already marked (then nothing changes). */
  markIfAbsent(roomId: string, day: string, subject: string | null): Promise<void>;
}
