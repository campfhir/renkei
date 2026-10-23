/**
 * A work type for a space — the fourth kind of change request: create a
 * work type (Jira's REST API still says "issue type") when no site-wide
 * one of that name exists, give it an icon, add it to the work type scheme
 * the space runs on, and — when asked to set it up like a work type the
 * space already has — map it to that one's screens and workflow.
 *
 * Reach is, again, the thing to get right. A work type is site-wide, and
 * a work type scheme is often shared by a family of spaces: adding a type
 * to the scheme puts it in every space on that scheme, which is why the
 * proposal tool names those spaces and will not go ahead without
 * `sharedScheme: true`, and why the review page repeats it. Changing an
 * existing work type's icon changes it everywhere it is used, and the
 * review page says so too.
 *
 * Applying re-checks what could have moved: that no work type of the name
 * has appeared since (a second "Incident" is how sites end up with two),
 * that the space still runs on the schemes the proposal read, and that
 * the type is not mapped already. It stops at the first operation that
 * fails; nothing is deleted.
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

export const WORK_TYPE_KIND = 'work_type';

interface LogScope {
  subject?: string;
}

export interface CreateWorkTypeOperation {
  op: 'create_work_type';
  name: string;
  description: string | null;
  subtask: boolean;
}

/** The icon, from Jira's system set for work types. */
export interface SetIconOperation {
  op: 'set_icon';
  avatarId: string;
  iconName: string;
}

export interface AddToSchemeOperation {
  op: 'add_to_scheme';
  schemeId: string;
  schemeName: string;
  /** Keys of the other spaces on this scheme, when proposed. */
  sharedWith: string[];
  moreShared: boolean;
}

/** The screen scheme the space shows the work type on — the one `likeName` uses. */
export interface MapScreensOperation {
  op: 'map_screens';
  schemeId: string;
  schemeName: string;
  screenSchemeId: string;
  screenSchemeName: string;
  likeName: string;
}

/** The workflow the work type runs on in the space's workflow scheme. */
export interface MapWorkflowOperation {
  op: 'map_workflow';
  schemeId: string;
  schemeName: string;
  workflowId: string;
  workflowName: string;
  /** The work type whose workflow this copies, when one was named. */
  likeName: string | null;
}

export type WorkTypeOperation =
  | CreateWorkTypeOperation
  | SetIconOperation
  | AddToSchemeOperation
  | MapScreensOperation
  | MapWorkflowOperation;

export interface WorkTypePayload {
  space: { id: string; key: string; serviceDesk: boolean };
  /** `id` is null when the first operation creates the work type. */
  workType: { id: string | null; name: string; subtask: boolean };
  operations: WorkTypeOperation[];
}

// ---- icons -------------------------------------------------------------------

export interface WorkTypeIcon {
  id: string;
  /** "bug", "story" — from the system avatar's file name. */
  name: string;
  url: string;
}

/**
 * The system icons for work types. Jira names them only by file
 * ("10303_bug.png"), so the name people use is the file's, without its
 * number and extension.
 */
export async function readWorkTypeIcons(
  scope: LogScope,
  access: JiraAdminAccess
): Promise<{ ok: true; icons: WorkTypeIcon[] } | { ok: false; error: string }> {
  const result = await jiraAdminGet(scope, access, '/rest/api/3/avatar/issuetype/system');
  if (!result.ok) return { ok: false, error: result.error };
  const icons = records(rec(result.body).system)
    .map((avatar) => ({
      id: str(avatar.id),
      name: iconNameOf(str(avatar.fileName)) || `icon ${str(avatar.id)}`,
      url: str(rec(avatar.urls)['48x48']) || str(rec(avatar.urls)['32x32']),
    }))
    .filter((icon) => icon.id);
  return { ok: true, icons };
}

function iconNameOf(fileName: string): string {
  const base = fileName.includes('/') ? fileName.slice(fileName.lastIndexOf('/') + 1) : fileName;
  return base
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/^[\d_-]+/, '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** An icon by name ("bug") or id ("10303"); null when none matches. */
export function findWorkTypeIcon(icons: WorkTypeIcon[], reference: string): WorkTypeIcon | null {
  const wanted = reference.trim().toLowerCase();
  if (!wanted) return null;
  const byId = icons.find((icon) => icon.id === wanted);
  if (byId) return byId;
  const exact = icons.find((icon) => icon.name === wanted);
  if (exact) return exact;
  const loose = icons.filter((icon) => icon.name.includes(wanted) || wanted.includes(icon.name));
  return loose.length === 1 ? (loose[0] ?? null) : null;
}

// ---- describing --------------------------------------------------------------

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

function sharedText(operation: AddToSchemeOperation): string | null {
  const count = operation.sharedWith.length;
  if (count === 0 && !operation.moreShared) return null;
  if (count === 0) return 'May be used by other spaces too — Jira would not say which';
  const more = count > 8 || operation.moreShared ? ' and more' : '';
  return `Also used by ${listWords(operation.sharedWith.slice(0, 8))}${more} — the work type appears there too`;
}

export interface DescribedWorkTypeOperation {
  text: string;
  access: boolean;
  details: string[];
}

export function describeWorkTypeOperation(
  operation: WorkTypeOperation,
  payload: Pick<WorkTypePayload, 'space' | 'workType'>
): DescribedWorkTypeOperation {
  const type = `“${payload.workType.name}”`;
  const space = payload.space.key;
  switch (operation.op) {
    case 'create_work_type':
      return {
        text: `Create the work type ${type}${operation.subtask ? ', a subtask type' : ''}`,
        access: false,
        details: [
          ...(operation.description ? [`Description: ${operation.description}`] : []),
          'Work types are site-wide: it exists for every space, and shows in the ones whose ' +
            'work type scheme lists it.',
        ],
      };
    case 'set_icon':
      return {
        text: `Give ${type} the “${operation.iconName}” icon`,
        access: false,
        details: payload.workType.id
          ? [`${type} exists already, so its icon changes in every space that uses it.`]
          : [],
      };
    case 'add_to_scheme': {
      const shared = sharedText(operation);
      return {
        text: `Add ${type} to ${space}’s work type scheme “${operation.schemeName}”`,
        access: false,
        details: shared ? [shared] : [],
      };
    }
    case 'map_screens':
      return {
        text:
          `Show ${type} on the screens “${operation.likeName}” uses in ${space} ` +
          `(screen scheme “${operation.screenSchemeName}”)`,
        access: false,
        details: [`In ${space}’s screens scheme “${operation.schemeName}”.`],
      };
    case 'map_workflow':
      return {
        text: `Run ${type} on the workflow “${operation.workflowName}” in ${space}`,
        access: false,
        details: [
          `In ${space}’s workflow scheme “${operation.schemeName}”` +
            (operation.likeName ? `, as “${operation.likeName}” does.` : '.'),
        ],
      };
  }
}

/** Does it land beyond the space it names? The page warns when so. */
export function workTypeTouchesOtherSpaces(payload: WorkTypePayload): boolean {
  return payload.operations.some(
    (operation) =>
      (operation.op === 'add_to_scheme' &&
        (operation.sharedWith.length > 0 || operation.moreShared)) ||
      (operation.op === 'set_icon' && payload.workType.id !== null)
  );
}

export function describeWorkTypeReach(payload: WorkTypePayload, siteUrl: string | null): string {
  const where = `${payload.space.key}${siteUrl ? ` on ${siteUrl}` : ''}`;
  const scheme = payload.operations.find((operation) => operation.op === 'add_to_scheme');
  const shared = scheme?.op === 'add_to_scheme' ? scheme.sharedWith : [];
  const more = scheme?.op === 'add_to_scheme' ? scheme.moreShared : false;
  const lead =
    `The work type “${payload.workType.name}” in ${where}. Work types are site-wide: everyone ` +
    'administering Jira sees it in the work type list.';
  const parts = [lead];
  if (shared.length > 0 || more) {
    parts.push(
      `${payload.space.key}’s work type scheme is shared` +
        (shared.length > 0
          ? ` with ${listWords(shared.slice(0, 8))}${shared.length > 8 || more ? ' and more' : ''}`
          : ' with other spaces') +
        ', and the work type appears in those spaces as well.'
    );
  } else if (scheme) {
    parts.push(`The work type scheme it joins is ${payload.space.key}’s alone.`);
  }
  if (payload.workType.id && payload.operations.some((operation) => operation.op === 'set_icon')) {
    parts.push('Its new icon shows in every space that uses it.');
  }
  return parts.join(' ');
}

/** "New work type “Incident” for OPS" / "“Incident” for OPS" — a list row's title. */
export function workTypeTitle(payload: WorkTypePayload): string {
  const title = payload.operations.some((operation) => operation.op === 'create_work_type')
    ? `New work type “${payload.workType.name}” for ${payload.space.key}`
    : `“${payload.workType.name}” for ${payload.space.key}`;
  return title.length > 300 ? `${title.slice(0, 299)}…` : title;
}

// ---- reading ---------------------------------------------------------------

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function readOperation(value: unknown): WorkTypeOperation | null {
  const record = rec(value);
  switch (record.op) {
    case 'create_work_type':
      if (!str(record.name)) return null;
      return {
        op: 'create_work_type',
        name: str(record.name),
        description: str(record.description) || null,
        subtask: record.subtask === true,
      };
    case 'set_icon':
      if (!str(record.avatarId)) return null;
      return {
        op: 'set_icon',
        avatarId: str(record.avatarId),
        iconName: str(record.iconName) || str(record.avatarId),
      };
    case 'add_to_scheme':
      if (!str(record.schemeId)) return null;
      return {
        op: 'add_to_scheme',
        schemeId: str(record.schemeId),
        schemeName: str(record.schemeName),
        sharedWith: strings(record.sharedWith),
        moreShared: record.moreShared === true,
      };
    case 'map_screens':
      if (!str(record.schemeId) || !str(record.screenSchemeId)) return null;
      return {
        op: 'map_screens',
        schemeId: str(record.schemeId),
        schemeName: str(record.schemeName),
        screenSchemeId: str(record.screenSchemeId),
        screenSchemeName: str(record.screenSchemeName),
        likeName: str(record.likeName),
      };
    case 'map_workflow':
      if (!str(record.schemeId) || !str(record.workflowId)) return null;
      return {
        op: 'map_workflow',
        schemeId: str(record.schemeId),
        schemeName: str(record.schemeName),
        workflowId: str(record.workflowId),
        workflowName: str(record.workflowName),
        likeName: str(record.likeName) || null,
      };
    default:
      return null;
  }
}

/** The payload as stored, or null when it is not one this code wrote in full. */
export function readWorkTypePayload(value: unknown): WorkTypePayload | null {
  const record = rec(value);
  const space = rec(record.space);
  const workType = rec(record.workType);
  if (!str(space.id) || !str(space.key) || !str(workType.name)) return null;
  if (!Array.isArray(record.operations) || record.operations.length === 0) return null;
  const operations: WorkTypeOperation[] = [];
  for (const item of record.operations) {
    const operation = readOperation(item);
    if (!operation) return null;
    operations.push(operation);
  }
  const creates = operations[0]?.op === 'create_work_type';
  if (operations.slice(1).some((operation) => operation.op === 'create_work_type')) return null;
  if (!creates && !str(workType.id)) return null;
  return {
    space: { id: str(space.id), key: str(space.key), serviceDesk: space.serviceDesk === true },
    workType: {
      id: creates ? null : str(workType.id),
      name: str(workType.name),
      subtask: workType.subtask === true,
    },
    operations,
  };
}

// ---- applying ----------------------------------------------------------------

type Step = { ok: true; note?: string } | { ok: false; error: string };

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Site-wide work types only: a team-managed space's own types carry a `scope`. */
export function siteWideWorkTypes(body: unknown): Record<string, unknown>[] {
  return records(body).filter((type) => Object.keys(rec(type.scope)).length === 0);
}

async function createWorkType(
  scope: LogScope,
  access: JiraAdminAccess,
  operation: CreateWorkTypeOperation
): Promise<Step & { workTypeId?: string }> {
  const listing = await jiraAdminGet(scope, access, '/rest/api/3/issuetype');
  if (!listing.ok) return { ok: false, error: `Checking the name is free: ${listing.error}` };
  const taken = siteWideWorkTypes(listing.body).find((type) =>
    same(str(type.name), operation.name)
  );
  if (taken) {
    return {
      ok: false,
      error:
        `A work type named “${str(taken.name)}” exists now (${str(taken.id)}), so another was ` +
        'not created. Ask for this again to use that one.',
    };
  }
  const created = await jiraAdminSend(scope, access, 'POST', '/rest/api/3/issuetype', {
    name: operation.name,
    ...(operation.description ? { description: operation.description } : {}),
    hierarchyLevel: operation.subtask ? -1 : 0,
  });
  if (!created.ok) return { ok: false, error: created.error };
  const workTypeId = str(rec(created.body).id);
  if (!workTypeId)
    return { ok: false, error: 'Jira created the work type but did not say its id.' };
  return { ok: true, workTypeId, note: `Created as ${workTypeId}.` };
}

async function setIcon(
  scope: LogScope,
  access: JiraAdminAccess,
  workTypeId: string,
  operation: SetIconOperation
): Promise<Step> {
  const result = await jiraAdminSend(
    scope,
    access,
    'PUT',
    `/rest/api/3/issuetype/${encodeURIComponent(workTypeId)}`,
    { avatarId: Number(operation.avatarId) }
  );
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/** The scheme of this family a space runs on now, by the `/project` association listing. */
async function currentScheme(
  scope: LogScope,
  access: JiraAdminAccess,
  path: string,
  key: string,
  spaceId: string
): Promise<{ ok: true; id: string; name: string } | { ok: false; error: string }> {
  const result = await jiraAdminGet(
    scope,
    access,
    `${path}?projectId=${encodeURIComponent(spaceId)}`
  );
  if (!result.ok) return { ok: false, error: result.error };
  const scheme = rec(records(result.body)[0]?.[key]);
  return str(scheme.id)
    ? { ok: true, id: str(scheme.id), name: str(scheme.name) }
    : { ok: false, error: 'Jira did not say which scheme the space uses.' };
}

async function addToScheme(
  scope: LogScope,
  access: JiraAdminAccess,
  payload: WorkTypePayload,
  workTypeId: string,
  operation: AddToSchemeOperation
): Promise<Step> {
  const scheme = await currentScheme(
    scope,
    access,
    '/rest/api/3/issuetypescheme/project',
    'issueTypeScheme',
    payload.space.id
  );
  if (!scheme.ok)
    return { ok: false, error: `Reading ${payload.space.key}’s scheme: ${scheme.error}` };
  if (scheme.id !== operation.schemeId) {
    return {
      ok: false,
      error:
        `${payload.space.key} runs on a different work type scheme now (“${scheme.name}”), so ` +
        'the work type was not added to it. Ask for this again.',
    };
  }
  const mapping = await jiraAdminPages(
    scope,
    access,
    `/rest/api/3/issuetypescheme/mapping?issueTypeSchemeId=${encodeURIComponent(scheme.id)}`
  );
  if (!mapping.ok) return { ok: false, error: `Reading the scheme: ${mapping.error}` };
  if (mapping.values.some((item) => str(item.issueTypeId) === workTypeId)) {
    return { ok: true, note: 'It was in the scheme already.' };
  }
  const result = await jiraAdminSend(
    scope,
    access,
    'PUT',
    `/rest/api/3/issuetypescheme/${encodeURIComponent(scheme.id)}/issuetype`,
    { issueTypeIds: [workTypeId] }
  );
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

async function mapScreens(
  scope: LogScope,
  access: JiraAdminAccess,
  payload: WorkTypePayload,
  workTypeId: string,
  operation: MapScreensOperation
): Promise<Step> {
  const scheme = await currentScheme(
    scope,
    access,
    '/rest/api/3/issuetypescreenscheme/project',
    'issueTypeScreenScheme',
    payload.space.id
  );
  if (!scheme.ok) {
    return { ok: false, error: `Reading ${payload.space.key}’s screens scheme: ${scheme.error}` };
  }
  if (scheme.id !== operation.schemeId) {
    return {
      ok: false,
      error:
        `${payload.space.key} runs on a different screens scheme now (“${scheme.name}”), so ` +
        'the work type’s screens were not set. Ask for this again.',
    };
  }
  const mapping = await jiraAdminPages(
    scope,
    access,
    `/rest/api/3/issuetypescreenscheme/mapping?issueTypeScreenSchemeId=${encodeURIComponent(scheme.id)}`
  );
  if (!mapping.ok) return { ok: false, error: `Reading the screens scheme: ${mapping.error}` };
  const held = mapping.values.find((item) => str(item.issueTypeId) === workTypeId);
  if (held) {
    return str(held.screenSchemeId) === operation.screenSchemeId
      ? { ok: true, note: 'It was mapped to those screens already.' }
      : {
          ok: false,
          error:
            'The screens scheme maps the work type to other screens now, so it was left as is.',
        };
  }
  const result = await jiraAdminSend(
    scope,
    access,
    'PUT',
    `/rest/api/3/issuetypescreenscheme/${encodeURIComponent(scheme.id)}/mapping`,
    { issueTypeMappings: [{ issueTypeId: workTypeId, screenSchemeId: operation.screenSchemeId }] }
  );
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

export interface WorkflowSchemeRead {
  id: string;
  name: string;
  version: { id: string; versionNumber: number };
  defaultWorkflow: { id: string; name: string };
  workflows: { id: string; name: string; issueTypeIds: string[] }[];
}

/** A workflow scheme in full — its version, default and mappings — by the bulk read. */
export async function readWorkflowScheme(
  scope: LogScope,
  access: JiraAdminAccess,
  schemeId: string
): Promise<{ ok: true; scheme: WorkflowSchemeRead } | { ok: false; error: string }> {
  const result = await jiraAdminSend(scope, access, 'POST', '/rest/api/3/workflowscheme/read', {
    workflowSchemeIds: [schemeId],
  });
  if (!result.ok) return { ok: false, error: result.error };
  const found = records(result.body).find((scheme) => str(scheme.id) === schemeId);
  if (!found) return { ok: false, error: 'Jira did not return the workflow scheme.' };
  const version = rec(found.version);
  const defaultWorkflow = rec(found.defaultWorkflow);
  return {
    ok: true,
    scheme: {
      id: str(found.id),
      name: str(found.name),
      version: { id: str(version.id), versionNumber: Number(version.versionNumber) || 0 },
      defaultWorkflow: { id: str(defaultWorkflow.id), name: str(defaultWorkflow.name) },
      workflows: records(found.workflowsForIssueTypes).map((item) => ({
        id: str(rec(item.workflow).id),
        name: str(rec(item.workflow).name),
        issueTypeIds: strings(item.issueTypeIds),
      })),
    },
  };
}

async function mapWorkflow(
  scope: LogScope,
  access: JiraAdminAccess,
  payload: WorkTypePayload,
  workTypeId: string,
  operation: MapWorkflowOperation
): Promise<Step> {
  const current = await currentScheme(
    scope,
    access,
    '/rest/api/3/workflowscheme/project',
    'workflowScheme',
    payload.space.id
  );
  if (!current.ok) {
    return { ok: false, error: `Reading ${payload.space.key}’s workflow scheme: ${current.error}` };
  }
  if (current.id !== operation.schemeId) {
    return {
      ok: false,
      error:
        `${payload.space.key} runs on a different workflow scheme now (“${current.name}”), so ` +
        'the work type’s workflow was not set. Ask for this again.',
    };
  }
  const read = await readWorkflowScheme(scope, access, operation.schemeId);
  if (!read.ok) return { ok: false, error: `Reading the workflow scheme: ${read.error}` };
  const { scheme } = read;
  const held = scheme.workflows.find((workflow) => workflow.issueTypeIds.includes(workTypeId));
  if (held) {
    return held.id === operation.workflowId
      ? { ok: true, note: 'It ran on that workflow already.' }
      : {
          ok: false,
          error: `The scheme runs the work type on “${held.name}” now, so it was left as is.`,
        };
  }
  if (scheme.defaultWorkflow.id === operation.workflowId) {
    return { ok: true, note: 'That is the scheme’s default workflow, which it runs on already.' };
  }
  const workflows = scheme.workflows.map((workflow) => ({
    workflowId: workflow.id,
    issueTypeIds:
      workflow.id === operation.workflowId
        ? [...workflow.issueTypeIds, workTypeId]
        : workflow.issueTypeIds,
  }));
  if (!workflows.some((workflow) => workflow.workflowId === operation.workflowId)) {
    workflows.push({ workflowId: operation.workflowId, issueTypeIds: [workTypeId] });
  }
  const result = await jiraAdminSend(scope, access, 'POST', '/rest/api/3/workflowscheme/update', {
    id: scheme.id,
    version: scheme.version,
    ...(scheme.defaultWorkflow.id ? { defaultWorkflowId: scheme.defaultWorkflow.id } : {}),
    workflowsForIssueTypes: workflows,
  });
  return result.ok ? { ok: true } : { ok: false, error: result.error };
}

/**
 * Apply a stored work type proposal, in order, stopping at the first
 * operation that fails.
 */
export async function applyWorkType(
  scope: LogScope,
  access: JiraAdminAccess,
  payload: WorkTypePayload
): Promise<{ status: 'applied' | 'partial' | 'failed'; results: OperationResult[] }> {
  const results: OperationResult[] = [];
  let workTypeId = payload.workType.id;
  let stopped = false;
  for (const operation of payload.operations) {
    const label = describeWorkTypeOperation(operation, payload).text;
    if (stopped) {
      results.push({ label, outcome: 'not_run' });
      continue;
    }
    let step: Step;
    if (operation.op === 'create_work_type') {
      const created = await createWorkType(scope, access, operation);
      if (created.ok && created.workTypeId) workTypeId = created.workTypeId;
      step = created;
    } else if (!workTypeId) {
      step = { ok: false, error: 'The work type was not created, so nothing can be done with it.' };
    } else if (operation.op === 'set_icon') {
      step = await setIcon(scope, access, workTypeId, operation);
    } else if (operation.op === 'add_to_scheme') {
      step = await addToScheme(scope, access, payload, workTypeId, operation);
    } else if (operation.op === 'map_screens') {
      step = await mapScreens(scope, access, payload, workTypeId, operation);
    } else {
      step = await mapWorkflow(scope, access, payload, workTypeId, operation);
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
