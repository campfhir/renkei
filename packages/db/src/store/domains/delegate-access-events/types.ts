/**
 * The delegate's append-only access rows (delegate_access_events,
 * migration 144): who called which sensitive op, about what, and how it
 * ended. Subjects arrive already hashed.
 */
export interface DelegateAccessEventInput {
  caller: string;
  op: string;
  subjectHash: string | null;
  target: string | null;
  outcome: string;
  status: number;
}

export interface DelegateAccessEventRecord extends DelegateAccessEventInput {
  id: string;
  createdAt: Date;
}

export interface DelegateAccessEventStore {
  /** Append one row (created now). */
  record(event: DelegateAccessEventInput): Promise<void>;
  /** The newest `limit` rows, newest first (ties by id, descending). */
  recent(limit: number): Promise<DelegateAccessEventRecord[]>;
}
