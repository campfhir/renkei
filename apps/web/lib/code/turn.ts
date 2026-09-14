/**
 * What a chat turn inside a code project gets: the code_* tools bound to
 * the project's checkout, and what the system prompt says about the
 * repository. Asked once per turn, because the checkout's state lives on
 * the sandbox worker — and because the checkout is made here: nothing is
 * cloned when a project is created; the first turn that needs it clones
 * the repository with the chatting person's own Bitbucket grant, waits
 * for the clone, and only then offers the tools. A checkout the worker's
 * sweep retired, or whose clone failed, is cloned again the same way.
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
import type { LocalTool } from '@/lib/chat/local-tools';
import type { ProjectRow } from '@/lib/chat/projects';
import type { TurnLimits } from '@/lib/chat/turn-runner';
import { resolveWorkspaceGitCredential } from '@/lib/sandbox/workspace-git';
import { startProjectClone } from './projects';
import { codeProjectTarget } from './scope';
import { codeTools } from './tools';

/** How long a turn waits for a clone it started before giving up on the tools for this turn. */
export const CLONE_WAIT_MS = 5 * 60_000;
const CLONE_POLL_MS = 2_000;

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
    /** The checkout was cloned for this very turn. */
    clonedNow: boolean;
  };
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
  // A clone in flight — this turn's or an earlier one's — is waited for.
  const deadline = Date.now() + CLONE_WAIT_MS;
  while (workspace.status === 'cloning' && Date.now() < deadline) {
    await sleep(CLONE_POLL_MS);
    const got = await sbWorkspaceGet(target, workspace.id);
    if (!got.ok) return unavailable('the checkout disappeared while cloning');
    workspace = got.val;
  }

  const env = await sbEnvList(target);
  const envNames = env.ok ? env.val.map((variable) => variable.name) : [];
  if (workspace.status === 'cloning') {
    return unavailable('the clone is still running; try again in a few minutes', {
      envNames,
      clonedNow,
    });
  }
  if (workspace.status === 'failed') {
    return unavailable(`the clone failed: ${workspace.error ?? 'unknown reason'}`, {
      envNames,
      clonedNow,
    });
  }
  return {
    tools: codeTools({
      target,
      workspaceId: workspace.id,
      repoFullName: project.repo.fullName,
      origin: actor.origin ?? getPublicBaseUrl() ?? '',
    }),
    prompt: {
      ...base,
      branch: workspace.branch,
      envNames,
      clonedNow,
      ready: true,
      notReady: null,
    },
  };
}
