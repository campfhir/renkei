/**
 * WebEx room-day windows waiting for a rebuild (`webex_dirty_windows`): a
 * captured message marks its (room, UTC day) dirty, and the windows sweep
 * coalesces the marks into one rebuild per window once they go quiet.
 */
export interface WebexDirtyWindowRecord {
  roomId: string;
  /** The UTC calendar day, `YYYY-MM-DD`. */
  day: string;
  /** A watcher whose token can refetch the day; null when none was known. */
  subject: string | null;
  markedAt: Date;
}

export interface WebexDirtyWindowStore {
  /**
   * Mark a window dirty, now. Idempotent per (room, day): a second mark
   * refreshes `markedAt` (the sweep's quiet-period debounce keys on it) and
   * keeps the stored watcher when this mark names none.
   */
  markDirty(roomId: string, day: string, subject: string | null): Promise<void>;
  /** One window's mark, or null when it is not dirty. */
  find(roomId: string, day: string): Promise<WebexDirtyWindowRecord | null>;
}
