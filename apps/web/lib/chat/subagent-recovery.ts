/**
 * Sub-agents that lost their process.
 *
 * A background sub-agent (subagent-tasks.ts) works on after the turn that
 * started it has ended, so when its process dies — a deploy, a crash —
 * no turn is left for the turn recovery to pick up: its run would read
 * "working" and its task "in progress" for good. A working sub-agent
 * touches its run row every few seconds (subagent.ts); one that has not
 * been touched for a while, under a turn that is no longer running, has
 * no process. The sweep on every web process (turn-recovery.ts, from its
 * first pass at start-up) ends such a run as interrupted and fails the
 * task it was working, which wakes a chat suspended on it — the
 * assistant is told, and can start the work again. Nothing is resumed: a
 * sub-agent's conversation lived in the process that died.
 */

import { getDataStore } from '@renkei/db';
import { isRecord } from '@renkei/guards';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';
import { cipherAsOwner } from './chat-keys';
import { listTurnMessages } from './messages';
import { getChatRow } from './store';
import { findTask, isFinished } from './tasks/graph';
import { changeTask, listTasks } from './tasks/store';
import { wakeSoon } from './tasks/wake';

/**
 * A run not touched for this long has no process: several heartbeats
 * (SUBAGENT_HEARTBEAT_MS) missed, so a slow database write is not a death.
 */
export const SUBAGENT_IDLE_SECONDS = 120;

export const SUBAGENT_LOST_ERROR = 'The service restarted while this sub-agent was working.';

export const SUBAGENT_LOST_TASK_RESULT =
  'The service restarted while a sub-agent was working this task, and its work in progress was lost with it. What it had committed is still on its branch; start the task again to finish it.';

/**
 * One pass: end the runs with no process, and fail the task each was
 * working. Returns how many runs were ended, for the log and the tests.
 */
export async function interruptLostSubagentRuns(now: Date = new Date()): Promise<number> {
  const lost = await getDataStore().chatThreads.interruptIdleSubagentRuns(
    new Date(now.getTime() - SUBAGENT_IDLE_SECONDS * 1000),
    SUBAGENT_LOST_ERROR
  );
  for (const run of lost) {
    const chat = await getChatRow(run.chatId);
    const failedTask = chat ? await failTaskOf(chat, run) : false;
    logger.warn(
      failedTask
        ? "a sub-agent of {actor}'s chat lost its process and was marked interrupted; its task was marked failed and the chat is told"
        : "a sub-agent of {actor}'s chat lost its process and was marked interrupted; it was working no open task, so nothing else changed",
      {
        component: 'chat/subagent-recovery',
        ...(await whoIs(chat?.ownerSubject)),
        chatId: run.chatId,
        turnId: run.turnId,
        toolUseId: run.toolUseId,
      }
    );
  }
  return lost.length;
}

/**
 * The task the lost run was working, failed. The run does not name its
 * task; the delegating call does, in the turn's own rows (`task_id`).
 */
async function failTaskOf(
  chat: NonNullable<Awaited<ReturnType<typeof getChatRow>>>,
  run: { chatId: string; turnId: string; toolUseId: string }
): Promise<boolean> {
  const cipher = await cipherAsOwner('chat', chat);
  const rows = await listTurnMessages(run.turnId, cipher);
  let ref: unknown;
  for (const row of rows) {
    for (const block of row.blocks) {
      if (block.type === 'tool_use' && block.id === run.toolUseId && isRecord(block.input)) {
        ref = block.input.task_id;
      }
    }
  }
  if (ref === undefined || ref === null || ref === '') return false;
  const tasks = await listTasks(run.chatId, cipher);
  const task = findTask(tasks, ref);
  if (!task || isFinished(task.status)) return false;
  const failed = await changeTask(
    run.chatId,
    cipher,
    task.id,
    { status: 'failed', result: SUBAGENT_LOST_TASK_RESULT },
    new Date()
  );
  // A chat suspended on the task hears of it now.
  wakeSoon(run.chatId);
  return failed.ok;
}
