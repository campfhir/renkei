/**
 * What a chat turn inside a code project gets: the code_* tools bound to
 * the project's checkout, and what the system prompt says about the
 * repository. Asked once per turn, because the checkout's state lives on
 * the sandbox worker — and because the checkout is made here: nothing is
 * cloned when a project is created; the first turn that needs it clones
 * the repository with the chatting person's own grant on the project's
 * git host and hands the turn a step that waits for it — shown in the chat like a
 * tool call, "Cloning the repository", right after the prompt — so the
 * tools are usable by the time the model speaks. A checkout the worker's
 * sweep retired, or whose clone failed, is cloned again the same way.
 *
 * The tools never work in that clone itself: it is the project's base,
 * left alone. Each chat works in a git worktree of it, made here on the
 * chat's first turn (`startChatWorktree`, lib/code/projects.ts) and
 * recorded on the chat, so chats in one project run at the same time
 * without seeing each other's files or branch switches. A new project's
 * first turn waits for the clone, then makes the worktree, in the same
 * step.
 *
 * A checkout can also go mid-turn — the worker's volume replaced, its row
 * retired, another chat's clone replacing it. The tools are handed a way
 * back (`recover`, lib/code/tools.ts): re-read the project, adopt a newer
 * clone if one is there, otherwise clone again with the same grant, make
 * the chat's worktree in it, wait as the first step would, and let the
 * call that hit the wall run again.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getPublicBaseUrl } from '@renkei/settings';
import {
  sandboxServicesEnabled,
  sandboxWorkspacesEnabled,
  sbEnvList,
  sbWorkspaceGet,
  type WireWorkspace,
} from '@renkei/sandbox-client';
import { errorResult, textResult, type LocalTool } from '@/lib/chat/local-tools';
import { listChatModels } from '@/lib/chat/models';
import { getProjectRow, type ProjectRow } from '@/lib/chat/projects';
import { getChatRow } from '@/lib/chat/store';
import type { PreludeStep, TurnLimits } from '@/lib/chat/turn-runner';
import { resolveWorkspaceGitAccess } from '@/lib/sandbox/workspace-git';
import { startProjectClone, type CodeOutcome } from './projects';
import { ensureChatWorktree } from './worktree';
import { codeProjectTarget } from './scope';
import { codeTools, type CheckoutRecovery } from './tools';

/** How long the clone step waits before giving up on the tools for this turn. */
export const CLONE_WAIT_MS = 5 * 60_000;
const CLONE_POLL_MS = 2_000;
/** The name the clone step carries in the transcript, beside the code_* tools. */
export const CLONE_STEP_NAME = 'code_clone';

function bytes(value: number): string {
  if (value < 1_048_576) return `${Math.max(1, Math.round(value / 1024))} KB`;
  if (value < 1_073_741_824) return `${(value / 1_048_576).toFixed(1)} MB`;
  return `${(value / 1_073_741_824).toFixed(2)} GB`;
}

/**
 * The checkout once its clone has settled — polled while `cloning`, up to
 * the deadline. Null when it disappeared from the worker meanwhile;
 * still `cloning` when the deadline passed first.
 */
async function awaitClone(
  target: ReturnType<typeof codeProjectTarget>,
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

type Actor = { subject: string; origin?: string };
type Chat = { id: string; workspaceId: string | null };
type Target = ReturnType<typeof codeProjectTarget>;

/**
 * The project's base clone as it is: present, cloning, or — when it is
 * gone or failed — cloned again with the chatting person's grant.
 */
async function resolveBase(
  db: Kysely<DB>,
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
  const cloned = await startProjectClone(db, project, credential);
  return cloned.ok ? { ok: true, val: cloned.val, cloned: true } : cloned;
}

/**
 * Bring a chat's checkout back for the tools mid-turn. The project row
 * and the chat are read again first: another chat may already have cloned
 * the project anew (its id is adopted, its clone waited on) — only a
 * base that is truly gone or failed is cloned again, with the chatting
 * person's grant — and the chat's worktree is then made in it.
 */
async function recoverCheckout(
  db: Kysely<DB>,
  project: ProjectRow,
  chat: Chat,
  actor: Actor,
  target: Target,
  lostId: string
): Promise<CheckoutRecovery> {
  if (!project.repo) return { ok: false, message: 'the project names no repository.' };
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);
  const fresh = (await getProjectRow(db, project.id)) ?? project;
  const freshChat = (await getChatRow(db, chat.id)) ?? chat;
  // The lost id is the chat's worktree or the base under it; the base is
  // only cloned again when the worker no longer has it.
  const base = await resolveBase(db, fresh, actor, target, { notId: lostId });
  if (!base.ok) return { ok: false, message: base.message };
  const settled = await awaitClone(target, base.val, started + CLONE_WAIT_MS);
  if (!settled) return { ok: false, message: 'the checkout disappeared while cloning.' };
  if (settled.status === 'failed') {
    return { ok: false, message: settled.error ?? 'the clone failed.' };
  }
  if (settled.status !== 'ready') {
    return { ok: false, message: `the clone is still running after ${seconds()}s.` };
  }
  const worktree = await ensureChatWorktree(db, fresh, freshChat, settled, actor);
  if (!worktree.ok) return { ok: false, message: worktree.message };
  return {
    ok: true,
    workspaceId: worktree.val.id,
    seconds: seconds(),
    how: 'cloned' in base && base.cloned ? 'cloned' : 'adopted',
  };
}

/**
 * A code chat's turn is a working session, not an answer: it may run a
 * test suite several times, read across a repository, and hand tasks to
 * sub-agents. Its limits are set far above an ordinary chat's — for now
 * effectively unlimited; an organisation-level allowance per day or
 * week is the place for a ceiling when one is wanted.
 */
export const CODE_TURN_LIMITS: Partial<TurnLimits> = {
  maxIterations: 1_000,
  wallClockMs: 6 * 60 * 60_000,
  toolResultMaxChars: 120_000,
};

export interface CodeTurnContext {
  tools: LocalTool[];
  prompt: {
    repoFullName: string;
    branch: string;
    ready: boolean;
    notReady: string | null;
    envNames: string[];
    /** The checkout is being cloned as this turn's first step. */
    clonedNow: boolean;
    /** The code_service_* tools are in the turn: containers may be started beside the checkout. */
    servicesEnabled: boolean;
  };
  /** The clone to run before the model speaks; null when the checkout is already usable. */
  prelude: PreludeStep | null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function codeProjectContext(
  db: Kysely<DB>,
  project: ProjectRow,
  actor: { subject: string; origin?: string; auto?: boolean; chat: Chat }
): Promise<CodeTurnContext | null> {
  if (project.kind !== 'code' || !project.repo) return null;
  const target = codeProjectTarget(project.id);
  const envNamesNone: string[] = [];
  const servicesEnabled = await sandboxServicesEnabled();
  const base = {
    repoFullName: project.repo.fullName,
    branch: project.repo.branch,
    envNames: envNamesNone,
    clonedNow: false,
    servicesEnabled,
  };
  const unavailable = (notReady: string, extra: Partial<typeof base> = {}) => ({
    tools: [],
    prompt: { ...base, ...extra, ready: false, notReady },
    prelude: null,
  });
  if (!(await sandboxWorkspacesEnabled())) {
    return unavailable('code workspaces are not enabled for this organization');
  }

  // The project's clone as it is: present and usable, still cloning, or
  // gone (never cloned, failed, or retired by the worker's sweep).
  const resolvedBase = await resolveBase(db, project, actor, target);
  if (!resolvedBase.ok) {
    return unavailable(`the repository could not be cloned: ${resolvedBase.message}`);
  }
  const clonedNow = 'cloned' in resolvedBase && resolvedBase.cloned === true;
  const baseWorkspace = resolvedBase.val;

  // The chat works in a worktree of that clone, made now when the clone is
  // ready, or by the first step below once it is.
  let workspace = baseWorkspace;
  if (baseWorkspace.status === 'ready') {
    const worktree = await ensureChatWorktree(db, project, actor.chat, baseWorkspace, actor);
    if (!worktree.ok) {
      return unavailable(`the chat's worktree could not be made: ${worktree.message}`);
    }
    workspace = worktree.val;
  }
  const workspaceRef = { id: workspace.id };

  // The org's roster, read once per turn: the orchestrator picks a
  // sub-agent's model from it per task (delegate.ts) — the same enabled
  // rows the composer's own picker offers.
  const [env, subagentModels] = await Promise.all([sbEnvList(target), listChatModels(db)]);
  const envNames = env.ok ? env.val.map((variable) => variable.name) : [];
  const tools = codeTools({
    target,
    workspaceId: workspace.id,
    workspaceRef,
    repoFullName: project.repo.fullName,
    repoProvider: project.repo.provider,
    origin: actor.origin ?? getPublicBaseUrl() ?? '',
    recover: (lostId) => recoverCheckout(db, project, actor.chat, actor, target, lostId),
    servicesEnabled,
    ...(actor.auto ? { auto: true } : {}),
    subagentModels: subagentModels.map(({ id, label, provider, model, isDefault }) => ({
      id,
      label,
      provider,
      model,
      isDefault,
    })),
  });

  // A clone in flight — this turn's or an earlier one's — is the turn's
  // first step: it waits, makes the chat's worktree, and answers the way a
  // tool would.
  if (baseWorkspace.status === 'cloning') {
    const repoFullName = project.repo.fullName;
    const started = Date.now();
    const prelude: PreludeStep = {
      name: CLONE_STEP_NAME,
      input: {
        repository: repoFullName,
        branch: project.repo.branch || '(default)',
        ...(clonedNow ? {} : { resumed: true }),
      },
      async run() {
        const current = await awaitClone(target, baseWorkspace, started + CLONE_WAIT_MS);
        if (!current) return errorResult('The checkout disappeared while cloning.');
        const seconds = Math.round((Date.now() - started) / 1000);
        if (current.status === 'ready') {
          const worktree = await ensureChatWorktree(db, project, actor.chat, current, actor);
          if (!worktree.ok) {
            return errorResult(
              `The repository was cloned, but this chat's worktree could not be made: ${worktree.message}. The code_* tools cannot work until it is; the next turn tries again.`
            );
          }
          workspaceRef.id = worktree.val.id;
          return textResult(
            `Cloned ${repoFullName} @ ${current.branch} — ${bytes(current.sizeBytes)} on the sandbox${current.worker ? ` (worker ${current.worker})` : ''}, ${seconds}s. This chat works in its own worktree, on ${worktree.val.branch}; the code_* tools work in it now.`
          );
        }
        if (current.status === 'failed') {
          return errorResult(
            `The clone failed: ${current.error ?? 'unknown reason'}. The code_* tools cannot work until it is cloned; the next chat tries again.`
          );
        }
        return errorResult(
          `The clone is still running after ${seconds}s. The code_* tools are not usable in this turn; try again in a few minutes.`
        );
      },
    };
    return {
      tools,
      prompt: { ...base, envNames, clonedNow, ready: true, notReady: null },
      prelude,
    };
  }
  return {
    tools,
    prompt: {
      ...base,
      branch: workspace.branch,
      envNames,
      clonedNow,
      ready: true,
      notReady: null,
    },
    prelude: null,
  };
}
