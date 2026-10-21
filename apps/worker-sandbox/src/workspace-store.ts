/**
 * Postgres access for code workspaces — the `sandbox_workspaces` row that
 * describes a checkout whose bytes live on this worker's workspace volume
 * (workspaces.ts). Every read and write is scoped by (tenantId, subject),
 * the same no-cross-caller discipline as sandbox_files; the sweep's
 * expiry walk is the one query that is not.
 */

import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
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

const COLUMNS = [
  'id',
  'subject',
  'provider',
  'repo_full_name',
  'branch',
  'storage_key',
  'parent_id',
  'status',
  'error',
  'size_bytes',
  'created_at',
  'last_used_at',
  'expires_at',
] as const;

function statusOf(value: string): WorkspaceStatus {
  return value === 'ready' || value === 'failed' ? value : 'cloning';
}

function toStored(row: {
  id: string;
  subject: string;
  provider: string;
  repo_full_name: string;
  branch: string;
  storage_key: string;
  parent_id: string | null;
  status: string;
  error: string | null;
  size_bytes: string | number | bigint;
  created_at: Date;
  last_used_at: Date;
  expires_at: Date;
}): StoredWorkspace {
  return {
    id: row.id,
    subject: row.subject,
    provider: row.provider,
    repoFullName: row.repo_full_name,
    branch: row.branch,
    storageKey: row.storage_key,
    parentId: row.parent_id,
    status: statusOf(row.status),
    error: row.error,
    sizeBytes: Number(row.size_bytes),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
  };
}

export function expiryFromNow(): Date {
  return new Date(Date.now() + WORKSPACE_TTL_MS);
}

export async function insertWorkspace(
  db: Kysely<DB>,
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
  const row = await db
    .insertInto('sandbox_workspaces')
    .values({
      id: randomUUID(),
      subject: input.subject,
      provider: input.provider,
      repo_full_name: input.repoFullName,
      branch: input.branch,
      storage_key: input.storageKey,
      parent_id: input.parentId ?? null,
      status: input.status ?? 'cloning',
      expires_at: expiryFromNow(),
    })
    .returning(COLUMNS)
    .executeTakeFirstOrThrow();
  return toStored(row);
}

export async function listWorkspaces(
  db: Kysely<DB>,
  target: WorkspaceTarget
): Promise<StoredWorkspace[]> {
  const rows = await db
    .selectFrom('sandbox_workspaces')
    .select(COLUMNS)
    .where('subject', '=', target.subject)
    .orderBy('created_at', 'desc')
    .execute();
  return rows.map(toStored);
}

/** Clones (`worktrees: false`) or worktrees (`true`) the caller holds; the two are capped apart. */
export async function countWorkspaces(
  db: Kysely<DB>,
  target: WorkspaceTarget,
  options: { worktrees?: boolean } = {}
): Promise<number> {
  const row = await db
    .selectFrom('sandbox_workspaces')
    .select((eb) => eb.fn.countAll<string>().as('count'))
    .where('subject', '=', target.subject)
    .where('parent_id', options.worktrees ? 'is not' : 'is', null)
    .executeTakeFirst();
  return row?.count ? Number(row.count) : 0;
}

export async function getWorkspace(
  db: Kysely<DB>,
  target: WorkspaceTarget,
  id: string
): Promise<StoredWorkspace | undefined> {
  const row = await db
    .selectFrom('sandbox_workspaces')
    .select(COLUMNS)
    .where('subject', '=', target.subject)
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? toStored(row) : undefined;
}

/** The clone finished (or did not); either way the row says so from now on. */
export async function setWorkspaceStatus(
  db: Kysely<DB>,
  id: string,
  status: WorkspaceStatus,
  input: { error?: string | null; sizeBytes?: number; branch?: string } = {}
): Promise<void> {
  await db
    .updateTable('sandbox_workspaces')
    .set({
      status,
      error: input.error ?? null,
      ...(input.sizeBytes !== undefined ? { size_bytes: input.sizeBytes } : {}),
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
    })
    .where('id', '=', id)
    .execute();
}

/** The worktrees hanging off a base clone. */
export async function listWorktrees(
  db: Kysely<DB>,
  target: WorkspaceTarget,
  parentId: string
): Promise<StoredWorkspace[]> {
  const rows = await db
    .selectFrom('sandbox_workspaces')
    .select(COLUMNS)
    .where('subject', '=', target.subject)
    .where('parent_id', '=', parentId)
    .execute();
  return rows.map(toStored);
}

/**
 * Any use extends the lifetime: a workspace someone is working in is not
 * stale — and neither is the base clone a worktree hangs off, which the
 * worktree cannot outlive.
 */
export async function touchWorkspace(
  db: Kysely<DB>,
  id: string,
  input: { sizeBytes?: number; branch?: string } = {}
): Promise<void> {
  await db
    .updateTable('sandbox_workspaces')
    .set({ expires_at: expiryFromNow() })
    .where((eb) =>
      eb('id', '=', eb.selectFrom('sandbox_workspaces').select('parent_id').where('id', '=', id))
    )
    .execute();
  await db
    .updateTable('sandbox_workspaces')
    .set({
      last_used_at: new Date(),
      expires_at: expiryFromNow(),
      ...(input.sizeBytes !== undefined ? { size_bytes: input.sizeBytes } : {}),
      ...(input.branch !== undefined ? { branch: input.branch } : {}),
    })
    .where('id', '=', id)
    .execute();
}

export async function deleteWorkspace(
  db: Kysely<DB>,
  target: WorkspaceTarget,
  id: string
): Promise<StoredWorkspace | undefined> {
  const row = await db
    .deleteFrom('sandbox_workspaces')
    .where('subject', '=', target.subject)
    .where('id', '=', id)
    .returning(COLUMNS)
    .executeTakeFirst();
  return row ? toStored(row) : undefined;
}

/** Rows past their expiry — the sweep removes each one's checkout, then the row. */
export async function listExpiredWorkspaces(
  db: Kysely<DB>,
  limit: number
): Promise<StoredWorkspace[]> {
  const rows = await db
    .selectFrom('sandbox_workspaces')
    .select(COLUMNS)
    .where('expires_at', '<', new Date())
    .limit(limit)
    .execute();
  return rows.map(toStored);
}

export async function deleteWorkspaceById(db: Kysely<DB>, id: string): Promise<void> {
  await db.deleteFrom('sandbox_workspaces').where('id', '=', id).execute();
}

/** A workspace by id alone — the sweep's lookup of a worktree's base, across callers. */
export async function getWorkspaceById(
  db: Kysely<DB>,
  id: string
): Promise<StoredWorkspace | undefined> {
  const row = await db
    .selectFrom('sandbox_workspaces')
    .select(COLUMNS)
    .where('id', '=', id)
    .executeTakeFirst();
  return row ? toStored(row) : undefined;
}

/** A base clone's worktrees by its id alone, for the sweep. */
export async function listWorktreesOf(
  db: Kysely<DB>,
  parentId: string
): Promise<StoredWorkspace[]> {
  const rows = await db
    .selectFrom('sandbox_workspaces')
    .select(COLUMNS)
    .where('parent_id', '=', parentId)
    .execute();
  return rows.map(toStored);
}
