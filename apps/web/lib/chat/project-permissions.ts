/**
 * A chat project's (or code project's) own tool settings for its chats:
 * Allow (an act tool runs without asking in every chat of the project) and
 * Ask (a tool that only reads, made to ask first). A chat can still block
 * a tool or make it ask for itself, the person's own blocks still refuse
 * it, and the organization's locked high-risk tools ask whatever this
 * says (tool-decision.ts). Stored on the project
 * (`chat_projects.tool_permissions`, migration 198); edited by the
 * project's editors from its settings.
 */

import { getDataStore } from '@renkei/db';
import { isRecord } from '@renkei/guards';
import { TOOL_NAME } from './permission-rules';

export interface ProjectToolSettings {
  /** Act tools that run without asking in the project's chats; sorted, unique. */
  allow: string[];
  /** Tools that ask first in the project's chats (reading ones made to ask); sorted, unique. */
  ask: string[];
}

export const NO_PROJECT_TOOL_SETTINGS: ProjectToolSettings = { allow: [], ask: [] };

function names(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [
    ...new Set(
      raw.filter((entry): entry is string => typeof entry === 'string' && TOOL_NAME.test(entry))
    ),
  ].sort();
}

/** Whatever jsonb hands back; a name on both lists asks (the stricter answer). */
export function parseProjectToolSettings(stored: unknown): ProjectToolSettings {
  if (!isRecord(stored)) return NO_PROJECT_TOOL_SETTINGS;
  const ask = names(stored.ask);
  return { allow: names(stored.allow).filter((name) => !ask.includes(name)), ask };
}

export type ProjectToolRule = 'allow' | 'ask' | 'clear';

export function isProjectToolRule(value: unknown): value is ProjectToolRule {
  return value === 'allow' || value === 'ask' || value === 'clear';
}

/** The settings with one tool moved onto `rule`'s list (and off the other); 'clear' takes it off both. */
export function withProjectToolRule(
  settings: ProjectToolSettings,
  name: string,
  rule: ProjectToolRule
): ProjectToolSettings {
  const allow = settings.allow.filter((entry) => entry !== name);
  const ask = settings.ask.filter((entry) => entry !== name);
  if (rule === 'allow') allow.push(name);
  if (rule === 'ask') ask.push(name);
  return { allow: allow.sort(), ask: ask.sort() };
}

/** Put one setting on a project: read fresh, change, write back; null when the name or project is wrong. */
export async function rememberProjectToolRule(
  projectId: string,
  name: string,
  rule: ProjectToolRule
): Promise<ProjectToolSettings | null> {
  if (!TOOL_NAME.test(name)) return null;
  const project = await getDataStore().chatProjects.get(projectId);
  if (!project) return null;
  const next = withProjectToolRule(parseProjectToolSettings(project.toolPermissions), name, rule);
  const empty = next.allow.length === 0 && next.ask.length === 0;
  // Settings, not activity: the project keeps its place in the person's list.
  await getDataStore().chatProjects.update(projectId, {
    toolPermissions: empty ? null : next,
    keepUpdatedAt: true,
  });
  return next;
}
