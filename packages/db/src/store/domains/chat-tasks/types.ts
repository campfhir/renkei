/**
 * A chat's tasks and its one wait (chat_tasks, chat_task_waits, migration
 * 171): the plan a chat's model keeps for itself and its sub-agents, and
 * the listener it suspends on until some of that plan finishes. Title,
 * detail, progress note and result are sealed under the chat's key; the
 * store keeps them as given and the web app opens them
 * (apps/web/lib/chat/tasks/store.ts). Every rule — which status may
 * follow which, what a dependency blocks, when a wait fires — is the
 * caller's (apps/web/lib/chat/tasks/graph.ts).
 */

export type ChatTaskStatus =
  'pending' | 'in_progress' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export type ChatTaskCreator = 'assistant' | 'subagent' | 'person';

export interface ChatTaskRecord {
  id: string;
  chatId: string;
  parentId: string | null;
  /** The task's short handle in its chat: 1, 2, 3… in the order they were made. */
  number: number;
  /** Sealed, as stored. */
  title: string;
  /** Sealed, as stored. */
  detail: string | null;
  status: ChatTaskStatus;
  /** 0–100, when someone said how far along it is. */
  progress: number | null;
  /** Sealed, as stored. */
  progressNote: string | null;
  /** Sealed, as stored: what finishing it came to. */
  result: string | null;
  /** Ids of this chat's tasks that must be completed before this one starts. */
  dependsOn: string[];
  createdBy: ChatTaskCreator;
  createdAt: Date;
  updatedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
}

export interface NewChatTask {
  chatId: string;
  parentId: string | null;
  title: string;
  detail: string | null;
  status: ChatTaskStatus;
  dependsOn: string[];
  createdBy: ChatTaskCreator;
  startedAt: Date | null;
}

/** The columns an update may set; absent leaves the column as it is. */
export interface ChatTaskPatch {
  title?: string;
  detail?: string | null;
  status?: ChatTaskStatus;
  progress?: number | null;
  progressNote?: string | null;
  result?: string | null;
  dependsOn?: string[];
  startedAt?: Date | null;
  finishedAt?: Date | null;
}

/** The finishes a wait can be woken by. */
export type ChatTaskWaitEvent = 'completed' | 'failed' | 'cancelled';

export interface ChatTaskWaitRecord {
  chatId: string;
  taskIds: string[];
  events: ChatTaskWaitEvent[];
  mode: 'any' | 'all';
  deadlineAt: Date | null;
  /** Who the woken turn runs as: the chat's owner, with the roles they had when it suspended. */
  subject: string;
  roles: string[];
  createdAt: Date;
}

export type NewChatTaskWait = Omit<ChatTaskWaitRecord, 'createdAt'>;

export interface ChatTaskStore {
  /** The chat's tasks, by number. */
  list(chatId: string): Promise<ChatTaskRecord[]>;
  /** One of the chat's tasks, or null. */
  get(chatId: string, id: string): Promise<ChatTaskRecord | null>;
  /** A new task, numbered one past the chat's highest. */
  create(task: NewChatTask): Promise<ChatTaskRecord>;
  /** Set these columns of one of the chat's tasks (and its updated time); the row after, or null. */
  update(chatId: string, id: string, patch: ChatTaskPatch): Promise<ChatTaskRecord | null>;
  /**
   * Delete these tasks of the chat, with every subtask beneath them, and
   * take their ids out of the remaining tasks' `dependsOn`; how many rows went.
   */
  delete(chatId: string, ids: string[]): Promise<number>;
  /** The chat's wait, or null when it is not suspended. */
  getWait(chatId: string): Promise<ChatTaskWaitRecord | null>;
  /** Suspend the chat on this wait, replacing any it had. */
  putWait(wait: NewChatTaskWait): Promise<ChatTaskWaitRecord>;
  /**
   * Remove the chat's wait; true only for the caller that removed it, so
   * of two that race to fire one wait, one wins.
   */
  clearWait(chatId: string): Promise<boolean>;
  /** Waits whose deadline is at or before `now`, earliest first (ties by chat id), at most `limit`. */
  listDueWaits(now: Date, limit: number): Promise<ChatTaskWaitRecord[]>;
}
