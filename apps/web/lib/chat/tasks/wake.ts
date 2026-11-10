/**
 * Suspending a chat on its tasks, and waking it.
 *
 * `chat_task_wait` (tools.ts) ends the model's turn and leaves one wait on
 * the chat (`chat_task_waits`): which tasks it watches, which finishes
 * wake it, whether any or all must finish, and when it gives up. The chat
 * is then idle — no turn running, nothing spent — like an event listener
 * registered and left. Whatever finishes a task (a background sub-agent
 * reporting, the person completing or cancelling one in the tasks dialog,
 * another tool call) calls `wakeIfReady`, and the deadline is kept by a
 * timer in this process plus the turn-recovery sweep on every web process
 * (turn-recovery.ts), so a restart loses no timeout.
 *
 * Firing claims the wait (the store's clearWait: of two that race, one
 * wins) and opens a turn the way a preview card's decision does
 * (widget-tools.ts): a note row — the person sees "Task wait finished: …"
 * as a line in the thread — that is also the user row of a new turn, run
 * as the chat's owner with the roles they had when the chat suspended. A
 * chat whose turn is still running when its wait fires keeps the wait;
 * that turn's end looks again (start-turn.ts).
 */

import { getDataStore, type ChatTaskWaitRecord } from '@renkei/db';
import { logger } from '@/lib/logger';
import { whoIs } from '@/lib/log-actor';
import { chatCipherById } from '../chat-keys';
import { waitFiring, wakeNoteText, type TaskWaitView, type WaitEvent } from './graph';
import { listTasks } from './store';

/** The longest a wait may stand before it times out. */
export const WAIT_MAX_SECONDS = 24 * 60 * 60;
/** A wait's timeout when the model names none. */
export const WAIT_DEFAULT_SECONDS = 30 * 60;
const DUE_BATCH = 50;

export function waitViewOf(wait: ChatTaskWaitRecord): TaskWaitView {
  return {
    taskIds: wait.taskIds,
    events: wait.events,
    mode: wait.mode,
    deadlineAt: wait.deadlineAt?.toISOString() ?? null,
  };
}

export async function getTaskWait(chatId: string): Promise<TaskWaitView | null> {
  const wait = await getDataStore().chatTasks.getWait(chatId);
  return wait ? waitViewOf(wait) : null;
}

/** How a woken turn is opened — start-turn.ts's startChatTurn, or a fake in tests. */
export type OpenWakeTurn = (input: {
  session: { subject: string; roles: string[] };
  chatId: string;
  text: string;
}) => Promise<{ ok: true } | { ok: false; running: boolean }>;

/**
 * A note turn opened as the person — a task wait firing, or a code chat's
 * checkout becoming ready (lib/code/checkout.ts): the text is a line in the
 * thread and the user row of a new turn.
 */
export const openNoteTurn: OpenWakeTurn = async (input) => {
  // Imported when first needed: start-turn imports the chat's tools, and they import this.
  const { startChatTurn } = await import('../start-turn');
  const started = await startChatTurn({
    ...input,
    kind: 'note',
    // A wake fires from background work (a sub-agent's report, a timer, the
    // sweep) as often as from a request, so the turn runs on its own rather
    // than through Next's after(), which needs a request around it — the
    // way a resumed turn runs (turn-recovery.ts).
    defer: (task) => {
      void task().catch(async (error: unknown) =>
        logger.error(
          "the turn that woke {actor}'s chat crashed; the chat shows no answer to the wake: {error}",
          {
            component: 'chat/tasks',
            ...(await whoIs(input.session.subject)),
            chatId: input.chatId,
            error: error instanceof Error ? error.message : String(error),
          }
        )
      );
    },
  });
  if (started.ok) return { ok: true };
  return { ok: false, running: started.err.type === 'ALREADY_RUNNING' };
};

declare global {
  var __renkeiTaskWaitTimers: Map<string, ReturnType<typeof setTimeout>> | undefined;
}

function timers(): Map<string, ReturnType<typeof setTimeout>> {
  globalThis.__renkeiTaskWaitTimers ??= new Map();
  return globalThis.__renkeiTaskWaitTimers;
}

function clearTimer(chatId: string): void {
  const timer = timers().get(chatId);
  if (timer) clearTimeout(timer);
  timers().delete(chatId);
}

/** Look again when the deadline comes, in this process; the sweep covers a restart. */
function scheduleTimer(chatId: string, subject: string, deadlineAt: Date | null, now: Date): void {
  clearTimer(chatId);
  if (!deadlineAt) return;
  const delay = Math.max(0, deadlineAt.getTime() - now.getTime()) + 250;
  const timer = setTimeout(() => {
    timers().delete(chatId);
    void wakeIfReady(chatId).catch(async (error: unknown) =>
      logger.warn(
        "the task-wait deadline of {actor}'s chat came, but the chat could not be checked; the sweep will look again: {error}",
        {
          component: 'chat/tasks',
          ...(await whoIs(subject)),
          chatId,
          error: error instanceof Error ? error.message : String(error),
        }
      )
    );
  }, delay);
  timer.unref?.();
  timers().set(chatId, timer);
}

/** Suspend the chat on these tasks, replacing any wait it had. */
export async function suspendOnTasks(input: {
  chatId: string;
  taskIds: string[];
  events: WaitEvent[];
  mode: 'any' | 'all';
  timeoutSeconds: number;
  session: { subject: string; roles: string[] };
  now: Date;
}): Promise<TaskWaitView> {
  const deadlineAt = new Date(input.now.getTime() + input.timeoutSeconds * 1000);
  const wait = await getDataStore().chatTasks.putWait({
    chatId: input.chatId,
    taskIds: input.taskIds,
    events: input.events,
    mode: input.mode,
    deadlineAt,
    subject: input.session.subject,
    roles: input.session.roles,
  });
  scheduleTimer(input.chatId, input.session.subject, deadlineAt, input.now);
  return waitViewOf(wait);
}

/** Take the chat off its wait without waking it (the model or the person called it off). */
export async function cancelTaskWait(chatId: string): Promise<boolean> {
  clearTimer(chatId);
  return getDataStore().chatTasks.clearWait(chatId);
}

/**
 * Fire the chat's wait if it is ready: true when a woken turn was opened.
 * A wait whose chat is mid-turn stays for that turn's end to look again;
 * one whose turn cannot open for any other reason (no model) is spent,
 * its note left out — the person sees the tasks in the dialog either way.
 */
export async function wakeIfReady(
  chatId: string,
  options: { now?: Date; open?: OpenWakeTurn } = {}
): Promise<boolean> {
  const store = getDataStore().chatTasks;
  const wait = await store.getWait(chatId);
  if (!wait) return false;
  const now = options.now ?? new Date();
  const cipher = await chatCipherById(chatId);
  const tasks = await listTasks(chatId, cipher);
  const firing = waitFiring(waitViewOf(wait), tasks, now);
  if (!firing) {
    if (!timers().has(chatId)) scheduleTimer(chatId, wait.subject, wait.deadlineAt, now);
    return false;
  }
  if (!(await store.clearWait(chatId))) return false;
  clearTimer(chatId);
  const open = options.open ?? openNoteTurn;
  const opened = await open({
    session: { subject: wait.subject, roles: wait.roles },
    chatId,
    text: wakeNoteText(firing, tasks),
  });
  if (opened.ok) {
    logger.info("{actor}'s chat woke on its tasks ({reason}); a note turn was opened", {
      component: 'chat/tasks',
      ...(await whoIs(wait.subject)),
      chatId,
      reason: firing.reason,
    });
    return true;
  }
  if (opened.running) {
    // Put back as it was; the running turn's end looks again.
    await store.putWait({
      chatId,
      taskIds: wait.taskIds,
      events: wait.events,
      mode: wait.mode,
      deadlineAt: wait.deadlineAt,
      subject: wait.subject,
      roles: wait.roles,
    });
    return false;
  }
  logger.warn(
    "{actor}'s chat could not be woken on its tasks ({reason}); the wait was dropped and the chat will not be told",
    {
      component: 'chat/tasks',
      ...(await whoIs(wait.subject)),
      chatId,
      reason: firing.reason,
    }
  );
  return false;
}

/** wakeIfReady that logs rather than throws: for callers that must not fail on it. */
export function wakeSoon(chatId: string): void {
  void wakeIfReady(chatId).catch((error: unknown) =>
    logger.warn(
      "a chat's task wait could not be checked after a task changed; the sweep will look again: {error}",
      {
        component: 'chat/tasks',
        chatId,
        error: error instanceof Error ? error.message : String(error),
      }
    )
  );
}

/** The sweep's half: every wait past its deadline, fired. How many woke. */
export async function fireDueTaskWaits(now = new Date()): Promise<number> {
  const due = await getDataStore().chatTasks.listDueWaits(now, DUE_BATCH);
  let woke = 0;
  for (const wait of due) {
    if (await wakeIfReady(wait.chatId, { now })) woke += 1;
  }
  return woke;
}
