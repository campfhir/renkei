/** One queued event (migration 013) or dead letter, as the event monitor lists it. */
export interface EventLogRecord {
  id: string;
  source: string;
  type: string;
  /** The queue status; dead letters report 'failed'. */
  status: string;
  attempts: number;
  /** The payload as stored — the caller reads only owner hints from it. */
  payload: unknown;
  createdAt: Date;
}

export interface EventLogStore {
  /** The newest `limit` live queue rows, newest first, ties by id descending. */
  listRecent(limit: number): Promise<EventLogRecord[]>;
  /** The newest `limit` dead letters, newest first, ties by id descending; status is 'failed'. */
  listRecentDeadLetters(limit: number): Promise<EventLogRecord[]>;
}
