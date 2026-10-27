/**
 * Chats: one row per conversation (migration 092 and later). Ownership is
 * structural — every owner-scoped write names the owner — and who else may
 * read a chat is apps/web/lib/chat/access.ts's decision, not the store's.
 */

export interface ChatRecord {
  id: string;
  ownerSubject: string;
  projectId: string | null;
  title: string | null;
  llmModelId: string | null;
  /** The stored JSON, unparsed (the caller validates it). */
  toolConfig: unknown;
  thinkingEnabled: boolean;
  autoMode: boolean;
  autoTitleAsked: boolean;
  workspaceId: string | null;
  lastMessageAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface NewChat {
  ownerSubject: string;
  projectId: string | null;
  llmModelId: string | null;
  /** JSON-serializable, or null. */
  toolConfig: unknown;
  thinkingEnabled: boolean;
  autoMode: boolean;
}

/** Fields an owner may change; absent ones stay. `archived` sets or clears archived_at (now). */
export interface ChatRecordPatch {
  title?: string | null;
  llmModelId?: string | null;
  toolConfig?: unknown;
  thinkingEnabled?: boolean;
  autoMode?: boolean;
  archived?: boolean;
}

export interface ChatStore {
  get(chatId: string): Promise<ChatRecord | null>;
  /**
   * An owner's chats, most recently touched first (ties by id). Archived
   * ones only with `includeArchived`; `since` (inclusive) and `before`
   * (exclusive) bound `updatedAt`.
   */
  listOwned(
    ownerSubject: string,
    options: { includeArchived?: boolean; since?: Date; before?: Date; limit: number }
  ): Promise<ChatRecord[]>;
  /** The owner's unarchived chats in one project, most recently touched first (ties by id). */
  listOwnedInProject(ownerSubject: string, projectId: string, limit: number): Promise<ChatRecord[]>;
  /** Whether the owner has a chat with a message, touched before `before`. */
  hasOwnedBefore(ownerSubject: string, before: Date): Promise<boolean>;
  /**
   * The unarchived chats in these projects, most recently touched first
   * (ties by id), leaving out `excludeOwner`'s own; `since` bounds
   * `updatedAt` (inclusive).
   */
  listInProjects(
    projectIds: string[],
    options: { excludeOwner: string | null; since?: Date; limit: number }
  ): Promise<ChatRecord[]>;
  /** These chats (unknown ids left out), most recently touched first (ties by id). */
  listByIds(chatIds: string[]): Promise<ChatRecord[]>;
  /** A new chat; its id. */
  create(chat: NewChat): Promise<string>;
  /** Change one of the owner's chats, bumping `updatedAt`; false when it is not theirs or not there. */
  update(ownerSubject: string, chatId: string, patch: ChatRecordPatch): Promise<boolean>;
  /** Re-home one of the owner's chats (null: out of any project), bumping `updatedAt`. */
  move(ownerSubject: string, chatId: string, projectId: string | null): Promise<boolean>;
  /** Delete one of the owner's chats (its rows cascade); false when it is not theirs. */
  delete(ownerSubject: string, chatId: string): Promise<boolean>;
  /** Activity: last message and update now; the title only while it has none; the model when given. */
  touch(
    chatId: string,
    input: { titleIfMissing?: string; llmModelId?: string | null }
  ): Promise<void>;
  /** Set the auto-title flag if unset; the title as it stood when this call set it, else null. */
  claimAutoTitle(chatId: string): Promise<{ placeholder: string | null } | null>;
  /** Rename only while the title is still `expected` (null: untitled); whether it changed. */
  renameIfTitledAs(chatId: string, expected: string | null, title: string): Promise<boolean>;
  /** The request overhead the chat's last turn measured, or null. */
  getRequestOverhead(chatId: string): Promise<number | null>;
  setRequestOverhead(chatId: string, tokens: number): Promise<void>;
  /** Record the chat's worktree on the sandbox worker. */
  setWorkspace(chatId: string, workspaceId: string | null): Promise<void>;
}
