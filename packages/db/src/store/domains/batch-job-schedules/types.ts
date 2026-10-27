/**
 * A batch-job schedule: the recurring recipe each firing turns into an
 * ordinary batch job. `config` and `scheduleConfig` come back as stored;
 * the callers parse them, and compute `nextRunAt` themselves.
 */
export interface BatchJobScheduleRecord {
  id: string;
  subject: string;
  name: string;
  kind: string;
  config: unknown;
  scheduleConfig: unknown;
  enabled: boolean;
  nextRunAt: Date | null;
  lastFiredAt: Date | null;
  lastError: string | null;
  createdAt: Date;
}

export interface NewBatchJobSchedule {
  /** Generated when left out. */
  id?: string;
  subject: string;
  name: string;
  kind: string;
  config: unknown;
  scheduleConfig: unknown;
  nextRunAt: Date | null;
}

/** The fields an edit may change; one left out keeps its value. */
export interface BatchJobSchedulePatch {
  name?: string;
  config?: unknown;
  scheduleConfig?: unknown;
  nextRunAt?: Date | null;
  enabled?: boolean;
}

/**
 * batch_job_schedules, plus the one read of schedule_calendars a
 * schedule's next run needs. Names are unique across the organization: a
 * clashing create or rename rejects with code 23505 and constraint
 * `batch_job_schedules_name`. (The worker's due-row sweep keeps its own
 * queries.)
 */
export interface BatchJobScheduleStore {
  create(schedule: NewBatchJobSchedule): Promise<BatchJobScheduleRecord>;
  get(scheduleId: string): Promise<BatchJobScheduleRecord | undefined>;
  /** One person's schedules by name (ties by id). */
  list(subject: string): Promise<BatchJobScheduleRecord[]>;
  /** The schedule as it now stands, or undefined when there is none with that id. */
  update(
    scheduleId: string,
    patch: BatchJobSchedulePatch
  ): Promise<BatchJobScheduleRecord | undefined>;
  /** Whether a row went; batches it spawned stay, their schedule link cleared. */
  delete(scheduleId: string): Promise<boolean>;
  /** A schedule calendar's `dates` as stored, or undefined when there is no such calendar. */
  calendarDates(calendarId: string): Promise<unknown>;
}
