/**
 * The fabric_ writes: create and change workspaces, notebooks and data
 * pipelines. Every one is preview + confirm on the directory_action_preview
 * card — the Entra Developer rule: a notebook's content is replaced whole
 * (Fabric keeps no history behind updateDefinition), and a workspace is
 * where a team's work lives. The preview resolves every reference and
 * checks what will be sent; the confirm acts on the ids the preview
 * resolved, never on names again.
 *
 * Creating an item and replacing a definition are long-running in Fabric
 * too; the confirm waits for them in place (they are quick in practice)
 * and, when Fabric is slower than that, says the change is still being
 * applied rather than claiming it landed.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  encodeDefinition,
  notebookCells,
  notebookLanguage,
  notebookProblem,
  pipelineActivities,
  pipelineProblem,
  pollOperation,
  type FabricAnswer,
} from '@renkei/connector-fabric';
import type { MCPToolContext } from '../common';
import {
  APP_ONLY_META,
  DIRECTORY_ACTION_PREVIEW_URI,
  confirmGuard,
  newPreviewId,
  previewToolMeta,
} from '../widgets';
import { previewResult, type DirectoryActionPreview } from '../entra-developer/provision';
import type { FabricAuth } from './fabric-auth';
import { errText, fabricCall, portalLink, str, textResult, type FabricAccess } from './client';
import { resolveCapacity, resolveItem, resolveWorkspace, type Workspace } from './resolve';
import { workspaceField } from './reads';

/** How long a confirm waits for Fabric to apply a long-running change. */
const APPLY_WAIT_MS = 30_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Applied =
  | { state: 'done'; body: Record<string, unknown> }
  | { state: 'running'; operationId: string }
  | { state: 'failed'; error: string };

/** Follow a write Fabric answered 202 to until it ends or the wait runs out. */
async function applied(
  access: FabricAccess,
  answer: FabricAnswer,
  withResult: boolean
): Promise<Applied> {
  if (!answer.ok) return { state: 'failed', error: answer.error };
  if (!answer.pending) return { state: 'done', body: answer.body };
  const deadline = Date.now() + APPLY_WAIT_MS;
  let wait = answer.pending.retryAfterSeconds * 1000;
  while (Date.now() + wait <= deadline) {
    await sleep(wait);
    const state = await pollOperation(
      access.fetcher,
      access.base,
      answer.pending.operationId,
      withResult
    );
    if (state.state === 'succeeded') return { state: 'done', body: state.result ?? {} };
    if (state.state === 'failed') return { state: 'failed', error: state.error };
    wait = state.retryAfterSeconds * 1000;
  }
  return { state: 'running', operationId: answer.pending.operationId };
}

const stillApplying = (what: string, operationId: string) =>
  `Fabric accepted ${what} and is still applying it (operation ${operationId}); check Fabric in a minute before changing it again.`;

function notebookSummary(ipynb: string): string {
  const cells = notebookCells(ipynb) ?? [];
  const code = cells.filter((c) => c.kind === 'code').length;
  const language = notebookLanguage(ipynb);
  return `${cells.length} cell(s): ${code} code, ${cells.length - code} markdown/raw${language ? ` · ${language}` : ''}`;
}

function pipelineSummary(json: string): { line: string; activities: string[] } {
  const activities = pipelineActivities(json) ?? [];
  return {
    line: `${activities.length} activit${activities.length === 1 ? 'y' : 'ies'}`,
    activities: activities.map(
      (a) => `${a.name} (${a.type})${a.dependsOn.length ? ` after ${a.dependsOn.join(', ')}` : ''}`
    ),
  };
}

const ipynbField = z
  .string()
  .min(2)
  .optional()
  .describe(
    'The notebook as Jupyter JSON (nbformat 4, a "cells" list) — the whole notebook; it ' +
      'replaces what is there.'
  );

const pipelineJsonField = z
  .string()
  .min(2)
  .optional()
  .describe(
    'The pipeline as its pipeline-content.json: { "properties": { "activities": [...] } } — ' +
      'the whole definition; it replaces what is there.'
  );

export async function registerWriteTools(
  server: McpServer,
  context: MCPToolContext,
  auth: FabricAuth
): Promise<void> {
  const subtitle = (access: FabricAccess, where?: string) =>
    `Microsoft Fabric · ${where ? `${where} · ` : ''}${access.upn || 'your account'}`;

  // -------------------------------------------------------------------
  // Workspaces
  // -------------------------------------------------------------------

  server.registerTool(
    'fabric_create_workspace_preview',
    {
      title: 'Fabric · Act — Preview creating a workspace',
      description:
        'Show the user a card to confirm or cancel creating a Fabric workspace, optionally on ' +
        'a capacity (by name or id; fabric_list_capacities lists them). The only way to create ' +
        'a workspace here — the user decides on the card.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: z.object({
        displayName: z
          .string()
          .min(1)
          .max(256)
          .describe('The new workspace’s name (unused in Fabric).'),
        description: z.string().max(4000).optional(),
        capacity: z
          .string()
          .optional()
          .describe('The capacity to put it on, by name or id. Without one it has no capacity.'),
      }),
    },
    async ({ displayName, description, capacity: capacityRef }) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const capacity = capacityRef ? await resolveCapacity(context, access, capacityRef) : null;
      if (typeof capacity === 'string') return errText(capacity);
      return previewResult({
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Create workspace',
        tone: 'positive',
        title: `Create ${displayName}`,
        subtitle: subtitle(access),
        person: { name: displayName, detail: 'New Fabric workspace' },
        fields: [
          ...(description ? [{ label: 'Description', value: description }] : []),
          {
            label: 'Capacity',
            value: capacity
              ? `${capacity.displayName} (${capacity.sku}, ${capacity.region})`
              : 'None',
          },
        ],
        confirmTool: 'fabric_create_workspace_confirm',
        confirmLabel: 'Create workspace',
        confirmArgs: {
          displayName,
          description: description ?? '',
          capacityId: capacity?.id ?? '',
        },
      });
    }
  );

  server.registerTool(
    'fabric_create_workspace_confirm',
    {
      title: 'Fabric · Act — Create a workspace',
      description:
        'Create the Fabric workspace the preview card showed.' +
        confirmGuard('fabric_create_workspace_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: z.object({
        displayName: z.string().min(1).max(256),
        description: z.string().max(4000),
        capacityId: z.string(),
      }),
    },
    async ({ displayName, description, capacityId }) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const answer = await fabricCall(context, access, 'POST', '/workspaces', {
        displayName,
        ...(description ? { description } : {}),
        ...(capacityId ? { capacityId } : {}),
      });
      if (!answer.ok) return errText(`Could not create the workspace: ${answer.error}`);
      const id = str(answer.body.id);
      return textResult(
        `Created workspace "${str(answer.body.displayName) || displayName}" — id ${id}. ` +
          `Open it in Fabric: ${portalLink(id)}`
      );
    }
  );

  server.registerTool(
    'fabric_update_workspace_preview',
    {
      title: 'Fabric · Act — Preview changing a workspace',
      description:
        'Show the user a card to confirm or cancel renaming a Fabric workspace or changing its ' +
        'description (you must be its admin). Shows old against new.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: z.object({
        workspace: workspaceField,
        displayName: z.string().min(1).max(256).optional().describe('The new name.'),
        description: z
          .string()
          .max(4000)
          .optional()
          .describe('The new description ("" clears it).'),
      }),
    },
    async ({ workspace: ref, displayName, description }) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      if (displayName === undefined && description === undefined) {
        return errText('Say what to change: a new displayName, a description, or both.');
      }
      const workspace = await resolveWorkspace(context, access, ref);
      if (typeof workspace === 'string') return errText(workspace);
      return previewResult({
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Change workspace',
        tone: 'caution',
        title: `Change ${workspace.displayName}`,
        subtitle: subtitle(access),
        person: { name: workspace.displayName, detail: `Workspace ${workspace.id}` },
        fields: [
          ...(displayName !== undefined
            ? [{ label: 'Name', value: displayName, oldValue: workspace.displayName }]
            : []),
          ...(description !== undefined
            ? [
                {
                  label: 'Description',
                  value: description || '(none)',
                  oldValue: workspace.description || '(none)',
                },
              ]
            : []),
        ],
        confirmTool: 'fabric_update_workspace_confirm',
        confirmLabel: 'Save changes',
        confirmArgs: {
          workspaceId: workspace.id,
          ...(displayName !== undefined ? { displayName } : {}),
          ...(description !== undefined ? { description } : {}),
        },
      });
    }
  );

  server.registerTool(
    'fabric_update_workspace_confirm',
    {
      title: 'Fabric · Act — Change a workspace',
      description:
        'Apply the workspace change the preview card showed.' +
        confirmGuard('fabric_update_workspace_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: z.object({
        workspaceId: z.string().uuid(),
        displayName: z.string().min(1).max(256).optional(),
        description: z.string().max(4000).optional(),
      }),
    },
    async ({ workspaceId, displayName, description }) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      const answer = await fabricCall(context, access, 'PATCH', `/workspaces/${workspaceId}`, {
        ...(displayName !== undefined ? { displayName } : {}),
        ...(description !== undefined ? { description } : {}),
      });
      if (!answer.ok) return errText(`Could not change the workspace: ${answer.error}`);
      return textResult(
        `Saved workspace "${str(answer.body.displayName) || displayName || workspaceId}". ${portalLink(workspaceId)}`
      );
    }
  );

  // -------------------------------------------------------------------
  // Notebooks and data pipelines: one shape, two kinds
  // -------------------------------------------------------------------

  interface ItemKind {
    type: 'Notebook' | 'DataPipeline';
    noun: string;
    collection: 'notebooks' | 'dataPipelines';
    prefix: 'notebook' | 'pipeline';
    contentKey: 'ipynb' | 'pipelineJson';
    problem: (content: string) => string | null;
    parts: (content: string) => Record<string, unknown>;
    contentFields: (content: string) => {
      fields: DirectoryActionPreview['fields'];
      groupLists?: DirectoryActionPreview['groupLists'];
    };
  }

  const NOTEBOOK: ItemKind = {
    type: 'Notebook',
    noun: 'notebook',
    collection: 'notebooks',
    prefix: 'notebook',
    contentKey: 'ipynb',
    problem: notebookProblem,
    parts: (ipynb) => encodeDefinition([{ path: 'notebook-content.ipynb', text: ipynb }], 'ipynb'),
    contentFields: (ipynb) => ({ fields: [{ label: 'Content', value: notebookSummary(ipynb) }] }),
  };

  const PIPELINE: ItemKind = {
    type: 'DataPipeline',
    noun: 'data pipeline',
    collection: 'dataPipelines',
    prefix: 'pipeline',
    contentKey: 'pipelineJson',
    problem: pipelineProblem,
    parts: (json) => encodeDefinition([{ path: 'pipeline-content.json', text: json }]),
    contentFields: (json) => {
      const summary = pipelineSummary(json);
      return {
        fields: [{ label: 'Content', value: summary.line }],
        groupLists: summary.activities.length
          ? [{ label: 'Activities', groups: summary.activities, tone: 'add' }]
          : undefined,
      };
    },
  };

  for (const kind of [NOTEBOOK, PIPELINE]) {
    const createPreview = `fabric_create_${kind.prefix}_preview`;
    const createConfirm = `fabric_create_${kind.prefix}_confirm`;
    const updatePreview = `fabric_update_${kind.prefix}_preview`;
    const updateConfirm = `fabric_update_${kind.prefix}_confirm`;
    const contentField = kind === NOTEBOOK ? ipynbField : pipelineJsonField;
    const itemField = z.string().min(1).describe(`The ${kind.noun}: its id or exact name.`);

    server.registerTool(
      createPreview,
      {
        title: `Fabric · Act — Preview creating a ${kind.noun}`,
        description:
          `Show the user a card to confirm or cancel creating a ${kind.noun} in a Fabric ` +
          `workspace, empty or with the content given. The only way to create a ${kind.noun} ` +
          'here — the user decides on the card.',
        annotations: { readOnlyHint: false },
        _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
        inputSchema: z.object({
          workspace: workspaceField,
          displayName: z.string().min(1).max(256).describe(`The new ${kind.noun}’s name.`),
          description: z.string().max(4000).optional(),
          [kind.contentKey]: contentField,
        }),
      },
      async (args: Record<string, unknown>) => {
        const access = await auth.resolve();
        if (typeof access === 'string') return errText(access);
        const content = typeof args[kind.contentKey] === 'string' ? str(args[kind.contentKey]) : '';
        const problem = content ? kind.problem(content) : null;
        if (problem) return errText(problem);
        const workspace = await resolveWorkspace(context, access, str(args.workspace));
        if (typeof workspace === 'string') return errText(workspace);
        const displayName = str(args.displayName);
        const description = str(args.description);
        const shown = content
          ? kind.contentFields(content)
          : { fields: [{ label: 'Content', value: 'Empty' }] };
        return previewResult({
          kind: 'directory_action',
          previewId: newPreviewId(),
          action: `Create ${kind.noun}`,
          tone: 'positive',
          title: `Create ${displayName}`,
          subtitle: subtitle(access, workspace.displayName),
          person: { name: displayName, detail: `New ${kind.noun} in ${workspace.displayName}` },
          fields: [
            ...(description ? [{ label: 'Description', value: description }] : []),
            ...(shown.fields ?? []),
          ],
          groupLists: shown.groupLists,
          confirmTool: createConfirm,
          confirmLabel: `Create ${kind.noun}`,
          confirmArgs: {
            workspaceId: workspace.id,
            workspaceName: workspace.displayName,
            displayName,
            description,
            content,
          },
        });
      }
    );

    server.registerTool(
      createConfirm,
      {
        title: `Fabric · Act — Create a ${kind.noun}`,
        description:
          `Create the ${kind.noun} the preview card showed.` + confirmGuard(createPreview),
        annotations: { readOnlyHint: false },
        _meta: APP_ONLY_META,
        inputSchema: z.object({
          workspaceId: z.string().uuid(),
          workspaceName: z.string(),
          displayName: z.string().min(1).max(256),
          description: z.string().max(4000),
          content: z.string(),
        }),
      },
      async ({ workspaceId, workspaceName, displayName, description, content }) => {
        const access = await auth.resolve();
        if (typeof access === 'string') return errText(access);
        const problem = content ? kind.problem(content) : null;
        if (problem) return errText(problem);
        const answer = await fabricCall(
          context,
          access,
          'POST',
          `/workspaces/${workspaceId}/${kind.collection}`,
          {
            displayName,
            ...(description ? { description } : {}),
            ...(content ? { definition: kind.parts(content) } : {}),
          }
        );
        const outcome = await applied(access, answer, true);
        if (outcome.state === 'failed')
          return errText(`Could not create the ${kind.noun}: ${outcome.error}`);
        if (outcome.state === 'running') {
          return textResult(
            stillApplying(`the new ${kind.noun} "${displayName}"`, outcome.operationId)
          );
        }
        const id = str(outcome.body.id);
        return textResult(
          `Created ${kind.noun} "${displayName}" in "${workspaceName}"${id ? ` — id ${id}` : ''}. ` +
            (id ? `Open it in Fabric: ${portalLink(workspaceId, { type: kind.type, id })}` : '')
        );
      }
    );

    server.registerTool(
      updatePreview,
      {
        title: `Fabric · Act — Preview changing a ${kind.noun}`,
        description:
          `Show the user a card to confirm or cancel renaming a Fabric ${kind.noun}, changing ` +
          `its description, or replacing its whole content. Read it first ` +
          `(fabric_get_${kind.prefix}_definition) and send it back changed — the content given ` +
          'replaces what is there.',
        annotations: { readOnlyHint: false },
        _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
        inputSchema: z.object({
          workspace: workspaceField,
          [kind.prefix]: itemField,
          displayName: z.string().min(1).max(256).optional().describe('The new name.'),
          description: z.string().max(4000).optional().describe('The new description.'),
          [kind.contentKey]: contentField,
        }),
      },
      async (args: Record<string, unknown>) => {
        const access = await auth.resolve();
        if (typeof access === 'string') return errText(access);
        const content = typeof args[kind.contentKey] === 'string' ? str(args[kind.contentKey]) : '';
        const displayName = typeof args.displayName === 'string' ? args.displayName : undefined;
        const description = typeof args.description === 'string' ? args.description : undefined;
        if (!content && displayName === undefined && description === undefined) {
          return errText(
            `Say what to change: a new displayName, a description, or the ${kind.noun}’s content.`
          );
        }
        const problem = content ? kind.problem(content) : null;
        if (problem) return errText(problem);
        const workspace: Workspace | string = await resolveWorkspace(
          context,
          access,
          str(args.workspace)
        );
        if (typeof workspace === 'string') return errText(workspace);
        const item = await resolveItem(
          context,
          access,
          workspace,
          kind.type,
          str(args[kind.prefix])
        );
        if (typeof item === 'string') return errText(item);
        const shown = content ? kind.contentFields(content) : { fields: [] };
        return previewResult({
          kind: 'directory_action',
          previewId: newPreviewId(),
          action: `Change ${kind.noun}`,
          tone: 'caution',
          title: `Change ${item.displayName}`,
          subtitle: subtitle(access, workspace.displayName),
          person: {
            name: item.displayName,
            detail: `${kind.noun[0].toUpperCase()}${kind.noun.slice(1)} ${item.id}`,
          },
          fields: [
            ...(displayName !== undefined
              ? [{ label: 'Name', value: displayName, oldValue: item.displayName }]
              : []),
            ...(description !== undefined
              ? [
                  {
                    label: 'Description',
                    value: description || '(none)',
                    oldValue: item.description || '(none)',
                  },
                ]
              : []),
            ...(content
              ? [
                  {
                    label: 'Replaces',
                    value: 'The whole current content — Fabric keeps no earlier version',
                  },
                ]
              : []),
            ...(shown.fields ?? []),
          ],
          groupLists: shown.groupLists,
          confirmTool: updateConfirm,
          confirmLabel: 'Save changes',
          confirmArgs: {
            workspaceId: workspace.id,
            itemId: item.id,
            itemName: item.displayName,
            ...(displayName !== undefined ? { displayName } : {}),
            ...(description !== undefined ? { description } : {}),
            content,
          },
        });
      }
    );

    server.registerTool(
      updateConfirm,
      {
        title: `Fabric · Act — Change a ${kind.noun}`,
        description:
          `Apply the ${kind.noun} change the preview card showed.` + confirmGuard(updatePreview),
        annotations: { readOnlyHint: false },
        _meta: APP_ONLY_META,
        inputSchema: z.object({
          workspaceId: z.string().uuid(),
          itemId: z.string().uuid(),
          itemName: z.string(),
          displayName: z.string().min(1).max(256).optional(),
          description: z.string().max(4000).optional(),
          content: z.string(),
        }),
      },
      async ({ workspaceId, itemId, itemName, displayName, description, content }) => {
        const access = await auth.resolve();
        if (typeof access === 'string') return errText(access);
        const problem = content ? kind.problem(content) : null;
        if (problem) return errText(problem);
        const base = `/workspaces/${workspaceId}/${kind.collection}/${itemId}`;
        const done: string[] = [];
        if (displayName !== undefined || description !== undefined) {
          const answer = await fabricCall(context, access, 'PATCH', base, {
            ...(displayName !== undefined ? { displayName } : {}),
            ...(description !== undefined ? { description } : {}),
          });
          if (!answer.ok)
            return errText(
              `Could not change the ${kind.noun}'s name or description: ${answer.error}`
            );
          done.push(
            displayName !== undefined ? `renamed to "${displayName}"` : 'description saved'
          );
        }
        if (content) {
          const answer = await fabricCall(context, access, 'POST', `${base}/updateDefinition`, {
            definition: kind.parts(content),
          });
          const outcome = await applied(access, answer, false);
          if (outcome.state === 'failed') {
            return errText(
              `${done.length ? `The ${kind.noun} was ${done.join(' and ')}, but its` : 'The'} content was not replaced: ${outcome.error}`
            );
          }
          if (outcome.state === 'running') {
            return textResult(
              [
                done.length ? `The ${kind.noun} was ${done.join(' and ')}.` : '',
                stillApplying('the new content', outcome.operationId),
              ]
                .filter(Boolean)
                .join(' ')
            );
          }
          done.push('content replaced');
        }
        return textResult(
          `${kind.noun[0].toUpperCase()}${kind.noun.slice(1)} "${displayName ?? itemName}": ${done.join(', ')}. ` +
            portalLink(workspaceId, { type: kind.type, id: itemId })
        );
      }
    );
  }
}
