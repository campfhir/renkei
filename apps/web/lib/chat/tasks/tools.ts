/**
 * The chat's task tools — built in, offered in every chat and never
 * turned off: they act only on the chat's own task list (store.ts), never
 * an organization system, so they never ask for permission, are not on
 * the Preferences page's list of tools to allow or block, and work in a
 * temporary chat and under org read-only mode alike, as chat_compact does.
 *
 *   chat_task_create    plan a task (optionally under a parent, after others)
 *   chat_task_update    progress, a note, a status, wording, dependencies
 *   chat_task_complete  finish one — completed, or failed — with its result
 *   chat_task_cancel    drop one (its open subtasks with it)
 *   chat_task_list      the plan as a tree
 *   chat_task_get       one task in full, result included
 *   chat_task_delete    remove one and its subtree
 *   chat_task_wait      suspend: end this turn, wake when tasks finish
 *
 * A sub-agent gets all but chat_task_wait (`subagentTaskTools`): it
 * reports progress on the task it was given, records its steps as
 * subtasks, and its report completes the task (chat-delegate.ts).
 *
 * The runner treats them as reads (`readOnly`) only in the sense that
 * matters to it: they never ask and may run beside other calls.
 */

import {
  END_TURN_META,
  errorResult,
  textResult,
  type LocalTool,
  type LocalToolContext,
} from '../local-tools';
import {
  WAIT_EVENTS,
  findTask,
  isFinished,
  isTaskStatus,
  taskDetail,
  taskLine,
  taskRef,
  taskTree,
  tasksMarkdown,
  waitFiring,
  wakeNoteText,
  dependentsOf,
  type ChatTaskView,
  type WaitEvent,
} from './graph';
import { changeTask, createTask, deleteTask, listTasks, type TaskOutcome } from './store';
import {
  WAIT_DEFAULT_SECONDS,
  WAIT_MAX_SECONDS,
  cancelTaskWait,
  suspendOnTasks,
  wakeSoon,
} from './wake';

export const TASK_TOOL_NAMES = {
  create: 'chat_task_create',
  update: 'chat_task_update',
  complete: 'chat_task_complete',
  cancel: 'chat_task_cancel',
  list: 'chat_task_list',
  get: 'chat_task_get',
  delete: 'chat_task_delete',
  wait: 'chat_task_wait',
} as const;

/** Whether a tool is one of these — the thread and the delegate tell them apart by name. */
export function isTaskTool(name: string): boolean {
  return Object.values(TASK_TOOL_NAMES).some((tool) => tool === name);
}

const TASK_REF_SCHEMA = {
  type: ['string', 'integer'],
  description: 'The task: its number (3 or "#3") or its id.',
};
const REF_LIST_SCHEMA = {
  type: 'array',
  items: { type: ['string', 'integer'] },
};

const now = () => new Date();

/** After a change: the task's line, what it unblocked, and a ping to any wait. */
function changed(outcome: TaskOutcome, context: LocalToolContext, verb: string) {
  if (!outcome.ok) return errorResult(outcome.reason);
  if (outcome.finished.length > 0) wakeSoon(context.chatId);
  const unblocked =
    outcome.task.status === 'completed'
      ? dependentsOf(outcome.task, outcome.tasks).filter(
          (dependent) =>
            !outcome.tasks.some(
              (other) => dependent.dependsOn.includes(other.id) && other.status !== 'completed'
            )
        )
      : [];
  const cascaded = outcome.finished.filter((task) => task.id !== outcome.task.id);
  return textResult(
    [
      `${verb} ${taskLine(outcome.task, outcome.tasks)}`,
      ...(cascaded.length > 0
        ? [`Also cancelled its open subtasks: ${cascaded.map(taskRef).join(', ')}.`]
        : []),
      ...(unblocked.length > 0
        ? [
            `Now ready to start: ${unblocked.map((task) => taskLine(task, outcome.tasks)).join('; ')}.`,
          ]
        : []),
    ].join('\n'),
    { taskId: outcome.task.id }
  );
}

function createTool(): LocalTool {
  return {
    def: {
      name: TASK_TOOL_NAMES.create,
      description:
        'Add a task to this chat’s task list — the plan you keep for work that takes several steps, so you and any sub-agents know what is done, what is under way and what must wait. ' +
        'Use `parent` to make it a subtask, `depends_on` for tasks that must be completed before it can start, `subtasks` to add its steps at once. ' +
        'The person can open the list from the chat’s menu. Tasks are numbered (#1, #2…); refer to them by number.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'A short imperative title: “Draft the summary”.' },
          detail: {
            type: 'string',
            description: 'What done looks like, and anything to remember.',
          },
          parent: { ...TASK_REF_SCHEMA, description: 'Make it a subtask of this task.' },
          depends_on: {
            ...REF_LIST_SCHEMA,
            description: 'Tasks (numbers or ids) that must be completed before this one starts.',
          },
          subtasks: {
            type: 'array',
            items: { type: 'string' },
            description: 'Titles of subtasks to create under it, in order.',
          },
          start: { type: 'boolean', description: 'Mark it in progress at once.' },
        },
        required: ['title'],
      },
    },
    readOnly: true,
    async execute(input, context) {
      const createdBy = context.taskActor ?? 'assistant';
      const made = await createTask(
        context.chatId,
        context.cipher,
        {
          title: input.title,
          detail: input.detail,
          parent: input.parent,
          dependsOn: input.depends_on,
          start: input.start === true,
          createdBy,
        },
        now()
      );
      if (!made.ok) return errorResult(made.reason);
      const lines = [`Created ${taskLine(made.task, made.tasks)}`];
      const titles = Array.isArray(input.subtasks)
        ? input.subtasks.filter((t): t is string => typeof t === 'string' && t.trim() !== '')
        : [];
      for (const title of titles.slice(0, 50)) {
        const sub = await createTask(
          context.chatId,
          context.cipher,
          { title, parent: made.task.id, createdBy },
          now()
        );
        if (!sub.ok) {
          lines.push(`Subtask “${title}” not created: ${sub.reason}`);
          continue;
        }
        lines.push(`  - ${taskLine(sub.task, sub.tasks)}`);
      }
      return textResult(lines.join('\n'), { taskId: made.task.id });
    },
  };
}

function updateTool(): LocalTool {
  return {
    def: {
      name: TASK_TOOL_NAMES.update,
      description:
        'Update a task: report progress (`progress` 0–100 and a short `note`), set its `status` — "in_progress" when you start it (refused until its dependencies are completed), "waiting" when it is held up on something outside the plan, "pending" to put it back — or change its title, detail or dependencies. ' +
        'Finish a task with chat_task_complete and drop one with chat_task_cancel.',
      inputSchema: {
        type: 'object',
        properties: {
          task: TASK_REF_SCHEMA,
          status: { type: 'string', enum: ['pending', 'in_progress', 'waiting'] },
          progress: { type: 'integer', minimum: 0, maximum: 100 },
          note: { type: 'string', description: 'Where it stands, in a sentence.' },
          title: { type: 'string' },
          detail: { type: 'string' },
          depends_on: { ...REF_LIST_SCHEMA, description: 'Replaces its dependencies.' },
        },
        required: ['task'],
      },
    },
    readOnly: true,
    async execute(input, context) {
      const status = input.status;
      if (
        status !== undefined &&
        status !== 'pending' &&
        status !== 'in_progress' &&
        status !== 'waiting'
      )
        return errorResult(
          'status here is pending, in_progress or waiting; use chat_task_complete or chat_task_cancel to finish a task.'
        );
      return changed(
        await changeTask(
          context.chatId,
          context.cipher,
          input.task,
          {
            ...(isTaskStatus(status) ? { status } : {}),
            ...(input.progress !== undefined
              ? { progress: typeof input.progress === 'number' ? input.progress : null }
              : {}),
            ...(input.note !== undefined ? { progressNote: input.note } : {}),
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.detail !== undefined ? { detail: input.detail } : {}),
            ...(input.depends_on !== undefined ? { dependsOn: input.depends_on } : {}),
          },
          now()
        ),
        context,
        'Updated'
      );
    },
  };
}

function completeTool(): LocalTool {
  return {
    def: {
      name: TASK_TOOL_NAMES.complete,
      description:
        'Finish a task with what it came to. `outcome` "completed" (the default) when it is done — refused while any of its subtasks is still open; "failed" when it cannot be done, saying why in `result`. ' +
        'A chat suspended on its tasks wakes when they finish.',
      inputSchema: {
        type: 'object',
        properties: {
          task: TASK_REF_SCHEMA,
          result: {
            type: 'string',
            description: 'What it came to: the answer, what changed, or why it failed.',
          },
          outcome: { type: 'string', enum: ['completed', 'failed'] },
        },
        required: ['task'],
      },
    },
    readOnly: true,
    async execute(input, context) {
      const status = input.outcome === 'failed' ? 'failed' : 'completed';
      return changed(
        await changeTask(
          context.chatId,
          context.cipher,
          input.task,
          { status, ...(input.result !== undefined ? { result: input.result } : {}) },
          now()
        ),
        context,
        status === 'failed' ? 'Failed' : 'Completed'
      );
    },
  };
}

function cancelTool(): LocalTool {
  return {
    def: {
      name: TASK_TOOL_NAMES.cancel,
      description:
        'Cancel a task that no longer needs doing, with its open subtasks. It stays on the list as cancelled; use chat_task_delete to remove it altogether.',
      inputSchema: {
        type: 'object',
        properties: {
          task: TASK_REF_SCHEMA,
          reason: { type: 'string', description: 'Why it was dropped.' },
        },
        required: ['task'],
      },
    },
    readOnly: true,
    async execute(input, context) {
      return changed(
        await changeTask(
          context.chatId,
          context.cipher,
          input.task,
          { status: 'cancelled', ...(input.reason !== undefined ? { result: input.reason } : {}) },
          now()
        ),
        context,
        'Cancelled'
      );
    },
  };
}

function listTool(): LocalTool {
  return {
    def: {
      name: TASK_TOOL_NAMES.list,
      description:
        'This chat’s task list as a tree: each task’s number, state (to do, in progress, waiting, blocked on dependencies, completed, failed, cancelled), progress and dependencies. ' +
        '`format` "markdown" gives the checklist the person sees when they export it — use it when they ask for the tasks as Markdown.',
      inputSchema: {
        type: 'object',
        properties: {
          open_only: { type: 'boolean', description: 'Leave out finished tasks.' },
          format: { type: 'string', enum: ['tree', 'markdown'] },
        },
      },
    },
    readOnly: true,
    async execute(input, context) {
      const all = await listTasks(context.chatId, context.cipher);
      const tasks =
        input.open_only === true
          ? all.filter(
              (task) =>
                !isFinished(task.status) ||
                all.some((other) => other.parentId === task.id && !isFinished(other.status))
            )
          : all;
      if (input.format === 'markdown') return textResult(tasksMarkdown(tasks, { results: true }));
      return textResult(taskTree(tasks));
    },
  };
}

function getTool(): LocalTool {
  return {
    def: {
      name: TASK_TOOL_NAMES.get,
      description:
        'One task in full: its detail, dependencies, subtasks, latest progress note and result.',
      inputSchema: {
        type: 'object',
        properties: { task: TASK_REF_SCHEMA },
        required: ['task'],
      },
    },
    readOnly: true,
    async execute(input, context) {
      const tasks = await listTasks(context.chatId, context.cipher);
      const task = findTask(tasks, input.task);
      if (!task) return errorResult(`No task ${String(input.task)} in this chat.`);
      return textResult(taskDetail(task, tasks));
    },
  };
}

function deleteTool(): LocalTool {
  return {
    def: {
      name: TASK_TOOL_NAMES.delete,
      description:
        'Remove a task and its subtasks from the list altogether (other tasks stop depending on them). To record that something will not be done, cancel it instead.',
      inputSchema: {
        type: 'object',
        properties: { task: TASK_REF_SCHEMA },
        required: ['task'],
      },
    },
    readOnly: true,
    async execute(input, context) {
      const deleted = await deleteTask(context.chatId, context.cipher, input.task);
      if (!deleted.ok) return errorResult(deleted.reason);
      // A wait on these tasks now watches nothing: it fires as 'gone'.
      wakeSoon(context.chatId);
      return textResult(`Deleted ${deleted.deleted.map(taskRef).join(', ')}.`);
    },
  };
}

function eventsOf(value: unknown): WaitEvent[] | null {
  if (value === undefined) return [...WAIT_EVENTS];
  if (!Array.isArray(value)) return null;
  const events = WAIT_EVENTS.filter((event) => value.includes(event));
  return events.length > 0 ? events : null;
}

function waitTool(): LocalTool {
  return {
    def: {
      name: TASK_TOOL_NAMES.wait,
      description:
        'Suspend: end this reply now and be woken when tasks finish — like registering an event listener. Use it when the remaining work is happening elsewhere (a background sub-agent started with chat_delegate and `background`, or the person) and there is nothing useful to do until it lands. ' +
        'You are woken with a note naming each watched task and its result: by default when ALL of them have finished, or at once if one fails or is cancelled; `until` "any" wakes on the first that finishes with one of the `wake_on` outcomes. `timeout_minutes` (default 30, at most 1440) wakes you anyway. ' +
        'If the tasks have already finished it answers at once instead. Say briefly to the person what you are waiting for before calling it; it must be your last call in the reply. `cancel` true removes the wait without waking.',
      inputSchema: {
        type: 'object',
        properties: {
          tasks: {
            ...REF_LIST_SCHEMA,
            description: 'The tasks to watch; default every open task.',
          },
          until: { type: 'string', enum: ['all', 'any'] },
          wake_on: {
            type: 'array',
            items: { type: 'string', enum: [...WAIT_EVENTS] },
            description: 'The finishes that wake you (default all three).',
          },
          timeout_minutes: { type: 'number', minimum: 1, maximum: WAIT_MAX_SECONDS / 60 },
          cancel: { type: 'boolean' },
        },
      },
    },
    readOnly: true,
    async execute(input, context) {
      if (input.cancel === true) {
        return textResult(
          (await cancelTaskWait(context.chatId)) ? 'Wait removed.' : 'This chat was not waiting.'
        );
      }
      const tasks = await listTasks(context.chatId, context.cipher);
      let watched: ChatTaskView[];
      if (input.tasks === undefined) {
        watched = tasks.filter((task) => !isFinished(task.status));
        if (watched.length === 0) return errorResult('No open tasks to wait on.');
      } else {
        const list = Array.isArray(input.tasks) ? input.tasks : [input.tasks];
        watched = [];
        for (const ref of list) {
          const task = findTask(tasks, ref);
          if (!task) return errorResult(`No task ${String(ref)} in this chat.`);
          if (!watched.includes(task)) watched.push(task);
        }
        if (watched.length === 0) return errorResult('Name at least one task to wait on.');
      }
      const events = eventsOf(input.wake_on);
      if (!events) return errorResult('wake_on lists completed, failed or cancelled.');
      const mode = input.until === 'any' ? 'any' : 'all';
      const minutes =
        typeof input.timeout_minutes === 'number' && Number.isFinite(input.timeout_minutes)
          ? input.timeout_minutes
          : WAIT_DEFAULT_SECONDS / 60;
      const timeoutSeconds = Math.round(Math.max(60, Math.min(WAIT_MAX_SECONDS, minutes * 60)));
      const at = now();
      const ready = waitFiring(
        { taskIds: watched.map((task) => task.id), events, mode, deadlineAt: null },
        tasks,
        at
      );
      if (ready)
        return textResult(`${wakeNoteText(ready, tasks)}\n(Nothing to wait for — not suspended.)`);
      await suspendOnTasks({
        chatId: context.chatId,
        taskIds: watched.map((task) => task.id),
        events,
        mode,
        timeoutSeconds,
        session: { subject: context.subject, roles: context.roles ?? [] },
        now: at,
      });
      return textResult(
        `Suspended until ${mode === 'all' ? 'all of' : 'any of'} ${watched
          .map(taskRef)
          .join(
            ', '
          )} finish (${events.join(', ')}), or ${Math.round(timeoutSeconds / 60)} minutes pass. This reply ends here; you will be woken with a note.`,
        { [END_TURN_META]: true }
      );
    },
  };
}

/** Every task tool, for the chat's own turn. */
export function taskTools(): LocalTool[] {
  return [
    createTool(),
    updateTool(),
    completeTool(),
    cancelTool(),
    listTool(),
    getTool(),
    deleteTool(),
    waitTool(),
  ];
}

/** What a sub-agent gets: all but chat_task_wait — a sub-agent has no turn to suspend. */
export function subagentTaskTools(): LocalTool[] {
  return taskTools().filter((tool) => tool.def.name !== TASK_TOOL_NAMES.wait);
}
