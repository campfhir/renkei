/**
 * A person's chat memory (chat_user_memories, migration 095): entries and
 * one summary, sealed under the person's own key — the store keeps the
 * sealed text; the delegate opens it (apps/web/lib/chat/user-memory.ts).
 */

export interface UserMemoryRecord {
  id: string;
  ownerSubject: string;
  kind: string;
  /** Sealed, as stored. */
  content: string;
  chatId: string | null;
  createdAt: Date;
}

export interface UserMemoryStore {
  /** The person's rows (entries and summary), newest first (ties by id), at most `limit`. */
  list(ownerSubject: string, limit: number): Promise<UserMemoryRecord[]>;
  /**
   * Append one sealed entry, then drop the person's entries beyond the
   * newest `keep` (ties by id); the new entry's id.
   */
  append(entry: {
    ownerSubject: string;
    content: string;
    chatId: string | null;
    keep: number;
  }): Promise<string>;
  /** Replace one of the person's entries' sealed text (never the summary); whether it changed. */
  edit(ownerSubject: string, id: string, content: string): Promise<boolean>;
  /** Delete all the person's memory, or these rows of it; how many went. */
  forget(
    ownerSubject: string,
    target: { kind: 'all' } | { kind: 'entries'; ids: string[] }
  ): Promise<number>;
}
