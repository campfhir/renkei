/**
 * A code chat's checkout ahead of its first turn: the project's base
 * clone (made with the acting person's grant when there is none) and the
 * chat's own worktree of it, prepared in the background the moment a
 * chat is created or opened, so the first message finds the code_* tools
 * ready rather than paying for the clone itself. A turn that arrives
 * first (lib/code/turn.ts) waits a few seconds, then — rather than
 * holding the model for minutes — registers a wake here, tells the model
 * to say so and end its turn, and when the checkout settles a note turn
 * wakes the chat the way a task wait does (lib/chat/tasks/wake.ts): the
 * person sees "Checkout ready" as a line in the thread and the model
 * carries on with what they asked.
 *
 * One preparation per chat per process (`preparations`), joined by every
 * caller; a wake is kept in this process too, and the turn that registers
 * one also joins or starts the preparation here, so the process that
 * promised the wake is the one that delivers it. A restart loses a wake,
 * and the next message does what the first turn always did.
 */

import { getPublicBaseUrl } from '@renkei/settings';
import {
  sandboxWorkspacesEnabled,
  sbWorkspaceGet,
  type WireWorkspace,
} from '@renkei/sandbox-client';
import { getProjectRow, type ProjectRow } from '@/lib/chat/projects';
import { getChatRow } from '@/lib/chat/store';
import { openNoteTurn, type OpenWakeTurn } from '@/lib/chat/tasks/wake';
import { logger } from '@/lib/logger';
import { resolveWorkspaceGitAccess } from '@/lib/sandbox/workspace-git';
import { startProjectClone, type CodeOutcome } from './projects';
import { codeProjectTarget } from './scope';
import { ensureChatWorktree } from './worktree';

/** How long a clone is waited on before it is given up on for now. */
export const CLONE_WAIT_MS = 5 * 60_000;
export const CLONE_POLL_MS = 2_000;
/** How often a wake that found the chat mid-turn tries again, and for how long. */
const WAKE_RETRY_MS = 5_000;
const WAKE_RETRY_FOR_MS = 10 * 60_000;
/** How long a chat that was just found ready is not asked about again on open. */
const READY_MEMORY_MS = 60_000;

export type Actor = { subject: string; origin?: string };
export type Chat = { id: string; workspaceId: string | null };
export type Target = ReturnType<typeof codeProjectTarget>;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The checkout once its clone has settled — polled while `cloning`, up to
 * the deadline. Null when it disappeared from the worker meanwhile;
 * still `cloning` when the deadline passed first.
 */
export async function awaitClone(
  target: Target,
  workspace: WireWorkspace,
  deadline: number
): Promise<WireWorkspace | null> {
  let current = workspace;
  while (current.status === 'cloning' && Date.now() < deadline) {
    await sleep(CLONE_POLL_MS);
    const got = await sbWorkspaceGet(target, current.id);
    if (!got.ok) return null;
    current = got.val;
  }
  return current;
}

/**
 * The project's base clone as it is: present, cloning, or — when it is
 * gone or failed — cloned again with the acting person's grant.
 */
export async function resolveBase(
  project: ProjectRow,
  actor: Actor,
  target: Target,
  options: { notId?: string } = {}
): Promise<
  (CodeOutcome<WireWorkspace> & { cloned?: boolean }) | { ok: false; status: 0; message: string }
> {
  let current: WireWorkspace | null = null;
  if (project.workspaceId && project.workspaceId !== options.notId) {
    const got = await sbWorkspaceGet(target, project.workspaceId);
    if (got.ok) current = got.val;
  }
  if (current && current.status !== 'failed') return { ok: true, val: current };
  const credential = await resolveWorkspaceGitAccess(
    {
      subject: actor.subject,
      origin: actor.origin ?? getPublicBaseUrl() ?? '',
      provider: project.repo!.provider,
    },
    { write: false }
  );
  if (typeof credential === 'string') return { ok: false, status: 0, message: credential };
  const cloned = await startProjectClone(project, credential);
  return cloned.ok ? { ok: true, val: cloned.val, cloned: true } : cloned;
}

export type CheckoutPreparation =
  | { ok: true; worktree: WireWorkspace; cloned: boolean; seconds: number }
  | { ok: false; message: string; seconds: number };

/**
 * The whole of it, once: the base clone found or started and waited on,
 * then the chat's worktree. Where the turn's own step does the same in
 * pieces, this is what runs in the background.
 */
export async function prepareChatCheckout(
  project: ProjectRow,
  chat: Chat,
  actor: Actor
): Promise<CheckoutPreparation> {
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);
  if (!project.repo) return { ok: false, message: 'the project names no repository.', seconds: 0 };
  const target = codeProjectTarget(project.id);
  const base = await resolveBase(project, actor, target);
  if (!base.ok) return { ok: false, message: base.message, seconds: seconds() };
  const settled = await awaitClone(target, base.val, started + CLONE_WAIT_MS);
  if (!settled) {
    return { ok: false, message: 'the checkout disappeared while cloning.', seconds: seconds() };
  }
  if (settled.status === 'failed') {
    return { ok: false, message: settled.error ?? 'the clone failed.', seconds: seconds() };
  }
  if (settled.status !== 'ready') {
    return {
      ok: false,
      message: `the clone is still running after ${seconds()}s.`,
      seconds: seconds(),
    };
  }
  const fresh = (await getChatRow(chat.id)) ?? chat;
  const worktree = await ensureChatWorktree(project, fresh, settled, actor);
  if (!worktree.ok) return { ok: false, message: worktree.message, seconds: seconds() };
  return {
    ok: true,
    worktree: worktree.val,
    cloned: 'cloned' in base && base.cloned === true,
    seconds: seconds(),
  };
}

interface Registry {
  preparations: Map<string, Promise<CheckoutPreparation>>;
  wakes: Map<string, { subject: string; roles: string[] }>;
  readyUntil: Map<string, number>;
}

declare global {
  var __renkeiCheckoutRegistry: Registry | undefined;
}

function registry(): Registry {
  globalThis.__renkeiCheckoutRegistry ??= {
    preparations: new Map(),
    wakes: new Map(),
    readyUntil: new Map(),
  };
  return globalThis.__renkeiCheckoutRegistry;
}

/** Test-only: forget every preparation, wake and memory. */
export function resetCheckoutRegistryForTests(): void {
  globalThis.__renkeiCheckoutRegistry = undefined;
}

/** What a woken turn is told, as the first line of the thread's note. */
export function checkoutWakeText(repoFullName: string, outcome: CheckoutPreparation): string {
  if (outcome.ok) {
    return (
      `Checkout ready: ${repoFullName} is checked out on the sandbox (${outcome.seconds}s) and this chat's worktree is on ${outcome.worktree.branch}. ` +
      'The code_* tools work now — carry on with what the person asked, without asking them again.'
    );
  }
  return (
    `Checkout not ready: ${repoFullName} could not be prepared — ${outcome.message} ` +
    'Tell the person in a sentence; the next message tries again.'
  );
}

/** Whether the chat's worktree is ready now, remembered briefly so an open does not ask the worker each time. */
async function alreadyReady(project: ProjectRow, chat: Chat): Promise<boolean> {
  const until = registry().readyUntil.get(chat.id);
  if (until !== undefined && until > Date.now()) return true;
  if (!chat.workspaceId || !project.workspaceId) return false;
  const got = await sbWorkspaceGet(codeProjectTarget(project.id), chat.workspaceId);
  const ready = got.ok && got.val.status === 'ready' && got.val.parentId === project.workspaceId;
  if (ready) registry().readyUntil.set(chat.id, Date.now() + READY_MEMORY_MS);
  return ready;
}

/**
 * Prepare a chat's checkout in the background — when the chat is created
 * or opened — unless it is ready already. Joins a preparation already
 * running for the chat in this process. When it settles, a wake left by a
 * turn that arrived first is delivered: a note turn opened as the person,
 * retried for a while if the chat is mid-turn.
 */
export function startCheckoutPreparation(input: {
  chatId: string;
  subject: string;
  origin?: string;
  /** How a woken turn is opened; the default goes through start-turn. */
  open?: OpenWakeTurn;
  /** Test-only: how long a wake waits before trying again when the chat is mid-turn. */
  retryMs?: number;
}): Promise<CheckoutPreparation | null> {
  const reg = registry();
  const running = reg.preparations.get(input.chatId);
  if (running) return running;
  const run = (async (): Promise<CheckoutPreparation | null> => {
    const chat = await getChatRow(input.chatId);
    if (!chat?.projectId) return null;
    const project = await getProjectRow(chat.projectId);
    if (!project || project.kind !== 'code' || !project.repo) return null;
    if (!(await sandboxWorkspacesEnabled())) return null;
    if (await alreadyReady(project, chat)) return null;
    const outcome = await prepareChatCheckout(project, chat, {
      subject: input.subject,
      ...(input.origin ? { origin: input.origin } : {}),
    });
    if (outcome.ok) reg.readyUntil.set(chat.id, Date.now() + READY_MEMORY_MS);
    logger.info('code chat checkout prepared ahead of its turn: {outcome}', {
      component: 'code/checkout',
      chatId: chat.id,
      projectId: project.id,
      subject: input.subject,
      outcome: outcome.ok ? `ready on ${outcome.worktree.branch}` : outcome.message,
      seconds: outcome.seconds,
    });
    const wake = reg.wakes.get(chat.id);
    if (wake) {
      reg.wakes.delete(chat.id);
      await deliverWake(chat.id, wake, checkoutWakeText(project.repo.fullName, outcome), {
        open: input.open ?? openNoteTurn,
        retryMs: input.retryMs ?? WAKE_RETRY_MS,
      });
    }
    return outcome;
  })()
    .catch((error: unknown): null => {
      logger.warn('code chat checkout preparation failed: {error}', {
        component: 'code/checkout',
        chatId: input.chatId,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    })
    .finally(() => {
      reg.preparations.delete(input.chatId);
    });
  // Joined as a preparation while it runs; a null answer (nothing to do)
  // is as good as done to a joiner.
  const nothing: CheckoutPreparation = { ok: false, message: 'nothing to prepare', seconds: 0 };
  const asPreparation = run.then((outcome) => outcome ?? nothing);
  reg.preparations.set(input.chatId, asPreparation);
  return run;
}

/**
 * A turn found the checkout not ready and ended: wake the chat with a note
 * when the preparation settles. The preparation is joined or started here,
 * in this process, which is the one holding the wake.
 */
export function registerCheckoutWake(input: {
  chatId: string;
  session: { subject: string; roles: string[] };
  origin?: string;
}): void {
  registry().wakes.set(input.chatId, input.session);
  void startCheckoutPreparation({
    chatId: input.chatId,
    subject: input.session.subject,
    ...(input.origin ? { origin: input.origin } : {}),
  });
}

/** Test-only: whether a wake is pending for the chat. */
export function hasCheckoutWake(chatId: string): boolean {
  return registry().wakes.has(chatId);
}

async function deliverWake(
  chatId: string,
  session: { subject: string; roles: string[] },
  text: string,
  options: { open: OpenWakeTurn; retryMs: number }
): Promise<void> {
  const deadline = Date.now() + WAKE_RETRY_FOR_MS;
  for (;;) {
    const opened = await options.open({ session, chatId, text });
    if (opened.ok) {
      logger.info('chat woke on its checkout', { component: 'code/checkout', chatId });
      return;
    }
    // Mid-turn (the turn that registered the wake is still answering):
    // try again shortly, for a while.
    if (!opened.running || Date.now() >= deadline) {
      logger.warn('chat could not be woken on its checkout; wake dropped', {
        component: 'code/checkout',
        chatId,
        running: opened.running,
      });
      return;
    }
    await sleep(options.retryMs);
  }
}
