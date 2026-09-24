/**
 * A field for a space — the third kind of change request (stage 1c of
 * docs/project-management-design.md): put a custom field on the screens a
 * space uses, give the space a context of its own for it when it needs one
 * (with the options it should offer), and create the field first when no
 * field of that name and type exists.
 *
 * Reach is the thing to get right. A custom field is site-wide; its options
 * live on a context, which covers either named spaces or every space; and a
 * screen is shown by every space whose schemes lead to it. Since April 2026
 * Jira will not narrow or delete a field's context for every space
 * (CHANGE-3019), so a new field may well come with one — which means that
 * the field shows wherever it is on a screen. That is why the proposal tool
 * names every other space that shows the same screens and will not go
 * ahead without `sharedScreens: true`, and why the review page repeats it.
 *
 * Applying re-checks what could have moved: that no field of the name has
 * appeared since (creating a second is how sites end up with two "Vendor"
 * fields), that the space still has no context of its own, which options
 * already exist, and that each screen tab is still there and the field not
 * yet on it. It stops at the first operation that fails; nothing is
 * deleted.
 */

import {
  jiraAdminGet,
  jiraAdminPages,
  jiraAdminSend,
  rec,
  records,
  str,
  type JiraAdminAccess,
} from '@/lib/mcp-tools/jira-admin/client';
import type { OperationResult } from './change-requests';
import { readContextOptions } from './field-options';
import type { ScreenUse } from './space-screens';

export const SPACE_FIELD_KIND = 'space_field';

interface LogScope {
  tenantId: string;
  subject?: string;
}

const TYPE_PREFIX = 'com.atlassian.jira.plugin.system.customfieldtypes:';

/** The field types a proposal can create, by the names the tool takes. */
export const FIELD_TYPE_NAMES = [
  'select',
  'multiselect',
  'radio',
  'checkboxes',
  'text',
  'paragraph',
  'number',
  'date',
  'datetime',
  'user',
  'users',
  'labels',
  'url',
] as const;

export type FieldTypeName = (typeof FIELD_TYPE_NAMES)[number];

/** Each type's Jira key, its searcher (so the field can be searched in JQL), and whether it has options. */
export const FIELD_TYPES: Record<
  FieldTypeName,
  { key: string; searcher: string; options: boolean; label: string }
> = {
  select: {
    key: 'select',
    searcher: 'multiselectsearcher',
    options: true,
    label: 'select list (single choice)',
  },
  multiselect: {
    key: 'multiselect',
    searcher: 'multiselectsearcher',
    options: true,
    label: 'select list (multiple choices)',
  },
  radio: {
    key: 'radiobuttons',
    searcher: 'multiselectsearcher',
    options: true,
    label: 'radio buttons',
  },
  checkboxes: {
    key: 'multicheckboxes',
    searcher: 'multiselectsearcher',
    options: true,
    label: 'checkboxes',
  },
  text: { key: 'textfield', searcher: 'textsearcher', options: false, label: 'short text' },
  paragraph: { key: 'textarea', searcher: 'textsearcher', options: false, label: 'paragraph' },
  number: { key: 'float', searcher: 'numberrange', options: false, label: 'number' },
  date: { key: 'datepicker', searcher: 'daterange', options: false, label: 'date' },
  datetime: { key: 'datetime', searcher: 'datetimerange', options: false, label: 'date & time' },
  user: {
    key: 'userpicker',
    searcher: 'userpickergroupsearcher',
    options: false,
    label: 'user picker (single)',
  },
  users: {
    key: 'multiuserpicker',
    searcher: 'userpickergroupsearcher',
    options: false,
    label: 'user picker (multiple)',
  },
  labels: { key: 'labels', searcher: 'labelsearcher', options: false, label: 'labels' },
  url: { key: 'url', searcher: 'exacttextsearcher', options: false, label: 'URL' },
};

export function isFieldTypeName(value: string): value is FieldTypeName {
  return FIELD_TYPE_NAMES.some((name) => name === value);
}

/** Which of our type names a live field is — from its `schema.custom` — or null for anything else. */
export function fieldTypeNameOf(field: Record<string, unknown>): FieldTypeName | null {
  const custom = str(rec(field.schema).custom);
  const key = custom.startsWith(TYPE_PREFIX) ? custom.slice(TYPE_PREFIX.length) : '';
  return FIELD_TYPE_NAMES.find((name) => FIELD_TYPES[name].key === key) ?? null;
}

export const MAX_FIELD_OPTIONS = 100;

export interface CreateFieldOperation {
  op: 'create_field';
  name: string;
  description: string | null;
  type: FieldTypeName;
}

/** A context of the space's own for the field — or, with no options, one only if nothing covers the space. */
export interface AddContextOperation {
  op: 'add_context';
  name: string;
  /** Empty: every work type. */
  issueTypes: { id: string; name: string }[];
  options: string[];
}

export interface AddOptionsOperation {
  op: 'add_options';
  contextId: string;
  contextName: string;
  options: string[];
}

export interface AddToScreenOperation {
  op: 'add_to_screen';
  screenId: string;
  screenName: string;
  tabId: string;
  tabName: string;
  /** Set when the tab asked for is not on this screen and its first tab was used. */
  tabNote: string | null;
  uses: ScreenUse[];
  /** Other spaces that show this screen, when proposed. */
  sharedWith: string[];
  moreShared: boolean;
}

export type SpaceFieldOperation =
  CreateFieldOperation | AddContextOperation | AddOptionsOperation | AddToScreenOperation;

export interface SpaceFieldPayload {
  space: { id: string; key: string };
  /** `id` is null when the first operation creates the field. */
  field: { id: string | null; name: string; typeLabel: string };
  operations: SpaceFieldOperation[];
}

// ---- describing --------------------------------------------------------------

function quoted(values: readonly string[], max = 8): string {
  const shown = values.slice(0, max).map((value) => `“${value}”`);
  const rest = values.length - shown.length;
  return rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', ');
}

const USE_WORDS: Record<ScreenUse, string> = {
  create: 'creating',
  edit: 'editing',
  view: 'viewing',
};

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function sharedText(operation: AddToScreenOperation): string | null {
  const count = operation.sharedWith.length;
  if (count === 0 && !operation.moreShared) return null;
  // No names but "more": Jira would not say, or there were too many to look up.
  if (count === 0) return 'May be shown by other spaces too — Jira would not say which';
  const more = count > 8 || operation.moreShared ? ' and more' : '';
  return `Also shown by ${listWords(operation.sharedWith.slice(0, 8))}${more} — the field appears there too`;
}

export interface DescribedFieldOperation {
  text: string;
  access: boolean;
  details: string[];
}

export function describeFieldOperation(
  operation: SpaceFieldOperation,
  payload: Pick<SpaceFieldPayload, 'space' | 'field'>
): DescribedFieldOperation {
  const field = `“${payload.field.name}”`;
  const space = payload.space.key;
  switch (operation.op) {
    case 'create_field':
      return {
        text: `Create the custom field ${field}, a ${FIELD_TYPES[operation.type].label}`,
        access: false,
        details: operation.description ? [`Description: ${operation.description}`] : [],
      };
    case 'add_context': {
      const only =
        operation.issueTypes.length > 0
          ? ` — for ${listWords(operation.issueTypes.map((type) => type.name))} only`
          : '';
      if (operation.options.length === 0) {
        return {
          text: `Make sure ${field} applies in ${space}${only}`,
          access: false,
          details: [
            `If no context of the field covers ${space} by then, a context for ${space} alone is ` +
              'added. Jira often gives a new field a context for every space, which covers it.',
          ],
        };
      }
      return {
        text:
          `Give ${field} a context of its own for ${space}${only}, offering ` +
          `${quoted(operation.options)}`,
        access: false,
        details: [],
      };
    }
    case 'add_options':
      return {
        text: `Add ${quoted(operation.options)} to ${field} in its context “${operation.contextName}”`,
        access: false,
        details: [],
      };
    case 'add_to_screen': {
      const shared = sharedText(operation);
      return {
        text: `Put ${field} on the screen “${operation.screenName}”, tab “${operation.tabName}”`,
        access: false,
        details: [
          ...(operation.uses.length > 0
            ? [
                `${space} shows it when ${listWords(operation.uses.map((use) => USE_WORDS[use]))} ` +
                  'an issue',
              ]
            : []),
          ...(operation.tabNote ? [operation.tabNote] : []),
          ...(shared ? [shared] : []),
        ],
      };
    }
  }
}

/** Does any screen it lands on show in other spaces too? The page warns when so. */
export function touchesOtherSpaces(payload: SpaceFieldPayload): boolean {
  return payload.operations.some(
    (operation) =>
      operation.op === 'add_to_screen' && (operation.sharedWith.length > 0 || operation.moreShared)
  );
}

export function describeFieldReach(payload: SpaceFieldPayload, siteUrl: string | null): string {
  const where = `${payload.space.key}${siteUrl ? ` on ${siteUrl}` : ''}`;
  const screens = payload.operations.filter((operation) => operation.op === 'add_to_screen');
  const shared = [
    ...new Set(
      screens.flatMap((operation) => (operation.op === 'add_to_screen' ? operation.sharedWith : []))
    ),
  ];
  const lead =
    `The custom field “${payload.field.name}” in ${where}. Custom fields are site-wide: ` +
    'everyone administering Jira sees it in the field list.';
  if (!touchesOtherSpaces(payload)) {
    return screens.length > 0
      ? `${lead} The screens it goes on are ${payload.space.key}’s alone.`
      : lead;
  }
  return (
    `${lead} Some of the screens it goes on are shown by other spaces too` +
    (shared.length > 0
      ? ` (${listWords(shared.slice(0, 8))}${shared.length > 8 ? ' and more' : ''})`
      : '') +
    ', and the field appears in those spaces as well.'
  );
}

/** "New field “Vendor” for OPS" / "“Vendor” on OPS’s screens" — a list row's title. */
export function spaceFieldTitle(payload: SpaceFieldPayload): string {
  const title = payload.operations.some((operation) => operation.op === 'create_field')
    ? `New field “${payload.field.name}” for ${payload.space.key}`
    : `“${payload.field.name}” for ${payload.space.key}`;
  return title.length > 300 ? `${title.slice(0, 299)}…` : title;
}

// ---- reading ---------------------------------------------------------------

const USE_SET = new Set<string>(['create', 'edit', 'view']);

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function readOperation(value: unknown): SpaceFieldOperation | null {
  const record = rec(value);
  switch (record.op) {
    case 'create_field': {
      const type = str(record.type);
      if (!str(record.name) || !isFieldTypeName(type)) return null;
      return {
        op: 'create_field',
        name: str(record.name),
        description: str(record.description) || null,
        type,
      };
    }
    case 'add_context': {
      if (!str(record.name)) return null;
      return {
        op: 'add_context',
        name: str(record.name),
        issueTypes: records(record.issueTypes)
          .filter((type) => str(type.id))
          .map((type) => ({ id: str(type.id), name: str(type.name) })),
        options: strings(record.options).slice(0, MAX_FIELD_OPTIONS),
      };
    }
    case 'add_options': {
      const options = strings(record.options).slice(0, MAX_FIELD_OPTIONS);
      if (!str(record.contextId) || options.length === 0) return null;
      return {
        op: 'add_options',
        contextId: str(record.contextId),
        contextName: str(record.contextName),
        options,
      };
    }
    case 'add_to_screen': {
      if (!str(record.screenId) || !str(record.tabId)) return null;
      return {
        op: 'add_to_screen',
        screenId: str(record.screenId),
        screenName: str(record.screenName),
        tabId: str(record.tabId),
        tabName: str(record.tabName),
        tabNote: str(record.tabNote) || null,
        uses: strings(record.uses).filter((use): use is ScreenUse => USE_SET.has(use)),
        sharedWith: strings(record.sharedWith),
        moreShared: record.moreShared === true,
      };
    }
    default:
      return null;
  }
}

/** The payload as stored, or null when it is not one this code wrote in full. */
export function readSpaceFieldPayload(value: unknown): SpaceFieldPayload | null {
  const record = rec(value);
  const space = rec(record.space);
  const field = rec(record.field);
  if (!str(space.id) || !str(space.key) || !str(field.name)) return null;
  if (!Array.isArray(record.operations) || record.operations.length === 0) return null;
  const operations: SpaceFieldOperation[] = [];
  for (const item of record.operations) {
    const operation = readOperation(item);
    if (!operation) return null;
    operations.push(operation);
  }
  const creates = operations[0]?.op === 'create_field';
  // A field is created first or not at all, and an existing one is named by id.
  if (operations.slice(1).some((operation) => operation.op === 'create_field')) return null;
  if (!creates && !str(field.id)) return null;
  return {
    space: { id: str(space.id), key: str(space.key) },
    field: {
      id: creates ? null : str(field.id),
      name: str(field.name),
      typeLabel: str(field.typeLabel),
    },
    operations,
  };
}

// ---- applying ----------------------------------------------------------------

type Step = { ok: true; note?: string } | { ok: false; error: string };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

async function createField(
  scope: LogScope,
  access: JiraAdminAccess,
  operation: CreateFieldOperation
): Promise<Step & { fieldId?: string }> {
  const search = await jiraAdminGet(
    scope,
    access,
    `/rest/api/3/field/search?type=custom&maxResults=50&query=${encodeURIComponent(operation.name)}`
  );
  if (!search.ok) return { ok: false, error: `Checking the name is free: ${search.error}` };
  const taken = records(search.body).find((field) => same(str(field.name), operation.name));
  if (taken) {
    return {
      ok: false,
      error:
        `A custom field named “${str(taken.name)}” exists now (${str(taken.id)}), so another ` +
        'was not created. Ask for this again to use that one.',
    };
  }
  const type = FIELD_TYPES[operation.type];
  const created = await jiraAdminSend(scope, access, 'POST', '/rest/api/3/field', {
    name: operation.name,
    ...(operation.description ? { description: operation.description } : {}),
    type: `${TYPE_PREFIX}${type.key}`,
    searcherKey: `${TYPE_PREFIX}${type.searcher}`,
  });
  if (!created.ok) return { ok: false, error: created.error };
  const fieldId = str(rec(created.body).id);
  if (!fieldId) return { ok: false, error: 'Jira created the field but did not say its id.' };
  return { ok: true, fieldId, note: `Created as ${fieldId}.` };
}

async function addContext(
  scope: LogScope,
  access: JiraAdminAccess,
  payload: SpaceFieldPayload,
  fieldId: string,
  operation: AddContextOperation
): Promise<Step> {
  const base = `/rest/api/3/field/${encodeURIComponent(fieldId)}/context`;
  const [contexts, mappings] = await Promise.all([
    jiraAdminPages(scope, access, base),
    jiraAdminPages(scope, access, `${base}/projectmapping`, 20),
  ]);
  if (!contexts.ok) return { ok: false, error: `Reading its contexts: ${contexts.error}` };
  if (!mappings.ok) return { ok: false, error: `Reading its contexts: ${mappings.error}` };
  const own = mappings.values.find(
    (mapping) => mapping.isGlobalContext !== true && str(mapping.projectId) === payload.space.id
  );
  if (own) {
    const name = str(contexts.values.find((ctx) => str(ctx.id) === str(own.contextId))?.name);
    return {
      ok: false,
      error:
        `${payload.space.key} has a context of its own for this field now` +
        (name ? ` (“${name}”)` : '') +
        ', so another was not added. Ask for this again to work with that one.',
    };
  }
  const global = contexts.values.some((ctx) => ctx.isGlobalContext === true);
  if (operation.options.length === 0 && global) {
    return {
      ok: true,
      note: `Its context for every space covers ${payload.space.key}, so none was added.`,
    };
  }
  const created = await jiraAdminSend(scope, access, 'POST', base, {
    name: operation.name,
    description: `For ${payload.space.key}, added from Renkei.`,
    projectIds: [payload.space.id],
    issueTypeIds: operation.issueTypes.map((type) => type.id),
  });
  if (!created.ok) return { ok: false, error: created.error };
  const contextId = str(rec(created.body).id);
  if (operation.options.length === 0) return { ok: true };
  if (!contextId) {
    return {
      ok: false,
      error: 'Jira added the context but did not say its id, so its options were not added.',
    };
  }
  const options = await jiraAdminSend(
    scope,
    access,
    'POST',
    `${base}/${encodeURIComponent(contextId)}/option`,
    { options: operation.options.map((value) => ({ value, disabled: false })) }
  );
  if (!options.ok) {
    return {
      ok: false,
      error: `The context was added, but Jira refused its options: ${options.error}`,
    };
  }
  return { ok: true };
}

async function addOptions(
  scope: LogScope,
  access: JiraAdminAccess,
  fieldId: string,
  operation: AddOptionsOperation
): Promise<Step> {
  const live = await readContextOptions(scope, access, fieldId, operation.contextId);
  if (!live.ok) return { ok: false, error: `Reading its options: ${live.error}` };
  const held = live.options.filter((option) => option.parentId === null);
  const missing = operation.options.filter(
    (value) => !held.some((option) => same(option.value, value))
  );
  const already = operation.options.length - missing.length;
  const note = already > 0 ? `${already} already there.` : undefined;
  if (missing.length === 0) return { ok: true, note };
  const result = await jiraAdminSend(
    scope,
    access,
    'POST',
    `/rest/api/3/field/${encodeURIComponent(fieldId)}/context/${encodeURIComponent(operation.contextId)}/option`,
    { options: missing.map((value) => ({ value, disabled: false })) }
  );
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true, note };
}

async function addToScreen(
  scope: LogScope,
  access: JiraAdminAccess,
  fieldId: string,
  onScreens: Set<string>,
  operation: AddToScreenOperation
): Promise<Step> {
  if (onScreens.has(operation.screenId))
    return { ok: true, note: 'It was on this screen already.' };
  const tabs = await jiraAdminGet(
    scope,
    access,
    `/rest/api/3/screens/${encodeURIComponent(operation.screenId)}/tabs`
  );
  if (!tabs.ok) return { ok: false, error: `Reading the screen’s tabs: ${tabs.error}` };
  if (!records(tabs.body).some((tab) => str(tab.id) === operation.tabId)) {
    return {
      ok: false,
      error: `The tab “${operation.tabName}” is no longer on “${operation.screenName}”.`,
    };
  }
  const result = await jiraAdminSend(
    scope,
    access,
    'POST',
    `/rest/api/3/screens/${encodeURIComponent(operation.screenId)}/tabs/${encodeURIComponent(operation.tabId)}/fields`,
    { fieldId }
  );
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true };
}

/** The screens a field is on already, or Jira's reason it would not say. */
async function screensHolding(
  scope: LogScope,
  access: JiraAdminAccess,
  fieldId: string
): Promise<Set<string> | string> {
  const screens = await jiraAdminPages(
    scope,
    access,
    `/rest/api/3/field/${encodeURIComponent(fieldId)}/screens`
  );
  return screens.ok ? new Set(screens.values.map((screen) => str(screen.id))) : screens.error;
}

/**
 * Apply a stored space-field proposal, in order, stopping at the first
 * operation that fails.
 */
export async function applySpaceField(
  scope: LogScope,
  access: JiraAdminAccess,
  payload: SpaceFieldPayload
): Promise<{ status: 'applied' | 'partial' | 'failed'; results: OperationResult[] }> {
  const results: OperationResult[] = [];
  let fieldId = payload.field.id;
  // Which screens the field is on already — read once, before the first screen.
  let onScreens: Set<string> | null = null;
  let stopped = false;
  for (const operation of payload.operations) {
    const label = describeFieldOperation(operation, payload).text;
    if (stopped) {
      results.push({ label, outcome: 'not_run' });
      continue;
    }
    let step: Step;
    if (operation.op === 'create_field') {
      const created = await createField(scope, access, operation);
      if (created.ok && created.fieldId) fieldId = created.fieldId;
      step = created;
    } else if (!fieldId) {
      step = { ok: false, error: 'The field was not created, so nothing can be done with it.' };
    } else if (operation.op === 'add_context') {
      step = await addContext(scope, access, payload, fieldId, operation);
    } else if (operation.op === 'add_options') {
      step = await addOptions(scope, access, fieldId, operation);
    } else {
      const known: Set<string> | string =
        onScreens ?? (await screensHolding(scope, access, fieldId));
      if (typeof known === 'string') {
        step = { ok: false, error: `Reading which screens it is on: ${known}` };
      } else {
        onScreens = known;
        step = await addToScreen(scope, access, fieldId, known, operation);
      }
    }
    if (!step.ok) {
      results.push({ label, outcome: 'failed', detail: step.error });
      stopped = true;
      continue;
    }
    results.push({ label, outcome: 'done', ...(step.note ? { detail: step.note } : {}) });
  }
  const done = results.filter((result) => result.outcome === 'done').length;
  return {
    status: done === results.length ? 'applied' : done === 0 ? 'failed' : 'partial',
    results,
  };
}
