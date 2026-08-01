/**
 * Field allowlisting and rendering for issues.
 *
 * Two separate concerns, both about what crosses the boundary to the model:
 *
 *   - Jira returns every field on the issue, including every custom field the
 *     instance defines. Asking for a named subset keeps unrelated custom-field
 *     data — which in a regulated instance may be exactly the data that must
 *     not leave — out of the response in the first place.
 *   - What comes back is rendered to markdown rather than passed through as
 *     JSON, because a JSON issue costs several times the tokens and the model
 *     reads it no better.
 */

import { adfToMarkdown } from './adf.js';

/** Fields requested for search hits. Enough to triage, not enough to be a data export. */
export const ISSUE_SUMMARY_FIELDS = [
  'summary',
  'status',
  'issuetype',
  'priority',
  'assignee',
  'reporter',
  'labels',
  'created',
  'updated',
  'duedate',
  'parent',
  'project',
  'resolution',
] as const;

/** Fields requested for a single issue read. */
export const ISSUE_DETAIL_FIELDS = [
  ...ISSUE_SUMMARY_FIELDS,
  'description',
  'comment',
  'attachment',
] as const;

export interface RawIssue {
  key?: unknown;
  fields?: unknown;
}

export interface SearchResponse {
  issues?: unknown;
  nextPageToken?: unknown;
  isLast?: unknown;
}

export interface Transition {
  id: string;
  name: string;
  to: string;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function named(value: unknown, key = 'name'): string | null {
  return text(record(value)[key]);
}

/**
 * Normalized to UTC and *labelled* as UTC. Jira returns an offset that is the
 * reporting user's, not the reader's; dropping it entirely would leave a
 * timestamp that looks local and is not. Same rule in ./requests.ts, where a
 * misread SLA breach time is the case that makes it matter.
 */
function shortDate(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  return Number.isNaN(parsed)
    ? raw
    : `${new Date(parsed).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export interface IssueSummary {
  key: string;
  summary: string;
  status: string | null;
  type: string | null;
  priority: string | null;
  assignee: string | null;
  reporter: string | null;
  labels: string[];
  created: string | null;
  updated: string | null;
  dueDate: string | null;
  parentKey: string | null;
  resolution: string | null;
}

export function toIssueSummary(raw: unknown): IssueSummary {
  const issue = record(raw);
  const fields = record(issue.fields);

  return {
    key: text(issue.key) ?? '(unknown)',
    summary: text(fields.summary) ?? '(no summary)',
    status: named(record(fields.status)),
    type: named(record(fields.issuetype)),
    priority: named(record(fields.priority)),
    assignee: named(record(fields.assignee), 'displayName'),
    reporter: named(record(fields.reporter), 'displayName'),
    labels: Array.isArray(fields.labels) ? fields.labels.map(String) : [],
    created: shortDate(fields.created),
    updated: shortDate(fields.updated),
    dueDate: text(fields.duedate),
    parentKey: text(record(fields.parent).key),
    resolution: named(record(fields.resolution)),
  };
}

export function formatIssueList(
  issues: readonly IssueSummary[],
  meta: { jql: string; nextPageToken: string | null },
): string {
  if (issues.length === 0) {
    return `No issues matched \`${meta.jql}\`.`;
  }

  const lines = issues.map((issue) => {
    const parts = [
      `**${issue.key}** — ${issue.summary}`,
      `  status: ${issue.status ?? 'unknown'}` +
        (issue.type ? ` · type: ${issue.type}` : '') +
        (issue.priority ? ` · priority: ${issue.priority}` : '') +
        ` · assignee: ${issue.assignee ?? 'unassigned'}`,
    ];

    const trailer: string[] = [];
    if (issue.updated) trailer.push(`updated ${issue.updated}`);
    if (issue.dueDate) trailer.push(`due ${issue.dueDate}`);
    if (issue.resolution) trailer.push(`resolved ${issue.resolution}`);
    if (issue.labels.length > 0) trailer.push(`labels: ${issue.labels.join(', ')}`);
    if (issue.parentKey) trailer.push(`parent ${issue.parentKey}`);
    if (trailer.length > 0) parts.push(`  ${trailer.join(' · ')}`);

    return parts.join('\n');
  });

  const header = `${issues.length} issue${issues.length === 1 ? '' : 's'} for \`${meta.jql}\``;
  const footer = meta.nextPageToken
    ? `\n\nMore results available — call search_issues again with nextPageToken: \`${meta.nextPageToken}\``
    : '';

  return `${header}\n\n${lines.join('\n\n')}${footer}`;
}

export interface IssueComment {
  author: string;
  created: string | null;
  body: string;
}

export function toComments(
  raw: unknown,
  limit: number,
): { comments: IssueComment[]; total: number } {
  const container = record(raw);
  const list = Array.isArray(container.comments) ? container.comments : [];
  const total = typeof container.total === 'number' ? container.total : list.length;

  // Most recent last: Jira returns oldest-first and that reads correctly as a
  // thread, so the tail is what gets kept when truncating.
  const kept = list.slice(Math.max(0, list.length - limit));

  return {
    total,
    comments: kept.map((entry) => {
      const comment = record(entry);
      return {
        author: named(record(comment.author), 'displayName') ?? 'unknown',
        created: shortDate(comment.created),
        body: adfToMarkdown(comment.body),
      };
    }),
  };
}

function formatCustomField(value: unknown, fieldName: string): string | null {
  if (value === null || value === undefined) {
    return null;
  }

  // Handle user objects
  if (typeof value === 'object' && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (obj.displayName) return String(obj.displayName);
    if (obj.name) return String(obj.name);
    if (obj.value) return String(obj.value);
    // For other objects, try to extract a meaningful value
    if (Object.keys(obj).length === 1) {
      const val = Object.values(obj)[0];
      if (val) return String(val);
    }
  }

  // Handle arrays
  if (Array.isArray(value)) {
    return value
      .map((v) => {
        if (typeof v === 'object' && v !== null) {
          const obj = v as Record<string, unknown>;
          return obj.displayName || obj.name || obj.value || String(v);
        }
        return String(v);
      })
      .join(', ');
  }

  return String(value);
}

export function formatIssueDetail(raw: unknown, options: { maxComments: number }): string {
  const issue = record(raw);
  const fields = record(issue.fields);
  const summary = toIssueSummary(raw);

  const sections: string[] = [];

  sections.push(`# ${summary.key} — ${summary.summary}`);

  const facts = [
    `- status: ${summary.status ?? 'unknown'}`,
    `- type: ${summary.type ?? 'unknown'}`,
    `- priority: ${summary.priority ?? 'none'}`,
    `- assignee: ${summary.assignee ?? 'unassigned'}`,
    `- reporter: ${summary.reporter ?? 'unknown'}`,
  ];
  if (summary.parentKey) facts.push(`- parent: ${summary.parentKey}`);
  if (summary.resolution) facts.push(`- resolution: ${summary.resolution}`);
  if (summary.dueDate) facts.push(`- due: ${summary.dueDate}`);
  if (summary.labels.length > 0) facts.push(`- labels: ${summary.labels.join(', ')}`);
  if (summary.created) facts.push(`- created: ${summary.created}`);
  if (summary.updated) facts.push(`- updated: ${summary.updated}`);
  sections.push(facts.join('\n'));

  // Add custom fields section if any exist
  const customFields: string[] = [];
  for (const [fieldId, value] of Object.entries(fields)) {
    // Skip standard fields and metadata
    if (
      fieldId.startsWith('customfield_') &&
      value !== null &&
      value !== undefined
    ) {
      const formatted = formatCustomField(value, fieldId);
      if (formatted) {
        customFields.push(`- \`${fieldId}\`: ${formatted}`);
      }
    }
  }
  if (customFields.length > 0) {
    sections.push(`## Custom Fields\n\n${customFields.join('\n')}`);
  }

  const description = adfToMarkdown(fields.description);
  sections.push(`## Description\n\n${description || '_(empty)_'}`);

  const attachments = Array.isArray(fields.attachment) ? fields.attachment : [];
  if (attachments.length > 0) {
    const listed = attachments.map((entry) => {
      const attachment = record(entry);
      const size = typeof attachment.size === 'number' ? ` (${formatBytes(attachment.size)})` : '';
      const author = named(record(attachment.author), 'displayName');
      return `- ${text(attachment.filename) ?? 'unnamed'}${size}${author ? ` — ${author}` : ''}`;
    });
    // Metadata only. GET /attachment/content/{id} is blocked by the allowlist,
    // so file contents are not retrievable through Renkei by design.
    sections.push(
      `## Attachments\n\n${listed.join('\n')}\n\n_Contents are not retrievable through Renkei._`,
    );
  }

  const { comments, total } = toComments(fields.comment, options.maxComments);
  if (total > 0) {
    const omitted = total - comments.length;
    const rendered = comments.map(
      (comment) =>
        `**${comment.author}**${comment.created ? ` · ${comment.created}` : ''}\n\n${
          comment.body || '_(empty)_'
        }`,
    );
    const heading =
      omitted > 0
        ? `## Comments (${total}, showing latest ${comments.length})`
        : `## Comments (${total})`;
    sections.push(`${heading}\n\n${rendered.join('\n\n---\n\n')}`);
  }

  return sections.join('\n\n');
}

export function toTransitions(raw: unknown): Transition[] {
  const container = record(raw);
  const list = Array.isArray(container.transitions) ? container.transitions : [];

  return list.map((entry) => {
    const transition = record(entry);
    return {
      id: text(transition.id) ?? '',
      name: text(transition.name) ?? '(unnamed)',
      to: named(record(transition.to)) ?? 'unknown',
    };
  });
}

export function formatTransitions(issueKey: string, transitions: readonly Transition[]): string {
  if (transitions.length === 0) {
    return `${issueKey} has no available transitions for this user.`;
  }

  const lines = transitions.map(
    (transition) => `- \`${transition.id}\` ${transition.name} → ${transition.to}`,
  );

  return `Available transitions for ${issueKey}:\n\n${lines.join('\n')}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
