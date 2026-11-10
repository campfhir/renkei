/**
 * Making a code project: a chat project with a repository on it. The row
 * is written and the `.env` (if pasted) goes to the sandbox worker under
 * the project's scope. Nothing is cloned yet — the first chat in the
 * project clones the repository with the chatting person's own grant on
 * the chosen git host (Bitbucket or GitHub).
 *
 * One function behind both doors: the Code page's form
 * (app/api/code/projects/route.ts) and the chat's own tool
 * (lib/chat/platform-tools/projects.ts), so a project the model makes on
 * the person's word clears the same bar as one made by hand.
 */

import type { ActorFields } from '@renkei/db';
import { validateGitRef, validateRepoFullName } from '@renkei/connector-sandbox';
import { sandboxWorkspacesEnabled } from '@renkei/sandbox-client';
import { ATLASSIAN_BITBUCKET, GITHUB } from '@renkei/provider-grants';
import { optionalString } from '@/lib/chat/route-support';
import {
  createProject,
  getProjectRow,
  PROJECT_INSTRUCTIONS_MAX_CHARS,
  PROJECT_NAME_MAX_CHARS,
} from '@/lib/chat/projects';
import {
  CODE_PROJECT_CONNECTORS,
  defaultToolConfig,
  parseToolConfig,
  withRequiredConnectors,
} from '@/lib/chat/tool-config';
import { getDefaultChatTools } from '@/lib/chat/tool-prefs';
import { recordAuditEvent } from '@/lib/audit-events';
import { logger } from '@/lib/logger';
import { codeProjectAccess, codeProjectAccessMessage } from './access';
import { DEFAULT_CODE_INSTRUCTIONS } from './default-instructions';
import { replaceProjectEnv } from './projects';

const DOTENV_MAX_CHARS = 200_000;

/** The git hosts a code project can live on, by provider key. */
export const CODE_HOSTS: readonly { provider: string; label: string }[] = [
  { provider: ATLASSIAN_BITBUCKET, label: 'Bitbucket' },
  { provider: GITHUB, label: 'GitHub' },
];

export type CreateCodeProjectOutcome =
  | { ok: true; projectId: string; name: string; repository: string; envProblems: string[] }
  | { ok: false; status: number; code: string; message: string };

/**
 * `body` is the request as the form sends it: `provider`, `repository`,
 * and optionally `name`, `branch`, `description`, `instructions`,
 * `toolConfig` and `env`. `actor` is who a log line names
 * (docs/logging.md) — `who(session)` in a route.
 */
export async function createCodeProject(
  subject: string,
  actor: ActorFields,
  body: Record<string, unknown>
): Promise<CreateCodeProjectOutcome> {
  const refuse = (status: number, code: string, message: string) =>
    ({ ok: false, status, code, message }) as const;
  if (!(await sandboxWorkspacesEnabled())) {
    return refuse(503, 'unavailable', 'Code workspaces are not enabled on this deployment.');
  }
  // The host this repository lives on — Bitbucket unless the form said
  // otherwise, so an older client that never sent `provider` keeps working.
  const provider =
    typeof body.provider === 'string' && body.provider === GITHUB ? GITHUB : ATLASSIAN_BITBUCKET;
  // The same bar the Code page shows: a connection on that host that can
  // clone, push and open pull requests, or no project.
  const access = await codeProjectAccess(subject, provider);
  if (!access.ok) {
    return refuse(
      403,
      provider === GITHUB ? 'github' : 'bitbucket',
      codeProjectAccessMessage(access, provider) ??
        `Connect ${provider === GITHUB ? 'GitHub' : 'Bitbucket'} first.`
    );
  }
  const repo = validateRepoFullName(body.repository);
  if (!repo.ok) return refuse(400, 'invalid', repo.message);
  // The repository names the project unless the person renamed it; the
  // slug alone (not `workspace/repo`) reads like a project name.
  const name =
    optionalString(body.name, PROJECT_NAME_MAX_CHARS) ||
    repo.fullName.split('/').pop() ||
    repo.fullName;
  let branch = '';
  if (typeof body.branch === 'string' && body.branch.trim()) {
    const ref = validateGitRef(body.branch);
    if (!ref.ok) return refuse(400, 'invalid', ref.message);
    branch = ref.ref;
  }
  const description = optionalString(body.description, 2_000) ?? null;
  // Instructions left out of the request get the standing developer's
  // brief; instructions sent blank were cleared on purpose and stay so.
  const instructions =
    body.instructions === undefined
      ? DEFAULT_CODE_INSTRUCTIONS
      : (optionalString(body.instructions, PROJECT_INSTRUCTIONS_MAX_CHARS) ?? null);
  // The toolset the project's chats start with: what the form chose, else
  // the person's own default for code projects, else the code default —
  // copied onto the project now (tool-config.ts), so a later change to the
  // preference leaves this project as it was made. The git host connectors
  // ride along whatever was chosen; both are locked on in every code chat
  // anyway (CODE_PROJECT_CONNECTORS).
  const chosen = body.toolConfig === undefined ? null : parseToolConfig(body.toolConfig);
  const toolConfig = withRequiredConnectors(
    chosen ??
      (await getDefaultChatTools(subject, { fresh: true, kind: 'code' })) ??
      defaultToolConfig('code'),
    CODE_PROJECT_CONNECTORS
  );
  const dotenv = typeof body.env === 'string' ? body.env : '';
  if (dotenv.length > DOTENV_MAX_CHARS) return refuse(413, 'invalid', 'The .env is too large.');

  const projectId = await createProject({
    ownerSubject: subject,
    name,
    description: description || null,
    instructions: instructions || null,
    toolConfig,
    repo: { provider, fullName: repo.fullName, branch },
  });
  if (!projectId) {
    logger.error(
      '{actor} created the code project "{name}" on {repository}, but the content encryption key is not configured; the project was not saved',
      {
        component: 'code/create-project',
        ...actor,
        name,
        repository: repo.fullName,
        provider,
      }
    );
    return refuse(500, 'content-key', 'The content encryption key is not configured.');
  }
  const project = await getProjectRow(projectId);
  if (!project) {
    logger.error(
      '{actor} created the code project "{name}" on {repository}, but the saved row could not be read back; the .env was not stored and the person saw an error',
      {
        component: 'code/create-project',
        ...actor,
        projectId,
        name,
        repository: repo.fullName,
        provider,
      }
    );
    return refuse(500, 'internal', 'The project could not be read back.');
  }

  const problems: string[] = [];
  if (dotenv.trim()) {
    const env = await replaceProjectEnv(project, dotenv);
    if (!env.ok) return refuse(env.status, 'env', env.message);
    problems.push(...env.val.problems);
  }
  recordAuditEvent({
    actorSubject: subject,
    action: 'code.project.created',
    targetKind: 'code_project',
    targetLabel: name,
    details: { projectId, repository: repo.fullName, branch: branch || null },
  });
  return { ok: true, projectId, name, repository: repo.fullName, envProblems: problems };
}
