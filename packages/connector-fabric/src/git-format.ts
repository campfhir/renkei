/**
 * Fabric items as a repository holds them: the format Fabric's own git
 * integration writes and Microsoft's fabric-cicd deploys from. Each item is
 * a folder named `<display name>.<type>` (`Load orders.Notebook`) holding a
 * `.platform` file (its type, name, description and a logical id that ties
 * the folder to the same item in every workspace it is deployed to) and
 * its content: `notebook-content.py` for a notebook in Fabric's source
 * format, `pipeline-content.json` for a data pipeline.
 *
 * Renkei writes these folders into a code project's branch and opens a pull
 * request; merging to an environment branch lets the pipeline's
 * "Fabric: deploy items" block publish them (packages/db migration 189).
 * Pure: no store, no network.
 */

import { asRecord } from '@renkei/guards';
import type { FabricOperationResult } from '@renkei/db';
import { notebookCells, notebookLanguage, type NotebookCell } from './readable';

export const REPO_ITEM_TYPES = ['Notebook', 'DataPipeline'] as const;
export type RepoItemType = (typeof REPO_ITEM_TYPES)[number];

/** Where a code project keeps its Fabric items unless told otherwise. */
export const DEFAULT_ITEMS_DIRECTORY = 'fabric';

const PLATFORM_SCHEMA =
  'https://developer.microsoft.com/json-schemas/fabric/gitIntegration/platformProperties/2.0.0/schema.json';

/** A display name as a folder name: path separators and characters Windows refuses become '-'. */
export function itemFolderName(displayName: string, type: RepoItemType): string {
  const safe = displayName
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  return `${safe || 'Untitled'}.${type}`;
}

/** A directory inside the repository: no leading or trailing slash, no `..`. */
export function itemsDirectory(value: string | undefined): string | null {
  const trimmed = (value ?? DEFAULT_ITEMS_DIRECTORY).trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return '';
  if (trimmed.split('/').some((segment) => segment === '..' || segment === '.' || !segment)) {
    return null;
  }
  return trimmed;
}

/** The `.platform` file Fabric's git format keeps beside an item's content. */
export function platformFile(
  type: RepoItemType,
  displayName: string,
  description: string,
  logicalId: string
): string {
  return `${JSON.stringify(
    {
      $schema: PLATFORM_SCHEMA,
      metadata: { type, displayName, ...(description ? { description } : {}) },
      config: { version: '2.0', logicalId },
    },
    null,
    2
  )}\n`;
}

// ——— notebooks in Fabric's source format ———

const MARKER = /^# (CELL|MARKDOWN|METADATA|PARAMETERS) \*+\s*$/;
const HEADER = '# Fabric notebook source';

function trimBlankLines(lines: string[]): string[] {
  let start = 0;
  let end = lines.length;
  while (start < end && !lines[start].trim()) start += 1;
  while (end > start && !lines[end - 1].trim()) end -= 1;
  return lines.slice(start, end);
}

/** Whether text is a notebook in Fabric's source format. */
export function isNotebookSource(text: string): boolean {
  return text.trimStart().startsWith(HEADER);
}

/** The cells of a notebook in Fabric's source format, in order; metadata blocks are skipped. */
export function cellsFromNotebookSource(text: string): NotebookCell[] {
  const cells: NotebookCell[] = [];
  let kind: 'code' | 'markdown' | 'metadata' | null = null;
  let lines: string[] = [];
  const flush = () => {
    if (kind === 'code' || kind === 'markdown') {
      const body = trimBlankLines(lines);
      cells.push({
        kind,
        source:
          kind === 'markdown'
            ? body
                .map((line) => (line.startsWith('# ') ? line.slice(2) : line.replace(/^#$/, '')))
                .join('\n')
            : body.join('\n'),
      });
    }
    lines = [];
  };
  for (const line of text.split(/\r?\n/)) {
    const marker = MARKER.exec(line);
    if (marker) {
      flush();
      kind = marker[1] === 'MARKDOWN' ? 'markdown' : marker[1] === 'METADATA' ? 'metadata' : 'code';
      continue;
    }
    if (kind) lines.push(line);
  }
  flush();
  return cells;
}

/** The kernel Fabric names for a language. */
function kernelOf(language: string): { kernel: string; group: string; language: string } {
  const lower = language.toLowerCase();
  if (lower === 'scala')
    return { kernel: 'synapse_pyspark', group: 'synapse_pyspark', language: 'scala' };
  if (lower === 'sql' || lower === 'sparksql') {
    return { kernel: 'synapse_pyspark', group: 'synapse_pyspark', language: 'sparksql' };
  }
  if (lower === 'r' || lower === 'sparkr') {
    return { kernel: 'synapse_pyspark', group: 'synapse_pyspark', language: 'r' };
  }
  return { kernel: 'synapse_pyspark', group: 'synapse_pyspark', language: 'python' };
}

function meta(value: Record<string, unknown>): string[] {
  return JSON.stringify(value, null, 2)
    .split('\n')
    .map((line) => `# META ${line}`);
}

/** Cells written as a notebook in Fabric's source format (`notebook-content.py`). */
export function notebookSourceFromCells(cells: NotebookCell[], language = 'python'): string {
  const { kernel, group, language: cellLanguage } = kernelOf(language);
  const out: string[] = [
    HEADER,
    '',
    '# METADATA ********************',
    '',
    ...meta({ kernel_info: { name: kernel } }),
  ];
  for (const cell of cells) {
    out.push('');
    if (cell.kind === 'markdown') {
      out.push('# MARKDOWN ********************', '');
      out.push(...cell.source.split(/\r?\n/).map((line) => (line ? `# ${line}` : '#')));
    } else {
      out.push('# CELL ********************', '', ...cell.source.split(/\r?\n/), '');
      out.push('# METADATA ********************', '');
      out.push(...meta({ language: cellLanguage, language_group: group }));
    }
  }
  return `${out.join('\n')}\n`;
}

/**
 * A notebook as given — Jupyter JSON or Fabric's source format — as
 * Fabric's source format, with its cells; a string says why it cannot be.
 */
export function notebookAsSource(
  content: string
): { source: string; cells: NotebookCell[] } | string {
  if (isNotebookSource(content)) {
    const cells = cellsFromNotebookSource(content);
    return cells.length
      ? { source: content.endsWith('\n') ? content : `${content}\n`, cells }
      : 'The notebook has no cells.';
  }
  const cells = notebookCells(content);
  if (!cells) {
    return 'Give the notebook as Jupyter JSON (a "cells" list) or in Fabric’s source format (starting "# Fabric notebook source").';
  }
  return { source: notebookSourceFromCells(cells, notebookLanguage(content) ?? 'python'), cells };
}

// ——— the files an item becomes ———

export interface RepoFile {
  /** Relative to the repository root. */
  path: string;
  text: string;
}

export interface RepoItem {
  type: RepoItemType;
  displayName: string;
  description: string;
  /** Notebook: Jupyter JSON or Fabric source. Pipeline: pipeline-content.json. */
  content: string;
  /** Kept from an existing `.platform` when replacing an item; fresh otherwise. */
  logicalId: string;
}

/** The files an item is written as, under `directory`; a string says why it cannot be. */
export function repoFilesForItem(item: RepoItem, directory: string): RepoFile[] | string {
  const folder = [directory, itemFolderName(item.displayName, item.type)].filter(Boolean).join('/');
  const platform = {
    path: `${folder}/.platform`,
    text: platformFile(item.type, item.displayName, item.description, item.logicalId),
  };
  if (item.type === 'Notebook') {
    const notebook = notebookAsSource(item.content);
    if (typeof notebook === 'string') return notebook;
    return [{ path: `${folder}/notebook-content.py`, text: notebook.source }, platform];
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(item.content);
  } catch {
    return 'The pipeline is not JSON.';
  }
  if (!Array.isArray(asRecord(asRecord(parsed).properties).activities)) {
    return 'The pipeline needs "properties": { "activities": [...] } (pipeline-content.json).';
  }
  return [
    { path: `${folder}/pipeline-content.json`, text: `${JSON.stringify(parsed, null, 2)}\n` },
    platform,
  ];
}

/**
 * A definition Fabric handed over (format fabricGitSource) as the files of
 * its folder, with `.platform` written fresh when Fabric did not include
 * one. Parts that are not text are left out and named.
 */
export function repoFilesFromDefinition(
  result: FabricOperationResult,
  item: { type: RepoItemType; displayName: string; description: string; logicalId: string },
  directory: string
): { files: RepoFile[]; skipped: string[] } {
  const folder = [directory, itemFolderName(item.displayName, item.type)].filter(Boolean).join('/');
  const files: RepoFile[] = [];
  const skipped: string[] = [];
  for (const part of result.parts) {
    if (part.text === undefined) {
      skipped.push(part.path);
      continue;
    }
    files.push({ path: `${folder}/${part.path}`, text: part.text });
  }
  if (!files.some((file) => file.path.endsWith('/.platform'))) {
    files.push({
      path: `${folder}/.platform`,
      text: platformFile(item.type, item.displayName, item.description, item.logicalId),
    });
  }
  return { files, skipped };
}
