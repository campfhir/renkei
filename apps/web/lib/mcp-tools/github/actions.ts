/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * GitHub Actions — Bitbucket Pipelines' counterpart: workflows, their
 * runs, jobs, and logs; dispatch (preview-gated) and cancel.
 */
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { actMeta } from '@renkei/tool-outcomes';
import { withPresentationHint } from '../common';
import type { MCPToolContext } from '../common';
import {
  APP_ONLY_META,
  ISSUE_PREVIEW_URI,
  confirmGuard,
  newPreviewId,
  previewToolMeta,
} from '../widgets';
import type { GitHubAuth } from './github-auth';
import { arr, describeGitHubFailure, errText, ghJson, ghRawText, moreLine, num, rec, repoUrl, runUrl, str, textResult } from './client';
import { githubScopeFor } from './scopes';

function repoPath(owner: string, repo: string): string {
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
}

const ownerArg = z.string().min(1).describe('Account (organization or user) login, from github_list_accounts');
const repoArg = z.string().min(1).describe('Repository name, from github_list_repositories');

function runLine(run: Record<string, unknown>): string {
  return (
    `#${num(run.run_number)} — ${str(run.status)}${str(run.conclusion) ? `/${str(run.conclusion)}` : ''}` +
    ` — ${str(run.name) || str(run.event)} — ${str(run.head_branch)}` +
    ` — id ${num(run.id)}` +
    (str(run.created_at) ? ` — ${str(run.created_at)}` : '')
  );
}

export async function registerActionsTools(
  server: McpServer,
  context: MCPToolContext,
  auth: GitHubAuth
): Promise<void> {
  server.registerTool(
    'github_list_workflows',
    {
      title: 'GitHub · Read — List workflows',
      description: 'A repository’s Actions workflows, with the ids github_trigger_workflow takes.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ owner: ownerArg, repo: repoArg }),
    },
    async (args: Record<string, any>) => {
      const result = await ghJson(
        auth,
        githubScopeFor('github_list_workflows'),
        `${repoPath(str(args.owner), str(args.repo))}/actions/workflows?per_page=100`
      );
      if (!result.ok) return errText(result.error);
      const workflows = arr(rec(result.body).workflows);
      const lines = workflows.map(
        (workflow) => `${str(workflow.name)} — id: ${num(workflow.id)} — ${str(workflow.path)} — ${str(workflow.state)}`
      );
      if (lines.length === 0) return textResult('No workflows.');
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'github_list_workflow_runs',
    {
      title: 'GitHub · Read — List workflow runs',
      description: 'A repository’s (or one workflow’s) Actions runs, newest first.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        workflowId: z.string().describe('Narrow to one workflow — id or filename, from github_list_workflows').optional(),
        branch: z.string().describe('Narrow to one branch').optional(),
        max: z.number().int().min(1).max(50).describe('How many (default 15)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const max = typeof args.max === 'number' ? args.max : 15;
      const parts = [`per_page=${max}`];
      if (str(args.branch)) parts.push(`branch=${encodeURIComponent(str(args.branch))}`);
      const base = str(args.workflowId)
        ? `${repoPath(str(args.owner), str(args.repo))}/actions/workflows/${encodeURIComponent(str(args.workflowId))}/runs`
        : `${repoPath(str(args.owner), str(args.repo))}/actions/runs`;
      const result = await ghJson(auth, githubScopeFor('github_list_workflow_runs'), `${base}?${parts.join('&')}`);
      if (!result.ok) return errText(result.error);
      const runs = arr(rec(result.body).workflow_runs);
      const lines = runs.map(runLine);
      if (lines.length === 0) return textResult('No runs.');
      return textResult(
        withPresentationHint(
          lines.join('\n') + moreLine(result.hasMore, 'raise max to see more.'),
          'a table (Run, Status, Name, Branch, Started) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'github_get_workflow_run',
    {
      title: 'GitHub · Read — Get a workflow run',
      description: 'One Actions run with its jobs and their states. Job ids feed github_get_workflow_job_log.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({ owner: ownerArg, repo: repoArg, runId: z.string().min(1).describe('From github_list_workflow_runs') }),
    },
    async (args: Record<string, any>) => {
      const owner = str(args.owner);
      const repo = str(args.repo);
      const runId = str(args.runId);
      const base = `${repoPath(owner, repo)}/actions/runs/${encodeURIComponent(runId)}`;
      const scopes = githubScopeFor('github_get_workflow_run');
      const [runResult, jobsResult] = await Promise.all([
        ghJson(auth, scopes, base),
        ghJson(auth, scopes, `${base}/jobs?per_page=50`),
      ]);
      if (!runResult.ok) return errText(runResult.error);
      const run = rec(runResult.body);
      const lines = [
        `Run #${num(run.run_number)} — ${str(run.status)}${str(run.conclusion) ? `/${str(run.conclusion)}` : ''}`,
        `Workflow: ${str(run.name)}`,
        `Branch: ${str(run.head_branch)} — ${str(rec(run.head_commit).id).slice(0, 12)}`,
        `Triggered by: ${str(rec(run.triggering_actor).login) || str(run.event)}`,
        `Started: ${str(run.run_started_at)}`,
      ];
      if (jobsResult.ok) {
        const jobs = arr(rec(jobsResult.body).jobs).map(
          (job) =>
            `  ${str(job.name)} — ${str(job.status)}${str(job.conclusion) ? `/${str(job.conclusion)}` : ''} — id: ${num(job.id)}`
        );
        if (jobs.length > 0) lines.push('', 'Jobs:', ...jobs);
      }
      lines.push('', `[Open on GitHub](${runUrl(owner, repo, runId)})`);
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'github_get_workflow_job_log',
    {
      title: 'GitHub · Read — Read a workflow job’s log',
      description: 'The log of one Actions job — the tail by default, where the failure usually is.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        owner: ownerArg,
        repo: repoArg,
        jobId: z.string().min(1).describe('From github_get_workflow_run'),
        maxChars: z.number().int().min(500).max(100_000).describe('How much of the tail to return (default 20000)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const result = await ghRawText(
        auth,
        githubScopeFor('github_get_workflow_job_log'),
        `${repoPath(str(args.owner), str(args.repo))}/actions/jobs/${encodeURIComponent(str(args.jobId))}/logs`,
        '*/*'
      );
      if (!result.ok) return errText(result.error);
      if (!result.text) return textResult('(empty log)');
      const maxChars = typeof args.maxChars === 'number' ? args.maxChars : 20_000;
      const tail =
        result.text.length > maxChars
          ? `… (${result.text.length - maxChars} earlier characters omitted)\n${result.text.slice(-maxChars)}`
          : result.text;
      return textResult(tail);
    }
  );

  // ——— Trigger (with preview) ———————————————————————————————————————

  const triggerSchema = z.object({
    owner: ownerArg,
    repo: repoArg,
    workflowId: z.string().min(1).describe('Workflow id or filename (e.g. "ci.yml"), from github_list_workflows'),
    ref: z.string().min(1).describe('Branch or tag to run on'),
    inputs: z.record(z.string(), z.string()).describe('workflow_dispatch inputs, if the workflow declares any').optional(),
  });

  const triggerHandler = async (args: Record<string, any>) => {
    const owner = str(args.owner);
    const repo = str(args.repo);
    const workflowId = str(args.workflowId);
    const result = await ghJson(
      auth,
      githubScopeFor('github_trigger_workflow'),
      `${repoPath(owner, repo)}/actions/workflows/${encodeURIComponent(workflowId)}/dispatches`,
      { method: 'POST', json: { ref: str(args.ref), ...(args.inputs ? { inputs: args.inputs } : {}) } }
    );
    if (!result.ok) return errText(result.error);
    // Dispatch answers 204 with no body — GitHub does not hand back the run
    // it just created, so the newest run on this ref/workflow is the best
    // available pointer, best effort.
    const runsUrl = `${repoUrl(owner, repo)}/actions/workflows/${encodeURIComponent(workflowId)}?query=branch%3A${encodeURIComponent(str(args.ref))}`;
    return {
      content: [
        {
          type: 'text' as const,
          text: `Workflow "${workflowId}" dispatched on ${str(args.ref)}.\n\n[View runs on GitHub](${runsUrl})`,
        },
      ],
      _meta: actMeta({ id: workflowId, url: runsUrl }),
    };
  };

  server.registerTool(
    'github_trigger_workflow',
    {
      title: 'GitHub · Act — Run a workflow',
      description:
        'Dispatch a workflow on a branch or tag (the workflow must declare `workflow_dispatch`). ' +
        'Prefer github_trigger_workflow_preview whenever the user should confirm first: a run ' +
        'spends Actions minutes and can deploy.',
      annotations: { readOnlyHint: false },
      inputSchema: triggerSchema,
    },
    triggerHandler
  );

  server.registerTool(
    'github_trigger_workflow_preview',
    {
      title: 'GitHub · Act — Preview a workflow run before starting it',
      description:
        'Show the user an interactive card confirming a workflow dispatch. Prefer this over ' +
        'github_trigger_workflow whenever the user should confirm — the card does the starting.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(ISSUE_PREVIEW_URI),
      inputSchema: triggerSchema,
    },
    async (args: Record<string, any>) => {
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `The workflow run on ${str(args.ref)} is awaiting the user's decision on the ` +
              `preview card. Do not start it another way; the user confirms or cancels from ` +
              `the card. If no card appeared in this client, ask the user how to proceed.`,
          },
        ],
        structuredContent: {
          kind: 'issue',
          previewId: newPreviewId(),
          title: 'Run workflow',
          subtitle: `${str(args.owner)}/${str(args.repo)}`,
          confirmTool: 'github_trigger_workflow_confirm',
          confirmLabel: 'Run workflow',
          confirmArgs: args,
          fields: [
            { label: 'Workflow', value: str(args.workflowId) },
            { label: 'Branch/tag', value: str(args.ref) },
          ],
        },
      };
    }
  );

  server.registerTool(
    'github_trigger_workflow_confirm',
    {
      title: 'GitHub · Act — Run a previewed workflow (card only)',
      description:
        'Dispatch a workflow run the user approved on a preview card.' +
        confirmGuard('github_trigger_workflow_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: triggerSchema,
    },
    triggerHandler
  );

  server.registerTool(
    'github_cancel_workflow_run',
    {
      title: 'GitHub · Act — Cancel a running workflow',
      description: 'Cancel an Actions run that is still in progress.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({ owner: ownerArg, repo: repoArg, runId: z.string().min(1).describe('From github_list_workflow_runs') }),
    },
    async (args: Record<string, any>) => {
      const response = await auth.fetch(
        githubScopeFor('github_cancel_workflow_run'),
        `${repoPath(str(args.owner), str(args.repo))}/actions/runs/${encodeURIComponent(str(args.runId))}/cancel`,
        { method: 'POST' }
      );
      if (!response.ok) return errText(await describeGitHubFailure(response));
      return {
        content: [{ type: 'text' as const, text: 'Workflow run cancellation requested.' }],
        _meta: actMeta({ id: str(args.runId) }),
      };
    }
  );
}
