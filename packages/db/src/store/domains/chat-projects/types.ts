/**
 * Chat projects — and code projects, the same row with a repository on it
 * (migrations 092, 102) — with their memory (chat_project_memories).
 * Instructions and memory come back sealed, as stored; who may open a
 * project is apps/web/lib/chat/access.ts's decision.
 */

export interface ChatProjectRecord {
  id: string;
  ownerSubject: string;
  /** `chat` or `code`, as stored. */
  kind: string;
  name: string;
  description: string | null;
  /** Sealed, as stored. */
  instructions: string | null;
  /** The stored JSON, unparsed. */
  toolConfig: unknown;
  repoProvider: string | null;
  repoFullName: string | null;
  repoBranch: string | null;
  workspaceId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewChatProject {
  ownerSubject: string;
  name: string;
  description: string | null;
  toolConfig: unknown;
  /** A code project's repository; absent makes a chat project. */
  repo?: { provider: string; fullName: string; branch: string | null };
}

/** Absent fields stay; every update bumps `updatedAt`. */
export interface ChatProjectPatch {
  name?: string;
  description?: string | null;
  /** Sealed instructions, or null to clear. */
  instructions?: string | null;
  toolConfig?: unknown;
  repo?: { provider: string; fullName: string; branch: string | null };
  workspaceId?: string | null;
}

export interface ProjectMemoryRecord {
  id: string;
  projectId: string;
  kind: string;
  /** Sealed, as stored. */
  content: string;
  authorSubject: string | null;
  chatId: string | null;
  createdAt: Date;
}

export type MemoryTarget = { kind: 'all' } | { kind: 'entries'; ids: string[] };

export interface ChatProjectStore {
  get(projectId: string): Promise<ChatProjectRecord | null>;
  /** An owner's projects, most recently updated first (ties by id). */
  listOwned(ownerSubject: string): Promise<ChatProjectRecord[]>;
  /**
   * These projects (unknown ids left out): most recently updated first,
   * or with `orderBy: 'name'` by name ascending — each with id as the
   * tie-breaker.
   */
  listByIds(
    projectIds: string[],
    options?: { orderBy?: 'updated' | 'name' }
  ): Promise<ChatProjectRecord[]>;
  /**
   * These projects (unknown ids left out) with how many unexpired grants
   * each has, by id.
   */
  withGrantCounts(
    projectIds: string[]
  ): Promise<{ id: string; name: string; kind: string; grants: number }[]>;
  /** A new project (no instructions yet); its id. */
  create(project: NewChatProject): Promise<string>;
  /** Change a project by id; false when there is none. */
  update(projectId: string, patch: ChatProjectPatch): Promise<boolean>;
  /** Delete one of the owner's projects (its memory and references cascade; its chats leave it). */
  delete(ownerSubject: string, projectId: string): Promise<boolean>;
  /** A project's memory rows (entries and the summary), newest first (ties by id), at most `limit`. */
  listMemory(projectId: string, limit: number): Promise<ProjectMemoryRecord[]>;
  /**
   * Append one sealed entry, then drop the project's entries beyond the
   * newest `keep` (ties by id); the new entry's id.
   */
  appendMemory(entry: {
    projectId: string;
    content: string;
    authorSubject: string;
    chatId: string | null;
    keep: number;
  }): Promise<string>;
  /** Delete all of a project's memory, or these rows of it; how many went. */
  forgetMemory(projectId: string, target: MemoryTarget): Promise<number>;
}
