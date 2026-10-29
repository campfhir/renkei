/**
 * Code workspaces — the `sandbox_workspaces` row that describes a checkout
 * whose bytes live on this worker's workspace volume (workspaces.ts),
 * through the data store (`sandboxWorkspaces`). Every read and write is
 * scoped by subject, the same no-cross-caller discipline as sandbox_files;
 * the sweep's walks are the ones that are not. Lifetimes are decided here.
 */

import { randomUUID } from 'node:crypto';
import { getDataStore, type SandboxWorkspaceRecord } from '@renkei/db';
import {
  WORKSPACE_TTL_MS,
  type SandboxWorkspaceSummary,
  type WorkspaceStatus,
} from '@renkei/connector-sandbox';

export interface WorkspaceTarget {
  subject: string;
}

export interface StoredWorkspace extends SandboxWorkspaceSummary, WorkspaceTarget {
  storageKey: string;
}

function statusOf(value: string): WorkspaceStatus {
  return value === 'ready' || value === 'failed' ? value : 'cloning';
}

function toStored(record: SandboxWorkspaceRecord): StoredWorkspace {
  return {
    id: record.id,
    subject: record.subject,
    provider: record.provider,
    repoFullName: record.repoFullName,
    branch: record.branch,
    storageKey: record.storageKey,
    parentId: record.parentId,
    status: statusOf(record.status),
    error: record.error,
    sizeBytes: record.sizeBytes,
    createdAt: record.createdAt,
    lastUsedAt: record.lastUsedAt,
    expiresAt: record.expiresAt,
  };
}

const workspaces = () => getDataStore().sandboxWorkspaces;

export function expiryFromNow(): Date {
  return new Date(Date.now() + WORKSPACE_TTL_MS);
}

export async function insertWorkspace(
  input: WorkspaceTarget & {
    provider: string;
    repoFullName: string;
    branch: string;
    storageKey: string;
    /** A worktree's base clone. */
    parentId?: string;
    /** A worktree is made by the request that asks for it: ready at once. */
    status?: WorkspaceStatus;
  }
): Promise<StoredWorkspace> {
  const record = await workspaces().insert({
    id: randomUUID(),
    subject: input.subject,
    provider: input.provider,
    repoFullName: input.repoFullName,
    branch: input.branch,
    storageKey: input.storageKey,
    parentId: input.parentId ?? null,
    status: input.status ?? 'cloning',
    expiresAt: expiryFromNow(),
  });
  return toStored(record);
}

export async function listWorkspaces(target: WorkspaceTarget): Promise<StoredWorkspace[]> {
  return (await workspaces().list(target.subject)).map(toStored);
}

/** Clones (`worktrees: false`) or worktrees (`true`) the caller holds; the two are capped apart. */
export async function countWorkspaces(
  target: WorkspaceTarget,
  options: { worktrees?: boolean } = {}
): Promise<number> {
  return workspaces().count(target.subject, options.worktrees ?? false);
}

export async function getWorkspace(
  target: WorkspaceTarget,
  id: string
): Promise<StoredWorkspace | undefined> {
  const record = await workspaces().get(target.subject, id);
  return record ? toStored(record) : undefined;
}

/** The clone finished (or did not); either way the row says so from now on. */
export async function setWorkspaceStatus(
  id: string,
  status: WorkspaceStatus,
  input: { error?: string | null; sizeBytes?: number; branch?: string } = {}
): Promise<void> {
  await workspaces().setStatus(id, status, {
    error: input.error ?? null,
    sizeBytes: input.sizeBytes,
    branch: input.branch,
  });
}

/** The worktrees hanging off a base clone. */
export async function listWorktrees(
  target: WorkspaceTarget,
  parentId: string
): Promise<StoredWorkspace[]> {
  return (await workspaces().listWorktrees(target.subject, parentId)).map(toStored);
}

/**
 * Any use extends the lifetime: a workspace someone is working in is not
 * stale — and neither is the base clone a worktree hangs off, which the
 * worktree cannot outlive.
 */
export async function touchWorkspace(
  id: string,
  input: { sizeBytes?: number; branch?: string } = {}
): Promise<void> {
  await workspaces().touch(id, {
    lastUsedAt: new Date(),
    expiresAt: expiryFromNow(),
    sizeBytes: input.sizeBytes,
    branch: input.branch,
  });
}

export async function deleteWorkspace(
  target: WorkspaceTarget,
  id: string
): Promise<StoredWorkspace | undefined> {
  const record = await workspaces().delete(target.subject, id);
  return record ? toStored(record) : undefined;
}

/** Rows past their expiry — the sweep removes each one's checkout, then the row. */
export async function listExpiredWorkspaces(limit: number): Promise<StoredWorkspace[]> {
  return (await workspaces().listExpired(new Date(), limit)).map(toStored);
}

export async function deleteWorkspaceById(id: string): Promise<void> {
  await workspaces().deleteById(id);
}

/** A workspace by id alone — the sweep's lookup of a worktree's base, across callers. */
export async function getWorkspaceById(id: string): Promise<StoredWorkspace | undefined> {
  const record = await workspaces().getById(id);
  return record ? toStored(record) : undefined;
}

/** A base clone's worktrees by its id alone, for the sweep. */
export async function listWorktreesOf(parentId: string): Promise<StoredWorkspace[]> {
  return (await workspaces().listWorktreesOf(parentId)).map(toStored);
}
