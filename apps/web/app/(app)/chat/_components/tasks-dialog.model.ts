/**
 * The chat's tasks dialog, opened from the title bar's More menu, with no
 * React: what it shows while the list loads and after, how the list is
 * grouped — what is under way first (in progress, then waiting and
 * blocked, then to do), then what has finished in the order it finished —
 * the Markdown view, what the person may do to a task (complete it once
 * its subtasks are done, cancel it, delete it), what an answer or a
 * refusal leaves on screen, and when the dialog keeps asking again.
 * tasks-dialog.tsx renders from this and makes the calls. The rules of
 * the list itself are lib/chat/tasks/graph.ts's, shared with the server.
 * Tested in tasks-dialog.model.test.ts.
 */

import {
  descendantsOf,
  displayState,
  isFinished,
  tasksMarkdown,
  taskRef,
  type ChatTaskView,
  type TaskDisplayState,
  type TaskWaitView,
} from '@/lib/chat/tasks/graph';

export type TaskAction = 'complete' | 'cancel' | 'delete';

export interface TasksDialogState {
  phase: 'loading' | 'ready' | 'failed';
  tasks: ChatTaskView[];
  wait: TaskWaitView | null;
  view: 'list' | 'markdown';
  /** The action on its way, so its buttons wait; one at a time. */
  pending: { taskId: string; action: TaskAction } | null;
  /** A load that failed, or an action the server refused, in its words. */
  error: string | null;
  /** The Markdown was just copied: the button says so. */
  copied: boolean;
}

export type TasksDialogAction =
  | { type: 'loaded'; tasks: ChatTaskView[]; wait: TaskWaitView | null }
  | { type: 'loadFailed'; message: string }
  | { type: 'viewChosen'; view: 'list' | 'markdown' }
  | { type: 'actionStarted'; taskId: string; action: TaskAction }
  /** The server's list after the action. */
  | { type: 'actionDone'; tasks: ChatTaskView[] }
  | { type: 'actionFailed'; message: string }
  | { type: 'copied' }
  | { type: 'errorDismissed' };

export function initTasksDialog(): TasksDialogState {
  return {
    phase: 'loading',
    tasks: [],
    wait: null,
    view: 'list',
    pending: null,
    error: null,
    copied: false,
  };
}

export function tasksDialogReducer(
  state: TasksDialogState,
  action: TasksDialogAction
): TasksDialogState {
  switch (action.type) {
    case 'loaded':
      // A poll landing while an action is on its way keeps the action's buttons waiting.
      return { ...state, phase: 'ready', tasks: action.tasks, wait: action.wait, error: null };
    case 'loadFailed':
      // A failed poll after a good load keeps the list on screen.
      return state.phase === 'ready' ? state : { ...state, phase: 'failed', error: action.message };
    case 'viewChosen':
      return { ...state, view: action.view, copied: false };
    case 'actionStarted':
      if (state.pending) return state;
      return { ...state, pending: { taskId: action.taskId, action: action.action }, error: null };
    case 'actionDone':
      return { ...state, pending: null, tasks: action.tasks };
    case 'actionFailed':
      return { ...state, pending: null, error: action.message };
    case 'copied':
      return { ...state, copied: true };
    case 'errorDismissed':
      return { ...state, error: null };
  }
}

export interface TaskSection {
  key: 'in_progress' | 'waiting' | 'pending' | 'finished';
  label: string;
  tasks: ChatTaskView[];
}

const byNumber = (a: ChatTaskView, b: ChatTaskView) => a.number - b.number;

/**
 * The list as the dialog groups it: In progress, Waiting (held up, or
 * blocked on a dependency), To do — each by number — then Finished,
 * chronologically by when each finished (ties by number). Empty groups
 * are left out.
 */
export function taskSections(tasks: readonly ChatTaskView[]): TaskSection[] {
  const of = (states: TaskDisplayState[]) =>
    tasks.filter((task) => states.includes(displayState(task, tasks))).sort(byNumber);
  const finished = tasks
    .filter((task) => isFinished(task.status))
    .sort(
      (a, b) =>
        (a.finishedAt ?? a.updatedAt).localeCompare(b.finishedAt ?? b.updatedAt) || byNumber(a, b)
    );
  const sections: TaskSection[] = [
    { key: 'in_progress', label: 'In progress', tasks: of(['in_progress']) },
    { key: 'waiting', label: 'Waiting', tasks: of(['waiting', 'blocked']) },
    { key: 'pending', label: 'To do', tasks: of(['pending']) },
    { key: 'finished', label: 'Finished', tasks: finished },
  ];
  return sections.filter((section) => section.tasks.length > 0);
}

/** "2 of 5 completed" — the dialog's summary line. */
export function taskSummary(tasks: readonly ChatTaskView[]): string {
  if (tasks.length === 0) return 'No tasks yet';
  const done = tasks.filter((task) => task.status === 'completed').length;
  return `${done} of ${tasks.length} completed`;
}

/** What the person may do to this task, in the order the buttons show. */
export function taskActions(
  task: ChatTaskView,
  tasks: readonly ChatTaskView[],
  isOwner: boolean
): TaskAction[] {
  if (!isOwner) return [];
  if (isFinished(task.status)) return ['delete'];
  const openBelow = descendantsOf(task.id, tasks).some((sub) => !isFinished(sub.status));
  return [...(openBelow ? [] : (['complete'] as const)), 'cancel', 'delete'];
}

/** Whether this task's buttons wait on an action in flight (any action holds every button). */
export function actionBusy(state: TasksDialogState): boolean {
  return state.pending !== null;
}

/** The short facts beside a task's title: its parent, and what it waits on. */
export function taskFacts(task: ChatTaskView, tasks: readonly ChatTaskView[]): string[] {
  const parent = task.parentId ? tasks.find((t) => t.id === task.parentId) : null;
  const deps = tasks.filter((t) => task.dependsOn.includes(t.id)).sort(byNumber);
  const blocked = displayState(task, tasks) === 'blocked';
  return [
    ...(parent ? [`subtask of ${taskRef(parent)}`] : []),
    ...(deps.length > 0
      ? [`${blocked ? 'waiting on' : 'after'} ${deps.map(taskRef).join(', ')}`]
      : []),
  ];
}

/** What the chat is suspended on, in words: "all of #2, #3", or null when it is not. */
export function waitSummary(state: TasksDialogState): string | null {
  const { wait } = state;
  if (!wait) return null;
  const watched = state.tasks.filter((task) => wait.taskIds.includes(task.id)).sort(byNumber);
  if (watched.length === 0) return null;
  return `${wait.mode === 'all' ? 'all of' : 'any of'} ${watched.map(taskRef).join(', ')}`;
}

/** Keep asking while something can still change without the person: work under way, or a wait. */
export function shouldPoll(state: TasksDialogState): boolean {
  if (state.phase !== 'ready') return false;
  return (
    state.wait !== null ||
    state.tasks.some((task) => task.status === 'in_progress' || task.status === 'waiting')
  );
}

export function dialogMarkdown(state: TasksDialogState, title: string | null): string {
  return tasksMarkdown(state.tasks, { title, results: true });
}
