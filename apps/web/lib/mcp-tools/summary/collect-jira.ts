/**
 * The current sprint: what is assigned to the caller, and what else is in it.
 *
 * Both, deliberately and separately labelled. "My tickets" is what someone
 * acts on; "the rest of the sprint" is what tells them whether the sprint is
 * in trouble. Merging them into one list loses that distinction, and dropping
 * the second answers a narrower question than a standing summary should.
 *
 * `openSprints()` rather than a board lookup: it is the one JQL clause that
 * means "whatever sprint is running right now" without first asking which
 * board, which project, or which of several active sprints a person is on.
 */

import { jiraFetch, type MCPToolContext } from '../common';
import { MAX_ITEMS_PER_SECTION, type SummaryPeriod, type SummarySection } from './types';

interface JiraIssue {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string };
    assignee?: { accountId?: string; displayName?: string };
    priority?: { name?: string };
    updated?: string;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function issueLine(issue: JiraIssue): string {
  const status = issue.fields.status?.name ?? 'unknown status';
  const priority = issue.fields.priority?.name;
  return `${issue.key} [${status}]${priority ? ` (${priority})` : ''} ${issue.fields.summary ?? ''}`.trim();
}

async function searchJql(
  context: MCPToolContext,
  jql: string,
  max: number
): Promise<JiraIssue[] | null> {
  const response = await jiraFetch(
    `${context.apiBaseUrl}/rest/api/3/search/jql`,
    context.accessToken,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jql,
        fields: ['summary', 'status', 'assignee', 'priority', 'updated'],
        maxResults: max,
      }),
    }
  ).catch(() => null);
  if (!response || !response.ok) return null;

  const body: unknown = await response.json().catch(() => null);
  if (!isRecord(body) || !Array.isArray(body.issues)) return null;
  return body.issues.filter(
    (issue): issue is JiraIssue => isRecord(issue) && typeof issue.key === 'string'
  );
}

export async function collectSprint(
  context: MCPToolContext,
  _period: SummaryPeriod
): Promise<SummarySection | null> {
  // The sprint is a state, not a window: what matters is what is open NOW,
  // so the period deliberately does not filter it. Asking for "yesterday"
  // still gets the sprint you are currently in.
  const mine = await searchJql(
    context,
    'sprint in openSprints() AND assignee = currentUser() ORDER BY status ASC, priority DESC',
    MAX_ITEMS_PER_SECTION
  );
  if (mine === null) {
    return { connector: 'jira', label: 'Sprint', lines: [], omitted: 'Jira did not answer' };
  }

  const others = await searchJql(
    context,
    'sprint in openSprints() AND assignee != currentUser() ORDER BY status ASC, priority DESC',
    MAX_ITEMS_PER_SECTION
  );

  if (mine.length === 0 && (others === null || others.length === 0)) return null;

  const lines: string[] = [];
  if (mine.length > 0) {
    lines.push('Assigned to you:');
    lines.push(...mine.map((issue) => `  ${issueLine(issue)}`));
  } else {
    lines.push('Nothing in the sprint is assigned to you.');
  }

  if (others && others.length > 0) {
    lines.push(`Elsewhere in the sprint (${others.length} shown):`);
    lines.push(
      ...others.slice(0, MAX_ITEMS_PER_SECTION).map((issue) => {
        const who = issue.fields.assignee?.displayName ?? 'unassigned';
        return `  ${issueLine(issue)} — ${who}`;
      })
    );
  }

  return {
    connector: 'jira',
    label: 'Sprint',
    headline: `${mine.length} assigned to you`,
    lines,
    omitted:
      others && others.length >= MAX_ITEMS_PER_SECTION
        ? `the rest of the sprint is truncated at ${MAX_ITEMS_PER_SECTION} issues`
        : undefined,
  };
}
