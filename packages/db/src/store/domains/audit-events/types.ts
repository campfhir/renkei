/** One row of the tenant audit trail, with the actor's recorded identity when there is one. */
export interface AuditEventRecord {
  id: string;
  actorSubject: string | null;
  action: string;
  targetKind: string | null;
  targetLabel: string | null;
  details: unknown;
  createdAt: Date;
  /** identities.display_name of the actor, when they have an identity row. */
  actorDisplayName: string | null;
  /** identities.email of the actor, when they have an identity row. */
  actorEmail: string | null;
}

export interface NewAuditEvent {
  id: string;
  actorSubject: string | null;
  action: string;
  targetKind: string | null;
  targetLabel: string | null;
  /** Stored as jsonb; null for none. */
  details: Record<string, unknown> | null;
  /** Defaults to now. */
  createdAt?: Date;
}

export interface AuditEventStore {
  /** Append one event; a duplicate id is refused (23505). */
  record(event: NewAuditEvent): Promise<void>;
  /** The newest `limit` events, newest first, ties by id descending. */
  listRecent(limit: number): Promise<AuditEventRecord[]>;
}
