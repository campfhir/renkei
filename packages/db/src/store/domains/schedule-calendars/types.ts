/** A named set of blackout dates agent and batch-job schedules can opt into. */
export interface ScheduleCalendarRecord {
  id: string;
  name: string;
  /** The stored jsonb, as stored — the caller validates its entries. */
  dates: unknown;
  updatedAt: Date;
}

export interface ScheduleCalendarStore {
  /** Every calendar, by name (ties by id). */
  list(): Promise<ScheduleCalendarRecord[]>;
  /** Add one; a name in use changes nothing. */
  create(calendar: {
    id: string;
    name: string;
    dates: unknown[];
  }): Promise<'created' | 'duplicate'>;
  /** Rename and re-date one. */
  update(
    id: string,
    calendar: { name: string; dates: unknown[] }
  ): Promise<'updated' | 'not-found' | 'duplicate'>;
  /** False when there was no such calendar. */
  delete(id: string): Promise<boolean>;
  /** One calendar by id, or null. */
  find(id: string): Promise<ScheduleCalendarRecord | null>;
}
