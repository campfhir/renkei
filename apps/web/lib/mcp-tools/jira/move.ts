/* eslint-disable @typescript-eslint/consistent-type-assertions */
/**
 * Moving issues between projects — jira_move_issues and its preview pair.
 *
 * ## Why this is not jira_update_issue with a project field
 *
 * The platform edit API refuses a project change: a move re-keys the issue
 * (ENG-42 becomes OPS-7), remaps its work type, workflow status and field
 * configuration, and Jira only does that through its bulk-move operation
 * (`POST /rest/api/3/bulk/issues/move`), which runs as a queued task. So
 * this tool submits the task, polls it, and then reads the issues back by
 * ID — the one thing a move does not change — to learn the new keys.
 *
 * ## What is checked before anything moves
 *
 * The API accepts a move that silently drops data, and the UI wizard exists
 * precisely to stop a person doing that by accident. The preflight stands
 * in for the wizard: it reads the source issues and the target work type's
 * create screen, blocks on a required target field no source issue has (the
 * caller supplies it in `fields`), and warns about populated fields the
 * target cannot hold. The preview card shows the same answer without
 * moving anything.
 *
 * ## Service desks: request type follows work type
 *
 * In Jira Service Management a request type is a customer-facing skin over
 * exactly one work type (issue type) — "Get IT help" is a Service Request,
 * "Report an outage" is an Incident. Moving an issue into a service desk
 * project therefore has two halves: the bulk move sets the work type, and a
 * follow-up edit sets the Request Type field, which the move leaves empty.
 * Without that second write the ticket exists for agents but never appears
 * in the customer portal or the desk's queues. The request type is inferred
 * from the work type when only one is backed by it; when several are, the
 * caller has to choose, and a caller's choice is refused when it is backed
 * by a different work type than the one being moved to.
 */

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/server';
import { actMeta } from '@renkei/tool-outcomes';
import type { MCPToolContext } from '../common';
import { getCachedDisplayName } from '../common';
import { logger } from '@/lib/logger';
import {
  buildFieldUpdates,
  isRequestTypeField,
  loadFieldSchema,
  type JiraField,
} from './field-schema';
import { writeWithFieldFallback } from './field-write';
import { recordUnwritten } from './write';
import { issueLinksMarkdown } from './issue-urls';
import {
  APP_ONLY_META,
  ISSUE_PREVIEW_URI,
  confirmGuard,
  previewToolMeta,
  newPreviewId,
} from '../widgets';
import { granularJiraScopes, describeJiraAuthFailure, type JiraAuth } from './jira-auth';
import { resolveProject, type ResolvedProjectRecord } from './work-types';

const TOOL = 'jira_move_issues';
const STATUS_TOOL = 'jira_get_bulk_operation';

/** Per call. The API takes 1000; a reply that lists the new keys should not. */
const MAX_ISSUES = 100;

/**
 * How long a call waits for the queued move before handing back the task
 * id. Well inside the MCP request budget; a large move that takes longer
 * is finished with jira_get_bulk_operation.
 */
const DEFAULT_POLL_BUDGET_MS = 45_000;
const POLL_INITIAL_MS = 1_000;
const POLL_MAX_MS = 3_000;

const TERMINAL_STATUSES = new Set(['COMPLETE', 'FAILED', 'CANCELLED', 'DEAD']);

/**
 * Fields whose value is a property of the project or board, so a move
 * between projects always clears them whatever the target's screens say.
 */
const PROJECT_SCOPED_FIELDS = new Set(['components', 'fixVersions', 'versions']);

/**
 * Custom field types that never survive a move or are derived rather than
 * entered — flagging them as "will be lost" would be noise on every JSM
 * ticket. Request Type is handled on its own path.
 */
const IGNORED_CUSTOM_TYPE_SUFFIXES = [
  ':vp-origin',
  ':sd-sla-field',
  ':sd-request-feedback',
  ':sd-request-feedback-date',
  ':sd-request-lang',
  ':gh-lexo-rank',
  ':devsummary',
];

/** Required on every create screen and set by the move itself. */
const REQUIRED_BY_THE_MOVE = new Set(['project', 'issuetype', 'summary', 'reporter', 'issuekey']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
}

function isEmpty(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    value === '' ||
    (Array.isArray(value) && value.length === 0)
  );
}

function errText(value: string) {
  return { content: [{ type: 'text' as const, text: value }], isError: true };
}

function list(items: readonly string[]): string {
  return items.map((item) => `• ${item}`).join('\n');
}

export type Sleep = (ms: number) => Promise<void>;

const realSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export interface MoveToolOptions {
  /** Test seam: replaces the wait between task polls. */
  sleep?: Sleep;
  /** Test seam: how long to keep polling before handing back the task id. */
  pollBudgetMs?: number;
}

// ——— What the preflight learns ————————————————————————————————————————

interface SourceIssue {
  id: string;
  key: string;
  summary: string;
  issueTypeId: string;
  issueTypeName: string;
  subtask: boolean;
  projectKey: string;
  serviceDesk: boolean;
  statusName: string;
  subtaskCount: number;
  fields: Record<string, unknown>;
}

interface WorkType {
  id: string;
  name: string;
  subtask: boolean;
}

interface RequestType {
  id: string;
  name: string;
  issueTypeId: string;
}

interface TargetField {
  id: string;
  name: string;
  required: boolean;
  hasDefaultValue: boolean;
  allowedValues: string[];
}

/** One bulk-move `targetMandatoryFields` entry. */
interface MandatoryFieldValue {
  retain: boolean;
  type: 'raw' | 'adf';
  value: unknown;
}

interface MovePlan {
  issues: SourceIssue[];
  target: ResolvedProjectRecord;
  serviceDesk: boolean;
  workType: WorkType;
  parentKey: string | null;
  /** Resolved for a service-desk target; null when none applies or none could be found. */
  requestType: RequestType | null;
  /** The site's Request Type field, when it has one. */
  requestTypeFieldId: string | null;
  /** Required target fields the caller supplied, in bulk-move shape. */
  mandatory: Record<string, MandatoryFieldValue>;
  /** Everything the caller supplied, resolved for a platform edit after the move. */
  supplied: {
    fields: Record<string, unknown>;
    labels: Record<string, string>;
    hints: Record<string, string>;
  };
  warnings: string[];
  notify: boolean;
}

type Preflight =
  { ok: true; plan: MovePlan } | { ok: false; problems: string[]; warnings: string[] };

// ——— Reading the two sides ————————————————————————————————————————————

function parseSourceIssue(raw: unknown): SourceIssue | null {
  if (!isRecord(raw) || !isRecord(raw.fields)) return null;
  const fields = raw.fields;
  const issuetype = isRecord(fields.issuetype) ? fields.issuetype : {};
  const project = isRecord(fields.project) ? fields.project : {};
  const status = isRecord(fields.status) ? fields.status : {};
  const key = str(raw.key);
  const id = str(raw.id);
  if (!key || !id) return null;
  return {
    id,
    key,
    summary: str(fields.summary),
    issueTypeId: str(issuetype.id),
    issueTypeName: str(issuetype.name),
    subtask: issuetype.subtask === true,
    projectKey: str(project.key),
    serviceDesk: project.projectTypeKey === 'service_desk',
    statusName: str(status.name),
    subtaskCount: Array.isArray(fields.subtasks) ? fields.subtasks.length : 0,
    fields,
  };
}

/**
 * The source issues, every field included: the preflight compares what
 * they hold against what the target can take. One bulkfetch, not a GET
 * per issue — the heavy collections (comments, attachments, worklogs) are
 * excluded because nothing here reads them.
 */
async function loadSourceIssues(
  auth: JiraAuth,
  keys: string[]
): Promise<{ issues: SourceIssue[]; problems: string[] }> {
  const response = await auth.fetch(granularJiraScopes(TOOL, true), '/rest/api/3/issue/bulkfetch', {
    method: 'POST',
    body: JSON.stringify({
      issueIdsOrKeys: keys,
      fields: ['*all', '-comment', '-attachment', '-worklog', '-watches', '-votes'],
    }),
  });
  if (!response.ok) throw new Error(await describeJiraAuthFailure(response));
  const body: unknown = await response.json();
  const issues = (isRecord(body) && Array.isArray(body.issues) ? body.issues : [])
    .map(parseSourceIssue)
    .filter((issue): issue is SourceIssue => issue !== null);

  const problems: string[] = [];
  const found = new Set(issues.map((issue) => issue.key.toUpperCase()));
  const errors =
    isRecord(body) && Array.isArray(body.issueErrors)
      ? body.issueErrors.map((entry) => (isRecord(entry) ? str(entry.id) : '')).filter(Boolean)
      : [];
  for (const key of keys) {
    if (!found.has(key.toUpperCase())) {
      problems.push(
        `${key}: not found or not visible to you` +
          (errors.includes(key) ? '' : ' (Jira returned nothing for it)')
      );
    }
  }
  return { issues, problems };
}

async function loadTargetWorkTypes(auth: JiraAuth, projectId: string): Promise<WorkType[]> {
  const response = await auth.fetch(
    granularJiraScopes(TOOL, true),
    `/rest/api/3/issuetype/project?projectId=${encodeURIComponent(projectId)}`
  );
  if (!response.ok) throw new Error(await describeJiraAuthFailure(response));
  const body: unknown = await response.json();
  return (Array.isArray(body) ? body : [])
    .filter(isRecord)
    .map((entry) => ({ id: str(entry.id), name: str(entry.name), subtask: entry.subtask === true }))
    .filter((entry) => entry.id && entry.name);
}

/**
 * The target work type's create screen: which fields it has, which are
 * required. Null when it cannot be read — the move still goes ahead, with
 * the field checks declared skipped rather than silently passed.
 */
async function loadTargetFields(
  auth: JiraAuth,
  projectId: string,
  issueTypeId: string
): Promise<TargetField[] | null> {
  try {
    const response = await auth.fetch(
      granularJiraScopes(TOOL, true),
      `/rest/api/3/issue/createmeta/${encodeURIComponent(projectId)}` +
        `/issuetypes/${encodeURIComponent(issueTypeId)}?maxResults=200`
    );
    if (!response.ok) throw new Error(await describeJiraAuthFailure(response));
    const body: unknown = await response.json();
    const raw = isRecord(body) && Array.isArray(body.fields) ? body.fields : [];
    return raw.filter(isRecord).map((entry) => ({
      id: str(entry.fieldId) || str(entry.key),
      name: str(entry.name) || str(entry.fieldId),
      required: entry.required === true,
      hasDefaultValue: entry.hasDefaultValue === true,
      allowedValues: (Array.isArray(entry.allowedValues) ? entry.allowedValues : [])
        .map((option) =>
          isRecord(option) ? str(option.name) || str(option.value) || str(option.id) : str(option)
        )
        .filter(Boolean),
    }));
  } catch (error) {
    logger.debug('Could not read the target create screen', {
      component: 'jira/move',
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Every request type of the service desk behind `projectKey`, with the
 * work type each is backed by. Null when the JSM API is not reachable on
 * this grant — the Jira app carries JSM scopes only when the site was
 * connected as one app — so the caller can say "could not infer" instead
 * of guessing.
 */
async function loadRequestTypes(auth: JiraAuth, projectKey: string): Promise<RequestType[] | null> {
  try {
    const desk = await auth.fetch(
      granularJiraScopes(TOOL, true),
      `/rest/servicedeskapi/servicedesk/${encodeURIComponent(projectKey)}`
    );
    if (!desk.ok) throw new Error(await describeJiraAuthFailure(desk));
    const deskBody: unknown = await desk.json();
    const deskId = isRecord(deskBody) ? str(deskBody.id) : '';
    if (!deskId) throw new Error('service desk answered without an id');

    const out: RequestType[] = [];
    let start = 0;
    for (;;) {
      const page = await auth.fetch(
        granularJiraScopes(TOOL, true),
        `/rest/servicedeskapi/servicedesk/${encodeURIComponent(deskId)}/requesttype` +
          `?start=${start}&limit=100`
      );
      if (!page.ok) throw new Error(await describeJiraAuthFailure(page));
      const body: unknown = await page.json();
      const values = isRecord(body) && Array.isArray(body.values) ? body.values : [];
      for (const entry of values) {
        if (!isRecord(entry)) continue;
        const id = str(entry.id);
        const name = str(entry.name);
        if (id && name) out.push({ id, name, issueTypeId: str(entry.issueTypeId) });
      }
      if (!isRecord(body) || body.isLastPage !== false || values.length === 0) break;
      start += values.length;
    }
    return out;
  } catch (error) {
    logger.debug('Could not list the target service desk request types', {
      component: 'jira/move',
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ——— Bulk-move value shapes —————————————————————————————————————————————

/**
 * A resolved edit value, reshaped for `targetMandatoryFields`. The bulk
 * API takes rich text as ADF and everything else as a list of raw strings
 * — ids for options and users, the text itself for text — so the
 * `{ value }` / `{ id }` / `{ accountId }` wrappers the edit API wants are
 * unwrapped here.
 */
function rawValues(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(rawValues);
  if (isRecord(value)) {
    for (const key of ['id', 'accountId', 'value', 'name', 'key']) {
      if (typeof value[key] === 'string') return [value[key] as string];
      if (typeof value[key] === 'number') return [String(value[key])];
    }
    return [JSON.stringify(value)];
  }
  if (value === null || value === undefined) return [];
  return [String(value)];
}

function mandatoryValue(value: unknown): MandatoryFieldValue {
  if (isRecord(value) && value.type === 'doc') return { retain: false, type: 'adf', value };
  return { retain: false, type: 'raw', value: rawValues(value) };
}

// ——— The preflight ————————————————————————————————————————————————————

interface MoveArgs {
  issueKeys: string[];
  targetProjectKey: string;
  targetWorkType: string | null;
  targetRequestType: string | null;
  targetParentKey: string | null;
  fields: Record<string, unknown>;
  notify: boolean;
}

function parseArgs(
  args: Record<string, unknown>
): { ok: true; args: MoveArgs } | { ok: false; problems: string[] } {
  const problems: string[] = [];
  const rawKeys = Array.isArray(args.issueKeys)
    ? args.issueKeys
    : typeof args.issueKeys === 'string'
      ? args.issueKeys.split(/[\s,]+/)
      : [];
  const issueKeys = [
    ...new Set(rawKeys.map((key) => String(key).trim().toUpperCase()).filter(Boolean)),
  ];
  if (issueKeys.length === 0) problems.push('issueKeys is required — at least one issue key');
  if (issueKeys.length > MAX_ISSUES) {
    problems.push(
      `At most ${MAX_ISSUES} issues per call (got ${issueKeys.length}); split the move.`
    );
  }
  const targetProjectKey = str(args.targetProjectKey).trim();
  if (!targetProjectKey) problems.push('targetProjectKey is required');
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    args: {
      issueKeys,
      targetProjectKey,
      targetWorkType: str(args.targetWorkType).trim() || null,
      targetRequestType: str(args.targetRequestType).trim() || null,
      targetParentKey: str(args.targetParentKey).trim().toUpperCase() || null,
      fields: isRecord(args.fields) ? args.fields : {},
      notify: args.notify === true,
    },
  };
}

function matchWorkType(types: WorkType[], reference: string): WorkType | undefined {
  const lower = reference.toLowerCase();
  return types.find((type) => type.id === reference || type.name.toLowerCase() === lower);
}

function matchRequestType(types: RequestType[], reference: string): RequestType | undefined {
  const lower = reference.toLowerCase();
  return types.find((type) => type.id === reference || type.name.toLowerCase() === lower);
}

/**
 * Everything a move needs, or the reasons it cannot proceed. Read-only, so
 * the preview shares it with the move itself and shows the same answer.
 */
async function preflight(
  context: MCPToolContext,
  auth: JiraAuth,
  input: MoveArgs
): Promise<Preflight> {
  const problems: string[] = [];
  const warnings: string[] = [];

  // The two sides, read together — neither depends on the other.
  const [source, resolvedTarget] = await Promise.all([
    loadSourceIssues(auth, input.issueKeys),
    resolveProject(auth, input.targetProjectKey),
  ]);
  problems.push(...source.problems);
  if (!resolvedTarget.ok) problems.push(resolvedTarget.reason);
  if (problems.length > 0 || !resolvedTarget.ok) return { ok: false, problems, warnings };

  const target = resolvedTarget.project;
  const serviceDesk = target.projectTypeKey === 'service_desk';
  const issues = source.issues;

  // The work type. Everything in one call lands on one type — the API's
  // rule, not this tool's — so an unspecified type has to be unanimous.
  const workTypes = await loadTargetWorkTypes(auth, target.id);
  const typeNames = workTypes.map((type) => `${type.name} (${type.id})`).join(', ');
  let workType: WorkType | undefined;
  if (input.targetWorkType) {
    workType = matchWorkType(workTypes, input.targetWorkType);
    if (!workType) {
      problems.push(
        `${target.name} (${target.key}) has no work type "${input.targetWorkType}". ` +
          `Its work types: ${typeNames || '(none visible)'}.`
      );
    }
  } else {
    const sourceTypes = [...new Set(issues.map((issue) => issue.issueTypeName))];
    if (sourceTypes.length > 1) {
      problems.push(
        `The issues have different work types (${sourceTypes.join(', ')}); a single move lands ` +
          `them all on one — pass targetWorkType, or move each type separately.`
      );
    } else {
      workType = matchWorkType(workTypes, sourceTypes[0] ?? '');
      if (!workType) {
        problems.push(
          `${target.name} (${target.key}) has no work type named "${sourceTypes[0]}" to keep; ` +
            `pass targetWorkType — one of: ${typeNames || '(none visible)'}.`
        );
      }
    }
  }
  if (!workType) return { ok: false, problems, warnings };

  const alreadyThere = issues.filter(
    (issue) =>
      issue.projectKey.toUpperCase() === target.key.toUpperCase() &&
      issue.issueTypeId === workType.id
  );
  if (alreadyThere.length > 0) {
    problems.push(
      `Already in ${target.key} as ${workType.name}: ${alreadyThere.map((issue) => issue.key).join(', ')}.`
    );
  }

  if (workType.subtask && !input.targetParentKey) {
    problems.push(
      `${workType.name} is a subtask type, so targetParentKey (the issue in ${target.key} ` +
        `that will own them) is required.`
    );
  }
  if (
    input.targetParentKey &&
    !input.targetParentKey.toUpperCase().startsWith(`${target.key.toUpperCase()}-`)
  ) {
    warnings.push(
      `targetParentKey ${input.targetParentKey} is not in ${target.key}; Jira will refuse the move ` +
        `unless the parent lives in the target project.`
    );
  }

  // The target's create screen against what the sources hold.
  const targetFields = await loadTargetFields(auth, target.id, workType.id);
  const schema = await loadFieldSchema(context, auth).catch((): JiraField[] => []);
  const schemaById = new Map(schema.map((field) => [field.id, field]));

  // Anything the caller wants set — resolved against the TARGET's options,
  // since that is where the values have to be valid.
  const updates =
    Object.keys(input.fields).length > 0
      ? await buildFieldUpdates(context, auth, input.fields, {
          projectKey: target.key,
          issueType: workType.name,
        })
      : { fields: {}, applied: [], problems: [], optionHints: {} };
  problems.push(...updates.problems.map((problem) => `fields: ${problem}`));
  const suppliedLabels: Record<string, string> = {};
  for (const id of Object.keys(updates.fields)) {
    suppliedLabels[id] = updates.applied.find((entry) => entry.includes(id)) ?? id;
  }

  const mandatory: Record<string, MandatoryFieldValue> = {};
  if (targetFields === null) {
    warnings.push(
      `Could not read the ${workType.name} create screen in ${target.key}; required-field and ` +
        `lost-field checks were skipped — Jira will report any field it cannot accept.`
    );
  } else {
    const targetById = new Map(targetFields.map((field) => [field.id, field]));

    for (const field of targetFields) {
      if (!field.required || REQUIRED_BY_THE_MOVE.has(field.id)) continue;
      if (field.id in updates.fields) {
        mandatory[field.id] = mandatoryValue(updates.fields[field.id]);
        continue;
      }
      if (field.hasDefaultValue) continue;
      const missingOn = issues.filter((issue) => isEmpty(issue.fields[field.id]));
      if (missingOn.length === 0) continue;
      const options = field.allowedValues.slice(0, 8).join(', ');
      problems.push(
        `${field.name} (${field.id}) is required for ${workType.name} in ${target.key} and empty on ` +
          `${missingOn.map((issue) => issue.key).join(', ')} — pass it in fields` +
          (options ? ` (valid: ${options}${field.allowedValues.length > 8 ? ', …' : ''})` : '') +
          '.'
      );
    }

    // Populated fields the target cannot hold. Custom fields by absence
    // from the screen; project-scoped system fields unconditionally, since
    // their values belong to the old project even when the field exists.
    const lost = new Map<string, string[]>();
    const cleared = new Map<string, string[]>();
    for (const issue of issues) {
      for (const [id, value] of Object.entries(issue.fields)) {
        if (isEmpty(value) || id in updates.fields) continue;
        const meta = schemaById.get(id);
        const name = meta?.name ?? id;
        if (
          PROJECT_SCOPED_FIELDS.has(id) &&
          issue.projectKey.toUpperCase() !== target.key.toUpperCase()
        ) {
          cleared.set(name, [...(cleared.get(name) ?? []), issue.key]);
          continue;
        }
        if (!id.startsWith('customfield_')) continue;
        const customType = meta?.customType ?? '';
        if (IGNORED_CUSTOM_TYPE_SUFFIXES.some((suffix) => customType.endsWith(suffix))) continue;
        if (targetById.has(id)) continue;
        lost.set(name, [...(lost.get(name) ?? []), issue.key]);
      }
    }
    const describe = (entries: Map<string, string[]>) =>
      [...entries.entries()].map(([name, keys]) => `${name} (${keys.join(', ')})`).join('; ');
    if (cleared.size > 0) {
      warnings.push(`Project-scoped values will be cleared by the move: ${describe(cleared)}.`);
    }
    if (lost.size > 0) {
      warnings.push(
        `Not on the ${workType.name} create screen in ${target.key} — Jira may clear these on ` +
          `move: ${describe(lost)}.`
      );
    }
  }

  // Service desks: the request type, and where it goes.
  let requestType: RequestType | null = null;
  let requestTypeFieldId: string | null = null;
  if (serviceDesk) {
    requestTypeFieldId = schema.find(isRequestTypeField)?.id ?? null;
    const requestTypes = await loadRequestTypes(auth, target.key);
    const backedBy = (typeId: string) =>
      (requestTypes ?? []).filter((type) => type.issueTypeId === typeId);
    const nameOfType = (typeId: string) =>
      workTypes.find((type) => type.id === typeId)?.name ?? `work type ${typeId}`;

    if (input.targetRequestType) {
      if (requestTypes === null) {
        if (/^\d+$/.test(input.targetRequestType)) {
          requestType = {
            id: input.targetRequestType,
            name: input.targetRequestType,
            issueTypeId: '',
          };
          warnings.push(
            `Request type ${input.targetRequestType} could not be checked against ${workType.name} ` +
              `(the service desk API is not reachable on this grant); it will be set as given.`
          );
        } else {
          problems.push(
            `Request type "${input.targetRequestType}" could not be looked up — the service desk ` +
              `API is not reachable on this grant. Pass its numeric id (jsm_list_request_types).`
          );
        }
      } else {
        const match = matchRequestType(requestTypes, input.targetRequestType);
        if (!match) {
          problems.push(
            `${target.name} has no request type "${input.targetRequestType}". Backed by ` +
              `${workType.name}: ${
                backedBy(workType.id)
                  .map((type) => `${type.name} (${type.id})`)
                  .join(', ') || '(none)'
              }.`
          );
        } else if (match.issueTypeId && match.issueTypeId !== workType.id) {
          const alternatives = backedBy(workType.id);
          problems.push(
            `Request type "${match.name}" is backed by ${nameOfType(match.issueTypeId)}, not ` +
              `${workType.name} — a request type follows its work type. Either pass ` +
              `targetWorkType "${nameOfType(match.issueTypeId)}", or keep ${workType.name} and choose ` +
              (alternatives.length > 0
                ? `one of: ${alternatives.map((type) => `${type.name} (${type.id})`).join(', ')}.`
                : 'a work type that has request types.')
          );
        } else {
          requestType = match;
        }
      }
    } else if (requestTypes === null) {
      warnings.push(
        `${target.name} is a service desk, but its request types could not be listed on this ` +
          `grant, so none will be set — pass targetRequestType (an id from jsm_list_request_types) ` +
          `or set Request Type afterwards with jira_update_issue.`
      );
    } else {
      const candidates = backedBy(workType.id);
      if (candidates.length === 1) {
        requestType = candidates[0] ?? null;
      } else if (candidates.length === 0) {
        const typesWithRequests = [...new Set(requestTypes.map((type) => type.issueTypeId))]
          .map(nameOfType)
          .join(', ');
        warnings.push(
          `No request type in ${target.name} is backed by ${workType.name}; the moved issues will ` +
            `have no request type and will not show in the customer portal. Work types with request ` +
            `types: ${typesWithRequests || '(none)'}.`
        );
      } else {
        problems.push(
          `${candidates.length} request types in ${target.name} are backed by ${workType.name} — ` +
            `pass targetRequestType: ${candidates.map((type) => `${type.name} (${type.id})`).join(', ')}.`
        );
      }
    }

    if (requestType && !requestTypeFieldId) {
      warnings.push(
        'This site exposes no Request Type field to the API, so the request type cannot be written ' +
          'after the move.'
      );
      requestType = null;
    }
  } else if (issues.some((issue) => issue.serviceDesk)) {
    warnings.push(
      `${target.name} (${target.key}) is not a service desk: request types, SLAs and customer ` +
        `portal visibility do not carry over.`
    );
  }

  if (problems.length > 0) return { ok: false, problems, warnings };
  return {
    ok: true,
    plan: {
      issues,
      target,
      serviceDesk,
      workType,
      parentKey: input.targetParentKey,
      requestType,
      requestTypeFieldId,
      mandatory,
      supplied: { fields: updates.fields, labels: suppliedLabels, hints: updates.optionHints },
      warnings,
      notify: input.notify,
    },
  };
}

// ——— The move ————————————————————————————————————————————————————————

interface TaskProgress {
  taskId: string;
  status: string;
  progressPercent: number;
  processed: string[];
  failed: Record<string, string[]>;
  invalidCount: number;
  totalCount: number;
}

function parseProgress(body: unknown, fallbackTaskId: string): TaskProgress {
  const record = isRecord(body) ? body : {};
  const failed: Record<string, string[]> = {};
  if (isRecord(record.failedAccessibleIssues)) {
    for (const [id, reasons] of Object.entries(record.failedAccessibleIssues)) {
      failed[id] = Array.isArray(reasons) ? reasons.map(String) : [String(reasons)];
    }
  }
  return {
    taskId: str(record.taskId) || fallbackTaskId,
    status: str(record.status) || 'UNKNOWN',
    progressPercent: typeof record.progressPercent === 'number' ? record.progressPercent : 0,
    processed: Array.isArray(record.processedAccessibleIssues)
      ? record.processedAccessibleIssues.map(String)
      : [],
    failed,
    invalidCount:
      typeof record.invalidOrInaccessibleIssueCount === 'number'
        ? record.invalidOrInaccessibleIssueCount
        : 0,
    totalCount: typeof record.totalIssueCount === 'number' ? record.totalIssueCount : 0,
  };
}

async function readProgress(auth: JiraAuth, taskId: string): Promise<TaskProgress> {
  const response = await auth.fetch(
    granularJiraScopes(STATUS_TOOL, true),
    `/rest/api/3/bulk/queue/${encodeURIComponent(taskId)}`
  );
  if (!response.ok) throw new Error(await describeJiraAuthFailure(response));
  return parseProgress(await response.json(), taskId);
}

async function waitForTask(
  auth: JiraAuth,
  taskId: string,
  sleep: Sleep,
  budgetMs: number
): Promise<TaskProgress> {
  const deadline = Date.now() + budgetMs;
  let delay = POLL_INITIAL_MS;
  for (;;) {
    const progress = await readProgress(auth, taskId);
    if (TERMINAL_STATUSES.has(progress.status)) return progress;
    if (Date.now() + delay > deadline) return progress;
    await sleep(delay);
    delay = Math.min(POLL_MAX_MS, Math.round(delay * 1.5));
  }
}

/** Issue ids → their current keys and summaries, after the move re-keyed them. */
async function readKeysById(
  auth: JiraAuth,
  ids: string[]
): Promise<Map<string, { key: string; summary: string }>> {
  const out = new Map<string, { key: string; summary: string }>();
  if (ids.length === 0) return out;
  const response = await auth.fetch(granularJiraScopes(TOOL, true), '/rest/api/3/issue/bulkfetch', {
    method: 'POST',
    body: JSON.stringify({ issueIdsOrKeys: ids, fields: ['summary'] }),
  });
  if (!response.ok) throw new Error(await describeJiraAuthFailure(response));
  const body: unknown = await response.json();
  for (const entry of isRecord(body) && Array.isArray(body.issues) ? body.issues : []) {
    if (!isRecord(entry)) continue;
    const id = str(entry.id);
    const key = str(entry.key);
    if (id && key) {
      out.set(id, { key, summary: isRecord(entry.fields) ? str(entry.fields.summary) : '' });
    }
  }
  return out;
}

function progressSummary(progress: TaskProgress): string {
  const lines = [
    `Bulk operation ${progress.taskId}: ${progress.status} (${progress.progressPercent}%)`,
  ];
  if (progress.totalCount) lines.push(`Issues attempted: ${progress.totalCount}`);
  if (progress.processed.length)
    lines.push(`Succeeded (issue ids): ${progress.processed.join(', ')}`);
  const failed = Object.entries(progress.failed);
  if (failed.length) {
    lines.push('Failed:');
    lines.push(list(failed.map(([id, reasons]) => `issue ${id}: ${reasons.join('; ')}`)));
  }
  if (progress.invalidCount) {
    lines.push(`Invalid or inaccessible issues: ${progress.invalidCount}`);
  }
  return lines.join('\n');
}

export async function registerMoveTools(
  server: McpServer,
  context: MCPToolContext,
  auth: JiraAuth,
  options: MoveToolOptions = {}
): Promise<void> {
  const sleep = options.sleep ?? realSleep;
  const pollBudgetMs = options.pollBudgetMs ?? DEFAULT_POLL_BUDGET_MS;

  const moveSchema = z.object({
    issueKeys: z
      .array(z.string())
      .min(1)
      .max(MAX_ISSUES)
      .describe(
        `Keys of the issues to move, e.g. ["ENG-42", "ENG-43"] (up to ${MAX_ISSUES} per call). ` +
          'Subtasks move with their parent automatically; do not list them separately.'
      ),
    targetProjectKey: z
      .string()
      .describe(
        'Key (or numeric id) of the project to move into, e.g. OPS. jira_list_projects lists them.'
      ),
    targetWorkType: z
      .string()
      .describe(
        'Work type (issue type) the issues become in the target — name or id, as jira_list_work_types ' +
          'shows for that project. Omit to keep the same work type name when the target has it. ' +
          'In a service desk the work type decides which request types are possible.'
      )
      .optional(),
    targetRequestType: z
      .string()
      .describe(
        'Service-desk targets only: the request type (name or id from jsm_list_request_types) the ' +
          'tickets get in the customer portal. Omit to infer it from targetWorkType when exactly one ' +
          'request type is backed by that work type; the tool refuses a request type backed by a ' +
          'different work type.'
      )
      .optional(),
    targetParentKey: z
      .string()
      .describe(
        'Issue in the target project that becomes the parent. Required when targetWorkType is a ' +
          'subtask type; optional to re-parent standard issues under an epic there.'
      )
      .optional(),
    fields: z
      .record(z.string(), z.unknown())
      .describe(
        'Values to set on every moved issue, keyed by field name or id — for a field the target ' +
          'requires that the sources leave empty, or anything to change as part of the move. ' +
          'Resolved against the target project the way jira_update_issue resolves fields.'
      )
      .optional(),
    notify: z
      .boolean()
      .describe("Send Jira's bulk-change notification email to watchers. Default false.")
      .optional(),
  });

  const moveHandler = async (args: Record<string, unknown>) => {
    const displayName = getCachedDisplayName(context.accountId);
    logger.debug(`${TOOL} invoked`, {
      component: 'mcp/tool',
      tenantId: context.tenantId,
      accountId: context.accountId,
      displayName,
    });
    try {
      const parsed = parseArgs(args);
      if (!parsed.ok) return errText(list(parsed.problems));

      const checked = await preflight(context, auth, parsed.args);
      if (!checked.ok) {
        return errText(
          `Nothing was moved.\n${list(checked.problems)}` +
            (checked.warnings.length ? `\nAlso note:\n${list(checked.warnings)}` : '')
        );
      }
      const plan = checked.plan;

      const mappingKey = [
        plan.target.id,
        plan.workType.id,
        ...(plan.parentKey ? [plan.parentKey] : []),
      ].join(',');
      const hasMandatory = Object.keys(plan.mandatory).length > 0;
      const submit = await auth.fetch(
        granularJiraScopes(TOOL, false),
        '/rest/api/3/bulk/issues/move',
        {
          method: 'POST',
          body: JSON.stringify({
            sendBulkNotification: plan.notify,
            targetToSourcesMapping: {
              [mappingKey]: {
                issueIdsOrKeys: plan.issues.map((issue) => issue.id),
                inferClassificationDefaults: true,
                inferStatusDefaults: true,
                inferSubtaskTypeDefault: true,
                inferFieldDefaults: !hasMandatory,
                ...(hasMandatory ? { targetMandatoryFields: [{ fields: plan.mandatory }] } : {}),
              },
            },
          }),
        }
      );
      if (!submit.ok) return errText(await describeJiraAuthFailure(submit));
      const submitted: unknown = await submit.json().catch(() => null);
      const taskId = isRecord(submitted) ? str(submitted.taskId) : '';
      if (!taskId) return errText('Jira accepted the move but returned no task id to follow.');

      const progress = await waitForTask(auth, taskId, sleep, pollBudgetMs);
      const destination = `${plan.target.name} (${plan.target.key}) as ${plan.workType.name}`;

      if (!TERMINAL_STATUSES.has(progress.status)) {
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `The move of ${plan.issues.length} issue(s) to ${destination} is still running in Jira ` +
                `(task ${taskId}, ${progress.status}, ${progress.progressPercent}%). Check it with ` +
                `${STATUS_TOOL} taskId=${taskId}; the moved issues keep their ids, so jira_get_issue by ` +
                `old key redirects to the new one.` +
                (plan.requestType
                  ? ` Request type "${plan.requestType.name}" still has to be set once it finishes ` +
                    `(jira_update_issue, field Request Type = ${plan.requestType.id}).`
                  : ''),
            },
          ],
        };
      }

      if (progress.status !== 'COMPLETE') {
        return errText(`The move did not complete.\n${progressSummary(progress)}`);
      }

      // Re-keyed issues, read back by id. The task reports ids only, and
      // may include subtasks it moved along with their parents.
      const requestedIds = new Set(plan.issues.map((issue) => issue.id));
      const keysById = await readKeysById(auth, progress.processed);
      const moved: { from: SourceIssue; key: string }[] = [];
      const alsoMoved: string[] = [];
      for (const id of progress.processed) {
        const now = keysById.get(id);
        const from = plan.issues.find((issue) => issue.id === id);
        if (from) moved.push({ from, key: now?.key ?? from.key });
        else if (now) alsoMoved.push(now.key);
      }
      const failed: string[] = [];
      for (const issue of plan.issues) {
        if (requestedIds.has(issue.id) && !progress.processed.includes(issue.id)) {
          const reasons = progress.failed[issue.id];
          failed.push(
            `${issue.key}: ${reasons?.join('; ') ?? 'not processed (no reason reported)'}`
          );
        }
      }
      for (const [id, reasons] of Object.entries(progress.failed)) {
        if (!requestedIds.has(id)) failed.push(`issue ${id}: ${reasons.join('; ')}`);
      }

      // The second half of a service-desk move, and whatever else was asked.
      const notes: string[] = [];
      const requestTypeSetOn: string[] = [];
      if (plan.requestType && plan.requestTypeFieldId) {
        for (const entry of moved) {
          try {
            const put = await auth.fetch(
              granularJiraScopes(TOOL, false),
              `/rest/api/3/issue/${encodeURIComponent(entry.key)}`,
              {
                method: 'PUT',
                body: JSON.stringify({
                  fields: { [plan.requestTypeFieldId]: plan.requestType.id },
                }),
              }
            );
            if (!put.ok) throw new Error(await describeJiraAuthFailure(put));
            requestTypeSetOn.push(entry.key);
          } catch (error) {
            notes.push(
              `Request type was not set on ${entry.key} — ${error instanceof Error ? error.message : String(error)}. ` +
                `Set it with jira_update_issue: fields {"Request Type": "${plan.requestType.id}"}.`
            );
          }
        }
      }
      if (Object.keys(plan.supplied.fields).length > 0) {
        for (const entry of moved) {
          try {
            const outcome = await writeWithFieldFallback(
              {
                required: {},
                optional: plan.supplied.fields,
                labels: plan.supplied.labels,
                hints: plan.supplied.hints,
              },
              async (fields) => {
                const put = await auth.fetch(
                  granularJiraScopes(TOOL, false),
                  `/rest/api/3/issue/${encodeURIComponent(entry.key)}`,
                  { method: 'PUT', body: JSON.stringify({ fields }) }
                );
                if (!put.ok) throw new Error(await describeJiraAuthFailure(put));
                return null;
              }
            );
            if (outcome.dropped.length > 0) {
              const commented = await recordUnwritten(context, auth, entry.key, outcome.dropped);
              notes.push(
                `${entry.key}: not set — ${outcome.dropped.map((field) => `${field.label} (${field.reason})`).join('; ')}` +
                  (commented ? ' [recorded as a comment]' : '')
              );
            }
          } catch (error) {
            notes.push(
              `${entry.key}: fields were not applied — ${error instanceof Error ? error.message : String(error)}`
            );
          }
        }
      }

      const lines: string[] = [
        `Moved ${moved.length} of ${plan.issues.length} issue(s) to ${destination}` +
          (plan.parentKey ? ` under ${plan.parentKey}` : '') +
          ':',
        ...moved.map(
          (entry) =>
            `• ${entry.from.key} → ${entry.key}` +
            (entry.from.summary ? ` — ${entry.from.summary}` : '')
        ),
      ];
      if (alsoMoved.length > 0) {
        lines.push(`Moved with their parents: ${alsoMoved.join(', ')}`);
      }
      if (failed.length > 0) lines.push('Not moved:', list(failed));
      if (requestTypeSetOn.length > 0 && plan.requestType) {
        lines.push(
          `Request type "${plan.requestType.name}" set on ${requestTypeSetOn.join(', ')}.`
        );
      }
      if (notes.length > 0) lines.push(list(notes));
      if (plan.warnings.length > 0) lines.push('Note:', list(plan.warnings));
      if (moved.length > 0) {
        lines.push(
          'Old keys redirect to the new ones in Jira; filters, links and automations that name ' +
            'the old keys should be updated.'
        );
        const first = moved[0];
        if (first) lines.push(await issueLinksMarkdown(context.siteUrl, auth, first.key));
      }

      const first = moved[0];
      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
        ...(moved.length === 0 ? { isError: true } : {}),
        ...(first
          ? {
              _meta: actMeta({
                id: first.key,
                url: `${context.siteUrl}/browse/${first.key}`,
                entity: moved.length > 1 ? 'issues' : 'issue',
              }),
            }
          : {}),
      };
    } catch (error) {
      return errText(error instanceof Error ? error.message : String(error));
    }
  };

  server.registerTool(
    TOOL,
    {
      title: 'Jira · Act — Move issues to another project',
      description:
        'Move one or more Jira issues into a different project (or onto a different work type), ' +
        'keeping history, comments and links. Issues get new keys; old keys redirect. Before moving, ' +
        "it checks the target work type's required fields against the source issues and refuses " +
        'with a list of what to pass in `fields`, and warns about values the target cannot hold. ' +
        'For a Jira Service Management target it also sets the request type, which follows the work ' +
        'type: inferred when one request type is backed by targetWorkType, otherwise pass ' +
        'targetRequestType. Statuses missing from the target workflow fall back to its initial ' +
        'status. Prefer jira_move_issues_preview whenever the user should confirm first — a move is ' +
        'not undone by anything short of another move.',
      annotations: { readOnlyHint: false },
      inputSchema: moveSchema,
    },
    moveHandler
  );

  server.registerTool(
    `${TOOL}_preview`,
    {
      title: 'Jira · Act — Preview a move to another project before doing it',
      description:
        'Show the user an interactive card describing a move of Jira issues to another project — ' +
        'destination, work type, request type (service desks), fields that will be set, and values ' +
        'that will be lost — to move or cancel. Runs the same checks as jira_move_issues and ' +
        'returns its refusals instead of a card. Prefer this over jira_move_issues whenever a ' +
        'person is present to confirm: the card does the moving.',
      annotations: { readOnlyHint: false },
      _meta: previewToolMeta(ISSUE_PREVIEW_URI),
      inputSchema: moveSchema,
    },
    async (args: Record<string, unknown>) => {
      try {
        const parsed = parseArgs(args);
        if (!parsed.ok) return errText(list(parsed.problems));
        const checked = await preflight(context, auth, parsed.args);
        if (!checked.ok) {
          return errText(
            `The move cannot be previewed as asked.\n${list(checked.problems)}` +
              (checked.warnings.length ? `\nAlso note:\n${list(checked.warnings)}` : '')
          );
        }
        const plan = checked.plan;
        const from = [
          ...new Set(plan.issues.map((issue) => `${issue.projectKey} · ${issue.issueTypeName}`)),
        ].join(', ');
        const subtasks = plan.issues.reduce((sum, issue) => sum + issue.subtaskCount, 0);
        const fieldsToSet = Object.values(plan.supplied.labels);
        const fields: { label: string; value: string; oldValue?: string }[] = [
          {
            label: plan.issues.length === 1 ? 'Issue' : `Issues (${plan.issues.length})`,
            value: plan.issues
              .map((issue) => `${issue.key}${issue.summary ? ` — ${issue.summary}` : ''}`)
              .join('; '),
          },
          {
            label: 'Destination',
            value: `${plan.target.name} (${plan.target.key}) · ${plan.workType.name}`,
            oldValue: from,
          },
        ];
        if (plan.parentKey) fields.push({ label: 'Parent', value: plan.parentKey });
        if (plan.serviceDesk) {
          fields.push({
            label: 'Request type',
            value: plan.requestType
              ? `${plan.requestType.name} (${plan.requestType.id})`
              : 'None — the tickets will not appear in the customer portal',
          });
        }
        if (fieldsToSet.length > 0)
          fields.push({ label: 'Fields to set', value: fieldsToSet.join('; ') });
        if (subtasks > 0) {
          fields.push({ label: 'Subtasks', value: `${subtasks} — move with their parents` });
        }
        fields.push({
          label: 'Statuses',
          value: 'Kept where the target workflow has them; otherwise its initial status',
        });
        if (plan.warnings.length > 0)
          fields.push({ label: 'Warnings', value: plan.warnings.join(' ') });
        fields.push({
          label: 'Notification',
          value: plan.notify ? 'Bulk-change email to watchers' : 'No email',
        });
        fields.push({
          label: 'Undo',
          value: 'Keys change on move (old keys redirect); moving back is another move',
        });

        const what =
          plan.issues.length === 1
            ? `The move of ${plan.issues[0]?.key}`
            : `The move of ${plan.issues.length} issues`;
        return {
          content: [
            {
              type: 'text' as const,
              text:
                `${what} is awaiting the user's decision on the preview card. Do not move them ` +
                `another way and do not repeat the card's contents in your reply; the user confirms ` +
                `or cancels from the card. If no card appeared in this client, ask the user how to proceed.`,
            },
          ],
          structuredContent: {
            kind: 'issue',
            previewId: newPreviewId(),
            title:
              plan.issues.length === 1
                ? `Move ${plan.issues[0]?.key} to ${plan.target.key}`
                : `Move ${plan.issues.length} issues to ${plan.target.key}`,
            subtitle: `${plan.target.name} · ${plan.workType.name}`,
            confirmTool: `${TOOL}_confirm`,
            confirmLabel: 'Move',
            confirmArgs: args,
            fields,
          },
        };
      } catch (error) {
        return errText(error instanceof Error ? error.message : String(error));
      }
    }
  );

  server.registerTool(
    `${TOOL}_confirm`,
    {
      title: 'Jira · Act — Move previewed issues (card only)',
      description:
        'Move Jira issues the user approved on a preview card.' + confirmGuard(`${TOOL}_preview`),
      annotations: { readOnlyHint: false },
      _meta: APP_ONLY_META,
      inputSchema: moveSchema,
    },
    moveHandler
  );

  server.registerTool(
    STATUS_TOOL,
    {
      title: 'Jira · Read — Check a bulk operation',
      description:
        'Progress of a queued Jira bulk operation by task id — the id jira_move_issues reports ' +
        'when a move is still running. Shows status, percent complete, the issue ids that ' +
        'succeeded, and each failure with its reason. Progress is kept for 14 days.',
      annotations: { readOnlyHint: true },
      inputSchema: z.object({
        taskId: z.string().describe('The task id, e.g. "10641"'),
      }),
    },
    async (args: Record<string, unknown>) => {
      const taskId = str(args.taskId).trim();
      if (!taskId) return errText('taskId is required');
      try {
        const progress = await readProgress(auth, taskId);
        const hint = TERMINAL_STATUSES.has(progress.status)
          ? progress.processed.length > 0
            ? "\nThe ids are stable across a move: jira_get_issue by id (or by the old key) shows each issue's new key."
            : ''
          : `\nStill running — check again in a moment.`;
        return {
          content: [{ type: 'text' as const, text: `${progressSummary(progress)}${hint}` }],
        };
      } catch (error) {
        return errText(error instanceof Error ? error.message : String(error));
      }
    }
  );
}
