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

/**
 * One row of the deployment-scoped platform log (platform_audit_log): the
 * installation's own record of operator acts, beside the tenant trail.
 */
export interface PlatformAuditEventRecord {
  id: string;
  eventType: string;
  actorId: string | null;
  resourceId: string | null;
  details: unknown;
  createdAt: Date;
}

export interface NewPlatformAuditEvent {
  id: string;
  eventType: string;
  actorId: string | null;
  resourceId: string | null;
  /** Stored as jsonb; null for none. */
  details: Record<string, unknown> | null;
}

export interface AuditEventStore {
  /** Append one event; a duplicate id is refused (23505). */
  record(event: NewAuditEvent): Promise<void>;
  /** The newest `limit` events, newest first, ties by id descending. */
  listRecent(limit: number): Promise<AuditEventRecord[]>;
  /** Append one platform-log row; a duplicate id is refused (23505). */
  recordPlatform(event: NewPlatformAuditEvent): Promise<void>;
  /** The platform-log rows about one resource, newest first, ties by id descending. */
  listPlatformFor(resourceId: string): Promise<PlatformAuditEventRecord[]>;
}
