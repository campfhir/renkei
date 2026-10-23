/**
 * Automation rules — three kinds of change request, all applied on the
 * person's Atlassian API token (lib/mcp-tools/jira-admin/automation-client.ts),
 * since Jira's Automation API refuses every OAuth app:
 *
 * - `automation_state`: rules switched on or off;
 * - `automation_rule`: a rule created from a definition (or copied from
 *   one), or an existing rule changed — name, description, labels, the
 *   spaces it is scoped to, its state, or its whole definition;
 * - `automation_run`: a manual rule run on named issues.
 *
 * A rule is Jira's: its trigger, conditions and actions are the JSON the
 * Automation API takes and gives (`trigger`, `components`), and Renkei
 * stores that JSON as proposed and sends it as stored. Applying re-reads
 * the rule first: a rule gone, or changed since it was read (its `updated`
 * stamp moved), stops the operation rather than overwrite someone's work.
 * Deleting a rule is not offered.
 */

import {
  jiraAdminGet,
  jiraAdminSend,
  rec,
  records,
  str,
  type JiraAdminAccess,
} from '@/lib/mcp-tools/jira-admin/client';
import { projectAri, projectIdOfAri } from '@/lib/mcp-tools/jira-admin/automation-client';
import type { OperationResult } from './change-requests';

export const AUTOMATION_STATE_KIND = 'automation_state';
export const AUTOMATION_RULE_KIND = 'automation_rule';
export const AUTOMATION_RUN_KIND = 'automation_run';

export const AUTOMATION_KINDS = [
  AUTOMATION_STATE_KIND,
  AUTOMATION_RULE_KIND,
  AUTOMATION_RUN_KIND,
] as const;

export function isAutomationKind(kind: string): boolean {
  return AUTOMATION_KINDS.some((known) => known === kind);
}

interface LogScope {
  subject?: string;
}

export type RuleState = 'ENABLED' | 'DISABLED';

const STATES: readonly RuleState[] = ['ENABLED', 'DISABLED'];

export function isRuleState(value: unknown): value is RuleState {
  return STATES.some((state) => state === value);
}

// ---- payloads ------------------------------------------------------------------

export interface RuleStateChange {
  uuid: string;
  name: string;
  from: RuleState;
  to: RuleState;
}

export interface AutomationStatePayload {
  rules: RuleStateChange[];
}

export interface AutomationRulePayload {
  mode: 'create' | 'update';
  /** The rule changed; null when one is created. */
  uuid: string | null;
  name: string;
  /** The spaces the rule is scoped to, as proposed; empty for a site-wide rule. */
  projects: { id: string; key: string }[];
  /** The rule's `updated` stamp when it was read, for an update; applying refuses a newer one. */
  updatedAt: number | null;
  /** The whole rule as the Automation API takes it. */
  rule: Record<string, unknown>;
  /** What an update changes, in words; for a create, where the definition came from. */
  changes: string[];
}

export interface AutomationRunPayload {
  rule: { uuid: string; name: string };
  issues: { key: string; id: string }[];
  userInputs: Record<string, unknown> | null;
}

// ---- describing --------------------------------------------------------------

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join('');
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`;
}

export interface DescribedAutomationOperation {
  text: string;
  access: boolean;
  details: string[];
}

const TOKEN_NOTE = 'Runs on your Atlassian API token, as you.';

export function describeStateChange(change: RuleStateChange): DescribedAutomationOperation {
  return {
    text: `${change.to === 'ENABLED' ? 'Enable' : 'Disable'} the automation rule “${change.name}”`,
    access: false,
    details: [],
  };
}

/** The trigger's type and the number of steps, from a rule's JSON, in words. */
export function summarizeRule(rule: Record<string, unknown>): string[] {
  const trigger = rec(rule.trigger);
  const components = records(rule.components);
  const lines: string[] = [];
  const triggerType = str(trigger.type) || str(rec(trigger.value).type);
  lines.push(
    `Trigger: ${triggerType || 'not set'}` +
      (components.length > 0
        ? `; ${components.length} step${components.length === 1 ? '' : 's'} (${[
            ...new Set(
              components.map((component) => str(component.type) || str(component.component))
            ),
          ]
            .filter(Boolean)
            .slice(0, 6)
            .join(', ')})`
        : '; no steps')
  );
  const labels = Array.isArray(rule.labels) ? rule.labels.map(str).filter(Boolean) : [];
  if (labels.length > 0) lines.push(`Labels: ${labels.join(', ')}`);
  if (str(rule.description)) lines.push(`Description: ${str(rule.description)}`);
  return lines;
}

export function describeRuleOperation(
  payload: AutomationRulePayload
): DescribedAutomationOperation {
  const where =
    payload.projects.length > 0
      ? ` in ${listWords(payload.projects.map((project) => project.key))}`
      : ', site-wide';
  if (payload.mode === 'create') {
    return {
      text:
        `Create the automation rule “${payload.name}”${where}, ` +
        `${str(payload.rule.state) === 'ENABLED' ? 'enabled' : 'disabled'}`,
      access: false,
      details: [...payload.changes, ...summarizeRule(payload.rule)],
    };
  }
  return {
    text: `Change the automation rule “${payload.name}”${where}`,
    access: false,
    details: payload.changes,
  };
}

export function describeRun(payload: AutomationRunPayload): DescribedAutomationOperation {
  const keys = payload.issues.map((issue) => issue.key);
  return {
    text: `Run the manual rule “${payload.rule.name}” on ${listWords(keys.slice(0, 8))}${keys.length > 8 ? ` and ${keys.length - 8} more` : ''}`,
    access: false,
    details: payload.userInputs ? [`With inputs: ${JSON.stringify(payload.userInputs)}`] : [],
  };
}

export function describeAutomationReach(kind: string, siteUrl: string | null): string {
  const site = siteUrl ? ` on ${siteUrl}` : '';
  if (kind === AUTOMATION_RUN_KIND) {
    return `The issues named${site}: the rule’s actions run on them now, once. ${TOKEN_NOTE}`;
  }
  return `Automation rules${site}: every space a rule is scoped to sees it. ${TOKEN_NOTE}`;
}

export function automationStateTitle(payload: AutomationStatePayload): string {
  const first = payload.rules[0];
  const verb = first?.to === 'ENABLED' ? 'Enable' : 'Disable';
  const title =
    payload.rules.length === 1 && first
      ? `${verb} the automation rule “${first.name}”`
      : `${verb} ${payload.rules.length} automation rules`;
  return title.length > 300 ? `${title.slice(0, 299)}…` : title;
}

export function automationRuleTitle(payload: AutomationRulePayload): string {
  const title =
    payload.mode === 'create'
      ? `New automation rule “${payload.name}”`
      : `Change the automation rule “${payload.name}”`;
  return title.length > 300 ? `${title.slice(0, 299)}…` : title;
}

export function automationRunTitle(payload: AutomationRunPayload): string {
  const title = `Run “${payload.rule.name}” on ${payload.issues.length} issue${payload.issues.length === 1 ? '' : 's'}`;
  return title.length > 300 ? `${title.slice(0, 299)}…` : title;
}

// ---- reading ---------------------------------------------------------------

function strings(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

export function readAutomationStatePayload(value: unknown): AutomationStatePayload | null {
  const record = rec(value);
  if (!Array.isArray(record.rules) || record.rules.length === 0) return null;
  const rules: RuleStateChange[] = [];
  for (const item of record.rules) {
    const change = rec(item);
    if (!str(change.uuid) || !isRuleState(change.from) || !isRuleState(change.to)) return null;
    rules.push({
      uuid: str(change.uuid),
      name: str(change.name) || str(change.uuid),
      from: change.from,
      to: change.to,
    });
  }
  return { rules };
}

export function readAutomationRulePayload(value: unknown): AutomationRulePayload | null {
  const record = rec(value);
  const mode = record.mode;
  if (mode !== 'create' && mode !== 'update') return null;
  if (!str(record.name)) return null;
  if (mode === 'update' && !str(record.uuid)) return null;
  const rule = rec(record.rule);
  if (Object.keys(rule).length === 0) return null;
  return {
    mode,
    uuid: mode === 'update' ? str(record.uuid) : null,
    name: str(record.name),
    projects: records(record.projects)
      .filter((project) => str(project.id))
      .map((project) => ({ id: str(project.id), key: str(project.key) || str(project.id) })),
    updatedAt: typeof record.updatedAt === 'number' ? record.updatedAt : null,
    rule,
    changes: strings(record.changes),
  };
}

export function readAutomationRunPayload(value: unknown): AutomationRunPayload | null {
  const record = rec(value);
  const rule = rec(record.rule);
  if (!str(rule.uuid)) return null;
  const issues = records(record.issues)
    .filter((issue) => str(issue.id) && str(issue.key))
    .map((issue) => ({ key: str(issue.key), id: str(issue.id) }));
  if (issues.length === 0) return null;
  const inputs = rec(record.userInputs);
  return {
    rule: { uuid: str(rule.uuid), name: str(rule.name) || str(rule.uuid) },
    issues,
    userInputs: Object.keys(inputs).length > 0 ? inputs : null,
  };
}

// ---- the rules as they are ---------------------------------------------------

export interface RuleSummary {
  uuid: string;
  name: string;
  state: RuleState | string;
  description: string;
  labels: string[];
  ruleScopeARIs: string[];
  /** Project ids the scope ARIs name; empty for a site-wide rule. */
  projectIds: string[];
  updated: number | null;
  authorAccountId: string;
}

function summaryOf(record: Record<string, unknown>): RuleSummary {
  const aris = strings(record.ruleScopeARIs);
  return {
    uuid: str(record.uuid),
    name: str(record.name),
    state: str(record.state),
    description: str(record.description),
    labels: strings(record.labels),
    ruleScopeARIs: aris,
    projectIds: aris.map(projectIdOfAri).filter((id): id is string => id !== null),
    updated: typeof record.updated === 'number' ? record.updated : null,
    authorAccountId: str(record.authorAccountId),
  };
}

const PAGE = 50;
const MAX_PAGES = 10;

/** The cursor the deprecated `links.next` carries, as query parameters. */
function nextCursor(body: Record<string, unknown>): string {
  const next = str(rec(body.links).next);
  if (!next) return '';
  try {
    return new URLSearchParams(next.startsWith('?') ? next.slice(1) : next).get('cursor') ?? '';
  } catch {
    return '';
  }
}

/**
 * Rule summaries, filtered when asked (the search needs at least one of
 * trigger, state, scope or limit), page after page up to a cap —
 * `truncated` when there were more.
 */
export async function readRuleSummaries(
  scope: LogScope,
  access: JiraAdminAccess,
  filter: { state?: RuleState; scopeAri?: string; trigger?: string } = {}
): Promise<{ ok: true; rules: RuleSummary[]; truncated: boolean } | { ok: false; error: string }> {
  const rules: RuleSummary[] = [];
  let cursor = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await jiraAdminSend(scope, access, 'POST', '/rest/v1/rule/summary', {
      limit: PAGE,
      ...(filter.state ? { state: filter.state } : {}),
      ...(filter.scopeAri ? { scope: filter.scopeAri } : {}),
      ...(filter.trigger ? { trigger: filter.trigger } : {}),
      ...(cursor ? { cursor } : {}),
    });
    if (!result.ok) return { ok: false, error: result.error };
    const body = rec(result.body);
    rules.push(...records(body.data).map(summaryOf));
    cursor = nextCursor(body);
    if (!cursor || records(body.data).length === 0) return { ok: true, rules, truncated: false };
  }
  return { ok: true, rules, truncated: true };
}

export interface RuleRead {
  summary: RuleSummary;
  /** The rule as the API gives it — the definition an update sends back. */
  rule: Record<string, unknown>;
  connections: Record<string, unknown>[];
}

/** One rule in full, or null when it is gone. */
export async function readRule(
  scope: LogScope,
  access: JiraAdminAccess,
  uuid: string
): Promise<{ ok: true; read: RuleRead | null } | { ok: false; error: string }> {
  const result = await jiraAdminGet(
    scope,
    access,
    `/rest/v1/rule/${encodeURIComponent(uuid)}?redactSensitiveFields=true`
  );
  if (!result.ok) {
    return result.status === 404 ? { ok: true, read: null } : { ok: false, error: result.error };
  }
  const body = rec(result.body);
  const rule = rec(body.rule);
  if (!str(rule.uuid) && !str(rule.name)) return { ok: true, read: null };
  return {
    ok: true,
    read: { summary: summaryOf(rule), rule, connections: records(body.connections) },
  };
}

/** A rule's definition with everything Jira assigns stripped, ready to be created again. */
export function definitionForCopy(rule: Record<string, unknown>): Record<string, unknown> {
  const stripIds = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(stripIds);
    if (typeof value === 'object' && value !== null) {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(value)) {
        if (key === 'id' || key === 'parentId' || key === 'conditionParentId') continue;
        out[key] = stripIds(inner);
      }
      return out;
    }
    return value;
  };
  const copy = { ...rule };
  for (const key of ['uuid', 'created', 'updated', 'authorAccountId', 'collaborators']) {
    delete copy[key];
  }
  return {
    ...copy,
    trigger: stripIds(rule.trigger),
    components: stripIds(rule.components),
  };
}

/** The scope ARIs for a list of spaces on a site; empty means site-wide. */
export function scopeArisFor(cloudId: string, projects: { id: string }[]): string[] {
  return projects.map((project) => projectAri(cloudId, project.id));
}

// ---- applying ----------------------------------------------------------------

type Outcome = { status: 'applied' | 'partial' | 'failed'; results: OperationResult[] };

function outcomeOf(results: OperationResult[]): Outcome {
  const done = results.filter((result) => result.outcome === 'done').length;
  return {
    status: done === results.length ? 'applied' : done === 0 ? 'failed' : 'partial',
    results,
  };
}

export async function applyAutomationState(
  scope: LogScope,
  access: JiraAdminAccess,
  payload: AutomationStatePayload
): Promise<Outcome> {
  const results: OperationResult[] = [];
  for (const change of payload.rules) {
    const label = describeStateChange(change).text;
    const read = await readRule(scope, access, change.uuid);
    if (!read.ok) {
      results.push({ label, outcome: 'failed', detail: `Reading the rule: ${read.error}` });
      continue;
    }
    if (!read.read) {
      results.push({ label, outcome: 'failed', detail: 'The rule no longer exists.' });
      continue;
    }
    if (read.read.summary.state === change.to) {
      results.push({
        label,
        outcome: 'done',
        detail: `It was ${change.to === 'ENABLED' ? 'enabled' : 'disabled'} already.`,
      });
      continue;
    }
    const result = await jiraAdminSend(
      scope,
      access,
      'PUT',
      `/rest/v1/rule/${encodeURIComponent(change.uuid)}/state`,
      { value: change.to }
    );
    results.push(
      result.ok ? { label, outcome: 'done' } : { label, outcome: 'failed', detail: result.error }
    );
  }
  return outcomeOf(results);
}

export async function applyAutomationRule(
  scope: LogScope,
  access: JiraAdminAccess,
  payload: AutomationRulePayload
): Promise<Outcome> {
  const label = describeRuleOperation(payload).text;
  if (payload.mode === 'create') {
    const result = await jiraAdminSend(scope, access, 'POST', '/rest/v1/rule', {
      rule: payload.rule,
    });
    if (!result.ok) return outcomeOf([{ label, outcome: 'failed', detail: result.error }]);
    const uuid = str(rec(result.body).ruleUuid);
    return outcomeOf([
      { label, outcome: 'done', ...(uuid ? { detail: `Created as ${uuid}.` } : {}) },
    ]);
  }
  const uuid = payload.uuid ?? '';
  const read = await readRule(scope, access, uuid);
  if (!read.ok)
    return outcomeOf([{ label, outcome: 'failed', detail: `Reading the rule: ${read.error}` }]);
  if (!read.read)
    return outcomeOf([{ label, outcome: 'failed', detail: 'The rule no longer exists.' }]);
  if (
    payload.updatedAt !== null &&
    read.read.summary.updated !== null &&
    read.read.summary.updated !== payload.updatedAt
  ) {
    return outcomeOf([
      {
        label,
        outcome: 'failed',
        detail:
          'The rule has been changed since this was proposed, so it was left as it is now. Ask ' +
          'for the change again.',
      },
    ]);
  }
  const result = await jiraAdminSend(
    scope,
    access,
    'PUT',
    `/rest/v1/rule/${encodeURIComponent(uuid)}`,
    { rule: payload.rule }
  );
  return outcomeOf(
    result.ok ? [{ label, outcome: 'done' }] : [{ label, outcome: 'failed', detail: result.error }]
  );
}

export async function applyAutomationRun(
  scope: LogScope,
  access: JiraAdminAccess,
  payload: AutomationRunPayload,
  issueAriOf: (issueId: string) => string
): Promise<Outcome> {
  const label = describeRun(payload).text;
  const read = await readRule(scope, access, payload.rule.uuid);
  if (!read.ok)
    return outcomeOf([{ label, outcome: 'failed', detail: `Reading the rule: ${read.error}` }]);
  if (!read.read)
    return outcomeOf([{ label, outcome: 'failed', detail: 'The rule no longer exists.' }]);
  if (read.read.summary.state !== 'ENABLED') {
    return outcomeOf([
      { label, outcome: 'failed', detail: 'The rule is disabled now, so it was not run.' },
    ]);
  }
  const result = await jiraAdminSend(
    scope,
    access,
    'POST',
    `/rest/v1/rule/manual/${encodeURIComponent(payload.rule.uuid)}/invocation`,
    {
      objects: payload.issues.map((issue) => issueAriOf(issue.id)),
      ...(payload.userInputs ? { userInputs: payload.userInputs } : {}),
    }
  );
  if (!result.ok) return outcomeOf([{ label, outcome: 'failed', detail: result.error }]);
  const answers = rec(result.body);
  const perIssue = payload.issues.map((issue) => {
    const answer = str(answers[issueAriOf(issue.id)]);
    return `${issue.key}: ${answer || 'no answer'}`;
  });
  const failed = payload.issues.filter((issue) => str(answers[issueAriOf(issue.id)]) !== 'SUCCESS');
  return outcomeOf([
    failed.length === payload.issues.length
      ? { label, outcome: 'failed', detail: perIssue.join('; ') }
      : { label, outcome: 'done', detail: perIssue.join('; ') },
  ]);
}
