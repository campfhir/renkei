/**
 * A chat's tasks through the data store (chatTasks, migration 171): the
 * sealed columns opened and sealed under the chat's key, and each change
 * decided by graph.ts before it is written. Every caller — the model's
 * tools, a sub-agent's, the tasks dialog's routes — changes tasks
 * through here, and each change that finishes a task asks wake.ts whether
 * the chat's wait now fires.
 */

import { getDataStore, type ChatTaskPatch, type ChatTaskRecord } from '@renkei/db';
import type { ContentCipher } from '../content-crypto';
import {
  dependencyRefusal,
  findTask,
  isFinished,
  statusChange,
  taskRef,
  type ChatTaskView,
  type TaskCreator,
  type TaskStatus,
} from './graph';

export const TASK_TITLE_MAX_CHARS = 200;
export const TASK_TEXT_MAX_CHARS = 20_000;
/** A chat's list is a plan, not a database: past this many, make fewer, bigger tasks. */
export const TASKS_PER_CHAT_MAX = 200;

function opened(stored: string | null, cipher: ContentCipher): string | null {
  return stored === null ? null : cipher.open(stored);
}

export function taskViewOf(row: ChatTaskRecord, cipher: ContentCipher): ChatTaskView {
  return {
    id: row.id,
    number: row.number,
    parentId: row.parentId,
    title: cipher.open(row.title),
    detail: opened(row.detail, cipher),
    status: row.status,
    progress: row.progress,
    progressNote: opened(row.progressNote, cipher),
    result: opened(row.result, cipher),
    dependsOn: row.dependsOn,
    createdBy: row.createdBy,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    finishedAt: row.finishedAt?.toISOString() ?? null,
  };
}

export async function listTasks(chatId: string, cipher: ContentCipher): Promise<ChatTaskView[]> {
  return (await getDataStore().chatTasks.list(chatId)).map((row) => taskViewOf(row, cipher));
}

export type TaskOutcome =
  | { ok: true; task: ChatTaskView; tasks: ChatTaskView[]; finished: ChatTaskView[] }
  | { ok: false; reason: string };

class SealRefused extends Error {}

function sealer(cipher: ContentCipher) {
  return (text: string): string => {
    const sealed = cipher.seal(text);
    if (!sealed.ok) throw new SealRefused('The chat’s encryption key is not available right now.');
    return sealed.val;
  };
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  return text ? text.slice(0, max) : null;
}

/** The ids of the tasks these refs name, or the first ref that names none. */
function resolveRefs(
  tasks: readonly ChatTaskView[],
  refs: unknown
): { ok: true; ids: string[] } | { ok: false; reason: string } {
  if (refs === undefined || refs === null) return { ok: true, ids: [] };
  const list = Array.isArray(refs) ? refs : [refs];
  const ids: string[] = [];
  for (const ref of list) {
    const task = findTask(tasks, ref);
    if (!task) return { ok: false, reason: `No task ${String(ref)} in this chat.` };
    if (!ids.includes(task.id)) ids.push(task.id);
  }
  return { ok: true, ids };
}

export interface NewTaskInput {
  title: unknown;
  detail?: unknown;
  /** The parent's id or number, for a subtask. */
  parent?: unknown;
  /** Ids or numbers of the tasks that must complete first. */
  dependsOn?: unknown;
  /** Start it at once (in_progress) rather than leaving it to do. */
  start?: boolean;
  createdBy: TaskCreator;
}

export async function createTask(
  chatId: string,
  cipher: ContentCipher,
  input: NewTaskInput,
  now: Date
): Promise<TaskOutcome> {
  const title = cleanText(input.title, TASK_TITLE_MAX_CHARS);
  if (!title) return { ok: false, reason: 'A task needs a title.' };
  const tasks = await listTasks(chatId, cipher);
  if (tasks.length >= TASKS_PER_CHAT_MAX)
    return {
      ok: false,
      reason: `This chat already has ${TASKS_PER_CHAT_MAX} tasks; delete finished ones or plan in bigger steps.`,
    };
  let parentId: string | null = null;
  if (input.parent !== undefined && input.parent !== null && input.parent !== '') {
    const parent = findTask(tasks, input.parent);
    if (!parent) return { ok: false, reason: `No task ${String(input.parent)} to put it under.` };
    if (isFinished(parent.status))
      return {
        ok: false,
        reason: `${taskRef(parent)} is already ${parent.status}; a finished task takes no new subtasks.`,
      };
    parentId = parent.id;
  }
  const deps = resolveRefs(tasks, input.dependsOn);
  if (!deps.ok) return deps;
  const refusal = dependencyRefusal(null, parentId, deps.ids, tasks);
  if (refusal) return { ok: false, reason: refusal };
  if (input.start) {
    const blockers = tasks.filter((t) => deps.ids.includes(t.id) && t.status !== 'completed');
    if (blockers.length > 0)
      return {
        ok: false,
        reason: `It cannot start yet: it depends on ${blockers.map(taskRef).join(', ')}. Create it without start.`,
      };
  }
  try {
    const seal = sealer(cipher);
    const detail = cleanText(input.detail, TASK_TEXT_MAX_CHARS);
    const row = await getDataStore().chatTasks.create({
      chatId,
      parentId,
      title: seal(title),
      detail: detail ? seal(detail) : null,
      status: input.start ? 'in_progress' : 'pending',
      dependsOn: deps.ids,
      createdBy: input.createdBy,
      startedAt: input.start ? now : null,
    });
    const task = taskViewOf(row, cipher);
    return { ok: true, task, tasks: [...tasks, task], finished: [] };
  } catch (error) {
    if (error instanceof SealRefused) return { ok: false, reason: error.message };
    throw error;
  }
}

export interface TaskChange {
  status?: TaskStatus;
  /** 0–100; null clears it. */
  progress?: number | null;
  progressNote?: unknown;
  title?: unknown;
  detail?: unknown;
  /** Replaces the dependencies: ids or numbers. */
  dependsOn?: unknown;
  result?: unknown;
}

/**
 * Change one task: its status by graph.ts's rules (a cancel takes its
 * open subtasks with it; starting stamps when, finishing stamps when and
 * sets progress to 100 on a completion), its progress, wording or
 * dependencies. `finished` lists every task this change finished, for
 * wake.ts.
 */
export async function changeTask(
  chatId: string,
  cipher: ContentCipher,
  ref: unknown,
  change: TaskChange,
  now: Date
): Promise<TaskOutcome> {
  const tasks = await listTasks(chatId, cipher);
  const task = findTask(tasks, ref);
  if (!task) return { ok: false, reason: `No task ${String(ref)} in this chat.` };
  const patch: ChatTaskPatch = {};
  let cascade: ChatTaskView[] = [];
  try {
    const seal = sealer(cipher);
    if (change.status !== undefined && change.status !== task.status) {
      const allowed = statusChange(task, change.status, tasks);
      if (!allowed.ok) return allowed;
      cascade = allowed.cascade;
      patch.status = change.status;
      if (change.status === 'in_progress' && !task.startedAt) patch.startedAt = now;
      if (isFinished(change.status)) patch.finishedAt = now;
      if (change.status === 'completed') patch.progress = 100;
    } else if (
      change.status === undefined &&
      isFinished(task.status) &&
      (change.progress !== undefined || change.dependsOn !== undefined)
    ) {
      return { ok: false, reason: `${taskRef(task)} is already ${task.status}.` };
    }
    if (change.progress !== undefined && patch.progress === undefined) {
      if (change.progress === null) patch.progress = null;
      else if (typeof change.progress !== 'number' || !Number.isFinite(change.progress))
        return { ok: false, reason: 'progress is a number from 0 to 100.' };
      else patch.progress = Math.max(0, Math.min(100, Math.round(change.progress)));
    }
    if (change.progressNote !== undefined) {
      const note = cleanText(change.progressNote, TASK_TEXT_MAX_CHARS);
      patch.progressNote = note ? seal(note) : null;
    }
    if (change.title !== undefined) {
      const title = cleanText(change.title, TASK_TITLE_MAX_CHARS);
      if (!title) return { ok: false, reason: 'A task needs a title.' };
      patch.title = seal(title);
    }
    if (change.detail !== undefined) {
      const detail = cleanText(change.detail, TASK_TEXT_MAX_CHARS);
      patch.detail = detail ? seal(detail) : null;
    }
    if (change.result !== undefined) {
      const result = cleanText(change.result, TASK_TEXT_MAX_CHARS);
      patch.result = result ? seal(result) : null;
    }
    if (change.dependsOn !== undefined) {
      const deps = resolveRefs(tasks, change.dependsOn);
      if (!deps.ok) return deps;
      const refusal = dependencyRefusal(task.id, task.parentId, deps.ids, tasks);
      if (refusal) return { ok: false, reason: refusal };
      if (task.status === 'in_progress' && patch.status === undefined) {
        const unmet = tasks.filter((t) => deps.ids.includes(t.id) && t.status !== 'completed');
        if (unmet.length > 0)
          return {
            ok: false,
            reason: `${taskRef(task)} is already under way; it cannot newly wait on ${unmet.map(taskRef).join(', ')}.`,
          };
      }
      patch.dependsOn = deps.ids;
    }
  } catch (error) {
    if (error instanceof SealRefused) return { ok: false, reason: error.message };
    throw error;
  }
  const store = getDataStore().chatTasks;
  const row = await store.update(chatId, task.id, patch);
  if (!row) return { ok: false, reason: `${taskRef(task)} is gone.` };
  for (const sub of cascade) {
    await store.update(chatId, sub.id, { status: 'cancelled', finishedAt: now });
  }
  const updated = taskViewOf(row, cipher);
  const after = await listTasks(chatId, cipher);
  const finishedIds = new Set([
    ...(patch.status && isFinished(patch.status) ? [task.id] : []),
    ...cascade.map((sub) => sub.id),
  ]);
  return {
    ok: true,
    task: updated,
    tasks: after,
    finished: after.filter((t) => finishedIds.has(t.id)),
  };
}

/** Delete a task with its subtree; the tasks deleted, or why not. */
export async function deleteTask(
  chatId: string,
  cipher: ContentCipher,
  ref: unknown
): Promise<
  { ok: true; deleted: ChatTaskView[]; tasks: ChatTaskView[] } | { ok: false; reason: string }
> {
  const tasks = await listTasks(chatId, cipher);
  const task = findTask(tasks, ref);
  if (!task) return { ok: false, reason: `No task ${String(ref)} in this chat.` };
  const below = new Set<string>([task.id]);
  for (let grew = true; grew;) {
    grew = false;
    for (const t of tasks) {
      if (t.parentId && below.has(t.parentId) && !below.has(t.id)) {
        below.add(t.id);
        grew = true;
      }
    }
  }
  await getDataStore().chatTasks.delete(chatId, [task.id]);
  return {
    ok: true,
    deleted: tasks.filter((t) => below.has(t.id)),
    tasks: await listTasks(chatId, cipher),
  };
}
