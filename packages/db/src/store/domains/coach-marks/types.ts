/** One person's record of one coach-mark tour. Timestamps are ISO strings. */
export interface CoachMarkProgressRecord {
  tourId: string;
  version: number;
  status: string;
  stepReached: number;
  stepsTotal: number;
  viewCount: number;
  completedCount: number;
  dismissedCount: number;
  firstViewedAt: string;
  lastViewedAt: string;
  completedAt: string | null;
  dismissedAt: string | null;
  reportedAt: string;
}

export interface CoachMarkStore {
  /** One person's rows, by tour id. */
  list(subject: string): Promise<CoachMarkProgressRecord[]>;
  /**
   * Read, decide, write — atomically per (subject, tour): two applies for
   * the same row never both read the row before the other wrote it. `next`
   * is a pure function of the existing row (null for a first report) and
   * its answer is what gets stored and returned. Its `tourId` must be the
   * one asked for; the row keeps the first view it was inserted with.
   */
  apply(
    subject: string,
    tourId: string,
    next: (existing: CoachMarkProgressRecord | null) => CoachMarkProgressRecord
  ): Promise<CoachMarkProgressRecord>;
  /** Every row in the deployment, most recently changed first. */
  listAll(): Promise<{ subject: string; progress: CoachMarkProgressRecord }[]>;
}
