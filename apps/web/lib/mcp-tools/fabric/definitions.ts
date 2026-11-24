/**
 * Reading a notebook's or a data pipeline's definition. Fabric serves a
 * definition as a long-running operation: it may answer at once, or hand
 * back an operation that finishes seconds or minutes later. The tool
 * starts a Fabric operation row (@renkei/connector-fabric), waits a short
 * while for it in place, and — if Fabric is still working — answers with
 * where it will appear: the operation's page, which streams it in while
 * the person watches, and a notification when they are not
 * (apps/worker's Fabric sweep). `fabric_get_operation` reads it later.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  advanceIfDue,
  kindLabel,
  mainPart,
  notebookAsText,
  pipelineAsText,
  startDefinitionOperation,
} from '@renkei/connector-fabric';
import { getDataStore, type FabricOperationRecord } from '@renkei/db';
import type { MCPToolContext } from '../common';
import type { FabricAuth } from './fabric-auth';
import type { FabricAccess } from './client';
import { errText, textResult } from './client';
import { resolveItem, resolveWorkspace } from './resolve';
import { workspaceField } from './reads';

/** How long a tool call waits for Fabric before answering "still working". */
const INLINE_WAIT_MS = 20_000;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The page a person watches an operation on. */
export function operationPath(id: string): string {
  return `/fabric/operations/${id}`;
}

/** Poll an operation in place until it ends or the wait runs out. */
export async function waitInline(
  operation: FabricOperationRecord,
  access: FabricAccess,
  budgetMs = INLINE_WAIT_MS
): Promise<FabricOperationRecord> {
  let current = operation;
  const deadline = Date.now() + budgetMs;
  while (current.status === 'running') {
    const dueIn = (current.nextPollAt?.getTime() ?? Date.now()) - Date.now();
    if (Date.now() + Math.max(dueIn, 0) > deadline) break;
    if (dueIn > 0) await sleep(dueIn);
    const advanced = await advanceIfDue(current.id, access.fetcher, access.base, new Date());
    if (advanced?.operation) current = advanced.operation;
    else {
      // Another poller holds it (the person's open page): read what it wrote.
      const reread = await getDataStore().fabricOperations.find(current.subject, current.id);
      if (!reread) break;
      current = reread;
      if (current.status === 'running') await sleep(1000);
    }
  }
  return current;
}

/** What the model reads for an operation, finished or not. */
export function describeOperation(operation: FabricOperationRecord, origin?: string): string {
  const what = `the ${kindLabel(operation.kind)} "${operation.itemName}" in "${operation.workspaceName}"`;
  const link = `${origin ?? ''}${operationPath(operation.id)}`;
  if (operation.status === 'running') {
    const progress =
      operation.percentComplete !== null ? ` (${operation.percentComplete}% so far)` : '';
    return (
      `Fabric is still preparing the definition of ${what}${progress}. Operation ${operation.id}. ` +
      `It appears at ${link} as soon as it is ready, and the person is notified if they are not ` +
      'watching. Call fabric_get_operation with this id to read it later.'
    );
  }
  if (operation.status === 'failed') {
    return `Fabric could not give the definition of ${what}: ${operation.error ?? 'no reason given'}.`;
  }
  const result = operation.result;
  const part = result ? mainPart(result) : null;
  if (!part?.text) return `The definition of ${what} came back with no readable content. ${link}`;
  const body =
    operation.kind === 'notebook-definition' && part.path.endsWith('.ipynb')
      ? notebookAsText(part.text)
      : operation.kind === 'pipeline-definition'
        ? pipelineAsText(part.text)
        : part.text;
  return `Definition of ${what} (${part.path}; also at ${link}):\n\n${body}`;
}

export async function registerDefinitionTools(
  server: McpServer,
  context: MCPToolContext,
  auth: FabricAuth
): Promise<void> {
  async function fetchDefinition(
    kind: 'notebook-definition' | 'pipeline-definition',
    workspaceRef: string,
    itemRef: string,
    format: string | null
  ) {
    const access = await auth.resolve();
    if (typeof access === 'string') return errText(access);
    if (!context.subject) return errText('No signed-in identity on this request.');
    const workspace = await resolveWorkspace(context, access, workspaceRef);
    if (typeof workspace === 'string') return errText(workspace);
    const item = await resolveItem(
      context,
      access,
      workspace,
      kind === 'notebook-definition' ? 'Notebook' : 'DataPipeline',
      itemRef
    );
    if (typeof item === 'string') return errText(item);
    const started = await startDefinitionOperation({
      id: randomUUID(),
      subject: context.subject,
      kind,
      workspaceId: workspace.id,
      workspaceName: workspace.displayName,
      itemId: item.id,
      itemName: item.displayName,
      format,
      fetcher: access.fetcher,
      base: access.base,
      now: new Date(),
    });
    if (!started.ok) return errText(`Could not get the definition: ${started.error}`);
    const settled = await waitInline(started.operation, access);
    const text = describeOperation(settled, context.origin);
    return settled.status === 'failed' ? errText(text) : textResult(text);
  }

  server.registerTool(
    'fabric_get_notebook_definition',
    {
      title: 'Fabric · Read a notebook',
      description:
        "A Fabric notebook's code: its cells in order (as Jupyter .ipynb by default). Fabric " +
        'may take a while to prepare it; if it is not ready within about 20 seconds this ' +
        'answers with an operation id and a page where it appears, and the person is notified ' +
        'when it is ready.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspace: workspaceField,
        notebook: z.string().min(1).describe('The notebook: its id or exact name.'),
        format: z
          .enum(['ipynb', 'fabricGitSource'])
          .optional()
          .describe(
            'ipynb (Jupyter, the default) or fabricGitSource (the .py/.scala/.sql form Fabric ' +
              'commits to git).'
          ),
      }),
    },
    async ({ workspace, notebook, format }) =>
      fetchDefinition('notebook-definition', workspace, notebook, format ?? 'ipynb')
  );

  server.registerTool(
    'fabric_get_pipeline_definition',
    {
      title: 'Fabric · Read a data pipeline',
      description:
        "A Fabric data pipeline's definition: its activities, what each depends on, and the " +
        'pipeline-content.json. Like a notebook, Fabric may finish this later — the answer then ' +
        'names the operation and where it appears.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        workspace: workspaceField,
        pipeline: z.string().min(1).describe('The data pipeline: its id or exact name.'),
      }),
    },
    async ({ workspace, pipeline }) =>
      fetchDefinition('pipeline-definition', workspace, pipeline, null)
  );

  server.registerTool(
    'fabric_get_operation',
    {
      title: 'Fabric · Check a definition fetch',
      description:
        'Where a definition fetch fabric_get_notebook_definition or ' +
        'fabric_get_pipeline_definition started stands now — still running, failed and why, ' +
        'or the definition itself.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        operationId: z.string().uuid().describe('The operation id the earlier call gave.'),
      }),
    },
    async ({ operationId }) => {
      if (!context.subject) return errText('No signed-in identity on this request.');
      const store = getDataStore().fabricOperations;
      let operation = await store.find(context.subject, operationId);
      if (!operation) return errText(`No Fabric operation ${operationId} of yours.`);
      if (operation.status === 'running') {
        const access = await auth.resolve();
        if (typeof access !== 'string') {
          const advanced = await advanceIfDue(
            operation.id,
            access.fetcher,
            access.base,
            new Date()
          );
          if (advanced?.operation) operation = advanced.operation;
        }
      }
      const text = describeOperation(operation, context.origin);
      return operation.status === 'failed' ? errText(text) : textResult(text);
    }
  );
}
