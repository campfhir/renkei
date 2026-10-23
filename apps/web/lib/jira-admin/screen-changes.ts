/**
 * Changes to a screen — the fifth kind of change request: fields added to,
 * taken off or moved on a tab, tabs added or renamed, and the screen
 * renamed. Removing a field from a screen hides it there; the field and
 * every value on every issue stay, so this is not a delete.
 *
 * A screen is shown by every space whose schemes lead to it, so the
 * proposal tool names those spaces and will not go ahead, when there is
 * more than one, without `sharedScreens: true` — and the review page
 * repeats it (lib/jira-admin/space-screens.ts finds them).
 *
 * Applying re-reads the screen's tabs and their fields first and stops at
 * the first operation whose ground has moved: a tab gone, a field already
 * on the screen, a field no longer on its tab.
 */

import {
  jiraAdminGet,
  jiraAdminSend,
  rec,
  records,
  str,
  type JiraAdminAccess,
} from '@/lib/mcp-tools/jira-admin/client';
import type { OperationResult } from './change-requests';

export const SCREEN_CHANGES_KIND = 'screen_changes';

interface LogScope {
  subject?: string;
}

export const FIELD_POSITIONS = ['first', 'last', 'earlier', 'later'] as const;
export type FieldPosition = (typeof FIELD_POSITIONS)[number];

export interface AddFieldOperation {
  op: 'add_field';
  fieldId: string;
  fieldName: string;
  tabId: string;
  tabName: string;
}

export interface RemoveFieldOperation {
  op: 'remove_field';
  fieldId: string;
  fieldName: string;
  tabId: string;
  tabName: string;
}

export interface MoveFieldOperation {
  op: 'move_field';
  fieldId: string;
  fieldName: string;
  tabId: string;
  tabName: string;
  position: FieldPosition;
}

export interface AddTabOperation {
  op: 'add_tab';
  name: string;
}

export interface RenameTabOperation {
  op: 'rename_tab';
  tabId: string;
  from: string;
  to: string;
}

export interface RenameScreenOperation {
  op: 'rename_screen';
  from: string;
  to: string;
}

export type ScreenOperation =
  | AddFieldOperation
  | RemoveFieldOperation
  | MoveFieldOperation
  | AddTabOperation
  | RenameTabOperation
  | RenameScreenOperation;

export interface ScreenChangesPayload {
  screen: { id: string; name: string };
  /** Keys of the spaces that show the screen, when proposed. */
  spaces: string[];
  /** True when there may be more than `spaces` names. */
  moreSpaces: boolean;
  operations: ScreenOperation[];
}

// ---- describing --------------------------------------------------------------

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

const POSITION_WORDS: Record<FieldPosition, string> = {
  first: 'to the top of',
  last: 'to the bottom of',
  earlier: 'one place up on',
  later: 'one place down on',
};

export interface DescribedScreenOperation {
  text: string;
  access: boolean;
  details: string[];
}

export function describeScreenOperation(
  operation: ScreenOperation,
  payload: Pick<ScreenChangesPayload, 'screen'>
): DescribedScreenOperation {
  const screen = `“${payload.screen.name}”`;
  switch (operation.op) {
    case 'add_field':
      return {
        text: `Put “${operation.fieldName}” on ${screen}, tab “${operation.tabName}”`,
        access: false,
        details: [],
      };
    case 'remove_field':
      return {
        text: `Take “${operation.fieldName}” off ${screen}, tab “${operation.tabName}”`,
        access: false,
        details: ['The field and its values on every issue stay; it is no longer shown here.'],
      };
    case 'move_field':
      return {
        text:
          `Move “${operation.fieldName}” ${POSITION_WORDS[operation.position]} tab ` +
          `“${operation.tabName}” of ${screen}`,
        access: false,
        details: [],
      };
    case 'add_tab':
      return { text: `Add a tab “${operation.name}” to ${screen}`, access: false, details: [] };
    case 'rename_tab':
      return {
        text: `Rename the tab “${operation.from}” of ${screen} to “${operation.to}”`,
        access: false,
        details: [],
      };
    case 'rename_screen':
      return {
        text: `Rename the screen “${operation.from}” to “${operation.to}”`,
        access: false,
        details: [],
      };
  }
}

/** Shown by more than one space? The page warns when so. */
export function screenTouchesOtherSpaces(payload: ScreenChangesPayload): boolean {
  return payload.spaces.length > 1 || payload.moreSpaces;
}

export function describeScreenReach(payload: ScreenChangesPayload, siteUrl: string | null): string {
  const where = siteUrl ? ` on ${siteUrl}` : '';
  const lead = `The screen “${payload.screen.name}”${where}.`;
  if (payload.spaces.length === 0 && !payload.moreSpaces) {
    return `${lead} No space shows it at the moment.`;
  }
  if (!screenTouchesOtherSpaces(payload)) {
    return `${lead} Only ${payload.spaces[0]} shows it.`;
  }
  const names = listWords(payload.spaces.slice(0, 8));
  const more = payload.spaces.length > 8 || payload.moreSpaces ? ' and more' : '';
  return (
    `${lead} ` +
    (names ? `${names}${more} show it` : 'Several spaces show it — Jira would not say which') +
    ', and every one of them sees these changes.'
  );
}

/** "Changes to the screen “OPS: Create”" — a list row's title. */
export function screenChangesTitle(payload: ScreenChangesPayload): string {
  const count = payload.operations.length;
  const title = `${count === 1 ? 'A change' : `${count} changes`} to the screen “${payload.screen.name}”`;
  return title.length > 300 ? `${title.slice(0, 299)}…` : title;
}

// ---- reading ---------------------------------------------------------------

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function isPosition(value: string): value is FieldPosition {
  return FIELD_POSITIONS.some((position) => position === value);
}

function readOperation(value: unknown): ScreenOperation | null {
  const record = rec(value);
  switch (record.op) {
    case 'add_field':
    case 'remove_field':
      if (!str(record.fieldId) || !str(record.tabId)) return null;
      return {
        op: record.op,
        fieldId: str(record.fieldId),
        fieldName: str(record.fieldName) || str(record.fieldId),
        tabId: str(record.tabId),
        tabName: str(record.tabName),
      };
    case 'move_field': {
      const position = str(record.position);
      if (!str(record.fieldId) || !str(record.tabId) || !isPosition(position)) return null;
      return {
        op: 'move_field',
        fieldId: str(record.fieldId),
        fieldName: str(record.fieldName) || str(record.fieldId),
        tabId: str(record.tabId),
        tabName: str(record.tabName),
        position,
      };
    }
    case 'add_tab':
      if (!str(record.name)) return null;
      return { op: 'add_tab', name: str(record.name) };
    case 'rename_tab':
      if (!str(record.tabId) || !str(record.to)) return null;
      return {
        op: 'rename_tab',
        tabId: str(record.tabId),
        from: str(record.from),
        to: str(record.to),
      };
    case 'rename_screen':
      if (!str(record.to)) return null;
      return { op: 'rename_screen', from: str(record.from), to: str(record.to) };
    default:
      return null;
  }
}

/** The payload as stored, or null when it is not one this code wrote in full. */
export function readScreenChangesPayload(value: unknown): ScreenChangesPayload | null {
  const record = rec(value);
  const screen = rec(record.screen);
  if (!str(screen.id)) return null;
  if (!Array.isArray(record.operations) || record.operations.length === 0) return null;
  const operations: ScreenOperation[] = [];
  for (const item of record.operations) {
    const operation = readOperation(item);
    if (!operation) return null;
    operations.push(operation);
  }
  return {
    screen: { id: str(screen.id), name: str(screen.name) || `Screen ${str(screen.id)}` },
    spaces: strings(record.spaces),
    moreSpaces: record.moreSpaces === true,
    operations,
  };
}

// ---- the screen as it is -----------------------------------------------------

export interface ScreenTabFields {
  id: string;
  name: string;
  fields: { id: string; name: string }[];
}

/** A screen's tabs, each with its fields in order — or Jira's reason it would not say. */
export async function readScreenTabs(
  scope: LogScope,
  access: JiraAdminAccess,
  screenId: string
): Promise<{ ok: true; tabs: ScreenTabFields[] } | { ok: false; error: string }> {
  const base = `/rest/api/3/screens/${encodeURIComponent(screenId)}/tabs`;
  const listing = await jiraAdminGet(scope, access, base);
  if (!listing.ok) return { ok: false, error: `Reading the screen’s tabs: ${listing.error}` };
  const tabs = records(listing.body)
    .map((tab) => ({ id: str(tab.id), name: str(tab.name) }))
    .filter((tab) => tab.id);
  const fields = await Promise.all(
    tabs.map((tab) => jiraAdminGet(scope, access, `${base}/${encodeURIComponent(tab.id)}/fields`))
  );
  const out: ScreenTabFields[] = [];
  for (const [index, tab] of tabs.entries()) {
    const result = fields[index];
    if (!result?.ok) {
      return {
        ok: false,
        error: `Reading the fields of tab “${tab.name}”: ${result?.error ?? 'could not be read'}`,
      };
    }
    out.push({
      ...tab,
      fields: records(result.body)
        .map((field) => ({ id: str(field.id), name: str(field.name) || str(field.id) }))
        .filter((field) => field.id),
    });
  }
  return { ok: true, tabs: out };
}

// ---- applying ----------------------------------------------------------------

type Step = { ok: true; note?: string } | { ok: false; error: string };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

const POSITION_API: Record<FieldPosition, string> = {
  first: 'First',
  last: 'Last',
  earlier: 'Earlier',
  later: 'Later',
};

/**
 * Apply a stored screen proposal, in order, stopping at the first
 * operation that fails. The tabs are read once, before the first
 * operation, and kept in step with what each one did.
 */
export async function applyScreenChanges(
  scope: LogScope,
  access: JiraAdminAccess,
  payload: ScreenChangesPayload
): Promise<{ status: 'applied' | 'partial' | 'failed'; results: OperationResult[] }> {
  const results: OperationResult[] = [];
  const base = `/rest/api/3/screens/${encodeURIComponent(payload.screen.id)}`;
  const read = await readScreenTabs(scope, access, payload.screen.id);
  let tabs: ScreenTabFields[] = read.ok ? read.tabs : [];
  let stopped = !read.ok;
  if (!read.ok) {
    results.push({ label: 'Read the screen', outcome: 'failed', detail: read.error });
  }
  for (const operation of payload.operations) {
    const label = describeScreenOperation(operation, payload).text;
    if (stopped) {
      results.push({ label, outcome: 'not_run' });
      continue;
    }
    const step = await applyOne(scope, access, base, tabs, operation);
    if (!step.ok) {
      results.push({ label, outcome: 'failed', detail: step.error });
      stopped = true;
      continue;
    }
    tabs = step.tabs;
    results.push({ label, outcome: 'done', ...(step.note ? { detail: step.note } : {}) });
  }
  const done = results.filter((result) => result.outcome === 'done').length;
  return {
    status: done === results.length ? 'applied' : done === 0 ? 'failed' : 'partial',
    results,
  };
}

async function applyOne(
  scope: LogScope,
  access: JiraAdminAccess,
  base: string,
  tabs: ScreenTabFields[],
  operation: ScreenOperation
): Promise<(Step & { ok: true; tabs: ScreenTabFields[] }) | (Step & { ok: false })> {
  const tabOf = (id: string) => tabs.find((candidate) => candidate.id === id) ?? null;
  switch (operation.op) {
    case 'add_field': {
      const tab = tabOf(operation.tabId);
      if (!tab)
        return { ok: false, error: `The tab “${operation.tabName}” is no longer on the screen.` };
      const on = tabs.find((candidate) =>
        candidate.fields.some((field) => field.id === operation.fieldId)
      );
      if (on) {
        return {
          ok: true,
          tabs,
          note:
            on.id === tab.id
              ? 'It was on this tab already.'
              : `It is on the tab “${on.name}” already, so it was not added twice.`,
        };
      }
      const result = await jiraAdminSend(
        scope,
        access,
        'POST',
        `${base}/tabs/${encodeURIComponent(tab.id)}/fields`,
        { fieldId: operation.fieldId }
      );
      if (!result.ok) return { ok: false, error: result.error };
      return {
        ok: true,
        tabs: tabs.map((candidate) =>
          candidate.id === tab.id
            ? {
                ...candidate,
                fields: [...candidate.fields, { id: operation.fieldId, name: operation.fieldName }],
              }
            : candidate
        ),
      };
    }
    case 'remove_field': {
      const tab = tabOf(operation.tabId);
      if (!tab)
        return { ok: false, error: `The tab “${operation.tabName}” is no longer on the screen.` };
      if (!tab.fields.some((field) => field.id === operation.fieldId)) {
        return { ok: true, tabs, note: 'It was not on this tab any more.' };
      }
      const result = await jiraAdminDelete(
        scope,
        access,
        `${base}/tabs/${encodeURIComponent(tab.id)}/fields/${encodeURIComponent(operation.fieldId)}`
      );
      if (!result.ok) return { ok: false, error: result.error };
      return {
        ok: true,
        tabs: tabs.map((candidate) =>
          candidate.id === tab.id
            ? { ...candidate, fields: candidate.fields.filter((f) => f.id !== operation.fieldId) }
            : candidate
        ),
      };
    }
    case 'move_field': {
      const tab = tabOf(operation.tabId);
      if (!tab)
        return { ok: false, error: `The tab “${operation.tabName}” is no longer on the screen.` };
      if (!tab.fields.some((field) => field.id === operation.fieldId)) {
        return {
          ok: false,
          error: `“${operation.fieldName}” is no longer on the tab “${tab.name}”, so it was not moved.`,
        };
      }
      const result = await jiraAdminSend(
        scope,
        access,
        'POST',
        `${base}/tabs/${encodeURIComponent(tab.id)}/fields/${encodeURIComponent(operation.fieldId)}/move`,
        { position: POSITION_API[operation.position] }
      );
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, tabs };
    }
    case 'add_tab': {
      const held = tabs.find((tab) => same(tab.name, operation.name));
      if (held) return { ok: true, tabs, note: 'A tab of that name is on the screen already.' };
      const result = await jiraAdminSend(scope, access, 'POST', `${base}/tabs`, {
        name: operation.name,
      });
      if (!result.ok) return { ok: false, error: result.error };
      const id = str(rec(result.body).id);
      return { ok: true, tabs: id ? [...tabs, { id, name: operation.name, fields: [] }] : tabs };
    }
    case 'rename_tab': {
      const tab = tabOf(operation.tabId);
      if (!tab)
        return { ok: false, error: `The tab “${operation.from}” is no longer on the screen.` };
      if (same(tab.name, operation.to))
        return { ok: true, tabs, note: 'It had that name already.' };
      const result = await jiraAdminSend(
        scope,
        access,
        'PUT',
        `${base}/tabs/${encodeURIComponent(tab.id)}`,
        { name: operation.to }
      );
      if (!result.ok) return { ok: false, error: result.error };
      return {
        ok: true,
        tabs: tabs.map((candidate) =>
          candidate.id === tab.id ? { ...candidate, name: operation.to } : candidate
        ),
      };
    }
    case 'rename_screen': {
      const result = await jiraAdminSend(scope, access, 'PUT', base, { name: operation.to });
      if (!result.ok) return { ok: false, error: result.error };
      return { ok: true, tabs };
    }
  }
}

/** DELETE, over the same fetcher — only taking a field off a screen tab uses it. */
async function jiraAdminDelete(
  scope: LogScope,
  access: JiraAdminAccess,
  path: string
): Promise<{ ok: true } | { ok: false; error: string }> {
  const result = await jiraAdminSend(scope, access, 'DELETE', path, undefined);
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}
