/**
 * The rules of a chat's task list, pure: what a task's status may become,
 * what a dependency blocks, which subtasks a cancel takes with it, when a
 * suspended chat's wait fires, and how the list reads as Markdown. The
 * tools (tools.ts), the routes and the tasks dialog all decide through
 * these, so the model, the person and the page see one set of rules.
 *
 * Nothing here touches the store, the clock or the browser: times come in
 * as arguments, so it runs the same in the server and the dialog's bundle.
 */

export type TaskStatus =
  'pending' | 'in_progress' | 'waiting' | 'completed' | 'failed' | 'cancelled';

export type TaskCreator = 'assistant' | 'subagent' | 'person';

/** A task as the page and the tools read it: opened, times as ISO strings. */
export interface ChatTaskView {
  id: string;
  number: number;
  parentId: string | null;
  title: string;
  detail: string | null;
  status: TaskStatus;
  progress: number | null;
  progressNote: string | null;
  result: string | null;
  dependsOn: string[];
  createdBy: TaskCreator;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export type WaitEvent = 'completed' | 'failed' | 'cancelled';

/** What a suspended chat is waiting on. */
export interface TaskWaitView {
  taskIds: string[];
  events: WaitEvent[];
  mode: 'any' | 'all';
  deadlineAt: string | null;
}

export const TASK_STATUSES: readonly TaskStatus[] = [
  'pending',
  'in_progress',
  'waiting',
  'completed',
  'failed',
  'cancelled',
];

export const WAIT_EVENTS: readonly WaitEvent[] = ['completed', 'failed', 'cancelled'];

export const FINISHED_STATUSES: readonly TaskStatus[] = ['completed', 'failed', 'cancelled'];

export function isFinished(status: TaskStatus): boolean {
  return FINISHED_STATUSES.includes(status);
}

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === 'string' && TASK_STATUSES.some((status) => status === value);
}

/** How a task shows: its status, or 'blocked' for an open task whose dependencies are not all completed. */
export type TaskDisplayState = TaskStatus | 'blocked';

export const STATE_LABELS: Record<TaskDisplayState, string> = {
  pending: 'To do',
  in_progress: 'In progress',
  waiting: 'Waiting',
  blocked: 'Blocked',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** `#3` — how a task is named to the model and the person. */
export function taskRef(task: { number: number }): string {
  return `#${task.number}`;
}

/** The task a model or a person meant: its id, or its number as `3` or `#3`. */
export function findTask(tasks: readonly ChatTaskView[], ref: unknown): ChatTaskView | null {
  if (typeof ref === 'number' && Number.isInteger(ref)) {
    return tasks.find((task) => task.number === ref) ?? null;
  }
  if (typeof ref !== 'string') return null;
  const text = ref.trim();
  const numbered = /^#?(\d+)$/.exec(text);
  if (numbered) return tasks.find((task) => task.number === Number(numbered[1])) ?? null;
  return tasks.find((task) => task.id === text) ?? null;
}

/** The dependencies of `task` that are not completed yet, in number order. */
export function blockersOf(task: ChatTaskView, tasks: readonly ChatTaskView[]): ChatTaskView[] {
  return tasks
    .filter((other) => task.dependsOn.includes(other.id) && other.status !== 'completed')
    .sort((a, b) => a.number - b.number);
}

export function displayState(task: ChatTaskView, tasks: readonly ChatTaskView[]): TaskDisplayState {
  if (
    (task.status === 'pending' || task.status === 'waiting') &&
    blockersOf(task, tasks).length > 0
  )
    return 'blocked';
  return task.status;
}

/** Every task beneath `id`, depth first in number order. */
export function descendantsOf(id: string, tasks: readonly ChatTaskView[]): ChatTaskView[] {
  const out: ChatTaskView[] = [];
  const walk = (parent: string) => {
    for (const child of tasks
      .filter((task) => task.parentId === parent)
      .sort((a, b) => a.number - b.number)) {
      out.push(child);
      walk(child.id);
    }
  };
  walk(id);
  return out;
}

/** The parent chain of `task`, nearest first. */
export function ancestorsOf(task: ChatTaskView, tasks: readonly ChatTaskView[]): ChatTaskView[] {
  const out: ChatTaskView[] = [];
  const seen = new Set<string>();
  let parentId = task.parentId;
  while (parentId && !seen.has(parentId)) {
    seen.add(parentId);
    const parent = tasks.find((other) => other.id === parentId);
    if (!parent) break;
    out.push(parent);
    parentId = parent.parentId;
  }
  return out;
}

const refs = (tasks: readonly ChatTaskView[]) => tasks.map(taskRef).join(', ');

/**
 * Whether `dependsOn` may be the dependencies of the task `selfId` (null
 * for one being made under `parentId`): every one a task of this chat,
 * none the task itself, its ancestor or its subtask (a parent finishes
 * after its subtasks, so either way round would never start), and no
 * cycle through other tasks' dependencies. A refusal says why, for the model.
 */
export function dependencyRefusal(
  selfId: string | null,
  parentId: string | null,
  dependsOn: readonly string[],
  tasks: readonly ChatTaskView[]
): string | null {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const id of dependsOn) {
    if (!byId.has(id)) return `No task ${id} in this chat to depend on.`;
    if (id === selfId) return 'A task cannot depend on itself.';
  }
  const lineage = new Set<string>();
  let cursor = parentId;
  while (cursor && !lineage.has(cursor)) {
    lineage.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
  }
  const below = selfId ? new Set(descendantsOf(selfId, tasks).map((task) => task.id)) : new Set();
  for (const id of dependsOn) {
    const dep = byId.get(id);
    if (!dep) continue;
    if (lineage.has(id))
      return `${taskRef(dep)} is a parent of this task: a parent finishes after its subtasks, so it can never come first.`;
    if (below.has(id))
      return `${taskRef(dep)} is a subtask of this task: subtasks belong inside it, not before it.`;
  }
  if (selfId) {
    // A path from any dependency back to this task through dependencies is a cycle.
    const stack = [...dependsOn];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const id = stack.pop();
      if (!id || seen.has(id)) continue;
      seen.add(id);
      if (id === selfId)
        return 'Those dependencies would make a cycle: a task would wait on itself.';
      stack.push(...(byId.get(id)?.dependsOn ?? []));
    }
  }
  return null;
}

/**
 * A status change asked for: refused with the reason, or allowed with the
 * other tasks it takes along (a cancel takes the open subtasks with it).
 *
 *  - a finished task stays finished: make a new task to do it again;
 *  - a task starts (in_progress) only once every dependency is completed;
 *  - a task completes only once none of its subtasks is still open;
 *  - failing or cancelling is always allowed; a cancel cancels the open
 *    subtasks too.
 */
export function statusChange(
  task: ChatTaskView,
  next: TaskStatus,
  tasks: readonly ChatTaskView[]
): { ok: true; cascade: ChatTaskView[] } | { ok: false; reason: string } {
  if (task.status === next) return { ok: true, cascade: [] };
  if (isFinished(task.status))
    return {
      ok: false,
      reason: `${taskRef(task)} is already ${task.status}; a finished task stays finished — create a new task to do it again.`,
    };
  if (next === 'in_progress') {
    const blockers = blockersOf(task, tasks);
    if (blockers.length > 0)
      return {
        ok: false,
        reason: `${taskRef(task)} cannot start yet: it depends on ${blockers
          .map((b) => `${taskRef(b)} (${STATE_LABELS[b.status].toLowerCase()})`)
          .join(', ')}.`,
      };
  }
  if (next === 'completed') {
    const open = descendantsOf(task.id, tasks).filter((sub) => !isFinished(sub.status));
    if (open.length > 0)
      return {
        ok: false,
        reason: `${taskRef(task)} still has open subtasks: ${refs(open)}. Complete or cancel them first.`,
      };
  }
  if (next === 'cancelled') {
    return {
      ok: true,
      cascade: descendantsOf(task.id, tasks).filter((sub) => !isFinished(sub.status)),
    };
  }
  return { ok: true, cascade: [] };
}

/** The tasks whose dependencies include `task` and that are still open — what finishing it may unblock. */
export function dependentsOf(task: ChatTaskView, tasks: readonly ChatTaskView[]): ChatTaskView[] {
  return tasks
    .filter((other) => other.dependsOn.includes(task.id) && !isFinished(other.status))
    .sort((a, b) => a.number - b.number);
}

/**
 * Whether a suspended chat's wait fires now, and why:
 *
 *  - 'gone': none of the watched tasks exists any more;
 *  - 'any': some watched task finished with one of the wait's events;
 *  - 'all': every watched task is finished — or, failing fast, one
 *    finished with a failure or cancel the wait listens for;
 *  - 'timeout': the deadline passed first.
 *
 * Null: keep waiting.
 */
export function waitFiring(
  wait: TaskWaitView,
  tasks: readonly ChatTaskView[],
  now: Date
): { reason: 'satisfied' | 'failed-fast' | 'timeout' | 'gone'; watched: ChatTaskView[] } | null {
  const watched = tasks
    .filter((task) => wait.taskIds.includes(task.id))
    .sort((a, b) => a.number - b.number);
  if (watched.length === 0) return { reason: 'gone', watched };
  const hit = (task: ChatTaskView) =>
    isFinished(task.status) && wait.events.some((event) => event === task.status);
  if (wait.mode === 'any') {
    if (watched.some(hit)) return { reason: 'satisfied', watched };
  } else {
    if (watched.every((task) => isFinished(task.status))) return { reason: 'satisfied', watched };
    if (watched.some((task) => task.status !== 'completed' && hit(task)))
      return { reason: 'failed-fast', watched };
  }
  if (wait.deadlineAt && new Date(wait.deadlineAt).getTime() <= now.getTime())
    return { reason: 'timeout', watched };
  return null;
}

function clipText(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** One task on one line, for the tools' answers: `#3 [in progress 40%] Title — after #1, sub of #2`. */
export function taskLine(task: ChatTaskView, tasks: readonly ChatTaskView[]): string {
  const state = displayState(task, tasks);
  const progress = task.progress !== null && !isFinished(task.status) ? ` ${task.progress}%` : '';
  const parent = task.parentId ? tasks.find((t) => t.id === task.parentId) : null;
  const deps = tasks.filter((t) => task.dependsOn.includes(t.id));
  const extras = [
    ...(parent ? [`subtask of ${taskRef(parent)}`] : []),
    ...(deps.length > 0 ? [`after ${refs(deps)}`] : []),
    ...(task.progressNote && !isFinished(task.status) ? [clipText(task.progressNote, 160)] : []),
  ];
  return `${taskRef(task)} [${STATE_LABELS[state].toLowerCase()}${progress}] ${task.title}${
    extras.length > 0 ? ` — ${extras.join('; ')}` : ''
  }`;
}

/** The whole list for a tool's answer: a tree, subtasks indented under their parent. */
export function taskTree(tasks: readonly ChatTaskView[]): string {
  if (tasks.length === 0) return 'No tasks yet.';
  const lines: string[] = [];
  const known = new Set(tasks.map((task) => task.id));
  const walk = (parentId: string | null, depth: number) => {
    for (const task of tasks
      .filter((t) =>
        parentId === null ? !t.parentId || !known.has(t.parentId) : t.parentId === parentId
      )
      .sort((a, b) => a.number - b.number)) {
      lines.push(`${'  '.repeat(depth)}- ${taskLine(task, tasks)}`);
      walk(task.id, depth + 1);
    }
  };
  walk(null, 0);
  return lines.join('\n');
}

/** A task in full, for chat_task_get. */
export function taskDetail(task: ChatTaskView, tasks: readonly ChatTaskView[]): string {
  const subtasks = tasks.filter((t) => t.parentId === task.id).sort((a, b) => a.number - b.number);
  const deps = tasks.filter((t) => task.dependsOn.includes(t.id));
  return [
    taskLine(task, tasks),
    `id: ${task.id}`,
    ...(task.detail ? [`Detail: ${task.detail}`] : []),
    ...(deps.length > 0 ? [`Depends on: ${deps.map((d) => taskLine(d, tasks)).join('; ')}`] : []),
    ...(subtasks.length > 0
      ? ['Subtasks:', ...subtasks.map((s) => `- ${taskLine(s, tasks)}`)]
      : []),
    ...(task.progressNote ? [`Progress note: ${task.progressNote}`] : []),
    ...(task.result ? [`Result: ${task.result}`] : []),
    `Created ${task.createdAt} by the ${task.createdBy}${task.startedAt ? `; started ${task.startedAt}` : ''}${
      task.finishedAt ? `; finished ${task.finishedAt}` : ''
    }.`,
  ].join('\n');
}

/** What the woken turn is told: why it woke, and how each watched task stands. */
export function wakeNoteText(
  firing: NonNullable<ReturnType<typeof waitFiring>>,
  tasks: readonly ChatTaskView[]
): string {
  const head =
    firing.reason === 'timeout'
      ? 'Task wait timed out before the tasks finished.'
      : firing.reason === 'gone'
        ? 'Task wait ended: the tasks it watched were deleted.'
        : firing.reason === 'failed-fast'
          ? 'Task wait woke early: a task it watched did not complete.'
          : 'Task wait finished: the tasks it watched are done.';
  const lines = firing.watched.map((task) => {
    const result = task.result ? `\n  Result: ${clipText(task.result, 4_000)}` : '';
    return `- ${taskLine(task, tasks)}${result}`;
  });
  return [head, ...lines, 'Carry on from here: chat_task_list shows the whole plan.'].join('\n');
}

const CHECK: Record<TaskStatus, string> = {
  pending: '[ ]',
  in_progress: '[ ]',
  waiting: '[ ]',
  completed: '[x]',
  failed: '[ ]',
  cancelled: '[ ]',
};

/**
 * The list as a Markdown checklist — what the person copies or downloads
 * from the tasks dialog: a heading, then the tree with each task's state,
 * progress, dependencies and (with `results`) what it came to.
 */
export function tasksMarkdown(
  tasks: readonly ChatTaskView[],
  options: { title?: string | null; results?: boolean } = {}
): string {
  const heading = `# ${options.title ? `Tasks — ${options.title}` : 'Tasks'}`;
  if (tasks.length === 0) return `${heading}\n\n_No tasks yet._\n`;
  const lines: string[] = [heading, ''];
  const done = tasks.filter((t) => t.status === 'completed').length;
  lines.push(`${done} of ${tasks.length} completed.`, '');
  const known = new Set(tasks.map((task) => task.id));
  const walk = (parentId: string | null, depth: number) => {
    for (const task of tasks
      .filter((t) =>
        parentId === null ? !t.parentId || !known.has(t.parentId) : t.parentId === parentId
      )
      .sort((a, b) => a.number - b.number)) {
      const indent = '  '.repeat(depth);
      const state = displayState(task, tasks);
      const title = task.status === 'cancelled' ? `~~${task.title}~~` : task.title;
      const deps = tasks.filter((t) => task.dependsOn.includes(t.id));
      const notes = [
        state === 'completed' ? null : `_${STATE_LABELS[state].toLowerCase()}_`,
        task.progress !== null && !isFinished(task.status) ? `${task.progress}%` : null,
        deps.length > 0 ? `after ${refs(deps)}` : null,
      ].filter((note): note is string => note !== null);
      lines.push(
        `${indent}- ${CHECK[task.status]} **${taskRef(task)}** ${title}${notes.length > 0 ? ` — ${notes.join(', ')}` : ''}`
      );
      if (task.detail) lines.push(`${indent}  ${task.detail.replace(/\n/g, ' ')}`);
      if (task.progressNote && !isFinished(task.status))
        lines.push(`${indent}  > ${task.progressNote.replace(/\n/g, ' ')}`);
      if (options.results && task.result)
        lines.push(`${indent}  > **Result:** ${task.result.replace(/\n/g, `\n${indent}  > `)}`);
      walk(task.id, depth + 1);
    }
  };
  walk(null, 0);
  return `${lines.join('\n')}\n`;
}
