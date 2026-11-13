/**
 * Sandbox instances (sandbox_instances) and which one serves each caller
 * (sandbox_assignments): how the app sends a caller's sandbox calls to
 * the one instance that holds their kernels, servers and checkouts.
 * Migration 179 says why; packages/sandbox-client's routing uses it.
 */
export interface SandboxInstanceRecord {
  /** Stable across a restart where the deployment names the instance. */
  id: string;
  /** Where the app reaches it directly, e.g. `http://172.18.0.7:8092`. */
  address: string;
  /** When this run of the instance began. */
  startedAt: Date;
  lastSeenAt: Date;
}

export interface SandboxLiveInstance extends SandboxInstanceRecord {
  /** How many callers are assigned to it. */
  assigned: number;
}

export interface SandboxAssignmentRecord {
  subject: string;
  instanceId: string;
  assignedAt: Date;
  /** The instance's own row, while it has one. */
  instance: SandboxInstanceRecord | null;
}

export interface SandboxInstanceStore {
  /** An instance says it is up: its row made, or its address, start and last-seen time brought up to date. */
  heartbeat(instance: { id: string; address: string; startedAt: Date; at: Date }): Promise<void>;
  /** Drop the rows of instances not seen since `before`; how many went. */
  removeUnseenSince(before: Date): Promise<number>;
  /** Instances seen at or after `since`, fewest assigned callers first, then by id. */
  listLive(since: Date): Promise<SandboxLiveInstance[]>;
  /** Which instance a caller is served by; null when none has been chosen. */
  assignment(subject: string): Promise<SandboxAssignmentRecord | null>;
  /**
   * Assign a caller to an instance, if nobody else has first: with
   * `replacing` null only a caller with no assignment is assigned, and
   * otherwise only one still assigned to `replacing`. Returns the
   * instance the caller is assigned to afterwards, which is another's
   * choice when one got there first.
   */
  assign(input: {
    subject: string;
    instanceId: string;
    replacing: string | null;
    at: Date;
  }): Promise<string>;
}
