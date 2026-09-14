/**
 * What a chat turn inside a code project gets: the code_* tools bound to
 * the project's checkout, and what the system prompt says about the
 * repository. Asked once per turn, because the checkout's state lives on
 * the sandbox worker — a clone still running, a clone that failed, a
 * checkout the worker's sweep retired — and the model should be offered
 * the tools only when they can do something.
 */

import { getPublicBaseUrl } from '@renkei/settings';
import { sandboxWorkspacesEnabled, sbEnvList, sbWorkspaceGet } from '@renkei/sandbox-client';
import type { LocalTool } from '@/lib/chat/local-tools';
import type { ProjectRow } from '@/lib/chat/projects';
import { codeProjectTarget } from './scope';
import { codeTools } from './tools';

export interface CodeTurnContext {
  tools: LocalTool[];
  prompt: {
    repoFullName: string;
    branch: string;
    ready: boolean;
    notReady: string | null;
    envNames: string[];
  };
}

export async function codeProjectContext(project: ProjectRow): Promise<CodeTurnContext | null> {
  if (project.kind !== 'code' || !project.repo) return null;
  const target = codeProjectTarget(project.tenantId, project.id);
  const base = { repoFullName: project.repo.fullName, branch: project.repo.branch, envNames: [] };
  if (!sandboxWorkspacesEnabled()) {
    return {
      tools: [],
      prompt: {
        ...base,
        ready: false,
        notReady: 'code workspaces are not enabled on this deployment',
      },
    };
  }
  if (!project.workspaceId) {
    return {
      tools: [],
      prompt: { ...base, ready: false, notReady: 'the repository has not been cloned' },
    };
  }
  const [workspace, env] = await Promise.all([
    sbWorkspaceGet(target, project.workspaceId),
    sbEnvList(target),
  ]);
  const envNames = env.ok ? env.val.map((variable) => variable.name) : [];
  if (!workspace.ok) {
    return {
      tools: [],
      prompt: {
        ...base,
        envNames,
        ready: false,
        notReady: 'the checkout is gone; clone it again from the project page',
      },
    };
  }
  if (workspace.val.status === 'cloning') {
    return {
      tools: [],
      prompt: { ...base, envNames, ready: false, notReady: 'the clone is still running' },
    };
  }
  if (workspace.val.status === 'failed') {
    return {
      tools: [],
      prompt: {
        ...base,
        envNames,
        ready: false,
        notReady: `the clone failed: ${workspace.val.error ?? 'unknown reason'}`,
      },
    };
  }
  return {
    tools: codeTools({
      target,
      workspaceId: workspace.val.id,
      repoFullName: project.repo.fullName,
      origin: getPublicBaseUrl() ?? '',
    }),
    prompt: { ...base, branch: workspace.val.branch, envNames, ready: true, notReady: null },
  };
}
