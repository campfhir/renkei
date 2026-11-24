/**
 * A definition as a reader takes it in: a notebook's cells in order with
 * their language, a pipeline's activities with what each waits on. For a
 * model reading a definition through a tool and for the web page's
 * summary line; the raw part stays available beside it.
 */

import { asRecord, isRecord } from '@renkei/guards';

export interface NotebookCell {
  kind: 'code' | 'markdown' | 'raw';
  source: string;
}

function sourceOf(value: unknown): string {
  if (typeof value === 'string') return value;
  return Array.isArray(value) ? value.filter((line) => typeof line === 'string').join('') : '';
}

/** The cells of a Jupyter notebook's JSON; null when it is not one. */
export function notebookCells(ipynb: string): NotebookCell[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(ipynb);
  } catch {
    return null;
  }
  const cells = asRecord(parsed).cells;
  if (!Array.isArray(cells)) return null;
  return cells.filter(isRecord).map((cell) => ({
    kind: cell.cell_type === 'markdown' ? 'markdown' : cell.cell_type === 'raw' ? 'raw' : 'code',
    source: sourceOf(cell.source),
  }));
}

/** Why a notebook a person gave cannot be sent, or null when it can. */
export function notebookProblem(ipynb: string): string | null {
  const cells = notebookCells(ipynb);
  if (!cells) return 'The notebook is not Jupyter JSON with a "cells" list.';
  const nbformat = asRecord(JSON.parse(ipynb)).nbformat;
  if (typeof nbformat !== 'number' || nbformat < 4) {
    return 'The notebook needs "nbformat": 4 (Fabric reads Jupyter format 4).';
  }
  return null;
}

/** A notebook's language from its metadata, when it says. */
export function notebookLanguage(ipynb: string): string | null {
  try {
    const metadata = asRecord(asRecord(JSON.parse(ipynb)).metadata);
    const language =
      asRecord(metadata.language_info).name ?? asRecord(metadata.kernelspec).language;
    return typeof language === 'string' && language ? language : null;
  } catch {
    return null;
  }
}

/** The cells as plain text, numbered, cut at `maxChars` with a note saying so. */
export function notebookAsText(ipynb: string, maxChars = 60_000): string {
  const cells = notebookCells(ipynb);
  if (!cells) return ipynb.length > maxChars ? `${ipynb.slice(0, maxChars)}\n… (cut)` : ipynb;
  const blocks = cells.map(
    (cell, index) => `--- cell ${index + 1} (${cell.kind}) ---\n${cell.source.trimEnd()}`
  );
  let text = '';
  for (const [index, block] of blocks.entries()) {
    if (text.length + block.length > maxChars) {
      return `${text}\n… ${blocks.length - index} more cell(s) not shown (the notebook is too long to read here).`;
    }
    text += `${text ? '\n\n' : ''}${block}`;
  }
  return text;
}

export interface PipelineActivity {
  name: string;
  type: string;
  dependsOn: string[];
}

/** A pipeline's activities from its pipeline-content.json; null when it is not one. */
export function pipelineActivities(json: string): PipelineActivity[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }
  const activities = asRecord(asRecord(parsed).properties).activities;
  if (!Array.isArray(activities)) return null;
  return activities.filter(isRecord).map((activity) => ({
    name: typeof activity.name === 'string' ? activity.name : '(unnamed)',
    type: typeof activity.type === 'string' ? activity.type : 'Unknown',
    dependsOn: Array.isArray(activity.dependsOn)
      ? activity.dependsOn
          .filter(isRecord)
          .map((dependency) => (typeof dependency.activity === 'string' ? dependency.activity : ''))
          .filter(Boolean)
      : [],
  }));
}

/** Why a pipeline definition a person gave cannot be sent, or null when it can. */
export function pipelineProblem(json: string): string | null {
  return pipelineActivities(json)
    ? null
    : 'The pipeline is not JSON with "properties": { "activities": [...] } (pipeline-content.json).';
}

/** One line per activity, then the JSON itself, cut at `maxChars`. */
export function pipelineAsText(json: string, maxChars = 60_000): string {
  const activities = pipelineActivities(json) ?? [];
  const lines = activities.map(
    (activity) =>
      `- ${activity.name} (${activity.type})` +
      (activity.dependsOn.length ? ` after ${activity.dependsOn.join(', ')}` : '')
  );
  const head = activities.length
    ? `Activities (${activities.length}):\n${lines.join('\n')}`
    : 'No activities.';
  const room = Math.max(0, maxChars - head.length);
  const body = json.length > room ? `${json.slice(0, room)}\n… (cut)` : json;
  return `${head}\n\npipeline-content.json:\n${body}`;
}
