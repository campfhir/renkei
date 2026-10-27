/**
 * Code workspaces on the sandbox worker (sandbox_workspaces): the row that
 * describes a checkout whose bytes live on the worker's volume. Every
 * per-caller read and write names the subject; the sweep's walks (expiry,
 * a worktree's base, a base's worktrees) are the reads by id alone.
 * Lifetimes (`expiresAt`) are the caller's to compute.
 */

export interface SandboxWorkspaceRecord {
  id: string;
  subject: string;
  provider: string;
  repoFullName: string;
  branch: string;
  storageKey: string;
  parentId: string | null;
  /** As stored: 'cloning', 'ready' or 'failed'. */
  status: string;
  error: string | null;
  sizeBytes: number;
  createdAt: Date;
  lastUsedAt: Date;
  expiresAt: Date;
}

export interface SandboxWorkspaceStore {
  insert(workspace: {
    id: string;
    subject: string;
    provider: string;
    repoFullName: string;
    branch: string;
    storageKey: string;
    parentId: string | null;
    status: string;
    expiresAt: Date;
  }): Promise<SandboxWorkspaceRecord>;
  /** The subject's workspaces, newest first (ties by id). */
  list(subject: string): Promise<SandboxWorkspaceRecord[]>;
  /** The subject's base clones (`worktrees` false) or worktrees (true). */
  count(subject: string, worktrees: boolean): Promise<number>;
  get(subject: string, id: string): Promise<SandboxWorkspaceRecord | null>;
  /** Set the status; the error is replaced (null clears it), size and branch only when given. */
  setStatus(
    id: string,
    status: string,
    change: { error: string | null; sizeBytes?: number; branch?: string }
  ): Promise<void>;
  /** The subject's worktrees of one base clone, oldest first (ties by id). */
  listWorktrees(subject: string, parentId: string): Promise<SandboxWorkspaceRecord[]>;
  /**
   * A use: the workspace's base clone (if it has one) gets `expiresAt`;
   * the workspace itself gets `lastUsedAt` and `expiresAt`, and its size
   * and branch when given.
   */
  touch(
    id: string,
    change: { lastUsedAt: Date; expiresAt: Date; sizeBytes?: number; branch?: string }
  ): Promise<void>;
  /** Delete one of the subject's workspaces; the row it was, or null. */
  delete(subject: string, id: string): Promise<SandboxWorkspaceRecord | null>;
  /** Workspaces expiring before `before`, soonest first (ties by id), at most `limit`. */
  listExpired(before: Date, limit: number): Promise<SandboxWorkspaceRecord[]>;
  deleteById(id: string): Promise<void>;
  /** A workspace by id alone (the sweep's lookup of a worktree's base). */
  getById(id: string): Promise<SandboxWorkspaceRecord | null>;
  /** A base clone's worktrees by its id alone, oldest first (ties by id). */
  listWorktreesOf(parentId: string): Promise<SandboxWorkspaceRecord[]>;
}
