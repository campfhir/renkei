'use client';

/**
 * The chat's task list, opened from the title bar's More menu: the plan
 * the chat's model keeps for itself and its sub-agents (lib/chat/tasks/).
 * What is under way comes first — in progress, waiting or blocked, to do
 * — then what has finished, in the order it finished. A suspended chat
 * says what it is waiting on. The list reads as Markdown too, to copy or
 * save. The owner can complete, cancel or delete a task, which may wake a
 * chat waiting on it. The rules are tasks-dialog.model.ts's; this renders
 * them, makes the calls and asks again while work is under way.
 */

import { useCallback, useEffect, useReducer } from 'react';
import Modal from '@/components/modal';
import DownloadLink from '@/components/download-link';
import { Icon, ICONS } from '@/components/icons';
import { LoadingLine } from '@/components/skeleton';
import { chatClient } from '@/lib/chat/client';
import {
  STATE_LABELS,
  displayState,
  taskRef,
  type ChatTaskView,
  type TaskDisplayState,
} from '@/lib/chat/tasks/graph';
import {
  actionBusy,
  dialogMarkdown,
  initTasksDialog,
  shouldPoll,
  taskActions,
  taskFacts,
  taskSections,
  taskSummary,
  tasksDialogReducer,
  waitSummary,
  type TaskAction,
} from './tasks-dialog.model';

const POLL_MS = 4_000;

const STATE_STYLE: Record<TaskDisplayState, string> = {
  in_progress: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-300',
  waiting: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
  blocked: 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300',
  pending: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300',
  completed: 'bg-green-100 text-green-800 dark:bg-green-950/60 dark:text-green-300',
  failed: 'bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300',
  cancelled: 'bg-gray-100 text-gray-500 dark:bg-gray-800 dark:text-gray-400',
};

const ACTION_LABEL: Record<TaskAction, string> = {
  complete: 'Mark complete',
  cancel: 'Cancel task',
  delete: 'Delete task',
};

const ACTION_ICON: Record<TaskAction, string> = {
  complete: ICONS.check,
  cancel: ICONS.close,
  delete: ICONS.trash,
};

function when(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      });
}

export default function TasksDialog({
  chatId,
  chatTitle,
  isOwner,
  onClose,
}: {
  chatId: string;
  chatTitle: string | null;
  isOwner: boolean;
  onClose: () => void;
}) {
  const [state, dispatch] = useReducer(tasksDialogReducer, undefined, initTasksDialog);

  const load = useCallback(async () => {
    const result = await chatClient.getTasks(chatId);
    if (result.data) dispatch({ type: 'loaded', tasks: result.data.tasks, wait: result.data.wait });
    else dispatch({ type: 'loadFailed', message: result.error ?? 'The tasks could not be read.' });
  }, [chatId]);

  useEffect(() => {
    void load();
  }, [load]);

  const polling = shouldPoll(state);
  useEffect(() => {
    if (!polling) return;
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [polling, load]);

  const act = async (task: ChatTaskView, action: TaskAction) => {
    if (actionBusy(state)) return;
    dispatch({ type: 'actionStarted', taskId: task.id, action });
    const result =
      action === 'delete'
        ? await chatClient.deleteTask(chatId, task.id)
        : await chatClient.actOnTask(chatId, task.id, action);
    if (result.data) dispatch({ type: 'actionDone', tasks: result.data.tasks });
    else dispatch({ type: 'actionFailed', message: result.error ?? 'That did not go through.' });
  };

  const markdown = dialogMarkdown(state, chatTitle);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      dispatch({ type: 'copied' });
    } catch {
      dispatch({ type: 'actionFailed', message: 'The clipboard is not available here.' });
    }
  };
  const waiting = waitSummary(state);
  const deadline = when(state.wait?.deadlineAt ?? null);
  const sections = taskSections(state.tasks);

  return (
    <Modal title="Tasks" onClose={onClose} size="lg">
      {state.phase === 'loading' ? (
        <LoadingLine label="Reading the tasks…" />
      ) : state.phase === 'failed' ? (
        <p role="alert" className="text-sm text-red-600 dark:text-red-400">
          {state.error}
        </p>
      ) : (
        <div className="space-y-3 text-sm" data-tasks-dialog>
          <div className="flex flex-wrap items-center gap-2">
            <span className="mr-auto text-xs text-gray-500 dark:text-gray-400" data-tasks-summary>
              {taskSummary(state.tasks)}
            </span>
            <div
              role="tablist"
              aria-label="Show the tasks as"
              className="inline-flex rounded-md border border-gray-200 p-0.5 dark:border-gray-700"
            >
              {(['list', 'markdown'] as const).map((view) => (
                <button
                  key={view}
                  type="button"
                  role="tab"
                  aria-selected={state.view === view}
                  onClick={() => dispatch({ type: 'viewChosen', view })}
                  className={`rounded px-2.5 py-1 text-xs font-medium ${
                    state.view === view
                      ? 'bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900'
                      : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-gray-800'
                  }`}
                >
                  {view === 'list' ? 'List' : 'Markdown'}
                </button>
              ))}
            </div>
          </div>
          {waiting ? (
            <p
              data-tasks-wait
              className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/60 dark:bg-amber-950/40 dark:text-amber-200"
            >
              <Icon path={ICONS.clock} className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              <span>
                The assistant is paused, waiting on {waiting}. It picks up again when they finish
                {deadline ? ` or at ${deadline}` : ''}.
              </span>
            </p>
          ) : null}
          {state.error ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-md bg-red-50 px-3 py-2 text-xs text-red-700 dark:bg-red-950/40 dark:text-red-300"
            >
              <span className="flex-1">{state.error}</span>
              <button
                type="button"
                aria-label="Dismiss"
                onClick={() => dispatch({ type: 'errorDismissed' })}
              >
                <Icon path={ICONS.close} className="h-3.5 w-3.5" />
              </button>
            </p>
          ) : null}
          {state.view === 'markdown' ? (
            <div className="space-y-2">
              <div className="flex gap-2">
                <button
                  type="button"
                  onClick={() => void copy()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                >
                  <Icon path={state.copied ? ICONS.check : ICONS.copy} className="h-3.5 w-3.5" />
                  {state.copied ? 'Copied' : 'Copy Markdown'}
                </button>
                <DownloadLink
                  href={chatClient.tasksMarkdownUrl(chatId)}
                  filename="tasks.md"
                  className="inline-flex items-center gap-1.5 rounded-md border border-gray-300 px-2.5 py-1 text-xs font-medium hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-800"
                >
                  <Icon path={ICONS.download} className="h-3.5 w-3.5" />
                  Download .md
                </DownloadLink>
              </div>
              <pre
                data-tasks-markdown
                className="max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-md border border-gray-200 bg-gray-50 p-3 font-mono text-xs text-gray-800 dark:border-gray-800 dark:bg-gray-950 dark:text-gray-200"
              >
                {markdown}
              </pre>
            </div>
          ) : sections.length === 0 ? (
            <p className="rounded-md border border-dashed border-gray-300 px-3 py-6 text-center text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
              No tasks yet. When the assistant plans work of several steps, its tasks show here.
            </p>
          ) : (
            <div className="max-h-[60vh] space-y-3 overflow-y-auto pr-1">
              {sections.map((section) => (
                <section key={section.key} data-tasks-section={section.key}>
                  <h3 className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-400">
                    {section.label}{' '}
                    <span className="font-normal normal-case">({section.tasks.length})</span>
                  </h3>
                  <ul className="divide-y divide-gray-100 overflow-hidden rounded-md border border-gray-200 dark:divide-gray-800 dark:border-gray-800">
                    {section.tasks.map((task) => (
                      <TaskRow
                        key={task.id}
                        task={task}
                        tasks={state.tasks}
                        actions={taskActions(task, state.tasks, isOwner)}
                        busy={actionBusy(state)}
                        pendingAction={
                          state.pending?.taskId === task.id ? state.pending.action : null
                        }
                        onAct={(action) => void act(task, action)}
                      />
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}

function TaskRow({
  task,
  tasks,
  actions,
  busy,
  pendingAction,
  onAct,
}: {
  task: ChatTaskView;
  tasks: ChatTaskView[];
  actions: TaskAction[];
  busy: boolean;
  pendingAction: TaskAction | null;
  onAct: (action: TaskAction) => void;
}) {
  const state = displayState(task, tasks);
  const finishedAt = when(task.finishedAt);
  const open = !['completed', 'failed', 'cancelled'].includes(task.status);
  // One quiet line under the title: parent, dependencies, progress note or result, when.
  const meta = [
    ...taskFacts(task, tasks),
    ...(task.progressNote && open ? [task.progressNote] : []),
    ...(finishedAt ? [finishedAt] : []),
  ];
  const progress = task.status === 'in_progress' && task.progress !== null ? task.progress : null;
  return (
    <li
      data-task={task.number}
      className="group/row px-2.5 py-1.5"
      title={task.detail ?? undefined}
    >
      <div className="flex items-center gap-2">
        <span className="w-6 shrink-0 font-mono text-[11px] text-gray-400">{taskRef(task)}</span>
        <span
          className={`min-w-0 flex-1 truncate text-[13px] text-gray-900 dark:text-gray-100 ${
            task.status === 'cancelled' ? 'line-through opacity-60' : ''
          }`}
        >
          {task.title}
        </span>
        {progress !== null ? (
          <span
            className="hidden h-1 w-12 shrink-0 overflow-hidden rounded-full bg-gray-200 sm:block dark:bg-gray-800"
            aria-label={`${progress}% done`}
          >
            <span className="block h-full bg-indigo-500" style={{ width: `${progress}%` }} />
          </span>
        ) : null}
        <span
          className={`shrink-0 rounded-full px-1.5 text-[10px] font-medium leading-4 ${STATE_STYLE[state]}`}
        >
          {progress !== null ? `${progress}%` : STATE_LABELS[state]}
        </span>
        {actions.length > 0 ? (
          <span className="-mr-1 flex shrink-0">
            {actions.map((action) => (
              <button
                key={action}
                type="button"
                disabled={busy}
                aria-label={`${ACTION_LABEL[action]} ${taskRef(task)}`}
                title={ACTION_LABEL[action]}
                onClick={() => onAct(action)}
                className={`rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-700 disabled:opacity-40 dark:hover:bg-gray-800 dark:hover:text-gray-200 ${
                  action === 'delete' ? 'hover:text-red-600 dark:hover:text-red-400' : ''
                } ${pendingAction === action ? 'motion-safe:animate-pulse' : ''}`}
              >
                <Icon path={ACTION_ICON[action]} className="h-3.5 w-3.5" />
              </button>
            ))}
          </span>
        ) : null}
      </div>
      {meta.length > 0 || task.result ? (
        <div className="ml-8 min-w-0 text-[11px] leading-4 text-gray-500 dark:text-gray-400">
          {meta.length > 0 ? <p className="truncate">{meta.join(' · ')}</p> : null}
          {task.result ? (
            <details className="group" data-task-result>
              <summary className="flex cursor-pointer list-none items-center gap-1 [&::-webkit-details-marker]:hidden">
                <Icon
                  path={ICONS.chevron}
                  className="h-2.5 w-2.5 shrink-0 text-gray-400 group-open:rotate-90"
                />
                <span className="min-w-0 flex-1 truncate">
                  <span className="font-medium text-gray-600 dark:text-gray-300">
                    {task.status === 'completed' ? 'Result' : 'Why'}:
                  </span>{' '}
                  <span className="group-open:hidden">{task.result.split('\n')[0]}</span>
                </span>
              </summary>
              <p className="mt-0.5 whitespace-pre-wrap break-words pl-3.5 text-gray-700 dark:text-gray-300">
                {task.result}
              </p>
            </details>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
