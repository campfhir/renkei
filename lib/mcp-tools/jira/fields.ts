/**
 * Rendering Jira field values as text.
 *
 * Sits on top of ./adf.ts. Rich text is only one of the shapes a field arrives
 * in: select fields come as `{ value: "Approved" }`, users as
 * `{ displayName: ... }`, and each needs unwrapping to the label a reader
 * expects. Anything unrecognised falls back to its raw JSON, so an unfamiliar
 * shape stays legible instead of becoming `[object Object]`.
 */

import { adfToMarkdown } from './adf';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Fields `get_issue` always prints, and so always asks for. */
export const STANDARD_ISSUE_FIELDS = [
  'summary',
  'status',
  'priority',
  'issuetype',
  'assignee',
  'created',
  'updated',
  'description',
];

/** Does this look like an ADF node — a typed container of child content? */
function looksLikeAdf(value: Record<string, unknown>): boolean {
  return typeof value.type === 'string' && Array.isArray(value.content);
}

/**
 * Render any issue field value as text.
 *
 * Returns an empty string for a field that is absent or empty, so callers can
 * decide whether to print a placeholder or skip the line entirely.
 */
export function renderFieldValue(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);

  if (Array.isArray(value)) {
    const items = value.map(renderFieldValue).filter(Boolean);
    if (items.length === 0) return '';
    // Multi-line members would run together on one comma-separated line.
    return items.some((item) => item.includes('\n'))
      ? items.map((item) => `- ${item}`).join('\n')
      : items.join(', ');
  }

  if (!isRecord(value)) return '';

  // Rich text first: an ADF node also has a `type`, which the label shapes
  // below would otherwise match on.
  if (looksLikeAdf(value)) return adfToMarkdown(value);

  // Select and radio fields. A cascading select nests the second level in
  // `child`, and losing it would report only half the answer.
  if ('value' in value) {
    const own = renderFieldValue(value.value);
    const child = isRecord(value.child)
      ? renderFieldValue('value' in value.child ? value.child.value : value.child)
      : '';
    return child ? `${own} → ${child}` : own;
  }

  // Users, then the `{ name }` shape shared by status, priority, issue type,
  // components, versions and resolutions.
  if (typeof value.displayName === 'string') return value.displayName;
  if (typeof value.name === 'string') return value.name;
  if (typeof value.text === 'string') return value.text;

  // Nothing recognisable — show what Jira actually sent. An unfamiliar shape is
  // a prompt to add a case here, which `[object Object]` never was.
  return JSON.stringify(value);
}

/**
 * Accept the several ways a custom field gets referred to.
 *
 * A bare `12013` and the JQL spelling `cf[12013]` both become
 * `customfield_12013`; anything else (`labels`, `customfield_12013`, a field
 * name) is passed through untouched.
 */
export function normalizeFieldId(field: string): string {
  const trimmed = field.trim();

  if (/^\d+$/.test(trimmed)) return `customfield_${trimmed}`;

  const jqlForm = /^cf\[(\d+)\]$/i.exec(trimmed);
  if (jqlForm) return `customfield_${jqlForm[1]}`;

  return trimmed;
}
