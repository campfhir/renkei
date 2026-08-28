/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Pipelines — runs, steps, logs; trigger (preview-gated) and stop.
 * Pipeline and step identifiers are uuids in braces; the tools take them
 * with or without the braces and normalize.
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
import type { BitbucketAuth } from './bitbucket-auth';
import {
  bbJson,
  bbRawText,
  describeBitbucketFailure,
  errText,
  moreLine,
  num,
  pipelineUrl,
  rec,
  str,
  textResult,
  values,
} from './client';
import { bitbucketScopeFor } from './scopes';

function repoPath(workspace: string, repoSlug: string): string {
  return `/repositories/${encodeURIComponent(workspace)}/${encodeURIComponent(repoSlug)}`;
}

/** Uuid path segment: brace-wrapped, then encoded — the API's own shape. */
function uuidSegment(raw: string): string {
  const uuid = /^\{.*\}$/.test(raw) ? raw : `{${raw}}`;
  return encodeURIComponent(uuid);
}

const workspaceArg = z.string().min(1).describe('Workspace slug, from bitbucket_list_workspaces');
const repoArg = z.string().min(1).describe('Repository slug, from bitbucket_list_repositories');

function stateOf(pipeline: Record<string, unknown>): string {
  const state = rec(pipeline.state);
  return str(rec(state.result).name) || str(rec(state.stage).name) || str(state.name);
}

function pipelineLine(pipeline: Record<string, unknown>): string {
  const target = rec(pipeline.target);
  const ref = str(target.ref_name) || str(rec(target.commit).hash).slice(0, 12);
  return (
    `#${num(pipeline.build_number)} — ${stateOf(pipeline)} — ${ref}` +
    ` — by ${str(rec(pipeline.creator).display_name) || '(scheduler)'}` +
    (str(pipeline.created_on) ? ` — ${str(pipeline.created_on)}` : '')
  );
}

export async function registerPipelineTools(
  server: McpServer,
  context: MCPToolContext,
  auth: BitbucketAuth
): Promise<void> {
  server.registerTool(
    'bitbucket_list_pipelines',
    {
      title: 'Bitbucket · Read — List pipeline runs',
      description: 'A repository’s pipeline runs, newest first, with state and target ref.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        max: z.number().int().min(1).max(50).describe('How many (default 15)').optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const max = typeof args.max === 'number' ? args.max : 15;
      const result = await bbJson(
        auth,
        bitbucketScopeFor('bitbucket_list_pipelines'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}/pipelines?pagelen=${max}&sort=-created_on`
      );
      if (!result.ok) return errText(result.error);
      const lines = values(result.body).map(
        (pipeline) => `${pipelineLine(pipeline)} — uuid: ${str(pipeline.uuid)}`
      );
      if (lines.length === 0) return textResult('No pipeline runs.');
      return textResult(
        withPresentationHint(
          lines.join('\n') + moreLine(result.body, 'raise max to see more.'),
          'a table (Run, State, Ref, Started by, When) usually scans faster than this flat list.'
        )
      );
    }
  );

  server.registerTool(
    'bitbucket_get_pipeline',
    {
      title: 'Bitbucket · Read — Get a pipeline run',
      description:
        'One pipeline run with its steps and their states. Step uuids feed ' +
        'bitbucket_get_pipeline_step_log.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        pipelineUuid: z.string().min(1).describe('From bitbucket_list_pipelines'),
      }),
    },
    async (args: Record<string, any>) => {
      const workspace = str(args.workspace);
      const repoSlug = str(args.repoSlug);
      const base = `${repoPath(workspace, repoSlug)}/pipelines/${uuidSegment(str(args.pipelineUuid))}`;
      const scopes = bitbucketScopeFor('bitbucket_get_pipeline');
      const [pipelineResult, stepsResult] = await Promise.all([
        bbJson(auth, scopes, base),
        bbJson(auth, scopes, `${base}/steps?pagelen=50`),
      ]);
      if (!pipelineResult.ok) return errText(pipelineResult.error);
      const pipeline = pipelineResult.body;
      const target = rec(pipeline.target);
      const lines = [
        `Run #${num(pipeline.build_number)} — ${stateOf(pipeline)}`,
        `Target: ${str(target.ref_name) || str(rec(target.commit).hash)}`,
        `Started by: ${str(rec(pipeline.creator).display_name) || '(scheduler)'}`,
        `Created: ${str(pipeline.created_on)}`,
        ...(num(pipeline.duration_in_seconds)
          ? [`Duration: ${num(pipeline.duration_in_seconds)}s`]
          : []),
      ];
      if (stepsResult.ok) {
        const steps = values(stepsResult.body).map(
          (step) =>
            `  ${str(step.name) || '(unnamed step)'} — ${
              str(rec(rec(step.state).result).name) || str(rec(step.state).name)
            } — uuid: ${str(step.uuid)}`
        );
        if (steps.length > 0) lines.push('', 'Steps:', ...steps);
      }
      lines.push(
        '',
        `[Open in Bitbucket](${pipelineUrl(workspace, repoSlug, num(pipeline.build_number))})`
      );
      return textResult(lines.join('\n'));
    }
  );

  server.registerTool(
    'bitbucket_get_pipeline_step_log',
    {
      title: 'Bitbucket · Read — Read a pipeline step’s log',
      description:
        'The log of one pipeline step — the tail by default, where the failure usually is.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        pipelineUuid: z.string().min(1).describe('From bitbucket_list_pipelines'),
        stepUuid: z.string().min(1).describe('From bitbucket_get_pipeline'),
        maxChars: z
          .number()
          .int()
          .min(500)
          .max(100_000)
          .describe('How much of the tail to return (default 20000)')
          .optional(),
      }),
    },
    async (args: Record<string, any>) => {
      const result = await bbRawText(
        auth,
        bitbucketScopeFor('bitbucket_get_pipeline_step_log'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}/pipelines/` +
          `${uuidSegment(str(args.pipelineUuid))}/steps/${uuidSegment(str(args.stepUuid))}/log`
      );
      if (!result.ok) return errText(result.error);
      if (!result.text) return textResult('(empty log)');
      const maxChars = typeof args.maxChars === 'number' ? args.maxChars : 20_000;
      const tail =
        result.text.length > maxChars
          ? `… (${result.text.length - maxChars} earlier characters omitted)\n` +
            result.text.slice(-maxChars)
          : result.text;
      return textResult(tail);
    }
  );

  // ——— Trigger (with preview) ———————————————————————————————————————

  const triggerSchema = z.object({
    workspace: workspaceArg,
    repoSlug: repoArg,
    ref: z.string().min(1).describe('Branch or tag to run on'),
    refType: z.enum(['branch', 'tag']).describe('Default branch').optional(),
    pattern: z
      .string()
      .describe(
        'A custom pipeline definition to run (the name under `custom:` in ' +
          'bitbucket-pipelines.yml); omitted, the ref’s default pipeline runs'
      )
      .optional(),
  });

  const triggerHandler = async (args: Record<string, any>) => {
    const workspace = str(args.workspace);
    const repoSlug = str(args.repoSlug);
    const target: Record<string, unknown> = {
      type: 'pipeline_ref_target',
      ref_type: str(args.refType) || 'branch',
      ref_name: str(args.ref),
      ...(str(args.pattern)
        ? {
            selector: { type: 'custom', pattern: str(args.pattern) },
          }
        : {}),
    };
    const result = await bbJson(
      auth,
      bitbucketScopeFor('bitbucket_trigger_pipeline'),
      `${repoPath(workspace, repoSlug)}/pipelines`,
      { method: 'POST', json: { target } }
    );
    if (!result.ok) return errText(result.error);
    const buildNumber = num(result.body.build_number);
    const url = pipelineUrl(workspace, repoSlug, buildNumber);
    return {
      content: [
        {
          type: 'text' as const,
          text:
            `Pipeline run #${buildNumber} started on ${str(args.ref)}` +
            ` (uuid ${str(result.body.uuid)}).\n\n[Open in Bitbucket](${url})`,
        },
      ],
      _meta: actMeta({ id: `#${buildNumber}`, url }),
    };
  };

  server.registerTool(
    'bitbucket_trigger_pipeline',
    {
      title: 'Bitbucket · Act — Run a pipeline',
      description:
        'Start a pipeline on a branch or tag — the ref’s default pipeline, or a named custom ' +
        'one. Prefer bitbucket_trigger_pipeline_preview whenever the user should confirm ' +
        'first: a run spends build minutes and can deploy.',
      annotations: { readOnlyHint: false },
      inputSchema: triggerSchema,
    },
    triggerHandler
  );

  server.registerTool(
    'bitbucket_trigger_pipeline_preview',
    {
      title: 'Bitbucket · Act — Preview a pipeline run before starting it',
      description:
        'Show the user an interactive card confirming a pipeline run. Prefer this over ' +
        'bitbucket_trigger_pipeline whenever the user should confirm — the card does the ' +
        'starting.',
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
              `The pipeline run on ${str(args.ref)} is awaiting the user's decision on the ` +
              `preview card. Do not start it another way; the user confirms or cancels from ` +
              `the card. If no card appeared in this client, ask the user how to proceed.`,
          },
        ],
        structuredContent: {
          kind: 'issue',
          previewId: newPreviewId(),
          title: 'Run pipeline',
          subtitle: `${str(args.workspace)}/${str(args.repoSlug)}`,
          confirmTool: 'bitbucket_trigger_pipeline_confirm',
          confirmLabel: 'Run pipeline',
          confirmArgs: args,
          fields: [
            { label: str(args.refType) === 'tag' ? 'Tag' : 'Branch', value: str(args.ref) },
            {
              label: 'Pipeline',
              value: str(args.pattern) ? `custom: ${str(args.pattern)}` : 'default for this ref',
            },
          ],
        },
      };
    }
  );

  server.registerTool(
    'bitbucket_trigger_pipeline_confirm',
    {
      title: 'Bitbucket · Act — Run a previewed pipeline (card only)',
      description:
        'Start a pipeline run the user approved on a preview card.' +
        confirmGuard('bitbucket_trigger_pipeline_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: triggerSchema,
    },
    triggerHandler
  );

  server.registerTool(
    'bitbucket_stop_pipeline',
    {
      title: 'Bitbucket · Act — Stop a running pipeline',
      description: 'Stop a pipeline run that is still in progress.',
      annotations: { readOnlyHint: false },
      inputSchema: z.object({
        workspace: workspaceArg,
        repoSlug: repoArg,
        pipelineUuid: z.string().min(1).describe('From bitbucket_list_pipelines'),
      }),
    },
    async (args: Record<string, any>) => {
      const response = await auth.fetch(
        bitbucketScopeFor('bitbucket_stop_pipeline'),
        `${repoPath(str(args.workspace), str(args.repoSlug))}/pipelines/` +
          `${uuidSegment(str(args.pipelineUuid))}/stopPipeline`,
        { method: 'POST' }
      );
      if (!response.ok) return errText(await describeBitbucketFailure(response));
      return {
        content: [{ type: 'text' as const, text: 'Pipeline stop requested.' }],
        _meta: actMeta({ id: str(args.pipelineUuid) }),
      };
    }
  );
}
