/**
 * Sandboxes (migration 180): the machines the orchestrator makes, one per
 * scope, and where each is in its life. The orchestrator
 * (packages/sandbox-orchestrator) is the only writer; every change of
 * state is a compare-and-set, so two orchestrators acting on one sandbox
 * agree on who did it.
 */
export type SandboxKind = 'user' | 'agent' | 'project' | 'system';

export type SandboxState =
  | 'provisioning'
  | 'running'
  | 'suspending'
  | 'suspended'
  | 'resuming'
  | 'deleting'
  | 'deleted';

export interface SandboxRecord {
  id: string;
  /** The scope, as callers name it: a subject, `agent:<id>`, `code-project:<id>`, … */
  routeKey: string;
  kind: SandboxKind;
  /** Which provider made it: `docker`, `azure`, … */
  provider: string;
  /** The provider's own name for the machine; null until it has made one. */
  providerId: string | null;
  state: SandboxState;
  /** Where its worker answers while it runs. */
  address: string | null;
  /** Why it was removed or could not be made, when that was a failure. */
  error: string | null;
  createdAt: Date;
  /** The last call made for the scope. */
  lastActiveAt: Date;
  stateChangedAt: Date;
  /** When the provider was last asked and agreed with `state`. */
  verifiedAt: Date;
}

export interface SandboxStore {
  /**
   * Begin a sandbox for a scope: a `provisioning` row, unless the scope
   * already has one that is not deleted — then null, and the caller reads
   * that one instead.
   */
  claim(input: {
    id: string;
    routeKey: string;
    kind: SandboxKind;
    provider: string;
    at: Date;
  }): Promise<SandboxRecord | null>;
  /** The scope's sandbox that is not deleted; null when it has none. */
  live(routeKey: string): Promise<SandboxRecord | null>;
  get(id: string): Promise<SandboxRecord | null>;
  /**
   * Move a sandbox from one of `from` to `to`, if it is still in one of
   * them: true when this call moved it. `state_changed_at` and
   * `verified_at` become `at`; `providerId`, `address` and `error` change
   * only where given (null clears).
   */
  transition(input: {
    id: string;
    from: SandboxState[];
    to: SandboxState;
    at: Date;
    providerId?: string | null;
    address?: string | null;
    error?: string | null;
  }): Promise<boolean>;
  /** A call was made for the scope: `last_active_at` moves forward to `at`, never back. */
  touch(id: string, at: Date): Promise<void>;
  /** The provider was asked and agrees with the row: `verified_at` becomes `at`. */
  verified(id: string, at: Date): Promise<void>;
  /**
   * Sandboxes in one of `states`, optionally only those last active
   * strictly before `lastActiveBefore` and/or whose state last changed
   * strictly before `stateChangedBefore`; least recently active first,
   * then by id, at most `limit`.
   */
  list(input: {
    states: SandboxState[];
    lastActiveBefore?: Date;
    stateChangedBefore?: Date;
    limit: number;
  }): Promise<SandboxRecord[]>;
  /** Drop `deleted` rows whose state last changed strictly before `before`; how many went. */
  purgeDeleted(before: Date): Promise<number>;
}
