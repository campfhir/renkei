/**
 * Two Jira summaries, because they answer different questions.
 *
 * `sprint` is a STATE: what is running right now, when it ends, and how it is
 * tracking. Its period is the sprint's own start and end, not the caller's
 * window — asking for "yesterday" still means the sprint you are in, and
 * filtering it by yesterday would return a fragment of a thing whose whole
 * point is its shape.
 *
 * `work items` is a WINDOW: what actually moved between two instants,
 * regardless of sprint. That is the one that honours the period, and the one
 * to ask when the question is "what happened while I was away".
 *
 * Sprint dates come off the issues rather than a board: the Agile API can
 * only reach sprints through a board id, and a summary should not have to
 * ask which of an org's boards a person means. The sprint custom field on an
 * issue already carries the name, state and dates, so one field lookup gets
 * them with no board involved. If that lookup fails the issues still list —
 * dates are worth having, not worth failing over.
 */

import { jiraFetch, type MCPToolContext } from '../common';
import { MAX_ITEMS_PER_SECTION, type SummaryPeriod, type SummarySection } from './types';

/** Jira's own id for the Agile sprint field; the customfield number varies per site. */
const SPRINT_FIELD_SCHEMA = 'com.pyxis.greenhopper.jira:gh-sprint';

interface JiraIssue {
  key: string;
  fields: Record<string, unknown> & {
    summary?: string;
    status?: { name?: string };
    assignee?: { displayName?: string };
    priority?: { name?: string };
    updated?: string;
  };
}

interface SprintInfo {
  name: string;
  state: string;
  startDate?: string;
  endDate?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function issueLine(issue: JiraIssue): string {
  const status = issue.fields.status?.name ?? 'unknown status';
  const priority = issue.fields.priority?.name;
  return `${issue.key} [${status}]${priority ? ` (${priority})` : ''} ${issue.fields.summary ?? ''}`.trim();
}

/** The site's sprint custom field id, or null when it cannot be resolved. */
async function sprintFieldId(context: MCPToolContext): Promise<string | null> {
  const response = await jiraFetch(
    `${context.apiBaseUrl}/rest/api/3/field`,
    context.accessToken
  ).catch(() => null);
  if (!response || !response.ok) return null;

  const body: unknown = await response.json().catch(() => null);
  if (!Array.isArray(body)) return null;
  for (const entry of body) {
    if (!isRecord(entry)) continue;
    const schema = isRecord(entry.schema) ? entry.schema : {};
    if (str(schema.custom) === SPRINT_FIELD_SCHEMA) return str(entry.id) || null;
  }
  return null;
}

/** The active sprint carried on an issue, if any. */
function activeSprintOf(issues: JiraIssue[], fieldId: string | null): SprintInfo | null {
  if (!fieldId) return null;
  for (const issue of issues) {
    const raw = issue.fields[fieldId];
    if (!Array.isArray(raw)) continue;
    for (const entry of raw) {
      if (!isRecord(entry)) continue;
      if (str(entry.state).toLowerCase() !== 'active') continue;
      return {
        name: str(entry.name),
        state: str(entry.state),
        startDate: str(entry.startDate) || undefined,
        endDate: str(entry.endDate) || undefined,
      };
    }
  }
  return null;
}

async function searchJql(
  context: MCPToolContext,
  jql: string,
  fields: string[],
  max: number
): Promise<JiraIssue[] | null> {
  const response = await jiraFetch(
    `${context.apiBaseUrl}/rest/api/3/search/jql`,
    context.accessToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jql, fields, maxResults: max }),
    }
  ).catch(() => null);
  if (!response || !response.ok) return null;

  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body) || !Array.isArray(body.issues)) return null;
  return body.issues.filter(
    (issue): issue is JiraIssue => isRecord(issue) && typeof issue.key === 'string'
  );
}

/** How much of the sprint has elapsed, which is the number people actually want. */
function sprintProgress(sprint: SprintInfo, now: Date): string {
  if (!sprint.startDate || !sprint.endDate) return '';
  const start = new Date(sprint.startDate).getTime();
  const end = new Date(sprint.endDate).getTime();
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return '';
  const remainingMs = end - now.getTime();
  const days = Math.ceil(remainingMs / (24 * 60 * 60 * 1000));
  if (days < 0) return `ended ${Math.abs(days)}d ago`;
  return `${days}d left`;
}

export async function collectSprint(
  context: MCPToolContext,
  _period: SummaryPeriod,
  now: Date = new Date()
): Promise<SummarySection | null> {
  const fieldId = await sprintFieldId(context);
  const fields = [
    'summary',
    'status',
    'assignee',
    'priority',
    'updated',
    ...(fieldId ? [fieldId] : []),
  ];

  const mine = await searchJql(
    context,
    'sprint in openSprints() AND assignee = currentUser() ORDER BY status ASC, priority DESC',
    fields,
    MAX_ITEMS_PER_SECTION
  );
  if (mine === null) {
    return { connector: 'jira', label: 'Sprint', lines: [], omitted: 'Jira did not answer' };
  }

  const others = await searchJql(
    context,
    'sprint in openSprints() AND assignee != currentUser() ORDER BY status ASC, priority DESC',
    fields,
    MAX_ITEMS_PER_SECTION
  );

  if (mine.length === 0 && (others === null || others.length === 0)) return null;

  const sprint = activeSprintOf([...mine, ...(others ?? [])], fieldId);
  const lines: string[] = [];

  if (sprint) {
    const window =
      sprint.startDate && sprint.endDate
        ? `${sprint.startDate.slice(0, 10)} → ${sprint.endDate.slice(0, 10)}`
        : 'dates not set';
    const progress = sprintProgress(sprint, now);
    lines.push(`${sprint.name} (${window}${progress ? `, ${progress}` : ''})`);
  }

  if (mine.length > 0) {
    lines.push('Assigned to you:');
    lines.push(...mine.map((issue) => `  ${issueLine(issue)}`));
  } else {
    lines.push('Nothing in the sprint is assigned to you.');
  }

  if (others && others.length > 0) {
    lines.push(`Elsewhere in the sprint (${others.length} shown):`);
    lines.push(
      ...others.map(
        (issue) => `  ${issueLine(issue)} — ${issue.fields.assignee?.displayName ?? 'unassigned'}`
      )
    );
  }

  const notes = [
    !fieldId && 'sprint dates unavailable on this site',
    others &&
      others.length >= MAX_ITEMS_PER_SECTION &&
      `the rest of the sprint is truncated at ${MAX_ITEMS_PER_SECTION} issues`,
  ].filter((note): note is string => typeof note === 'string');

  return {
    connector: 'jira',
    label: 'Sprint',
    headline: `${mine.length} assigned to you`,
    lines,
    omitted: notes.length > 0 ? notes.join('; ') : undefined,
  };
}

export async function collectWorkItems(
  context: MCPToolContext,
  period: SummaryPeriod
): Promise<SummarySection | null> {
  // Jira's JQL takes minute precision in the site's own timezone; the ISO
  // instants are converted rather than passed through, since a raw ISO string
  // is rejected outright.
  const asJql = (iso: string): string => iso.slice(0, 16).replace('T', ' ');

  const issues = await searchJql(
    context,
    `updated >= "${asJql(period.start)}" AND updated < "${asJql(period.end)}" ` +
      'AND (assignee = currentUser() OR reporter = currentUser()) ' +
      'ORDER BY updated DESC',
    ['summary', 'status', 'assignee', 'priority', 'updated'],
    MAX_ITEMS_PER_SECTION
  );
  if (issues === null) {
    return { connector: 'jira', label: 'Work items', lines: [], omitted: 'Jira did not answer' };
  }
  if (issues.length === 0) return null;

  return {
    connector: 'jira',
    label: 'Work items updated',
    headline: `${issues.length} touched`,
    lines: issues.map((issue) => {
      const when = str(issue.fields.updated).slice(11, 16);
      return `${when} ${issueLine(issue)}`;
    }),
    omitted:
      issues.length >= MAX_ITEMS_PER_SECTION
        ? `truncated at ${MAX_ITEMS_PER_SECTION}; issues you own or reported only`
        : 'issues you own or reported only',
  };
}
