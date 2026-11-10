/**
 * A sub-agent that works a task of the chat's task list, shared by
 * `chat_delegate` (chat-delegate.ts) and a code project's `code_delegate`
 * (lib/code/delegate.ts): the task goes in progress when the sub-agent
 * starts, its report completes the task (or fails it), and — in the
 * background — the delegating call answers at once while the sub-agent
 * works on, so the assistant's own calls carry on and, once it suspends
 * on `chat_task_wait` (tasks/wake.ts), the chat is idle for the person to
 * write in. A background sub-agent ends with the process's shutdown, or
 * when its task is finished from elsewhere: cancelling the task in the
 * tasks dialog is how a person stops one.
 */

import type { McpToolResult } from '@renkei/mcp-client';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';
import { onShutdown } from '@/lib/shutdown';
import { errorResult, textResult, type LocalToolContext } from './local-tools';
import { descendantsOf, findTask, isFinished, taskRef, type ChatTaskView } from './tasks/graph';
import { changeTask, listTasks } from './tasks/store';
import { wakeSoon } from './tasks/wake';

/** Where a sub-agent's answer turns from the run's counts to its report (subagent.ts). */
const REPORT_MARKER = '\n\nReport:\n';

/** How often a background sub-agent looks at whether its task was finished under it. */
export const TASK_CANCEL_POLL_MS = 10_000;

/** What a sub-agent working a task is told about it; `besides` names what else it does. */
export function taskNote(task: ChatTaskView, besides = 'Besides reading'): string {
  return `You are working task ${taskRef(task)} of the assistant's task list: “${task.title}”${
    task.detail ? ` (${task.detail})` : ''
  }. ${besides}, you may keep that list: record the steps you take as subtasks of ${taskRef(
    task
  )} (chat_task_create with parent ${task.number}), report progress on it with chat_task_update, and complete or fail your subtasks as you go. Your final report completes ${taskRef(
    task
  )} on its own; if the task cannot be done, say so plainly in the report and it is marked failed.`;
}

/** Whether a delegating call named a task at all. */
export function namesTask(ref: unknown): boolean {
  return ref !== undefined && ref !== null && ref !== '';
}

/**
 * The task a sub-agent is to work: it must be open and free to start, and
 * it goes in progress now.
 */
export async function startLinkedTask(
  context: LocalToolContext,
  ref: unknown
): Promise<{ ok: true; task: ChatTaskView } | { ok: false; error: McpToolResult }> {
  const tasks = await listTasks(context.chatId, context.cipher);
  const found = findTask(tasks, ref);
  if (!found) return { ok: false, error: errorResult(`No task ${String(ref)} in this chat.`) };
  if (isFinished(found.status)) {
    return { ok: false, error: errorResult(`${taskRef(found)} is already ${found.status}.`) };
  }
  const started = await changeTask(
    context.chatId,
    context.cipher,
    found.id,
    { status: 'in_progress' },
    new Date()
  );
  return started.ok
    ? { ok: true, task: started.task }
    : { ok: false, error: errorResult(started.reason) };
}

/**
 * The sub-agent reported (or failed): its task completes with the report,
 * or fails with the reason — unless it was finished meanwhile (the
 * sub-agent's own call, the person's cancel). Then any wait looks again.
 */
export async function settleLinkedTask(
  context: LocalToolContext,
  taskId: string,
  outcome: McpToolResult
): Promise<void> {
  const tasks = await listTasks(context.chatId, context.cipher);
  const task = tasks.find((t) => t.id === taskId);
  if (task && !isFinished(task.status)) {
    const said = outcome.content
      .flatMap((block) => (block.type === 'text' ? [block.text] : []))
      .join('\n');
    // The task keeps the report itself, not the run's counts above it (subagent.ts's report()).
    const marker = said.indexOf(REPORT_MARKER);
    const report = (marker >= 0 ? said.slice(marker + REPORT_MARKER.length) : said).trim();
    // Subtasks the sub-agent left open would refuse the completion: they end with it.
    for (const sub of descendantsOf(taskId, tasks).filter((t) => !isFinished(t.status))) {
      await changeTask(context.chatId, context.cipher, sub.id, { status: 'cancelled' }, new Date());
    }
    const settled = await changeTask(
      context.chatId,
      context.cipher,
      taskId,
      {
        status: outcome.isError ? 'failed' : 'completed',
        result:
          report || (outcome.isError ? 'The sub-agent failed.' : 'The sub-agent reported nothing.'),
      },
      new Date()
    );
    if (!settled.ok) {
      logger.warn(
        "a sub-agent of {actor}'s chat finished, but its task could not be marked {status} ({reason}); the task stays open",
        {
          component: 'chat/delegate',
          ...(await whoIs(context.subject)),
          chatId: context.chatId,
          taskId,
          status: outcome.isError ? 'failed' : 'completed',
          reason: settled.reason,
        }
      );
    }
  }
  wakeSoon(context.chatId);
}

/**
 * Run a sub-agent on its task in the background and answer at once: the
 * turn may go on, or end (and suspend on chat_task_wait), while it works.
 * Its stop is the process's shutdown or its task being finished under it
 * (cancelled by the person), never the turn's Stop; the turn's tool
 * surface is held open until it is done.
 */
export function startInBackground(
  context: LocalToolContext,
  linked: ChatTaskView,
  go: (context: LocalToolContext) => Promise<McpToolResult>,
  pollMs: number = TASK_CANCEL_POLL_MS
): McpToolResult {
  const taskId = linked.id;
  const stop = new AbortController();
  const unsubscribe = onShutdown(() => stop.abort());
  const release = context.holdTurn?.() ?? (() => {});
  const watch = setInterval(() => {
    void listTasks(context.chatId, context.cipher)
      .then((tasks) => {
        const task = tasks.find((t) => t.id === taskId);
        if (!task || isFinished(task.status)) stop.abort();
      })
      .catch(() => {});
  }, pollMs);
  watch.unref?.();
  void go({ ...context, signal: stop.signal })
    .then((outcome) => settleLinkedTask(context, taskId, outcome))
    .catch(async (error: unknown) => {
      logger.warn(
        "a background sub-agent of {actor}'s chat stopped unexpectedly; its task is marked failed: {error}",
        {
          component: 'chat/delegate',
          ...(await whoIs(context.subject)),
          chatId: context.chatId,
          taskId,
          error: error instanceof Error ? error.message : String(error),
        }
      );
      await settleLinkedTask(context, taskId, errorResult('The sub-agent stopped unexpectedly.'));
    })
    .catch(() => {})
    .finally(() => {
      clearInterval(watch);
      unsubscribe();
      release();
    });
  return textResult(
    `Started a background sub-agent on ${taskRef(linked)} “${linked.title}”. It completes the task when it reports. ` +
      'Carry on with other work, or call chat_task_wait to suspend until it finishes.',
    { taskId }
  );
}
