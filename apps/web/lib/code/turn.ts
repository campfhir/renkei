/**
 * What a chat turn inside a code project gets: the code_* tools bound to
 * the project's checkout, and what the system prompt says about the
 * repository. Asked once per turn, because the checkout's state lives on
 * the sandbox worker — and because the checkout is made here: nothing is
 * cloned when a project is created; the first turn that needs it clones
 * the repository with the chatting person's own Bitbucket grant and
 * hands the turn a step that waits for it — shown in the chat like a
 * tool call, "Cloning the repository", right after the prompt — so the
 * tools are usable by the time the model speaks. A checkout the worker's
 * sweep retired, or whose clone failed, is cloned again the same way.
 *
 * A checkout can also go mid-turn — the worker's volume replaced, its row
 * retired, another chat's clone replacing it. The tools are handed a way
 * back (`recover`, lib/code/tools.ts): re-read the project, adopt a newer
 * clone if one is there, otherwise clone again with the same grant, wait
 * as the first step would, and let the call that hit the wall run again.
 */

import type { Kysely } from 'kysely';
import type { DB } from '@renkei/db';
import { getPublicBaseUrl } from '@renkei/settings';
import {
  sandboxWorkspacesEnabled,
  sbEnvList,
  sbWorkspaceGet,
  type WireWorkspace,
} from '@renkei/sandbox-client';
import { errorResult, textResult, type LocalTool } from '@/lib/chat/local-tools';
import { getProjectRow, type ProjectRow } from '@/lib/chat/projects';
import type { PreludeStep, TurnLimits } from '@/lib/chat/turn-runner';
import { resolveWorkspaceGitCredential } from '@/lib/sandbox/workspace-git';
import { startProjectClone } from './projects';
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

/**
 * Bring a project's checkout back for the tools mid-turn. The project row
 * is read again first: another chat may already have cloned it anew (its
 * id is adopted, its clone waited on) — only a checkout that is truly
 * gone or failed is cloned again, with the chatting person's grant.
 */
async function recoverCheckout(
  db: Kysely<DB>,
  project: ProjectRow,
  actor: { subject: string; origin?: string },
  target: ReturnType<typeof codeProjectTarget>,
  lostId: string
): Promise<CheckoutRecovery> {
  const started = Date.now();
  const seconds = () => Math.round((Date.now() - started) / 1000);
  const fresh = (await getProjectRow(db, project.tenantId, project.id)) ?? project;
  let current: WireWorkspace | null = null;
  if (fresh.workspaceId && fresh.workspaceId !== lostId) {
    const got = await sbWorkspaceGet(target, fresh.workspaceId);
    if (got.ok) current = got.val;
  }
  let how: 'cloned' | 'adopted' = 'adopted';
  if (!current || current.status === 'failed') {
    const origin = actor.origin ?? getPublicBaseUrl() ?? '';
    const credential = await resolveWorkspaceGitCredential(
      { tenantId: project.tenantId, subject: actor.subject, origin },
      { write: false }
    );
    if (typeof credential === 'string') return { ok: false, message: credential };
    const cloned = await startProjectClone(db, fresh, credential);
    if (!cloned.ok) return { ok: false, message: cloned.message };
    current = cloned.val;
    how = 'cloned';
  }
  const settled = await awaitClone(target, current, started + CLONE_WAIT_MS);
  if (!settled) return { ok: false, message: 'the checkout disappeared while cloning.' };
  if (settled.status === 'ready') {
    return { ok: true, workspaceId: settled.id, seconds: seconds(), how };
  }
  if (settled.status === 'failed') {
    return { ok: false, message: settled.error ?? 'the clone failed.' };
  }
  return { ok: false, message: `the clone is still running after ${seconds()}s.` };
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
  actor: { subject: string; origin?: string }
): Promise<CodeTurnContext | null> {
  if (project.kind !== 'code' || !project.repo) return null;
  const target = codeProjectTarget(project.tenantId, project.id);
  const envNamesNone: string[] = [];
  const base = {
    repoFullName: project.repo.fullName,
    branch: project.repo.branch,
    envNames: envNamesNone,
    clonedNow: false,
  };
  const unavailable = (notReady: string, extra: Partial<typeof base> = {}) => ({
    tools: [],
    prompt: { ...base, ...extra, ready: false, notReady },
    prelude: null,
  });
  if (!sandboxWorkspacesEnabled()) {
    return unavailable('code workspaces are not enabled on this deployment');
  }

  // The checkout as it is: present and usable, still cloning, failed, or
  // gone (never cloned, or retired by the worker's sweep).
  let workspace: WireWorkspace | null = null;
  if (project.workspaceId) {
    const got = await sbWorkspaceGet(target, project.workspaceId);
    if (got.ok) workspace = got.val;
  }
  let clonedNow = false;
  if (!workspace || workspace.status === 'failed') {
    const origin = actor.origin ?? getPublicBaseUrl() ?? '';
    const credential = await resolveWorkspaceGitCredential(
      { tenantId: project.tenantId, subject: actor.subject, origin },
      { write: false }
    );
    if (typeof credential === 'string') {
      return unavailable(`the repository could not be cloned: ${credential}`);
    }
    const cloned = await startProjectClone(db, project, credential);
    if (!cloned.ok) return unavailable(`the clone failed to start: ${cloned.message}`);
    workspace = cloned.val;
    clonedNow = true;
  }
  const env = await sbEnvList(target);
  const envNames = env.ok ? env.val.map((variable) => variable.name) : [];
  const tools = codeTools({
    target,
    workspaceId: workspace.id,
    repoFullName: project.repo.fullName,
    origin: actor.origin ?? getPublicBaseUrl() ?? '',
    recover: (lostId) => recoverCheckout(db, project, actor, target, lostId),
  });

  // A clone in flight — this turn's or an earlier one's — is the turn's
  // first step: it waits, and answers the way a tool would.
  if (workspace.status === 'cloning') {
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
        const current = await awaitClone(target, workspace, started + CLONE_WAIT_MS);
        if (!current) return errorResult('The checkout disappeared while cloning.');
        const seconds = Math.round((Date.now() - started) / 1000);
        if (current.status === 'ready') {
          return textResult(
            `Cloned ${repoFullName} @ ${current.branch} — ${bytes(current.sizeBytes)} on the sandbox${current.worker ? ` (worker ${current.worker})` : ''}, ${seconds}s. The code_* tools work in it now.`
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
