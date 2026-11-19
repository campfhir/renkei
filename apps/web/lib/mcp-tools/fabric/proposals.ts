/**
 * The fabric_ writes, as pull requests. Nothing here changes Fabric: a
 * change is committed to a code project's repository in Fabric's git format
 * (lib/fabric/repo.ts) and reaches Fabric when someone merges it to an
 * environment's branch and the project's pipeline runs its "Fabric: deploy
 * items to a workspace" block (packages/db migration 189), which also makes
 * the environment's workspace exist under its name.
 *
 *   - fabric_propose_items: notebooks and data pipelines, new or changed,
 *     written as their item folders.
 *   - fabric_export_items: items as they are in a workspace (their
 *     definitions in Fabric's git source format) brought into the
 *     repository — how a workspace built by hand starts being deployed.
 *   - fabric_setup_pipeline: the workspace and capacity each environment
 *     deploys to, written into the project's pipeline (the pipeline
 *     builder's own pull request).
 *
 * Each is preview + confirm on the directory_action_preview card. The
 * preview resolves every reference; the confirm acts on what it resolved.
 */

import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import {
  DEFAULT_ITEMS_DIRECTORY,
  itemFolderName,
  itemsDirectory,
  kindLabel,
  notebookAsSource,
  pipelineActivities,
  repoFilesForItem,
  repoFilesFromDefinition,
  startDefinitionOperation,
  type RepoFile,
  type RepoItemType,
} from '@renkei/connector-fabric';
import type { MCPToolContext } from '../common';
import {
  APP_ONLY_META,
  DIRECTORY_ACTION_PREVIEW_URI,
  confirmGuard,
  newPreviewId,
  previewToolMeta,
} from '../widgets';
import { previewResult } from '../entra-developer/provision';
import {
  existingLogicalId,
  proposalBase,
  proposalBranch,
  proposeFiles,
  resolveRepoProject,
  type RepoProject,
} from '@/lib/fabric/repo';
import {
  fabricBlockVersions,
  planFabricPipeline,
  savedSpec,
  writeFabricPipeline,
  type FabricEnvironment,
} from '@/lib/fabric/pipeline';
import type { FabricAuth } from './fabric-auth';
import { errText, isGuid, textResult } from './client';
import { resolveCapacity, resolveItem, resolveWorkspace } from './resolve';
import { workspaceField } from './reads';
import { waitInline } from './definitions';

const projectField = z
  .string()
  .min(1)
  .describe('The code project (a Bitbucket or GitHub repository in Renkei): its id or exact name.');
const baseField = z
  .string()
  .optional()
  .describe(
    'The branch the pull request goes into; by default the branch of the pipeline’s first ' +
      'environment (usually develop), else the project’s branch.'
  );
const directoryField = z
  .string()
  .optional()
  .describe(`Where the repository keeps its Fabric items; default "${DEFAULT_ITEMS_DIRECTORY}".`);
const itemTypeField = z.enum(['Notebook', 'DataPipeline']);

/** How long the export waits for Fabric to hand over each definition. */
const EXPORT_WAIT_MS = 45_000;

const SCOPE_FOR_TYPE: Record<RepoItemType, string> = {
  Notebook: 'Notebook.ReadWrite.All',
  DataPipeline: 'DataPipeline.ReadWrite.All',
};

function repoLine(repo: RepoProject): string {
  return `${repo.project.name} · ${repo.project.repo.fullName} (${repo.host === 'github' ? 'GitHub' : 'Bitbucket'})`;
}

function contentLine(type: RepoItemType, content: string): string {
  if (type === 'Notebook') {
    const notebook = notebookAsSource(content);
    if (typeof notebook === 'string') return 'unreadable';
    const code = notebook.cells.filter((cell) => cell.kind === 'code').length;
    return `${notebook.cells.length} cell(s), ${code} code`;
  }
  const activities = pipelineActivities(content);
  return activities
    ? `${activities.length} activit${activities.length === 1 ? 'y' : 'ies'}`
    : 'unreadable';
}

const MERGE_NOTE =
  'Merging it to an environment’s branch deploys it to that environment’s Fabric workspace, ' +
  'through the project’s pipeline.';

export async function registerProposalTools(
  server: McpServer,
  context: MCPToolContext,
  auth: FabricAuth
): Promise<void> {
  const caller = () => ({ subject: context.subject ?? '', origin: context.origin ?? '' });

  // -------------------------------------------------------------------
  // Notebooks and pipelines, new or changed.
  // -------------------------------------------------------------------

  const itemInput = z.object({
    type: itemTypeField,
    displayName: z.string().min(1).max(256).describe('The item’s name in Fabric.'),
    description: z.string().max(4000).optional(),
    content: z
      .string()
      .min(2)
      .describe(
        'The whole item. A notebook as Jupyter JSON (nbformat 4, a "cells" list) or in Fabric’s ' +
          'source format ("# Fabric notebook source" — what fabric_get_notebook_definition gives ' +
          'with format fabricGitSource); a data pipeline as its pipeline-content.json.'
      ),
  });
  type ItemInput = z.infer<typeof itemInput>;

  /** The items' files, keeping the logical id of an item the branch already has. */
  async function itemFiles(
    repo: RepoProject,
    base: string,
    directory: string,
    items: (ItemInput & { logicalId?: string })[]
  ): Promise<{ files: RepoFile[]; lines: string[] } | string> {
    const files: RepoFile[] = [];
    const lines: string[] = [];
    for (const item of items) {
      const folder = [directory, itemFolderName(item.displayName, item.type)]
        .filter(Boolean)
        .join('/');
      const kept =
        item.logicalId ?? (await existingLogicalId(caller(), repo, base, `${folder}/.platform`));
      const written = repoFilesForItem(
        {
          type: item.type,
          displayName: item.displayName,
          description: item.description ?? '',
          content: item.content,
          logicalId: kept ?? randomUUID(),
        },
        directory
      );
      if (typeof written === 'string') return `${item.displayName}: ${written}`;
      files.push(...written);
      lines.push(
        `${kept ? 'Replaces' : 'New'} ${folder}/ — ${kindLabel(item.type === 'Notebook' ? 'notebook-definition' : 'pipeline-definition')}, ${contentLine(item.type, item.content)}`
      );
    }
    return { files, lines };
  }

  server.registerTool(
    'fabric_propose_items_preview',
    {
      title: 'Fabric · Act — Preview proposing notebooks or pipelines',
      description:
        'Show the user a card to confirm or cancel a pull request that adds or changes Fabric ' +
        'notebooks and data pipelines in a code project’s repository (Fabric’s git format, one ' +
        `folder per item). Nothing changes in Fabric until it is merged: ${MERGE_NOTE} To change ` +
        'an existing item, read it first (fabric_get_notebook_definition with format ' +
        'fabricGitSource) and send it back whole.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: z.object({
        project: projectField,
        items: z.array(itemInput).min(1).max(10),
        base: baseField,
        itemsDirectory: directoryField,
      }),
    },
    async ({ project: projectRef, items, base: asked, itemsDirectory: dir }) => {
      if (!context.subject) return errText('No signed-in identity on this request.');
      const directory = itemsDirectory(dir);
      if (directory === null)
        return errText('The items directory must be a path inside the repository.');
      const repo = await resolveRepoProject(context.subject, projectRef);
      if (typeof repo === 'string') return errText(repo);
      const base = await proposalBase(repo.project, asked);
      const planned = await itemFiles(repo, base, directory, items);
      if (typeof planned === 'string') return errText(planned);
      const names = items.map((item) => item.displayName).join(', ');
      return previewResult({
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Propose Fabric change',
        tone: 'positive',
        title: `Pull request: ${names}`,
        subtitle: `Microsoft Fabric through CI · ${repoLine(repo)}`,
        person: { name: repo.project.name, detail: `Into ${base}` },
        fields: [
          { label: 'Repository', value: repo.project.repo.fullName },
          { label: 'Pull request into', value: base },
          { label: 'Deploys', value: 'When merged to an environment’s branch, by the pipeline' },
        ],
        groupLists: [{ label: 'Items', groups: planned.lines, tone: 'add' }],
        confirmTool: 'fabric_propose_items_confirm',
        confirmLabel: 'Open pull request',
        confirmArgs: { projectId: repo.project.id, base, itemsDirectory: directory, items },
      });
    }
  );

  server.registerTool(
    'fabric_propose_items_confirm',
    {
      title: 'Fabric · Act — Propose notebooks or pipelines',
      description:
        'Open the pull request the preview card showed.' +
        confirmGuard('fabric_propose_items_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: z.object({
        projectId: z.string().uuid(),
        base: z.string().min(1),
        itemsDirectory: z.string(),
        items: z.array(itemInput).min(1).max(10),
      }),
    },
    async ({ projectId, base, itemsDirectory: dir, items }) => {
      if (!context.subject) return errText('No signed-in identity on this request.');
      const directory = itemsDirectory(dir);
      if (directory === null)
        return errText('The items directory must be a path inside the repository.');
      const repo = await resolveRepoProject(context.subject, projectId);
      if (typeof repo === 'string') return errText(repo);
      const planned = await itemFiles(repo, base, directory, items);
      if (typeof planned === 'string') return errText(planned);
      const names = items.map((item) => item.displayName).join(', ');
      const proposed = await proposeFiles(caller(), repo, {
        files: planned.files,
        base,
        branch: proposalBranch(
          items.length === 1 ? items[0].displayName : 'fabric-items',
          new Date()
        ),
        message: `Fabric: ${names} (Renkei)`,
        title: `Fabric: ${names}`,
        description: [
          `Fabric items, proposed in Renkei:`,
          ...planned.lines.map((l) => `- ${l}`),
          '',
          MERGE_NOTE,
        ].join('\n'),
      });
      if (!proposed.ok) return errText(`Could not open the pull request: ${proposed.error}`);
      return textResult(
        `Opened a pull request into ${base} with ${names}: ${proposed.url}\n${MERGE_NOTE}`
      );
    }
  );

  // -------------------------------------------------------------------
  // Items as they are in a workspace, brought into the repository.
  // -------------------------------------------------------------------

  const exportRef = z.object({
    type: itemTypeField,
    item: z.string().min(1).describe('The item in the workspace: its id or exact name.'),
  });

  server.registerTool(
    'fabric_export_items_preview',
    {
      title: 'Fabric · Act — Preview exporting items to a repository',
      description:
        'Show the user a card to confirm or cancel a pull request that brings notebooks and data ' +
        'pipelines from a Fabric workspace into a code project’s repository, in Fabric’s git ' +
        'format — how a workspace built by hand starts being deployed through CI (and how a ' +
        'Bitbucket repository gets what Fabric’s own git integration cannot reach).',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: z.object({
        workspace: workspaceField,
        items: z.array(exportRef).min(1).max(10),
        project: projectField,
        base: baseField,
        itemsDirectory: directoryField,
      }),
    },
    async ({
      workspace: workspaceRef,
      items,
      project: projectRef,
      base: asked,
      itemsDirectory: dir,
    }) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      if (!context.subject) return errText('No signed-in identity on this request.');
      const directory = itemsDirectory(dir);
      if (directory === null)
        return errText('The items directory must be a path inside the repository.');
      const held = new Set(context.fabricScopes ?? []);
      const missing = items.find(
        (ref) => context.fabricScopes && !held.has(SCOPE_FOR_TYPE[ref.type])
      );
      if (missing) {
        return errText(
          `Reading a ${kindLabel(missing.type === 'Notebook' ? 'notebook-definition' : 'pipeline-definition')}'s definition needs the Fabric connection's ${SCOPE_FOR_TYPE[missing.type]}; reconnect Fabric with it.`
        );
      }
      const workspace = await resolveWorkspace(context, access, workspaceRef);
      if (typeof workspace === 'string') return errText(workspace);
      const resolved = [];
      for (const ref of items) {
        const item = await resolveItem(context, access, workspace, ref.type, ref.item);
        if (typeof item === 'string') return errText(item);
        resolved.push({
          type: ref.type,
          id: item.id,
          displayName: item.displayName,
          description: item.description,
        });
      }
      const repo = await resolveRepoProject(context.subject, projectRef);
      if (typeof repo === 'string') return errText(repo);
      const base = await proposalBase(repo.project, asked);
      const lines = await Promise.all(
        resolved.map(async (item) => {
          const folder = [directory, itemFolderName(item.displayName, item.type)]
            .filter(Boolean)
            .join('/');
          const kept = await existingLogicalId(caller(), repo, base, `${folder}/.platform`);
          return `${kept ? 'Replaces' : 'New'} ${folder}/ — from “${workspace.displayName}”`;
        })
      );
      return previewResult({
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Export Fabric items',
        tone: 'positive',
        title: `Pull request: ${resolved.map((i) => i.displayName).join(', ')}`,
        subtitle: `Microsoft Fabric through CI · ${repoLine(repo)}`,
        person: { name: repo.project.name, detail: `Into ${base}` },
        fields: [
          { label: 'From workspace', value: workspace.displayName },
          { label: 'Repository', value: repo.project.repo.fullName },
          { label: 'Pull request into', value: base },
        ],
        groupLists: [{ label: 'Items', groups: lines, tone: 'add' }],
        confirmTool: 'fabric_export_items_confirm',
        confirmLabel: 'Open pull request',
        confirmArgs: {
          workspaceId: workspace.id,
          workspaceName: workspace.displayName,
          items: resolved,
          projectId: repo.project.id,
          base,
          itemsDirectory: directory,
        },
      });
    }
  );

  server.registerTool(
    'fabric_export_items_confirm',
    {
      title: 'Fabric · Act — Export items to a repository',
      description:
        'Read the items the preview card showed from Fabric and open the pull request.' +
        confirmGuard('fabric_export_items_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: z.object({
        workspaceId: z.string().uuid(),
        workspaceName: z.string(),
        items: z
          .array(
            z.object({
              type: itemTypeField,
              id: z.string().uuid(),
              displayName: z.string().min(1),
              description: z.string(),
            })
          )
          .min(1)
          .max(10),
        projectId: z.string().uuid(),
        base: z.string().min(1),
        itemsDirectory: z.string(),
      }),
    },
    async ({ workspaceId, workspaceName, items, projectId, base, itemsDirectory: dir }) => {
      const access = await auth.resolve();
      if (typeof access === 'string') return errText(access);
      if (!context.subject) return errText('No signed-in identity on this request.');
      const directory = itemsDirectory(dir);
      if (directory === null)
        return errText('The items directory must be a path inside the repository.');
      const repo = await resolveRepoProject(context.subject, projectId);
      if (typeof repo === 'string') return errText(repo);
      const files: RepoFile[] = [];
      const skipped: string[] = [];
      for (const item of items) {
        const started = await startDefinitionOperation({
          id: randomUUID(),
          subject: context.subject,
          kind: item.type === 'Notebook' ? 'notebook-definition' : 'pipeline-definition',
          workspaceId,
          workspaceName,
          itemId: item.id,
          itemName: item.displayName,
          // Fabric's git source format: what its git integration and fabric-cicd read.
          format: item.type === 'Notebook' ? 'fabricGitSource' : null,
          fetcher: access.fetcher,
          base: access.base,
          now: new Date(),
        });
        if (!started.ok)
          return errText(`Could not read “${item.displayName}” from Fabric: ${started.error}`);
        const settled = await waitInline(started.operation, access, EXPORT_WAIT_MS);
        if (settled.status === 'running') {
          return errText(
            `Fabric is still preparing “${item.displayName}” (operation ${settled.id}); nothing was committed. ` +
              'The person is notified when it is ready; try the export again then.'
          );
        }
        if (settled.status === 'failed' || !settled.result) {
          return errText(
            `Fabric could not give “${item.displayName}”: ${settled.error ?? 'no definition'}`
          );
        }
        const folder = [directory, itemFolderName(item.displayName, item.type)]
          .filter(Boolean)
          .join('/');
        const kept = await existingLogicalId(caller(), repo, base, `${folder}/.platform`);
        const exported = repoFilesFromDefinition(
          settled.result,
          {
            type: item.type,
            displayName: item.displayName,
            description: item.description,
            logicalId: kept ?? randomUUID(),
          },
          directory
        );
        files.push(...exported.files);
        skipped.push(...exported.skipped.map((path) => `${item.displayName}/${path}`));
      }
      const names = items.map((item) => item.displayName).join(', ');
      const proposed = await proposeFiles(caller(), repo, {
        files,
        base,
        branch: proposalBranch(
          `export-${items.length === 1 ? items[0].displayName : workspaceName}`,
          new Date()
        ),
        message: `Fabric: export ${names} from ${workspaceName} (Renkei)`,
        title: `Fabric: export ${names} from ${workspaceName}`,
        description: [
          `Exported in Renkei from the Fabric workspace “${workspaceName}”:`,
          ...items.map((item) => `- ${item.displayName} (${item.type})`),
          ...(skipped.length ? ['', `Not exported (not text): ${skipped.join(', ')}`] : []),
          '',
          MERGE_NOTE,
        ].join('\n'),
      });
      if (!proposed.ok) return errText(`Could not open the pull request: ${proposed.error}`);
      return textResult(
        `Opened a pull request into ${base} with ${names} from “${workspaceName}”: ${proposed.url}` +
          (skipped.length ? `\nLeft out (not text): ${skipped.join(', ')}` : '')
      );
    }
  );

  // -------------------------------------------------------------------
  // Workspaces: each environment's, in the pipeline.
  // -------------------------------------------------------------------

  const environmentInput = z.object({
    name: z
      .string()
      .min(1)
      .max(60)
      .describe('The environment as the pipeline names it: dev, production.'),
    branch: z
      .string()
      .optional()
      .describe('The branch whose merges deploy it — only for an environment the pipeline lacks.'),
    workspaceName: z
      .string()
      .min(1)
      .max(256)
      .describe('The workspace it deploys to; the deploy makes it if there is none.'),
    existingWorkspace: z
      .string()
      .optional()
      .describe('An existing workspace (id or exact name) to use and rename to workspaceName.'),
    capacity: z
      .string()
      .optional()
      .describe('The capacity the workspace runs on, by name or id (fabric_list_capacities).'),
    description: z.string().max(256).optional().describe('The workspace’s description.'),
  });
  type EnvironmentInput = z.infer<typeof environmentInput>;

  /** The environments with every reference resolved to an id; a string says what did not resolve. */
  async function resolveEnvironments(
    inputs: EnvironmentInput[]
  ): Promise<FabricEnvironment[] | string> {
    const access = await auth.resolve();
    if (typeof access === 'string') return access;
    const out: FabricEnvironment[] = [];
    for (const env of inputs) {
      let workspaceId: string | undefined;
      if (env.existingWorkspace) {
        const found = await resolveWorkspace(context, access, env.existingWorkspace);
        if (typeof found === 'string') return found;
        workspaceId = found.id;
      }
      let capacityId: string | undefined;
      if (env.capacity) {
        if (isGuid(env.capacity)) capacityId = env.capacity.trim();
        else {
          const found = await resolveCapacity(context, access, env.capacity);
          if (typeof found === 'string') return found;
          capacityId = found.id;
        }
      }
      out.push({
        name: env.name.trim(),
        ...(env.branch ? { branch: env.branch } : {}),
        workspaceName: env.workspaceName.trim(),
        ...(workspaceId ? { workspaceId } : {}),
        ...(capacityId ? { capacityId } : {}),
        ...(env.description ? { description: env.description } : {}),
      });
    }
    return out;
  }

  server.registerTool(
    'fabric_setup_pipeline_preview',
    {
      title: 'Fabric · Act — Preview setting up Fabric deployment',
      description:
        'Show the user a card to confirm or cancel a pull request that sets up a code project’s ' +
        'pipeline to deploy Fabric: items are checked on every pull request, and each named ' +
        'environment deploys to its workspace — created by the deploy if it does not exist, or an ' +
        'existing one renamed, on the capacity given. This is how workspaces are created and ' +
        'renamed: through the pipeline, not directly.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(DIRECTORY_ACTION_PREVIEW_URI),
      inputSchema: z.object({
        project: projectField,
        environments: z.array(environmentInput).min(1).max(6),
        itemsDirectory: directoryField,
      }),
    },
    async ({ project: projectRef, environments, itemsDirectory: dir }) => {
      if (!context.subject) return errText('No signed-in identity on this request.');
      const directory = itemsDirectory(dir);
      if (directory === null)
        return errText('The items directory must be a path inside the repository.');
      const repo = await resolveRepoProject(context.subject, projectRef);
      if (typeof repo === 'string') return errText(repo);
      const blocks = await fabricBlockVersions();
      if (typeof blocks === 'string') return errText(blocks);
      const resolved = await resolveEnvironments(environments);
      if (typeof resolved === 'string') return errText(resolved);
      const plan = planFabricPipeline(await savedSpec(repo), resolved, blocks, directory || '.');
      if (typeof plan === 'string') return errText(plan);
      return previewResult({
        kind: 'directory_action',
        previewId: newPreviewId(),
        action: 'Set up Fabric deployment',
        tone: 'caution',
        title: `Deploy Fabric from ${repo.project.name}`,
        subtitle: `Microsoft Fabric through CI · ${repoLine(repo)}`,
        person: {
          name: repo.project.name,
          detail: `Pipeline pull request into ${repo.project.repo.branch}`,
        },
        fields: [
          { label: 'Repository', value: repo.project.repo.fullName },
          {
            label: 'Signs in to Fabric as',
            value:
              'The app registration named by the repository variables AZURE_TENANT_ID and AZURE_CLIENT_ID, through a federated credential that trusts this repository’s OIDC tokens',
          },
        ],
        groupLists: [{ label: 'Pipeline changes', groups: plan.changes, tone: 'add' }],
        confirmTool: 'fabric_setup_pipeline_confirm',
        confirmLabel: 'Open pull request',
        confirmArgs: {
          projectId: repo.project.id,
          environments: resolved,
          itemsDirectory: directory,
        },
      });
    }
  );

  server.registerTool(
    'fabric_setup_pipeline_confirm',
    {
      title: 'Fabric · Act — Set up Fabric deployment',
      description:
        'Write the pipeline the preview card showed and open its pull request.' +
        confirmGuard('fabric_setup_pipeline_preview'),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: z.object({
        projectId: z.string().uuid(),
        environments: z
          .array(
            z.object({
              name: z.string().min(1),
              branch: z.string().optional(),
              workspaceName: z.string().min(1),
              workspaceId: z.string().optional(),
              capacityId: z.string().optional(),
              description: z.string().optional(),
            })
          )
          .min(1)
          .max(6),
        itemsDirectory: z.string(),
      }),
    },
    async ({ projectId, environments, itemsDirectory: dir }) => {
      if (!context.subject) return errText('No signed-in identity on this request.');
      const directory = itemsDirectory(dir);
      if (directory === null)
        return errText('The items directory must be a path inside the repository.');
      const repo = await resolveRepoProject(context.subject, projectId);
      if (typeof repo === 'string') return errText(repo);
      const blocks = await fabricBlockVersions();
      if (typeof blocks === 'string') return errText(blocks);
      // Planned again on the pipeline as it is now, so a save made since the preview is kept.
      const plan = planFabricPipeline(
        await savedSpec(repo),
        environments,
        blocks,
        directory || '.'
      );
      if (typeof plan === 'string') return errText(plan);
      const opened = await writeFabricPipeline(caller(), repo, plan, new Date());
      if (!opened.ok) {
        return errText(
          `Could not open the pipeline’s pull request: ${opened.error}` +
            (opened.problems?.length ? `\n${opened.problems.join('\n')}` : '')
        );
      }
      return textResult(
        `${opened.updated ? 'Added to' : 'Opened'} the pipeline’s pull request: ${opened.url}\n` +
          `${plan.changes.join('\n')}\n` +
          'Before the first deploy, the repository needs the variables AZURE_TENANT_ID and ' +
          'AZURE_CLIENT_ID, and that app registration a federated credential trusting this ' +
          'repository’s OIDC tokens and an admin role on any existing workspace it renames.'
      );
    }
  );
}
